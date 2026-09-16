/*
 * Статистика (только в service worker). Хранится локально по дням в chrome.storage.local:
 *   statsDays: { 'YYYY-MM-DD': Day }
 *   statsSeen: { date, list: [hash] } — чтобы одно входящее сообщение не считалось повторно
 *
 * Day = {
 *   date, requests, chars, cacheHits, errors, lastError,
 *   providers: { 'google-free': chars },
 *   incoming:  { es: { n, chars } },   // уникальные переведённые входящие
 *   outgoing:  { es: { n, chars } },   // вставленные переводы ответов
 *   guard:     { blocked, sentAsIs, translated }
 * }
 */
(function () {
  const L = globalThis.ST_LIB;
  const SEEN_LIMIT = 20000;

  let chain = Promise.resolve();
  const area = () => (globalThis.chrome && chrome.storage && chrome.storage.local) || null;

  function emptyDay(date) {
    return {
      date, requests: 0, chars: 0, cacheHits: 0, errors: 0, lastError: '',
      providers: {}, incoming: {}, outgoing: {}, guard: { blocked: 0, sentAsIs: 0, translated: 0 }
    };
  }

  // Последовательная модификация, чтобы параллельные события не затирали друг друга
  function mutate(fn) {
    const a = area();
    if (!a) return Promise.resolve();
    chain = chain
      .then(async () => {
        const date = L.today();
        const { statsDays, settings } = await a.get(['statsDays', 'settings']);
        const days = statsDays || {};
        const day = Object.assign(emptyDay(date), days[date] || {});
        const res = await fn(day, a);
        if (res === false) return;
        days[date] = day;
        const keep = (settings && settings.statsKeepDays) || 90;
        const cutoff = new Date(Date.now() - keep * 86400000).toISOString().slice(0, 10);
        for (const k of Object.keys(days)) if (k < cutoff) delete days[k];
        await a.set({ statsDays: days });
      })
      .catch((e) => console.warn('[stats]', e));
    return chain;
  }

  function addLang(bucket, lang, chars) {
    const k = L.baseLang(lang) === 'zh' ? L.normLang(lang) : L.baseLang(lang) || '?';
    const b = bucket[k] || (bucket[k] = { n: 0, chars: 0 });
    b.n += 1;
    b.chars += chars || 0;
  }

  const ST_STATS = {
    api(chars, provider) {
      return mutate((d) => {
        d.requests += 1;
        d.chars += chars;
        d.providers[provider] = (d.providers[provider] || 0) + chars;
      });
    },
    cacheHit() {
      return mutate((d) => { d.cacheHits += 1; });
    },
    error(msg) {
      return mutate((d) => {
        d.errors += 1;
        d.lastError = String(msg || '').slice(0, 300);
      });
    },
    note(msg) {
      return mutate((d) => { d.lastError = String(msg || '').slice(0, 300); });
    },
    // События из content scripts
    event(ev) {
      return mutate(async (d, a) => {
        if (ev.kind === 'incoming') {
          const { statsSeen } = await a.get('statsSeen');
          const seen = statsSeen && statsSeen.date === d.date ? statsSeen : { date: d.date, list: [] };
          if (seen.list.includes(ev.hash)) return false;
          seen.list.push(ev.hash);
          if (seen.list.length > SEEN_LIMIT) seen.list.splice(0, seen.list.length - SEEN_LIMIT);
          await a.set({ statsSeen: seen });
          addLang(d.incoming, ev.lang, ev.chars);
        } else if (ev.kind === 'outgoing') {
          addLang(d.outgoing, ev.lang, ev.chars);
        } else if (ev.kind === 'guard' && d.guard[ev.action] != null) {
          d.guard[ev.action] += 1;
        } else {
          return false;
        }
      });
    },
    async getDays() {
      const a = area();
      if (!a) return [];
      await chain;
      const { statsDays } = await a.get('statsDays');
      return Object.values(statsDays || {}).sort((x, y) => (x.date < y.date ? -1 : 1));
    },
    async today() {
      const days = await this.getDays();
      const t = L.today();
      return days.find((d) => d.date === t) || emptyDay(t);
    },
    async reset() {
      const a = area();
      if (!a) return;
      await chain;
      await a.remove(['statsDays', 'statsSeen', 'stats']);
    },
    emptyDay
  };

  globalThis.ST_STATS = ST_STATS;
})();
