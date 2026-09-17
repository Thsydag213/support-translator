(async function () {
  const L = globalThis.ST_LIB;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Math.round(n || 0).toLocaleString('ru');

  const FREE_TIER = 500000; // символов/мес бесплатно в Cloud Translation
  const PRICE_PER_M = 20; // $ за 1 млн символов
  const WORKDAYS = 22;

  const { settings } = await chrome.storage.local.get('settings');
  $('keep').textContent = L.mergeSettings(settings).statsKeepDays;

  let ownDays = [];
  let mergedFiles = []; // [{ name, days }]

  async function loadOwn() {
    const r = await chrome.runtime.sendMessage({ type: 'getStats' });
    ownDays = (r && r.days) || [];
  }

  // --- объединение дней (свои + файлы коллег) ---
  function addBucket(target, src) {
    for (const [k, v] of Object.entries(src || {})) {
      const t = target[k] || (target[k] = { n: 0, chars: 0 });
      t.n += v.n || 0;
      t.chars += v.chars || 0;
    }
  }
  function mergeDays(lists) {
    const map = {};
    for (const list of lists) {
      for (const d of list) {
        const m = map[d.date] || (map[d.date] = {
          date: d.date, requests: 0, chars: 0, cacheHits: 0, errors: 0, providers: {},
          incoming: {}, outgoing: {}, guard: { blocked: 0, sentAsIs: 0, translated: 0 }
        });
        m.requests += d.requests || 0;
        m.chars += d.chars || 0;
        m.cacheHits += d.cacheHits || 0;
        m.errors += d.errors || 0;
        for (const [p, c] of Object.entries(d.providers || {})) m.providers[p] = (m.providers[p] || 0) + c;
        addBucket(m.incoming, d.incoming);
        addBucket(m.outgoing, d.outgoing);
        for (const k of Object.keys(m.guard)) m.guard[k] += (d.guard && d.guard[k]) || 0;
      }
    }
    return Object.values(map).sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  function dateRange(n) {
    const out = [];
    const now = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      out.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
    }
    return out;
  }

  const sumN = (o) => Object.values(o || {}).reduce((n, x) => n + x.n, 0);

  // --- tooltip ---
  const tip = $('tip');
  function showTip(e, html) {
    tip.innerHTML = html;
    tip.hidden = false;
    const x = Math.min(window.innerWidth - tip.offsetWidth - 8, (e.clientX || 0) + 12);
    const y = Math.max(8, (e.clientY || 0) - tip.offsetHeight - 10);
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  const hideTip = () => { tip.hidden = true; };
  window.addEventListener('scroll', hideTip, { passive: true });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  function renderTiles(days) {
    const inc = days.reduce((n, d) => n + sumN(d.incoming), 0);
    const out = days.reduce((n, d) => n + sumN(d.outgoing), 0);
    const chars = days.reduce((n, d) => n + d.chars, 0);
    const req = days.reduce((n, d) => n + d.requests, 0);
    const hits = days.reduce((n, d) => n + d.cacheHits, 0);
    const errors = days.reduce((n, d) => n + d.errors, 0);
    const g = days.reduce((a, d) => ({ blocked: a.blocked + d.guard.blocked, sentAsIs: a.sentAsIs + d.guard.sentAsIs, translated: a.translated + d.guard.translated }), { blocked: 0, sentAsIs: 0, translated: 0 });
    const tiles = [
      [fmt(inc), 'входящих переведено', ''],
      [fmt(out), 'ответов переведено', ''],
      [fmt(chars), 'символов в переводчик', fmt(req) + ' запросов'],
      [(req + hits ? Math.round((hits / (req + hits)) * 100) : 0) + '%', 'из кэша', fmt(hits) + ' попаданий'],
      [fmt(g.blocked), 'блокировок отправки', fmt(g.translated) + ' перевели · ' + fmt(g.sentAsIs) + ' как есть'],
      [fmt(errors), 'ошибок перевода', '']
    ];
    $('tiles').innerHTML = tiles.map(([v, l, s]) => `<div class="tile"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div><div class="s">${esc(s)}</div></div>`).join('');
  }

  function renderCharsChart(days, range) {
    const byDate = Object.fromEntries(days.map((d) => [d.date, d]));
    const values = range.map((date) => ({ date, v: (byDate[date] && byDate[date].chars) || 0, d: byDate[date] }));
    const box = $('charsChart');
    const max = niceMax(Math.max(0, ...values.map((x) => x.v)));
    if (!values.some((x) => x.v)) {
      box.innerHTML = '<div class="empty" style="grid-column:1/-1">Пока нет данных за период</div>';
      return;
    }
    const ticks = [0, 0.5, 1];
    box.innerHTML = `
      <div class="yaxis">${ticks.map((t) => `<span style="bottom:${t * 100}%">${fmt(max * t)}</span>`).join('')}</div>
      <div class="plot">
        ${ticks.slice(1).map((t) => `<div class="gridline" style="bottom:${t * 100}%"></div>`).join('')}
        <div class="bars">${values.map((x, i) => `<div class="col" tabindex="0" data-i="${i}"><div class="bar" style="height:${(x.v / max) * 100}%"></div></div>`).join('')}</div>
      </div>
      <div class="xlabels"><span>${values[0].date.slice(5)}</span><span>${values[Math.floor(values.length / 2)].date.slice(5)}</span><span>${values[values.length - 1].date.slice(5)}</span></div>`;
    box.querySelectorAll('.col').forEach((col) => {
      const x = values[+col.dataset.i];
      const html = `${x.date}<br><b>${fmt(x.v)}</b> символов` + (x.d ? `<br>${fmt(x.d.requests)} запросов · ${fmt(x.d.cacheHits)} из кэша` : '');
      col.addEventListener('mousemove', (e) => showTip(e, html));
      col.addEventListener('mouseleave', hideTip);
      col.addEventListener('focus', () => {
        const r = col.getBoundingClientRect();
        showTip({ clientX: r.left, clientY: r.top }, html);
      });
      col.addEventListener('blur', hideTip);
    });
  }

  function renderLangBars(el, days, key) {
    const agg = {};
    for (const d of days) addBucket(agg, d[key]);
    let rows = Object.entries(agg).map(([lang, v]) => ({ lang, n: v.n, chars: v.chars })).sort((a, b) => b.n - a.n);
    if (!rows.length) {
      el.innerHTML = '<div class="empty">Нет данных</div>';
      return;
    }
    if (rows.length > 10) {
      const rest = rows.slice(9);
      rows = rows.slice(0, 9).concat([{ lang: 'other', n: rest.reduce((s, r) => s + r.n, 0), chars: rest.reduce((s, r) => s + r.chars, 0), other: rest.length }]);
    }
    const total = rows.reduce((s, r) => s + r.n, 0);
    const max = Math.max(...rows.map((r) => r.n));
    el.innerHTML = rows.map((r, i) => {
      const name = r.lang === 'other' ? 'Другие (' + r.other + ')' : L.langName(r.lang) + ' (' + r.lang + ')';
      return `<div class="hrow" data-i="${i}"><span class="name" title="${esc(name)}">${esc(name)}</span><div class="track"><div class="fill" style="width:${(r.n / max) * 100}%"></div></div><span class="val">${fmt(r.n)}</span></div>`;
    }).join('');
    el.querySelectorAll('.hrow').forEach((row) => {
      const r = rows[+row.dataset.i];
      const html = `${esc(r.lang === 'other' ? 'Другие' : L.langName(r.lang))}<br><b>${fmt(r.n)}</b> сообщений (${Math.round((r.n / total) * 100)}%)<br>${fmt(r.chars)} символов`;
      row.addEventListener('mousemove', (e) => showTip(e, html));
      row.addEventListener('mouseleave', hideTip);
    });
  }

  function renderCost(allDays) {
    const month = L.today().slice(0, 7);
    const monthDays = allDays.filter((d) => d.date.startsWith(month) && d.chars > 0);
    const monthChars = monthDays.reduce((n, d) => n + d.chars, 0);
    const avg = monthDays.length ? monthChars / monthDays.length : 0;
    const projected = avg * WORKDAYS;
    const cost = (c) => Math.max(0, c - FREE_TIER) / 1e6 * PRICE_PER_M;
    $('cost').innerHTML = `
      <div class="cost">
        <div><span class="muted small">В этом месяце отправлено</span><b>${fmt(monthChars)}</b><span class="muted small">символов за ${monthDays.length} раб. дн.</span></div>
        <div><span class="muted small">Прогноз на месяц (${WORKDAYS} раб. дн.)</span><b>${fmt(projected)}</b><span class="muted small">символов</span></div>
        <div><span class="muted small">Было бы на официальном API</span><b>$${cost(projected).toFixed(0)}/мес</b><span class="muted small">$${PRICE_PER_M} за 1 млн, первые ${fmt(FREE_TIER)} бесплатно</span></div>
      </div>
      <p class="muted small">Сейчас используется бесплатный провайдер — фактических расходов нет. Оценка нужна для решения о переходе на официальный API. Если объединены файлы коллег — считается по всей команде.</p>`;
  }

  function renderTable(days) {
    const rows = days.slice().reverse();
    $('table').querySelector('tbody').innerHTML = rows.length
      ? rows.map((d) => `<tr><td>${d.date}</td><td>${fmt(sumN(d.incoming))}</td><td>${fmt(sumN(d.outgoing))}</td><td>${fmt(d.requests)}</td><td>${fmt(d.chars)}</td><td>${fmt(d.cacheHits)}</td><td>${fmt(d.errors)}</td><td>${fmt(d.guard.blocked)}</td><td>${fmt(d.guard.sentAsIs)}</td><td>${fmt(d.guard.translated)}</td></tr>`).join('')
      : '<tr><td colspan="10" class="empty">Нет данных</td></tr>';
  }

  function render() {
    const all = mergeDays([ownDays, ...mergedFiles.map((f) => f.days)]);
    const n = +$('period').value;
    const range = dateRange(n);
    const days = all.filter((d) => d.date >= range[0]);
    $('source').textContent = mergedFiles.length
      ? 'Данные: этот браузер + ' + mergedFiles.length + ' файл(ов): ' + mergedFiles.map((f) => f.name).join(', ')
      : 'Данные: этот браузер';
    renderTiles(days);
    renderCharsChart(days, range);
    renderLangBars($('langIn'), days, 'incoming');
    renderLangBars($('langOut'), days, 'outgoing');
    renderCost(all);
    renderTable(days);
  }

  $('period').addEventListener('change', render);

  $('merge').addEventListener('change', async (e) => {
    for (const file of e.target.files) {
      try {
        const data = JSON.parse(await file.text());
        const days = Array.isArray(data) ? data : data.days;
        if (!Array.isArray(days)) throw new Error('нет поля days');
        mergedFiles.push({ name: file.name, days });
      } catch (err) {
        alert('Файл ' + file.name + ' не распознан: ' + err.message);
      }
    }
    e.target.value = '';
    render();
  });

  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  $('exportJson').addEventListener('click', () => {
    download('support-translator-stats-' + L.today() + '.json', JSON.stringify({ exportedAt: new Date().toISOString(), days: ownDays }, null, 2), 'application/json');
  });

  $('exportCsv').addEventListener('click', () => {
    const all = mergeDays([ownDays, ...mergedFiles.map((f) => f.days)]);
    const langs = new Set();
    for (const d of all) for (const k of Object.keys(d.incoming)) langs.add(k);
    const langList = Array.from(langs).sort();
    const head = ['date', 'incoming', 'outgoing', 'requests', 'chars', 'cacheHits', 'errors', 'guardBlocked', 'guardSentAsIs', 'guardTranslated', ...langList.map((l) => 'in_' + l)];
    const lines = [head.join(';')];
    for (const d of all) {
      lines.push([d.date, sumN(d.incoming), sumN(d.outgoing), d.requests, d.chars, d.cacheHits, d.errors, d.guard.blocked, d.guard.sentAsIs, d.guard.translated, ...langList.map((l) => (d.incoming[l] ? d.incoming[l].n : 0))].join(';'));
    }
    download('support-translator-stats-' + L.today() + '.csv', '﻿' + lines.join('\n'), 'text/csv');
  });

  $('reset').addEventListener('click', async () => {
    if (!confirm('Удалить всю статистику в этом браузере? Сначала можно сделать «Экспорт JSON».')) return;
    await chrome.runtime.sendMessage({ type: 'resetStats' });
    await loadOwn();
    render();
  });

  await loadOwn();
  render();
})();
