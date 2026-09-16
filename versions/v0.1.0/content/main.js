/*
 * Точка входа content script: загрузка настроек, запуск модулей, реакция на изменения и команды.
 */
(function () {
  const ST = globalThis.ST;
  if (ST.started) return;
  ST.started = true;

  // Подпись настроек, влияющих на уже отрисованные переводы
  function renderSignature(s) {
    const site = ST.site;
    return JSON.stringify([
      s.enabled, s.targetLang, s.skipLangs, s.displayMode, s.minChars,
      site && [site.id, site.urlPattern, site.containerSelector, site.messageSelector]
    ]);
  }

  let sig = '';

  async function apply() {
    await ST.loadSettings();
    const next = renderSignature(ST.settings);
    if (next === sig) {
      ST.outgoing.refresh();
      return;
    }
    const firstRun = sig === '';
    sig = next;
    if (!firstRun) ST.incoming.reset();
    ST.outgoing.refresh();
    if (ST.site) {
      ST.log('Активно правило:', ST.site.name);
      ST.incoming.start();
    } else {
      ST.incoming.stop();
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) apply();
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg && msg.type) {
      case 'command':
        if (msg.command === 'translate-input') ST.outgoing.openForActive();
        if (msg.command === 'retranslate-page') ST.incoming.rescan();
        break;
      case 'pick':
        ST.picker.run(msg.kind);
        break;
      case 'rescan':
        ST.incoming.rescan();
        break;
      case 'status':
        sendResponse({
          site: ST.site ? { id: ST.site.id, name: ST.site.name } : null,
          messages: ST.site ? ST.incoming.countMessages() : 0,
          conversationLang: ST.state.conversationLang
        });
        return;
    }
    sendResponse({ ok: true });
  });

  // SPA-навигация: URL мог смениться без перезагрузки страницы
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      ST.state.conversationLang = '';
      sig = '';
      apply();
    }
  }, 1000);

  apply();
})();
