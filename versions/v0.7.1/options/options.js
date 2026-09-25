(async function () {
  const L = globalThis.ST_LIB;
  const $ = (id) => document.getElementById(id);

  $('version').textContent = 'v' + chrome.runtime.getManifest().version;

  function fillLangSelect(sel, extra) {
    sel.innerHTML = '';
    for (const [v, t] of extra || []) sel.add(new Option(t, v));
    for (const c of L.LANGS) sel.add(new Option(L.langName(c) + ' (' + c + ')', c));
  }
  fillLangSelect($('targetLang'));
  fillLangSelect($('fallbackOutgoingLang'));
  fillLangSelect($('backTranslateLang'), [['auto', 'Язык оригинала оператора (авто)']]);
  fillLangSelect($('glossaryTestLang'));

  // Языки ответов: галочки; языки платформы — первыми и жирным
  const replyBox = $('replyLangs');
  const replyCodes = [...L.REPLY_LANGS_DEFAULT, ...L.LANGS.filter((c) => !L.REPLY_LANGS_DEFAULT.includes(c))];
  for (const c of replyCodes) {
    const lab = document.createElement('label');
    lab.className = 'check' + (L.REPLY_LANGS_DEFAULT.includes(c) ? ' platform' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = c;
    lab.append(cb, ' ' + L.langName(c) + ' (' + c + ')');
    replyBox.appendChild(lab);
  }
  const replyChecks = () => Array.from(replyBox.querySelectorAll('input'));
  function setReplyLangs(list) {
    for (const cb of replyChecks()) cb.checked = list.includes(cb.value);
    refreshReplyFallback();
  }
  function checkedReplyLangs() {
    return replyChecks().filter((cb) => cb.checked).map((cb) => cb.value);
  }
  function refreshReplyFallback() {
    const sel = $('replyFallbackLang');
    const prev = sel.value;
    const list = checkedReplyLangs();
    sel.innerHTML = '';
    for (const c of list) sel.add(new Option(L.langName(c) + ' (' + c + ')', c));
    sel.value = list.includes(prev) ? prev : list.includes('en') ? 'en' : list[0] || '';
  }
  replyBox.addEventListener('change', (e) => {
    if (!checkedReplyLangs().length) e.target.checked = true; // хотя бы один язык должен остаться
    refreshReplyFallback();
  });
  $('glossaryTestLang').value = 'es';

  let settings = L.mergeSettings((await chrome.storage.local.get('settings')).settings);
  let dirty = false;

  const SELECTOR_FIELDS = ['containerSelector', 'messageSelector', 'userMessageSelector', 'inputSelector', 'sendButtonSelector', 'ticketIdSelector', 'subjectSelector', 'listItemSelector', 'noteSelector'];
  const GLOBAL_CHECKBOXES = ['outgoingButton', 'fallbackToCloud', 'batchRequests', 'onlyVisible', 'checkNumbers', 'spellCheck', 'listBadges', 'listBadgesUseNetwork',
    'quickInsert', 'tmEnabled', 'maskPii', 'assist', 'langChangeNotice', 'selectorCheck', 'updateCheck', 'cloudStopAtLimit'];
  const GLOBAL_SELECTS = ['formality', 'uiTheme', 'localTranslatorMode'];

  async function renderAccess(node, site) {
    const span = node.querySelector('[data-access]');
    const btn = node.querySelector('[data-act="grant"]');
    const origins = L.ruleOrigins(site);
    if (!origins.length) {
      span.textContent = '⚠ Не удалось определить домен — заполните «Доп. домены доступа» (например https://desk.company.com/*)';
      btn.hidden = true;
      return;
    }
    const missing = [];
    for (const o of origins) {
      if (!(await chrome.permissions.contains({ origins: [o] }))) missing.push(o);
    }
    span.textContent = missing.length
      ? '⚠ Нет доступа: ' + missing.join(', ')
      : '✅ Доступ выдан: ' + origins.join(', ');
    btn.hidden = !missing.length;
    btn.onclick = async () => {
      const ok = await chrome.permissions.request({ origins: missing });
      if (ok) await chrome.runtime.sendMessage({ type: 'syncScripts' });
      renderAccess(node, site);
    };
  }

  function renderSites() {
    const box = $('sites');
    box.innerHTML = '';
    settings.sites.forEach((site, i) => {
      const node = $('siteTpl').content.firstElementChild.cloneNode(true);
      node.querySelectorAll('[data-f]').forEach((inp) => {
        const f = inp.dataset.f;
        if (inp.type === 'checkbox') inp.checked = site[f] !== false;
        else inp.value = site[f] || '';
        inp.addEventListener('input', () => { dirty = true; });
        inp.addEventListener('change', () => {
          dirty = true;
          if (f === 'urlPattern' || f === 'origins') {
            collect();
            renderAccess(node, settings.sites[i]);
          }
        });
      });
      node.querySelector('[data-act="del"]').addEventListener('click', () => {
        if (!confirm('Удалить правило «' + (site.name || site.urlPattern) + '»?')) return;
        collect();
        settings.sites.splice(i, 1);
        dirty = true;
        renderSites();
      });
      node.dataset.index = i;
      box.appendChild(node);
      renderAccess(node, site);
    });
  }

  function render() {
    $('targetLang').value = settings.targetLang;
    $('skipLangs').value = settings.skipLangs.join(', ');
    $('displayMode').value = settings.displayMode;
    $('minChars').value = settings.minChars;
    $('intentMacros').value = settings.intentMacros || '';
    $('cloudMonthlyLimit').value = settings.cloudMonthlyLimit;
    $('fallbackOutgoingLang').value = settings.fallbackOutgoingLang;
    $('backTranslateLang').value = settings.backTranslateLang;
    $('guardMinLetters').value = settings.guardMinLetters;
    $('operatorLangs').value = settings.operatorLangs.join(', ');
    setReplyLangs(settings.replyLangs);
    if (settings.replyLangs.includes(settings.replyFallbackLang)) $('replyFallbackLang').value = settings.replyFallbackLang;
    $('glossary').value = settings.glossary;
    $('provider').value = settings.provider;
    $('googleCloudApiKey').value = settings.googleCloudApiKey;
    for (const id of GLOBAL_CHECKBOXES) $(id).checked = !!settings[id];
    for (const id of GLOBAL_SELECTS) $(id).value = settings[id];
    renderSites();
  }

  function collect() {
    settings.targetLang = $('targetLang').value;
    settings.skipLangs = $('skipLangs').value.split(',').map((x) => L.normLang(x)).filter(Boolean);
    settings.displayMode = $('displayMode').value;
    settings.minChars = Math.max(1, parseInt($('minChars').value, 10) || 3);
    settings.intentMacros = $('intentMacros').value;
    settings.cloudMonthlyLimit = Math.max(0, parseInt($('cloudMonthlyLimit').value, 10) || 0);
    settings.fallbackOutgoingLang = $('fallbackOutgoingLang').value;
    settings.backTranslateLang = $('backTranslateLang').value;
    settings.guardMinLetters = Math.max(1, parseInt($('guardMinLetters').value, 10) || 8);
    settings.operatorLangs = $('operatorLangs').value.split(',').map((x) => L.normLang(x)).filter(Boolean);
    settings.replyLangs = checkedReplyLangs();
    settings.replyFallbackLang = $('replyFallbackLang').value || 'en';
    settings.glossary = $('glossary').value;
    settings.provider = $('provider').value;
    settings.googleCloudApiKey = $('googleCloudApiKey').value.trim();
    for (const id of GLOBAL_CHECKBOXES) settings[id] = $(id).checked;
    for (const id of GLOBAL_SELECTS) settings[id] = $(id).value;
    document.querySelectorAll('#sites .site').forEach((node) => {
      const site = settings.sites[+node.dataset.index];
      if (!site) return;
      node.querySelectorAll('[data-f]').forEach((inp) => {
        site[inp.dataset.f] = inp.type === 'checkbox' ? inp.checked : inp.value.trim();
      });
    });
  }

  function validate() {
    const frag = document.createDocumentFragment();
    for (const s of settings.sites) {
      const label = s.name || s.urlPattern || 'правило';
      if (!s.urlPattern) return 'Не задан шаблон URL (' + label + ')';
      for (const f of SELECTOR_FIELDS) {
        if (!s[f]) continue;
        try {
          frag.querySelector(s[f]);
        } catch (e) {
          return 'Ошибка в селекторе «' + s[f] + '» (' + label + ')';
        }
      }
      for (const o of L.splitList(s.origins)) {
        if (!L.isValidMatchPattern(o)) return 'Неверный домен доступа «' + o + '» (' + label + '). Формат: https://host/*';
      }
    }
    return '';
  }

  async function save() {
    collect();
    const err = validate();
    if (err) {
      $('saved').textContent = '⚠ ' + err;
      return false;
    }
    await chrome.storage.local.set({ settings });
    dirty = false;
    $('saved').textContent = 'Сохранено ' + new Date().toLocaleTimeString('ru');
    return true;
  }

  $('save').addEventListener('click', save);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  });
  document.addEventListener('input', () => { dirty = true; });
  $('replyLangsDefault').addEventListener('click', () => {
    setReplyLangs(L.REPLY_LANGS_DEFAULT);
    dirty = true;
  });
  $('replyLangsAll').addEventListener('click', () => {
    setReplyLangs(replyCodes);
    dirty = true;
  });
  window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault();
  });

  // Если настройки поменялись из popup/пикера, пока страница открыта — подхватываем (если нет несохранённых правок)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings || dirty) return;
    settings = L.mergeSettings(changes.settings.newValue);
    render();
  });

  $('addSite').addEventListener('click', () => {
    collect();
    settings.sites.push(Object.assign({}, L.SITE_DEFAULTS, {
      id: 'site-' + Date.now().toString(36),
      urlPattern: 'https://'
    }));
    dirty = true;
    renderSites();
  });

  $('testCloud').addEventListener('click', async () => {
    if (!(await save())) return;
    if (!settings.googleCloudApiKey) {
      $('testOut').textContent = '⚠ Не задан Google Cloud API key';
      return;
    }
    $('testOut').textContent = '⏳ Проверяю Google Cloud…';
    const r = await chrome.runtime.sendMessage({ type: 'testProvider', provider: 'google-cloud', text: $('testText').value, tl: settings.targetLang });
    $('testOut').textContent = r.ok
      ? `✅ Резерв работает: Google Cloud · ${L.langName(r.result.detectedLang)} → ${L.langName(settings.targetLang)} · ${r.ms} мс\n${r.result.translation}` +
        (settings.fallbackToCloud ? '' : '\n⚠ Галочка «Резерв» выключена — при блокировке бесплатного Google переключения не будет')
      : '❌ Google Cloud: ' + r.error + '\nПроверьте ключ, что «Cloud Translation API» включён в проекте и у проекта есть оплата.';
  });

  // ---------- Встроенный переводчик Chrome ----------
  const toBcp = (c) => {
    const n = L.normLang(c);
    return n === 'zh-CN' ? 'zh' : n === 'zh-TW' ? 'zh-Hant' : L.baseLang(n);
  };
  const STATE_RU = { available: '✅ скачан', downloadable: '⬇ нужно скачать', downloading: '⏳ скачивается', unavailable: '— не поддерживается', unknown: '? браузер не ответил', checking: '⏳ проверяю…' };

  // Все нужные пары в ОБЕ стороны: язык собеседника ↔ язык перевода входящих (en)
  // и язык собеседника ↔ языки операторов (ru): ответ ru→es, обратный перевод es→ru
  function localPairs() {
    collect();
    // Английский — всегда: через него переводятся пары без прямого пакета (испанский → английский → корейский)
    const hubs = Array.from(new Set(['en', settings.targetLang, ...(settings.operatorLangs || []), settings.backTranslateLang].filter((x) => x && x !== 'auto').map(toBcp)));
    const pairs = [];
    const seen = new Set();
    const add = (a, b) => {
      if (!a || !b || a === b || seen.has(a + '>' + b)) return;
      seen.add(a + '>' + b);
      pairs.push([a, b]);
    };
    // языки собеседников + все включённые языки ответов
    const langs = new Set([...L.splitList($('localLangs').value), ...(settings.replyLangs || [])].map(toBcp));
    for (const l of langs) {
      for (const h of hubs) {
        add(l, h);
        add(h, l);
      }
    }
    // операторы ↔ английский (если оператор пишет по-английски или по-русски)
    for (const h of hubs) for (const h2 of hubs) add(h, h2);
    return pairs;
  }

  // ---------- Пакеты и модели: статус и ручное скачивание ----------
  // Chrome скачивает пакет только по клику (нужен жест пользователя), поэтому у каждой строки своя кнопка.
  // «Скачать все недостающие» запускает все загрузки сразу в обработчике клика — без await перед ними.
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  let packRows = []; // [{ s, t, state, progress }]

  function noApiText() {
    const env = globalThis.ST_ENV || { name: 'браузер' };
    return env.firefox || env.safari
      ? '❌ Перевод на устройстве есть только в Chrome и Edge (версия 138+). В ' + env.name + ' переводом занимается облачный провайдер — всё остальное работает как обычно.'
      : '❌ Встроенный переводчик недоступен в этой версии браузера (нужен Chrome или Edge 138+ на компьютере). Будет использоваться облачный провайдер.';
  }

  const STATE_ORDER = { downloadable: 0, downloading: 1, unknown: 2, checking: 3, unavailable: 4, available: 5 };

  function renderPacks() {
    const box = $('packs');
    box.textContent = '';
    if (!packRows.length) return;
    const count = (st) => packRows.filter((r) => r.state === st).length;
    const missing = count('downloadable') + count('downloading');
    const ready = count('available');
    const unknown = count('unknown');
    const checking = count('checking');
    $('localOut').textContent = checking
      ? '⏳ Проверяю пакеты… ' + (packRows.length - checking) + ' из ' + packRows.length
      : 'Пакетов: ' + packRows.length + ' · скачано: ' + ready + ' · нужно скачать: ' + missing +
        (unknown ? ' · браузер не ответил: ' + unknown + ' (можно скачать кнопкой или проверить ещё раз)' : '') +
        (missing || unknown ? ' — нажмите «Скачать» в строке или «Скачать все недостающие».' : ' — всё готово.');
    const sorted = packRows.slice().sort((a, b) => (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9));
    for (const r of sorted) {
      const row = document.createElement('div');
      row.className = 'pack ' + r.state;
      const name = document.createElement('span');
      name.textContent = L.langName(r.s) + ' → ' + L.langName(r.t);
      const st = document.createElement('span');
      st.className = 'st';
      st.textContent = r.progress || STATE_RU[r.state] || r.state;
      row.append(name, st);
      if (['downloadable', 'downloading', 'unknown'].includes(r.state)) {
        const b = document.createElement('button');
        b.className = 'small secondary';
        b.textContent = r.state === 'downloading' ? 'Докачать' : 'Скачать';
        b.disabled = /^⏳/.test(r.progress || '');
        b.addEventListener('click', () => downloadPacks([r]));
        row.appendChild(b);
      }
      box.appendChild(row);
    }
  }

  async function localCheck() {
    if (typeof Translator === 'undefined') {
      $('localOut').textContent = noApiText();
      $('packs').textContent = '';
      renderModels();
      return;
    }
    $('localOut').textContent = '⏳ Проверяю пакеты…';
    const pairs = localPairs();
    // Проверяем по 3 пары одновременно: на десятки параллельных запросов Chrome может не ответить
    packRows = pairs.map(([s, t]) => ({ s, t, state: 'checking', progress: '' }));
    renderPacks();
    let next = 0;
    const worker = async () => {
      while (next < packRows.length) {
        const r = packRows[next++];
        try { r.state = await withTimeout(Translator.availability({ sourceLanguage: r.s, targetLanguage: r.t }), 10000); } catch (e) { r.state = e.message === 'timeout' ? 'unknown' : 'unavailable'; }
        renderPacks();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    renderPacks();
    renderModels();
  }

  // Все create() стартуют синхронно в обработчике клика — иначе Chrome откажет без жеста пользователя
  function downloadPacks(rows) {
    for (const r of rows) {
      r.progress = '⏳ 0%';
      Translator.create({
        sourceLanguage: r.s,
        targetLanguage: r.t,
        monitor(m) {
          m.addEventListener('downloadprogress', (e) => {
            r.progress = '⏳ ' + Math.round((e.loaded || 0) * 100) + '%';
            renderPacks();
          });
        }
      }).then(
        () => { r.state = 'available'; r.progress = ''; renderPacks(); },
        (e) => { r.progress = '⚠ ' + ((e && e.message) || 'не скачалось'); renderPacks(); }
      );
    }
    renderPacks();
  }

  $('localCheck').addEventListener('click', localCheck);
  $('localDownload').addEventListener('click', () => {
    if (typeof Translator === 'undefined') return localCheck();
    const missing = packRows.filter((r) => ['downloadable', 'downloading', 'unknown'].includes(r.state));
    if (!packRows.length) {
      // Статус ещё не проверяли — запускаем все нужные пары (уже скачанные завершатся мгновенно)
      packRows = localPairs().map(([s, t]) => ({ s, t, state: 'downloadable', progress: '' }));
      downloadPacks(packRows);
      return;
    }
    if (!missing.length) {
      $('localOut').textContent = 'Все пакеты уже скачаны.';
      return;
    }
    downloadPacks(missing);
  });

  // --- Модели на устройстве: определение языка, языковая модель, пересказ ---
  const MODELS = [
    { id: 'LanguageDetector', name: 'Определение языка', note: 'маленькая, нужна для перевода на устройстве' },
    { id: 'LanguageModel', name: 'Языковая модель (Gemini Nano)', note: '~2 ГБ: «Исправить / Вежливее / Короче», «Кратко о тикете»' },
    { id: 'Summarizer', name: 'Пересказ (Summarizer)', note: 'та же модель: пересказ тикета без языковой модели' }
  ];
  const MODEL_RU = { available: '✅ скачана', downloadable: '⬇ нужно скачать', downloading: '⏳ скачивается', unavailable: '— недоступна на этом компьютере' };
  const modelProgress = {};

  async function renderModels() {
    const box = $('models');
    box.textContent = '';
    for (const m of MODELS) {
      const api = globalThis[m.id];
      let state = 'none';
      if (typeof api !== 'undefined') {
        try { state = await withTimeout(api.availability(), 5000); } catch (e) { state = 'unavailable'; }
      }
      const row = document.createElement('div');
      row.className = 'pack ' + state;
      const name = document.createElement('span');
      name.textContent = m.name;
      name.title = m.note;
      const st = document.createElement('span');
      st.className = 'st';
      st.textContent = modelProgress[m.id] || (state === 'none' ? 'нет в этом браузере' : MODEL_RU[state] || state);
      row.append(name, st);
      if (state === 'downloadable' || state === 'downloading') {
        const b = document.createElement('button');
        b.className = 'small secondary';
        b.textContent = state === 'downloading' ? 'Докачать' : 'Скачать';
        b.addEventListener('click', () => {
          modelProgress[m.id] = '⏳ 0%';
          st.textContent = modelProgress[m.id];
          b.disabled = true;
          api.create({
            monitor(mon) {
              mon.addEventListener('downloadprogress', (e) => {
                modelProgress[m.id] = '⏳ ' + Math.round((e.loaded || 0) * 100) + '%';
                st.textContent = modelProgress[m.id];
              });
            }
          }).then(
            (inst) => { try { inst.destroy(); } catch (e) { /* ignore */ } delete modelProgress[m.id]; renderModels(); },
            (e) => { modelProgress[m.id] = '⚠ ' + ((e && e.message) || 'не скачалась'); st.textContent = modelProgress[m.id]; b.disabled = false; }
          );
        });
        row.appendChild(b);
      }
      const note = document.createElement('span');
      note.className = 'note';
      note.textContent = m.note;
      row.appendChild(note);
      box.appendChild(row);
    }
  }
  renderModels();

  // --- Помощник: память переводов, локальная модель, расход Google Cloud ---
  async function tmInfo() {
    const { tm } = await chrome.storage.local.get('tm');
    return tm || {};
  }
  $('tmExport').addEventListener('click', async () => {
    const tm = await tmInfo();
    const rows = Object.values(tm).map((e) => ({ lang: e.l, translation: e.t, uses: e.n, at: new Date(e.at).toISOString() }));
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'support-translator-memory-' + L.today() + '.json';
    a.click();
    $('assistOut').textContent = 'Выгружено записей: ' + rows.length;
  });
  $('tmClear').addEventListener('click', async () => {
    const n = Object.keys(await tmInfo()).length;
    if (!confirm('Очистить память переводов (' + n + ' записей)?')) return;
    await chrome.storage.local.remove('tm');
    $('assistOut').textContent = 'Память переводов очищена.';
  });
  $('assistCheck').addEventListener('click', async () => {
    const out = [];
    const env = globalThis.ST_ENV || {};
    const state = async (api) => {
      if (typeof api === 'undefined') return 'нет в этом браузере (нужен Chrome или Edge 138+)';
      try {
        const s = await Promise.race([api.availability(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
        return { available: '✅ готова', downloadable: '⬇ нужно скачать (~2 ГБ, скачается при первом использовании)', downloading: '⏳ скачивается', unavailable: '❌ недоступна на этом компьютере' }[s] || s;
      } catch (e) {
        return e.message === 'timeout' ? 'нет ответа от браузера' : '❌ ' + e.message;
      }
    };
    out.push('Браузер: ' + (env.name || '?'));
    out.push('Языковая модель (Prompt API): ' + (await state(globalThis.LanguageModel)));
    out.push('Пересказ (Summarizer API): ' + (await state(globalThis.Summarizer)));
    out.push('Память переводов: ' + Object.keys(await tmInfo()).length + ' записей');
    out.push('Без модели работают: тема обращения по ключевым словам, пересказ по первым фразам, память переводов, быстрая вставка.');
    $('assistOut').textContent = out.join('\n');
  });
  chrome.runtime.sendMessage({ type: 'cloudUsage' }).then((r) => {
    const u = r && r.usage;
    if (!u) return;
    const pct = Math.round(u.share * 100);
    $('cloudUsageOut').textContent = 'В этом месяце через Google Cloud: ' + u.used.toLocaleString('ru') + ' символов (' + pct + '% лимита)' + (u.configured ? '' : ' · ключ не задан');
  }).catch(() => {});


  $('testBtn').addEventListener('click', async () => {
    if (!(await save())) return;
    $('testOut').textContent = '⏳ …';
    const t0 = performance.now();
    const r = await chrome.runtime.sendMessage({ type: 'translate', text: $('testText').value, sl: 'auto', tl: settings.targetLang });
    const ms = Math.round(performance.now() - t0);
    $('testOut').textContent = r.ok
      ? `✅ ${L.langName(r.result.detectedLang)} → ${L.langName(settings.targetLang)} · ${r.result.provider || ''} · ${r.result.fromCache ? 'кэш' : ms + ' мс'}\n${r.result.translation}`
      : '❌ ' + r.error;
  });

  $('glossaryTestBtn').addEventListener('click', async () => {
    if (!(await save())) return;
    const text = $('glossaryTest').value;
    const tl = $('glossaryTestLang').value;
    const p = globalThis.ST_GLOSSARY.protect(text, settings.glossary, tl);
    const entries = globalThis.ST_GLOSSARY.parse(settings.glossary);
    $('glossaryOut').textContent = '⏳ …';
    const r = await chrome.runtime.sendMessage({ type: 'translate', text, sl: 'auto', tl });
    $('glossaryOut').textContent =
      'Записей в глоссарии: ' + entries.length + '\n' +
      'Отправлено в переводчик: ' + p.text + '\n' +
      (r.ok ? 'Результат: ' + r.result.translation : '❌ ' + r.error);
  });

  $('clearCache').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'clearCache' });
    $('testOut').textContent = 'Кэш очищен';
  });

  $('export').addEventListener('click', () => {
    collect();
    const data = Object.assign({}, settings, { googleCloudApiKey: '' });
    data.sites = data.sites.map((s) => Object.assign({}, s, { lastOutgoingLang: undefined }));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'support-translator-settings.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const key = settings.googleCloudApiKey;
      settings = L.mergeSettings(data);
      if (!settings.googleCloudApiKey) settings.googleCloudApiKey = key;
      render();
      await save();
    } catch (err) {
      $('saved').textContent = '⚠ Не удалось импортировать: ' + err.message;
    }
    e.target.value = '';
  });

  render();
})();
