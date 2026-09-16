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

  let settings = L.mergeSettings((await chrome.storage.local.get('settings')).settings);

  function renderSites() {
    const box = $('sites');
    box.innerHTML = '';
    settings.sites.forEach((site, i) => {
      const node = $('siteTpl').content.firstElementChild.cloneNode(true);
      node.querySelectorAll('[data-f]').forEach((inp) => {
        const f = inp.dataset.f;
        if (inp.type === 'checkbox') inp.checked = site[f] !== false;
        else inp.value = site[f] || '';
      });
      node.querySelector('[data-act="del"]').addEventListener('click', () => {
        if (!confirm('Удалить правило «' + (site.name || site.urlPattern) + '»?')) return;
        collect();
        settings.sites.splice(i, 1);
        renderSites();
      });
      node.dataset.index = i;
      box.appendChild(node);
    });
  }

  function render() {
    $('targetLang').value = settings.targetLang;
    $('skipLangs').value = settings.skipLangs.join(', ');
    $('displayMode').value = settings.displayMode;
    $('minChars').value = settings.minChars;
    $('fallbackOutgoingLang').value = settings.fallbackOutgoingLang;
    $('backTranslateLang').value = settings.backTranslateLang;
    $('outgoingButton').checked = settings.outgoingButton;
    $('provider').value = settings.provider;
    $('googleCloudApiKey').value = settings.googleCloudApiKey;
    $('fallbackToCloud').checked = settings.fallbackToCloud;
    renderSites();
  }

  function collect() {
    settings.targetLang = $('targetLang').value;
    settings.skipLangs = $('skipLangs').value.split(',').map((x) => L.normLang(x)).filter(Boolean);
    settings.displayMode = $('displayMode').value;
    settings.minChars = Math.max(1, parseInt($('minChars').value, 10) || 3);
    settings.fallbackOutgoingLang = $('fallbackOutgoingLang').value;
    settings.backTranslateLang = $('backTranslateLang').value;
    settings.outgoingButton = $('outgoingButton').checked;
    settings.provider = $('provider').value;
    settings.googleCloudApiKey = $('googleCloudApiKey').value.trim();
    settings.fallbackToCloud = $('fallbackToCloud').checked;
    document.querySelectorAll('#sites .site').forEach((node) => {
      const site = settings.sites[+node.dataset.index];
      node.querySelectorAll('[data-f]').forEach((inp) => {
        site[inp.dataset.f] = inp.type === 'checkbox' ? inp.checked : inp.value.trim();
      });
    });
  }

  function validate() {
    for (const s of settings.sites) {
      for (const f of ['containerSelector', 'messageSelector', 'inputSelector']) {
        if (!s[f]) continue;
        try {
          document.createDocumentFragment().querySelector(s[f]);
        } catch (e) {
          return 'Ошибка в селекторе «' + s[f] + '» (' + (s.name || s.urlPattern) + ')';
        }
      }
    }
    return '';
  }

  async function save() {
    collect();
    const err = validate();
    if (err) {
      $('saved').textContent = '⚠ ' + err;
      return;
    }
    await chrome.storage.local.set({ settings });
    $('saved').textContent = 'Сохранено ' + new Date().toLocaleTimeString('ru');
  }

  $('save').addEventListener('click', save);

  $('addSite').addEventListener('click', () => {
    collect();
    settings.sites.push({
      id: 'site-' + Date.now().toString(36),
      name: 'Новый сайт',
      enabled: true,
      urlPattern: 'https://*/*',
      containerSelector: '',
      messageSelector: '',
      inputSelector: ''
    });
    renderSites();
  });

  $('testBtn').addEventListener('click', async () => {
    await save();
    $('testOut').textContent = '⏳ …';
    const t0 = performance.now();
    const r = await chrome.runtime.sendMessage({ type: 'translate', text: $('testText').value, sl: 'auto', tl: settings.targetLang });
    const ms = Math.round(performance.now() - t0);
    $('testOut').textContent = r.ok
      ? `✅ ${L.langName(r.result.detectedLang)} → ${L.langName(settings.targetLang)} · ${r.result.provider || ''} · ${r.result.fromCache ? 'кэш' : ms + ' мс'}\n${r.result.translation}`
      : '❌ ' + r.error;
  });

  $('clearCache').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'clearCache' });
    $('testOut').textContent = 'Кэш очищен';
  });

  $('export').addEventListener('click', () => {
    collect();
    const data = Object.assign({}, settings, { googleCloudApiKey: '' });
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
