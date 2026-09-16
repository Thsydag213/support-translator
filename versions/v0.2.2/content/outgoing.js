/*
 * Исходящие сообщения: кнопка у поля ввода -> панель подтверждения перевода.
 * Оригинал | Перевод (редактируемый) | Обратный перевод для сверки смысла.
 * Ничего не отправляется автоматически: текст вставляется в поле только после подтверждения.
 */
(function () {
  const ST = globalThis.ST;
  if (ST.outgoing) return;
  const L = ST.L;

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
    const exp = ST.expectedLang();
    fab.shadowRoot.querySelector('.lang').textContent = exp.lang ? '→ ' + exp.lang.toUpperCase() + (exp.source === 'lock' ? ' 📌' : '') : '';
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

  window.addEventListener('scroll', () => fab && fab.style.display !== 'none' && placeFab(), true);
  window.addEventListener('resize', () => fab && fab.style.display !== 'none' && placeFab());

  // ---------- Панель подтверждения ----------
  const PANEL_CSS = `
    :host{all:initial}
    *{box-sizing:border-box}
    .wrap{position:fixed;z-index:2147483647;width:min(820px,calc(100vw - 24px));background:#fff;color:#202124;
      border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.28);font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;
      border:1px solid #dadce0;display:flex;flex-direction:column;max-height:calc(100vh - 24px)}
    header{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #eee;flex-wrap:wrap}
    header b{font-size:14px;margin-right:auto}
    select{font:inherit;padding:3px 6px;border:1px solid #dadce0;border-radius:6px;background:#fff;color:inherit}
    .lang{color:#5f6368}
    .lock{display:flex;align-items:center;gap:4px;color:#5f6368;font-size:12px;cursor:pointer;user-select:none}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:12px 14px;overflow:auto}
    @media (max-width:640px){.grid{grid-template-columns:1fr}}
    label.cap{display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#5f6368;margin-bottom:4px}
    textarea{width:100%;min-height:110px;resize:vertical;font:inherit;padding:8px 10px;border:1px solid #dadce0;border-radius:8px;color:inherit;background:#fff}
    textarea:focus{outline:2px solid #1a73e8;border-color:transparent}
    textarea.tr{background:#f1f6fe;border-color:#c6dafc}
    .back{grid-column:1/-1;background:#f8f9fa;border:1px dashed #dadce0;border-radius:8px;padding:8px 10px;white-space:pre-wrap;min-height:40px}
    .back mark{background:#fde293;border-radius:3px;padding:0 1px}
    .note{grid-column:1/-1;font-size:12px;color:#5f6368}
    .warn{grid-column:1/-1;background:#fef7e0;color:#7a4f01;border-radius:8px;padding:6px 10px}
    .err{grid-column:1/-1;background:#fce8e6;color:#a50e0e;border-radius:8px;padding:6px 10px}
    footer{display:flex;gap:8px;justify-content:flex-end;align-items:center;padding:10px 14px;border-top:1px solid #eee;flex-wrap:wrap}
    footer .hint{margin-right:auto;color:#5f6368;font-size:12px}
    button{font:600 13px/1 inherit;font-family:inherit;padding:8px 14px;border-radius:8px;border:1px solid #dadce0;background:#fff;color:#202124;cursor:pointer}
    button:hover{background:#f1f3f4}
    button.primary{background:#1a73e8;color:#fff;border-color:#1a73e8}
    button.primary:hover{background:#1558b0}
    button:disabled{opacity:.5;cursor:default}
    .x{border:none;padding:4px 8px;font-size:16px}
    .spin{color:#1a73e8}
    [hidden]{display:none!important}
  `;

  function langOptions(selected) {
    const codes = L.LANGS.slice();
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

  function pickTarget() {
    const exp = ST.expectedLang();
    return exp.lang || ST.state.conversationLang || (ST.site && ST.site.lastOutgoingLang) || ST.settings.fallbackOutgoingLang;
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
    const target = pickTarget();
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
          <div class="warn" id="warn" hidden></div>
          <div class="err" id="err" hidden></div>
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
    const ui = {
      orig: $('orig'), tr: $('tr'), tl: $('tl'), src: $('src'), back: $('back'), backLang: $('backLang'),
      warn: $('warn'), err: $('err'), ok: $('ok'), spin: $('spin'), spinBack: $('spinBack'), lock: $('lock')
    };
    ui.orig.value = original;
    ui.lock.checked = locked;

    // позиционирование над полем ввода (или под ним, если сверху нет места)
    const r = field.getBoundingClientRect();
    const w = Math.min(820, window.innerWidth - 24);
    wrap.style.left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w / 2)) + 'px';
    if (r.top > window.innerHeight / 2) wrap.style.bottom = Math.max(12, window.innerHeight - r.top + 8) + 'px';
    else wrap.style.top = Math.min(window.innerHeight - 200, r.bottom + 8) + 'px';

    // события клавиатуры не должны уходить сайту (иначе Enter может отправить сообщение)
    for (const type of ['keydown', 'keyup', 'keypress', 'input', 'paste', 'copy', 'cut']) {
      host.addEventListener(type, (e) => e.stopPropagation());
    }

    const state = { srcLang: '', seq: 0, backSeq: 0 };
    panel = { host, field };

    function setError(msg) {
      ui.err.hidden = !msg;
      ui.err.textContent = msg ? '⚠ ' + msg : '';
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
        const b = await ST.translate(text, ui.tl.value, backLang);
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
        return;
      }
      ui.spin.hidden = false;
      try {
        const res = await ST.translate(text, 'auto', tl);
        if (my !== state.seq || !panel) return;
        state.srcLang = res.detectedLang;
        ui.src.textContent = L.langName(res.detectedLang) + ' (' + res.detectedLang + ')';
        ui.tr.value = res.translation;
        const same = L.sameLang(res.detectedLang, tl);
        ui.warn.hidden = !same;
        ui.warn.textContent = same ? 'Текст уже на языке «' + L.langName(tl) + '». Проверьте, правильно ли выбран язык собеседника.' : '';
        ui.ok.disabled = false;
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
      tTr = setTimeout(doBack, 700);
    });
    ui.tl.addEventListener('change', () => {
      if (ui.lock.checked) ST.langLock.set(ui.tl.value);
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

  async function rememberLang(tl) {
    if (!ST.site) return;
    try {
      const { settings } = await chrome.storage.local.get('settings');
      const all = L.mergeSettings(settings);
      const rule = all.sites.find((x) => x.id === ST.site.id);
      if (rule && rule.lastOutgoingLang !== tl) {
        rule.lastOutgoingLang = tl;
        await ST.saveSettings(all);
      }
    } catch (e) { /* ignore */ }
  }

  function restoreOriginal() {
    if (!lastInsert || !lastInsert.field.isConnected) return;
    ST.setFieldText(lastInsert.field, lastInsert.original);
    lastInsert = null;
  }

  ST.outgoing = {
    open,
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
