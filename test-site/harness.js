/*
 * DEV HARNESS: запускает content scripts расширения прямо на тестовой странице без установки расширения.
 * Эмулирует chrome.* API (storage, runtime, i18n), переводит через те же glossary/providers/translator,
 * пишет статистику через lib/stats.js (в памяти страницы).
 * Использование: http://localhost:8787/test-site/mock-chat.html?harness=1
 */
(function () {
  const EXT = '../extension/';
  const store = {};
  const changeListeners = [];
  const messageListeners = [];
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  function notify(changes) {
    setTimeout(() => changeListeners.forEach((l) => l(changes, 'local')), 0);
  }

  window.chrome = {
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return clone(store);
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (k in store) out[k] = clone(store[k]);
          return out;
        },
        async set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: store[k], newValue: clone(v) };
            store[k] = clone(v);
          }
          notify(changes);
        },
        async remove(keys) {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
        }
      },
      onChanged: { addListener: (fn) => changeListeners.push(fn) }
    },
    runtime: {
      id: 'harness',
      async sendMessage(msg) {
        const settings = globalThis.ST_LIB.mergeSettings(store.settings);
        switch (msg.type) {
          case 'translate':
            try {
              const result = await globalThis.ST_TRANSLATOR.translate(msg.text, msg.sl, msg.tl, settings);
              return { ok: true, result };
            } catch (e) {
              return { ok: false, error: e.message };
            }
          case 'event':
            globalThis.ST_STATS.event(msg.event);
            return { ok: true };
          case 'getStats':
            return { ok: true, today: await globalThis.ST_STATS.today(), days: await globalThis.ST_STATS.getDays() };
          case 'hello':
          case 'pickEnd':
            return { ok: true };
          default:
            return { ok: false, error: 'not supported in harness: ' + msg.type };
        }
      },
      onMessage: { addListener: (fn) => messageListeners.push(fn) }
    },
    i18n: {
      // В harness нет CLD — всегда "не уверен", язык определит Google
      async detectLanguage() {
        return { isReliable: false, languages: [] };
      }
    }
  };

  const post = (msg) => new Promise((resolve) => messageListeners.forEach((l) => l(msg, {}, resolve)));
  window.stHarness = {
    command: (command) => post({ type: 'command', command }),
    pick: (kind) => post({ type: 'pick', kind }),
    status: () => post({ type: 'status' }),
    diag: () => post({ type: 'diag' }),
    store,
    async setSettings(patch, sitePatch) {
      const s = globalThis.ST_LIB.mergeSettings(store.settings);
      Object.assign(s, patch || {});
      if (sitePatch) Object.assign(s.sites[0], sitePatch);
      await chrome.storage.local.set({ settings: s });
    }
  };
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.code === 'KeyY' || String(e.key).toLowerCase() === 'y')) {
      e.preventDefault();
      window.stHarness.command('translate-input');
    }
  }, true);

  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = EXT + 'content/content.css';
  document.head.appendChild(css);

  const files = [
    'lib/defaults.js', 'lib/providers.js', 'lib/glossary.js', 'lib/stats.js', 'lib/translator.js',
    'content/core.js', 'content/incoming.js', 'content/outgoing.js', 'content/guard.js', 'content/picker.js', 'content/diag.js', 'content/main.js'
  ];
  (function next(i) {
    if (i >= files.length) return console.log('[harness] loaded');
    const s = document.createElement('script');
    s.src = EXT + files[i];
    s.onload = () => next(i + 1);
    s.onerror = () => console.error('[harness] failed to load', files[i]);
    document.body.appendChild(s);
  })(0);
})();
