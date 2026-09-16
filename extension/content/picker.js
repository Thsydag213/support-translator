/*
 * Выбор элемента на странице мышкой -> генерация CSS-селектора -> сохранение в правило сайта.
 * Работает в каждом фрейме вкладки; когда выбор сделан в одном фрейме, остальные отменяются.
 */
(function () {
  const ST = globalThis.ST;
  if (ST.picker) return;
  const L = ST.L;

  // Классы, похожие на сгенерированные (css-1abc2de, sc-AxjAm, _3xYz…), в селектор не берём
  const unstableClass = (c) => /^(css|sc|jsx|emotion|styled)-|^_|[0-9a-f]{5,}|\d{3,}|^(active|selected|hover|focus|st-)/i.test(c);

  function stableClasses(el) {
    return Array.from(el.classList).filter((c) => !unstableClass(c)).slice(0, 2);
  }

  const esc = (s) => CSS.escape(s);
  const STABLE_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'name', 'role', 'aria-label'];

  // Уникальный селектор (для окна / поля ввода / кнопки / ID тикета)
  function uniqueSelector(el) {
    if (el.id && !/\d{3,}/.test(el.id)) return '#' + esc(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < 6) {
      let part = cur.tagName.toLowerCase();
      if (cur.id && !/\d{3,}/.test(cur.id)) {
        parts.unshift('#' + esc(cur.id));
        break;
      }
      const cls = stableClasses(cur);
      if (cls.length) part += '.' + cls.map(esc).join('.');
      const attr = STABLE_ATTRS.find((a) => cur.hasAttribute(a));
      if (attr) part += '[' + attr + '="' + cur.getAttribute(attr).replace(/"/g, '\\"') + '"]';
      parts.unshift(part);
      const sel = parts.join(' > ');
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch (e) { /* continue */ }
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  // Обобщённый селектор (для сообщений — должен матчить все похожие элементы)
  function genericSelector(el, container) {
    const cls = stableClasses(el);
    let sel = el.tagName.toLowerCase() + (cls.length ? '.' + cls.map(esc).join('.') : '');
    const attr = ['data-testid', 'data-test', 'data-qa'].find((a) => el.hasAttribute(a));
    if (attr) sel += '[' + attr + '="' + el.getAttribute(attr) + '"]';
    if (!cls.length && !attr && el.parentElement && el.parentElement !== container) {
      const pc = stableClasses(el.parentElement);
      if (pc.length) sel = el.parentElement.tagName.toLowerCase() + '.' + pc.map(esc).join('.') + ' > ' + sel;
    }
    return sel;
  }

  const TIPS = {
    container: 'Кликните по ОКНУ чата (область со всеми сообщениями)',
    message: 'Кликните по ТЕКСТУ одного сообщения собеседника',
    input: 'Кликните по ПОЛЮ ВВОДА сообщения',
    sendButton: 'Кликните по КНОПКЕ ОТПРАВКИ сообщения',
    ticketId: 'Кликните по НОМЕРУ/ID тикета (или имени собеседника в шапке чата)'
  };

  let active = null;

  function pick(kind) {
    return new Promise((resolve) => {
      if (active) active.cancel(true);
      const box = ST.h('div', { [ST.UI_ATTR]: 'pick', class: 'st-pick-box' });
      const tip = ST.h('div', { [ST.UI_ATTR]: 'pick', class: 'st-pick-tip' }, TIPS[kind] + ' · Esc — отмена');
      document.documentElement.append(box);
      if (ST.isTop) document.documentElement.append(tip);
      let current = null;

      const move = (e) => {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || ST.isOurNode(el)) return;
        current = el;
        const r = el.getBoundingClientRect();
        Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      };
      const swallow = (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      };
      const click = (e) => {
        swallow(e);
        finish(current || e.target, false);
      };
      const key = (e) => {
        if (e.key === 'Escape') {
          swallow(e);
          finish(null, false);
        }
      };
      function finish(el, silent) {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('click', click, true);
        document.removeEventListener('mousedown', swallow, true);
        document.removeEventListener('mouseup', swallow, true);
        document.removeEventListener('keydown', key, true);
        box.remove();
        tip.remove();
        active = null;
        if (!silent) ST.send({ type: 'pickEnd' }).catch(() => {});
        resolve(el);
      }
      active = { cancel: (silent) => finish(null, silent) };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mousedown', swallow, true);
      document.addEventListener('mouseup', swallow, true);
      document.addEventListener('click', click, true);
      document.addEventListener('keydown', key, true);
    });
  }

  ST.picker = {
    cancel() {
      if (active) active.cancel(true);
    },
    async run(kind) {
      const el = await pick(kind);
      if (!el) return;

      const { settings } = await chrome.storage.local.get('settings');
      const all = L.mergeSettings(settings);
      let rule = ST.site && all.sites.find((s) => s.id === ST.site.id);
      if (!rule) {
        rule = Object.assign({}, L.SITE_DEFAULTS, {
          id: 'site-' + Date.now().toString(36),
          name: location.hostname || 'Новый сайт',
          urlPattern: location.origin && location.origin !== 'null' ? location.origin + '/*' : location.href.split(/[?#]/)[0] + '*'
        });
        all.sites.push(rule);
      }

      let sel;
      let count;
      if (kind === 'container') {
        sel = uniqueSelector(el);
        rule.containerSelector = sel;
        count = document.querySelectorAll(sel).length;
      } else if (kind === 'message') {
        let container = null;
        try { container = rule.containerSelector && el.closest(rule.containerSelector); } catch (e) { /* ignore */ }
        sel = genericSelector(el, container);
        rule.messageSelector = sel;
        count = (container || document).querySelectorAll(sel).length;
      } else if (kind === 'input') {
        const root = ST.editableRoot(el) || el.querySelector('textarea,[contenteditable="true"],input[type="text"]') || el;
        sel = uniqueSelector(root);
        rule.inputSelector = sel;
        count = document.querySelectorAll(sel).length;
      } else if (kind === 'sendButton') {
        const btn = el.closest('button,[role="button"],input[type="submit"],a') || el;
        sel = uniqueSelector(btn);
        rule.sendButtonSelector = sel;
        count = document.querySelectorAll(sel).length;
      } else if (kind === 'ticketId') {
        sel = uniqueSelector(el);
        rule.ticketIdSelector = sel;
        count = document.querySelectorAll(sel).length;
      } else {
        return;
      }
      await ST.saveSettings(all);
      const warn = kind !== 'message' && count !== 1 ? ' ⚠ ожидался 1 элемент — проверьте в настройках' : '';
      ST.toast('Сохранено: ' + sel + ' (найдено: ' + count + ')' + warn, { duration: 7000, error: !!warn });
    }
  };
})();
