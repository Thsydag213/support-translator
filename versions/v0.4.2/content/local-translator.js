/*
 * Встроенный переводчик Chrome (Translator API и Language Detector API, Chrome 138+).
 * Переводит на устройстве: без сети, без лимитов, тексты не уходят в интернет.
 * Используется ПЕРВЫМ для всего (входящие, перевод ответа, обратный перевод, определение языка);
 * облачный провайдер — только если перевести на устройстве нельзя.
 *
 * Где выполняется перевод:
 *   'page'   — прямо в скрипте на странице сайта (если Chrome даёт API в этом окружении);
 *   'bridge' — через скрытую страницу расширения (offscreen document): на страницах расширения API есть всегда,
 *              даже если на странице сайта его нет. Выбирается автоматически.
 *
 * Модели скачиваются браузером; во время работы используются только уже скачанные пары языков.
 * Скачать заранее: настройки → «Перевод на устройстве» → «Скачать языковые пакеты».
 */
(function () {
  const ST = globalThis.ST;
  if (ST.local) return;
  const L = ST.L;
  const G = globalThis.ST_GLOSSARY;

  const pageHasTranslator = () => typeof self.Translator !== 'undefined' && typeof self.Translator.create === 'function';
  const pageHasDetector = () => typeof self.LanguageDetector !== 'undefined' && typeof self.LanguageDetector.create === 'function';

  // Коды языков расширения -> BCP 47 для Translator API
  function toBcp(code) {
    const c = L.normLang(code);
    if (c === 'zh-CN') return 'zh';
    if (c === 'zh-TW') return 'zh-Hant';
    return L.baseLang(c);
  }

  // API может не ответить (скрытая вкладка, нестандартная сборка) — не ждём бесконечно, уходим дальше
  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error((label || 'Встроенный переводчик') + ': нет ответа за ' + ms + ' мс')), ms);
      Promise.resolve(promise).then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); }
      );
    });
  }

  let hangs = 0; // зависания API на странице; после 5 — используем только мост
  const availability = new Map(); // "page|es>en" -> { state, at }
  const missing = new Set(); // пары, для которых нужен языковой пакет
  const memo = new Map(); // кэш переводов на странице
  const translators = new Map(); // "es>en" -> Promise<Translator> (только 'page')
  let detector = null;
  let bridgeInfo = null; // { translator, detector } — есть ли API на странице расширения
  let lastBackend = '';

  async function getBridgeInfo() {
    if (bridgeInfo) return bridgeInfo;
    try {
      const r = await withTimeout(ST.send({ type: 'localInfo' }), 8000, 'Мост встроенного переводчика');
      bridgeInfo = r && r.ok ? r.info : { translator: false, detector: false };
    } catch (e) {
      bridgeInfo = { translator: false, detector: false };
      setTimeout(() => { bridgeInfo = null; }, 60000); // попробуем позже ещё раз
    }
    return bridgeInfo;
  }

  // ---------- 'page': API прямо на странице ----------
  const page = {
    async state(src, tgt) {
      const key = 'page|' + src + '>' + tgt;
      const cached = availability.get(key);
      if (cached && Date.now() - cached.at < 60000) return cached.state;
      let state = 'unavailable';
      try {
        state = await withTimeout(self.Translator.availability({ sourceLanguage: src, targetLanguage: tgt }), 5000, 'Translator.availability');
      } catch (e) {
        if (/нет ответа/.test(e.message)) hangs++;
      }
      availability.set(key, { state, at: Date.now() });
      return state;
    },
    async translate(text, src, tgt) {
      const key = src + '>' + tgt;
      if (!translators.has(key)) {
        translators.set(key, withTimeout(self.Translator.create({ sourceLanguage: src, targetLanguage: tgt }), 15000, 'Translator.create').catch((e) => {
          translators.delete(key);
          throw e;
        }));
      }
      const tr = await translators.get(key);
      return withTimeout(tr.translate(text), 20000, 'Translator.translate');
    },
    async detect(text) {
      if ((await withTimeout(self.LanguageDetector.availability(), 5000, 'LanguageDetector.availability')) !== 'available') return null;
      detector = detector || (await withTimeout(self.LanguageDetector.create(), 15000, 'LanguageDetector.create'));
      return withTimeout(detector.detect(text), 8000, 'LanguageDetector.detect');
    }
  };

  // ---------- 'bridge': через страницу расширения ----------
  const bridge = {
    async state(src, tgt) {
      const key = 'bridge|' + src + '>' + tgt;
      const cached = availability.get(key);
      if (cached && Date.now() - cached.at < 60000) return cached.state;
      let state = 'unavailable';
      try {
        const r = await withTimeout(ST.send({ type: 'localAvailability', src, tgt }), 8000, 'Мост: проверка пакета');
        if (r && r.ok) state = r.state;
      } catch (e) { /* unavailable */ }
      availability.set(key, { state, at: Date.now() });
      return state;
    },
    async translate(text, src, tgt) {
      const r = await withTimeout(ST.send({ type: 'localTranslate', text, src, tgt }), 30000, 'Мост: перевод');
      if (!r || !r.ok) throw new Error((r && r.error) || 'мост не ответил');
      return r.translation;
    },
    async detect(text) {
      const r = await withTimeout(ST.send({ type: 'localDetect', text }), 15000, 'Мост: определение языка');
      return r && r.ok ? r.results : null;
    }
  };

  // Порядок: API на странице (если есть и не зависает), затем мост
  async function backends() {
    const list = [];
    if (pageHasTranslator() && hangs < 5) list.push(['page', page]);
    const bi = await getBridgeInfo();
    if (bi.translator) list.push(['bridge', bridge]);
    return list;
  }

  function enabled() {
    return ST.settings.localTranslatorMode !== 'off';
  }

  ST.local = {
    supported: pageHasTranslator,
    detectorSupported: pageHasDetector,
    missingPacks: () => Array.from(missing),
    hangs: () => hangs,
    lastBackend: () => lastBackend,
    bridgeInfo: () => bridgeInfo,

    // Определение языка встроенной моделью. { lang, confidence } или null
    async detect(text) {
      if (!enabled()) return null;
      const order = [];
      if (pageHasDetector() && hangs < 5) order.push(page);
      const bi = await getBridgeInfo();
      if (bi.detector) order.push(bridge);
      for (const b of order) {
        try {
          const res = await b.detect(text);
          const top = res && res[0];
          if (top && top.detectedLanguage && top.detectedLanguage !== 'und') {
            return { lang: L.normLang(top.detectedLanguage), confidence: top.confidence };
          }
        } catch (e) {
          if (b === page && /нет ответа/.test(e && e.message)) hangs++;
        }
      }
      return null;
    },

    /**
     * translate(text, sl, tl) -> { translation, detectedLang, provider: 'chrome-builtin' } или null,
     * если перевести на устройстве нельзя (нет API, нет пакета, глоссарий не сохранился).
     */
    async translate(text, sl, tl) {
      if (!enabled() || !sl || sl === 'auto') return null;
      const src = toBcp(sl);
      const tgt = toBcp(tl);
      if (!src || !tgt || src === tgt) return null;
      const glossary = ST.settings.glossary || '';
      const memoKey = L.hash(src + '>' + tgt + '|' + L.hash(glossary) + '|' + text);
      if (memo.has(memoKey)) return Object.assign({}, memo.get(memoKey), { fromCache: true });

      const p = G ? G.protect(text, glossary, tl) : { text, tokens: [] };
      let sawDownloadable = false;
      for (const [name, b] of await backends()) {
        const state = await b.state(src, tgt);
        if (state === 'downloadable' || state === 'downloading') sawDownloadable = true;
        if (state !== 'available') continue;
        try {
          let out = await b.translate(p.text, src, tgt);
          if (p.tokens.length) {
            // Метки глоссария должны пережить перевод, иначе термин потеряется — тогда облако
            for (let i = 0; i < p.tokens.length; i++) {
              if (!new RegExp('⟦\\s*' + i + '\\s*⟧').test(out)) return null;
            }
            out = G.restore(out, p.tokens);
          }
          missing.delete(src + '>' + tgt);
          lastBackend = name;
          const r = { translation: out, detectedLang: L.normLang(sl), provider: 'chrome-builtin', backend: name, fromCache: false };
          memo.set(memoKey, r);
          if (memo.size > 1000) memo.delete(memo.keys().next().value);
          return r;
        } catch (e) {
          if (name === 'page' && /нет ответа/.test(e && e.message)) hangs++;
          ST.log('Встроенный переводчик (' + name + ') не справился:', e && e.message);
        }
      }
      if (sawDownloadable) missing.add(src + '>' + tgt);
      return null;
    }
  };
})();
