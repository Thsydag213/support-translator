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
  const GLOBAL_CHECKBOXES = ['outgoingButton', 'fallbackToCloud', 'batchRequests', 'onlyVisible', 'checkNumbers', 'spellCheck', 'listBadges', 'listBadgesUseNetwork'];
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
  const STATE_RU = { available: '✅ скачан', downloadable: '⬇ нужно скачать', downloading: '⏳ скачивается', unavailable: '— не поддерживается' };

  // Все нужные пары в ОБЕ стороны: язык собеседника ↔ язык перевода входящих (en)
  // и язык собеседника ↔ языки операторов (ru): ответ ru→es, обратный перевод es→ru
  function localPairs() {
    collect();
    const hubs = Array.from(new Set([settings.targetLang, ...(settings.operatorLangs || []), settings.backTranslateLang].filter((x) => x && x !== 'auto').map(toBcp)));
    const pairs = [];
    const seen = new Set();
    const add = (a, b) => {
      if (!a || !b || a === b || seen.has(a + '>' + b)) return;
      seen.add(a + '>' + b);
      pairs.push([a, b]);
    };
    for (const l of L.splitList($('localLangs').value).map(toBcp)) {
      for (const h of hubs) {
        add(l, h);
        add(h, l);
      }
    }
    // операторы ↔ английский (если оператор пишет по-английски или по-русски)
    for (const h of hubs) for (const h2 of hubs) add(h, h2);
    return pairs;
  }

  async function localCheck() {
    if (typeof Translator === 'undefined') {
      $('localOut').textContent = '❌ Встроенный переводчик недоступен в этой версии Chrome (нужен Chrome 138+ на компьютере). Будет использоваться облачный провайдер.';
      return;
    }
    const lines = [];
    for (const [s, t] of localPairs()) {
      let st;
      try { st = await Promise.race([Translator.availability({ sourceLanguage: s, targetLanguage: t }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]); } catch (e) { st = e.message === 'timeout' ? 'нет ответа от браузера' : 'unavailable'; }
      lines.push(L.langName(s) + ' → ' + L.langName(t) + ': ' + (STATE_RU[st] || st));
    }
    if (typeof LanguageDetector !== 'undefined') {
      let d;
      try { d = await Promise.race([LanguageDetector.availability(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]); } catch (e) { d = e.message === 'timeout' ? 'нет ответа от браузера' : 'unavailable'; }
      lines.push('Определение языка: ' + (STATE_RU[d] || d));
    }
    $('localOut').textContent = lines.join('\n');
  }

  $('localCheck').addEventListener('click', localCheck);

  // Скачивание требует клика: все create() запускаются сразу в обработчике, без await перед ними
  $('localDownload').addEventListener('click', () => {
    if (typeof Translator === 'undefined') return localCheck();
    const pairs = localPairs();
    const progress = {};
    const render = () => {
      $('localOut').textContent = pairs.map(([s, t]) => L.langName(s) + ' → ' + L.langName(t) + ': ' + (progress[s + '>' + t] || '⏳')).join('\n');
    };
    const jobs = pairs.map(([s, t]) =>
      Translator.create({
        sourceLanguage: s,
        targetLanguage: t,
        monitor(m) {
          m.addEventListener('downloadprogress', (e) => {
            progress[s + '>' + t] = '⏳ ' + Math.round((e.loaded || 0) * 100) + '%';
            render();
          });
        }
      }).then(() => { progress[s + '>' + t] = '✅ готово'; }, (e) => { progress[s + '>' + t] = '— ' + (e && e.message ? e.message : 'недоступно'); })
    );
    if (typeof LanguageDetector !== 'undefined') jobs.push(LanguageDetector.create().catch(() => {}));
    render();
    Promise.all(jobs).then(render);
  });

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
