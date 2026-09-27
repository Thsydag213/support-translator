/*
 * Service worker (MV3).
 *  - единственное место, откуда идут сетевые запросы к переводчику;
 *  - регистрирует content scripts ТОЛЬКО на доменах, к которым пользователь выдал доступ;
 *  - ведёт реестр фреймов вкладок (чат может быть в iframe) и рассылает им команды;
 *  - собирает статистику.
 */
import './lib/compat.js';
import './lib/defaults.js';
import './lib/providers.js';
import './lib/glossary.js';
import './lib/pii.js';
import './lib/stats.js';
import './lib/translator.js';

const L = globalThis.ST_LIB;
const STATS = globalThis.ST_STATS;

const SCRIPT_ID = 'st-main';
const CS_JS = [
  'lib/compat.js',
  'lib/defaults.js',
  'lib/checks.js',
  'lib/glossary.js',
  'content/core.js',
  'content/styles.js',
  'content/local-translator.js',
  'content/tm.js',
  'content/incoming.js',
  'content/outgoing.js',
  'content/assist.js',
  'content/guard.js',
  'content/picker.js',
  'content/palette.js',
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
    const base = { id: SCRIPT_ID, matches: origins, js: CS_JS, runAt: 'document_idle', allFrames: true, persistAcrossSessions: true };
    try {
      // matchOriginAsFallback — письма во фреймах about:srcdoc/blank (Chrome, Edge). Firefox это свойство не знает
      await chrome.scripting.registerContentScripts([Object.assign({ matchOriginAsFallback: true }, base)]);
    } catch (e) {
      console.warn('[sync] без matchOriginAsFallback:', e && e.message);
      await chrome.scripting.registerContentScripts([base]);
    }
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
// Скрытая страница расширения (offscreen document) — мост встроенного переводчика Chrome
// ---------------------------------------------------------------------------
const OFFSCREEN_URL = 'offscreen/offscreen.html';
let offscreenCreating = null;

async function ensureOffscreen() {
  if (!chrome.offscreen) throw new Error('offscreen API недоступен');
  const contexts = chrome.runtime.getContexts
    ? await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)] })
    : [];
  if (contexts.length) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['DOM_PARSER'],
        justification: 'Перевод на устройстве через встроенный Translator API Chrome'
      })
      .catch((e) => {
        if (!/single offscreen|already exists/i.test(String(e && e.message))) throw e;
      })
      .finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
}

async function offscreenCall(payload) {
  try {
    await ensureOffscreen();
    const r = await chrome.runtime.sendMessage(Object.assign({ target: 'offscreen' }, payload));
    return r || { ok: false, error: 'мост не ответил' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), info: { translator: false, detector: false } };
  }
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
        checkUpdate(false).catch(() => {});
        return { ok: true };

      // --- локальная языковая модель Chrome (через offscreen) ---
      case 'llmInfo':
        return await offscreenCall({ op: 'llmInfo' });
      case 'llmPrompt':
        return await offscreenCall({ op: 'prompt', system: msg.system, text: msg.text, schema: msg.schema });
      case 'llmSummarize':
        return await offscreenCall({ op: 'summarize', text: msg.text, kind: msg.kind, length: msg.length });

      // --- палитра команд, онбординг, обновления, лимит Cloud ---
      case 'selfDiag':
        return tabId != null ? await tabDiag(tabId) : { ok: false, error: 'нет вкладки' };
      case 'openOptions':
        chrome.runtime.openOptionsPage();
        return { ok: true };
      case 'openOnboarding':
        await chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
        return { ok: true };
      case 'openShortcuts':
        await chrome.tabs.create({ url: globalThis.ST_ENV && globalThis.ST_ENV.firefox ? 'about:addons' : 'chrome://extensions/shortcuts' }).catch(() => {});
        return { ok: true };
      case 'updateInfo':
        return { ok: true, update: await checkUpdate(!!msg.force) };
      case 'cloudUsage':
        return { ok: true, usage: await cloudUsage() };
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
      case 'tabDiag':
        return await tabDiag(msg.tabId);
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
      case 'clearCache':
        await globalThis.ST_TRANSLATOR.clearCache();
        return { ok: true };
      case 'testProvider': {
        // Проверка конкретного провайдера (например, резерва Google Cloud) — без кэша и без резерва
        const settings = await getSettings();
        const s = Object.assign({}, settings, { provider: msg.provider, fallbackToCloud: false });
        const t0 = Date.now();
        const r = await globalThis.ST_TRANSLATOR.translate(msg.text, 'auto', msg.tl || settings.targetLang, s, { noCache: true });
        return { ok: true, result: r, ms: Date.now() - t0 };
      }
      case 'providerStatus':
        return { ok: true, status: globalThis.ST_TRANSLATOR.status() };

      // --- мост встроенного переводчика Chrome (для скриптов на сайте, где API может не быть) ---
      case 'localInfo':
        return await offscreenCall({ op: 'info' });
      case 'localAvailability':
        return await offscreenCall({ op: 'availability', src: msg.src, tgt: msg.tgt });
      case 'localTranslate':
        // статистику «на устройстве» пишет сам скрипт страницы (ST.translate) — здесь не дублируем
        return await offscreenCall({ op: 'translate', text: msg.text, src: msg.src, tgt: msg.tgt });
      case 'localTranslateMany':
        return await offscreenCall({ op: 'translateMany', texts: msg.texts, src: msg.src, tgt: msg.tgt });
      case 'localDetect':
        return await offscreenCall({ op: 'detect', text: msg.text });
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

