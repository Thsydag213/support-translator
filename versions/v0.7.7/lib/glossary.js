/*
 * Глоссарий: термины, которые не надо переводить, и термины с фиксированным переводом.
 *
 * Формат (по строке на запись, # — комментарий):
 *   Premium Plus
 *   Кошелёк => ru: Кошелёк | es: Billetera | tr: Cüzdan | en: Wallet
 *
 * Механизм: перед отправкой в переводчик термины заменяются метками ⟦0⟧, ⟦1⟧…
 * (Google оставляет их нетронутыми — проверено на es/tr/de/ar/zh/ru), после перевода метки
 * заменяются обратно: "не переводить" — исходным текстом, "фиксированный" — вариантом для целевого языка.
 * Для фиксированных терминов распознаются все языковые варианты (Billetera, Cüzdan, Wallet…),
 * поэтому обратный перевод тоже возвращает правильный термин.
 */
(function () {
  const L = globalThis.ST_LIB;

  let cacheSrc = null;
  let cacheParsed = [];

  function parse(src) {
    if (src === cacheSrc) return cacheParsed;
    const entries = [];
    for (const raw of String(src || '').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=>');
      if (idx === -1) {
        entries.push({ keep: true, variants: [line] });
        continue;
      }
      const term = line.slice(0, idx).trim();
      const map = {};
      for (const part of line.slice(idx + 2).split('|')) {
        const m = /^\s*([a-zA-Z]{2,3}(?:-[a-zA-Z]{2})?)\s*:\s*(.+?)\s*$/.exec(part);
        if (m) map[L.baseLang(m[1])] = m[2];
      }
      if (!term || !Object.keys(map).length) continue;
      const variants = Array.from(new Set([term, ...Object.values(map)]));
      entries.push({ keep: false, map, variants });
    }
    cacheSrc = src;
    cacheParsed = entries;
    return entries;
  }

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /**
   * protect(text, glossarySrc, tl) -> { text, tokens, originals }
   */
  function protect(text, glossarySrc, tl) {
    const entries = parse(glossarySrc);
    if (!entries.length) return { text, tokens: [], originals: [] };
    const tlBase = L.baseLang(tl);

    // Длинные варианты первыми, чтобы "Premium Plus" не разрезался на "Premium"
    const variants = [];
    for (const e of entries) {
      if (!e.keep && !e.map[tlBase]) continue; // нет перевода для этого языка — пусть переводит Google
      for (const v of e.variants) variants.push({ v, e });
    }
    variants.sort((a, b) => b.v.length - a.v.length);

    const tokens = [];
    const originals = []; // исходный текст на месте каждой метки (для восстановления исходника, например подсказки опечаток)
    let out = text;
    for (const { v, e } of variants) {
      const re = new RegExp('(?<![\\p{L}\\p{N}_])' + esc(v) + '(?![\\p{L}\\p{N}_])', 'giu');
      out = out.replace(re, (match) => {
        tokens.push(e.keep ? match : e.map[tlBase]);
        originals.push(match);
        return '⟦' + (tokens.length - 1) + '⟧';
      });
    }
    return { text: out, tokens, originals };
  }

  function restore(text, tokens) {
    if (!tokens || !tokens.length) return text;
    return text.replace(/⟦\s*(\d+)\s*⟧/g, (m, n) => (tokens[+n] != null ? tokens[+n] : m));
  }

  globalThis.ST_GLOSSARY = { parse, protect, restore };
})();
