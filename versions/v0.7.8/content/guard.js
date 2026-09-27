/*
 * Защита от отправки непереведённого текста.
 *
 * Перехватываем (в фазе capture, раньше обработчиков сайта):
 *   - Enter / Ctrl+Enter / Shift+Enter в поле ввода (по настройке sendKey правила);
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
  const verified = new Map(); // хэш текста -> тикет: язык проверен заранее, отправку не задерживаем
  const detectedFor = new Map(); // хэш текста -> { key: тикет, lang } — язык текста, определённый заранее

  function markVerified(text, lang) {
    verified.set(textHash(text), ST.ticketKey() + '|' + lang);
    if (verified.size > 200) verified.delete(verified.keys().next().value);
  }

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

  // Подпись кнопки/пункта меню, которая отправляет сообщение: «Send», «Send and close», «Отправить и закрыть»…
  const SEND_LABEL = /(^|[^a-zа-я])(send|reply|submit|отправ|ответ)/i;

  // Мгновенное определение языка латиницей по частым служебным словам — без сети и без ожидания.
  // Нужно в момент отправки: повторить отправку за оператора нельзя, поэтому ждать детектор некогда.
  // Возвращает язык, только если он явно преобладает (≥ 3 совпадений и вдвое больше, чем у ближайшего).
  const STOP = {
    en: 'the and you your to of is are we our for it this that have has will be please thank thanks with on in if can not what when would us my me there here just so any let know',
    es: 'el la los las de que y en un una es por para con su tu te lo le se no del al como más pero sus usted gracias hola nuestro nuestra está puede',
    pt: 'o a os as de que e em um uma é por para com seu sua você não do da dos das ao como mais mas obrigado olá nosso nossa está pode',
    fr: 'le la les de des que et en un une est pour avec votre vous nous ne pas du au comme plus mais merci bonjour notre il elle sur',
    de: 'der die das und ist sie ihr ihre wir nicht mit für auf dem den ein eine zu von bitte danke hallo unser unsere wird haben kann',
    it: 'il lo la gli le di che e in un una è per con il suo sua lei non del della al come più ma grazie ciao nostro nostra può'
  };
  const STOP_SETS = Object.fromEntries(Object.entries(STOP).map(([k, v]) => [k, new Set(v.split(' '))]));
  function quickLang(text) {
    const words = String(text).toLowerCase().replace(/https?:\/\/\S+|\S+@\S+/g, ' ').match(/[\p{L}']+/gu) || [];
    if (words.length < 4) return '';
    const score = {};
    for (const [lang, set] of Object.entries(STOP_SETS)) {
      score[lang] = 0;
      for (const w of words) if (set.has(w)) score[lang]++;
    }
    const sorted = Object.entries(score).sort((a, b) => b[1] - a[1]);
    const [best, n] = sorted[0];
    const second = sorted[1][1];
    return n >= 3 && n >= second * 2 ? best : '';
  }
  function isSendLabel(el) {
    // стрелка «Send ▾» только открывает меню — её не трогаем, иначе меню не открыть
    if (el.getAttribute('aria-haspopup') || el.getAttribute('aria-expanded')) return false;
    const label = (el.getAttribute('data-testid') || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' +
      (el.getAttribute('title') || '') + ' ' + (el.textContent || '').trim().slice(0, 60);
    return SEND_LABEL.test(label);
  }

  // Хэш текста без учёта переносов/пробелов: редактор после вставки может перестроить абзацы
  function textHash(text) {
    return L.hash(String(text).replace(/[\s ​]+/g, ' ').trim());
  }

  // --- повторная отправка после проверки ---
  function resend(ctx) {
    const h = textHash(ST.getFieldText(ctx.field));
    approved = { hash: h, until: Date.now() + 2000 };
    // Сайт может не принять программную отправку (игнорирует синтетические клики/Enter).
    // Если через секунду текст всё ещё в поле — разрешаем оператору отправить его сам, без повторной проверки.
    setTimeout(() => {
      if (!ctx.field.isConnected || textHash(ST.getFieldText(ctx.field)) !== h || !ST.getFieldText(ctx.field).trim()) return;
      approved = { hash: h, until: Date.now() + 60000, sticky: true };
      ST.toast('✔ Язык проверен — нажмите «Отправить» ещё раз');
    }, 1200);
    // Пункт меню («отправить и закрыть») сами не нажимаем: меню уже закрылось, а обычная кнопка
    // отправки сделала бы не то, что выбрал оператор — просто разрешаем отправку и просим нажать ещё раз
    if (ctx.noAuto) {
      approved = { hash: h, until: Date.now() + 60000, sticky: true };
      ST.toast('✔ Язык проверен — выберите действие отправки ещё раз', { duration: 7000 });
      return;
    }
    const button = ctx.kind === 'button'
      ? (ctx.button && ctx.button.isConnected ? ctx.button : ST.site.sendButtonSelector && ST.qsaSafe(ST.site.sendButtonSelector)[0])
      : null;
    if (button) {
      const o = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
      try {
        button.dispatchEvent(new PointerEvent('pointerdown', o));
        button.dispatchEvent(new MouseEvent('mousedown', o));
        button.dispatchEvent(new PointerEvent('pointerup', o));
        button.dispatchEvent(new MouseEvent('mouseup', o));
      } catch (e) { /* ignore */ }
      button.click();
      return;
    }
    const f = ctx.field;
    f.focus();
    const init = {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: 0,
      bubbles: true, cancelable: true, composed: true,
      ctrlKey: !!ctx.ctrl && !ST.isMac, metaKey: !!ctx.ctrl && ST.isMac, shiftKey: !!ctx.shift
    };
    const down = new KeyboardEvent('keydown', init);
    const notCancelled = f.dispatchEvent(down);
    f.dispatchEvent(new KeyboardEvent('keypress', Object.assign({}, init, { charCode: 13 })));
    f.dispatchEvent(new KeyboardEvent('keyup', init));
    // Сайт не обработал синтетический Enter (не отменил событие) и есть кнопка отправки — жмём её
    if (notCancelled && ctx.explicit && ST.site.sendButtonSelector) {
      try {
        const btn = ST.qsaSafe(ST.site.sendButtonSelector)[0];
        if (btn && ST.getFieldText(f).trim()) btn.click();
      } catch (e) { /* ignore */ }
    }
  }

  // Последнее решение защиты — для диагностики («почему не сработало»)
  const last = { at: 0, action: '', reason: '' };
  function note(action, reason) {
    last.at = Date.now();
    last.action = action;
    last.reason = reason;
  }

  // Ожидаемый язык ответа. Язык собеседника не определён (например, пишет по-английски — английский не переводится)
  // → ждём ответ на языке по умолчанию для ответов (английский): отвечать на языке операторов нельзя.
  function expectedFor(exp0) {
    const user = exp0.lang || '';
    const fb = ST.settings.replyFallbackLang || 'en';
    return Object.assign({}, exp0, { lang: L.replyTarget(ST.settings, user || fb), userLang: user, source: user ? exp0.source : 'default' });
  }

  // --- основной обработчик ---
  function intercept(e, ctx) {
    if (!enabled()) return note('pass', 'защита выключена или правило сайта не активно');
    if (dialog || ST.outgoing.isOpen()) return note('pass', 'открыта панель перевода или предупреждение');
    const field = ctx.field;
    if (!field) return note('pass', 'не найдено поле ввода (проверьте «Поле ввода» в правиле)');
    if (ST.isNoteMode(field)) return note('pass', 'режим заметки: ' + ST.noteModeInfo(field).reason);
    const text = ST.getFieldText(field).trim();
    if (!text) return note('pass', 'поле пустое');

    const h = textHash(text);
    if (approved && approved.hash === h && Date.now() < approved.until) {
      approved = null;
      return note('pass', 'отправка разрешена после проверки');
    }
    if (checking) {
      block(e);
      return note('block', 'идёт проверка');
    }
    if (letterCount(text) < ST.settings.guardMinLetters) return note('pass', 'короткое сообщение');
    if (ST.outgoing.wasInserted(field, text)) return note('pass', 'вставленный перевод');

    const exp0 = ST.expectedLang();
    // Клиент перешёл на английский (раньше писал на другом языке): отвечать можно на любом из двух — не задерживаем.
    // Останавливаем только текст другой письменности (например, кириллицу)
    if (exp0.source === 'switched') {
      const ts = L.textScript(text);
      const okScripts = [L.langScript(exp0.lang), L.langScript(exp0.prev)];
      if (!ts.script || ts.share < 0.6 || okScripts.includes(ts.script)) {
        return note('pass', 'клиент перешёл с ' + exp0.prev + ' на ' + exp0.lang + ' — защита не нужна');
      }
    }
    if (exp0.lang) {
      const exp = expectedFor(exp0);
      if (verified.get(h) === ST.ticketKey() + '|' + exp.lang) return note('pass', 'язык проверен заранее: ' + exp.lang);
      // Решаем СРАЗУ, без ожидания: повторить отправку за оператора нельзя (сайт не принимает программные нажатия,
      // меню «Отправить и закрыть» к этому моменту закрыто) — любая асинхронная проверка превращалась в «нажмите ещё раз».
      // 1) язык текста уже определён заранее и он другой — предупреждаем;
      const known = detectedFor.get(h);
      if (known && known.key === ST.ticketKey() && !L.sameLang(known.lang, exp.lang)) {
        block(e);
        note('warn', 'язык текста ' + known.lang + ' ≠ ' + exp.lang + ' (проверено заранее)');
        showWarning(ctx, text, exp, known.lang);
        return;
      }
      // 2) письменность не та (кириллица в испанском тикете) — предупреждаем;
      const ts = L.textScript(text);
      const expScript = L.langScript(exp.lang);
      if (expScript && ts.script && ts.share >= 0.6 && ts.script !== expScript) {
        block(e);
        note('warn', 'письменность ' + ts.script + ' ≠ ' + exp.lang);
        showWarning(ctx, text, exp, '');
        return;
      }
      // 3) письменность совпадает, а заранее язык не проверен — мгновенно по частым словам (английский макрос в испанском тикете)
      const q = quickLang(text);
      if (q && !L.sameLang(q, exp.lang)) {
        block(e);
        note('warn', 'язык текста ' + q + ' ≠ ' + exp.lang + ' (по частым словам)');
        showWarning(ctx, text, exp, q);
        return;
      }
      // 4) язык совпал или по тексту не понять — не задерживаем
      return note('pass', q ? 'язык текста совпадает (по частым словам): ' + q : 'письменность совпадает с ' + exp.lang + ', язык не понять — не задерживаем');
    }
    // Язык собеседника не определён — обычно клиент пишет по-английски (английский не переводится).
    // Текст той же письменности, что язык ответа по умолчанию (латиница для английского), не задерживаем:
    // повторную отправку сайт может не принять, и пришлось бы нажимать «Отправить» дважды.
    // Текст другой письменности (кириллица) останавливаем — это почти наверняка непереведённый ответ.
    const fbLang = expectedFor({ lang: '', source: '' }).lang;
    const tsNow = L.textScript(text);
    if (fbLang && tsNow.script && tsNow.share >= 0.6 && tsNow.script === L.langScript(fbLang)) {
      return note('pass', 'язык клиента не определён, текст на письменности языка по умолчанию (' + fbLang + ') — не задерживаем');
    }
    // Иначе блокируем и определяем язык собеседника по сообщениям тикета
    block(e);
    checking = true;
    ST.resolveConversationLang()
      .catch(() => ({ lang: '', source: '' }))
      .then((r) => {
        checking = false;
        const exp = expectedFor(r);
        if (verified.get(h) === ST.ticketKey() + '|' + exp.lang) {
          note('pass', 'язык проверен заранее: ' + exp.lang);
          return resend(ctx);
        }
        check(ctx, text, exp);
      });
  }

  // Событие уже заблокировано: сверяем язык текста с ожидаемым
  function check(ctx, text, exp) {
    const expScript = L.langScript(exp.lang);
    const ts = L.textScript(text);
    if (expScript && ts.script && ts.share >= 0.6 && ts.script !== expScript) {
      note('warn', 'письменность ' + ts.script + ' ≠ ' + exp.lang);
      showWarning(ctx, text, exp, '');
      return;
    }
    // та же письменность — уточняем язык асинхронно
    checking = true;
    detect(text, exp.lang)
      .then((lang) => {
        if (lang && L.sameLang(lang, exp.lang)) {
          note('pass', 'язык совпал: ' + lang);
          markVerified(text, exp.lang);
          resend(ctx);
        } else {
          note('warn', 'язык текста ' + (lang || '?') + ' ≠ ' + exp.lang);
          showWarning(ctx, text, exp, lang);
        }
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
      (!exp.userLang
        ? 'Язык собеседника не определён — ответ ожидается на: ' + L.langName(exp.lang) + ' (' + exp.lang + '). '
        : exp.userLang && !L.sameLang(exp.userLang, exp.lang)
        ? 'Собеседник пишет на: ' + L.langName(exp.userLang) + ' (' + exp.userLang + ') — язык выключен для ответов, отвечаем на: ' + L.langName(exp.lang) + ' (' + exp.lang + '). '
        : 'Собеседник пишет на: ' + L.langName(exp.lang) + ' (' + exp.lang + ')' + (exp.source === 'lock' ? ', язык закреплён' : '') + '. ') +
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

  // --- фоновая проверка, пока оператор печатает ---
  // Проверяем язык заранее (без облака: CLD и встроенный детектор). Тогда при отправке событие не блокируется
  // и сайт получает настоящий клик/Enter — программная повторная отправка многими сайтами игнорируется.
  let preTimer = null;
  function precheck(field, delay) {
    clearTimeout(preTimer);
    preTimer = setTimeout(async () => {
      if (!enabled() || !field.isConnected || ST.isNoteMode(field)) return;
      const text = ST.getFieldText(field).trim();
      if (!text || letterCount(text) < ST.settings.guardMinLetters) return;
      // заодно определяем язык собеседника по сообщениям тикета, чтобы при отправке он был уже известен
      const conv = ST.expectedLang().lang || (await ST.resolveConversationLang().catch(() => ({ lang: '' }))).lang;
      const exp = L.replyTarget(ST.settings, conv || ST.settings.replyFallbackLang || 'en');
      if (!exp|| verified.get(textHash(text)) === ST.ticketKey() + '|' + exp) return;
      const expScript = L.langScript(exp);
      const ts = L.textScript(text);
      if (expScript && ts.script && ts.share >= 0.6 && ts.script !== expScript) return;
      try {
        const d = await ST.detectSource(text);
        if (ST.getFieldText(field).trim() !== text) return; // текст успел измениться
        // Уверенный язык — запоминаем любой (другой язык → предупреждение при отправке без ожидания).
        // Неуверенная догадка засчитывается только в пользу ожидаемого языка
        const lang = d.lang || (d.guess && L.sameLang(d.guess, exp) ? d.guess : '');
        if (!lang) return;
        detectedFor.set(textHash(text), { key: ST.ticketKey(), lang });
        if (detectedFor.size > 200) detectedFor.delete(detectedFor.keys().next().value);
        if (L.sameLang(lang, exp)) markVerified(text, exp);
      } catch (e) { /* проверим при отправке */ }
    }, delay == null ? 500 : delay);
  }
  window.addEventListener('input', (e) => {
    const t = e.composedPath()[0];
    if (t && ST.site && ST.fieldAllowed(t)) precheck(ST.editableRoot(t));
  }, true);

  // Макросы и вставка редактором меняют поле без события input — следим за изменениями самого поля,
  // чтобы язык был проверен заранее и отправка не задерживалась
  let watched = null;
  const fieldObserver = new MutationObserver(() => { if (watched && watched.isConnected) precheck(watched); });
  document.addEventListener('focusin', (e) => {
    const t = e.composedPath ? e.composedPath()[0] : e.target;
    if (!ST.site || !t || !ST.fieldAllowed(t)) return;
    const f = ST.editableRoot(t);
    if (!f || f === watched) return;
    fieldObserver.disconnect();
    watched = f;
    fieldObserver.observe(f, { childList: true, subtree: true, characterData: true });
    precheck(f);
  }, true);
  // Наведение на кнопку отправки — последний шанс проверить язык до клика
  document.addEventListener('pointerover', (e) => {
    if (!ST.site || !ST.site.sendButtonSelector || !watched || !watched.isConnected) return;
    const t = e.composedPath ? e.composedPath()[0] : e.target;
    try {
      if (!t || !t.closest) return;
      // кнопка отправки, стрелка меню рядом с ней и пункты «Отправить и закрыть / отложить»
      const onSend = ST.closestDeep(t, ST.site.sendButtonSelector) || ST.closestDeep(t, '[data-testid*="send" i]');
      const item = !onSend && ST.closestDeep(t, 'button, [role="menuitem"], [role="option"], [role="button"]');
      if (onSend || (item && !ST.isOurNode(item) && SEND_LABEL.test((item.textContent || '').trim().slice(0, 60)))) precheck(watched, 0);
    } catch (err) { /* неверный селектор */ }
  }, true);

  // --- режим 'auto': обычный Enter не проверяется никогда ---
  // (0.5.4 пытался «заметить» отправку по Enter, но выбор макроса по Enter тоже очищает поле — это ломало Enter.
  //  Запомненное значение удаляем.)
  chrome.storage.local.remove('sendKeyLearned').catch(() => {});

  // Открыт выпадающий список у поля (макросы, упоминания, подсказки) — Enter выбирает пункт, а не отправляет
  function popupOpen(field) {
    if (!field) return false;
    if (field.getAttribute('aria-expanded') === 'true' || field.getAttribute('aria-activedescendant')) return true;
    const fr = field.getBoundingClientRect();
    let lists;
    try {
      lists = ST.qsa('[role="listbox"], [role="menu"], [data-tippy-root], [data-radix-popper-content-wrapper], [popover]');
    } catch (e) {
      return false;
    }
    return lists.some((el) => {
      if (ST.isOurNode(el) || ST.composedContains(el, field)) return false;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      // рядом с полем ввода (над ним или под ним) и по горизонтали пересекается с ним
      if (r.bottom < fr.top - 500 || r.top > fr.bottom + 300 || r.right <= fr.left || r.left >= fr.right) return false;
      // не постоянные панели страницы (список разговоров и т.п.) — всплывающие списки невысокие
      if (r.height > window.innerHeight * 0.6) return false;
      // всплывающий слой: сам или предок с position fixed/absolute
      for (let cur = el, i = 0; cur && cur.nodeType === 1 && i < 6; cur = cur.parentElement, i++) {
        const pos = getComputedStyle(cur).position;
        if (pos === 'fixed' || pos === 'absolute') return true;
      }
      return false;
    });
  }

  // --- перехватчики ---
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229 || e.altKey || !e.isTrusted) {
      // синтетический Enter от resend пропускаем, но "съедаем" одобрение
      if (!e.isTrusted && e.key === 'Enter' && approved && !approved.sticky) approved = null;
      return;
    }
    if (!enabled()) return;
    const sendKey = ST.site.sendKey || 'auto';
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    if (sendKey === 'none') return;
    const plain = !ctrl && !shift;
    // Сочетание из правила сайта; Ctrl/⌘+Enter проверяем всегда — им почти везде отправляют, а не переносят строку.
    // 'auto': обычный Enter не проверяем (перенос строки, выбор макроса). Остальные Enter тоже не трогаем.
    const explicit =
      (sendKey === 'enter' && plain) ||
      (sendKey === 'ctrl+enter' && ctrl && !shift) ||
      (sendKey === 'shift+enter' && shift && !ctrl);
    if (!explicit && !(ctrl && !shift)) return;
    const t = e.composedPath()[0];
    if (!ST.fieldAllowed(t)) return note('pass', 'Enter не в поле ввода из правила (проверьте «Поле ввода»)');
    if (popupOpen(ST.editableRoot(t))) return note('pass', 'открыт выпадающий список у поля (макросы/подсказки)');
    intercept(e, { kind: 'key', field: ST.editableRoot(t), ctrl, shift, explicit });
  }, true);

  window.addEventListener('click', (e) => {
    if (!enabled() || !ST.site.sendButtonSelector) return;
    if (!e.isTrusted) {
      if (approved && !approved.sticky) approved = null; // программный клик из resend
      return;
    }
    const t = e.composedPath()[0];
    let button = null;
    try {
      button = t && t.closest ? ST.closestDeep(t, ST.site.sendButtonSelector) : null;
    } catch (err) {
      return;
    }
    // «Отправить и закрыть», «Отправить и отложить» — пункты меню у кнопки отправки: селектор их не охватывает,
    // узнаём их по подписи. Отправку они тоже выполняют, значит проверять текст нужно.
    let menuSend = false;
    if (!button) {
      const item = ST.closestDeep(t, 'button, [role="menuitem"], [role="menuitemradio"], [role="option"], [role="button"]');
      if (item && !ST.isOurNode(item) && isSendLabel(item)) {
        button = item;
        menuSend = true;
      }
    }
    if (!button) return;
    // Селектор может указывать на обёртку с несколькими кнопками (отправка, эмодзи, вложения).
    // Берём реально нажатую кнопку; если в обёртке кнопок несколько — проверяем только кнопку отправки.
    const real = ST.closestDeep(t, 'button, [role="button"]');
    if (real && real !== button && ST.composedContains(button, real)) {
      const many = button.querySelectorAll('button, [role="button"]').length > 1;
      const hint = (real.getAttribute('data-testid') || '') + ' ' + (real.getAttribute('aria-label') || '') + ' ' + (real.textContent || '');
      if (many && !/send|submit|reply|отправ|ответ/i.test(hint)) return;
      button = real;
    }
    intercept(e, { kind: 'button', field: findField(), button, noAuto: menuSend });
  }, true);

  ST.guard = { closeDialog, quickLang, last: () => Object.assign({}, last) };
})();
