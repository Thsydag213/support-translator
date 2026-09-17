/*
 * Входящие сообщения: следим за "окнами" (containerSelector), находим сообщения (messageSelector),
 * определяем язык и показываем перевод с подписью "Переведено: X → Y".
 *
 * insertMode:
 *   inside — подпись добавляется последним дочерним элементом сообщения;
 *   after  — подпись вставляется соседним элементом сразу после сообщения
 *            (для сайтов, чей фреймворк не терпит чужих узлов внутри своих элементов).
 */
(function () {
  const ST = globalThis.ST;
  if (ST.incoming) return;
  const L = ST.L;
  const DONE = 'data-st-done';

  let observer = null;
  let scanTimer = null;
  const ownerOf = new WeakMap(); // наш узел -> сообщение
  const nodeOf = new WeakMap(); // сообщение -> наш узел

  const insertMode = () => (ST.site && ST.site.insertMode === 'after' ? 'after' : 'inside');

  // Встроенный фрейм без своего адреса (about:srcdoc) — например, HTML-письмо внутри карточки сообщения
  const EMBEDDED = !ST.isTop && /^(about:|blob:|data:)/i.test(location.href);

  function containers() {
    const sel = ST.site && ST.site.containerSelector;
    // Без выбранного окна чата ничего не переводим: иначе уходит в перевод весь интерфейс сайта
    if (!sel) return [];
    try {
      const found = ST.qsa(sel);
      // Во встроенном фрейме селекторов основной страницы нет — весь документ фрейма считаем одним сообщением
      if (!found.length && EMBEDDED && document.body) return [document.body];
      return found;
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
      while (el && el !== container && /^(SPAN|B|I|EM|STRONG|A|U|SMALL|MARK|LABEL|FONT|SUB|SUP)$/.test(el.tagName)) el = el.parentElement;
      if (el) set.add(el);
    }
    const arr = Array.from(set);
    return arr.filter((el) => !arr.some((o) => o !== el && el.contains(o)));
  }

  function messages() {
    const out = [];
    const msgSel = ST.site && ST.site.messageSelector;
    for (const c of containers()) {
      if (EMBEDDED && c === document.body) {
        const inner = msgSel ? ST.qsaSafe(msgSel, c) : [];
        out.push(...(inner.length ? inner : [c]));
      } else if (msgSel) {
        try {
          if (c.matches(msgSel)) out.push(c);
          out.push(...ST.qsa(msgSel, c));
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
    el.classList.remove('st-replaced', 'st-hide');
    for (const ch of Array.from(el.children)) if (ch.hasAttribute(ST.UI_ATTR)) ch.remove();
    const sib = nodeOf.get(el);
    if (sib) sib.remove();
    nodeOf.delete(el);
  }

  function place(el, node) {
    if (insertMode() === 'after') el.after(node);
    else el.appendChild(node);
    ST.ensureStyles(el.getRootNode()); // стили внутрь shadow root, если сообщение там
    nodeOf.set(el, node);
    ownerOf.set(node, el);
  }

  // Подписи, чьё сообщение сайт уже удалил/перерисовал (актуально для режима after)
  function cleanupOrphans() {
    ST.qsa('[' + ST.UI_ATTR + '="tr"],[' + ST.UI_ATTR + '="err"]').forEach((node) => {
      const owner = ownerOf.get(node);
      if (owner && !owner.isConnected) node.remove();
    });
  }

  // Тема письма/тикета: одна компактная строка перевода под темой, без кнопок
  function renderSubject(el, r) {
    removeOurNode(el);
    const s = ST.settings;
    const node = ST.h(
      'div',
      { [ST.UI_ATTR]: 'tr', class: 'st-tr st-tr--compact', title: '🌐 ' + L.langName(r.detectedLang) + ' (' + r.detectedLang + ') → ' + L.langName(s.targetLang) },
      '🌐 ' + r.translation
    );
    el.appendChild(node);
    ST.ensureStyles(el.getRootNode());
    nodeOf.set(el, node);
    ownerOf.set(node, el);
  }

  function render(el, text, r, kind) {
    if (kind === 'subject') return renderSubject(el, r);
    removeOurNode(el);
    el.setAttribute('data-st-lang', r.detectedLang);
    const s = ST.settings;
    const replace = s.displayMode === 'replace';
    const after = insertMode() === 'after';
    const hideClass = after ? 'st-hide' : 'st-replaced';
    const fs = getComputedStyle(el).fontSize;

    const toggle = ST.h('button', { class: 'st-tr__btn', type: 'button', title: 'Переключить оригинал/перевод' }, replace ? 'оригинал' : 'скрыть');
    const body = ST.h('div', { class: 'st-tr__text' }, r.translation);
    const node = ST.h(
      'div',
      { [ST.UI_ATTR]: 'tr', class: 'st-tr' + (after ? ' st-tr--after' : ''), style: '--st-fs:' + fs, title: 'Перевод: ' + (r.fromCache ? 'из кэша' : r.provider || '') },
      ST.h('div', { class: 'st-tr__head' },
        ST.h('span', { class: 'st-tr__badge' }, '🌐 Переведено'),
        ST.h('span', { class: 'st-tr__langs' }, L.langName(r.detectedLang) + ' (' + r.detectedLang + ') → ' + L.langName(s.targetLang)),
        toggle,
        ST.h('button', { class: 'st-tr__btn', type: 'button', title: 'Копировать перевод', onclick: (e) => { e.stopPropagation(); navigator.clipboard.writeText(r.translation); ST.toast('Перевод скопирован'); } }, 'копировать')
      ),
      body
    );

    let showingTranslation = true;
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (replace) {
        showingTranslation = !showingTranslation;
        el.classList.toggle(hideClass, showingTranslation);
        body.hidden = !showingTranslation;
        toggle.textContent = showingTranslation ? 'оригинал' : 'перевод';
      } else {
        body.hidden = !body.hidden;
        toggle.textContent = body.hidden ? 'показать' : 'скрыть';
      }
    });

    if (replace) el.classList.add(hideClass);
    place(el, node);
  }

  function renderError(el, err) {
    removeOurNode(el);
    const retry = () => {
      el.removeAttribute(DONE);
      removeOurNode(el);
      processMessage(el);
    };
    const node = ST.h('div', { [ST.UI_ATTR]: 'err', class: 'st-tr st-tr--error' },
      ST.h('span', null, '⚠ Перевод не удался: ' + err),
      ST.h('button', { class: 'st-tr__btn', type: 'button', onclick: (e) => { e.stopPropagation(); retry(); } }, 'повторить')
    );
    place(el, node);
    // Временные сбои (лимит Google, сеть) — повторяем автоматически после паузы предохранителя
    if (/ограничил|429|Сеть недоступна/.test(err)) {
      setTimeout(() => {
        if (node.isConnected && el.isConnected && ST.alive()) retry();
      }, 65000 + Math.random() * 10000);
    }
  }

  // kind: 'message' (сообщение в окне) | 'subject' (тема письма — компактно, без статистики)
  async function processMessage(el, kind) {
    if (ST.dead) return;
    kind = kind || 'message';
    const s = ST.settings;
    const text = ST.extractText(el);
    const mark = L.hash(kind + '|' + text + '|' + s.targetLang + '|' + s.displayMode + '|' + insertMode() + '|' + L.hash(s.glossary || ''));
    if (el.getAttribute(DONE) === mark) return;
    el.setAttribute(DONE, mark);

    if (text.length < s.minChars || !hasLetters(text)) {
      removeOurNode(el);
      return;
    }

    // 1) локальное определение языка — отсекаем английский без запроса в сеть
    const local = await ST.detectLocal(text);
    if (local.reliable && !ST.isForeign(local.lang)) {
      removeOurNode(el);
      return;
    }
    // Короткие надписи ("Send", "21m", "Email"): CLD на них "не уверен", но если он считает их английскими —
    // не тратим запрос. Короткие иностранные фразы CLD обычно определяет иначе, они пойдут в перевод.
    if (text.length < 40 && local.lang && !ST.isForeign(local.lang)) {
      removeOurNode(el);
      return;
    }

    // 2) перевод (Google заодно определяет язык точнее)
    try {
      const r = await ST.translate(text, 'auto', s.targetLang);
      if (el.getAttribute(DONE) !== mark) return; // текст успел поменяться
      if (!ST.isForeign(r.detectedLang) || r.translation.trim() === text.trim()) {
        removeOurNode(el);
        return;
      }
      render(el, text, r, kind);
      if (kind === 'subject') return;
      ST.setConversationLang(r.detectedLang);
      ST.track({ kind: 'incoming', lang: r.detectedLang, chars: text.length, hash: L.hash(location.host + '|' + text) });
      // Язык собеседника — другим фреймам вкладки (письмо во фрейме -> панель ответа в основной странице)
      const ul = userLang(el);
      if (ul) ST.send({ type: 'convLang', lang: ul }).catch(() => {});
    } catch (e) {
      if (el.getAttribute(DONE) === mark && !ST.dead) {
        if (kind === 'subject') removeOurNode(el);
        else renderError(el, e.message);
      }
    }
  }

  // Язык сообщения, если оно считается сообщением ПОЛЬЗОВАТЕЛЯ (а не оператора), иначе ''
  function userLang(el) {
    const l = el.getAttribute('data-st-lang');
    if (!l) return '';
    const userSel = ST.site && ST.site.userMessageSelector;
    // Письмо во встроенном фрейме: пользователь или оператор — по селектору не понять, отсекаем языки операторов
    if (userSel && !(EMBEDDED && el === document.body)) {
      try {
        return ST.closestDeep(el, userSel) ? l : '';
      } catch (e) {
        return l;
      }
    }
    return (ST.settings.operatorLangs || []).some((x) => L.sameLang(x, l)) ? '' : l;
  }

  // ---------- Метки языка в списке тикетов ----------
  const BADGE_DONE = 'data-st-badge';

  function removeBadge(el) {
    for (const ch of Array.from(el.children)) if (ch.getAttribute(ST.UI_ATTR) === 'badge') ch.remove();
  }

  async function processListItem(el) {
    const s = ST.settings;
    const text = ST.extractText(el);
    const mark = L.hash(text);
    if (el.getAttribute(BADGE_DONE) === mark) return;
    el.setAttribute(BADGE_DONE, mark);
    removeBadge(el);
    if (text.length < 8 || !hasLetters(text)) return;

    let lang = '';
    const local = await ST.detectLocal(text);
    if (local.reliable) lang = local.lang;
    else if (s.listBadgesUseNetwork && text.length >= 15) {
      try {
        lang = (await ST.translate(text, 'auto', s.targetLang)).detectedLang;
      } catch (e) {
        return;
      }
    }
    if (el.getAttribute(BADGE_DONE) !== mark || !lang || !ST.isForeign(lang)) return;
    const badge = ST.h('span', { [ST.UI_ATTR]: 'badge', class: 'st-badge', title: 'Язык: ' + L.langName(lang) }, lang.split('-')[0].toUpperCase());
    el.prepend(badge);
    ST.ensureStyles(el.getRootNode());
  }

  const observedRoots = new WeakSet();

  // MutationObserver не видит изменений внутри shadow root — подписываемся на каждый найденный
  function observeShadowRoots() {
    if (!observer) return;
    for (const root of ST.shadowRoots(true)) {
      if (observedRoots.has(root)) continue;
      observedRoots.add(root);
      observer.observe(root, { childList: true, subtree: true, characterData: true });
    }
  }

  function scan() {
    const site = ST.site;
    if (!site || !ST.alive()) return;
    if (!site.containerSelector && !site.listItemSelector && !site.subjectSelector && !EMBEDDED) return;
    observeShadowRoots();
    cleanupOrphans();
    for (const el of messages()) processMessage(el, 'message');
    if (site.subjectSelector) for (const el of ST.qsaSafe(site.subjectSelector)) if (!ST.isOurNode(el)) processMessage(el, 'subject');
    if (site.listItemSelector && ST.settings.listBadges) for (const el of ST.qsaSafe(site.listItemSelector)) if (!ST.isOurNode(el)) processListItem(el);
  }

  // ---------- Самопроверка ----------
  // Возвращает { level: 'ok'|'warn'|'error', issues: [..] } — показывается значком на иконке и в popup
  function health() {
    const site = ST.site;
    if (!site) return null;
    const issues = [];
    let level = 'ok';
    const raise = (lvl, text) => {
      issues.push(text);
      if (lvl === 'error' || (lvl === 'warn' && level === 'ok')) level = lvl;
    };

    if (!EMBEDDED) {
      if (!site.containerSelector) {
        if (ST.isTop) raise('warn', 'Не выбрано «Окно чата» — перевод сообщений выключен');
      } else {
        const cs = ST.qsaSafe(site.containerSelector);
        if (cs.length) {
          const textLen = cs.reduce((n, c) => n + (c.textContent || '').length, 0);
          if (site.messageSelector && textLen > 120 && messages().length === 0) {
            raise('error', 'Окно чата найдено, но сообщения не находятся — вероятно, сайт обновился, перенастройте «Сообщение»');
          }
          if (site.inputSelector && ST.qsaSafe(site.inputSelector).length === 0 && ST.qsa('textarea,[contenteditable="true"]').length > 0) {
            raise('warn', 'Поле ввода по селектору не найдено — кнопка перевода и защита отправки могут не работать');
          }
        }
      }
    }
    const errs = ST.qsaSafe('[' + ST.UI_ATTR + '="err"]').length;
    const le = ST.state.lastError;
    if (le && Date.now() - le.at < 120000 && /ограничил|429/.test(le.msg)) raise('warn', 'Google ограничил запросы — переводы временно не приходят');
    else if (errs) raise('warn', 'Ошибок перевода на странице: ' + errs);
    return { level, issues };
  }

  // Троттлинг, а не debounce: на "живых" сайтах DOM меняется постоянно, и debounce мог бы не сработать никогда
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 300);
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
      if (!ST.site || !document.body) return;
      observer = new MutationObserver(onMutations);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      scan();
    },
    stop() {
      if (observer) observer.disconnect();
      observer = null;
      clearTimeout(scanTimer);
      scanTimer = null;
    },
    // Полная очистка (после смены настроек)
    reset() {
      ST.qsa('[' + DONE + ']').forEach((el) => {
        el.removeAttribute(DONE);
        removeOurNode(el);
      });
      ST.qsa('[' + ST.UI_ATTR + '="tr"],[' + ST.UI_ATTR + '="err"],[' + ST.UI_ATTR + '="badge"]').forEach((n) => n.remove());
      ST.qsa('[' + BADGE_DONE + ']').forEach((el) => el.removeAttribute(BADGE_DONE));
    },
    health,
    rescan() {
      this.reset();
      scan();
    },
    countMessages() {
      return ST.site ? messages().length : 0;
    },
    // Язык последнего иностранного сообщения СОБЕСЕДНИКА в текущем окне (корректно при переключении тикетов)
    lastForeignLang() {
      if (!ST.site) return '';
      const list = messages();
      for (let i = list.length - 1; i >= 0; i--) {
        const l = userLang(list[i]);
        if (l) return l;
      }
      return '';
    }
  };
})();
