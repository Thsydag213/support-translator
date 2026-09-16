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
      conversationLang: '' // последний определённый иностранный язык на вкладке
    },
    UI_ATTR: 'data-st-ui',
    isTop: window === window.top
  });

  ST.log = (...a) => console.debug('[SupportTranslator]', ...a);

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

  ST.translate = async function (text, sl, tl) {
    const resp = await ST.send({ type: 'translate', text, sl: sl || 'auto', tl });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'Нет ответа от расширения');
    return resp.result;
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

  ST.setConversationLang = function (lang) {
    if (ST.isForeign(lang) && !(ST.settings.operatorLangs || []).some((x) => L.sameLang(x, lang))) {
      ST.state.conversationLang = lang;
    }
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
    return { lang: '', source: '' };
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
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
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

  ST.getFieldText = function (el) {
    return el.isContentEditable ? el.innerText.replace(/\n$/, '') : el.value;
  };

  // Вставка текста так, чтобы React/Vue/Angular увидели изменение, и работал Ctrl+Z
  ST.setFieldText = function (el, text) {
    el.focus();
    if (el.isContentEditable) {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      let ok = false;
      try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
      if (!ok || ST.getFieldText(el).trim() !== text.trim()) {
        el.textContent = text;
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
