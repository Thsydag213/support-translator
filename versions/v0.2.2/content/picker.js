/*
 * Выбор элемента на странице мышкой -> генерация CSS-селектора -> сохранение в правило сайта.
 * Работает в каждом фрейме вкладки; когда выбор сделан в одном фрейме, остальные отменяются.
 */
(function () {
  const ST = globalThis.ST;
  if (ST.picker) return;
  const L = ST.L;

  // Классы, похожие на сгенерированные (css-1abc2de, sc-AxjAm, _3xYz…), в селектор не берём
  // Утилитарные классы (Tailwind и подобные: flex, h-full, p-4, text-sm…) не описывают смысл элемента — тоже пропускаем
  const UTILITY_CLASS = /^(flex|grid|block|inline|hidden|contents|relative|absolute|fixed|sticky|static|truncate|group|peer|transition|container|w-|h-|min-|max-|size-|p[xytrbl]?-|m[xytrbl]?-|-m[xytrbl]?-|gap-|space-|text-|bg-|border|rounded|shadow|ring|outline|overflow|items-|justify-|content-|self-|place-|flex-|grid-|col-|row-|order-|leading-|tracking-|font-|opacity-|z-|inset|top-|left-|right-|bottom-|cursor-|select-|pointer-|whitespace-|break-|align-|duration-|ease-|delay-|animate-|translate-|scale-|rotate-|fill-|stroke-|fm-|shrink|grow|basis-|dark:|hover:|focus:|sm:|md:|lg:|xl:)/;
  const unstableClass = (c) =>
    /^(css|sc|jsx|emotion|styled)-|^_|[0-9a-f]{5,}|\d{3,}|^(active|selected|hover|focus|st-|ember)/i.test(c) || UTILITY_CLASS.test(c);

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
        if (ST.qsa(sel).length === 1) return sel;
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

  const parentOf = (el) => el.parentElement || (el.getRootNode() && el.getRootNode().host) || null;

  // Кликнули по <p>/<span> без классов — поднимаемся до ближайшего предка со стабильным признаком
  function climbToStable(el, container) {
    let cur = el;
    for (let i = 0; i < 5 && cur && cur !== container; i++) {
      if (stableClasses(cur).length || ['data-testid', 'data-test', 'data-qa'].some((a) => cur.hasAttribute(a))) return cur;
      cur = parentOf(cur);
    }
    return el;
  }

  // Признаки элемента для сравнения: стабильные классы и короткие data-атрибуты
  function tokens(el) {
    const out = stableClasses(el).map((c) => '.' + esc(c));
    for (const a of Array.from(el.attributes)) {
      if (/^data-/.test(a.name) && !/^data-st-/.test(a.name) && a.value && a.value.length <= 30 && !/\d{4,}/.test(a.value)) {
        out.push('[' + a.name + '="' + a.value.replace(/"/g, '\\"') + '"]');
      }
    }
    return out;
  }

  // Селектор, который есть у предков сообщения пользователя и отсутствует у сообщения оператора
  function differentiator(userEl, opEl) {
    const opSet = new Set();
    for (let cur = opEl, i = 0; cur && i < 12; cur = parentOf(cur), i++) tokens(cur).forEach((t) => opSet.add(t));
    for (let cur = userEl, i = 0; cur && i < 12; cur = parentOf(cur), i++) {
      for (const t of tokens(cur)) {
        if (opSet.has(t)) continue;
        try {
          if (ST.closestDeep(userEl, t) && !ST.closestDeep(opEl, t)) return t;
        } catch (e) { /* неверный селектор — пропускаем */ }
      }
    }
    return '';
  }

  const TIPS = {
    container: 'Кликните по ОКНУ чата (область со всеми сообщениями)',
    message: 'Кликните по ТЕКСТУ одного сообщения собеседника',
    userMessage: 'Шаг 1 из 2: кликните по сообщению ПОЛЬЗОВАТЕЛЯ',
    operatorMessage: 'Шаг 2 из 2: теперь кликните по сообщению ОПЕРАТОРА (нашему)',
    input: 'Кликните по ПОЛЮ ВВОДА сообщения',
    sendButton: 'Кликните по КНОПКЕ ОТПРАВКИ сообщения',
    ticketId: 'Кликните по НОМЕРУ/ID тикета (или имени собеседника в шапке чата)'
  };

  let active = null;

  // keepOthers: не отменять выбор в других фреймах (для двухшагового выбора)
  function pick(kind, keepOthers) {
    return new Promise((resolve) => {
      if (active) active.cancel(true);
      const box = ST.h('div', { [ST.UI_ATTR]: 'pick', class: 'st-pick-box' });
      const tip = ST.h('div', { [ST.UI_ATTR]: 'pick', class: 'st-pick-tip' }, TIPS[kind] + ' · Esc — отмена');
      document.documentElement.append(box);
      if (ST.isTop) document.documentElement.append(tip);
      let current = null;

      const move = (e) => {
        const el = ST.deepElementFromPoint(e.clientX, e.clientY);
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
        // Берём элемент точно под курсором в момент клика (подсветка могла отстать от мыши)
        const at = ST.deepElementFromPoint(e.clientX, e.clientY);
        finish(at && !ST.isOurNode(at) ? at : current || e.composedPath()[0], false);
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
        if (!silent && !keepOthers) ST.send({ type: 'pickEnd' }).catch(() => {});
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
    _differentiator: differentiator, // для тестов
    cancel() {
      if (active) active.cancel(true);
    },
    async run(kind) {
      const el = await pick(kind, kind === 'userMessage');
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
        count = ST.qsaSafe(sel).length;
      } else if (kind === 'userMessage') {
        const opEl = await pick('operatorMessage');
        if (!opEl) return;
        sel = differentiator(el, opEl);
        if (!sel) {
          ST.toast('Не нашёл признак, отличающий сообщения пользователя от сообщений оператора. Будут использоваться «Языки операторов» из настроек.', { error: true, duration: 8000 });
          return;
        }
        rule.userMessageSelector = sel;
        count = ST.qsaSafe(sel).length;
      } else if (kind === 'message') {
        let container = null;
        try { container = rule.containerSelector && ST.closestDeep(el, rule.containerSelector); } catch (e) { /* ignore */ }
        sel = genericSelector(climbToStable(el, container), container);
        rule.messageSelector = sel;
        count = ST.qsaSafe(sel, container || undefined).length;
      } else if (kind === 'input') {
        const root = ST.editableRoot(el) || el.querySelector('textarea,[contenteditable="true"],input[type="text"]') || el;
        sel = uniqueSelector(root);
        rule.inputSelector = sel;
        count = ST.qsaSafe(sel).length;
      } else if (kind === 'sendButton') {
        const btn = ST.closestDeep(el,'button,[role="button"],input[type="submit"],a') || el;
        sel = uniqueSelector(btn);
        rule.sendButtonSelector = sel;
        count = ST.qsaSafe(sel).length;
      } else if (kind === 'ticketId') {
        sel = uniqueSelector(el);
        rule.ticketIdSelector = sel;
        count = ST.qsaSafe(sel).length;
      } else {
        return;
      }
      await ST.saveSettings(all);
      const warn = kind !== 'message' && kind !== 'userMessage' && count !== 1 ?' ⚠ ожидался 1 элемент — проверьте в настройках' : '';
      ST.toast('Сохранено: ' + sel + ' (найдено: ' + count + ')' + warn, { duration: 7000, error: !!warn });
    }
  };
})();
