(async function () {
  const L = globalThis.ST_LIB;
  const $ = (id) => document.getElementById(id);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const { settings: stored } = await chrome.storage.local.get('settings');
  const settings = L.mergeSettings(stored);

  $('enabled').checked = settings.enabled;
  $('enabled').addEventListener('change', async () => {
    const { settings: cur } = await chrome.storage.local.get('settings');
    const s = L.mergeSettings(cur);
    s.enabled = $('enabled').checked;
    await chrome.storage.local.set({ settings: s });
    refreshStatus();
  });

  async function send(msg) {
    try {
      return await chrome.tabs.sendMessage(tab.id, msg);
    } catch (e) {
      return null;
    }
  }

  async function refreshStatus() {
    const st = await send({ type: 'status' });
    if (!st) {
      $('siteName').textContent = 'Расширение не работает на этой странице';
      $('siteInfo').textContent = 'Служебная страница или вкладка открыта до установки — обновите её (F5).';
      return;
    }
    if (st.site) {
      $('siteName').textContent = '✅ ' + st.site.name;
      $('siteInfo').textContent =
        'Сообщений в окнах: ' + st.messages + (st.conversationLang ? ' · язык собеседника: ' + L.langName(st.conversationLang) : '');
    } else {
      $('siteName').textContent = '⚪ Правило для сайта не настроено';
      $('siteInfo').textContent = 'Нажмите «1. Окно чата», чтобы создать правило для этого сайта.';
    }
  }

  document.querySelectorAll('[data-pick]').forEach((b) =>
    b.addEventListener('click', async () => {
      await send({ type: 'pick', kind: b.dataset.pick });
      window.close();
    })
  );
  $('rescan').addEventListener('click', async () => {
    await send({ type: 'rescan' });
    window.close();
  });
  $('translateInput').addEventListener('click', async () => {
    await send({ type: 'command', command: 'translate-input' });
    window.close();
  });
  $('options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  const r = await chrome.runtime.sendMessage({ type: 'getStats' });
  const s = r && r.stats;
  const today = new Date().toISOString().slice(0, 10);
  if (s && s.date === today) {
    $('sReq').textContent = s.requests || 0;
    $('sChars').textContent = (s.chars || 0).toLocaleString('ru');
    $('sCache').textContent = s.cacheHits || 0;
    $('sErr').textContent = s.errors || 0;
    if (s.lastError) $('lastError').textContent = 'Последняя ошибка: ' + s.lastError;
  }

  refreshStatus();
})();
