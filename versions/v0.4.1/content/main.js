/*
 * Точка входа content script: загрузка настроек, запуск модулей, реакция на изменения и команды.
 * Выполняется в каждом фрейме вкладки, к домену которого выдан доступ.
 */
(function () {
  const ST = globalThis.ST;
  if (ST.started) return;
  ST.started = true;

  // Подпись настроек, влияющих на уже отрисованные переводы
  function renderSignature(s) {
    const site = ST.site;
    return JSON.stringify([
      s.enabled, s.targetLang, s.skipLangs, s.displayMode, s.minChars, s.glossary, s.listBadges, s.listBadgesUseNetwork,
      s.onlyVisible, s.localTranslatorMode,
      site && [site.id, site.urlPattern, site.containerSelector, site.messageSelector, site.insertMode, site.listItemSelector, site.subjectSelector,
        site.userMessageSelector, site.agentMessages]
    ]);
  }

  let sig = '';

  async function apply() {
    if (ST.dead) return;
    try {
      await ST.loadSettings();
    } catch (e) {
      return;
    }
    const next = renderSignature(ST.settings);
    if (next === sig) {
      ST.outgoing.refresh();
      reportHealth(true);
      return;
    }
    const firstRun = sig === '';
    sig = next;
    if (!firstRun) ST.incoming.reset();
    ST.outgoing.refresh();
    if (ST.site) {
      ST.log('Активно правило:', ST.site.name, ST.isTop ? '' : '(iframe ' + location.host + ')');
      ST.incoming.start();
    } else {
      ST.incoming.stop();
    }
    reportHealth(true);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || ST.dead) return;
    if (changes.settings) apply();
    if (changes.langLocks) ST.langLock._cache = changes.langLocks.newValue || {};
  });

  // Команда относится к этому фрейму, если фокус именно в нём (а не во вложенном iframe)
  function focusedHere() {
    return document.hasFocus() && !(document.activeElement && document.activeElement.tagName === 'IFRAME');
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg && msg.type) {
      case 'command':
        if (msg.command === 'translate-input' && focusedHere()) ST.outgoing.openForActive();
        if (msg.command === 'retranslate-page') ST.incoming.rescan();
        break;
      case 'pick':
        ST.picker.run(msg.kind);
        break;
      case 'pickCancel':
        ST.picker.cancel();
        break;
      case 'rescan':
        ST.incoming.rescan();
        break;
      case 'frameLang':
        // Язык собеседника, найденный в другом фрейме вкладки (например, письмо во встроенном iframe)
        ST.state.frameLang = { lang: msg.lang, at: Date.now() };
        break;
      case 'diag':
        try {
          sendResponse(ST.diagnose());
        } catch (e) {
          sendResponse({ frame: ST.isTop ? 'top' : 'iframe', error: String(e && e.message) });
        }
        return;
      case 'status': {
        const exp = ST.site ? ST.expectedLang() : { lang: '', source: '' };
        sendResponse({
          top: ST.isTop,
          url: location.href,
          site: ST.site ? { id: ST.site.id, name: ST.site.name } : null,
          messages: ST.incoming.countMessages(),
          expectedLang: exp.lang,
          langSource: exp.source,
          guard: !!(ST.site && ST.site.sendGuard !== false),
          health: lastHealth
        });
        return;
      }
    }
    sendResponse({ ok: true });
  });

  // SPA-навигация: URL мог смениться без перезагрузки страницы
  let lastUrl = location.href;
  setInterval(() => {
    if (ST.dead) return;
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      ST.state.conversationLang = '';
      ST.state.frameLang = null;
      ST.state.navAt = Date.now();
      sig = '';
      apply();
    }
  }, 1000);

  // ---------- Самопроверка: значок на иконке расширения ----------
  let lastHealth = null;
  let lastHealthKey = '';
  function reportHealth(force) {
    if (ST.dead || !ST.alive()) return;
    if (document.visibilityState === 'hidden' && !force) return;
    let h = null;
    try {
      h = ST.incoming.health();
    } catch (e) {
      h = null;
    }
    lastHealth = h;
    const key = JSON.stringify(h);
    if (!force && key === lastHealthKey) return;
    lastHealthKey = key;
    ST.send({ type: 'health', health: h }).catch(() => {});
  }
  setInterval(() => reportHealth(false), 5000);

  ST.send({ type: 'hello' }).catch(() => {});
  apply();
})();
