/*
 * Защита от отправки непереведённого текста.
 *
 * Перехватываем (в фазе capture, раньше обработчиков сайта):
 *   - Enter / Ctrl+Enter в поле ввода (по настройке sendKey правила);
 *   - клик по кнопке отправки (sendButtonSelector).
 *
 * Логика:
 *   1. Язык собеседника неизвестен, текст короткий, или это ровно вставленный нами перевод → пропускаем.
 *   2. Письменность текста не совпадает с письменностью языка собеседника (кириллица vs латиница) →
 *      блокируем сразу, показываем предупреждение.
 *   3. Письменность совпадает → блокируем, асинхронно определяем язык (CLD, затем Google);
 *      язык совпал → повторяем отправку сами; не совпал → предупреждение.
 *
 * Предупреждение: [🌐 Перевести] [Отправить как есть] [Отмена].
 */
(function () {
  const ST = globalThis.ST;
  if (ST.guard) return;
  const L = ST.L;

  let approved = null; // { hash, until } — следующая отправка этого текста разрешена
  let dialog = null;
  let checking = false;

  function enabled() {
    return !!(ST.site && ST.settings.enabled && ST.site.sendGuard !== false && ST.alive());
  }

  function letterCount(text) {
    return (String(text).replace(/https?:\/\/\S+/g, '').match(/\p{L}/gu) || []).length;
  }

  function findField() {
    const a = ST.deepActiveElement();
    if (a && ST.fieldAllowed(a)) return ST.editableRoot(a);
    const last = ST.outgoing.lastField();
    if (last) return last;
    const sel = ST.site && ST.site.inputSelector;
    if (!sel) return null;
    try {
      const all = ST.qsa(sel).filter((el) => el.getClientRects().length > 0);
      return ST.editableRoot(all[0]) || null;
    } catch (e) {
      return null;
    }
  }

  function block(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  // --- повторная отправка после проверки ---
  function resend(ctx) {
    approved = { hash: L.hash(ST.getFieldText(ctx.field).trim()), until: Date.now() + 2000 };
    if (ctx.kind === 'button' && ctx.button && ctx.button.isConnected) {
      ctx.button.click();
      return;
    }
    const f = ctx.field;
    f.focus();
    const init = {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: 0,
      bubbles: true, cancelable: true, composed: true,
      ctrlKey: ctx.ctrl, metaKey: false
    };
    const down = new KeyboardEvent('keydown', init);
    const notCancelled = f.dispatchEvent(down);
    f.dispatchEvent(new KeyboardEvent('keypress', Object.assign({}, init, { charCode: 13 })));
    f.dispatchEvent(new KeyboardEvent('keyup', init));
    // Сайт не обработал синтетический Enter (не отменил событие) и есть кнопка отправки — жмём её
    if (notCancelled && ST.site.sendButtonSelector) {
      try {
        const btn = ST.qsaSafe(ST.site.sendButtonSelector)[0];
        if (btn && ST.getFieldText(f).trim()) btn.click();
      } catch (e) { /* ignore */ }
    }
  }

  // --- основной обработчик ---
  function intercept(e, ctx) {
    if (!enabled()) return;
    if (dialog || ST.outgoing.isOpen()) return;
    const field = ctx.field;
    if (!field) return;
    if (ST.isNoteMode(field)) return; // внутренняя заметка для коллег — не проверяем
    const text = ST.getFieldText(field).trim();
    if (!text) return;

    const h = L.hash(text);
    if (approved && approved.hash === h && Date.now() < approved.until) {
      approved = null;
      return; // разрешённая отправка
    }
    if (checking) {
      block(e);
      return;
    }

    const exp = ST.expectedLang();
    if (!exp.lang) return;
    if (letterCount(text) < ST.settings.guardMinLetters) return;
    if (ST.outgoing.wasInserted(field, text)) return;

    const expScript = L.langScript(exp.lang);
    const ts = L.textScript(text);
    block(e);

    if (expScript && ts.script && ts.share >= 0.6 && ts.script !== expScript) {
      showWarning(ctx, text, exp, '');
      return;
    }

    // та же письменность — уточняем язык асинхронно
    checking = true;
    detect(text, exp.lang)
      .then((lang) => {
        if (lang && L.sameLang(lang, exp.lang)) resend(ctx);
        else showWarning(ctx, text, exp, lang);
      })
      .catch(() => showWarning(ctx, text, exp, ''))
      .finally(() => { checking = false; });
  }

  async function detect(text, expected) {
    // Сначала без облака: CLD и встроенный детектор Chrome; облако — только если они не уверены
    const d = await ST.detectSource(text);
    if (d.lang) return d.lang;
    try {
      const r = await ST.translate(text, 'auto', expected);
      return r.detectedLang;
    } catch (e) {
      return d.guess || ''; // облако недоступно — неуверенная догадка лучше, чем ничего
    }
  }

  // --- диалог предупреждения ---
  function closeDialog() {
    if (dialog) dialog.remove();
    dialog = null;
  }

  function showWarning(ctx, text, exp, detected) {
    closeDialog();
    ST.track({ kind: 'guard', action: 'blocked' });
    const SCRIPT_NAMES = { Cyrillic: 'кириллица', Latin: 'латиница', Arabic: 'арабское письмо', CJK: 'иероглифы', Hangul: 'хангыль', Hebrew: 'иврит', Greek: 'греческое письмо' };
    const script = L.textScript(text).script;
    const host = ST.h('div', { [ST.UI_ATTR]: 'guard' });
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host{all:initial}
        ${ST.outgoing.THEME_CSS}
        .box{position:fixed;z-index:2147483647;width:min(440px,calc(100vw - 24px));background:var(--bg);color:var(--fg);border-radius:12px;
          border:1px solid var(--warnfg);box-shadow:var(--shadow);font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;padding:14px}
        b{display:block;font-size:14px;margin-bottom:6px;color:var(--warnfg)}
        p{margin:0 0 12px;color:var(--fg)}
        .row{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
        button{font:600 13px/1 system-ui,sans-serif;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--fg);cursor:pointer}
        button:hover{background:var(--hover)}
        button.primary{background:var(--accent);border-color:var(--accent);color:var(--bg)}
        button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
      </style>
      <div class="box" role="alertdialog" aria-label="Сообщение не переведено">
        <b>⚠ Похоже, сообщение не переведено</b>
        <p id="msg"></p>
        <div class="row">
          <button id="cancel">Отмена</button>
          <button id="asis">Отправить как есть</button>
          <button id="tr" class="primary">🌐 Перевести</button>
        </div>
      </div>`;
    const $ = (id) => shadow.getElementById(id);
    $('msg').textContent =
      'Собеседник пишет на: ' + L.langName(exp.lang) + ' (' + exp.lang + ')' + (exp.source === 'lock' ? ', язык закреплён' : '') + '. ' +
      'Ваш текст: ' + (detected ? L.langName(detected) + ' (' + detected + ')' : SCRIPT_NAMES[script] || 'другой язык') + '.';

    document.documentElement.appendChild(host);
    dialog = host;

    const box = shadow.querySelector('.box');
    if (ST.uiDark(ctx.field)) box.classList.add('dark');
    const r = ctx.field.getBoundingClientRect();
    box.style.left = Math.max(12, Math.min(window.innerWidth - 452, r.right - 440)) + 'px';
    if (r.top > 200) box.style.bottom = window.innerHeight - r.top + 8 + 'px';
    else box.style.top = r.bottom + 8 + 'px';

    for (const type of ['keydown', 'keyup', 'keypress']) host.addEventListener(type, (e) => e.stopPropagation());
    host.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeDialog();
        ctx.field.focus();
      }
    });

    $('cancel').addEventListener('click', () => { closeDialog(); ctx.field.focus(); });
    $('asis').addEventListener('click', () => {
      closeDialog();
      ST.track({ kind: 'guard', action: 'sentAsIs' });
      resend(ctx);
    });
    $('tr').addEventListener('click', () => {
      closeDialog();
      ST.track({ kind: 'guard', action: 'translated' });
      ST.outgoing.open(ctx.field);
    });
    $('tr').focus();
  }

  // --- перехватчики ---
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.shiftKey || e.altKey || !e.isTrusted) {
      // синтетический Enter от resend пропускаем, но "съедаем" одобрение
      if (!e.isTrusted && e.key === 'Enter' && approved) approved = null;
      return;
    }
    if (!enabled()) return;
    const sendKey = ST.site.sendKey || 'enter';
    const ctrl = e.ctrlKey || e.metaKey;
    if (sendKey === 'none' || (sendKey === 'enter' && ctrl) || (sendKey === 'ctrl+enter' && !ctrl)) return;
    const t = e.composedPath()[0];
    if (!ST.fieldAllowed(t)) return;
    intercept(e, { kind: 'key', field: ST.editableRoot(t), ctrl: sendKey === 'ctrl+enter' });
  }, true);

  window.addEventListener('click', (e) => {
    if (!enabled() || !ST.site.sendButtonSelector) return;
    if (!e.isTrusted) {
      if (approved) approved = null; // программный клик из resend
      return;
    }
    const t = e.composedPath()[0];
    let button = null;
    try {
      button = t && t.closest ? ST.closestDeep(t, ST.site.sendButtonSelector) : null;
    } catch (err) {
      return;
    }
    if (!button) return;
    intercept(e, { kind: 'button', field: findField(), button });
  }, true);

  ST.guard = { closeDialog };
})();
