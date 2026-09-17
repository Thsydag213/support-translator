/*
 * Встроенный переводчик Chrome (Translator API и Language Detector API, Chrome 138+).
 * Переводит на устройстве: без сети, без лимитов, тексты не уходят в интернет.
 * Качество ниже облачного Google — поэтому используется для чтения входящих и обратного перевода,
 * а перевод ответа пользователю идёт через облачный провайдер.
 *
 * Модели языков скачиваются браузером. Скачивание требует действия пользователя (клик), поэтому
 * во время работы используется только уже скачанная пара языков, остальные — через облако.
 * Скачать пакеты заранее: настройки → «Перевод на устройстве» → «Скачать языковые пакеты».
 */
(function () {
  const ST = globalThis.ST;
  if (ST.local) return;
  const L = ST.L;
  const G = globalThis.ST_GLOSSARY;

  const hasTranslator = () => typeof self.Translator !== 'undefined' && typeof self.Translator.create === 'function';
  const hasDetector = () => typeof self.LanguageDetector !== 'undefined' && typeof self.LanguageDetector.create === 'function';

  // Коды языков расширения -> BCP 47 для Translator API
  function toBcp(code) {
    const c = L.normLang(code);
    if (c === 'zh-CN') return 'zh';
    if (c === 'zh-TW') return 'zh-Hant';
    return L.baseLang(c);
  }

  // API может не ответить (скрытая вкладка, нестандартная сборка браузера) — не ждём бесконечно, уходим в облако
  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error((label || 'Встроенный переводчик') + ': нет ответа за ' + ms + ' мс')), ms);
      Promise.resolve(promise).then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); }
      );
    });
  }
  let hangs = 0; // сколько раз API не ответил; после 3 — отключаем встроенный переводчик до перезагрузки страницы

  const translators = new Map(); // "es>en" -> Promise<Translator>
  const availability = new Map(); // "es>en" -> { state, at }
  const missing = new Set(); // пары, для которых нужен языковой пакет
  const memo = new Map(); // кэш переводов на странице
  let detector = null;

  async function pairState(src, tgt) {
    const key = src + '>' + tgt;
    const cached = availability.get(key);
    if (cached && Date.now() - cached.at < 60000) return cached.state;
    let state = 'unavailable';
    try {
      state = await withTimeout(self.Translator.availability({ sourceLanguage: src, targetLanguage: tgt }), 3000, 'Translator.availability');
    } catch (e) {
      if (/нет ответа/.test(e.message)) hangs++;
      state = 'unavailable';
    }
    availability.set(key, { state, at: Date.now() });
    if (state === 'downloadable' || state === 'downloading') missing.add(key);
    else missing.delete(key);
    return state;
  }

  async function getTranslator(src, tgt) {
    const key = src + '>' + tgt;
    if (!translators.has(key)) {
      translators.set(key, withTimeout(self.Translator.create({ sourceLanguage: src, targetLanguage: tgt }), 10000, 'Translator.create').catch((e) => {
        translators.delete(key);
        throw e;
      }));
    }
    return translators.get(key);
  }

  const usable = () => hasTranslator() && hangs < 3;

  ST.local = {
    supported: hasTranslator,
    detectorSupported: hasDetector,
    missingPacks: () => Array.from(missing),
    hangs: () => hangs,

    // Определение языка встроенной моделью (если скачана). { lang, confidence } или null
    async detect(text) {
      if (!hasDetector() || hangs >= 3) return null;
      try {
        if ((await withTimeout(self.LanguageDetector.availability(), 3000, 'LanguageDetector.availability')) !== 'available') return null;
        detector = detector || (await withTimeout(self.LanguageDetector.create(), 10000, 'LanguageDetector.create'));
        const res = await withTimeout(detector.detect(text), 5000, 'LanguageDetector.detect');
        const top = res && res[0];
        if (!top || top.detectedLanguage === 'und') return null;
        return { lang: L.normLang(top.detectedLanguage), confidence: top.confidence };
      } catch (e) {
        if (/нет ответа/.test(e && e.message)) hangs++;
        return null;
      }
    },

    /**
     * translate(text, sl, tl) -> { translation, detectedLang, provider: 'chrome-builtin' } или null,
     * если перевести на устройстве нельзя (нет API, нет пакета, глоссарий не сохранился) — тогда облако.
     */
    async translate(text, sl, tl) {
      if (!usable() || !sl || sl === 'auto') return null;
      const src = toBcp(sl);
      const tgt = toBcp(tl);
      if (!src || !tgt || src === tgt) return null;
      const glossary = ST.settings.glossary || '';
      const memoKey = L.hash(src + '>' + tgt + '|' + L.hash(glossary) + '|' + text);
      if (memo.has(memoKey)) return Object.assign({}, memo.get(memoKey), { fromCache: true });

      if ((await pairState(src, tgt)) !== 'available') return null;
      try {
        const tr = await getTranslator(src, tgt);
        const p = G ? G.protect(text, glossary, tl) : { text, tokens: [] };
        let out = await withTimeout(tr.translate(p.text), 15000, 'Translator.translate');
        if (p.tokens.length) {
          // Метки глоссария должны пережить перевод, иначе термин потеряется — тогда переводим в облаке
          for (let i = 0; i < p.tokens.length; i++) {
            if (!new RegExp('⟦\\s*' + i + '\\s*⟧').test(out)) return null;
          }
          out = G.restore(out, p.tokens);
        }
        const r = { translation: out, detectedLang: L.normLang(sl), provider: 'chrome-builtin', fromCache: false };
        memo.set(memoKey, r);
        if (memo.size > 1000) memo.delete(memo.keys().next().value);
        return r;
      } catch (e) {
        if (/нет ответа/.test(e && e.message)) hangs++;
        ST.log('Встроенный переводчик не справился:', e && e.message);
        return null;
      }
    },

    // Состояние для диагностики/настроек
    async info(langs, target) {
      const out = { translator: hasTranslator(), detector: hasDetector(), pairs: {} };
      if (!out.translator) return out;
      const tgt = toBcp(target || ST.settings.targetLang);
      for (const l of langs || []) {
        const src = toBcp(l);
        if (src && src !== tgt) out.pairs[src + '>' + tgt] = await pairState(src, tgt);
      }
      return out;
    }
  };
})();
