(async function () {
  const L = globalThis.ST_LIB;
  const $ = (id) => document.getElementById(id);
  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const { settings: stored } = await chrome.storage.local.get('settings');
  const settings = L.mergeSettings(stored);

  $('enabled').checked = settings.enabled;
  $('enabled').addEventListener('change', async () => {
    const { settings: cur } = await chrome.storage.local.get('settings');
    const s = L.mergeSettings(cur);
    s.enabled = $('enabled').checked;
    await chrome.storage.local.set({ settings: s });
    setTimeout(refreshStatus, 300);
  });

  const bg = (msg) => chrome.runtime.sendMessage(msg);
  const tabCommand = (message) => bg({ type: 'tabCommand', tabId: tab.id, message });

  function tabOrigin() {
    try {
      const u = new URL(tab.url);
      if (!/^https?:$/.test(u.protocol)) return null;
      return { url: u, pattern: u.protocol + '//' + u.hostname + '/*', urlPattern: u.origin + '/*', name: u.hostname };
    } catch (e) {
      return null;
    }
  }

  async function refreshStatus() {
    $('connect').hidden = true;
    $('setupCard').hidden = true;
    const r = await bg({ type: 'tabStatus', tabId: tab.id });
    const frames = (r && r.frames) || [];
    const active = frames.filter((f) => f.site);

    if (active.length) {
      const f = active.find((x) => x.expectedLang) || active[0];
      const inFrame = active.every((x) => !x.top);
      $('siteName').textContent = '✅ ' + f.site.name + (inFrame ? ' (в iframe)' : '');
      const msgs = active.reduce((n, x) => n + (x.messages || 0), 0);
      const parts = ['Сообщений в окнах: ' + msgs];
      if (f.expectedLang) parts.push('язык собеседника: ' + L.langName(f.expectedLang) + (f.langSource === 'lock' ? ' 📌' : f.langSource === 'frame' ? ' (из письма)' : ''));
      parts.push('защита отправки: ' + (f.guard ? 'вкл' : 'выкл'));
      $('siteInfo').textContent = parts.join(' · ');
      // Самопроверка: проблемы из всех фреймов
      const hs = frames.map((x) => x.health).filter(Boolean);
      const issues = Array.from(new Set(hs.flatMap((h) => h.issues || [])));
      const box = $('health');
      box.textContent = '';
      box.hidden = !issues.length;
      box.classList.toggle('error', hs.some((h) => h.level === 'error'));
      for (const i of issues) {
        const li = document.createElement('li');
        li.textContent = i;
        box.appendChild(li);
      }
      $('setupCard').hidden = false;
      return;
    }

    if (!settings.enabled) {
      $('siteName').textContent = '⏸ Расширение выключено';
      $('siteInfo').textContent = '';
      return;
    }

    if (frames.length) {
      // скрипт есть (доступ выдан), но правило не подходит под URL
      $('siteName').textContent = '⚪ Доступ есть, правило не подходит под эту страницу';
      $('siteInfo').textContent = 'Проверьте «Шаблон URL» в настройках или настройте окна заново.';
      $('setupCard').hidden = false;
      return;
    }

    const o = tabOrigin();
    if (!o) {
      $('siteName').textContent = 'Служебная страница';
      $('siteInfo').textContent = 'Расширение работает только на http/https сайтах.';
      return;
    }
    const granted = await chrome.permissions.contains({ origins: [o.pattern] });
    if (granted) {
      $('siteName').textContent = '⚪ Доступ к ' + o.name + ' есть, но страница открыта раньше';
      $('siteInfo').textContent = 'Обновите страницу (F5).';
      return;
    }
    $('siteName').textContent = '⚪ Сайт не подключён';
    $('siteInfo').textContent = 'Расширение не читает этот сайт, пока вы его не подключите.';
    $('connect').hidden = false;
  }

  $('connect').addEventListener('click', async () => {
    const o = tabOrigin();
    if (!o) return;
    // Без await: permissions.request должен вызываться сразу в обработчике клика (user gesture).
    // Запись успеет завершиться, пока пользователь читает диалог.
    chrome.storage.session.set({ pendingConnect: { origin: o.pattern, urlPattern: o.urlPattern, name: o.name, tabId: tab.id } });
    // Popup может закрыться во время диалога — тогда подключение завершит service worker
    const granted = await chrome.permissions.request({ origins: [o.pattern] });
    if (!granted) {
      $('siteInfo').textContent = 'Доступ не выдан.';
      return;
    }
    await bg({ type: 'connectSite' });
    $('siteInfo').textContent = 'Подключено. Настраиваю…';
    setTimeout(refreshStatus, 800);
  });

  document.querySelectorAll('[data-pick]').forEach((b) =>
    b.addEventListener('click', async () => {
      await tabCommand({ type: 'pick', kind: b.dataset.pick });
      window.close();
    })
  );
  $('rescan').addEventListener('click', async () => {
    await tabCommand({ type: 'rescan' });
    window.close();
  });
  $('translateInput').addEventListener('click', async () => {
    await tabCommand({ type: 'command', command: 'translate-input' });
    window.close();
  });
  $('diag').addEventListener('click', async () => {
    $('diagOut').textContent = 'Собираю…';
    const r = await bg({ type: 'tabDiag', tabId: tab.id });
    if (!r || !r.ok) {
      $('diagOut').textContent = 'Не удалось: ' + ((r && r.error) || 'нет ответа');
      return;
    }
    const text = JSON.stringify(r.report, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      const frames = r.report.frames || [];
      const withRule = frames.filter((f) => f.rule);
      const msgs = withRule.reduce((n, f) => n + ((f.found && f.found.messagesUsed) || 0), 0);
      $('diagOut').textContent =
        '✅ Отчёт скопирован (без текста переписки). Фреймов: ' + frames.length +
        ', с правилом: ' + withRule.length + ', сообщений найдено: ' + msgs + '. Вставьте отчёт разработчику.';
    } catch (e) {
      $('diagOut').textContent = 'Не удалось скопировать: ' + e.message;
    }
  });

  $('options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  $('statsLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('stats/stats.html') });
  });

  const st = await bg({ type: 'getStats' });
  const d = st && st.today;
  if (d) {
    const sum = (o) => Object.values(o || {}).reduce((n, x) => n + x.n, 0);
    $('sIn').textContent = sum(d.incoming);
    $('sOut').textContent = sum(d.outgoing);
    $('sChars').textContent = (d.chars || 0).toLocaleString('ru');
    $('sGuard').textContent = d.guard ? d.guard.blocked : 0;
    const total = d.requests + d.cacheHits;
    $('sExtra').textContent = 'Запросов: ' + d.requests + ' · из кэша: ' + (total ? Math.round((d.cacheHits / total) * 100) : 0) + '% · ошибок: ' + d.errors;
    if (d.lastError) $('lastError').textContent = 'Последняя ошибка: ' + d.lastError;
  }

  refreshStatus();
})();
