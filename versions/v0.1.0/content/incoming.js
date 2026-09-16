/*
 * Входящие сообщения: следим за "окнами" (containerSelector), находим сообщения (messageSelector),
 * определяем язык и показываем перевод с подписью "Переведено: X → Y".
 */
(function () {
  const ST = globalThis.ST;
  const L = ST.L;
  const DONE = 'data-st-done';

  let observer = null;
  let scanTimer = null;

  function containers() {
    const sel = ST.site && ST.site.containerSelector;
    if (!sel) return [document.body];
    try {
      return Array.from(document.querySelectorAll(sel));
    } catch (e) {
      ST.log('Неверный containerSelector', sel);
      return [];
    }
  }

  // Режим без messageSelector: ищем "листовые" текстовые блоки
  function autoBlocks(container) {
    const set = new Set();
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || n.nodeValue.trim().length < 2) return NodeFilter.FILTER_REJECT;
        if (ST.isOurNode(n)) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|INPUT|BUTTON|CODE)$/.test(p.tagName) || p.isContentEditable) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) {
      let el = n.parentElement;
      // поднимаемся от инлайновых тегов до блочного родителя
      while (el && el !== container && /^(SPAN|B|I|EM|STRONG|A|U|SMALL|MARK|LABEL|FONT|SUB|SUP)$/.test(el.tagName)) el = el.parentElement;
      if (el) set.add(el);
    }
    // оставляем только самые внутренние
    const arr = Array.from(set);
    return arr.filter((el) => !arr.some((o) => o !== el && el.contains(o)));
  }

  function messages() {
    const out = [];
    const msgSel = ST.site && ST.site.messageSelector;
    for (const c of containers()) {
      if (msgSel) {
        try {
          if (c.matches(msgSel)) out.push(c);
          out.push(...c.querySelectorAll(msgSel));
        } catch (e) {
          ST.log('Неверный messageSelector', msgSel);
          return out;
        }
      } else {
        out.push(...autoBlocks(c));
      }
    }
    return out.filter((el) => !ST.isOurNode(el) && !el.isContentEditable);
  }

  function hasLetters(text) {
    return /\p{L}{2,}/u.test(text.replace(/https?:\/\/\S+/g, ''));
  }

  function removeOurNode(el) {
    el.removeAttribute('data-st-lang');
    for (const ch of Array.from(el.children)) if (ch.hasAttribute(ST.UI_ATTR)) ch.remove();
    el.classList.remove('st-replaced');
  }

  function render(el, text, r) {
    removeOurNode(el);
    el.setAttribute('data-st-lang', r.detectedLang);
    const s = ST.settings;
    const replace = s.displayMode === 'replace';
    const fs = getComputedStyle(el).fontSize;

    const toggle = ST.h('button', { class: 'st-tr__btn', type: 'button', title: 'Переключить оригинал/перевод' }, replace ? 'оригинал' : 'скрыть');
    const body = ST.h('div', { class: 'st-tr__text' }, r.translation);
    const origBox = ST.h('div', { class: 'st-tr__orig', hidden: true });
    const node = ST.h(
      'div',
      { [ST.UI_ATTR]: 'tr', class: 'st-tr', style: '--st-fs:' + fs, title: 'Перевод: ' + (r.fromCache ? 'из кэша' : r.provider || '') },
      ST.h('div', { class: 'st-tr__head' },
        ST.h('span', { class: 'st-tr__badge' }, '🌐 Переведено'),
        ST.h('span', { class: 'st-tr__langs' }, L.langName(r.detectedLang) + ' (' + r.detectedLang + ') → ' + L.langName(s.targetLang)),
        toggle,
        ST.h('button', { class: 'st-tr__btn', type: 'button', title: 'Копировать перевод', onclick: (e) => { e.stopPropagation(); navigator.clipboard.writeText(r.translation); ST.toast('Перевод скопирован'); } }, 'копировать')
      ),
      body,
      origBox
    );

    let showingTranslation = true;
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (replace) {
        showingTranslation = !showingTranslation;
        el.classList.toggle('st-replaced', showingTranslation);
        body.hidden = !showingTranslation;
        origBox.hidden = true;
        toggle.textContent = showingTranslation ? 'оригинал' : 'перевод';
      } else {
        body.hidden = !body.hidden;
        toggle.textContent = body.hidden ? 'показать' : 'скрыть';
      }
    });

    if (replace) el.classList.add('st-replaced');
    el.appendChild(node);
  }

  function renderError(el, err) {
    removeOurNode(el);
    const node = ST.h('div', { [ST.UI_ATTR]: 'err', class: 'st-tr st-tr--error' },
      ST.h('span', null, '⚠ Перевод не удался: ' + err),
      ST.h('button', { class: 'st-tr__btn', type: 'button', onclick: (e) => { e.stopPropagation(); el.removeAttribute(DONE); node.remove(); processMessage(el); } }, 'повторить')
    );
    el.appendChild(node);
  }

  async function processMessage(el) {
    const s = ST.settings;
    const text = ST.extractText(el);
    const mark = L.hash(text + '|' + s.targetLang + '|' + s.displayMode);
    if (el.getAttribute(DONE) === mark) return;
    el.setAttribute(DONE, mark);

    if (text.length < s.minChars || !hasLetters(text)) {
      removeOurNode(el);
      return;
    }

    // 1) локальное определение языка — отсекаем английский без запроса в сеть
    const local = await ST.detectLocal(text);
    if (local.reliable && (s.skipLangs.some((l) => L.sameLang(l, local.lang)) || L.sameLang(local.lang, s.targetLang))) {
      removeOurNode(el);
      return;
    }

    // 2) перевод (Google заодно определяет язык точнее)
    try {
      const r = await ST.translate(text, 'auto', s.targetLang);
      if (el.getAttribute(DONE) !== mark) return; // текст успел поменяться
      const lang = r.detectedLang;
      if (L.sameLang(lang, s.targetLang) || s.skipLangs.some((l) => L.sameLang(l, lang)) || r.translation.trim() === text.trim()) {
        removeOurNode(el);
        return;
      }
      ST.setConversationLang(lang);
      render(el, text, r);
    } catch (e) {
      if (el.getAttribute(DONE) === mark) renderError(el, e.message);
    }
  }

  function scan() {
    if (!ST.site) return;
    for (const el of messages()) processMessage(el);
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 250);
  }

  function onMutations(records) {
    for (const r of records) {
      if (ST.isOurNode(r.target)) continue;
      const nodes = [...r.addedNodes, ...r.removedNodes];
      if (r.type === 'characterData' || nodes.some((n) => !(n.nodeType === 1 && n.hasAttribute(ST.UI_ATTR)))) {
        scheduleScan();
        return;
      }
    }
  }

  ST.incoming = {
    start() {
      this.stop();
      if (!ST.site) return;
      observer = new MutationObserver(onMutations);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      scan();
    },
    stop() {
      if (observer) observer.disconnect();
      observer = null;
      clearTimeout(scanTimer);
    },
    // Полная перерисовка (после смены настроек)
    reset() {
      document.querySelectorAll('[' + DONE + ']').forEach((el) => {
        el.removeAttribute(DONE);
        removeOurNode(el);
      });
    },
    rescan() {
      this.reset();
      scan();
    },
    countMessages() {
      return messages().length;
    },
    // Язык последнего иностранного сообщения в текущем окне (корректно при переключении тикетов)
    lastForeignLang() {
      const list = messages();
      for (let i = list.length - 1; i >= 0; i--) {
        const l = list[i].getAttribute('data-st-lang');
        if (l) return l;
      }
      return '';
    }
  };
})();
