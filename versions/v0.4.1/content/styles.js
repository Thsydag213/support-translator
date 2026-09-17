/*
 * Стили вставок расширения. Хранятся строкой, потому что их нужно подключать не только в документ,
 * но и в каждый Shadow DOM, внутри которого расширение рисует подписи (обычный CSS туда не проникает).
 * Все классы с префиксом st-.
 */
(function () {
  const ST = globalThis.ST;
  if (ST.ensureStyles) return;

  const CSS = `
.st-tr {
  display: block !important;
  margin: 6px 0 2px !important;
  padding: 6px 8px !important;
  border-left: 3px solid #1a73e8 !important;
  background: rgba(26, 115, 232, 0.09) !important;
  border-radius: 0 6px 6px 0 !important;
  font-size: var(--st-fs, 14px) !important;
  line-height: 1.45 !important;
  color: inherit !important;
  white-space: pre-wrap !important;
  text-align: left !important;
  font-style: normal !important;
}
.st-tr__head {
  display: flex !important;
  flex-wrap: wrap !important;
  align-items: center !important;
  gap: 6px !important;
  font: 600 11px/1.3 system-ui, -apple-system, 'Segoe UI', sans-serif !important;
  color: #4a90f0 !important;
  margin-bottom: 3px !important;
  white-space: normal !important;
}
.st-tr__langs { font-weight: 500 !important; opacity: 0.9 !important; }
.st-tr__btn {
  all: unset;
  cursor: pointer !important;
  font: 500 11px/1.3 system-ui, sans-serif !important;
  color: inherit !important;
  opacity: 0.75 !important;
  text-decoration: underline dotted !important;
}
.st-tr__btn:hover { opacity: 1 !important; }
.st-tr__text[hidden], .st-tr__orig[hidden] { display: none !important; }
.st-tr--error {
  border-left-color: #d93025 !important;
  background: rgba(217, 48, 37, 0.09) !important;
  color: #e46060 !important;
  font: 12px/1.4 system-ui, sans-serif !important;
  display: flex !important;
  gap: 8px !important;
}
/* Компактный перевод (тема письма) */
.st-tr--compact {
  margin: 2px 0 0 !important;
  padding: 1px 6px !important;
  border-left-width: 2px !important;
  font: 500 12px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif !important;
  white-space: normal !important;
  opacity: 0.9 !important;
}
/* Тема письма: перевод на месте оригинала, в той же строке */
.st-subject {
  display: inline !important;
  font-size: var(--st-fs, 13px) !important;
  cursor: help !important;
  white-space: inherit !important;
}
.st-subject[hidden] { display: none !important; }
/* Кнопка перевода сообщения агента (по запросу) */
.st-trbtn {
  all: unset;
  display: inline-block !important;
  margin: 4px 0 0 !important;
  padding: 1px 8px !important;
  border-radius: 999px !important;
  border: 1px solid currentColor !important;
  font: 500 11px/16px system-ui, -apple-system, 'Segoe UI', sans-serif !important;
  opacity: 0.55 !important;
  cursor: pointer !important;
  white-space: nowrap !important;
}
.st-trbtn:hover { opacity: 1 !important; }
/* Метка языка в списке тикетов */
.st-badge {
  display: inline-block !important;
  margin: 0 6px 0 0 !important;
  padding: 0 5px !important;
  border-radius: 4px !important;
  background: #1a73e8 !important;
  color: #fff !important;
  font: 700 10px/16px system-ui, -apple-system, 'Segoe UI', sans-serif !important;
  letter-spacing: 0.03em !important;
  vertical-align: 1px !important;
  white-space: nowrap !important;
}
/* Режим "замена": прячем оригинал, оставляем только нашу вставку */
.st-replaced { font-size: 0 !important; }
.st-replaced > :not([data-st-ui]) { display: none !important; }
/* insertMode=after: подпись — соседний элемент, оригинал прячем целиком */
.st-hide { display: none !important; }
.st-tr--after { box-sizing: border-box !important; max-width: 100% !important; }

.st-toast {
  position: fixed !important;
  z-index: 2147483647 !important;
  left: 50% !important;
  top: 16px !important;
  transform: translateX(-50%) !important;
  background: #202124 !important;
  color: #fff !important;
  padding: 10px 14px !important;
  border-radius: 8px !important;
  font: 13px/1.4 system-ui, sans-serif !important;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3) !important;
  display: flex !important;
  gap: 12px !important;
  align-items: center !important;
  max-width: calc(100vw - 32px) !important;
}
.st-toast--error { background: #a50e0e !important; }
.st-toast__btn {
  all: unset;
  cursor: pointer !important;
  color: #8ab4f8 !important;
  font-weight: 600 !important;
  white-space: nowrap !important;
}
.st-pick-box {
  position: fixed !important;
  z-index: 2147483646 !important;
  pointer-events: none !important;
  display: none;
  border: 2px solid #1a73e8 !important;
  background: rgba(26, 115, 232, 0.12) !important;
  border-radius: 3px !important;
  transition: all 60ms !important;
}
.st-pick-tip {
  position: fixed !important;
  z-index: 2147483647 !important;
  top: 12px !important;
  left: 50% !important;
  transform: translateX(-50%) !important;
  background: #1a73e8 !important;
  color: #fff !important;
  padding: 8px 14px !important;
  border-radius: 8px !important;
  font: 600 13px/1.4 system-ui, sans-serif !important;
  pointer-events: none !important;
}
`;

  let sheet = null;
  function getSheet() {
    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
    }
    return sheet;
  }

  // root: document или ShadowRoot. Проверяем при каждой отрисовке — фреймворки могут перезаписать adoptedStyleSheets
  ST.ensureStyles = function (root) {
    root = root || document;
    try {
      const s = getSheet();
      const list = root.adoptedStyleSheets;
      if (!list.includes(s)) root.adoptedStyleSheets = [...list, s];
    } catch (e) {
      const target = root === document ? document.head || document.documentElement : root;
      if (!target.querySelector(':scope > style[data-st-ui]')) {
        const st = document.createElement('style');
        st.setAttribute('data-st-ui', 'style');
        st.textContent = CSS;
        target.appendChild(st);
      }
    }
  };

  ST.CSS_TEXT = CSS;
  ST.ensureStyles(document);
})();
