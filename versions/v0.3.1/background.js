/*
 * Service worker (MV3).
 *  - единственное место, откуда идут сетевые запросы к переводчику;
 *  - регистрирует content scripts ТОЛЬКО на доменах, к которым пользователь выдал доступ;
 *  - ведёт реестр фреймов вкладок (чат может быть в iframe) и рассылает им команды;
 *  - собирает статистику.
 */
import './lib/defaults.js';
import './lib/providers.js';
import './lib/glossary.js';
import './lib/stats.js';
import './lib/translator.js';

const L = globalThis.ST_LIB;
const STATS = globalThis.ST_STATS;

const SCRIPT_ID = 'st-main';
const CS_JS = [
  'lib/defaults.js',
  'lib/checks.js',
  'content/core.js',
  'content/styles.js',
  'content/incoming.js',
  'content/outgoing.js',
  'content/guard.js',
  'content/picker.js',
  'content/diag.js',
  'content/main.js'
];
// Стили подключаются из content/styles.js (в документ и в shadow root)

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return L.mergeSettings(settings);
}

// ---------------------------------------------------------------------------
// Регистрация content scripts по выданным доступам
// ---------------------------------------------------------------------------
async function grantedOrigins(settings) {
  const wanted = new Set();
  for (const rule of settings.sites) for (const o of L.ruleOrigins(rule)) wanted.add(o);
  const out = [];
  for (const o of wanted) {
    try {
      if (await chrome.permissions.contains({ origins: [o] })) out.push(o);
    } catch (e) { /* невалидный шаблон */ }
  }
  return out.sort();
}

let syncChain = Promise.resolve();
function syncContentScripts(force) {
  syncChain = syncChain.then(() => doSync(force)).catch((e) => console.warn('[sync]', e));
  return syncChain;
}

async function doSync(force) {
  const settings = await getSettings();
  const origins = await grantedOrigins(settings);
  const key = JSON.stringify(origins);
  const { registeredKey } = await chrome.storage.session.get('registeredKey');
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (!force && registeredKey === key && (existing.length > 0) === (origins.length > 0)) return;

  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  if (origins.length) {
    await chrome.scripting.registerContentScripts([{
      id: SCRIPT_ID,
      matches: origins,
      js: CS_JS,
      runAt: 'document_idle',
      allFrames: true,
      matchOriginAsFallback: true,
      persistAcrossSessions: true
    }]);
  }
  await chrome.storage.session.set({ registeredKey: key });

  // В уже открытые вкладки скрипты не попадут сами — внедряем
  if (origins.length) {
    const tabs = await chrome.tabs.query({ url: origins });
    for (const t of tabs) await injectTab(t.id);
  }
}

async function injectTab(tabId) {
  const run = async (allFrames) => {
    await chrome.scripting.executeScript({ target: { tabId, allFrames }, files: CS_JS });
  };
  try {
    await run(true);
  } catch (e) {
    try { await run(false); } catch (e2) { /* нет доступа к вкладке */ }
  }
}

// Подключение сайта из popup: popup кладёт pendingConnect и запрашивает доступ.
// Popup может закрыться во время диалога разрешения — поэтому завершаем здесь.
// Вызывается и из popup, и из permissions.onAdded — выполняем строго по очереди, чтобы не создать правило дважды.
let connectChain = Promise.resolve();
function finishConnect() {
  const p = connectChain.then(doFinishConnect);
  connectChain = p.catch(() => {});
  return p;
}

async function doFinishConnect() {
  const { pendingConnect } = await chrome.storage.session.get('pendingConnect');
  if (!pendingConnect) return { ok: false, error: 'нет запроса на подключение' };
  const granted = await chrome.permissions.contains({ origins: [pendingConnect.origin] });
  if (!granted) return { ok: false, error: 'доступ не выдан' };

  const settings = await getSettings();
  let rule = settings.sites.find((s) => L.ruleOrigins(s).includes(pendingConnect.origin));
  if (!rule) {
    rule = Object.assign({}, L.SITE_DEFAULTS, {
      id: 'site-' + Date.now().toString(36),
      name: pendingConnect.name,
      urlPattern: pendingConnect.urlPattern
    });
    settings.sites.push(rule);
    await chrome.storage.local.set({ settings });
  }
  await chrome.storage.session.remove('pendingConnect');
  await syncContentScripts(true);
  if (pendingConnect.tabId) await injectTab(pendingConnect.tabId);
  return { ok: true, rule: { id: rule.id, name: rule.name } };
}

// ---------------------------------------------------------------------------
// Реестр фреймов: content script каждого фрейма сообщает о себе
// ---------------------------------------------------------------------------
async function getFrames(tabId) {
  const k = 'frames:' + tabId;
  const got = await chrome.storage.session.get(k);
  return got[k] || [];
}
async function addFrame(tabId, frameId) {
  const k = 'frames:' + tabId;
  const list = await getFrames(tabId);
  if (!list.includes(frameId)) {
    list.push(frameId);
    await chrome.storage.session.set({ [k]: list });
  }
}

async function broadcast(tabId, msg) {
  const frames = await getFrames(tabId);
  const ids = frames.length ? frames : [0];
  const results = await Promise.all(ids.map((frameId) =>
    chrome.tabs.sendMessage(tabId, msg, { frameId }).then((r) => ({ frameId, r }), () => ({ frameId, r: undefined }))
  ));
  // Отвалившиеся фреймы (навигация) убираем из реестра
  const alive = results.filter((x) => x.r !== undefined).map((x) => x.frameId);
  if (frames.length && alive.length !== frames.length) {
    await chrome.storage.session.set({ ['frames:' + tabId]: alive });
  }
  return results.filter((x) => x.r !== undefined);
}

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(['frames:' + tabId, 'health:' + tabId]));

