// Maratona — popup do ícone: liga/desliga cada parte, idioma, tempo economizado e o rodapé padrão (regra 9).
(() => {
  'use strict';
  const ext = (globalThis.browser && globalThis.browser.runtime) ? globalThis.browser : globalThis.chrome;
  const I = globalThis.MT_I18N;
  const SYNC = ext.storage.sync || ext.storage.local;
  const REPO = 'DredsGG/maratona';
  const DEF = { on: true, intro: true, recap: true, credits: true, next: true, toast: true };
  const ITEMS = ['intro', 'recap', 'credits', 'next', 'toast'];
  const VERSION = ext.runtime.getManifest().version;
  let S = Object.assign({}, DEF), lang = I.detect();
  const L = () => I.T[lang] || I.T.en;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtTime(sec) {
    const m = Math.round((sec || 0) / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
  }

  function render() {
    const T = L();
    document.documentElement.lang = lang === 'pt' ? 'pt-BR' : lang;
    $('tagline').textContent = T.tagline;
    $('on').setAttribute('aria-checked', String(!!S.on));
    $('on').setAttribute('aria-label', S.on ? T.master : T.masterOff);
    $('on').title = S.on ? T.master : T.masterOff;
    $('list').closest('.panel').classList.toggle('off', !S.on);
    $('section').textContent = T.section;
    $('list').innerHTML = ITEMS.map((k) => `<div class="it" data-k="${k}"><div class="tx"><b>${esc(T[k])}</b><small>${esc(T[k + 'Sub'])}</small></div>
      <button class="sw" type="button" role="switch" aria-checked="${!!S[k]}" aria-label="${esc(T[k])}"><i></i></button></div>`).join('');
    for (const el of $('list').querySelectorAll('.it')) el.addEventListener('click', () => set(el.dataset.k, !S[el.dataset.k]));
    $('savedLbl').textContent = T.saved;
    $('check').textContent = T.check;
    $('report').textContent = T.report;
    $('help').title = T.howto; $('help').setAttribute('aria-label', T.howto);
    $('madeBy').textContent = T.madeBy;
    $('ver').textContent = VERSION;
    $('langs').setAttribute('aria-label', T.lang);
    $('langs').innerHTML = I.LANGS.map((l) => `<button type="button" data-l="${l}" role="radio" aria-checked="${l === lang}" class="${l === lang ? 'on' : ''}">${l.toUpperCase()}</button>`).join('');
    for (const b of $('langs').querySelectorAll('button')) b.addEventListener('click', () => { lang = b.dataset.l; SYNC.set({ lang }); render(); renderStats(); renderBanner(); });
  }
  // faixa laranja no topo quando há versão nova (ou urgente: a Maratona fica pausada até atualizar)
  async function renderBanner() {
    const u = (await ext.storage.local.get('mt.update'))['mt.update'] || {};
    const nova = u.disponivel && u.ultima && cmpVer(u.ultima, VERSION) > 0;
    const b = $('banner');
    b.hidden = !nova;
    if (nova) b.textContent = u.urgente ? L().bannerUrg(u.ultima) : L().banner(u.ultima);
  }
  const cmpVer = (a, b) => { const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0), pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; } return 0; };
  $('banner').addEventListener('click', () => { ext.runtime.sendMessage({ type: 'maratona:update', cmd: 'apply' }); });
  ext.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch['mt.update']) renderBanner(); });

  async function renderStats() {
    const st = (await ext.storage.local.get('mt.stats'))['mt.stats'] || { seconds: 0, skips: 0, eps: 0 };
    $('saved').textContent = fmtTime(st.seconds);
    $('skips').textContent = L().skips(st.skips || 0);
    $('eps').textContent = L().eps(st.eps || 0);
  }
  function set(k, v) { S[k] = v; SYNC.set({ [k]: v }); render(); }
  $('on').addEventListener('click', () => set('on', !S.on));

  function msg(html) { $('msg').innerHTML = html; $('msg').hidden = !html; }
  $('check').addEventListener('click', async () => {
    msg(esc(L().checking));
    const r = await ext.runtime.sendMessage({ type: 'maratona:update', cmd: 'check' }).catch(() => null);
    if (!r || r.erro) return msg(esc(L().checkErr));
    if (r.disponivel) {
      msg(`${esc(L().newVer(r.ultima))} <a href="#" id="go">${esc(L().updGo)}</a>`);
      $('go').addEventListener('click', (e) => { e.preventDefault(); ext.runtime.sendMessage({ type: 'maratona:update', cmd: 'apply' }); });
    } else msg(esc(L().upToDate));
  });

  // "Relatar bug": abre o relato nos Issues do repo com a versão e um diagnóstico sem dado pessoal
  function navegador() {
    const ua = navigator.userAgent;
    const m = ua.match(/(Firefox|Edg|OPR|Chrome)\/(\d+)/);
    const nome = !m ? 'unknown' : m[1] === 'Edg' ? 'Edge' : m[1] === 'OPR' ? 'Opera' : (m[1] === 'Chrome' && navigator.brave) ? 'Brave' : m[1];
    const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : 'other';
    return `${nome} ${m ? m[2] : ''} · ${os}`;
  }
  $('report').addEventListener('click', async () => {
    const loc = await ext.storage.local.get(['mt.log', 'mt.update', 'mt.disco']);
    let inst = '?'; try { inst = (await ext.management.getSelf()).installType; } catch (_) {}
    const agora = Date.now();
    const log = (loc['mt.log'] || []).map((e) => `- ${Math.round((agora - e.em) / 60000)} min: ${e.type} ${e.ok ? 'ok' : 'FAIL'}${e.s ? ` (${e.s}s)` : ''}`).join('\n') || '- (vazio)';
    const u = loc['mt.update'] || {};
    const diag = [
      `Maratona v${VERSION}`, `Browser: ${navegador()}`, `Install: ${inst}`, `UI: ${lang} / ${navigator.language}`,
      `Settings: ${ITEMS.concat('on').map((k) => `${k}=${S[k] ? 1 : 0}`).join(' ')}`,
      `Update check: latest=${u.ultima || '-'} err=${u.erro || '-'}`,
      loc['mt.disco'] ? `Disk: ${loc['mt.disco'].estado || '-'} (${loc['mt.disco'].noDisco || '-'})` : null,
      '', 'Last events:', log,
    ].filter((x) => x !== null).join('\n');
    const body = `${L().bugBody}\n---\n\`\`\`\n${diag}\n\`\`\``;
    const url = `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(L().bugTitle)}&body=${encodeURIComponent(body)}&labels=bug`;
    ext.tabs.create({ url });
    window.close();
  });

  // "?": tutorial no meio da página da Crunchyroll; sem aba da Crunchyroll, abre o guia
  $('help').addEventListener('click', async () => {
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    if (tab && /^https:\/\/www\.crunchyroll\.com\//.test(tab.url || '')) {
      try { await ext.tabs.sendMessage(tab.id, { type: 'maratona:tutorial' }); window.close(); return; } catch (_) {}
    }
    ext.tabs.create({ url: ext.runtime.getURL('COMO-INSTALAR.html#usar') });
    window.close();
  });

  SYNC.get(null).then((s) => {
    for (const k of Object.keys(DEF)) if (k in s) S[k] = s[k];
    if (I.LANGS.includes(s.lang)) lang = s.lang;
  }).catch(() => {}).finally(() => { render(); renderStats(); renderBanner(); });
})();
