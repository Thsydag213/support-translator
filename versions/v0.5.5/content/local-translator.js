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
    async translateMany(texts, src, tgt) {
      const out = [];
      for (const t of texts) out.push(await this.translate(t, src, tgt));
      return out;
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
    async translateMany(texts, src, tgt) {
      const r = await withTimeout(ST.send({ type: 'localTranslateMany', texts, src, tgt }), 20000 + texts.length * 5000, 'Мост: перевод');
      if (!r || !r.ok) throw new Error((r && r.error) || 'мост не ответил');
      return r.translations;
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

      // Встроенный переводчик склеивает строки и абзацы в один кусок. Поэтому переводим ПОСТРОЧНО:
      // пустые строки, отступы и маркеры списков (*, -, •, 1.) остаются как были, переводится только текст строки.
      const segments = String(text).replace(/\r/g, '').split('\n').map((line) => {
        const m = /^([\s ]*(?:(?:[-*•·▪◦]|\d{1,3}[.)])[\s ]+)?)([\s\S]*?)([\s ]*)$/.exec(line);
        const core = m ? m[2] : line;
        return { pre: m ? m[1] : '', core, post: m ? m[3] : '', translate: /\p{L}/u.test(core) };
      });
      const toTranslate = segments.filter((s) => s.translate);
      if (!toTranslate.length) return null;
      const protectedCores = toTranslate.map((s) => (G ? G.protect(s.core, glossary, tl) : { text: s.core, tokens: [] }));

      // Собираем результат; null — метки глоссария не пережили перевод (тогда облако)
      const build = (outs, name, via) => {
        if (!outs || outs.length !== protectedCores.length) throw new Error('переведены не все строки');
        for (let k = 0; k < protectedCores.length; k++) {
          const p = protectedCores[k];
          let line = String(outs[k] || '').replace(/\n+/g, ' ').trim();
          if (p.tokens.length) {
            for (let i = 0; i < p.tokens.length; i++) {
              if (!new RegExp('⟦\\s*' + i + '\\s*⟧').test(line)) return null;
            }
            line = G.restore(line, p.tokens);
          }
          toTranslate[k].out = line;
        }
        const out = segments.map((s) => (s.translate ? s.pre + s.out + s.post : s.pre + s.core + s.post)).join('\n');
        lastBackend = name;
        const r = { translation: out, detectedLang: L.normLang(sl), provider: 'chrome-builtin', backend: name, via: via || '', fromCache: false };
        memo.set(memoKey, r);
        if (memo.size > 1000) memo.delete(memo.keys().next().value);
        return r;
      };
      const texts = protectedCores.map((p) => p.text);

      // 1) прямая пара
      let sawDownloadable = false;
      for (const [name, b] of await backends()) {
        const state = await b.state(src, tgt);
        if (state === 'downloadable' || state === 'downloading') sawDownloadable = true;
        if (state !== 'available') continue;
        try {
          const r = build(await b.translateMany(texts, src, tgt), name);
          if (r) missing.delete(src + '>' + tgt);
          return r;
        } catch (e) {
          if (name === 'page' && /нет ответа/.test(e && e.message)) hangs++;
          ST.log('Встроенный переводчик (' + name + ') не справился:', e && e.message);
        }
      }

      // 2) нет прямого пакета (например, испанский → корейский) — через английский скачанными пакетами
      if (src !== 'en' && tgt !== 'en') {
        for (const [name, b] of await backends()) {
          if ((await b.state(src, 'en')) !== 'available' || (await b.state('en', tgt)) !== 'available') continue;
          try {
            const mid = await b.translateMany(texts, src, 'en');
            if (!mid || mid.length !== texts.length) throw new Error('переведены не все строки');
            const r = build(await b.translateMany(mid.map((x) => String(x || '').replace(/\n+/g, ' ').trim()), 'en', tgt), name, 'en');
            if (r) missing.delete(src + '>' + tgt);
            return r;
          } catch (e) {
            if (name === 'page' && /нет ответа/.test(e && e.message)) hangs++;
            ST.log('Встроенный переводчик через английский (' + name + ') не справился:', e && e.message);
          }
        }
      }

      if (sawDownloadable) missing.add(src + '>' + tgt);
      return null;
    }
  };
})();
