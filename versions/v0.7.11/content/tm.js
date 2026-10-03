/*
 * Память переводов (translation memory).
 *
 * Когда оператор вставляет перевод ответа, пара «оригинал → перевод, который он подтвердил (и, возможно, поправил)»
 * запоминается. В следующий раз тот же текст на тот же язык переводится мгновенно из памяти:
 * без запроса к переводчику и с правками оператора, а не с «сырым» машинным переводом.
 *
 * Хранится локально (storage.local, ключ tm), до 3000 записей; старые вытесняются.
 */
(function () {
  const ST = globalThis.ST;
  if (ST.tm) return;
  const L = ST.L;
  const LIMIT = 3000;

  let cache = null;
  async function load() {
    if (cache) return cache;
    try {
      const { tm } = await chrome.storage.local.get('tm');
      cache = tm || {};
    } catch (e) {
      cache = {};
    }
    return cache;
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.tm) cache = changes.tm.newValue || {};
  });

  const norm = (s) => String(s).replace(/[\s ​]+/g, ' ').trim();
  const keyOf = (text, tl) => L.hash(L.baseLang(tl) + '|' + norm(text));

  ST.tm = {
    enabled: () => ST.settings.tmEnabled !== false,

    // { translation, at, uses } или null
    async get(text, tl) {
      if (!this.enabled() || !norm(text)) return null;
      const all = await load();
      const e = all[keyOf(text, tl)];
      return e ? { translation: e.t, at: e.at, uses: e.n || 0 } : null;
    },

    async set(text, tl, translation) {
      if (!this.enabled() || !norm(text) || !norm(translation)) return;
      const all = await load();
      const k = keyOf(text, tl);
      const prev = all[k];
      all[k] = { t: translation, at: Date.now(), n: prev ? (prev.n || 0) + 1 : 1, l: L.baseLang(tl) };
      const keys = Object.keys(all);
      if (keys.length > LIMIT) {
        keys.sort((a, b) => all[a].at - all[b].at);
        for (const old of keys.slice(0, keys.length - LIMIT)) delete all[old];
      }
      try {
        await chrome.storage.local.set({ tm: all });
      } catch (e) { /* хранилище недоступно — не страшно */ }
    },

    async size() {
      return Object.keys(await load()).length;
    }
  };
})();
