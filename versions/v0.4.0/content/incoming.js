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

  const PROVIDER_NAMES = {
    'chrome-builtin': 'на устройстве (Chrome)',
    'google-free': 'Google',
    'google-cloud': 'Google Cloud',
    'dev-mock': 'тестовый'
  };

  const insertMode = () => (ST.site && ST.site.insertMode === 'after' ? 'after' : 'inside');

  // Встроенный фрейм без своего адреса (about:srcdoc) — например, HTML-письмо внутри карточки сообщения.
  // Крошечные служебные фреймы (виджеты, счётчики 1×1, кнопка мессенджера 48×48) не считаем письмами.
  const EMBEDDED = !ST.isTop && /^(about:|blob:|data:)/i.test(location.href);
  const embeddedDoc = () => EMBEDDED && window.innerWidth >= 150 && window.innerHeight >= 60;

  // Если "окно чата" совпало со слишком многими элементами (селектор вида "div > div > div"),
  // обход каждого был бы очень тяжёлым — ищем сообщения по всей странице и сообщаем в самопроверке
  const TOO_MANY_CONTAINERS = 30;
  let containersTooBroad = false;

  function containers() {
    const sel = ST.site && ST.site.containerSelector;
    containersTooBroad = false;
    // Без выбранного окна чата ничего не переводим: иначе уходит в перевод весь интерфейс сайта
    if (!sel) return [];
    try {
      const found = ST.qsa(sel);
      // Во встроенном фрейме селекторов основной страницы нет — весь документ фрейма считаем одним сообщением
      if (!found.length && embeddedDoc() && document.body) return [document.body];
      if (found.length > TOO_MANY_CONTAINERS && ST.site.messageSelector) {
        containersTooBroad = true;
        return [document];
      }
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
    const found = new Set();
    const msgSel = ST.site && ST.site.messageSelector;
    for (const c of containers()) {
      if (EMBEDDED && c === document.body) {
        const inner = msgSel ? ST.qsaSafe(msgSel, c) : [];
        (inner.length ? inner : [c]).forEach((el) => found.add(el));
      } else if (msgSel) {
        try {
          if (c !== document && c.matches(msgSel)) found.add(c);
          ST.qsa(msgSel, c === document ? undefined : c).forEach((el) => found.add(el));
        } catch (e) {
          ST.log('Неверный messageSelector', msgSel);
          break;
        }
      } else {
        autoBlocks(c).forEach((el) => found.add(el));
      }
    }
    // Без дублей (вложенные окна находят одни и те же сообщения) и без вложенных совпадений:
    // если селектор совпал и с обёрткой, и с текстом внутри неё — берём самый внутренний элемент
    const list = Array.from(found).filter((el) => !ST.isOurNode(el) && !el.isContentEditable);
    if (list.length < 2 || list.length > 400) return list;
    return list.filter((el) => !list.some((o) => o !== el && el.contains(o)));
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
    ST.qsa('[' + ST.UI_ATTR + '="tr"],[' + ST.UI_ATTR + '="err"],[' + ST.UI_ATTR + '="trbtn"]').forEach((node) => {
      const owner = ownerOf.get(node);
      if (owner && !owner.isConnected) node.remove();
    });
  }

  // Тема письма/тикета: одна компактная строка перевода под темой, без кнопок
  // Тема письма/тикета: перевод показывается НА МЕСТЕ оригинала, в той же строке.
  // Шапки обычно однострочные с фиксированной высотой и обрезкой — блок под текстом там не виден.
  // Оригинал — во всплывающей подсказке; клик по переводу временно показывает оригинал.
  function renderSubject(el, r) {
    removeOurNode(el);
    const s = ST.settings;
    const original = ST.extractText(el);
    const fs = getComputedStyle(el).fontSize;
    const node = ST.h(
      'span',
      {
        [ST.UI_ATTR]: 'tr',
        class: 'st-subject',
        style: '--st-fs:' + fs,
        title: 'Оригинал (' + L.langName(r.detectedLang) + '): ' + original + '\nКлик — показать оригинал'
      },
      '🌐 ' + r.translation
    );
    node.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('st-replaced');
      node.hidden = true;
      setTimeout(() => {
        if (!node.isConnected) return;
        node.hidden = false;
        el.classList.add('st-replaced');
      }, 4000);
    });
    el.classList.add('st-replaced');
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
      { [ST.UI_ATTR]: 'tr', class: 'st-tr' + (after ? ' st-tr--after' : ''), style: '--st-fs:' + fs, title: 'Перевод: ' + (PROVIDER_NAMES[r.provider] || r.provider || '') + (r.fromCache ? ' · из кэша' : '') },
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
  // ---------- Сообщения агентов: перевод по кнопке ----------
  const AGENT_OPEN = 'data-st-agent-open'; // хэш текста сообщения агента, перевод которого запросили кнопкой

  // Сообщение агента/оператора = не попадает под «Сообщение пользователя». Без этого селектора агентов не различаем
  function isAgentMessage(el) {
    const userSel = ST.site && ST.site.userMessageSelector;
    if (!userSel || (EMBEDDED && el === document.body)) return false;
    try {
      return !ST.closestDeep(el, userSel);
    } catch (e) {
      return false;
    }
  }

  function renderAgentButton(el, text) {
    removeOurNode(el);
    const btn = ST.h('button', {
      [ST.UI_ATTR]: 'trbtn',
      class: 'st-trbtn',
      type: 'button',
      title: 'Сообщение агента — перевести по запросу (без автоматических запросов к переводчику)'
    }, '🌐 перевести');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.textContent = '⏳';
      el.setAttribute(AGENT_OPEN, L.hash(text));
      el.removeAttribute(DONE);
      processMessage(el, 'agent');
    });
    place(el, btn);
  }

  // kind: 'message' (сообщение в окне) | 'subject' (тема письма — компактно, без статистики)
  //       | 'agent' (сообщение агента, перевод запрошен кнопкой — без статистики и без влияния на язык собеседника)
  async function processMessage(el, kind) {
    if (ST.dead) return;
    kind = kind || 'message';
    const s = ST.settings;
    const text = ST.extractText(el);

    const agentMode = (ST.site && ST.site.agentMessages) || 'button';
    const agent = kind !== 'subject' && isAgentMessage(el);
    if (kind === 'message' && agent) {
      if (agentMode === 'off') {
        removeOurNode(el);
        return;
      }
      // Перевод уже запрашивали кнопкой и текст не менялся — показываем перевод, а не кнопку
      if (agentMode === 'button' && el.getAttribute(AGENT_OPEN) === L.hash(text)) kind = 'agent';
    }

    const mark = L.hash(kind + '|' + (agent ? agentMode : '') + '|' + text + '|' + s.targetLang + '|' + s.displayMode + '|' + insertMode() + '|' + L.hash(s.glossary || ''));
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

    // Сообщение агента в режиме «по кнопке»: вместо запроса к переводчику — кнопка
    if (kind === 'message' && agent && agentMode === 'button') {
      renderAgentButton(el, text);
      return;
    }

    // 2) язык источника: для встроенного переводчика Chrome и для объединения запросов нужен уверенный язык.
    //    CLD (chrome.i18n) — если уверен; иначе встроенный детектор (Language Detector API), если модель есть
    let source = local.reliable ? local.lang : '';
    if (!source && s.localTranslator !== 'off' && ST.local) {
      const d = await ST.local.detect(text);
      if (d && d.confidence >= 0.7) source = d.lang;
    }
    if (source && !ST.isForeign(source)) {
      removeOurNode(el);
      return;
    }

    // 3) перевод: на устройстве (если пакет языка скачан), иначе облако — объединённым запросом
    try {
      const r = await ST.translate(text, 'auto', s.targetLang, {
        local: s.localTranslator !== 'off',
        localSource: source,
        batch: true,
        hint: source
      });
      if (el.getAttribute(DONE) !== mark) return; // текст успел поменяться
      if (!ST.isForeign(r.detectedLang) || r.translation.trim() === text.trim()) {
        removeOurNode(el);
        if (kind === 'agent') ST.toast('Сообщение уже на английском — перевод не нужен');
        return;
      }
      render(el, text, r, kind);
      if (kind === 'subject' || kind === 'agent' || agent) return;
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

  // ---------- Перевод только видимых сообщений ----------
  // Хелпдески подгружают всю историю тикета; переводим сообщение, когда оно на экране или рядом (±600px).
  // IntersectionObserver работает и внутри Shadow DOM.
  const nearViewport = new WeakSet();
  let visibilityObserver = null;

  function ensureVisibilityObserver() {
    if (visibilityObserver || typeof IntersectionObserver === 'undefined') return visibilityObserver;
    visibilityObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          if (!nearViewport.has(e.target)) {
            nearViewport.add(e.target);
            processMessage(e.target, 'message');
          }
        } else {
          nearViewport.delete(e.target);
        }
      }
    }, { root: null, rootMargin: '600px 0px 600px 0px', threshold: 0 });
    return visibilityObserver;
  }

  function scan() {
    const site = ST.site;
    if (!site || !ST.alive()) return;
    if (EMBEDDED && !embeddedDoc()) return; // служебный фрейм виджета — не наш случай
    if (!site.containerSelector && !site.listItemSelector && !site.subjectSelector && !EMBEDDED) return;
    observeShadowRoots();
    cleanupOrphans();
    const onlyVisible = ST.settings.onlyVisible !== false && ensureVisibilityObserver();
    for (const el of messages()) {
      if (!onlyVisible || (EMBEDDED && el === document.body)) {
        processMessage(el, 'message');
      } else {
        // observe() повторно для того же элемента ничего не делает; первый вызов сразу сообщает, виден ли элемент
        visibilityObserver.observe(el);
        if (nearViewport.has(el)) processMessage(el, 'message');
      }
    }
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

    if (EMBEDDED && !embeddedDoc()) return null;
    if (!EMBEDDED) {
      if (!site.containerSelector) {
        if (ST.isTop) raise('warn', 'Не выбрано «Окно чата» — перевод сообщений выключен');
      } else {
        const cs = ST.qsaSafe(site.containerSelector);
        if (cs.length > TOO_MANY_CONTAINERS) {
          raise('warn', '«Окно чата» выбрано слишком общо (совпадений: ' + cs.length + ') — перенастройте: кликните по пустому месту ленты сообщений');
        }
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
      if (visibilityObserver) visibilityObserver.disconnect();
      visibilityObserver = null;
      clearTimeout(scanTimer);
      scanTimer = null;
    },
    // Полная очистка (после смены настроек)
    reset() {
      ST.qsa('[' + DONE + ']').forEach((el) => {
        el.removeAttribute(DONE);
        removeOurNode(el);
      });
      ST.qsa('[' + ST.UI_ATTR + '="tr"],[' + ST.UI_ATTR + '="err"],[' + ST.UI_ATTR + '="badge"],[' + ST.UI_ATTR + '="trbtn"]').forEach((n) => n.remove());
      ST.qsa('[' + BADGE_DONE + ']').forEach((el) => el.removeAttribute(BADGE_DONE));
    },
    health,
    // Для диагностики: сколько сообщений пользователя/агентов среди найденных
    messageBreakdown() {
      const list = ST.site ? messages() : [];
      const agents = list.filter(isAgentMessage).length;
      return { total: list.length, user: list.length - agents, agent: agents, containersTooBroad };
    },
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
