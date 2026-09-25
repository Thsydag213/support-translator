/*
 * Исходящие сообщения: кнопка у поля ввода -> панель подтверждения перевода.
 * Оригинал | Перевод (редактируемый) | Обратный перевод для сверки смысла.
 * Проверки перед вставкой: числа/суммы/ссылки, обращение на "ты", опечатки в оригинале.
 * Ничего не отправляется автоматически: текст вставляется в поле только после подтверждения.
 */
(function () {
  const ST = globalThis.ST;
  if (ST.outgoing) return;
  const L = ST.L;
  const C = globalThis.ST_CHECKS;

  let lastField = null; // последнее поле ввода, где был фокус
  let lastInsert = null; // { field, original, translated, lang }
  let fab = null; // плавающая кнопка
  let panel = null; // открытая панель
  let fabIntent = null; // тема обращения для кнопки у поля
  let fabIntentAt = 0;

  // ---------- Плавающая кнопка ----------
  function ensureFab() {
    if (fab) return fab;
    const host = ST.h('div', { [ST.UI_ATTR]: 'fab', class: 'st-fab-host' });
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        .row{display:flex;gap:4px;align-items:center}
        button{all:unset;cursor:pointer;display:flex;align-items:center;gap:4px;padding:3px 8px;border-radius:999px;
          background:#1a73e8;color:#fff;font:600 12px/18px system-ui,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.25);white-space:nowrap}
        button:hover{background:#1558b0}
        button.sub{background:#5f6368;padding:3px 7px;font-weight:500}
        button.sub:hover{background:#3c4043}
        .lang{font-weight:500;opacity:.85}
        [hidden]{display:none!important}
      </style>
      <div class="row">
        <button type="button" class="main"><span class="label">🌐 Перевести</span> <span class="lang"></span></button>
        <button type="button" class="sub tag" hidden title="Тема обращения — открыть «Кратко о тикете»"></button>
        <button type="button" class="sub more" title="Все команды (палитра)">⋯</button>
      </div>`;
    const btn = (sel, fn) =>
      shadow.querySelector(sel).addEventListener('mousedown', (e) => {
        e.preventDefault(); // не забираем фокус у поля
        e.stopPropagation();
        fn(e);
      });
    // Клик — режим из настроек (панель или быстрая вставка), Shift+клик — другой режим
    btn('.main', (e) => {
      if (!lastField) return;
      const quickMode = !!ST.settings.quickInsert !== !!e.shiftKey;
      if (quickMode) quick(lastField);
      else open(lastField);
    });
    btn('.tag', () => ST.assist && ST.assist.openTicketPanel());
    btn('.more', () => ST.palette && ST.palette.open());
    host.style.cssText = 'position:fixed;z-index:2147483646;display:none;';
    document.documentElement.appendChild(host);
    fab = host;
    return fab;
  }

  function placeFab() {
    if (!fab || !lastField || !lastField.isConnected) return hideFab();
    const r = lastField.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return hideFab();
    // Во внутренней заметке перевод не нужен — кнопку прячем
    if (ST.isNoteMode(lastField)) return hideFab();
    const exp = ST.expectedLang();
    const expReply = L.replyTarget(ST.settings, exp.lang);
    const sr = fab.shadowRoot;
    sr.querySelector('.lang').textContent = expReply ? '→ ' + expReply.toUpperCase() + (exp.source === 'lock' ? ' 📌' : '') : '';
    const quickMode = !!ST.settings.quickInsert;
    sr.querySelector('.label').textContent = quickMode ? '⚡ Перевести' : '🌐 Перевести';
    sr.querySelector('.main').title = quickMode
      ? 'Перевести и сразу вставить (Shift+клик — с панелью подтверждения)'
      : 'Перевести с подтверждением (Shift+клик — сразу вставить)';
    // Тема обращения (по ключевым словам) — не чаще раза в 3 с: разбор переписки не бесплатный
    if (Date.now() - fabIntentAt > 3000) {
      fabIntentAt = Date.now();
      try { fabIntent = ST.assist ? ST.assist.currentIntent() : null; } catch (e) { fabIntent = null; }
    }
    const tag = sr.querySelector('.tag');
    tag.hidden = !fabIntent;
    tag.textContent = fabIntent ? '🏷 ' + fabIntent.label : '';
    fab.style.display = 'block';
    const w = fab.offsetWidth || 90;
    fab.style.left = Math.max(4, Math.min(window.innerWidth - w - 4, r.right - w - 6)) + 'px';
    fab.style.top = Math.max(4, r.top - 26) + 'px';
  }

  function hideFab() {
    if (fab) fab.style.display = 'none';
  }

  document.addEventListener('focusin', (e) => {
    const t = e.composedPath ? e.composedPath()[0] : e.target;
    if (!ST.fieldAllowed(t)) return;
    lastField = ST.editableRoot(t);
    if (ST.settings.outgoingButton) {
      ensureFab();
      placeFab();
    }
  }, true);

  document.addEventListener('focusout', () => {
    setTimeout(() => {
      const a = ST.deepActiveElement();
      if (!a || !ST.fieldAllowed(a)) hideFab();
    }, 150);
  }, true);

  // Режим "Ответ/Заметка" переключают кликом — перепроверяем видимость кнопки
  document.addEventListener('click', () => {
    if (fab && lastField && ST.settings.outgoingButton) setTimeout(placeFab, 200);
  }, true);

  window.addEventListener('scroll', () => fab && fab.style.display !== 'none' && placeFab(), true);
  window.addEventListener('resize', () => fab && fab.style.display !== 'none' && placeFab());

  // ---------- Панель подтверждения ----------
  // Общие переменные темы: светлая по умолчанию, тёмная — класс .dark (по фону сайта или настройке)
  const THEME_CSS = `
    .wrap, .box{--bg:#fff;--fg:#202124;--muted:#5f6368;--border:#dadce0;--line:#eee;--soft:#f8f9fa;--hover:#f1f3f4;
      --trbg:#f1f6fe;--trborder:#c6dafc;--accent:#1a73e8;--accent-hover:#1558b0;
      --warnbg:#fef7e0;--warnfg:#7a4f01;--errbg:#fce8e6;--errfg:#a50e0e;--mark:#fde293;--markfg:#202124;
      --infobg:#e8f0fe;--infofg:#174ea6;--shadow:0 12px 40px rgba(0,0,0,.28)}
    .wrap.dark, .box.dark{--bg:#202124;--fg:#e8eaed;--muted:#9aa0a6;--border:#3c4043;--line:#303134;--soft:#28292c;--hover:#303134;
      --trbg:#1b2638;--trborder:#2f4a70;--accent:#8ab4f8;--accent-hover:#aecbfa;
      --warnbg:#3a3113;--warnfg:#fdd663;--errbg:#3c1f1d;--errfg:#f6aea9;--mark:#5c4a13;--markfg:#fdd663;
      --infobg:#1c2a40;--infofg:#aecbfa;--shadow:0 12px 40px rgba(0,0,0,.6)}
  `;

  const PANEL_CSS = `
    :host{all:initial}
    *{box-sizing:border-box}
    ${THEME_CSS}
    .wrap{position:fixed;z-index:2147483647;width:min(820px,calc(100vw - 24px));background:var(--bg);color:var(--fg);
      border-radius:12px;box-shadow:var(--shadow);font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;
      border:1px solid var(--border);display:flex;flex-direction:column;max-height:calc(100vh - 24px)}
    header{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap}
    header b{font-size:14px;margin-right:auto}
    select{font:inherit;padding:3px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:inherit}
    .lang{color:var(--muted)}
    .lock{display:flex;align-items:center;gap:4px;color:var(--muted);font-size:12px;cursor:pointer;user-select:none}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:12px 14px;overflow:auto;flex:1 1 auto;min-height:0}
    header,footer{flex:0 0 auto}
    @media (max-width:640px){.grid{grid-template-columns:1fr}}
    label.cap{display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-bottom:4px}
    textarea{width:100%;min-height:90px;max-height:38vh;resize:vertical;overflow:auto;font:inherit;padding:8px 10px;border:1px solid var(--border);border-radius:8px;color:inherit;background:var(--bg)}
    textarea:focus{outline:2px solid var(--accent);border-color:transparent}
    textarea.tr{background:var(--trbg);border-color:var(--trborder)}
    .back{grid-column:1/-1;background:var(--soft);border:1px dashed var(--border);border-radius:8px;padding:8px 10px;white-space:pre-wrap;min-height:40px;max-height:30vh;overflow:auto;overflow-wrap:anywhere}
    .back mark{background:var(--mark);color:var(--markfg);border-radius:3px;padding:0 1px}
    .note{grid-column:1/-1;font-size:12px;color:var(--muted)}
    .checks{grid-column:1/-1;display:flex;flex-direction:column;gap:6px}
    .check{border-radius:8px;padding:6px 10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .check.warn{background:var(--warnbg);color:var(--warnfg)}
    .check.err{background:var(--errbg);color:var(--errfg)}
    .check.info{background:var(--infobg);color:var(--infofg)}
    .check code{font:12px/1.3 ui-monospace,Menlo,Consolas,monospace;background:rgba(127,127,127,.18);padding:0 4px;border-radius:4px}
    .check button{padding:4px 10px;font-size:12px}
    footer{display:flex;gap:8px;justify-content:flex-end;align-items:center;padding:10px 14px;border-top:1px solid var(--line);flex-wrap:wrap}
    footer .hint{margin-right:auto;color:var(--muted);font-size:12px}
    button{font:600 13px/1 inherit;font-family:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--fg);cursor:pointer}
    button:hover{background:var(--hover)}
    button.primary{background:var(--accent);color:var(--bg);border-color:var(--accent)}
    button.primary:hover{background:var(--accent-hover)}
    button:disabled{opacity:.5;cursor:default}
    .x{border:none;padding:4px 8px;font-size:16px}
    .spin{color:var(--accent)}
    [hidden]{display:none!important}
    .assist{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;align-items:center}
    .assist button{padding:4px 9px;font-size:12px;font-weight:500}
    .assist .lbl{font-size:11px;color:var(--muted)}
  `;

  // В списке — только языки, включённые для ответов (настройки → «Языки ответов»)
  function langOptions(selected) {
    const codes = L.LANGS.filter((c) => L.replyAllowed(ST.settings, c));
    for (const c of ST.settings.replyLangs || []) if (!codes.includes(c)) codes.push(c);
    if (selected && !codes.includes(selected)) codes.unshift(selected);
    return codes
      .map((c) => `<option value="${c}"${c === selected ? ' selected' : ''}>${L.langName(c)} (${c})</option>`)
      .join('');
  }

  const normWord = (w) => w.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '');
  // Грубая "основа" слова: первые 5 букв — чтобы не подсвечивать разные окончания (обновится/обновлен)
  const stem = (w) => (w.length > 5 ? w.slice(0, 5) : w);

  // Подсветка слов обратного перевода, которых нет в оригинале — быстрый индикатор расхождений
  function renderBack(container, original, back) {
    container.textContent = '';
    const origStems = new Set(original.split(/\s+/).map(normWord).filter(Boolean).map(stem));
    for (const part of back.split(/(\s+)/)) {
      const w = normWord(part);
      if (w && w.length > 2 && !origStems.has(stem(w))) {
        const m = document.createElement('mark');
        m.textContent = part;
        container.appendChild(m);
      } else {
        container.appendChild(document.createTextNode(part));
      }
    }
  }

  function close() {
    if (!panel) return;
    panel.host.remove();
    panel = null;
  }

  // Язык ответа — только из текущего тикета; язык прошлого тикета (или "последний на сайте") не подставляется
  // Язык собеседника выключен для ответов → { lang: язык ответа по умолчанию, disabled: язык собеседника }
  async function pickTarget() {
    const r = await ST.resolveConversationLang();
    const lang = r.lang || ST.settings.fallbackOutgoingLang;
    const target = L.replyTarget(ST.settings, lang);
    return { lang: target, disabled: target !== lang ? lang : '' };
  }

  // Элемент проверки: текст + необязательная кнопка действия
  function checkItem(level, parts, action) {
    const el = document.createElement('div');
    el.className = 'check ' + level;
    for (const p of parts) {
      if (typeof p === 'string') el.appendChild(document.createTextNode(p));
      else el.appendChild(p);
    }
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = action.label;
      b.addEventListener('click', action.run);
      el.appendChild(b);
    }
    return el;
  }

  function codeList(items) {
    const frag = document.createDocumentFragment();
    items.forEach((x, i) => {
      if (i) frag.appendChild(document.createTextNode(' '));
      const c = document.createElement('code');
      c.textContent = x;
      frag.appendChild(c);
    });
    return frag;
  }

  /**
   * Перевод текста ответа (панель и быстрая вставка):
   *   память переводов (подтверждённые оператором переводы) → скачанный переводчик Chrome → облако.
   * -> { translation, detectedLang, provider, spell, tm? }
   */
  async function translateReply(text, tl, o) {
    o = o || {};
    const s = ST.settings;
    const mode = s.localTranslatorMode || 'all';
    // Язык оригинала без облака; если детекторы не справились — по письменности (кириллица → язык операторов)
    const src = mode === 'all' || o.useTm !== false ? await ST.detectSource(text).catch(() => ({ lang: '', guess: '' })) : { lang: '', guess: '' };
    if (!src.guess) {
      const script = L.textScript(text).script;
      const opLang = (s.operatorLangs || []).find((l) => L.langScript(l) === script);
      src.guess = opLang || (script === 'Latin' ? 'en' : '');
    }
    if (o.useTm !== false && ST.tm) {
      const hit = await ST.tm.get(text, tl);
      if (hit) return { translation: hit.translation, detectedLang: src.lang || src.guess || '', provider: 'tm', tm: hit, spell: '' };
    }
    return ST.translate(text, 'auto', tl, {
      spell: !!o.spell,
      local: mode === 'all',
      localSource: mode === 'all' ? src.lang : '',
      localGuess: mode === 'all' ? src.guess : ''
    });
  }

  // Быстрая вставка: перевести и сразу вставить, без панели. Если проверки нашли проблему — открываем панель.
  async function quick(field) {
    field = ST.editableRoot(field);
    if (!field) return ST.toast('Поставьте курсор в поле ввода', { error: true });
    const original = ST.getFieldText(field);
    if (!original.trim()) return ST.toast('Поле ввода пустое — нечего переводить', { error: true });
    hideFab();
    const tl = (await pickTarget()).lang;
    ST.toast('⚡ Перевожу на ' + L.langName(tl) + '…', { duration: 2500 });
    let res;
    try {
      res = await translateReply(original, tl, {});
    } catch (e) {
      return ST.toast('Перевод не удался: ' + e.message, { error: true, duration: 8000 });
    }
    if (L.sameLang(res.detectedLang, tl)) return ST.toast('Текст уже на языке «' + L.langName(tl) + '» — перевод не нужен');
    const s = ST.settings;
    const factsBad = s.checkNumbers && !C.compareFacts(original, res.translation).ok;
    const informal = s.formality === 'formal' && C.informalMarkers(res.translation, tl).length > 0;
    if (factsBad || informal) {
      ST.toast((factsBad ? '🔢 Числа или ссылки в переводе не совпадают' : '🤝 Перевод обращается на «ты»') + ' — открываю панель для проверки', { duration: 6000 });
      return open(field);
    }
    if (ST.getFieldText(field) !== original) return ST.toast('Текст в поле изменился во время перевода — перевод не вставлен', { error: true });
    ST.setFieldText(field, res.translation);
    lastInsert = { field, original, translated: ST.getFieldText(field), inserted: res.translation, lang: tl };
    rememberLang(tl);
    ST.track({ kind: 'outgoing', lang: tl, chars: res.translation.length });
    ST.toast('⚡ Вставлен перевод (' + L.langName(tl) + (res.provider === 'tm' ? ', из памяти переводов' : '') + '). Проверьте и отправьте.', {
      duration: 8000,
      action: { label: '↩ Вернуть и открыть панель', run: () => { restoreOriginal(); open(field); } }
    });
  }

  /**
   * open(field, opts) — opts.onInserted() вызывается после вставки перевода (для защиты от отправки);
   * opts.assist — сразу применить правку локальной моделью ('fix' | 'polite' | 'short' | 'friendly')
   */
  async function open(field, opts) {
    opts = opts || {};
    field = ST.editableRoot(field);
    if (!field) return ST.toast('Поставьте курсор в поле ввода', { error: true });
    const original = ST.getFieldText(field);
    if (!original.trim()) return ST.toast('Поле ввода пустое — нечего переводить', { error: true });
    close();
    hideFab();

    const s = ST.settings;
    const picked = await pickTarget();
    const target = picked.lang;
    const locked = !!ST.langLock.get();

    const host = ST.h('div', { [ST.UI_ATTR]: 'panel' });
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${PANEL_CSS}</style>
      <div class="wrap" role="dialog" aria-label="Подтверждение перевода">
        <header>
          <b>Перевод исходящего сообщения</b>
          <span class="lang">С: <span id="src">определяется…</span></span>
          <span>→</span>
          <select id="tl" title="Язык собеседника">${langOptions(target)}</select>
          <label class="lock" title="Использовать этот язык для тикета, даже если пользователь пишет на другом"><input type="checkbox" id="lock"> 📌 закрепить для тикета</label>
          <button class="x" id="close" title="Закрыть (Esc)">✕</button>
        </header>
        <div class="grid">
          <div>
            <label class="cap" for="orig">Ваш текст (оригинал)</label>
            <textarea id="orig" dir="auto"></textarea>
            <div class="assist" id="assist" hidden></div>
          </div>
          <div>
            <label class="cap" for="tr">Перевод — будет вставлен в поле <span class="spin" id="spin" hidden>⏳</span></label>
            <textarea id="tr" class="tr" placeholder="Перевод…"></textarea>
          </div>
          <div class="checks" id="checks"></div>
          <div class="check err" id="err" hidden></div>
          <div style="grid-column:1/-1">
            <label class="cap">Обратный перевод — проверка смысла <span class="lang" id="backLang"></span> <span class="spin" id="spinBack" hidden>⏳</span></label>
            <div class="back" id="back"></div>
          </div>
          <div class="note">Жёлтым отмечены слова обратного перевода, которых нет в оригинале — проверьте эти места. Перевод можно править вручную.</div>
        </div>
        <footer>
          <span class="hint">${ST.keys('Ctrl+Enter')} — вставить · Esc — отмена · сообщение не отправляется автоматически</span>
          <button id="copy">Копировать</button>
          <button id="cancel">Отмена</button>
          <button id="ok" class="primary" disabled>✔ Вставить перевод</button>
        </footer>
      </div>`;
    document.documentElement.appendChild(host);

    const $ = (id) => shadow.getElementById(id);
    const wrap = shadow.querySelector('.wrap');
    if (ST.uiDark(field)) wrap.classList.add('dark');
    const ui = {
      orig: $('orig'), tr: $('tr'), tl: $('tl'), src: $('src'), back: $('back'), backLang: $('backLang'),
      checks: $('checks'), err: $('err'), ok: $('ok'), spin: $('spin'), spinBack: $('spinBack'), lock: $('lock'), assist: $('assist')
    };
    ui.back.dir = 'auto';
    // Арабский и другие языки справа налево: поле перевода переключается на RTL
    const applyDir = () => { ui.tr.dir = L.isRtl(ui.tl.value) ? 'rtl' : 'ltr'; };
    applyDir();
    ui.orig.value = original;
    ui.lock.checked = locked;

    // Позиционирование: над полем ввода, под ним или по центру — и панель НИКОГДА не выходит за экран.
    // Высота ограничена свободным местом; длинный текст прокручивается внутри панели.
    const place = () => {
      if (!wrap.isConnected) return;
      const r = field.getBoundingClientRect();
      const vh = window.innerHeight;
      const w = Math.min(820, window.innerWidth - 24);
      wrap.style.left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w / 2)) + 'px';
      const above = r.top - 8 - 12;
      const below = vh - r.bottom - 8 - 12;
      wrap.style.top = wrap.style.bottom = '';
      if (above >= 380 || (above >= below && above >= 300)) {
        wrap.style.bottom = Math.max(12, vh - r.top + 8) + 'px';
        wrap.style.maxHeight = above + 'px';
      } else if (below >= 380) {
        wrap.style.top = r.bottom + 8 + 'px';
        wrap.style.maxHeight = below + 'px';
      } else {
        wrap.style.top = '12px';
        wrap.style.maxHeight = vh - 24 + 'px';
      }
    };
    place();
    const onResize = () => place();
    window.addEventListener('resize', onResize);
    new MutationObserver((m, obs) => {
      if (!host.isConnected) {
        window.removeEventListener('resize', onResize);
        obs.disconnect();
      }
    }).observe(document.documentElement, { childList: true });

    // события клавиатуры не должны уходить сайту (иначе Enter может отправить сообщение)
    for (const type of ['keydown', 'keyup', 'keypress', 'input', 'paste', 'copy', 'cut']) {
      host.addEventListener(type, (e) => e.stopPropagation());
    }

    const state = { srcLang: '', seq: 0, backSeq: 0, spell: '', sameLang: false, politeTried: false, disabledLang: picked.disabled, tm: null, skipTm: false, assisted: '' };
    panel = { host, field };

    function setError(msg) {
      ui.err.hidden = !msg;
      ui.err.textContent = msg ? '⚠ ' + msg : '';
      // Не хватает языкового пакета — кнопка скачать его прямо отсюда (без перехода в настройки)
      const tgt = ST.local ? ST.local.toBcp(ui.tl.value) : '';
      const missing = msg && ST.local ? ST.local.missingPacks().filter((p) => p.split('>')[1] === tgt) : [];
      if (!missing.length) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = '⬇ Скачать пакет ' + missing.map((p) => p.replace('>', '→')).join(', ');
      b.style.marginLeft = '8px';
      b.addEventListener('click', () => {
        if (!ST.local.canDownloadHere()) {
          ST.send({ type: 'openOptions' }).catch(() => {});
          return;
        }
        b.disabled = true;
        const progress = {};
        ST.local.download(missing, (p, t) => {
          progress[p] = t;
          b.textContent = '⏳ ' + Object.entries(progress).map(([k, v]) => k.replace('>', '→') + ': ' + v).join(', ');
        }).then((ok) => {
          b.textContent = ok ? '✅ Пакеты скачаны — перевожу' : '⚠ Не всё скачалось — настройки → «Перевод на устройстве»';
          if (ok) setTimeout(doTranslate, 300);
        });
      });
      ui.err.appendChild(b);
    }

    // Все проверки перевода — пересчитываются после перевода и при ручной правке
    function renderChecks() {
      ui.checks.textContent = '';
      const orig = ui.orig.value;
      const tr = ui.tr.value;
      const tl = ui.tl.value;
      let blocking = false;

      if (state.disabledLang && tl === target) {
        ui.checks.appendChild(checkItem('info', ['🌐 Собеседник пишет на языке «' + L.langName(state.disabledLang) + '» — он выключен для ответов, перевод на «' + L.langName(tl) + '». Включить язык: настройки → «Языки ответов».']));
      }

      if (state.tm) {
        ui.checks.appendChild(checkItem('info', ['🧠 Из памяти переводов — ваш ранее подтверждённый перевод' + (state.tm.uses > 1 ? ' (подтверждён ' + state.tm.uses + ' раз)' : '') + '.'], {
          label: 'Перевести заново',
          run: () => { state.skipTm = true; doTranslate(); }
        }));
      }
      if (state.assisted) {
        ui.checks.appendChild(checkItem('info', ['✨ Перевод отредактирован локальной моделью (' + state.assisted + '). Сверьте обратный перевод — смысл не должен измениться.'], {
          label: 'Обычный перевод',
          run: () => doTranslate()
        }));
      }

      if (state.sameLang) {
        ui.checks.appendChild(checkItem('warn', ['Текст уже на языке «' + L.langName(tl) + '». Проверьте, правильно ли выбран язык собеседника.']));
      }

      if (s.spellCheck && state.spell && state.spell.trim() !== orig.trim()) {
        ui.checks.appendChild(checkItem('info', ['✏️ Возможно, опечатка. Вариант: «' + state.spell + '»'], {
          label: 'Исправить и перевести',
          run: () => {
            ui.orig.value = state.spell;
            state.spell = '';
            doTranslate();
          }
        }));
      }

      if (s.checkNumbers && tr.trim()) {
        const f = C.compareFacts(orig, tr);
        if (!f.ok) {
          blocking = true;
          const parts = ['🔢 Проверьте числа и ссылки.'];
          if (f.missing.length) parts.push(' Нет в переводе: ', codeList(f.missing));
          if (f.extra.length) parts.push(' Появилось в переводе: ', codeList(f.extra));
          ui.checks.appendChild(checkItem('err', parts));
        }
      }

      if (s.formality === 'formal' && tr.trim() && !state.sameLang) {
        const markers = C.informalMarkers(tr, tl);
        if (markers.length) {
          const canRetry = !state.politeTried && /\p{Script=Cyrillic}/u.test(orig) && C.hasLowercasePoliteRu(orig);
          ui.checks.appendChild(checkItem('warn', [
            '🤝 Перевод обращается на «ты»: ', codeList(markers),
            canRetry ? '' : '. Поправьте вручную или добавьте формулировку в глоссарий.'
          ], canRetry ? {
            label: 'Перевести вежливо («Вы»)',
            run: () => {
              state.politeTried = true;
              ui.orig.value = C.politeRu(ui.orig.value);
              doTranslate();
            }
          } : null));
        }
      }

      ui.ok.textContent = blocking ? '⚠ Вставить всё равно' : '✔ Вставить перевод';
    }

    async function doBack() {
      const text = ui.tr.value;
      const my = ++state.backSeq;
      if (!text.trim()) {
        ui.back.textContent = '';
        return;
      }
      const backLang = s.backTranslateLang === 'auto' ? state.srcLang || 'en' : s.backTranslateLang;
      ui.backLang.textContent = '(' + L.langName(ui.tl.value) + ' → ' + L.langName(backLang) + ')';
      ui.spinBack.hidden = false;
      try {
        // Обратный перевод — только для проверки смысла: можно на устройстве (без запроса в облако)
        const b = await ST.translate(text, ui.tl.value, backLang, { local: ['all', 'incoming+back'].includes(s.localTranslatorMode || 'all') });
        if (my !== state.backSeq || !panel) return;
        renderBack(ui.back, ui.orig.value, b.translation);
      } catch (e) {
        if (my === state.backSeq) ui.back.textContent = 'Не удалось получить обратный перевод: ' + e.message;
      } finally {
        if (my === state.backSeq) ui.spinBack.hidden = true;
      }
    }

    async function doTranslate() {
      const text = ui.orig.value;
      const tl = ui.tl.value;
      const my = ++state.seq;
      setError('');
      ui.ok.disabled = true;
      if (!text.trim()) {
        ui.tr.value = '';
        ui.back.textContent = '';
        ui.checks.textContent = '';
        return;
      }
      ui.spin.hidden = false;
      state.assisted = '';
      try {
        // Память переводов → скачанный переводчик Chrome → облако. Подсказку опечаток даёт только облако.
        const res = await translateReply(text, tl, { spell: !!s.spellCheck, useTm: !state.skipTm });
        if (my !== state.seq || !panel) return;
        state.tm = res.tm || null;
        state.srcLang = res.detectedLang;
        state.spell = res.spell || '';
        state.sameLang = L.sameLang(res.detectedLang, tl);
        ui.src.textContent = L.langName(res.detectedLang) + ' (' + res.detectedLang + ')';
        ui.tr.value = res.translation;
        ui.ok.disabled = false;
        renderChecks();
        doBack();
      } catch (e) {
        if (my === state.seq) setError('Перевод не удался: ' + e.message);
      } finally {
        if (my === state.seq) ui.spin.hidden = true;
      }
    }

    let tOrig = null;
    let tTr = null;
    ui.orig.addEventListener('input', () => {
      clearTimeout(tOrig);
      state.skipTm = false;
      tOrig = setTimeout(doTranslate, 700);
    });
    ui.tr.addEventListener('input', () => {
      ui.ok.disabled = !ui.tr.value.trim();
      clearTimeout(tTr);
      tTr = setTimeout(() => {
        renderChecks();
        doBack();
      }, 700);
    });
    ui.tl.addEventListener('change', () => {
      if (ui.lock.checked) ST.langLock.set(ui.tl.value);
      state.politeTried = false;
      applyDir();
      doTranslate();
    });
    ui.lock.addEventListener('change', () => {
      if (ui.lock.checked) ST.langLock.set(ui.tl.value);
      else ST.langLock.clear();
    });

    // Правка локальной моделью. Модель уверенно работает с английским, поэтому:
    // текст оператора → английский → правка → язык собеседника (переводы — на устройстве, если есть пакеты)
    async function doAssist(mode) {
      const text = ui.orig.value;
      const tl = ui.tl.value;
      if (!text.trim() || !ST.assist) return;
      const my = ++state.seq;
      setError('');
      ui.ok.disabled = true;
      ui.spin.hidden = false;
      ui.assist.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      try {
        const src = (await ST.detectSource(text)).lang;
        const en = src && L.sameLang(src, 'en') ? text : (await translateReply(text, 'en', { useTm: false })).translation;
        const edited = await ST.assist.rewrite(en, mode);
        const localAll = (s.localTranslatorMode || 'all') === 'all';
        const out = L.sameLang(tl, 'en') ? edited : (await ST.translate(edited, 'en', tl, { local: localAll, localSource: 'en' })).translation;
        if (my !== state.seq || !panel) return;
        state.tm = null;
        state.assisted = ST.assist.MODES[mode].ru;
        if (!state.srcLang) state.srcLang = src || '';
        ui.tr.value = out;
        ui.ok.disabled = false;
        renderChecks();
        doBack();
      } catch (e) {
        if (my === state.seq) {
          setError('Помощник: ' + e.message);
          ui.ok.disabled = !ui.tr.value.trim();
        }
      } finally {
        if (my === state.seq) ui.spin.hidden = true;
        ui.assist.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      }
    }
    if (s.assist !== false && ST.assist) {
      ui.assist.hidden = false;
      ui.assist.appendChild(ST.h('span', { class: 'lbl' }, 'Локальная модель:'));
      for (const [mode, m] of Object.entries(ST.assist.MODES)) {
        ui.assist.appendChild(ST.h('button', { type: 'button', title: 'Отредактировать перевод на устройстве (без интернета)', onclick: () => doAssist(mode) }, m.label));
      }
    }

    async function confirm() {
      const text = ui.tr.value;
      if (!text.trim() || ui.ok.disabled) return;
      const originalNow = ST.getFieldText(field);
      const tl = ui.tl.value;
      // Память переводов: подтверждённый (и, возможно, поправленный) перевод пригодится в следующий раз
      if (ST.tm) ST.tm.set(ui.orig.value, tl, text);
      close();
      ST.setFieldText(field, text);
      lastInsert = { field, original: originalNow, translated: ST.getFieldText(field), inserted: text, lang: tl };
      rememberLang(tl);
      ST.track({ kind: 'outgoing', lang: tl, chars: text.length });
      ST.toast('Вставлен перевод (' + L.langName(tl) + '). Проверьте и отправьте.', {
        duration: 6000,
        action: { label: '↩ Вернуть оригинал', run: () => restoreOriginal() }
      });
      if (opts.onInserted) opts.onInserted();
    }

    $('ok').addEventListener('click', confirm);
    $('cancel').addEventListener('click', () => { close(); field.focus(); });
    $('close').addEventListener('click', () => { close(); field.focus(); });
    $('copy').addEventListener('click', () => {
      navigator.clipboard.writeText(ui.tr.value);
      ST.toast('Перевод скопирован');
    });
    host.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        field.focus();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        confirm();
      }
    });

    ui.tr.focus();
    if (opts.assist) doAssist(opts.assist);
    else doTranslate();
  }

  // Запоминаем язык ответа для ЭТОГО тикета (раньше — один на весь сайт, из-за чего подставлялся язык прошлого тикета)
  async function rememberLang(tl) {
    if (!ST.site) return;
    try {
      await ST.ticketLang.set(tl);
    } catch (e) { /* ignore */ }
  }

  function restoreOriginal() {
    if (!lastInsert || !lastInsert.field.isConnected) return;
    ST.setFieldText(lastInsert.field, lastInsert.original);
    lastInsert = null;
  }

  ST.outgoing = {
    open,
    quick,
    translateReply,
    THEME_CSS,
    // Поле для команд палитры: активное или последнее, где был курсор
    activeField() {
      const a = ST.deepActiveElement();
      const f = a && ST.fieldAllowed(a) ? ST.editableRoot(a) : lastField;
      return f && f.isConnected ? f : null;
    },
    quickForActive() {
      if (!ST.site) return ST.toast('Для этого сайта не настроено правило перевода', { error: true });
      quick(this.activeField());
    },
    openForActive() {
      const a = ST.deepActiveElement();
      const f = a && ST.fieldAllowed(a) ? a : lastField;
      if (!ST.site) return ST.toast('Для этого сайта не настроено правило перевода', { error: true });
      open(f);
    },
    close,
    isOpen: () => !!panel,
    lastField: () => (lastField && lastField.isConnected ? lastField : null),
    // Текст в поле — ровно тот перевод, который вставили мы
    // Сравнение без учёта переносов и пробелов: редактор (ProseMirror и т.п.) после вставки перестраивает абзацы
    wasInserted(field, text) {
      if (!lastInsert || lastInsert.field !== field) return false;
      const norm = (s) => String(s).replace(/[\s ​]+/g, ' ').trim();
      const t = norm(text);
      return t === norm(lastInsert.translated) || t === norm(lastInsert.inserted);
    },
    refresh() {
      if (!ST.site) hideFab();
    }
  };
})();
