/*
 * Маскирование персональных данных перед отправкой в облачный переводчик.
 *
 * Почты, телефоны, номера карт, IBAN и длинные номера заказов заменяются на метки ⟦p0⟧, ⟦p1⟧…
 * После перевода метки заменяются обратно. В Google уходит текст без данных клиента.
 * Метки глоссария (⟦0⟧) не задеваются: у данных своя буква «p».
 *
 * На устройстве (встроенный переводчик Chrome) маскирование не нужно — текст никуда не уходит.
 */
(function () {
  const RULES = [
    // почта
    /[\w.+-]+@[\w-]+\.[\w.-]{2,}/g,
    // карта: 13–19 цифр группами
    /\b(?:\d[ -]?){12,18}\d\b/g,
    // IBAN
    /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}\b/g,
    // телефон: +34 600 123 456, (555) 123-4567
    /\+?\d[\d\s()-]{8,}\d/g,
    // длинный номер заказа/транзакции: TX-99812, ORD_123456, 8 и более цифр
    /\b[A-Z]{2,6}[-_ ]?\d{4,}\b/g,
    /\b\d{8,}\b/g
  ];

  /**
   * mask(text) -> { text, tokens }  (tokens[i] — исходная строка)
   */
  function mask(text) {
    const tokens = [];
    let out = String(text == null ? '' : text);
    for (const re of RULES) {
      out = out.replace(re, (m) => {
        // уже метка или её часть — не трогаем
        if (/⟦/.test(m)) return m;
        const i = tokens.push(m) - 1;
        return '⟦p' + i + '⟧';
      });
    }
    return { text: out, tokens };
  }

  function restore(text, tokens) {
    if (!tokens || !tokens.length) return text;
    return String(text).replace(/⟦\s*p(\d+)\s*⟧/g, (m, n) => (tokens[+n] != null ? tokens[+n] : m));
  }

  // Все ли метки пережили перевод: если провайдер их потерял, данные восстановить нельзя
  function intact(text, tokens) {
    if (!tokens || !tokens.length) return true;
    for (let i = 0; i < tokens.length; i++) {
      if (!new RegExp('⟦\\s*p' + i + '\\s*⟧').test(text)) return false;
    }
    return true;
  }

  globalThis.ST_PII = { mask, restore, intact };
})();
