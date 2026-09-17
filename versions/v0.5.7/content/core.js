/*
 * Ядро content script: состояние, настройки, мост к service worker, определение языка, утилиты DOM.
 * Все файлы content/* выполняются в одном изолированном мире и делят объект ST.
 */
(function () {
  if (globalThis.ST) return;
  const L = globalThis.ST_LIB;

  const ST = (globalThis.ST = {
    L,
    settings: L.mergeSettings(null),
    site: null, // активное правило сайта или null
    dead: false, // расширение перезагружено — контекст недействителен
    state: {
      conversationLang: '', // последний определённый иностранный язык на вкладке
      frameLang: null, // { lang, at } — язык собеседника, найденный в другом фрейме вкладки (письмо во фрейме)
      navAt: 0, // время последней смены страницы/тикета (SPA)
      lastError: null // { msg, at } — последняя ошибка перевода (для самопроверки)
    },
    UI_ATTR: 'data-st-ui',
    isTop: window === window.top
  });

  ST.log = (...a) => console.debug('[SupportTranslator]', ...a);

  // macOS: вместо Ctrl — Command (⌘) в подсказках и при повторной отправке по Ctrl/⌘+Enter
  ST.isMac = /mac/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');
  ST.keys = (label) => (ST.isMac ? String(label).replace(/Ctrl\+/g, '⌘').replace(/Shift\+/g, '⇧').replace(/Alt\+/g, '⌥') : label);

  // URL для сопоставления с правилами. У встроенных фреймов без своего адреса (about:srcdoc, about:blank —
  // так часто показывают HTML-письма) берём адрес родительской страницы.
  ST.effectiveUrl = function () {
    const href = location.href;
    if (!/^(about:|blob:|data:)/i.test(href)) return href;
    try {
      return window.parent.location.href;
    } catch (e) {
      const ao = location.ancestorOrigins;
      if (ao && ao.length) return ao[0] + '/';
    }
    return href;
  };

  ST.loadSettings = async function () {
    const { settings, langLocks } = await chrome.storage.local.get(['settings', 'langLocks']);
    ST.settings = L.mergeSettings(settings);
    ST.site = ST.settings.enabled ? L.findSiteRule(ST.settings, ST.effectiveUrl()) : null;
    ST.langLock._cache = langLocks || {};
    return ST.settings;
  };

  ST.saveSettings = async function (settings) {
    await chrome.storage.local.set({ settings });
  };

  // --- мост к service worker ---
  function checkAlive(e) {
    const invalid = !chrome.runtime || !chrome.runtime.id || /context invalidated/i.test(String(e && e.message));
    if (invalid && !ST.dead) {
      ST.dead = true;
      ST.incoming && ST.incoming.stop();
      ST.toast('Support Translator обновлён — обновите страницу (F5)', { error: true, duration: 10000 });
    }
    return !invalid;
  }

  // Синхронная проверка: после обновления/перезагрузки расширения старые скрипты на странице
  // теряют chrome.runtime.id — они должны сразу перестать что-либо перехватывать
  ST.alive = function () {
    if (ST.dead) return false;
    if (!chrome.runtime || !chrome.runtime.id) {
      checkAlive(null);
      return false;
    }
    return true;
  };

  ST.send = async function (msg) {
    if (ST.dead) throw new Error('Расширение обновлено — обновите страницу');
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      checkAlive(e);
      throw e;
    }
  };

  /**
   * opts.local       — сначала попробовать встроенный переводчик Chrome (без сети)
   * opts.localSource — язык исходного текста для него (встроенному переводчику нужен явный язык)
   * opts.batch/hint  — можно объединить с другими сообщениями этого языка в один облачный запрос
   * opts.spell       — запросить подсказку опечаток (облако)
   */
  ST.translate = async function (text, sl, tl, opts) {
    opts = opts || {};
    const localOn = opts.local && ST.local && ST.settings.localTranslatorMode !== 'off';
    const tryLocal = async (src) => {
      const r = await ST.local.translate(text, src, tl).catch(() => null);
      if (r && !r.fromCache) ST.track({ kind: 'local', chars: String(text).length });
      return r;
    };
    const firstSrc = sl && sl !== 'auto' ? sl : opts.localSource;
    // 1) скачанный переводчик Chrome — первым
    if (localOn && firstSrc) {
      const r = await tryLocal(firstSrc);
      if (r) return r;
    }
    // 2) облако
    const cloudOpts = { spell: !!opts.spell, batch: !!opts.batch, hint: opts.hint || '' };
    let resp;
    try {
      resp = await ST.send({ type: 'translate', text, sl: sl || 'auto', tl, opts: cloudOpts });
    } catch (e) {
      resp = { ok: false, error: e.message };
    }
    if (resp && resp.ok) return resp.result;
    let msg = (resp && resp.error) || 'Нет ответа от расширения';
    // Облако не ответило, а на устройстве не хватило пакета — подсказываем, что скачать
    const tgtBcp = L.baseLang(tl);
    const miss = localOn && ST.local.missingPacks().filter((p) => p.endsWith('>' + tgtBcp));
    if (miss && miss.length) {
      msg = 'Нет скачанного языкового пакета ' + miss.map((p) => p.replace('>', '→')).join(', ') +
        (tgtBcp !== 'en' ? ' (или пар через английский)' : '') +
        ', а облако не ответило: ' + msg + '. Скачайте пакеты: настройки расширения → «Перевод на устройстве» → «Скачать языковые пакеты».';
    }
    // 3) облако недоступно (лимит Google и т.п.) — ещё раз на устройстве по неуверенной догадке о языке
    if (localOn && opts.localGuess && opts.localGuess !== firstSrc) {
      const r = await tryLocal(opts.localGuess);
      if (r) return Object.assign({}, r, { guessed: true });
    }
    ST.state.lastError = { msg, at: Date.now() };
    throw new Error(msg);
  };

  /**
   * Язык текста без облака: { lang, guess }
   *   lang  — уверенный (CLD уверен или встроенный детектор ≥ 0.7);
   *   guess — лучшая неуверенная догадка (для перевода на устройстве, если облако недоступно).
   */
  ST.detectSource = async function (text) {
    const cld = await ST.detectLocal(text);
    if (cld.reliable) return { lang: cld.lang, guess: cld.lang };
    let guess = cld.lang || '';
    if (ST.local && ST.settings.localTranslatorMode !== 'off') {
      const d = await ST.local.detect(text);
      if (d && d.confidence >= 0.7) return { lang: d.lang, guess: d.lang };
      if (d && d.confidence >= 0.3) guess = d.lang;
    }
    return { lang: '', guess };
  };

  // Статистика: fire-and-forget
  ST.track = function (event) {
    if (ST.dead) return;
    ST.send({ type: 'event', event }).catch(() => {});
  };

  // Локальное определение языка (CLD, встроен в Chrome) — без сетевых запросов
  ST.detectLocal = async function (text) {
    try {
      const r = await chrome.i18n.detectLanguage(text);
      const top = r && r.languages && r.languages[0];
      if (!top) return { lang: '', reliable: false };
      return { lang: L.normLang(top.language), reliable: !!r.isReliable && top.percentage >= 80 };
    } catch (e) {
      return { lang: '', reliable: false };
    }
  };

  ST.isForeign = function (lang) {
    const s = ST.settings;
    return !!lang && !L.sameLang(lang, s.targetLang) && !s.skipLangs.some((x) => L.sameLang(x, lang));
  };

  // Язык собеседника на вкладке — привязан к тикету: язык прошлого тикета не должен подставляться в новый
  ST.setConversationLang = function (lang) {
    if (ST.isForeign(lang) && !(ST.settings.operatorLangs || []).some((x) => L.sameLang(x, lang))) {
      ST.state.conversationLang = lang;
      ST.state.conversationLangKey = ST.ticketKey();
    }
  };
  ST.conversationLangForTicket = function () {
    return ST.state.conversationLangKey === ST.ticketKey() ? ST.state.conversationLang : '';
  };

  // Язык, который оператор выбирал в панели для ЭТОГО тикета (не закрепление, просто память)
  ST.ticketLang = {
    _cache: null,
    async _load() {
      if (!this._cache) {
        const { ticketLangs } = await chrome.storage.local.get('ticketLangs');
        this._cache = ticketLangs || {};
      }
      return this._cache;
    },
    async get() {
      const all = await this._load();
      const x = all[ST.ticketKey()];
      return x ? x.lang : '';
    },
    async set(lang) {
      const all = await this._load();
      all[ST.ticketKey()] = { lang, at: Date.now() };
      const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
      for (const k of keys.slice(500)) delete all[k];
      await chrome.storage.local.set({ ticketLangs: all });
    }
  };

  /**
   * Язык собеседника для текущего тикета — с дополнительными источниками, которые требуют времени:
   *  1) 📌 / переведённые сообщения пользователя / письмо во фрейме (ST.expectedLang);
   *  2) определение по тексту сообщений пользователя на странице (даже если «Сообщение» настроено неточно);
   *  3) язык, который оператор уже выбирал в этом тикете.
   * Язык прошлых тикетов не используется.
   */
  ST.resolveConversationLang = async function () {
    const exp = ST.expectedLang();
    if (exp.lang) return exp;
    const key = ST.ticketKey();
    const cached = ST.state.detectedLang;
    if (cached && cached.key === key && cached.lang) return { lang: cached.lang, source: 'detected' };

    const sel = ST.site && ST.site.userMessageSelector;
    if (sel) {
      const els = ST.qsaSafe(sel).filter((el) => !ST.isOurNode(el) && el.getClientRects().length > 0).slice(-4);
      const text = els.map((el) => ST.extractText(el)).join('\n').slice(-1500);
      if (text.trim().length >= 12) {
        const d = await ST.detectSource(text);
        const lang = d.lang || d.guess;
        if (lang && ST.isForeign(lang) && !(ST.settings.operatorLangs || []).some((x) => L.sameLang(x, lang))) {
          ST.state.detectedLang = { key, lang };
          return { lang, source: 'detected' };
        }
      }
    }
    const conv = ST.conversationLangForTicket();
    if (conv) return { lang: conv, source: 'messages' };
    const remembered = await ST.ticketLang.get();
    if (remembered) return { lang: remembered, source: 'ticket' };
    return { lang: '', source: '' };
  };

  // --- тикет и закреплённый язык ---
  ST.ticketKey = function () {
    const sel = ST.site && ST.site.ticketIdSelector;
    if (sel) {
      try {
        const el = ST.qsa(sel)[0];
        const t = el && (el.innerText || el.textContent || '').trim().slice(0, 120);
        if (t) return location.host + '|' + t;
      } catch (e) { /* неверный селектор */ }
    }
    return location.host + location.pathname + location.search + location.hash;
  };

  ST.langLock = {
    _cache: {},
    get() {
      const x = this._cache[ST.ticketKey()];
      return x ? x.lang : '';
    },
    async set(lang) {
      const { langLocks } = await chrome.storage.local.get('langLocks');
      const all = langLocks || {};
      all[ST.ticketKey()] = { lang, at: Date.now() };
      // храним последние 300 тикетов
      const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
      for (const k of keys.slice(300)) delete all[k];
      this._cache = all;
      await chrome.storage.local.set({ langLocks: all });
    },
    async clear() {
      const { langLocks } = await chrome.storage.local.get('langLocks');
      const all = langLocks || {};
      delete all[ST.ticketKey()];
      this._cache = all;
      await chrome.storage.local.set({ langLocks: all });
    }
  };

  // Язык, на котором нужно отвечать в текущем тикете: { lang, source }
  ST.expectedLang = function () {
    const locked = ST.langLock.get();
    if (locked) return { lang: locked, source: 'lock' };
    const last = ST.incoming ? ST.incoming.lastForeignLang() : '';
    if (last) return { lang: last, source: 'messages' };
    // Язык из письма в другом фрейме (например, email во встроенном iframe) — только для текущего тикета
    const fl = ST.state.frameLang;
    if (fl && fl.lang && fl.at >= ST.state.navAt - 1500) return { lang: fl.lang, source: 'frame' };
    // Определённый по тексту сообщений пользователя этого тикета (заполняет ST.resolveConversationLang)
    const dl = ST.state.detectedLang;
    if (dl && dl.lang && dl.key === ST.ticketKey()) return { lang: dl.lang, source: 'detected' };
    return { lang: '', source: '' };
  };

  // --- Режим внутренней заметки ---
  // В хелпдесках композер переключается между "Ответ" и "Заметка". Заметки пишутся для коллег —
  // их не нужно ни проверять защитой, ни переводить.
  // Элемент с подписью режима действительно показывает АКТИВНЫЙ режим:
  //  - выбранная вкладка/переключатель (aria-selected/pressed/checked = true, data-state=active|on|checked, класс active/selected) — сам или прямой родитель;
  //  - кнопка-выпадашка, на которой написан текущий режим ("Note ▾"): кнопка с aria-haspopup, при этом не пункт открытого меню.
  const CLASS_ACTIVE = /(^|[\s_-])(active|selected|is-active|checked)($|[\s_-])/i;
  function classOf(el) {
    return el && typeof el.className === 'string' ? el.className : '';
  }
  function activeIndicator(el) {
    for (let cur = el, i = 0; cur && i < 2; cur = cur.parentElement, i++) {
      for (const a of ['aria-selected', 'aria-pressed', 'aria-checked']) if (cur.getAttribute(a) === 'true') return a + '=true';
      if (/^(active|on|checked)$/.test(cur.getAttribute('data-state') || '')) return 'data-state=' + cur.getAttribute('data-state');
      if (CLASS_ACTIVE.test(classOf(cur))) return 'class';
    }
    if (el.closest('[role="menu"],[role="listbox"],[role="menuitem"],[role="option"]')) return '';
    const btn = el.closest('button,[role="button"]');
    if (btn && btn.hasAttribute('aria-haspopup') && ST.composedContains(btn, el)) return 'dropdown-trigger';
    return '';
  }

  // Возвращает { note: boolean, reason: string } — reason показывается в диагностике
  ST.noteModeInfo = function (field) {
    const site = ST.site;
    if (!site || !field) return { note: false, reason: '' };
    if (site.noteSelector) {
      try {
        if (ST.closestDeep(field, site.noteSelector)) return { note: true, reason: 'noteSelector: поле внутри' };
        if (ST.qsa(site.noteSelector).some((e) => e.getClientRects().length > 0)) return { note: true, reason: 'noteSelector: элемент виден' };
      } catch (e) { /* неверный селектор */ }
    }
    const words = L.splitList(site.noteModeText).map((w) => w.toLowerCase());
    if (!words.length) return { note: false, reason: '' };
    // Поднимаемся от поля к "шапке" композера, пока предок не станет слишком большим
    let cur = field;
    for (let level = 0; level < 8; level++) {
      cur = cur.parentElement || (cur.getRootNode() && cur.getRootNode().host) || null;
      if (!cur) break;
      const all = cur.querySelectorAll('*');
      if (all.length > 600) break;
      for (const el of all) {
        if (el.children.length > 2 || ST.isOurNode(el) || field.contains(el)) continue;
        const t = (el.textContent || '').replace(/[▾▼⌄⏷▴▲]/g, '').trim().toLowerCase();
        if (!t || t.length > 25 || !words.includes(t)) continue;
        if (!el.getClientRects().length) continue;
        const why = activeIndicator(el);
        if (why) return { note: true, reason: '«' + t + '» (' + why + ') <' + el.tagName.toLowerCase() + ' class="' + classOf(el).slice(0, 60) + '">' };
      }
    }
    return { note: false, reason: '' };
  };

  ST.isNoteMode = function (field) {
    return ST.noteModeInfo(field).note;
  };

  // --- Тема оформления панелей ---
  function parseRgb(s) {
    const m = /rgba?\(([^)]+)\)/.exec(s || '');
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }

  ST.isDarkAround = function (el) {
    let cur = el || document.body;
    for (let i = 0; cur && i < 40; i++) {
      if (cur.nodeType === 1) {
        const c = parseRgb(getComputedStyle(cur).backgroundColor);
        if (c && c.a > 0.5) return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255 < 0.45;
      }
      cur = cur.parentElement || (cur.getRootNode && cur.getRootNode().host) || null;
    }
    const b = parseRgb(getComputedStyle(document.documentElement).backgroundColor);
    if (b && b.a > 0.5) return (0.2126 * b.r + 0.7152 * b.g + 0.0722 * b.b) / 255 < 0.45;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  };

  ST.uiDark = function (anchor) {
    const t = ST.settings.uiTheme;
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return ST.isDarkAround(anchor);
  };

  // --- DOM ---
  ST.isOurNode = function (node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!(el && el.closest && el.closest('[' + ST.UI_ATTR + ']'));
  };

  // --- Shadow DOM ---
  // Многие современные приложения (например, хелпдески на веб-компонентах) рисуют интерфейс внутри
  // открытых shadow root. Обычный querySelectorAll/MutationObserver туда не заглядывают.
  let rootsCache = { at: 0, list: [] };
  ST.shadowRoots = function (force) {
    const now = Date.now();
    if (!force && now - rootsCache.at < 400) return rootsCache.list;
    const list = [];
    const walk = (root) => {
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let n;
      while ((n = tw.nextNode())) {
        if (n.shadowRoot) {
          list.push(n.shadowRoot);
          walk(n.shadowRoot);
        }
      }
    };
    if (document.documentElement) walk(document.documentElement);
    rootsCache = { at: now, list };
    return list;
  };

  // scope содержит node с учётом вложенных shadow root
  ST.composedContains = function (scope, node) {
    while (node) {
      if (scope.contains(node)) return true;
      const root = node.getRootNode();
      node = root && root.host ? root.host : null;
    }
    return false;
  };

  // querySelectorAll по документу и всем открытым shadow root. Бросает исключение на неверный селектор
  ST.qsa = function (sel, scope) {
    const roots = [scope || document, ...ST.shadowRoots().filter((r) => !scope || ST.composedContains(scope, r.host))];
    const out = [];
    for (const r of roots) out.push(...r.querySelectorAll(sel));
    return out;
  };
  ST.qsaSafe = function (sel, scope) {
    if (!sel) return [];
    try {
      return ST.qsa(sel, scope);
    } catch (e) {
      return [];
    }
  };

  // closest(), продолжающий поиск через границы shadow root
  ST.closestDeep = function (el, sel) {
    while (el) {
      const found = el.closest(sel);
      if (found) return found;
      const root = el.getRootNode();
      el = root && root.host ? root.host : null;
    }
    return null;
  };

  ST.deepActiveElement = function () {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  };

  ST.deepElementFromPoint = function (x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };

  // Текст элемента без наших вставок, с сохранением переносов строк
  const BLOCK = /^(DIV|P|LI|BR|TR|H[1-6]|BLOCKQUOTE|PRE|SECTION|ARTICLE|UL|OL|TABLE)$/;
  ST.extractText = function (root) {
    let out = '';
    const walk = (node) => {
      if (node.nodeType === 3) {
        out += node.nodeValue;
        return;
      }
      if (node.nodeType !== 1) return;
      if (node.hasAttribute(ST.UI_ATTR)) return;
      const tag = node.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'SVG' || tag === 'svg') return;
      // Служебные элементы внутри сообщения (кнопки "Reply", реакции, скрытые подсказки) — не часть текста
      if (node !== root && (tag === 'BUTTON' || node.getAttribute('role') === 'button' || node.getAttribute('aria-hidden') === 'true')) return;
      if (tag === 'BR') {
        out += '\n';
        return;
      }
      const block = BLOCK.test(tag) && node !== root;
      if (block && out && !out.endsWith('\n')) out += '\n';
      // Веб-компоненты: содержимое в shadow root, светлые дети попадают через <slot>
      const kids = node.shadowRoot
        ? node.shadowRoot.childNodes
        : tag === 'SLOT'
          ? node.assignedNodes({ flatten: true })
          : node.childNodes;
      for (const ch of kids) walk(ch);
      if (block && !out.endsWith('\n')) out += '\n';
    };
    walk(root);
    return out.replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  };

  ST.isEditable = function (el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return !el.readOnly && !el.disabled;
    if (el.tagName === 'INPUT') return /^(text|search|)$/i.test(el.type || '') && !el.readOnly && !el.disabled;
    return false;
  };

  // Корень редактируемой области (для contenteditable — самый внешний)
  ST.editableRoot = function (el) {
    if (!el) return null;
    if (el.nodeType === 3) el = el.parentElement;
    if (el.isContentEditable) {
      let r = el;
      while (r.parentElement && r.parentElement.isContentEditable) r = r.parentElement;
      return r;
    }
    return ST.isEditable(el) ? el : null;
  };

  // Поле подходит под правило сайта
  ST.fieldAllowed = function (el) {
    if (!ST.site || !ST.settings.enabled || !ST.alive()) return false;
    const root = ST.editableRoot(el);
    if (!root || ST.isOurNode(root)) return false;
    const sel = ST.site.inputSelector;
    if (!sel) return true;
    try {
      return !!ST.closestDeep(root, sel);
    } catch (e) {
      return false;
    }
  };

  // Текст поля ввода. Для редакторов с абзацами (<p>/<div> на каждую строку — ProseMirror, Draft и т.п.)
  // собираем строки сами: innerText ставит между <p> пустые строки, из-за чего абзацы "размножались" бы
  const FIELD_BLOCK = /^(P|DIV|H[1-6]|BLOCKQUOTE|PRE)$/;
  // Картинки, видео и другие вложения в поле ввода: переводом не трогаются
  const MEDIA_SEL = 'img, picture, video, audio, iframe, figure, canvas, object, embed';
  const MEDIA_TAG = /^(IMG|PICTURE|VIDEO|AUDIO|IFRAME|FIGURE|CANVAS|OBJECT|EMBED|HR)$/;
  ST.fieldHasMedia = (el) => !!(el && el.isContentEditable && el.querySelector(MEDIA_SEL));
  const isMediaBlock = (k) => MEDIA_TAG.test(k.tagName) || !!k.querySelector(MEDIA_SEL);

  // Адрес ссылки для текста: «здесь» → «здесь (https://…)». Если текст ссылки и есть адрес — ничего не добавляем
  function linkSuffix(a) {
    const raw = a.getAttribute('href') || '';
    if (!raw || /^(javascript:|#)/i.test(raw)) return '';
    const href = raw.replace(/^mailto:/i, '').replace(/^tel:/i, '');
    const text = (a.textContent || '').trim();
    const norm = (s) => s.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '').toLowerCase();
    if (!text || norm(text) === norm(href)) return '';
    return ' (' + href + ')';
  }

  // Текст блока поля ввода. Ссылки с другим текстом («here») сохраняют адрес в скобках, чтобы он пережил перевод
  function blockText(el) {
    if (!el.querySelector('a[href]')) return el.innerText || '';
    let out = '';
    const walk = (node) => {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) out += n.nodeValue;
        else if (n.nodeType === 1) {
          if (n.tagName === 'BR') out += '\n';
          else {
            const block = /^(P|DIV|LI|H[1-6]|BLOCKQUOTE|PRE)$/.test(n.tagName) && out && !out.endsWith('\n');
            if (block) out += '\n';
            walk(n);
            if (n.tagName === 'A') out += linkSuffix(n);
          }
        }
      }
    };
    walk(el);
    return out;
  }

  /**
   * Строки поля по блокам: [{ el, line, marker }] или null, если поле не из блоков.
   * Блоки с картинками пропускаются — их не читаем и не перезаписываем.
   */
  function fieldSlots(el) {
    const kids = Array.from(el.children);
    const isBlock = (k) => FIELD_BLOCK.test(k.tagName) || /^(UL|OL)$/.test(k.tagName) || isMediaBlock(k);
    if (!kids.length || !kids.every(isBlock)) return null;
    const slots = [];
    for (const k of kids) {
      if (isMediaBlock(k)) continue;
      if (/^(UL|OL)$/.test(k.tagName)) {
        // Списки редактора: пункты с маркерами, чтобы структура пережила перевод и вставку
        Array.from(k.children).filter((li) => li.tagName === 'LI').forEach((li, i) => {
          const marker = k.tagName === 'OL' ? i + 1 + '. ' : '• ';
          slots.push({ el: li.querySelector('p') || li, marker, line: marker + blockText(li).replace(/\n+/g, ' ').trim() });
        });
      } else {
        slots.push({ el: k, marker: '', line: blockText(k).replace(/\n$/, '') });
      }
    }
    return slots;
  }

  ST.getFieldText = function (el) {
    if (!el.isContentEditable) return el.value;
    const slots = fieldSlots(el);
    if (slots) return slots.map((s) => s.line).join('\n');
    return blockText(el).replace(/\n$/, '');
  };

  // Поле с картинками: заменяем текст по блокам, картинки остаются на своих местах
  function setFieldTextKeepMedia(el, text) {
    const lines = String(text).replace(/\r/g, '').split('\n');
    const first = fieldSlots(el);
    if (!first || !first.length) return false;
    const n = first.length;
    // строк больше, чем текстовых блоков — остаток уходит в последний блок отдельными абзацами
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(i < n - 1 ? (lines[i] != null ? [lines[i]] : ['']) : lines.slice(n - 1).length ? lines.slice(n - 1) : ['']);
    const sel = window.getSelection();
    // С конца: вставка абзацев в блок i не сдвигает блоки перед ним
    for (let i = n - 1; i >= 0; i--) {
      const slots = fieldSlots(el);
      const slot = slots && slots[i];
      if (!slot) return false;
      const newLines = parts[i].map((l) => (slot.marker ? l.replace(/^\s*(?:[•\-*·]|\d{1,3}[.)])\s+/, '') : l));
      if (newLines.length === 1 && slot.line === (slot.marker ? slot.marker : '') + newLines[0]) continue;
      const range = document.createRange();
      range.selectNodeContents(slot.el);
      sel.removeAllRanges();
      sel.addRange(range);
      newLines.forEach((line, j) => {
        if (j > 0) document.execCommand('insertParagraph');
        if (line) document.execCommand('insertText', false, line);
        else if (j === 0) document.execCommand('delete');
      });
    }
    return true;
  }

  const normLines = (s) => String(s).replace(/\r/g, '').replace(/\n{2,}/g, '\n').trim();

  // Вставка текста так, чтобы React/Vue/Angular/ProseMirror увидели изменение, и работал Ctrl+Z.
  // В редакторах с абзацами каждая строка вставляется отдельным абзацем (как если бы оператор нажимал Enter).
  ST.setFieldText = function (el, text) {
    el.focus();
    if (ST.fieldHasMedia(el)) {
      let done = false;
      try { done = setFieldTextKeepMedia(el, text); } catch (e) { done = false; }
      if (done) return;
      // Структуру не удалось разобрать — поле не трогаем, чтобы не потерять картинки
      try { navigator.clipboard.writeText(String(text)); } catch (e) { /* ignore */ }
      ST.toast('В поле есть картинки, и заменить текст без их потери не удалось. Перевод скопирован — вставьте его вручную.', { error: true, duration: 9000 });
      return;
    }
    if (el.isContentEditable) {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      const lines = String(text).replace(/\r/g, '').split('\n');
      let ok = true;
      try {
        document.execCommand('delete');
        lines.forEach((line, i) => {
          if (i > 0) ok = document.execCommand('insertParagraph') && ok;
          if (line) ok = document.execCommand('insertText', false, line) && ok;
        });
      } catch (e) {
        ok = false;
      }
      if (!ok || normLines(ST.getFieldText(el)) !== normLines(text)) {
        // Запасной вариант: собираем абзацы вручную
        el.textContent = '';
        for (const line of lines) {
          const p = document.createElement('p');
          if (line) p.textContent = line;
          else p.appendChild(document.createElement('br'));
          el.appendChild(p);
        }
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
    } else {
      el.select();
      let ok = false;
      try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
      if (!ok || el.value !== text) {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  };

  // Небольшой helper для создания DOM без innerHTML (переводы вставляем только как текст)
  ST.h = function (tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  };

  ST.toast = function (text, opts) {
    opts = opts || {};
    const host = ST.h('div', { [ST.UI_ATTR]: 'toast', class: 'st-toast' + (opts.error ? ' st-toast--error' : '') }, text);
    if (opts.action) {
      host.appendChild(ST.h('button', { class: 'st-toast__btn', onclick: () => { opts.action.run(); host.remove(); } }, opts.action.label));
    }
    document.documentElement.appendChild(host);
    setTimeout(() => host.remove(), opts.duration || 3500);
  };
})();
