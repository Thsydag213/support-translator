/*
 * Диагностика для настройки нового сайта: что видит расширение в этом фрейме.
 * Собирает ТОЛЬКО структуру (теги, классы, размеры, счётчики) — без текста переписки.
 * Учитывает открытые Shadow DOM (граница обозначается как " >> ").
 */
(function () {
  const ST = globalThis.ST;
  if (ST.diagnose) return;

  const cls = (el) =>
    Array.from(el.classList || [])
      .filter((c) => !c.startsWith('st-'))
      .slice(0, 4)
      .join('.');

  function describe(el) {
    if (!el || el.nodeType !== 1) return '';
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const c = cls(el);
    if (c) s += '.' + c;
    for (const a of Array.from(el.attributes)) {
      if (/^(data-(?!st-)|role$|aria-label$)/.test(a.name)) s += '[' + a.name + '="' + String(a.value).slice(0, 30) + '"]';
    }
    return s;
  }

  // Путь с пересечением границ shadow root
  function path(el, depth) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < (depth || 4)) {
      parts.unshift(describe(cur));
      if (cur.parentElement) {
        cur = cur.parentElement;
      } else {
        const root = cur.getRootNode();
        if (root && root.host) {
          parts.unshift('>>');
          cur = root.host;
        } else {
          cur = null;
        }
      }
    }
    return parts.join(' > ').replace(/ > >> > /g, ' >> ');
  }

  function count(sel) {
    if (!sel) return null;
    try {
      return ST.qsa(sel).length;
    } catch (e) {
      return 'ошибка селектора';
    }
  }

  function ownTextLength(el) {
    let n = 0;
    for (const ch of el.childNodes) if (ch.nodeType === 3) n += ch.nodeValue.trim().length;
    return n;
  }

  function urlShape(href) {
    try {
      const u = new URL(href);
      if (!/^https?:$/.test(u.protocol)) return href.slice(0, 20);
      return u.origin + u.pathname.replace(/\d{5,}/g, '<id>');
    } catch (e) {
      return String(href).slice(0, 20);
    }
  }

  const visible = (el) => el.getClientRects().length > 0;

  ST.diagnose = function () {
    const site = ST.site;
    const roots = ST.shadowRoots(true);
    const all = [document, ...roots];
    const out = {
      frame: ST.isTop ? 'top' : 'iframe',
      url: urlShape(location.href),
      matchUrl: urlShape(ST.effectiveUrl()),
      alive: ST.alive(),
      enabled: ST.settings.enabled,
      rule: site
        ? {
            name: site.name,
            urlPattern: site.urlPattern,
            containerSelector: site.containerSelector,
            messageSelector: site.messageSelector,
            userMessageSelector: site.userMessageSelector,
            inputSelector: site.inputSelector,
            sendButtonSelector: site.sendButtonSelector,
            ticketIdSelector: site.ticketIdSelector,
            insertMode: site.insertMode,
            sendKey: site.sendKey,
            subjectSelector: site.subjectSelector,
            listItemSelector: site.listItemSelector,
            agentMessages: site.agentMessages,
            noteModeText: site.noteModeText,
            noteSelector: site.noteSelector
          }
        : null,
      shadowRoots: roots.length
    };

    if (site) {
      out.found = {
        containers: count(site.containerSelector),
        messagesInPage: count(site.messageSelector),
        messagesUsed: ST.incoming.countMessages(),
        userMessages: count(site.userMessageSelector),
        inputs: count(site.inputSelector),
        sendButtons: count(site.sendButtonSelector),
        ticketId: count(site.ticketIdSelector),
        translatedNodes: count('[' + ST.UI_ATTR + '="tr"]'),
        errorNodes: count('[' + ST.UI_ATTR + '="err"]'),
        processed: count('[data-st-done]'),
        subjects: count(site.subjectSelector),
        listItems: count(site.listItemSelector),
        listBadges: count('[' + ST.UI_ATTR + '="badge"]'),
        noteModeNow: (() => {
          const f = ST.outgoing.lastField() || ST.qsaSafe(site.inputSelector)[0];
          return f ? ST.isNoteMode(f) : null;
        })(),
        // Почему решено, что сейчас режим заметки (какой элемент совпал) — для настройки
        noteModeReason: (() => {
          const f = ST.outgoing.lastField() || ST.qsaSafe(site.inputSelector)[0];
          return f ? ST.noteModeInfo(f).reason : '';
        })(),
        messageBreakdown: ST.incoming.messageBreakdown(),
        agentButtons: count('[' + ST.UI_ATTR + '="trbtn"]'),
        darkUi: ST.uiDark(ST.outgoing.lastField()),
        localTranslator: {
          setting: ST.settings.localTranslator,
          translatorApi: !!(ST.local && ST.local.supported()),
          detectorApi: !!(ST.local && ST.local.detectorSupported()),
          missingPacks: ST.local ? ST.local.missingPacks() : []
        },
        onlyVisible: ST.settings.onlyVisible,
        expectedLang: ST.expectedLang(),
        health: ST.incoming.health()
      };
      out.processedSample = ST.qsa('[data-st-done]')
        .slice(0, 10)
        .map((el) => ({ el: path(el, 4), textLen: (el.innerText || '').length, lang: el.getAttribute('data-st-lang') || '' }));
    }

    out.iframes = ST.qsa('iframe').map((f) => {
      const info = {
        el: path(f, 3),
        src: f.hasAttribute('srcdoc') ? 'srcdoc' : urlShape(f.src || 'about:blank'),
        size: f.offsetWidth + 'x' + f.offsetHeight
      };
      try {
        const d = f.contentDocument;
        info.sameOrigin = !!d;
        info.textLen = d && d.body ? d.body.innerText.length : 0;
      } catch (e) {
        info.sameOrigin = false;
      }
      return info;
    });

    // Кандидаты: видимые элементы со своим текстом (только структура и длина)
    const candidates = [];
    for (const r of all) {
      for (const el of r.querySelectorAll('*')) {
        if (ST.isOurNode(el) || !visible(el)) continue;
        const n = ownTextLength(el);
        if (n >= 40) candidates.push({ el, n });
      }
    }
    candidates.sort((a, b) => b.n - a.n);
    out.textBlocks = candidates.slice(0, 12).map((c) => ({ el: path(c.el, 7), ownText: c.n }));

    // Редактируемые поля (кандидаты в поле ввода)
    out.editables = ST.qsa('textarea, [contenteditable="true"], [contenteditable=""], input[type="text"]')
      .filter(visible)
      .slice(0, 6)
      .map((el) => path(el, 5));

    // Кнопки с текстом отправки (кандидаты в кнопку отправки)
    out.sendButtons = ST.qsa('button, [role="button"]')
      .filter((b) => visible(b) && /^(send|reply|submit|отправ)/i.test((b.innerText || b.getAttribute('aria-label') || '').trim()))
      .slice(0, 4)
      .map((el) => path(el, 4));

    return out;
  };
})();