// ---------------------------------------------------------------------------
// Самопроверка: худшее состояние среди фреймов вкладки -> значок на иконке
// ---------------------------------------------------------------------------
const HEALTH_ORDER = { ok: 0, warn: 1, error: 2 };

async function setHealth(tabId, frameId, health) {
  const k = 'health:' + tabId;
  const got = await chrome.storage.session.get(k);
  const map = got[k] || {};
  if (health) map[frameId] = health;
  else delete map[frameId];
  await chrome.storage.session.set({ [k]: map });

  let worst = null;
  const issues = [];
  for (const h of Object.values(map)) {
    issues.push(...(h.issues || []));
    if (!worst || HEALTH_ORDER[h.level] > HEALTH_ORDER[worst]) worst = h.level;
  }
  const text = worst === 'error' ? '!' : worst === 'warn' ? '•' : '';
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (text) await chrome.action.setBadgeBackgroundColor({ tabId, color: worst === 'error' ? '#d93025' : '#f29900' });
    await chrome.action.setTitle({ tabId, title: 'Support Translator' + (issues.length ? '\n' + Array.from(new Set(issues)).join('\n') : '') });
  } catch (e) { /* вкладка закрыта */ }
}

async function getHealth(tabId) {
  const k = 'health:' + tabId;
  const got = await chrome.storage.session.get(k);
  return got[k] || {};
}

// ---------------------------------------------------------------------------
// Сообщения
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const tabId = sender.tab && sender.tab.id;
    switch (msg && msg.type) {
      case 'translate': {
        const settings = await getSettings();
        const r = await globalThis.ST_TRANSLATOR.translate(msg.text, msg.sl, msg.tl, settings, msg.opts);
        return { ok: true, result: r };
      }
      case 'hello':
        if (tabId != null) await addFrame(tabId, sender.frameId || 0);
        return { ok: true };
      case 'event':
        STATS.event(msg.event);
        return { ok: true };
      case 'health':
        if (tabId != null) await setHealth(tabId, sender.frameId || 0, msg.health);
        return { ok: true };
      case 'convLang': {
        // Язык собеседника из одного фрейма -> остальным фреймам вкладки
        if (tabId == null || !msg.lang) return { ok: true };
        const frames = await getFrames(tabId);
        await Promise.all(frames
          .filter((f) => f !== (sender.frameId || 0))
          .map((frameId) => chrome.tabs.sendMessage(tabId, { type: 'frameLang', lang: msg.lang }, { frameId }).catch(() => {})));
        return { ok: true };
      }
      case 'pickEnd':
        if (tabId != null) await broadcast(tabId, { type: 'pickCancel' });
        return { ok: true };

      // --- от popup ---
      case 'tabStatus': {
        const res = await broadcast(msg.tabId, { type: 'status' });
        const statuses = res.map((x) => Object.assign({ frameId: x.frameId }, x.r));
        return { ok: true, frames: statuses };
      }
      case 'tabDiag': {
        const res = await broadcast(msg.tabId, { type: 'diag' });
        const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
        let origin = '';
        try { origin = tab && tab.url ? new URL(tab.url).origin : ''; } catch (e) { /* ignore */ }
        const settings = await getSettings();
        const s = await STATS.today();
        return {
          ok: true,
          report: {
            version: chrome.runtime.getManifest().version,
            tabOrigin: origin,
            accessGranted: origin ? await chrome.permissions.contains({ origins: [origin.replace(/:\d+$/, '') + '/*'] }).catch(() => false) : false,
            registeredFrames: (await getFrames(msg.tabId)).length,
            health: await getHealth(msg.tabId),
            provider: settings.provider,
            today: { requests: s.requests, chars: s.chars, cacheHits: s.cacheHits, errors: s.errors, lastError: s.lastError },
            frames: res.map((x) => Object.assign({ frameId: x.frameId }, x.r))
          }
        };
      }
      case 'tabCommand':
        await broadcast(msg.tabId, msg.message);
        return { ok: true };
      case 'connectSite':
        return await finishConnect();
      case 'syncScripts':
        await syncContentScripts(true);
        return { ok: true };

      case 'getSettings':
        return { ok: true, settings: await getSettings() };
      case 'getStats':
        return { ok: true, today: await STATS.today(), days: await STATS.getDays() };
      case 'resetStats':
        await STATS.reset();
        return { ok: true };
      case 'clearCache': {
        const all = await chrome.storage.session.get(null);
        await chrome.storage.session.remove(Object.keys(all).filter((k) => k.startsWith('c:')));
        return { ok: true };
      }
      default:
        return { ok: false, error: 'unknown message' };
    }
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // асинхронный ответ
});

// Горячие клавиши -> во все фреймы вкладки (действует фрейм, где фокус)
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (tab && tab.id != null) await broadcast(tab.id, { type: 'command', command });
});

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: L.mergeSettings(settings) });
  // миграция статистики 0.1.0
  await chrome.storage.local.remove('stats');
  await syncContentScripts(true);
});
chrome.runtime.onStartup.addListener(() => syncContentScripts(true));
chrome.permissions.onAdded.addListener(async () => {
  await finishConnect().catch(() => {});
  await syncContentScripts(true);
});
chrome.permissions.onRemoved.addListener(() => syncContentScripts(true));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) syncContentScripts(false);
});
