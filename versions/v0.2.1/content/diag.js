/*
 * Диагностика для настройки нового сайта: что видит расширение в этом фрейме.
 * Собирает ТОЛЬКО структуру (теги, классы, размеры, счётчики) — без текста переписки.
 */
(function () {
  const ST = globalThis.ST;
  if (ST.diagnose) return;

  const cls = (el) =>
    Array.from(el.classList || [])
      .filter((c) => !c.startsWith('st-'))
      .slice(0, 3)
      .join('.');

  function describe(el) {
    if (!el || el.nodeType !== 1) return '';
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const c = cls(el);
    if (c) s += '.' + c;
    for (const a of ['data-testid', 'data-test', 'data-qa', 'role']) {
      if (el.hasAttribute(a)) s += '[' + a + '="' + String(el.getAttribute(a)).slice(0, 40) + '"]';
    }
    return s;
  }

  function path(el, depth) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < (depth || 4)) {
      parts.unshift(describe(cur));
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function safeCount(sel, root) {
    if (!sel) return null;
    try {
      return (root || document).querySelectorAll(sel).length;
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

  ST.diagnose = function () {
    const site = ST.site;
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
            sendKey: site.sendKey
          }
        : null
    };

    if (site) {
      out.found = {
        containers: safeCount(site.containerSelector),
        messagesInPage: safeCount(site.messageSelector),
        messagesUsed: ST.incoming.countMessages(),
        userMessages: safeCount(site.userMessageSelector),
        inputs: safeCount(site.inputSelector),
        sendButtons: safeCount(site.sendButtonSelector),
        ticketId: safeCount(site.ticketIdSelector),
        translatedNodes: document.querySelectorAll('[' + ST.UI_ATTR + '="tr"]').length,
        errorNodes: document.querySelectorAll('[' + ST.UI_ATTR + '="err"]').length,
        processed: document.querySelectorAll('[data-st-done]').length,
        expectedLang: ST.expectedLang()
      };
      out.processedSample = Array.from(document.querySelectorAll('[data-st-done]'))
        .slice(0, 12)
        .map((el) => ({ el: path(el, 3), textLen: (el.innerText || '').length, lang: el.getAttribute('data-st-lang') || '' }));
    }

    out.iframes = Array.from(document.querySelectorAll('iframe')).map((f) => {
      const info = {
        el: path(f, 3),
        src: f.hasAttribute('srcdoc') ? 'srcdoc' : urlShape(f.src || 'about:blank'),
        size: f.offsetWidth + 'x' + f.offsetHeight,
        sandbox: f.getAttribute('sandbox') || ''
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

    // Элементы с открытым Shadow DOM (обычный querySelector внутрь не видит)
    const hosts = Array.from(document.querySelectorAll('*')).filter((e) => e.shadowRoot);
    out.shadowHosts = { count: hosts.length, sample: hosts.slice(0, 8).map((h) => path(h, 2)) };

    // Крупные текстовые блоки — кандидаты в "сообщение" (только структура и длина)
    out.textBlocks = Array.from(document.body ? document.body.querySelectorAll('*') : [])
      .filter((el) => !ST.isOurNode(el) && el.offsetParent !== null && ownTextLength(el) >= 60)
      .map((el) => ({ el: path(el, 5), ownText: ownTextLength(el) }))
      .sort((a, b) => b.ownText - a.ownText)
      .slice(0, 10);

    return out;
  };
})();
