/*
 * Сервис перевода: очередь с ограничением параллельности, ретраи, кэш, статистика, фолбэк провайдера.
 * Работает в service worker (и в dev-harness тестовой страницы).
 */
(function () {
  const { normLang, hash } = globalThis.ST_LIB;
  const { byId, ProviderError } = globalThis.ST_PROVIDERS;

  const MAX_CONCURRENCY = 4;
  const MAX_RETRIES = 3;
  const MEM_CACHE_LIMIT = 3000;

  const memCache = new Map(); // key -> { translation, detectedLang }
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
      // квота 10MB исчерпана — чистим сессионный кэш целиком
      try { await area.clear(); } catch (e2) { /* ignore */ }
    }
  }

  // --- статистика за день ---
  let statsQueue = Promise.resolve();
  function bumpStats(patch) {
    const area = globalThis.chrome && chrome.storage && chrome.storage.local;
    if (!area) return;
    statsQueue = statsQueue.then(async () => {
      const today = new Date().toISOString().slice(0, 10);
      const { stats } = await area.get('stats');
      const s = stats && stats.date === today ? stats : { date: today, requests: 0, chars: 0, cacheHits: 0, errors: 0, lastError: '' };
      for (const k of Object.keys(patch)) {
        if (typeof patch[k] === 'number') s[k] = (s[k] || 0) + patch[k];
        else s[k] = patch[k];
      }
      await area.set({ stats: s });
    }).catch(() => {});
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

  async function callProvider(provider, text, sl, tl, settings) {
    let attempt = 0;
    for (;;) {
      await acquire();
      try {
        const r = await provider.translate({ text, sl, tl, settings });
        bumpStats({ requests: 1, chars: text.length });
        return r;
      } catch (e) {
        const retriable = e instanceof ProviderError && (e.status === 0 || e.status === 429 || e.status >= 500);
        if (!retriable || attempt >= MAX_RETRIES) throw e;
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
        detectedLang: normLang(results[0].detectedLang),
        provider: provider.id
      };
    };
    try {
      return await run(primary);
    } catch (e) {
      if (primary.id === 'google-free' && settings.fallbackToCloud && settings.googleCloudApiKey) {
        bumpStats({ errors: 1, lastError: 'free упал, фолбэк на Cloud: ' + e.message });
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

    const key = hash(sl + '|' + tl + '|' + text);
    const cached = await cacheGet(key);
    if (cached) {
      bumpStats({ cacheHits: 1 });
      return Object.assign({}, cached, { fromCache: true });
    }
    if (inflight.has(key)) return inflight.get(key);

    const p = translateRaw(text, sl, tl, settings)
      .then(async (r) => {
        await cacheSet(key, r);
        return Object.assign({}, r, { fromCache: false });
      })
      .catch((e) => {
        bumpStats({ errors: 1, lastError: String(e.message || e) });
        throw e;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  globalThis.ST_TRANSLATOR = { translate, chunkText };
})();
