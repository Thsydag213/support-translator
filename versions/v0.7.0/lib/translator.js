/*
 * Сервис перевода (service worker и dev-harness):
 *   глоссарий → кэш (память + постоянный в storage.local) → дедупликация →
 *   объединение нескольких сообщений в один запрос → очередь/ретраи/предохранитель →
 *   резерв (Google Cloud) при недоступности основного провайдера → статистика.
 */
(function () {
  const { normLang, hash } = globalThis.ST_LIB;
  const { byId, ProviderError } = globalThis.ST_PROVIDERS;
  const G = globalThis.ST_GLOSSARY;
  const PII = globalThis.ST_PII;
  const stats = () => globalThis.ST_STATS || null;

  const MAX_CONCURRENCY = 4;
  const MAX_RETRIES = 3;
  const MEM_CACHE_LIMIT = 3000;

  const memCache = new Map(); // key -> { translation, detectedLang, provider, spell }
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

  // ---------------------------------------------------------------------------
  // Постоянный кэш: переживает перезапуск браузера — повторно открытые тикеты не переводятся заново.
  // Каждая запись — отдельный ключ "c:<hash>" в storage.local; при превышении лимита удаляются самые старые.
  // ---------------------------------------------------------------------------
  const CACHE_PREFIX = 'c:';
  const CACHE_MAX = 3000; // storage.local ~10 МБ: с запасом под настройки и статистику
  const CACHE_KEEP_AFTER_PRUNE = 2000;
  const CACHE_TTL_MS = 30 * 86400000;
  const localArea = () => (globalThis.chrome && chrome.storage && chrome.storage.local) || null;

  let cacheCount = null; // число записей (по метаданным), грузится лениво
  let pruning = null;

  async function loadCount(area) {
    if (cacheCount != null) return cacheCount;
    try {
      const { cmeta } = await area.get('cmeta');
      cacheCount = (cmeta && cmeta.count) || 0;
    } catch (e) {
      cacheCount = 0;
    }
    return cacheCount;
  }

  async function cacheGet(key) {
    if (memCache.has(key)) return memCache.get(key);
    const area = localArea();
    if (!area) return null;
    try {
      const k = CACHE_PREFIX + key;
      const got = await area.get(k);
      const v = got && got[k];
      if (v && (!v.at || Date.now() - v.at < CACHE_TTL_MS)) {
        memCache.set(key, v);
        return v;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  async function prune(area) {
    if (pruning) return pruning;
    pruning = (async () => {
      const all = await area.get(null);
      const entries = Object.keys(all)
        .filter((k) => k.startsWith(CACHE_PREFIX))
        .map((k) => [k, (all[k] && all[k].at) || 0])
        .sort((a, b) => a[1] - b[1]);
      const now = Date.now();
      const remove = entries
        .filter(([, at], i) => i < entries.length - CACHE_KEEP_AFTER_PRUNE || now - at > CACHE_TTL_MS)
        .map(([k]) => k);
      if (remove.length) await area.remove(remove);
      cacheCount = entries.length - remove.length;
      await area.set({ cmeta: { count: cacheCount } });
    })()
      .catch(() => {})
      .finally(() => { pruning = null; });
    return pruning;
  }

  async function cacheSet(key, value) {
    const v = Object.assign({}, value, { at: Date.now() });
    memCache.set(key, v);
    if (memCache.size > MEM_CACHE_LIMIT) memCache.delete(memCache.keys().next().value);
    const area = localArea();
    if (!area) return;
    try {
      await area.set({ [CACHE_PREFIX + key]: v });
      const n = (await loadCount(area)) + 1;
      cacheCount = n;
      if (n % 50 === 0) await area.set({ cmeta: { count: n } });
      if (n > CACHE_MAX) prune(area);
    } catch (e) {
      // квота исчерпана — чистим старые записи
      prune(area);
    }
  }

  async function clearCache() {
    memCache.clear();
    const area = localArea();
    if (!area) return;
    const all = await area.get(null);
    await area.remove(Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX)).concat('cmeta'));
    cacheCount = 0;
    // старый сессионный кэш (до 0.4.0)
    try {
      const s = chrome.storage.session;
      const sAll = await s.get(null);
      await s.remove(Object.keys(sAll).filter((k) => k.startsWith(CACHE_PREFIX)));
    } catch (e) { /* ignore */ }
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

  // ---------------------------------------------------------------------------
  // Предохранитель: если провайдер начал отказывать (429 / блок), не долбим его запросами —
  // пауза, в течение которой запросы сразу падают (и уходят в резерв, если он настроен)
  // ---------------------------------------------------------------------------
  const COOLDOWN_MS = 60000;
  const cooldownUntil = {}; // providerId -> timestamp
  const failStreak = {}; // providerId -> подряд неудачных запросов после ретраев

  function checkCooldown(provider) {
    const until = cooldownUntil[provider.id] || 0;
    if (Date.now() < until) {
      const sec = Math.ceil((until - Date.now()) / 1000);
      throw new ProviderError('Google временно ограничил запросы, пауза ' + sec + ' с' + (provider.id === 'google-free' ? ' (настройте резерв Google Cloud)' : ''), 429);
    }
  }

  // Один запрос к провайдеру с очередью, ретраями и предохранителем. fn() делает сам запрос
  async function withRetries(provider, chars, fn) {
    let attempt = 0;
    for (;;) {
      checkCooldown(provider);
      await acquire();
      try {
        const r = await fn();
        stats() && stats().api(chars, provider.id);
        failStreak[provider.id] = 0;
        return r;
      } catch (e) {
        const limited = e instanceof ProviderError && e.status === 429;
        const retriable = e instanceof ProviderError && (e.status === 0 || e.status >= 500);
        if (limited) {
          // явный лимит — сразу пауза для всех запросов
          cooldownUntil[provider.id] = Date.now() + COOLDOWN_MS;
          throw e;
        }
        if (!retriable || attempt >= MAX_RETRIES) {
          if (retriable) {
            failStreak[provider.id] = (failStreak[provider.id] || 0) + 1;
            if (failStreak[provider.id] >= 3) cooldownUntil[provider.id] = Date.now() + COOLDOWN_MS;
          }
          throw e;
        }
      } finally {
        release();
      }
      attempt++;
      await sleep(800 * Math.pow(2, attempt - 1) + Math.random() * 300);
    }
  }

  // Цепочка провайдеров: основной, затем резерв Google Cloud (если включён, задан ключ и это не он же)
  function providerChain(settings) {
    const primary = byId[settings.provider] || byId['google-free'];
    const chain = [primary];
    if (settings.fallbackToCloud && settings.googleCloudApiKey && primary.id !== 'google-cloud' && primary.id !== 'dev-mock') {
      chain.push(byId['google-cloud']);
    }
    return chain;
  }

  // Расход Google Cloud за месяц (кэш на минуту): при исчерпании лимита Cloud не используется — чтобы не было счёта
  let cloudUsed = { at: 0, chars: 0 };
  async function cloudOverLimit(settings) {
    if (!settings.cloudStopAtLimit || !stats() || !stats().monthChars) return false;
    if (Date.now() - cloudUsed.at > 60000) cloudUsed = { at: Date.now(), chars: await stats().monthChars('google-cloud') };
    return cloudUsed.chars >= (settings.cloudMonthlyLimit || 500000);
  }

  async function withFallback(settings, run) {
    const chain = providerChain(settings);
    let lastErr = null;
    for (let i = 0; i < chain.length; i++) {
      try {
        if (chain[i].id === 'google-cloud' && (await cloudOverLimit(settings))) {
          throw new ProviderError('Лимит Google Cloud на этот месяц исчерпан (' + (settings.cloudMonthlyLimit || 500000).toLocaleString('ru') + ' символов) — Cloud отключён до 1-го числа', 429);
        }
        return await run(chain[i]);
      } catch (e) {
        lastErr = e;
        if (i + 1 < chain.length) stats() && stats().note(chain[i].id + ' недоступен, резерв ' + chain[i + 1].id + ': ' + e.message);
      }
    }
    throw lastErr;
  }

  async function translateRaw(text, sl, tl, settings, opts) {
    return withFallback(settings, async (provider) => {
      const chunks = chunkText(text, provider.maxChunk);
      const results = [];
      for (const c of chunks) {
        results.push(await withRetries(provider, c.length, () => provider.translate({ text: c, sl, tl, settings, spell: !!opts.spell })));
      }
      return {
        translation: results.map((r) => r.translation).join(''),
        // подсказка опечаток: если хоть один кусок исправлен — собираем исправленный текст целиком
        spell: results.some((r) => r.spell) ? results.map((r, i) => r.spell || chunks[i]).join('') : '',
        detectedLang: normLang(results[0].detectedLang),
        provider: provider.id
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Объединение запросов: сообщения одного языка (по подсказке встроенного детектора Chrome),
  // пришедшие в течение 150 мс, уходят одним запросом. Провайдеры умеют translateMany;
  // если ответ не удалось разобрать на части — переводим по одному.
  // ---------------------------------------------------------------------------
  const BATCH_DELAY_MS = 150;
  const BATCH_MAX_ITEMS = 20;
  const BATCH_MAX_CHARS = 3500;
  const batches = new Map(); // key -> { items: [{ text, resolve, reject }], chars, timer, sl, tl, settings }

  function enqueueBatch(text, sl, tl, settings, hint) {
    const key = (settings.provider || '') + '|' + sl + '|' + tl + '|' + hint;
    return new Promise((resolve, reject) => {
      let b = batches.get(key);
      if (b && (b.items.length >= BATCH_MAX_ITEMS || b.chars + text.length > BATCH_MAX_CHARS)) {
        flushBatch(key);
        b = null;
      }
      if (!b) {
        b = { items: [], chars: 0, sl, tl, settings, timer: setTimeout(() => flushBatch(key), BATCH_DELAY_MS) };
        batches.set(key, b);
      }
      b.items.push({ text, resolve, reject });
      b.chars += text.length;
    });
  }

  async function flushBatch(key) {
    const b = batches.get(key);
    if (!b) return;
    batches.delete(key);
    clearTimeout(b.timer);
    const { items, sl, tl, settings } = b;
    const texts = items.map((i) => i.text);
    try {
      const results = await withFallback(settings, async (provider) => {
        if (texts.length > 1 && provider.translateMany) {
          try {
            const many = await withRetries(provider, b.chars, () => provider.translateMany({ texts, sl, tl, settings }));
            stats() && stats().batch(texts.length);
            return many.map((r) => ({ translation: r.translation, detectedLang: normLang(r.detectedLang), provider: provider.id, spell: '' }));
          } catch (e) {
            if (!(e instanceof ProviderError) || e.status !== 422) throw e;
            // ответ не разобрался на части — по одному
          }
        }
        const out = [];
        for (const t of texts) {
          const r = await withRetries(provider, t.length, () => provider.translate({ text: t, sl, tl, settings }));
          out.push({ translation: r.translation, detectedLang: normLang(r.detectedLang), provider: provider.id, spell: '' });
        }
        return out;
      });
      items.forEach((it, i) => it.resolve(results[i]));
    } catch (e) {
      items.forEach((it) => it.reject(e));
    }
  }

  /**
   * translate(text, sl, tl, settings, opts) -> { translation, detectedLang, provider, fromCache, spell }
   * opts.spell   — запросить проверку орфографии исходного текста (только текст оператора)
   * opts.batch   — можно объединить с другими сообщениями (входящие)
   * opts.hint    — язык по встроенному детектору Chrome: объединяются только сообщения одного языка
   * opts.noCache — не брать из кэша (проверка провайдера)
   */
  async function translate(text, sl, tl, settings, opts) {
    opts = opts || {};
    text = String(text || '');
    sl = sl || 'auto';
    tl = normLang(tl);
    if (!text.trim()) return { translation: text, detectedLang: '', fromCache: true };

    const glossary = settings.glossary || '';
    // провайдер в ключе: переводы тестового провайдера не должны попадать в кэш настоящего;
    // spell в ключе: ответ без проверки орфографии не должен закрывать запрос, где подсказка нужна
    const key = hash((settings.provider || '') + (opts.spell ? '|spell' : '') + '|' + sl + '|' + tl + '|' + hash(glossary) + '|' + text);
    if (!opts.noCache) {
      const cached = await cacheGet(key);
      if (cached) {
        stats() && stats().cacheHit();
        return Object.assign({}, cached, { fromCache: true });
      }
      if (inflight.has(key)) return inflight.get(key);
    }

    // Персональные данные не уходят к провайдеру: почты, телефоны, карты, номера заказов — метками
    const masked = PII && settings.maskPii !== false && !opts.noMask ? PII.mask(text) : { text, tokens: [] };
    const protectedText = G ? G.protect(masked.text, glossary, tl) : { text: masked.text, tokens: [], originals: [] };
    const canBatch = settings.batchRequests !== false && opts.batch && opts.hint && sl === 'auto' && !opts.spell && protectedText.text.length <= 3000;
    const work = canBatch
      ? enqueueBatch(protectedText.text, sl, tl, settings, normLang(opts.hint))
      : translateRaw(protectedText.text, sl, tl, settings, opts);

    const p = work
      .then(async (r) => {
        r = Object.assign({}, r);
        r.translation = G ? G.restore(r.translation, protectedText.tokens) : r.translation;
        if (r.spell && G) r.spell = G.restore(r.spell, protectedText.originals);
        if (masked.tokens.length) {
          // Провайдер потерял метки — переводим ещё раз без маскирования, иначе данные пропадут
          if (!PII.intact(r.translation, masked.tokens)) {
            return translate(text, sl, tl, settings, Object.assign({}, opts, { noMask: true, noCache: true }));
          }
          r.translation = PII.restore(r.translation, masked.tokens);
          if (r.spell) r.spell = PII.restore(r.spell, masked.tokens);
          r.masked = masked.tokens.length;
        }
        await cacheSet(key, r);
        return Object.assign({}, r, { fromCache: false });
      })
      .catch((e) => {
        stats() && stats().error(e.message || e);
        throw e;
      })
      .finally(() => inflight.delete(key));
    if (!opts.noCache) inflight.set(key, p);
    return p;
  }

  function status() {
    const now = Date.now();
    const cd = {};
    for (const [id, until] of Object.entries(cooldownUntil)) if (until > now) cd[id] = Math.ceil((until - now) / 1000);
    return { cooldown: cd, cacheEntries: cacheCount, memCache: memCache.size };
  }

  globalThis.ST_TRANSLATOR = { translate, chunkText, clearCache, status };
})();
