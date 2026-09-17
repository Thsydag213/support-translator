/*
 * Мост встроенного переводчика Chrome: выполняет Translator / LanguageDetector API на странице расширения
 * по запросам service worker. Сообщения адресуются полем target: 'offscreen'; остальные игнорируются.
 */
(function () {
  const translators = new Map(); // "es>en" -> Promise<Translator>
  let detector = null;

  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(label + ': нет ответа за ' + ms + ' мс')), ms);
      Promise.resolve(promise).then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); }
      );
    });
  }

  const hasTranslator = () => typeof self.Translator !== 'undefined';
  const hasDetector = () => typeof self.LanguageDetector !== 'undefined';

  function getTranslator(src, tgt) {
    const key = src + '>' + tgt;
    if (!translators.has(key)) {
      translators.set(key, withTimeout(Translator.create({ sourceLanguage: src, targetLanguage: tgt }), 15000, 'create').catch((e) => {
        translators.delete(key);
        throw e;
      }));
    }
    return translators.get(key);
  }

  async function handle(msg) {
    switch (msg.op) {
      case 'info':
        return { ok: true, info: { translator: hasTranslator(), detector: hasDetector() } };
      case 'availability': {
        if (!hasTranslator()) return { ok: true, state: 'unavailable' };
        const state = await withTimeout(Translator.availability({ sourceLanguage: msg.src, targetLanguage: msg.tgt }), 5000, 'availability');
        return { ok: true, state };
      }
      case 'translate': {
        if (!hasTranslator()) return { ok: false, error: 'Translator API недоступен' };
        const tr = await getTranslator(msg.src, msg.tgt);
        const translation = await withTimeout(tr.translate(msg.text), 25000, 'translate');
        return { ok: true, translation };
      }
      // Несколько фрагментов (строки текста) за один вызов — чтобы сохранить переносы строк и абзацы
      case 'translateMany': {
        if (!hasTranslator()) return { ok: false, error: 'Translator API недоступен' };
        const tr = await getTranslator(msg.src, msg.tgt);
        const translations = [];
        for (const t of msg.texts) translations.push(await withTimeout(tr.translate(t), 25000, 'translate'));
        return { ok: true, translations };
      }
      case 'detect': {
        if (!hasDetector()) return { ok: false, error: 'LanguageDetector API недоступен' };
        if ((await withTimeout(LanguageDetector.availability(), 5000, 'detector availability')) !== 'available') return { ok: false, error: 'модель определения языка не скачана' };
        detector = detector || (await withTimeout(LanguageDetector.create(), 15000, 'detector create'));
        const results = await withTimeout(detector.detect(msg.text), 8000, 'detect');
        return { ok: true, results: results.slice(0, 3).map((r) => ({ detectedLanguage: r.detectedLanguage, confidence: r.confidence })) };
      }
      default:
        return { ok: false, error: 'unknown op' };
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target !== 'offscreen') return false;
    handle(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  });
})();
