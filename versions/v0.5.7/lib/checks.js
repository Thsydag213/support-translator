/*
 * Проверки перевода исходящего сообщения (без сети, детерминированные):
 *   compareFacts(original, translation) — числа/суммы/валюты/ссылки/почты должны совпадать;
 *   informalMarkers(text, lang) — слова обращения на "ты" в переводе (для поддержки обычно нужна вежливая форма);
 *   politeRu(text) — "вы/вас/ваш…" -> "Вы/Вас/Ваш…" (заглавная форма подсказывает переводчику вежливое обращение).
 */
(function () {
  // ---------- Числа, валюты, ссылки ----------
  const URL_RE = /https?:\/\/[^\s<>"'«»)]+/gi;
  const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
  const NUM_RE = /\d[\d\s  .,]*\d|\d/g;
  const CURRENCY_CODES = /\b(USD|EUR|GBP|RUB|TRY|BRL|MXN|ARS|COP|CLP|PEN|UAH|KZT|PLN|INR|CAD|AUD|CHF|JPY|CNY)\b/gi;
  const CURRENCY_SYMBOLS = /[$€£₽₺¥₹₴₸]/g;

  const trimUrl = (u) => u.replace(/[.,;:!?]+$/, '');

  // "1 234,50" / "1,234.50" / "34.99" / "34,99" -> "1234.5" / "34.99"
  function normalizeNumber(raw) {
    const s = raw.replace(/[\s  ]/g, '');
    let out;
    if (/^\d{1,3}([.,]\d{3})+$/.test(s)) {
      out = s.replace(/[.,]/g, ''); // разделители тысяч
    } else {
      const m = /^(.*?)[.,](\d{1,2})$/.exec(s);
      out = m ? m[1].replace(/[.,]/g, '') + '.' + m[2] : s.replace(/[.,]/g, '');
    }
    const n = parseFloat(out);
    return Number.isFinite(n) ? String(n) : out;
  }

  // Цельное число/сумма: "34", "34,99", "1 234,50", "1,234.50", "1.234.567"
  const WHOLE_NUMBER = /^(\d+|\d{1,3}([.,\s  ]\d{3})+)([.,]\d{1,2})?$/;

  function numbers(text) {
    const out = [];
    for (const m of text.matchAll(NUM_RE)) {
      const token = m[0].replace(/[\s  .,]+$/, '');
      if (WHOLE_NUMBER.test(token)) {
        out.push(normalizeNumber(token));
      } else {
        // Даты, версии, перечисления: "17.09.2026", "1.2.3", "5 10" — форматы в языках разные, сравниваем по частям
        token.split(/[.,\s  ]+/).forEach((p) => p && out.push(normalizeNumber(p)));
      }
    }
    return out;
  }

  // Телефоны: "+7 999 123-45-67", "(495) 123-45-67" — форматирование разное, сравниваем только цифры
  const PHONE_RE = /(?:\+\d[\d\s ().-]{5,}\d|\(?\d{2,4}\)?[\s .-]?\d{2,4}-\d{2}(?:-\d{2})?)/g;

  function extractFacts(text) {
    text = String(text || '');
    const urls = (text.match(URL_RE) || []).map(trimUrl);
    const emails = (text.match(EMAIL_RE) || []).map((e) => e.toLowerCase());
    let rest = text.replace(URL_RE, ' ').replace(EMAIL_RE, ' ');
    const phones = (rest.match(PHONE_RE) || []).map((p) => p.replace(/\D/g, '')).filter((d) => d.length >= 7);
    rest = rest.replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 7 ? ' ' : m));
    return {
      urls,
      emails,
      phones,
      numbers: numbers(rest),
      codes: (rest.match(CURRENCY_CODES) || []).map((c) => c.toUpperCase()),
      symbols: rest.match(CURRENCY_SYMBOLS) || []
    };
  }

  // Разность мультимножеств: что есть в a, но не в b
  function missing(a, b) {
    const left = b.slice();
    const out = [];
    for (const x of a) {
      const i = left.indexOf(x);
      if (i === -1) out.push(x);
      else left.splice(i, 1);
    }
    return out;
  }

  /**
   * compareFacts(original, translation) -> { ok, missing: [..], extra: [..] }
   * missing — есть в оригинале, пропало в переводе; extra — появилось в переводе.
   */
  function compareFacts(original, translation) {
    const a = extractFacts(original);
    const b = extractFacts(translation);
    const miss = [];
    const extra = [];
    for (const k of ['numbers', 'phones', 'urls', 'emails', 'codes', 'symbols']) {
      miss.push(...missing(a[k], b[k]));
      extra.push(...missing(b[k], a[k]));
    }
    return { ok: !miss.length && !extra.length, missing: Array.from(new Set(miss)), extra: Array.from(new Set(extra)) };
  }

  // ---------- Вежливость обращения ----------
  const INFORMAL = {
    es: ['tú', 'tu', 'tus', 'te', 'ti', 'contigo', 'puedes', 'tienes', 'quieres', 'debes', 'necesitas', 'eres', 'estás', 'sabes', 'podrías', 'deberías', 'hazlo', 'avísame'],
    pt: ['tu', 'teu', 'tua', 'teus', 'tuas', 'contigo', 'podes', 'tens', 'queres'],
    de: ['du', 'dich', 'dir', 'dein', 'deine', 'deinen', 'deinem', 'deiner', 'deines', 'euch', 'euer', 'eure'],
    fr: ['tu', 'toi', 'ton', 'ta', 'tes', "t'"],
    it: ['tu', 'ti', 'tuo', 'tua', 'tuoi', 'tue', 'puoi', 'hai', 'sei', 'vuoi', 'devi'],
    tr: ['sen', 'seni', 'sana', 'senin', 'sende', 'senden'],
    nl: ['je', 'jij', 'jou', 'jouw', 'jullie'],
    pl: ['ty', 'ciebie', 'cię', 'tobie', 'ci', 'twój', 'twoja', 'twoje', 'twoich', 'możesz', 'masz']
  };

  function informalMarkers(text, lang) {
    const base = String(lang || '').split('-')[0];
    const list = INFORMAL[base];
    if (!list) return [];
    const words = String(text).toLowerCase().match(/[\p{L}]+'?/gu) || [];
    const found = new Set();
    for (const w of words) if (list.includes(w)) found.add(w);
    if (base === 'fr' && /(^|[\s(«"])t'/i.test(text)) found.add("t'");
    return Array.from(found);
  }

  const INFORMAL_SUPPORTED = Object.keys(INFORMAL);

  // вы/вас/вам/вами/ваш… -> с заглавной (вежливая форма в деловой переписке)
  const RU_POLITE = /(^|[^\p{L}])(вы|вас|вам|вами|ваш|ваша|ваше|ваши|вашего|вашей|вашему|вашим|вашими|ваших|вашу|вашем)(?=[^\p{L}]|$)/gu;
  function politeRu(text) {
    return String(text).replace(RU_POLITE, (m, pre, w) => pre + w.charAt(0).toUpperCase() + w.slice(1));
  }
  function hasLowercasePoliteRu(text) {
    RU_POLITE.lastIndex = 0;
    return RU_POLITE.test(String(text));
  }

  globalThis.ST_CHECKS = { extractFacts, compareFacts, informalMarkers, INFORMAL_SUPPORTED, politeRu, hasLowercasePoliteRu, normalizeNumber };
})();