chrome.runtime.onInstalled.addListener(async (details) => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: L.mergeSettings(settings) });
  // миграция статистики 0.1.0
  await chrome.storage.local.remove('stats');
  await syncContentScripts(true);
  // Знакомство с расширением: при установке и один раз при переходе на 0.7 (много новых функций)
  const prev = (details && details.previousVersion) || '';
  if (details && (details.reason === 'install' || (details.reason === 'update' && prev && newerVersion('0.7.0', prev)))) {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') }).catch(() => {});
  }
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

// ---------------------------------------------------------------------------
// Отчёт диагностики вкладки (popup, палитра команд)
// ---------------------------------------------------------------------------
async function tabDiag(tabId) {
  const res = await broadcast(tabId, { type: 'diag' });
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  let origin = '';
  try { origin = tab && tab.url ? new URL(tab.url).origin : ''; } catch (e) { /* ignore */ }
  const settings = await getSettings();
  const s = await STATS.today();
  return {
    ok: true,
    report: {
      version: chrome.runtime.getManifest().version,
      browser: globalThis.ST_ENV ? globalThis.ST_ENV.name + (globalThis.ST_ENV.offscreen ? '' : ' (без offscreen)') : '',
      tabOrigin: origin,
      accessGranted: origin ? await chrome.permissions.contains({ origins: [origin.replace(/:\d+$/, '') + '/*'] }).catch(() => false) : false,
      registeredFrames: (await getFrames(tabId)).length,
      health: await getHealth(tabId),
      provider: settings.provider,
      cloudFallback: !!(settings.fallbackToCloud && settings.googleCloudApiKey),
      batchRequests: settings.batchRequests,
      maskPii: settings.maskPii !== false,
      cloudUsage: await cloudUsage(),
      translator: globalThis.ST_TRANSLATOR.status(),
      today: { requests: s.requests, chars: s.chars, cacheHits: s.cacheHits, errors: s.errors, lastError: s.lastError },
      frames: res.map((x) => Object.assign({ frameId: x.frameId }, x.r))
    }
  };
}

// ---------------------------------------------------------------------------
// Проверка новой версии на GitHub (не чаще раза в 12 часов)
// ---------------------------------------------------------------------------
const UPDATE_URL = 'https://raw.githubusercontent.com/Thsydag213/support-translator/main/extension/manifest.json';
const DOWNLOAD_URL = 'https://github.com/Thsydag213/support-translator/archive/refs/heads/main.zip';

function newerVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function checkUpdate(force) {
  const settings = await getSettings();
  const current = chrome.runtime.getManifest().version;
  const { updateState } = await chrome.storage.local.get('updateState');
  const st = updateState || {};
  if (!settings.updateCheck && !force) return null;
  if (!force && st.checkedAt && Date.now() - st.checkedAt < 12 * 3600 * 1000) {
    return st.latest && newerVersion(st.latest, current) ? { current, latest: st.latest, url: DOWNLOAD_URL } : null;
  }
  try {
    const r = await fetch(UPDATE_URL, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const latest = (await r.json()).version;
    await chrome.storage.local.set({ updateState: { checkedAt: Date.now(), latest } });
    return newerVersion(latest, current) ? { current, latest, url: DOWNLOAD_URL } : null;
  } catch (e) {
    await chrome.storage.local.set({ updateState: Object.assign({}, st, { checkedAt: Date.now(), error: String(e && e.message) }) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Расход Google Cloud за текущий месяц (бесплатный лимит — 500 000 символов)
// ---------------------------------------------------------------------------
async function cloudUsage() {
  const settings = await getSettings();
  const used = await STATS.monthChars('google-cloud');
  const limit = settings.cloudMonthlyLimit || 500000;
  return { used, limit, share: limit ? used / limit : 0, configured: !!settings.googleCloudApiKey };
}
