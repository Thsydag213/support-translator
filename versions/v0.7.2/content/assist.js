/*
 * Помощник агента на локальной языковой модели Chrome (Prompt API / Summarizer API, Chrome и Edge 138+).
 * Всё выполняется на устройстве: тексты не уходят в интернет, запросы бесплатные.
 *
 *  - rewrite(text, mode)  — исправить / вежливее / короче / дружелюбнее (модель работает с английским текстом;
 *                           перевод туда и обратно делает outgoing.js);
 *  - intent(text)         — тема обращения по ключевым словам на 12 языках (без модели, мгновенно);
 *  - openTicketPanel()    — «Кратко о тикете»: что хочет клиент, тема, настроение, краткий пересказ,
 *                           подходящие макросы. Без модели — по ключевым словам и первым фразам сообщений.
 *
 * Где выполняется модель: прямо на странице (если Chrome даёт API в content script) или через скрытую
 * страницу расширения (offscreen) — как у встроенного переводчика.
 */
(function () {
  const ST = globalThis.ST;
  if (ST.assist) return;
  const L = ST.L;

  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(label + ': нет ответа за ' + Math.round(ms / 1000) + ' с')), ms);
      Promise.resolve(promise).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  const enabled = () => ST.settings.assist !== false;
  const pageLM = () => typeof self.LanguageModel !== 'undefined' && typeof self.LanguageModel.create === 'function';
  const pageSum = () => typeof self.Summarizer !== 'undefined' && typeof self.Summarizer.create === 'function';

  // ---------- доступность модели ----------
  let infoCache = null;
  async function info() {
    if (infoCache && Date.now() - infoCache.at < 60000) return infoCache.v;
    const v = { prompt: 'none', summarizer: 'none', backend: '' };
    try {
      if (pageLM()) {
        v.prompt = await withTimeout(self.LanguageModel.availability(), 5000, 'LanguageModel');
        v.backend = 'page';
      }
      if (pageSum()) v.summarizer = await withTimeout(self.Summarizer.availability(), 5000, 'Summarizer');
    } catch (e) { /* пробуем мост */ }
    if (v.prompt !== 'available' || v.summarizer !== 'available') {
      try {
        const r = await withTimeout(ST.send({ type: 'llmInfo' }), 10000, 'Мост модели');
        if (r && r.ok) {
          if (v.prompt !== 'available' && r.info.prompt !== 'none') { v.prompt = r.info.prompt; v.backend = 'bridge'; }
          if (v.summarizer !== 'available' && r.info.summarizer !== 'none') v.summarizer = r.info.summarizer;
        }
      } catch (e) { /* моста нет (Firefox, Safari) */ }
    }
    infoCache = { at: Date.now(), v };
    return v;
  }

  const STATE_RU = {
    available: 'готова',
    downloadable: 'нужно скачать модель (Chrome скачает её при первом использовании, ~2 ГБ)',
    downloading: 'модель скачивается',
    unavailable: 'недоступна на этом компьютере',
    none: 'нет в этом браузере (нужен Chrome или Edge 138+)'
  };
  function explain(state) {
    return STATE_RU[state] || state;
  }

  // ---------- вызовы модели ----------
  async function prompt(system, text, schema) {
    if (!enabled()) throw new Error('Помощник выключен в настройках');
    const i = await info();
    if (i.prompt === 'none' || i.prompt === 'unavailable') throw new Error('Локальная модель ' + explain(i.prompt));
    if (i.backend === 'page') {
      const s = await withTimeout(self.LanguageModel.create({ initialPrompts: [{ role: 'system', content: system }] }), 120000, 'Загрузка модели');
      try {
        return await withTimeout(s.prompt(text, schema ? { responseConstraint: schema } : undefined), 90000, 'Модель');
      } finally {
        try { s.destroy(); } catch (e) { /* ignore */ }
      }
    }
    const r = await withTimeout(ST.send({ type: 'llmPrompt', system, text, schema }), 180000, 'Модель');
    if (!r || !r.ok) throw new Error((r && r.error) || 'модель не ответила');
    return r.text;
  }

  async function summarize(text) {
    const i = await info();
    if (i.summarizer !== 'available' && i.summarizer !== 'downloadable') throw new Error('Summarizer ' + explain(i.summarizer));
    if (pageSum()) {
      const s = await withTimeout(self.Summarizer.create({ type: 'tldr', format: 'plain-text', length: 'short' }), 120000, 'Загрузка модели');
      try { return await withTimeout(s.summarize(text), 90000, 'Summarizer'); } finally { try { s.destroy(); } catch (e) { /* ignore */ } }
    }
    const r = await withTimeout(ST.send({ type: 'llmSummarize', text, kind: 'tldr', length: 'short' }), 180000, 'Summarizer');
    if (!r || !r.ok) throw new Error((r && r.error) || 'модель не ответила');
    return r.text;
  }

  // ---------- правка текста ответа ----------
  const MODES = {
    fix: { label: '✨ Исправить', ru: 'исправлена грамматика', task: 'Fix grammar, spelling and punctuation. Keep the meaning, tone and length.' },
    polite: { label: '🙂 Вежливее', ru: 'вежливее', task: 'Make it more polite, warm and professional for a customer support reply. Keep all facts.' },
    short: { label: '✂ Короче', ru: 'короче', task: 'Make it shorter and clearer. Keep all facts, numbers, links and requests.' },
    friendly: { label: '😊 Проще', ru: 'проще и дружелюбнее', task: 'Make it simpler and friendlier, in plain everyday language. Keep all facts.' }
  };

  // ---------- имя агента ----------
  // Берём ТОЛЬКО из текущего черновика ответа (оригинал оператора и его английский перевод).
  // Прошлые ответы в тикете не смотрим: их писали другие агенты с другими именами.
  // Вводная фраза — без учёта регистра; само имя — строго с заглавной (иначе «John and» считалось бы именем).
  // after — что должно идти после имени, чтобы «I am Sorry…» не считалось представлением
  const NAME = /^(\p{Lu}[\p{Ll}'’-]+(?:[ -]\p{Lu}[\p{Ll}'’-]+)?)/u;
  const NAME_LEADS = [
    ['my name is'], ["i'm|i am", /^(?:\s+(?:from|with|at|and|here)\b|[,.!])/], ['this is', /^\s+(?:from|with|at)\b/],
    ['меня зовут'], ['с вами', /^[,.!]/], ['mi nombre es'], ['me llamo'], ['meu nome é'], ['me chamo'],
    ["je m'appelle"], ['je suis', /^(?:\s+de\b|[,.!])/], ['mein name ist'], ['ich heiße'], ['mi chiamo'], ['il mio nome è']
  ].map(([lead, after]) => ({ re: new RegExp('(?:^|[^\\p{L}])(?:' + lead + ')\\s+', 'giu'), after }));
  // Подпись в конце: «Best regards,\nTom» / «С уважением,\nАнна»
  const SIGN_OFF = /(?:best regards|kind regards|warm regards|regards|best wishes|sincerely|cheers|thanks|thank you|many thanks|с уважением|всего доброго|спасибо|saludos(?: cordiales)?|atentamente|atenciosamente|cordialement|mit freundlichen grüßen|viele grüße|cordiali saluti|distinti saluti)\s*[,!.]?\s*\n+\s*([^\n]{2,60})\s*$/iu;
  const PLACEHOLDER_NAME = /\[(?:your|agent|author|my)[ _-]?name\]|\{\{?\s*(?:agent|author)[ _-]?name\s*\}?\}|<(?:your|agent) name>|\bAuthor name\b/gi;
  const NON_NAMES = /^(team|support|customer|the|a|an|we|here|happy|glad|sorry|writing|reaching|back|available)$/i;

  // Все имена агента в тексте: из вводных фраз и из подписи (в порядке появления)
  function agentNames(text) {
    const t = String(text || '');
    const found = [];
    for (const { re, after } of NAME_LEADS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(t))) {
        const rest = t.slice(m.index + m[0].length);
        const nm = NAME.exec(rest);
        if (!nm || NON_NAMES.test(nm[1].split(/[ -]/)[0])) continue;
        // «Tom Smith and» → берём имя без хвоста; проверяем, что после имени идёт то, что нужно
        const name = nm[1];
        if (after && !after.test(rest.slice(name.length))) continue;
        found.push(name.trim());
      }
    }
    const s = SIGN_OFF.exec(t.trim());
    if (s) {
      const line = s[1].trim();
      // «Tom», «Anna K.», «Tom from Support» → имя; «The Support Team» → не имя агента
      const nm = /^(\p{Lu}[\p{Ll}'’-]+(?: \p{Lu}[\p{Ll}'’.-]*)?)(?:\s+(?:from|at|—|-|\|).*)?$/u.exec(line);
      if (nm && !NON_NAMES.test(nm[1].split(' ')[0]) && !/team|support|команда|поддержк/i.test(line)) found.push(nm[1].trim());
    }
    return Array.from(new Set(found));
  }

  function agentName(text) {
    return agentNames(text)[0] || '';
  }

  function teamSignature() {
    return String(ST.settings.teamSignature || '').trim() || 'Support Team';
  }

  // Модель иногда подставляет своё имя или заглушку «[Your Name]» — исправляем после ответа
  function fixNames(out, expected) {
    const team = teamSignature();
    let t = String(out || '').replace(PLACEHOLDER_NAME, expected || team);
    // Модель может подставить разные имена во вводной фразе и в подписи — исправляем, пока чужих имён не останется
    for (let i = 0; i < 4; i++) {
      const got = agentNames(t).find((n) => n !== expected);
      if (!got) break;
      const esc = got.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const word = new RegExp('(?<![\\p{L}])' + esc + '(?![\\p{L}])', 'gu');
      if (expected) {
        t = t.replace(word, expected);
      } else {
        // Имени в черновике не было: представление «My name is X (from …)» убираем, подпись заменяем на команду
        t = t.replace(new RegExp("(?:my name is|i'm|i am|this is)\\s+" + esc + '(?:\\s+from [^.,!\\n]+)?\\s*[.,!]?\\s*', 'giu'), '')
          .replace(new RegExp('(?<![\\p{L}])' + esc + '(?:\\s+from [^\\n]+)?\\s*$', 'u'), team)
          .replace(word, team)
          // после удалённой фразы «My name is …» предложение может начаться со строчной
          .replace(/([.!?]\s+)(\p{Ll})/gu, (m, a, b) => a + b.toUpperCase());
      }
    }
    return t.replace(/[ \t]+\n/g, '\n').replace(/([!.?,])[ \t]{2,}/g, '$1 ').trim();
  }

  async function rewrite(englishText, mode, original) {
    const m = MODES[mode] || MODES.fix;
    const expected = agentName(original) || agentName(englishText);
    const team = teamSignature();
    const nameRule = expected
      ? 'The agent who writes this reply is named "' + expected + '". If the text introduces the agent or has a sign-off, use exactly "' + expected + '". Never use any other person\'s name for the agent. '
      : 'The text does not name the agent. Do not add any personal name for the agent and do not introduce the agent by name. ' +
        'If the text has a sign-off or introduces the sender, use "' + team + '" instead of a personal name. Do not add a sign-off if there is none. ';
    const system =
      'You edit replies written by customer support agents. ' + m.task + ' ' + nameRule +
      'Never add new facts, promises, prices or links. Keep every URL, email, number, amount, date, code and placeholder (like ⟦0⟧ or {{name}}) exactly as is. ' +
      'Keep line breaks and list markers. Answer in English with the edited text only, no comments or quotes.';
    const out = await prompt(system, englishText);
    return fixNames(String(out || '').replace(/^["«]|["»]$/g, '').trim(), expected);
  }

  // ---------- тема обращения (без модели) ----------
  // Ключевые слова: английский, испанский, португальский, французский, немецкий, итальянский, русский, украинский, китайский,
  // турецкий, корейский, японский, арабский. Ищем и в оригинале, и в английском переводе.
  const INTENTS = [
    { id: 'refund', label: 'Возврат денег', re: /refund|money back|reimburs|reembols|devoluc|devolv|rembours|rückerstatt|zurückerstatt|geld zurück|rimbors|restitu|возврат|верн[иуё]те деньги|повернення|iade|환불|返金|返品|استرداد|استرجاع/i },
    { id: 'cancel', label: 'Отмена подписки', re: /cancel|unsubscri|stop (my )?subscription|cancelar|anular|darme de baja|annul|résili|resili|kündig|disdire|disdetta|отмен|отпис|скасув|iptal|해지|취소|解約|キャンセル|退会|إلغاء/i },
    { id: 'charge', label: 'Списание / оплата', re: /charg|billed|payment|debit|cobr|pago|cargo|débit|prélev|paiement|abgebucht|zahlung|abbuchung|addebit|pagament|списа|оплат|плат[её]ж|списан|ödeme|결제|청구|請求|支払|引き落とし|خصم|دفع|رسوم/i },
    { id: 'access', label: 'Вход в аккаунт', re: /log ?in|sign ?in|password|can'?t (access|enter|get in)|locked out|verification code|token|acces|no puedo (entrar|acceder)|entrar en mi cuenta|acessar|não consigo entrar|entrer|einloggen|anmelden|accedere|contraseña|iniciar sesi|senha|mot de passe|connexion|anmeld|passwort|accedere|войти|вход|парол|увійти|giriş|şifre|로그인|비밀번호|ログイン|パスワード|تسجيل الدخول|كلمة المرور/i },
    { id: 'bug', label: 'Техническая проблема', re: /error|bug|not work|doesn'?t work|crash|broken|no funciona|falla|não funciona|ne (fonctionne|marche) pas|funktioniert nicht|fehler|non funziona|не работает|ошибк|не працює|hata|çalışmıyor|오류|안 돼|エラー|動かない|خطأ|لا يعمل/i },
    { id: 'delete', label: 'Удаление аккаунта / данных', re: /delete (my )?(account|data)|remove my (account|data)|eliminar (mi )?cuenta|borrar|supprimer (mon )?compte|konto löschen|daten löschen|cancellare (il mio )?account|удал(ить|ите) (аккаунт|учетн|учётн|данные)|hesab(ımı)? sil|계정 삭제|アカウント削除|حذف (الحساب|حسابي)/i },
    { id: 'plan', label: 'Вопрос о подписке / тарифе', re: /subscription|plan|trial|upgrade|downgrade|suscrip|assinatura|abonnement|abo\b|abbonamento|подписк|тариф|пробн|підписк|abonelik|구독|サブスク|プラン|اشتراك/i },
    { id: 'thanks', label: 'Благодарность / можно закрыть', re: /^(thanks?|thank you|gracias|obrigad|merci|danke|grazie|спасибо|дякую|teşekkür|감사|ありがとう|شكرا)[\s!.,]*$/im }
  ];

  // Китайский (упрощённый и традиционный) — отдельно: в иероглифах нет границ слов
  const INTENTS_ZH = {
    refund: /退款|退钱|退費|退费|退還|退还/g,
    cancel: /取消|退订|退訂|解约|解約|停止订阅|停止訂閱/g,
    charge: /扣款|扣费|扣費|收费|收費|付款|支付|被扣|重复扣|重複扣/g,
    access: /登录|登入|登錄|密码|密碼|验证码|驗證碼|无法进入|無法進入/g,
    bug: /错误|錯誤|报错|報錯|无法使用|無法使用|不能用|打不开|打不開|故障|闪退|閃退/g,
    delete: /删除(账户|账号|数据)|刪除(帳戶|帳號|資料)|注销|註銷/g,
    plan: /订阅|訂閱|套餐|会员|會員|试用|試用/g,
    thanks: /^\s*(谢谢|謝謝|感谢|感謝)[\s!！。.]*$/gm
  };

  function intent(text) {
    const t = String(text || '');
    const scores = INTENTS.map((x) => ({ x, n: (t.match(new RegExp(x.re.source, 'gi' + (x.re.flags.includes('m') ? 'm' : ''))) || []).length + (t.match(INTENTS_ZH[x.id]) || []).length }))
      .filter((s) => s.n > 0)
      .sort((a, b) => b.n - a.n);
    if (!scores.length) return null;
    // «Подписка» — фон почти любого тикета: уступает более конкретной теме
    const top = scores.find((s) => s.x.id !== 'plan') || scores[0];
    return { id: top.x.id, label: top.x.label, others: scores.filter((s) => s !== top).map((s) => s.x.label) };
  }

  // Макросы для темы из настроек: «refund: ref recur, ref ups» (ключ — id темы или её название)
  function macrosFor(intentId) {
    const res = [];
    for (const line of String(ST.settings.intentMacros || '').split('\n')) {
      const m = /^\s*([^:#]+?)\s*:\s*(.+)$/.exec(line);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const it = INTENTS.find((x) => x.id === key || x.label.toLowerCase() === key);
      if (it && it.id === intentId) res.push(...L.splitList(m[2]));
    }
    return res;
  }

  // Тема текущего тикета — для кнопки у поля ввода (кэш по тикету и тексту)
  let intentCache = { key: '', v: null };
  function currentIntent() {
    if (!enabled() || !ST.incoming || !ST.incoming.ticketDigest) return null;
    const d = ST.incoming.ticketDigest().filter((m) => m.role === 'user');
    if (!d.length) return null;
    const text = d.map((m) => m.text + '\n' + (m.en || '')).join('\n');
    const key = ST.ticketKey() + '|' + L.hash(text);
    if (intentCache.key !== key) intentCache = { key, v: intent(text) };
    return intentCache.v;
  }

  // ---------- «Кратко о тикете» ----------
  const SUMMARY_SCHEMA = {
    type: 'object',
    properties: {
      request: { type: 'string' },
      summary: { type: 'string' },
      intent: { type: 'string', enum: INTENTS.map((x) => x.id).concat(['other']) },
      mood: { type: 'string', enum: ['calm', 'confused', 'upset', 'angry'] }
    },
    required: ['request', 'summary', 'intent', 'mood']
  };
  const MOOD_RU = { calm: '😌 спокоен', confused: '🤔 не понимает', upset: '😟 расстроен', angry: '😠 зол' };

  function digestText(digest) {
    let out = '';
    for (const m of digest.slice(-30)) {
      const line = (m.role === 'user' ? 'Customer: ' : 'Agent: ') + (m.en || m.text).replace(/\s+/g, ' ').trim();
      out += line.slice(0, 1200) + '\n';
    }
    return out.slice(-8000);
  }

  // Без модели: первые фразы последних сообщений клиента
  function extractive(digest) {
    const user = digest.filter((m) => m.role === 'user').slice(-3);
    return user.map((m) => {
      const t = (m.en || m.text).replace(/\s+/g, ' ').trim();
      const first = (t.match(/^.{20,220}?[.!?](\s|$)/) || [t.slice(0, 220)])[0];
      return '• ' + first.trim();
    }).join('\n');
  }

  async function analyzeTicket() {
    const digest = ST.incoming && ST.incoming.ticketDigest ? ST.incoming.ticketDigest() : [];
    const user = digest.filter((m) => m.role === 'user');
    const langs = Array.from(new Set(user.map((m) => m.lang).filter(Boolean)));
    const base = {
      langs,
      messages: digest.length,
      intent: intent(user.map((m) => m.text + '\n' + (m.en || '')).join('\n')),
      summary: '',
      request: '',
      mood: '',
      source: ''
    };
    if (!user.length) return Object.assign(base, { source: 'none' });
    const conv = digestText(digest);
    try {
      const raw = await prompt(
        'You help customer support agents. Read the conversation between a customer and support agents. ' +
          'Return JSON: "request" — what the customer wants right now (one short sentence); "summary" — 2-3 sentences with the key facts ' +
          '(dates, amounts, what was already done by support); "intent" — the main topic; "mood" — the customer mood. Answer in English.',
        conv,
        SUMMARY_SCHEMA
      );
      const j = JSON.parse(raw);
      const it = INTENTS.find((x) => x.id === j.intent);
      return Object.assign(base, {
        request: j.request || '',
        summary: j.summary || '',
        mood: MOOD_RU[j.mood] || '',
        intent: it ? { id: it.id, label: it.label, others: [] } : base.intent,
        source: 'model'
      });
    } catch (e1) {
      try {
        const s = await summarize(conv);
        return Object.assign(base, { summary: s, source: 'summarizer', note: e1.message });
      } catch (e2) {
        return Object.assign(base, { summary: extractive(digest), source: 'keywords', note: e1.message });
      }
    }
  }

  let panel = null;
  function closePanel() {
    if (panel) panel.remove();
    panel = null;
  }

  async function openTicketPanel() {
    if (!ST.site) return ST.toast('Для этого сайта не настроено правило перевода', { error: true });
    closePanel();
    const host = ST.h('div', { [ST.UI_ATTR]: 'insight' });
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host{all:initial}
        ${ST.outgoing.THEME_CSS}
        .box{position:fixed;z-index:2147483647;right:16px;top:72px;width:min(420px,calc(100vw - 32px));max-height:calc(100vh - 96px);overflow:auto;
          background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow);
          font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;padding:14px}
        header{display:flex;align-items:center;gap:8px;margin-bottom:10px}
        header b{font-size:14px;margin-right:auto}
        .chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
        .chip{background:var(--infobg);color:var(--infofg);border-radius:999px;padding:2px 10px;font-size:12px}
        .cap{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:10px 0 4px}
        .txt{white-space:pre-wrap}
        .macro{display:inline-block;margin:2px 6px 2px 0;padding:2px 8px;border:1px dashed var(--border);border-radius:6px;cursor:pointer;background:var(--soft)}
        .muted{color:var(--muted);font-size:12px}
        button{font:600 12px/1 system-ui,sans-serif;padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--fg);cursor:pointer}
        .x{border:none;font-size:16px;padding:2px 6px}
        footer{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
      </style>
      <div class="box" role="dialog" aria-label="Кратко о тикете">
        <header><b>🧠 Кратко о тикете</b><button class="x" id="x" title="Закрыть (Esc)">✕</button></header>
        <div id="body" class="muted">⏳ Анализирую сообщения…</div>
        <footer><button id="copy">Копировать</button><button id="again">Обновить</button></footer>
      </div>`;
    document.documentElement.appendChild(host);
    panel = host;
    const $ = (id) => shadow.getElementById(id);
    if (ST.uiDark(ST.outgoing.lastField() || document.body)) shadow.querySelector('.box').classList.add('dark');
    $('x').addEventListener('click', closePanel);
    host.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); e.stopPropagation(); });

    let plain = '';
    const run = async () => {
      $('body').className = 'muted';
      $('body').textContent = '⏳ Анализирую сообщения…';
      const a = await analyzeTicket();
      if (!panel) return;
      const body = $('body');
      body.className = '';
      body.textContent = '';
      if (a.source === 'none') {
        body.className = 'muted';
        body.textContent = 'Сообщений клиента не найдено. Проверьте «Сообщение пользователя» в правиле сайта или откройте переписку.';
        return;
      }
      const chips = ST.h('div', { class: 'chips' });
      if (a.intent) chips.appendChild(ST.h('span', { class: 'chip' }, '🏷 ' + a.intent.label));
      if (a.langs.length) chips.appendChild(ST.h('span', { class: 'chip' }, '🌐 ' + a.langs.map((l) => L.langName(l)).join(', ')));
      if (a.mood) chips.appendChild(ST.h('span', { class: 'chip' }, a.mood));
      chips.appendChild(ST.h('span', { class: 'chip' }, '✉ ' + a.messages));
      body.appendChild(chips);
      if (a.request) {
        body.appendChild(ST.h('div', { class: 'cap' }, 'Что хочет клиент'));
        body.appendChild(ST.h('div', { class: 'txt' }, a.request));
      }
      if (a.summary) {
        body.appendChild(ST.h('div', { class: 'cap' }, 'Кратко'));
        body.appendChild(ST.h('div', { class: 'txt' }, a.summary));
      }
      const macros = a.intent ? macrosFor(a.intent.id) : [];
      body.appendChild(ST.h('div', { class: 'cap' }, 'Подходящие макросы'));
      if (macros.length) {
        const wrap = ST.h('div');
        for (const m of macros) {
          wrap.appendChild(ST.h('span', { class: 'macro', title: 'Скопировать для поиска макроса', onclick: () => { navigator.clipboard.writeText(m); ST.toast('Скопировано: ' + m); } }, m));
        }
        body.appendChild(wrap);
      } else {
        body.appendChild(ST.h('div', { class: 'muted' }, a.intent ? 'Для темы «' + a.intent.label + '» макросы не заданы — настройки → «Помощник» → «Макросы для тем».' : 'Тема не определена.'));
      }
      const SRC = {
        model: 'Локальная модель Chrome (на устройстве).',
        summarizer: 'Summarizer Chrome (на устройстве); тема — по ключевым словам.',
        keywords: 'Без модели: тема по ключевым словам, пересказ — первые фразы сообщений клиента.'
      };
      body.appendChild(ST.h('div', { class: 'muted', style: 'margin-top:10px' }, (SRC[a.source] || '') + (a.note && a.source !== 'model' ? ' Модель: ' + a.note : '')));
      plain = [
        a.intent ? 'Тема: ' + a.intent.label : '',
        a.langs.length ? 'Язык: ' + a.langs.map((l) => L.langName(l)).join(', ') : '',
        a.request ? 'Запрос: ' + a.request : '',
        a.summary ? 'Кратко: ' + a.summary : ''
      ].filter(Boolean).join('\n');
    };
    $('again').addEventListener('click', run);
    $('copy').addEventListener('click', () => { navigator.clipboard.writeText(plain); ST.toast('Скопировано'); });
    run();
  }

  ST.assist = { info, explain, rewrite, agentName, fixNames, MODES, intent, currentIntent, macrosFor, analyzeTicket, openTicketPanel, closePanel };
})();
