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

  // Селектор атрибута. Значения с номером в конце ("conversation-part-id-464826615") превращаются
  // в "начинается с" ([data-testid^="conversation-part-id-"]); прочие значения с длинными числами пропускаем
  function attrSel(name, value) {
    if (value == null || value === '') return '';
    const m = /^(.*?[-_:])\d{3,}$/.exec(value);
    if (m && m[1].length >= 3) return '[' + name + '^="' + m[1].replace(/"/g, '\\"') + '"]';
    if (/\d{4,}/.test(value) || value.length > 40) return '';
    return '[' + name + '="' + value.replace(/"/g, '\\"') + '"]';
  }
  function stableAttr(el, names) {
    for (const a of names || STABLE_ATTRS) {
      if (!el.hasAttribute(a)) continue;
      const s = attrSel(a, el.getAttribute(a));
      if (s) return s;
    }
    return '';
  }
  // Смысловое описание элемента без позиций: tag.class[attr]; '' — если описать нечем
  function semantic(el) {
    if (el.id && !/\d{3,}/.test(el.id)) return '#' + esc(el.id);
    const cls = stableClasses(el);
    const attr = stableAttr(el);
    if (!cls.length && !attr) return '';
    return el.tagName.toLowerCase() + (cls.length ? '.' + cls.map(esc).join('.') : '') + attr;
  }

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
      part += stableAttr(cur);
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
    const attr = stableAttr(el, ['data-testid', 'data-test', 'data-qa']);
    if (attr) sel += attr;
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
      if (stableClasses(cur).length || stableAttr(cur, ['data-testid', 'data-test', 'data-qa'])) return cur;
      cur = parentOf(cur);
    }
    return el;
  }

  // Признаки элемента для сравнения: стабильные классы и data-атрибуты (номера -> "начинается с")
  function tokens(el) {
    const out = stableClasses(el).map((c) => '.' + esc(c));
    for (const a of Array.from(el.attributes)) {
      if (!/^data-/.test(a.name) || /^data-st-/.test(a.name)) continue;
      const s = attrSel(a.name, a.value);
      if (s) out.push(s);
    }
    return out;
  }

  // Классы, которыми часто задают сторону сообщения (свои справа, чужие слева) — утилитарные, но здесь смысловые
  const SIDE_CLASS = /^(justify-end|justify-start|self-end|self-start|items-end|ml-auto|mr-auto|text-right|flex-row-reverse|is-outgoing|is-incoming|outgoing|incoming|out|in|own|mine|right|left)$/i;

  // Вариант "[общий признак]:not(.класс-стороны)": части переписки одинаковые, у сообщений агента есть класс выравнивания
  function sideDifferentiator(userEl, opEl) {
    for (let o = opEl, i = 0; o && i < 12; o = parentOf(o), i++) {
      const side = Array.from(o.classList || []).filter((c) => SIDE_CLASS.test(c));
      if (!side.length) continue;
      const bases = tokens(o).filter((t) => t.startsWith('['));
      for (const b of bases) {
        let u;
        try { u = ST.closestDeep(userEl, b); } catch (e) { continue; }
        if (!u || u === o) continue;
        for (const c of side) {
          if (u.classList.contains(c)) continue;
          const cand = b + ':not(.' + esc(c) + ')';
          try {
            if (ST.closestDeep(userEl, cand) && !ST.closestDeep(opEl, cand)) return cand;
          } catch (e) { /* пропускаем */ }
        }
      }
    }
    return '';
  }

  // Селектор, который есть у предков сообщения пользователя и отсутствует у сообщения оператора
  function differentiator(userEl, opEl) {
    const side = sideDifferentiator(userEl, opEl);
    if (side) return side;
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
    listItem: 'Кликните по ТЕКСТУ ПРЕВЬЮ одного тикета в списке (последнее сообщение)',
    subject: 'Кликните по ТЕМЕ письма/тикета в шапке',
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
        // Сначала ищем смыслового предка (id / класс / data-testid / role), совпадающего максимум с 3 элементами
        sel = '';
        for (let cur = el, i = 0; cur && i < 12; cur = parentOf(cur), i++) {
          const s = semantic(cur);
          if (s && ST.qsaSafe(s).length > 0 && ST.qsaSafe(s).length <= 3) {
            sel = s;
            break;
          }
        }
        if (!sel) sel = uniqueSelector(el);
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
      } else if (kind === 'listItem') {
        // Все превью списка должны совпасть — обобщённый селектор, как у сообщений
        sel = genericSelector(climbToStable(el, null), null);
        rule.listItemSelector = sel;
        count = ST.qsaSafe(sel).length;
      } else if (kind === 'subject') {
        sel = uniqueSelector(el);
        rule.subjectSelector = sel;
        count = ST.qsaSafe(sel).length;
      } else if (kind === 'ticketId') {
        sel = uniqueSelector(el);
        rule.ticketIdSelector = sel;
        count = ST.qsaSafe(sel).length;
      } else {
        return;
      }
      await ST.saveSettings(all);
      const warn = !['message', 'userMessage', 'listItem'].includes(kind) && count !== 1 ? ' ⚠ ожидался 1 элемент — проверьте в настройках' : '';
      ST.toast('Сохранено: ' + sel + ' (найдено: ' + count + ')' + warn, { duration: 7000, error: !!warn });
    }
  };
})();
