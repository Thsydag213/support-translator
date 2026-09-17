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

  // ---------- Плавающая кнопка ----------
  function ensureFab() {
    if (fab) return fab;
    const host = ST.h('div', { [ST.UI_ATTR]: 'fab', class: 'st-fab-host' });
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        button{all:unset;cursor:pointer;display:flex;align-items:center;gap:4px;padding:3px 8px;border-radius:999px;
          background:#1a73e8;color:#fff;font:600 12px/18px system-ui,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.25);white-space:nowrap}
        button:hover{background:#1558b0}
        .lang{font-weight:500;opacity:.85}
      </style>
      <button type="button" title="Перевести введённый текст (Ctrl+Shift+Y)">🌐 Перевести <span class="lang"></span></button>`;
    shadow.querySelector('button').addEventListener('mousedown', (e) => {
      e.preventDefault(); // не забираем фокус у поля
      e.stopPropagation();
      if (lastField) open(lastField);
    });
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
    fab.shadowRoot.querySelector('.lang').textContent = expReply ? '→ ' + expReply.toUpperCase() + (exp.source === 'lock' ? ' 📌' : '') : '';
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
    .check code{font:12px/1.3 ui-monospace,Consolas,monospace;background:rgba(127,127,127,.18);padding:0 4px;border-radius:4px}
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
   * open(field, opts) — opts.onInserted() вызывается после вставки перевода (для защиты от отправки)
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
            <textarea id="orig"></textarea>
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
          <span class="hint">Ctrl+Enter — вставить · Esc — отмена · сообщение не отправляется автоматически</span>
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
      checks: $('checks'), err: $('err'), ok: $('ok'), spin: $('spin'), spinBack: $('spinBack'), lock: $('lock')
    };
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

    const state = { srcLang: '', seq: 0, backSeq: 0, spell: '', sameLang: false, politeTried: false, disabledLang: picked.disabled };
    panel = { host, field };

    function setError(msg) {
      ui.err.hidden = !msg;
      ui.err.textContent = msg ? '⚠ ' + msg : '';
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
      try {
        // Перевод ответа: в режиме «для всего» — сначала скачанный переводчик Chrome (язык оригинала определяем без облака),
        // затем облако. Подсказку опечаток даёт только облако.
        const mode = s.localTranslatorMode || 'all';
        const src = mode === 'all' ? await ST.detectSource(text) : { lang: '', guess: '' };
        if (mode === 'all' && !src.guess) {
          // Детекторы не справились — догадка по письменности: кириллица → язык операторов, латиница → английский
          const script = L.textScript(text).script;
          const opLang = (s.operatorLangs || []).find((l) => L.langScript(l) === script);
          src.guess = opLang || (script === 'Latin' ? 'en' : '');
        }
        const res = await ST.translate(text, 'auto', tl, {
          spell: !!s.spellCheck,
          local: mode === 'all',
          localSource: src.lang,
          localGuess: src.guess
        });
        if (my !== state.seq || !panel) return;
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
      doTranslate();
    });
    ui.lock.addEventListener('change', () => {
      if (ui.lock.checked) ST.langLock.set(ui.tl.value);
      else ST.langLock.clear();
    });

    async function confirm() {
      const text = ui.tr.value;
      if (!text.trim() || ui.ok.disabled) return;
      const originalNow = ST.getFieldText(field);
      const tl = ui.tl.value;
      close();
      ST.setFieldText(field, text);
      lastInsert = { field, original: originalNow, translated: ST.getFieldText(field), lang: tl };
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
    doTranslate();
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
    THEME_CSS,
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
    wasInserted(field, text) {
      return !!(lastInsert && lastInsert.field === field && lastInsert.translated.trim() === String(text).trim());
    },
    refresh() {
      if (!ST.site) hideFab();
    }
  };
})();
