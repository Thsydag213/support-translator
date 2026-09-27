/*
 * Палитра команд: все действия расширения в одном списке с поиском.
 * Открывается кнопкой «⋯» у поля ввода, из меню расширения или своим сочетанием клавиш
 * (chrome://extensions/shortcuts → «Палитра команд»). ↑↓ — выбор, Enter — выполнить, Esc — закрыть.
 */
(function () {
  const ST = globalThis.ST;
  if (ST.palette) return;
  const L = ST.L;

  let host = null;

  function field() {
    return ST.outgoing.activeField();
  }

  function commands() {
    const list = [];
    const add = (icon, title, hint, run, keywords) => list.push({ icon, title, hint: hint || '', run, keywords: keywords || '' });
    const needField = (fn) => () => {
      const f = field();
      if (!f) return ST.toast('Сначала поставьте курсор в поле ответа', { error: true });
      fn(f);
    };

    add('🌐', 'Перевести ответ', 'с панелью подтверждения', needField((f) => ST.outgoing.open(f)), 'translate reply перевод');
    add('⚡', 'Перевести и сразу вставить', 'без панели', needField((f) => ST.outgoing.quick(f)), 'quick быстро');
    if (ST.settings.assist !== false && ST.assist) {
      for (const [mode, m] of Object.entries(ST.assist.MODES)) {
        add(m.label.split(' ')[0], m.label.replace(/^\S+\s/, '') + ' и перевести', 'локальная модель Chrome', needField((f) => ST.outgoing.open(f, { assist: mode })), 'rewrite модель ' + mode);
      }
      add('🧠', 'Кратко о тикете', 'что хочет клиент, тема, макросы', () => ST.assist.openTicketPanel(), 'summary пересказ тема');
    }
    const exp = ST.expectedLang();
    const lock = ST.langLock.get();
    if (lock) add('📌', 'Снять закрепление языка', 'сейчас: ' + L.langName(lock), () => { ST.langLock.clear(); ST.toast('Закрепление снято'); }, 'unlock lock');
    for (const code of ST.settings.replyLangs || []) {
      if (lock && L.sameLang(lock, code)) continue;
      add('📌', 'Отвечать на: ' + L.langName(code), code + (exp.lang && L.sameLang(exp.lang, code) ? ' · язык клиента' : ''), () => { ST.langLock.set(code); ST.toast('Язык ответа для тикета: ' + L.langName(code)); }, 'lock язык ' + code);
    }
    add('↻', 'Перевести окно заново', '', () => ST.incoming.rescan(), 'rescan');
    add('🩺', 'Скопировать диагностику', 'для отчёта о проблеме', async () => {
      const r = await ST.send({ type: 'selfDiag' }).catch((e) => ({ ok: false, error: e.message }));
      if (!r || !r.ok) return ST.toast('Не удалось собрать отчёт: ' + ((r && r.error) || ''), { error: true });
      await navigator.clipboard.writeText(JSON.stringify(r.report, null, 2)).catch(() => {});
      ST.toast('Отчёт скопирован — пришлите его в чат');
    }, 'diag отчёт');
    add('⚙', 'Настройки', '', () => ST.send({ type: 'openOptions' }), 'options settings');
    add('⌨', 'Назначить сочетания клавиш', 'для палитры, перевода, быстрой вставки', () => ST.send({ type: 'openShortcuts' }), 'shortcuts hotkey');
    add('🎓', 'Как пользоваться', 'короткий тур по расширению', () => ST.send({ type: 'openOnboarding' }), 'help тур onboarding');
    return list;
  }

  function close() {
    if (host) host.remove();
    host = null;
  }

  function open() {
    if (!ST.site) return ST.toast('Для этого сайта не настроено правило перевода', { error: true });
    close();
    const all = commands();
    host = ST.h('div', { [ST.UI_ATTR]: 'palette' });
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host{all:initial}
        ${ST.outgoing.THEME_CSS}
        .box{position:fixed;z-index:2147483647;left:50%;top:14vh;transform:translateX(-50%);width:min(520px,calc(100vw - 24px));
          background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow);
          font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;overflow:hidden}
        input{all:unset;box-sizing:border-box;width:100%;padding:12px 14px;font-size:14px;border-bottom:1px solid var(--line)}
        ul{list-style:none;margin:0;padding:6px;max-height:min(420px,60vh);overflow:auto}
        li{display:flex;gap:10px;align-items:center;padding:7px 10px;border-radius:8px;cursor:pointer}
        li.sel{background:var(--hover)}
        .i{width:20px;text-align:center}
        .h{margin-left:auto;color:var(--muted);font-size:12px}
        .empty{padding:12px;color:var(--muted)}
      </style>
      <div class="box" role="dialog" aria-label="Команды Support Translator">
        <input id="q" placeholder="Команда… (перевести, кратко, язык, диагностика)" autocomplete="off">
        <ul id="list" role="listbox"></ul>
      </div>`;
    document.documentElement.appendChild(host);
    const box = shadow.querySelector('.box');
    if (ST.uiDark(field() || document.body)) box.classList.add('dark');
    const q = shadow.getElementById('q');
    const ul = shadow.getElementById('list');
    let shown = all;
    let sel = 0;

    const render = () => {
      ul.textContent = '';
      if (!shown.length) {
        ul.appendChild(ST.h('div', { class: 'empty' }, 'Ничего не найдено'));
        return;
      }
      shown.forEach((c, i) => {
        const li = ST.h('li', { class: i === sel ? 'sel' : '', role: 'option' },
          ST.h('span', { class: 'i' }, c.icon), ST.h('span', {}, c.title), ST.h('span', { class: 'h' }, c.hint));
        li.addEventListener('mousedown', (e) => { e.preventDefault(); run(c); });
        li.addEventListener('mousemove', () => { if (sel !== i) { sel = i; render(); } });
        ul.appendChild(li);
      });
      const cur = ul.children[sel];
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
    };
    const run = (c) => {
      close();
      try { c.run(); } catch (e) { ST.toast('Команда не выполнена: ' + e.message, { error: true }); }
    };
    q.addEventListener('input', () => {
      const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
      shown = all.filter((c) => {
        const hay = (c.title + ' ' + c.hint + ' ' + c.keywords).toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      sel = 0;
      render();
    });
    // Клавиши не должны уходить сайту (Enter отправил бы сообщение)
    for (const type of ['keydown', 'keyup', 'keypress', 'input', 'paste']) host.addEventListener(type, (e) => e.stopPropagation());
    shadow.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (shown[sel]) run(shown[sel]); }
    });
    q.addEventListener('blur', () => setTimeout(() => { if (host && !shadow.activeElement) close(); }, 150));
    render();
    q.focus();
  }

  ST.palette = { open, close, isOpen: () => !!host };
})();
