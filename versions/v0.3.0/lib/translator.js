/*
 * Сервис перевода: глоссарий, очередь с ограничением параллельности, ретраи, кэш, статистика, фолбэк провайдера.
 * Работает в service worker (и в dev-harness тестовой страницы).
 */
(function () {
  const { normLang, hash } = globalThis.ST_LIB;
  const { byId, ProviderError } = globalThis.ST_PROVIDERS;
  const G = globalThis.ST_GLOSSARY;
  const stats = () => globalThis.ST_STATS || null;

  const MAX_CONCURRENCY = 4;
  const MAX_RETRIES = 3;
  const MEM_CACHE_LIMIT = 3000;

  const memCache = new Map(); // key -> { translation, detectedLang, provider }
  const inflight = new Map(); // key -> Promise (дедупликация одинаковых запросов)
  let active = 0;
  const waiters = [];

  function acquire() {
    if (active < MAX_CONCURRENCY) {
      active++;
      return Promise.resolve();
    }
    return new Promise((r) => waiters.push(r)).then(() => { active++; });
  }
  function release() {
    active--;
    const next = waiters.shift();
    if (next) next();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // --- storage.session как второй уровень кэша (переживает перезапуск service worker) ---
  const sessionArea = () => (globalThis.chrome && chrome.storage && chrome.storage.session) || null;

  async function cacheGet(key) {
    if (memCache.has(key)) return memCache.get(key);
    const area = sessionArea();
    if (!area) return null;
    try {
      const k = 'c:' + key;
      const got = await area.get(k);
      if (got && got[k]) {
        memCache.set(key, got[k]);
        return got[k];
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  async function cacheSet(key, value) {
    memCache.set(key, value);
    if (memCache.size > MEM_CACHE_LIMIT) memCache.delete(memCache.keys().next().value);
    const area = sessionArea();
    if (!area) return;
    try {
      await area.set({ ['c:' + key]: value });
    } catch (e) {
      // квота 10MB исчерпана — чистим кэш переводов (служебные ключи оставляем)
      try {
        const all = await area.get(null);
        await area.remove(Object.keys(all).filter((k) => k.startsWith('c:')));
      } catch (e2) { /* ignore */ }
    }
  }

  // Режем длинный текст по абзацам/предложениям
  function chunkText(text, max) {
    if (text.length <= max) return [text];
    const parts = text.split(/(?<=[\n.!?。！？])/);
    const chunks = [];
    let cur = '';
    for (const p of parts) {
      if ((cur + p).length > max && cur) {
        chunks.push(cur);
        cur = '';
      }
      if (p.length > max) {
        for (let i = 0; i < p.length; i += max) chunks.push(p.slice(i, i + max));
      } else {
        cur += p;
      }
    }
    if (cur) chunks.push(cur);
    return chunks;
  }

  // Предохранитель: если провайдер начал отказывать (429 / блок), не долбим его запросами —
  // пауза, в течение которой запросы сразу падают (и уходят в фолбэк, если он настроен)
  const COOLDOWN_MS = 60000;
  const cooldownUntil = {}; // providerId -> timestamp
  const failStreak = {}; // providerId -> подряд неудачных запросов после ретраев

  function checkCooldown(provider) {
    const until = cooldownUntil[provider.id] || 0;
    if (Date.now() < until) {
      const sec = Math.ceil((until - Date.now()) / 1000);
      throw new ProviderError('Google временно ограничил запросы, пауза ' + sec + ' с' + (provider.id === 'google-free' ? ' (добавьте API key для резервного перевода)' : ''), 429);
    }
  }

  async function callProvider(provider, text, sl, tl, settings) {
    let attempt = 0;
    for (;;) {
      checkCooldown(provider);
      await acquire();
      try {
        const r = await provider.translate({ text, sl, tl, settings });
        stats() && stats().api(text.length, provider.id);
        failStreak[provider.id] = 0;
        return r;
      } catch (e) {
        const limited = e instanceof ProviderError && e.status === 429;
        const retriable = e instanceof ProviderError && (e.status === 0 || limited || e.status >= 500);
        if (limited) {
          // явный лимит — сразу пауза для всех запросов
          cooldownUntil[provider.id] = Date.now() + COOLDOWN_MS;
          throw e;
        }
        if (!retriable || attempt >= MAX_RETRIES) {
          failStreak[provider.id] = (failStreak[provider.id] || 0) + 1;
          if (failStreak[provider.id] >= 3) cooldownUntil[provider.id] = Date.now() + COOLDOWN_MS;
          throw e;
        }
      } finally {
        release();
      }
      attempt++;
      await sleep(800 * Math.pow(2, attempt - 1) + Math.random() * 300);
    }
  }

  async function translateRaw(text, sl, tl, settings) {
    const primary = byId[settings.provider] || byId['google-free'];
    const run = async (provider) => {
      const chunks = chunkText(text, provider.maxChunk);
      const results = [];
      for (const c of chunks) results.push(await callProvider(provider, c, sl, tl, settings));
      return {
        translation: results.map((r) => r.translation).join(''),
        // подсказка опечаток: если хоть один кусок исправлен — собираем исправленный текст целиком
        spell: results.some((r) => r.spell) ? results.map((r, i) => r.spell || chunks[i]).join('') : '',
        // подсказка опечаток: если хоть один кусок исправлен — собираем исправленный текст целиком
        spell: results.some((r) => r.spell) ? results.map((r, i) => r.spell || chunks[i]).join('') : '',
        detectedLang: normLang(results[0].detectedLang),
        provider: provider.id
      };
    };
    try {
      return await run(primary);
    } catch (e) {
      if (primary.id === 'google-free' && settings.fallbackToCloud && settings.googleCloudApiKey) {
        stats() && stats().note('free недоступен, фолбэк на Cloud: ' + e.message);
        return await run(byId['google-cloud']);
      }
      throw e;
    }
  }

  /**
   * translate(text, sl, tl, settings) -> { translation, detectedLang, provider, fromCache }
   */
  async function translate(text, sl, tl, settings) {
    text = String(text || '');
    sl = sl || 'auto';
    tl = normLang(tl);
    if (!text.trim()) return { translation: text, detectedLang: '', fromCache: true };

    const glossary = settings.glossary || '';
    // провайдер в ключе: переводы тестового провайдера не должны попадать в кэш настоящего
    const key = hash((settings.provider || '') + '|' + sl + '|' + tl + '|' + hash(glossary) + '|' + text);
    const cached = await cacheGet(key);
    if (cached) {
      stats() && stats().cacheHit();
      return Object.assign({}, cached, { fromCache: true });
    }
    if (inflight.has(key)) return inflight.get(key);

    const protectedText = G ? G.protect(text, glossary, tl) : { text, tokens: [] };
    const p = translateRaw(protectedText.text, sl, tl, settings)
      .then(async (r) => {
        r.translation = G ? G.restore(r.translation, protectedText.tokens) : r.translation;
        if (r.spell && G) r.spell = G.restore(r.spell, protectedText.originals);
        await cacheSet(key, r);
        return Object.assign({}, r, { fromCache: false });
      })
      .catch((e) => {
        stats() && stats().error(e.message || e);
        throw e;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  globalThis.ST_TRANSLATOR = { translate, chunkText };
})();
