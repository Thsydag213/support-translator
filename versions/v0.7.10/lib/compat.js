/*
 * Совместимость браузеров. Подключается ПЕРВЫМ во всех частях расширения.
 *
 * Chrome и Edge: глобальный chrome.*, методы возвращают промисы (MV3).
 * Firefox и Safari: промисы есть у browser.*, а chrome.* работает через колбэки.
 *   Весь код расширения написан на промисах, поэтому подменяем chrome на browser.
 *
 * ST_ENV — что доступно в текущем браузере (для диагностики и обходных путей):
 *   offscreen — скрытая страница расширения (мост встроенного переводчика Chrome);
 *   builtinAI — Translator / LanguageDetector API (пока только Chrome и Edge).
 */
(function () {
  const g = globalThis;
  const b = typeof g.browser !== 'undefined' ? g.browser : null;
  if (b && b.runtime && b.runtime.id && g.chrome !== b) {
    try {
      g.chrome = b;
    } catch (e) {
      try {
        Object.defineProperty(g, 'chrome', { value: b, configurable: true, writable: true });
      } catch (e2) {
        /* останется chrome.* с колбэками — часть функций будет недоступна */
      }
    }
  }
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const firefox = /Firefox\//i.test(ua) || !!(b && b.runtime && !g.chrome.offscreen && /Gecko\//i.test(ua));
  const edge = /Edg(e|A|iOS)?\//i.test(ua);
  const chromium = /Chrom(e|ium)\//i.test(ua) && !firefox;
  const safari = !chromium && !firefox && /Safari\//i.test(ua);
  g.ST_ENV = {
    firefox,
    edge,
    safari,
    chromium,
    name: firefox ? 'Firefox' : edge ? 'Edge' : safari ? 'Safari' : chromium ? 'Chrome' : 'браузер',
    offscreen: !!(g.chrome && g.chrome.offscreen),
    builtinAI: typeof g.Translator !== 'undefined' || typeof g.LanguageDetector !== 'undefined'
  };
})();
