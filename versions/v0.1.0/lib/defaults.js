/*
 * Общие настройки по умолчанию и утилиты.
 * Файл подключается и в service worker (import), и в content scripts, и в options/popup.
 * Поэтому — без import/export, всё кладём в globalThis.ST_LIB.
 */
(function () {
  const DEFAULTS = {
    enabled: true,

    // Входящие: на какой язык переводим сообщения пользователей
    targetLang: 'en',
    // Языки, которые НЕ переводим (команда их и так понимает)
    skipLangs: ['en'],

    // Исходящие: язык для обратного перевода (проверка смысла). 'auto' = язык оригинала оператора
    backTranslateLang: 'auto',
    // Язык по умолчанию для исходящих, если язык собеседника ещё не определён
    fallbackOutgoingLang: 'es',

    // Провайдер: 'google-free' (бесплатный неофициальный) | 'google-cloud' (официальный API, нужен ключ)
    provider: 'google-free',
    googleCloudApiKey: '',
    // Если бесплатный провайдер упал (429/блок) и есть ключ — переключаться на официальный
    fallbackToCloud: true,

    // 'below' — перевод под оригиналом; 'replace' — перевод вместо оригинала (оригинал по кнопке)
    displayMode: 'below',
    // Минимальная длина текста для перевода
    minChars: 3,

    // Показывать кнопку перевода у полей ввода
    outgoingButton: true,

    // Правила для сайтов ("конкретные окна")
    sites: [
      {
        id: 'mock',
        name: 'Тестовый чат (mock-chat.html)',
        enabled: true,
        urlPattern: '*mock-chat.html*',
        containerSelector: '#chat-messages',
        messageSelector: '.msg-text',
        inputSelector: '#composer, #composer-rich'
      }
    ]
  };

  const LANGS = [
    'en', 'ru', 'uk', 'es', 'pt', 'fr', 'de', 'it', 'pl', 'tr', 'ar', 'fa', 'he', 'hi', 'id', 'vi', 'th',
    'zh-CN', 'zh-TW', 'ja', 'ko', 'kk', 'uz', 'az', 'ka', 'hy', 'ro', 'cs', 'sk', 'hu', 'bg', 'sr', 'hr',
    'nl', 'sv', 'no', 'da', 'fi', 'el', 'lt', 'lv', 'et', 'ms', 'tl', 'bn', 'ur'
  ];

  let displayNames = null;
  function langName(code) {
    if (!code) return '?';
    try {
      displayNames = displayNames || new Intl.DisplayNames(['ru'], { type: 'language' });
      const n = displayNames.of(code);
      return n ? n.charAt(0).toUpperCase() + n.slice(1) : code;
    } catch (e) {
      return code;
    }
  }

  // Приводим коды языков Google/Chrome к единому виду
  function normLang(code) {
    if (!code) return '';
    let c = String(code).trim();
    const map = { iw: 'he', jw: 'jv', 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', zh: 'zh-CN', tl: 'tl', fil: 'tl', nb: 'no' };
    if (map[c]) return map[c];
    const low = c.toLowerCase();
    if (low === 'zh-cn') return 'zh-CN';
    if (low === 'zh-tw') return 'zh-TW';
    return low;
  }

  function baseLang(code) {
    return normLang(code).split('-')[0];
  }

  function sameLang(a, b) {
    return baseLang(a) === baseLang(b);
  }

  // Glob "*" -> RegExp, матчим весь URL
  function urlMatches(pattern, url) {
    if (!pattern) return false;
    return pattern
      .split(/[\n,]/)
      .map((p) => p.trim())
      .filter(Boolean)
      .some((p) => {
        const re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
        return re.test(url);
      });
  }

  function findSiteRule(settings, url) {
    return (settings.sites || []).find((s) => s.enabled !== false && urlMatches(s.urlPattern, url)) || null;
  }

  function mergeSettings(stored) {
    const s = Object.assign({}, DEFAULTS, stored || {});
    if (!Array.isArray(s.sites)) s.sites = DEFAULTS.sites;
    if (!Array.isArray(s.skipLangs)) s.skipLangs = DEFAULTS.skipLangs;
    return s;
  }

  // Быстрый не-криптографический хэш (FNV-1a) — для ключей кэша и отметок в DOM
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36) + str.length.toString(36);
  }

  globalThis.ST_LIB = { DEFAULTS, LANGS, langName, normLang, baseLang, sameLang, urlMatches, findSiteRule, mergeSettings, hash };
})();
