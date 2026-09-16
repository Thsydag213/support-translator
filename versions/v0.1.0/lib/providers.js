/*
 * Провайдеры перевода. Единый интерфейс:
 *   translate({ text, sl, tl, settings }) -> Promise<{ translation, detectedLang }>
 * При ошибке бросают ProviderError с полем status (HTTP-код или 0 для сетевых).
 */
(function () {
  class ProviderError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status || 0;
    }
  }

  // --- Бесплатный неофициальный эндпоинт Google Translate (тот же, что у виджета/расширения Google) ---
  const googleFree = {
    id: 'google-free',
    title: 'Google Translate (бесплатный, неофициальный)',
    maxChunk: 4500,
    async translate({ text, sl, tl }) {
      const url =
        'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&dj=1' +
        '&sl=' + encodeURIComponent(sl || 'auto') +
        '&tl=' + encodeURIComponent(tl);
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: 'q=' + encodeURIComponent(text)
        });
      } catch (e) {
        throw new ProviderError('Сеть недоступна: ' + e.message, 0);
      }
      if (!res.ok) throw new ProviderError('Google free HTTP ' + res.status, res.status);
      const data = await res.json();
      const translation = (data.sentences || []).map((s) => s.trans || '').join('');
      return { translation, detectedLang: data.src || '' };
    }
  };

  // --- Официальный Google Cloud Translation API v2 (нужен API key, 500k символов/мес бесплатно) ---
  const googleCloud = {
    id: 'google-cloud',
    title: 'Google Cloud Translation API (официальный, ключ)',
    maxChunk: 4500,
    async translate({ text, sl, tl, settings }) {
      const key = settings && settings.googleCloudApiKey;
      if (!key) throw new ProviderError('Не задан API key Google Cloud', 401);
      const body = { q: text, target: tl, format: 'text' };
      if (sl && sl !== 'auto') body.source = sl;
      let res;
      try {
        res = await fetch('https://translation.googleapis.com/language/translate/v2?key=' + encodeURIComponent(key), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
      } catch (e) {
        throw new ProviderError('Сеть недоступна: ' + e.message, 0);
      }
      if (!res.ok) throw new ProviderError('Google Cloud HTTP ' + res.status, res.status);
      const data = await res.json();
      const t = data.data.translations[0];
      return { translation: decodeEntities(t.translatedText), detectedLang: t.detectedSourceLanguage || sl || '' };
    }
  };

  function decodeEntities(s) {
    return String(s)
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  globalThis.ST_PROVIDERS = { ProviderError, list: [googleFree, googleCloud], byId: { 'google-free': googleFree, 'google-cloud': googleCloud } };
})();
