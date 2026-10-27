// Maratona — guia: idioma salvo (ou do navegador) e seletor PT · EN · ES.
(() => {
  const ext = (globalThis.browser && globalThis.browser.runtime) ? globalThis.browser : globalThis.chrome;
  const SYNC = ext.storage.sync || ext.storage.local;
  const apply = (l) => {
    document.body.className = l;
    document.documentElement.lang = l === 'pt' ? 'pt-BR' : l;
    for (const b of document.querySelectorAll('[data-set]')) b.classList.toggle('on', b.dataset.set === l);
  };
  document.getElementById('ver').textContent = ext.runtime.getManifest().version;
  apply(MT_I18N.detect());
  SYNC.get('lang').then((s) => { if (MT_I18N.LANGS.includes(s.lang)) apply(s.lang); }).catch(() => {});
  for (const b of document.querySelectorAll('[data-set]')) b.addEventListener('click', () => { apply(b.dataset.set); SYNC.set({ lang: b.dataset.set }); });
})();
