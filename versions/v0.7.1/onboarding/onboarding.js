(function () {
  document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;
  const actions = {
    options: () => chrome.runtime.openOptionsPage(),
    shortcuts: () => chrome.runtime.sendMessage({ type: 'openShortcuts' }),
    close: () => window.close()
  };
  document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => actions[b.dataset.act]()));
})();
