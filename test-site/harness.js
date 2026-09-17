/*
 * DEV HARNESS: запускает content scripts расширения прямо на тестовой странице без установки расширения.
 * Эмулирует chrome.* API (storage, runtime, i18n), переводит через те же glossary/providers/translator,
 * пишет статистику через lib/stats.js (в памяти страницы).
 * Использование: http://localhost:8787/test-site/mock-chat.html?harness=1
 *   &mock=1   — тестовый переводчик без сети (не тратит лимиты Google)
 *   &shadow=1 — интерфейс чата внутри Shadow DOM
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
              const result = await globalThis.ST_TRANSLATOR.translate(msg.text, msg.sl, msg.tl, settings, msg.opts);
              return { ok: true, result };
            } catch (e) {
              return { ok: false, error: e.message };
            }
          case 'event':
            globalThis.ST_STATS.event(msg.event);
            return { ok: true };
          case 'getStats':
            return { ok: true, today: await globalThis.ST_STATS.today(), days: await globalThis.ST_STATS.getDays() };
          case 'health':
            window.stHarness.lastHealth = msg.health;
            return { ok: true };
          case 'hello':
          case 'pickEnd':
          case 'convLang':
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

  // ?mock=1 — тестовый провайдер без сети (не расходует лимиты Google)
  if (new URLSearchParams(location.search).has('mock')) {
    const L0 = { provider: 'dev-mock' };
    store.settings = L0; // mergeSettings дополнит остальное значениями по умолчанию
  }

  // ?fakelocal=1 — эмуляция встроенного переводчика Chrome (Translator/LanguageDetector API).
  // Пакет "скачан" для es/pt → en; остальные пары — "нужно скачать" (идут в облако)
  if (new URLSearchParams(location.search).has('fakelocal')) {
    window.stFakeLocal = { calls: 0 };
    window.Translator = {
      async availability({ sourceLanguage, targetLanguage }) {
        const ok = ['es>en', 'pt>en', 'en>es', 'ru>es', 'es>ru', 'ru>en', 'en>ru'];
        return ok.includes(sourceLanguage + '>' + targetLanguage) ? 'available' : 'downloadable';
      },
      async create({ sourceLanguage, targetLanguage }) {
        return {
          async translate(text) {
            window.stFakeLocal.calls++;
            return '[local ' + sourceLanguage + '>' + targetLanguage + '] ' + text;
          }
        };
      }
    };
    window.LanguageDetector = {
      async availability() { return 'available'; },
      async create() {
        return {
          async detect(text) {
            if (/\p{Script=Cyrillic}/u.test(text)) return [{ detectedLanguage: 'ru', confidence: 0.97 }];
            if (/\b(hola|cuenta|puedo|necesito|dinero)\b/i.test(text)) return [{ detectedLanguage: 'es', confidence: 0.95 }];
            if (/iPhone/.test(text)) return [{ detectedLanguage: 'es', confidence: 0.5 }]; // неуверенная догадка
            if (/\b(merhaba|ödeme|lütfen)\b/i.test(text)) return [{ detectedLanguage: 'tr', confidence: 0.9 }];
            return [{ detectedLanguage: 'und', confidence: 0.2 }];
          }
        };
      }
    };
  }

  const post = (msg) => new Promise((resolve) => messageListeners.forEach((l) => l(msg, {}, resolve)));
  window.stHarness = {
    command: (command) => post({ type: 'command', command }),
    pick: (kind) => post({ type: 'pick', kind }),
    status: () => post({ type: 'status' }),
    diag: () => post({ type: 'diag' }),
    // произвольное сообщение от "фоновой части" (например, { type: 'frameLang', lang: 'pt' })
    message: (msg) => post(msg),
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

  const files = [
    'lib/defaults.js', 'lib/checks.js', 'lib/providers.js', 'lib/glossary.js', 'lib/stats.js', 'lib/translator.js',
    'content/core.js', 'content/styles.js', 'content/local-translator.js', 'content/incoming.js', 'content/outgoing.js', 'content/guard.js', 'content/picker.js', 'content/diag.js', 'content/main.js'
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
