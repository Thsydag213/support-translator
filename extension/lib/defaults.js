/*
 * Общие настройки по умолчанию и утилиты.
 * Файл подключается и в service worker (import), и в content scripts, и в options/popup/stats.
 * Поэтому — без import/export, всё кладём в globalThis.ST_LIB.
 */
(function () {
  const SITE_DEFAULTS = {
    id: '',
    name: 'Новый сайт',
    enabled: true,
    // Где включать: glob-шаблоны URL через запятую (включая URL iframe с чатом)
    urlPattern: '',
    // Дополнительные домены доступа (match patterns), если их нельзя вывести из urlPattern
    origins: '',
    containerSelector: '',
    messageSelector: '',
    // Отличает сообщения ПОЛЬЗОВАТЕЛЯ от сообщений оператора (например ".msg.in").
    // Нужен, чтобы язык собеседника брался только из его сообщений. Пусто = игнорируем operatorLangs
    userMessageSelector: '',
    inputSelector: '',
    // Кнопка отправки сообщения на сайте (для защиты от отправки без перевода)
    sendButtonSelector: '',
    // Как сайт отправляет сообщение с клавиатуры: 'enter' | 'ctrl+enter' | 'none'
    sendKey: 'enter',
    // Элемент, текст которого однозначно определяет тикет (номер/ID). Пусто = URL страницы
    ticketIdSelector: '',
    // Куда вставлять подпись перевода: 'inside' (внутрь сообщения) | 'after' (соседним элементом)
    insertMode: 'inside',
    // Предупреждать об отправке непереведённого текста
    sendGuard: true
  };

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

    // Защита от отправки без перевода: не проверять сообщения короче N букв ("ok", "спасибо")
    guardMinLetters: 8,

    // Языки, на которых пишут операторы. Сообщения на них не считаются "языком собеседника"
    // (если у правила сайта не задан userMessageSelector)
    operatorLangs: ['ru'],

    // Глоссарий (текст, по строке на термин):
    //   Premium Plus                                   — не переводить
    //   Кошелёк => ru: Кошелёк | es: Billetera | en: Wallet — фиксированный перевод
    glossary: '',

    // Статистика: сколько дней хранить
    statsKeepDays: 90,

    // Правила для сайтов ("конкретные окна")
    sites: [
      Object.assign({}, SITE_DEFAULTS, {
        id: 'mock',
        name: 'Тестовый чат (mock-chat.html)',
        urlPattern: '*mock-chat.html*',
        origins: 'http://localhost/*, http://127.0.0.1/*',
        containerSelector: '#chat-messages',
        messageSelector: '.msg-text',
        userMessageSelector: '.msg.in',
        inputSelector: '#composer, #composer-rich',
        sendButtonSelector: '#send',
        ticketIdSelector: '#chatTitle'
      })
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
    const c = String(code).trim();
    const map = { iw: 'he', jw: 'jv', 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', zh: 'zh-CN', fil: 'tl', nb: 'no' };
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
    return !!a && !!b && baseLang(a) === baseLang(b);
  }

  // Письменность языка — для мгновенной (синхронной) проверки "текст не на том языке"
  const LANG_SCRIPT = {
    ru: 'Cyrillic', uk: 'Cyrillic', be: 'Cyrillic', bg: 'Cyrillic', mk: 'Cyrillic', kk: 'Cyrillic', ky: 'Cyrillic',
    mn: 'Cyrillic', tg: 'Cyrillic',
    ar: 'Arabic', fa: 'Arabic', ur: 'Arabic', ps: 'Arabic',
    he: 'Hebrew', yi: 'Hebrew', el: 'Greek', th: 'Thai', ka: 'Georgian', hy: 'Armenian',
    hi: 'Devanagari', mr: 'Devanagari', ne: 'Devanagari', bn: 'Bengali',
    zh: 'CJK', ja: 'CJK', ko: 'Hangul'
  };
  const SCRIPTS = [
    ['Cyrillic', /\p{Script=Cyrillic}/u], ['Latin', /\p{Script=Latin}/u], ['Arabic', /\p{Script=Arabic}/u],
    ['Hebrew', /\p{Script=Hebrew}/u], ['Greek', /\p{Script=Greek}/u], ['Thai', /\p{Script=Thai}/u],
    ['Georgian', /\p{Script=Georgian}/u], ['Armenian', /\p{Script=Armenian}/u], ['Devanagari', /\p{Script=Devanagari}/u],
    ['Bengali', /\p{Script=Bengali}/u], ['Hangul', /\p{Script=Hangul}/u],
    ['CJK', /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u]
  ];

  function langScript(code) {
    const b = baseLang(code);
    return LANG_SCRIPT[b] || (b ? 'Latin' : '');
  }

  // Доминирующая письменность текста: { script, share, letters }
  function textScript(text) {
    const counts = {};
    let letters = 0;
    for (const ch of String(text).replace(/https?:\/\/\S+/g, '')) {
      if (!/\p{L}/u.test(ch)) continue;
      letters++;
      for (const [name, re] of SCRIPTS) {
        if (re.test(ch)) {
          counts[name] = (counts[name] || 0) + 1;
          break;
        }
      }
    }
    let best = '';
    for (const k of Object.keys(counts)) if (!best || counts[k] > counts[best]) best = k;
    return { script: best, share: letters ? (counts[best] || 0) / letters : 0, letters };
  }

  // Glob "*" -> RegExp, матчим весь URL
  function urlMatches(pattern, url) {
    if (!pattern) return false;
    return splitList(pattern).some((p) => {
      const re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
      return re.test(url);
    });
  }

  function splitList(s) {
    return String(s || '').split(/[\n,]/).map((p) => p.trim()).filter(Boolean);
  }

  const MATCH_PATTERN_RE = /^(\*|https?):\/\/(\*|\*\.[^/*:]+|[^/*:]+)\/\*$/;

  // Домены доступа правила: выводим из urlPattern (https://desk.com/tickets/* -> https://desk.com/*) + ручные
  function ruleOrigins(rule) {
    const out = new Set();
    for (const p of splitList(rule.urlPattern)) {
      const m = /^(\*|https?):\/\/([^/]+)/i.exec(p);
      if (!m) continue;
      const host = m[2].replace(/:\d+$/, '').replace(/:\*$/, '');
      const candidate = m[1].toLowerCase() + '://' + host.toLowerCase() + '/*';
      if (MATCH_PATTERN_RE.test(candidate)) out.add(candidate);
    }
    for (const o of splitList(rule.origins)) if (MATCH_PATTERN_RE.test(o)) out.add(o);
    return Array.from(out);
  }

  function isValidMatchPattern(p) {
    return MATCH_PATTERN_RE.test(p);
  }

  function findSiteRule(settings, url) {
    return (settings.sites || []).find((s) => s.enabled !== false && urlMatches(s.urlPattern, url)) || null;
  }

  function mergeSettings(stored) {
    const s = Object.assign({}, DEFAULTS, stored || {});
    if (!Array.isArray(s.sites)) s.sites = DEFAULTS.sites;
    s.sites = s.sites.map((site) => Object.assign({}, SITE_DEFAULTS, site));
    if (!Array.isArray(s.skipLangs)) s.skipLangs = DEFAULTS.skipLangs;
    if (!Array.isArray(s.operatorLangs)) s.operatorLangs = DEFAULTS.operatorLangs;
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

  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  globalThis.ST_LIB = {
    DEFAULTS, SITE_DEFAULTS, LANGS, langName, normLang, baseLang, sameLang, langScript, textScript,
    urlMatches, splitList, ruleOrigins, isValidMatchPattern, findSiteRule, mergeSettings, hash, today
  };
})();
