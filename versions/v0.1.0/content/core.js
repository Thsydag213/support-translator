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
    state: {
      conversationLang: '', // последний определённый иностранный язык собеседника
      conversationLangAt: 0
    },
    UI_ATTR: 'data-st-ui'
  });

  ST.log = (...a) => console.debug('[SupportTranslator]', ...a);

  ST.loadSettings = async function () {
    const { settings } = await chrome.storage.local.get('settings');
    ST.settings = L.mergeSettings(settings);
    ST.site = ST.settings.enabled ? L.findSiteRule(ST.settings, location.href) : null;
    return ST.settings;
  };

  ST.saveSettings = async function (settings) {
    await chrome.storage.local.set({ settings });
  };

  ST.translate = async function (text, sl, tl) {
    const resp = await chrome.runtime.sendMessage({ type: 'translate', text, sl: sl || 'auto', tl });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'Нет ответа от расширения');
    return resp.result;
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

  ST.setConversationLang = function (lang) {
    if (!lang || ST.settings.skipLangs.some((s) => L.sameLang(s, lang)) || L.sameLang(lang, ST.settings.targetLang)) return;
    ST.state.conversationLang = lang;
    ST.state.conversationLangAt = Date.now();
  };

  ST.isOurNode = function (node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!(el && el.closest && el.closest('[' + ST.UI_ATTR + ']'));
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
      for (const ch of node.childNodes) walk(ch);
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
    if (el.isContentEditable) {
      let r = el;
      while (r.parentElement && r.parentElement.isContentEditable) r = r.parentElement;
      return r;
    }
    return ST.isEditable(el) ? el : null;
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
