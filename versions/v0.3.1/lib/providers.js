/*
 * Провайдеры перевода. Единый интерфейс:
 *   translate({ text, sl, tl, settings, spell }) -> Promise<{ translation, detectedLang, spell? }>
 *   spell (вход) — запросить проверку орфографии исходного текста
 *   spell — исправленный вариант исходного текста, если переводчик нашёл опечатки (не у всех провайдеров)
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
    async translate({ text, sl, tl, spell }) {
      const url =
        // dt=t — перевод; dt=qca — проверка орфографии исходного текста (только когда нужна подсказка опечаток)
        'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t' + (spell ? '&dt=qca' : '') + '&dj=1' +
        '&sl=' + encodeURIComponent(sl || 'auto') +
        '&tl=' + encodeURIComponent(tl);
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: 'q=' + encodeURIComponent(text),
          // При ограничении Google перенаправляет на google.com/sorry (captcha). Не идём по редиректу:
          // иначе Chrome пишет в ошибки расширения CORS-ошибку, а мы получаем невнятное "Failed to fetch"
          redirect: 'manual'
        });
      } catch (e) {
        throw new ProviderError('Сеть недоступна: ' + e.message, 0);
      }
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        throw new ProviderError('Google ограничил запросы с этого IP (перенаправление на страницу проверки)', 429);
      }
      if (!res.ok) throw new ProviderError('Google free HTTP ' + res.status, res.status);
      let data;
      try {
        data = await res.json();
      } catch (e) {
        // Вместо JSON пришла HTML-страница "Sorry… / captcha" — Google ограничил запросы с этого IP
        throw new ProviderError('Google ограничил запросы с этого IP (страница проверки)', 429);
      }
      const translation = (data.sentences || []).map((s) => s.trans || '').join('');
      const spellRes = spell && data.spell && typeof data.spell.spell_res === 'string' ? data.spell.spell_res : '';
      return { translation, detectedLang: data.src || '', spell: spellRes };
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

  // --- Тестовый провайдер без сети: для проверки интерфейса, не расходуя лимиты Google ---
  const MOCK_LANGS = [
    ['es', /\b(hola|gracias|cuenta|puedo|pago|reembolso|por favor|necesito|quiero|mi|el|la|que|no)\b/i],
    ['pt', /\b(olá|obrigad[oa]|equipe|não|gostaria|você|minha|assinatura)\b/i],
    ['tr', /\b(merhaba|lütfen|ödeme|teşekkür|hesabım|yardım)\b/i],
    ['fr', /\b(bonjour|merci|je|vous|remboursement|pouvez)\b/i],
    ['de', /\b(guten|ich|danke|nicht|bitte|möchte)\b/i],
    ['it', /\b(ciao|grazie|pagamento|vorrei)\b/i]
  ];
  const MOCK_SPELL = { 'Здраствуйте': 'Здравствуйте', 'проверели': 'проверили', 'плотеж': 'платеж', 'пожалуста': 'пожалуйста' };

  const devMock = {
    id: 'dev-mock',
    title: 'Тестовый (без сети, для разработки)',
    maxChunk: 4500,
    async translate({ text, sl, tl, spell: wantSpell }) {
      await new Promise((r) => setTimeout(r, 120));
      let src = sl && sl !== 'auto' ? sl : '';
      if (!src) {
        if (/\p{Script=Cyrillic}/u.test(text)) src = 'ru';
        else if (/\p{Script=Arabic}/u.test(text)) src = 'ar';
        else if (/\p{Script=Han}/u.test(text)) src = 'zh-CN';
        else src = (MOCK_LANGS.find(([, re]) => re.test(text)) || ['en'])[0];
      }
      let spell = '';
      let fixed = text;
      for (const [bad, good] of Object.entries(MOCK_SPELL)) fixed = fixed.split(bad).join(good);
      if (wantSpell && fixed !== text) spell = fixed;
      const same = src.split('-')[0] === String(tl).split('-')[0];
      return { translation: same ? text : '[' + tl + '] ' + text, detectedLang: src, spell };
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

  globalThis.ST_PROVIDERS = {
    ProviderError,
    list: [googleFree, googleCloud, devMock],
    byId: { 'google-free': googleFree, 'google-cloud': googleCloud, 'dev-mock': devMock }
  };
})();
