/*
 * Service worker (MV3). Единственное место, откуда идут сетевые запросы к переводчику.
 * Content scripts общаются с ним через chrome.runtime.sendMessage.
 */
import './lib/defaults.js';
import './lib/providers.js';
import './lib/translator.js';

const { mergeSettings } = globalThis.ST_LIB;

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return mergeSettings(settings);
}

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: mergeSettings(settings) });
  chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'translate': {
        const settings = await getSettings();
        const r = await globalThis.ST_TRANSLATOR.translate(msg.text, msg.sl, msg.tl, settings);
        return { ok: true, result: r };
      }
      case 'getSettings':
        return { ok: true, settings: await getSettings() };
      case 'getStats': {
        const { stats } = await chrome.storage.local.get('stats');
        return { ok: true, stats: stats || null };
      }
      case 'clearCache':
        await chrome.storage.session.clear();
        return { ok: true };
      default:
        return { ok: false, error: 'unknown message' };
    }
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // асинхронный ответ
});

// Горячая клавиша из manifest.commands -> отдаём во вкладку
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'command', command });
  } catch (e) { /* на вкладке нет content script */ }
});
