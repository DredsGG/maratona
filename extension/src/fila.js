// Maratona — Fila com progresso (v1.3.0). Roda na Crunchyroll, no mundo isolado da extensão.
// Pedido do André (2026-10-28): em cada anime da Fila ("Minhas Listas → Fila"), uma rodelinha no canto com a % de
// episódios vistos. Clicando nela: "Marcar episódios vistos" (vários de uma vez, ou todos) e "Recomeçar do zero"
// (para reassistir). Quando sai episódio novo, a % cai e a rodelinha brilha com "+N".
// De onde vêm os dados (medido ao vivo em 2026-10-28; ver Jarvis/02-projetos/extensoes/crunchyroll/pesquisa/2026-10-28-fila-progresso.md):
//  - token: POST /auth/v1/token com o cookie de login (grant_type=etp_rt_cookie), o client id do próprio site
//    (window.__APP_CONFIG__.cxApiParams.accountAuthClientId, lido do script inline) e o device_id do cookie do site;
//  - temporadas e episódios: /content/v2/cms/series/<id>/seasons e /cms/seasons/<id>/episodes;
//  - o que foi visto: /content/v2/<conta>/playheads (fully_watched + last_modified), em todas as versões (legendado e dublado).
// Nada é escrito na conta da Crunchyroll: "marcar vistos" e "recomeçar" ficam guardados na extensão.
(() => {
  'use strict';
  const ext = (globalThis.browser && globalThis.browser.runtime) ? globalThis.browser : globalThis.chrome;
  const I = globalThis.MT_I18N;
  if (!ext || !ext.runtime || !I) return;

  // uma instância por aba (a extensão recarregada injeta outra; a antiga para)
  document.dispatchEvent(new Event('maratona-fila-takeover'));
  let dead = false;
  const onTakeover = () => stop();
  setTimeout(() => document.addEventListener('maratona-fila-takeover', onTakeover), 0);
  const alive = () => { try { return !dead && !!ext.runtime.id; } catch (_) { return false; } };

  const SYNC = ext.storage.sync || ext.storage.local;
  let lang = I.detect();
  const L = () => I.T[lang] || I.T.en;
  let ligado = true; // ajuste "Progresso na Fila" do menu da Maratona
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // no Firefox, content.fetch faz o pedido como a própria página (mesma origem, com o cookie de login)
  const pfetch = (globalThis.content && typeof globalThis.content.fetch === 'function') ? globalThis.content.fetch.bind(globalThis.content) : globalThis.fetch.bind(globalThis);

  const FRESH_MS = 10 * 60 * 1000; // progresso da Fila: refaz se tiver mais de 10 min
  const REVISIT_MS = 2 * 60 * 1000; // voltou para a aba da Fila: refaz o que tiver mais de 2 min
  const BG_MS = 2 * 60 * 60 * 1000; // de qualquer página da Crunchyroll: procura episódio novo a cada 2 h
  const K_CACHE = 'mt.fila.cache', K_KNOWN = 'mt.fila.known', K_NOVOS = 'mt.fila.novos', K_BG = 'mt.fila.bg', K_DEV = 'mt.fila.dev';
  const UKEY = (sid) => 'mtf.' + sid; // decisões da pessoa por série, no storage.sync: {r: recomeço, m: [marcados], u: {desmarcado: quando}}

  let cache = {}, known = {}, user = {};
  const state = new Map(); // sid → 'loading' | 'error' | 'ok'
  const titles = {};

  // ───────────────────────── API da Crunchyroll ─────────────────────────
  const LOCS = { 'pt-br': 'pt-BR', 'pt-pt': 'pt-PT', es: 'es-419', 'es-es': 'es-ES', fr: 'fr-FR', de: 'de-DE', it: 'it-IT', ru: 'ru-RU', ar: 'ar-SA', hi: 'hi-IN' };
  const loc = () => { const m = location.pathname.match(/^\/([a-z]{2}(?:-[a-z]{2})?)\//); return (m && LOCS[m[1]]) || 'en-US'; };
  let clientIdCache = null;
  function clientId() {
    if (clientIdCache) return clientIdCache;
    for (const s of document.scripts) {
      if (s.src) continue;
      const m = s.textContent.match(/accountAuthClientId["']?\s*:\s*["']([^"']+)["']/);
      if (m) return (clientIdCache = m[1]);
    }
    return null;
  }
  async function deviceId() {
    const m = document.cookie.match(/(?:^|;\s*)device_id=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
    try {
      const v = (await ext.storage.local.get(K_DEV))[K_DEV];
      if (v) return v;
      const n = crypto.randomUUID(); await ext.storage.local.set({ [K_DEV]: n }); return n;
    } catch (_) { return crypto.randomUUID(); }
  }
  function deviceType() {
    const ua = navigator.userAgent, b = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : 'Chrome';
    const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Desktop';
    return `${b} on ${os}`;
  }
  let tok = null, tokP = null;
  async function token() {
    if (tok && tok.exp > Date.now() + 20000) return tok;
    if (tokP) return tokP;
    tokP = (async () => {
      const id = clientId();
      if (!id) throw new Error('noclient');
      const body = new URLSearchParams({ grant_type: 'etp_rt_cookie', device_id: await deviceId(), device_type: deviceType() }).toString();
      const r = await pfetch(location.origin + '/auth/v1/token', { method: 'POST', credentials: 'include',
        headers: { Authorization: 'Basic ' + btoa(id + ':'), 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      if (r.status === 400 || r.status === 401) throw new Error('login');
      if (!r.ok) throw new Error('token ' + r.status);
      const j = await r.json();
      if (!j.access_token || !j.account_id) throw new Error('login');
      tok = { t: j.access_token, acc: j.account_id, exp: Date.now() + Math.max(60, (j.expires_in || 300) - 30) * 1000 };
      return tok;
    })();
    try { return await tokP; } finally { tokP = null; }
  }
  async function api(path, tries = 0) {
    const t = await token();
    const r = await pfetch(location.origin + path, { credentials: 'include', headers: { Authorization: 'Bearer ' + t.t } });
    if (r.status === 401 && tries < 1) { tok = null; return api(path, tries + 1); }
    if ((r.status === 429 || r.status >= 500) && tries < 3) { await sleep(1200 * (tries + 1)); return api(path, tries + 1); }
    if (!r.ok) throw new Error('http ' + r.status);
    return r.json();
  }
  async function pool(items, n, fn) {
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
    return out;
  }

  // temporadas e episódios disponíveis (com o idioma preferido, cada temporada vem uma vez; dublagens são "versions")
  async function serieEps(sid) {
    const q = `locale=${loc()}&preferred_audio_language=${loc()}`;
    const s = await api(`/content/v2/cms/series/${sid}/seasons?${q}`);
    const seasons = (s.data || []).slice().sort((a, b) => ((a.season_sequence_number || 0) - (b.season_sequence_number || 0)) || ((a.season_number || 0) - (b.season_number || 0)));
    const lists = await pool(seasons, 3, async (se) => (await api(`/content/v2/cms/seasons/${se.id}/episodes?${q}`)).data || []);
    const now = Date.now(), out = { seasons: [], eps: [] };
    seasons.forEach((se, i) => {
      const eps = [];
      lists[i].forEach((x, j) => {
        if (x.is_clip) return;
        const ds = [x.availability_starts, x.premium_available_date].map((d) => Date.parse(d || '')).filter((d) => d > 0);
        if (ds.length && Math.min(...ds) > now) return; // ainda não saiu
        const seq = x.sequence_number != null ? x.sequence_number : j + 1;
        eps.push({ k: `${se.season_sequence_number || i + 1}-${seq}`, n: String(x.episode || x.episode_number || j + 1), t: x.title || '',
          ids: [...new Set([x.id, ...(x.versions || []).map((v) => v.guid)].filter(Boolean))] });
      });
      if (!eps.length) return;
      out.seasons.push({ t: se.title || '', n: se.season_display_number || se.season_number || i + 1 });
      for (const e of eps) out.eps.push(Object.assign(e, { s: out.seasons.length - 1 }));
    });
    return out;
  }
  async function vistosNaCrunchyroll(eps) {
    const ids = [...new Set(eps.flatMap((e) => e.ids))], chunks = [];
    for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
    const t = await token(), ph = {};
    await pool(chunks, 4, async (c) => { const r = await api(`/content/v2/${t.acc}/playheads?content_ids=${c.join(',')}&locale=${loc()}`); for (const p of r.data || []) ph[p.content_id] = p; });
    const auto = {};
    for (const e of eps) {
      let lm = 0;
      for (const id of e.ids) { const p = ph[id]; if (p && p.fully_watched) lm = Math.max(lm, Date.parse(p.last_modified || '') || 1); }
      if (lm) auto[e.k] = lm;
    }
    return auto;
  }

  // ───────────────────────── progresso ─────────────────────────
  let saveT = 0;
  const saveNow = () => { clearTimeout(saveT); if (alive()) return ext.storage.local.set({ [K_CACHE]: cache, [K_KNOWN]: known }).catch(() => {}); };
  const saveCache = () => { clearTimeout(saveT); saveT = setTimeout(saveNow, 300); };
  function calc(sid) {
    const c = cache[sid];
    if (!c || !c.eps) return null;
    const u = user[sid] || {}, r = u.r || 0, m = new Set(u.m || []), un = u.u || {};
    const seen = new Set();
    for (const e of c.eps) {
      const a = (c.auto || {})[e.k];
      if (m.has(e.k) || (a && a > r && a > (un[e.k] || 0))) seen.add(e.k);
    }
    const total = c.eps.length, w = seen.size;
    const pct = !total ? 0 : w >= total ? 100 : Math.floor((w * 100) / total);
    const k = known[sid];
    const novos = k != null && total > k && w < total ? total - k : 0;
    return { total, w, pct, seen, novos, reset: r };
  }
  // "já vi o aviso": a contagem conhecida passa a ser o total de agora (e quando está tudo visto, também)
  function acertarConhecidos(sid) {
    const c = cache[sid], p = calc(sid);
    if (!c || !p) return;
    if (known[sid] == null || p.w >= p.total || known[sid] > p.total) known[sid] = p.total;
  }
  function novosLista() {
    return Object.keys(cache).map((sid) => { const p = calc(sid); return p && p.novos ? { sid, t: cache[sid].title || titles[sid] || sid, n: p.novos } : null; }).filter(Boolean);
  }
  let lastNovos = '';
  function publicarNovos() {
    const l = novosLista(), j = JSON.stringify(l);
    if (j === lastNovos) return;
    lastNovos = j;
    try { ext.storage.local.set({ [K_NOVOS]: l }); } catch (_) {}
  }

  const fila = new Set(); // séries que estão na Fila (vistas nesta página)
  const queue = []; let running = 0;
  function pedir(sid, full) {
    if (queue.find((q) => q.sid === sid) || state.get(sid) === 'loading') return;
    queue.push({ sid, full }); bomba();
  }
  async function bomba() {
    while (running < 2 && queue.length && alive()) {
      const { sid, full } = queue.shift();
      running++;
      if (full) { state.set(sid, 'loading'); paintRings(sid); }
      (async () => {
        try {
          const d = await serieEps(sid);
          const auto = full ? await vistosNaCrunchyroll(d.eps) : ((cache[sid] || {}).auto || {});
          const prev = cache[sid] || {};
          cache[sid] = { at: full ? Date.now() : (prev.at || 0), tot: Date.now(), title: titles[sid] || prev.title || '', seasons: d.seasons, eps: d.eps.map(({ k, s, n, t }) => ({ k, s, n, t })), auto };
          acertarConhecidos(sid);
          state.set(sid, 'ok');
        } catch (e) {
          if (String(e && e.message) === 'login') ligadoLogin = false;
          state.set(sid, cache[sid] ? 'ok' : 'error');
        } finally {
          running--; saveNow(); publicarNovos(); paintRings(sid); if (pop && pop.sid === sid) renderPop(); bomba();
        }
      })();
    }
  }
  let ligadoLogin = true;

  // ───────────────────────── a rodelinha em cada card da Fila ─────────────────────────
  const R = 17, CIRC = 2 * Math.PI * R;
  const RING_CSS = `
  :host { all: initial; position: absolute; top: 6px; right: 6px; z-index: 3; display: block; }
  * { box-sizing: border-box; }
  .rg { --o5: #ff640a; --o4: #ff8036; --ease: cubic-bezier(.4,0,.2,1); position: relative; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 999px; cursor: pointer;
    background: rgba(0,0,0,.72); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); color: #fff; display: grid; place-items: center;
    font-family: DMSans, "DM Sans", "Helvetica Neue", helvetica, sans-serif; -webkit-font-smoothing: antialiased;
    box-shadow: 0 4px 10px rgba(0,0,0,.45); transition: transform .2s var(--ease), background-color .2s var(--ease); }
  .rg:hover { transform: scale(1.08); background: rgba(21,21,21,.9); }
  .rg:active { transform: scale(.96); }
  .rg:focus-visible { outline: 2px solid var(--o5); outline-offset: 2px; }
  svg { position: absolute; inset: 0; transform: rotate(-90deg); }
  .tr { fill: none; stroke: #414141; stroke-width: 3.5; }
  .pg { fill: none; stroke: var(--o5); stroke-width: 3.5; stroke-linecap: round; transition: stroke-dashoffset .7s var(--ease), stroke .2s var(--ease); }
  .done .pg { stroke: var(--o5); }
  .nm { position: relative; font-size: 13px; font-weight: 700; letter-spacing: -.4px; line-height: 1; }
  .nm small { font-size: 8px; font-weight: 700; margin-left: 1px; vertical-align: 3px; }
  .done .nm { font-size: 12px; }
  .ld .pg { stroke-dasharray: ${(CIRC * 0.25).toFixed(1)} ${CIRC.toFixed(1)}; animation: spin 1s linear infinite; transform-origin: 22px 22px; }
  .ld .nm { opacity: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .er .nm { color: #8c8c8c; }
  /* episódio novo: brilho laranja que pulsa + selo "+N" */
  .nv { animation: glow 1.8s var(--ease) infinite; }
  @keyframes glow { 0% { box-shadow: 0 0 0 0 rgba(255,100,10,.75), 0 4px 10px rgba(0,0,0,.45); } 70% { box-shadow: 0 0 0 10px rgba(255,100,10,0), 0 4px 10px rgba(0,0,0,.45); } 100% { box-shadow: 0 0 0 0 rgba(255,100,10,0), 0 4px 10px rgba(0,0,0,.45); } }
  .bdg { position: absolute; right: -4px; bottom: -6px; min-width: 20px; height: 16px; padding: 0 4px; border-radius: 999px; background: var(--o5); color: #000;
    font-size: 10px; font-weight: 700; line-height: 16px; text-align: center; letter-spacing: 0; box-shadow: 0 0 0 2px #000; }
  @media (prefers-reduced-motion: reduce) { .rg, .pg { transition: none; } .nv, .ld .pg { animation: none; } }
  `;
  function cardSid(card) {
    const a = card.querySelector('a[href*="/series/"]');
    const m = a && a.getAttribute('href').match(/\/series\/([A-Z0-9]+)/i);
    return m ? m[1] : null;
  }
  function ensureRing(card) {
    const sid = cardSid(card);
    if (!sid) return;
    const img = card.querySelector('[class*="watchlist-card-image--"]') || card;
    let h = img.querySelector(':scope > maratona-ring');
    if (h && h.dataset.sid === sid && h.shadowRoot) return; // (um clone sem shadow root não serve)
    if (h) h.remove();
    const tt = card.querySelector('[class*="watchlist-card-title"]'), tl = tt && tt.textContent.trim();
    if (tl) titles[sid] = tl;
    fila.add(sid);
    h = document.createElement('maratona-ring');
    h.dataset.sid = sid;
    const sr = h.attachShadow({ mode: 'open' });
    sr.innerHTML = `<style>${RING_CSS}</style><button class="rg ld" type="button"><svg viewBox="0 0 44 44" width="44" height="44" aria-hidden="true">
      <circle class="tr" cx="22" cy="22" r="${R}"/><circle class="pg" cx="22" cy="22" r="${R}" stroke-dasharray="${CIRC.toFixed(2)}" stroke-dashoffset="${CIRC.toFixed(2)}"/></svg>
      <span class="nm"></span></button>`;
    // o card inteiro é um link: nada do que acontece na rodelinha chega a ele
    for (const t of ['click', 'dblclick', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'auxclick', 'contextmenu', 'touchstart', 'keydown']) h.addEventListener(t, (e) => { e.stopPropagation(); if (t === 'click' || t === 'auxclick') e.preventDefault(); });
    sr.querySelector('.rg').addEventListener('click', () => togglePop(sid, h));
    img.appendChild(h);
    paintRing(h);
    const c = cache[sid];
    if (!c || Date.now() - (c.at || 0) > FRESH_MS) pedir(sid, true);
  }
  function paintRing(h) {
    const sid = h.dataset.sid, b = h.shadowRoot.querySelector('.rg'), T = L();
    const p = calc(sid), st = state.get(sid);
    b.classList.toggle('ld', !p && st !== 'error');
    b.classList.toggle('er', !p && st === 'error');
    b.classList.toggle('done', !!p && p.pct >= 100);
    b.classList.toggle('nv', !!p && p.novos > 0);
    const pg = b.querySelector('.pg'), nm = b.querySelector('.nm');
    let bd = b.querySelector('.bdg');
    if (p) {
      const off = CIRC * (1 - p.pct / 100);
      if (pg.getAttribute('stroke-dashoffset') !== off.toFixed(2)) requestAnimationFrame(() => pg.setAttribute('stroke-dashoffset', off.toFixed(2)));
      nm.innerHTML = `${p.pct}<small>%</small>`;
      const lbl = `${T.fRing(p.pct)} · ${T.fOf(p.w, p.total)}${p.novos ? ' · ' + T.fNovos(p.novos) : ''}`;
      b.title = lbl; b.setAttribute('aria-label', lbl);
      if (p.novos) { if (!bd) { bd = document.createElement('span'); bd.className = 'bdg'; b.appendChild(bd); } bd.textContent = '+' + p.novos; } else if (bd) bd.remove();
    } else {
      nm.textContent = st === 'error' ? '!' : '';
      b.title = st === 'error' ? T.fErr : T.fLoading; b.setAttribute('aria-label', b.title);
      if (bd) bd.remove();
    }
  }
  function paintRings(sid) {
    for (const h of document.querySelectorAll('maratona-ring')) if (!sid || h.dataset.sid === sid) paintRing(h);
  }
  const naFila = () => /\/watchlist(\/|$)/.test(location.pathname);
  function scan() {
    if (!ligado || !ligadoLogin || !naFila()) { removeRings(); return; }
    for (const c of document.querySelectorAll('[data-t="watch-list-card"]')) ensureRing(c);
  }
  function removeRings() { for (const h of document.querySelectorAll('maratona-ring')) h.remove(); if (pop) closePop(); }
  let mo = null, scanT = 0;
  function observar(on) {
    if (on && !mo) { mo = new MutationObserver(() => { clearTimeout(scanT); scanT = setTimeout(scan, 120); }); mo.observe(document.body, { childList: true, subtree: true }); scan(); }
    if (!on && mo) { mo.disconnect(); mo = null; removeRings(); }
  }

  // ───────────────────────── janela da rodelinha e escolha de episódios ─────────────────────────
  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .wrap { --o5: #ff640a; --o4: #ff8036; --o6: #d25108; --n8: #151515; --n7: #272727; --n6: #414141; --n5: #636363; --n4: #8c8c8c; --n3: #bbb; --n2: #d8d8d8;
    --ease: cubic-bezier(.4,0,.2,1); font-family: DMSans, "DM Sans", "Helvetica Neue", helvetica, sans-serif; font-size: 14px; line-height: 20px; color: #fff; -webkit-font-smoothing: antialiased; }
  button { font-family: inherit; }
  button:focus-visible { outline: 2px solid var(--o5); outline-offset: 2px; }
  [hidden] { display: none !important; }
  .pop { position: fixed; z-index: 2147483646; width: 300px; max-width: calc(100vw - 16px); background: var(--n7); border-radius: 8px; overflow: hidden;
    box-shadow: 0 20px 25px -5px rgba(0,0,0,.55), 0 8px 10px -6px rgba(0,0,0,.55); opacity: 0; transform: translateY(-6px) scale(.97); transform-origin: top right;
    transition: opacity .2s var(--ease), transform .2s var(--ease); }
  .pop.on { opacity: 1; transform: none; }
  .ph { padding: 14px 16px 12px; background: var(--n8); box-shadow: inset 0 -1px 0 rgba(255,255,255,.06); }
  .ph b { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 16px; font-weight: 700; letter-spacing: -.48px; line-height: 21px; }
  .ph .sub { display: flex; justify-content: space-between; margin-top: 6px; color: var(--n3); font-size: 12px; line-height: 16px; }
  .ph .sub em { font-style: normal; color: var(--o5); font-weight: 700; }
  .ln { height: 4px; margin-top: 8px; background: var(--n6); overflow: hidden; }
  .ln i { display: block; height: 100%; background: var(--o5); transition: width .5s var(--ease); }
  .nov { display: flex; align-items: center; gap: 10px; margin: 12px 16px 0; padding: 10px 12px; background: rgba(255,100,10,.1); border-left: 3px solid var(--o5); font-size: 13px; line-height: 18px; }
  .nov div { flex: 1; } .nov b { display: block; color: #fff; } .nov small { color: var(--n3); font-size: 12px; }
  .it { display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 16px; border: 0; background: none; color: #fff; text-align: left; cursor: pointer; transition: background-color .15s var(--ease); }
  .it:hover { background: var(--n6); } .it:active { background: var(--n5); }
  .it .ic { flex: none; width: 24px; height: 24px; display: grid; place-items: center; color: var(--o5); }
  .it .tx { flex: 1; min-width: 0; } .it b { display: block; font-size: 14px; font-weight: 400; line-height: 20px; } .it small { display: block; font-size: 12px; line-height: 16px; color: var(--n3); }
  .items { padding: 6px 0; }
  .ask { margin: 4px 16px 10px; padding: 10px 12px; background: var(--n8); font-size: 13px; line-height: 18px; color: var(--n2); }
  .ask .row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
  .pf { display: flex; align-items: center; justify-content: space-between; padding: 8px 16px 12px; border-top: 1px solid rgba(255,255,255,.06); color: var(--n4); font-size: 12px; }
  .btn { height: 36px; padding: 0 14px; border: 0; border-radius: 0; cursor: pointer; font-size: 13px; font-weight: 700; letter-spacing: .04em; line-height: 1; text-transform: uppercase;
    transition: background-color .2s var(--ease), color .2s var(--ease), box-shadow .2s var(--ease); }
  .pri { background: var(--o5); color: #000; } .pri:hover { background: var(--o4); } .pri:active { background: var(--o6); }
  .lk { border: 0; background: none; color: var(--n3); cursor: pointer; padding: 4px 6px; font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; transition: color .15s var(--ease); }
  .lk:hover { color: #fff; } .lk.o { color: var(--o5); } .lk.o:hover { color: var(--o4); }
  /* escolha de episódios: o painel do player no meio da tela */
  .veil { position: fixed; inset: 0; z-index: 2147483646; background: rgba(0,0,0,.6); opacity: 0; transition: opacity .2s var(--ease); }
  .veil.on { opacity: 1; }
  .pick { position: fixed; z-index: 2147483647; left: 50%; top: 50%; width: 600px; max-width: calc(100vw - 24px); max-height: min(640px, calc(100vh - 32px)); display: flex; flex-direction: column;
    background: var(--n7); border-radius: 8px; overflow: hidden; box-shadow: 0 20px 25px -5px rgba(0,0,0,.55), 0 8px 10px -6px rgba(0,0,0,.55);
    opacity: 0; transform: translate(-50%, -47%) scale(.98); transition: opacity .2s var(--ease), transform .2s var(--ease); }
  .pick.on { opacity: 1; transform: translate(-50%, -50%); }
  .pick::before { content: ""; display: block; flex: none; height: 4px; background: var(--o5); }
  .top { display: flex; align-items: flex-start; gap: 12px; padding: 16px 12px 4px 20px; }
  .ttl { flex: 1; min-width: 0; }
  .kick { display: block; color: var(--o5); font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; line-height: 16px; }
  .ttl b { display: block; font-size: 18px; font-weight: 700; letter-spacing: -.54px; line-height: 24px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ttl small { display: block; color: var(--n3); font-size: 12px; line-height: 16px; margin-top: 2px; }
  .x { flex: none; width: 36px; height: 36px; border: 0; border-radius: 999px; background: none; color: var(--n3); cursor: pointer; display: grid; place-items: center; transition: background-color .15s var(--ease), color .15s var(--ease); }
  .x:hover { background: var(--n6); color: #fff; }
  .tabs { flex: none; display: flex; flex-wrap: wrap; gap: 0 2px; padding: 8px 20px 0; box-shadow: inset 0 -2px 0 var(--n6); }
  .tab { flex: none; border: 0; background: none; color: var(--n4); cursor: pointer; padding: 10px 12px; font-size: 13px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; white-space: nowrap;
    max-width: 260px; overflow: hidden; text-overflow: ellipsis; transition: color .15s var(--ease), box-shadow .15s var(--ease); }
  .tab:hover { color: #fff; } .tab.on { color: #fff; box-shadow: inset 0 -2px 0 var(--o5); }
  .tab span { color: var(--n4); font-weight: 400; margin-left: 4px; text-transform: none; } .tab.on span { color: var(--o5); }
  .tools { flex: none; display: flex; flex-wrap: wrap; gap: 4px 6px; padding: 10px 20px 2px; }
  .tools .lk { font-size: 11px; }
  .tools .sp { flex: 1; }
  .grid { flex: 1; min-height: 120px; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(52px, 1fr)); gap: 6px; padding: 10px 20px 14px; align-content: start;
    user-select: none; scrollbar-width: thin; scrollbar-color: var(--n5) transparent; overscroll-behavior: contain; }
  .ep { height: 40px; border: 0; background: var(--n8); color: var(--n2); cursor: pointer; font-size: 14px; font-weight: 700; touch-action: none; box-shadow: inset 0 0 0 1px rgba(255,255,255,.06);
    transition: background-color .12s var(--ease), color .12s var(--ease), transform .12s var(--ease); }
  .ep:hover { background: var(--n6); color: #fff; }
  .ep.on { background: var(--o5); color: #000; box-shadow: none; }
  .ep.on:hover { background: var(--o4); }
  .ep:active { transform: scale(.94); }
  .ft { flex: none; display: flex; align-items: center; gap: 8px; padding: 12px 20px 16px; border-top: 1px solid rgba(255,255,255,.06); }
  .cnt { margin-right: auto; color: var(--n3); font-size: 13px; } .cnt b { color: var(--o5); }
  @media (prefers-reduced-motion: reduce) { .pop, .pick, .veil, .ln i, .ep { transition: none; } }
  `;
  const ICO = {
    all: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="m8 12.2 2.8 2.8L16.3 9.4"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="m8 12 3 3 5-6"/></svg>',
    reset: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/></svg>',
    undo: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
    x: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  };
  let host = null, root = null;
  function ui() {
    if (!host) {
      host = document.createElement('maratona-fila');
      root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${CSS}</style><div class="wrap"><div class="pop" role="dialog" hidden></div><div class="veil" hidden></div><div class="pick" role="dialog" aria-modal="true" hidden></div></div>`;
      for (const t of ['click', 'dblclick', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'keydown', 'keyup', 'wheel', 'contextmenu']) host.addEventListener(t, (e) => e.stopPropagation());
      root.querySelector('.pop').addEventListener('click', (e) => { const el = e.target.closest('[data-a]'); if (el) { e.preventDefault(); popAction(el.dataset.a); } });
      root.querySelector('.veil').addEventListener('click', () => closePick());
      wirePick();
    }
    if (host.parentNode !== document.body) document.body.appendChild(host);
    return root;
  }
  const showEl = (el) => { clearTimeout(el._t); el.hidden = false; const n = el._n = (el._n || 0) + 1; void el.offsetWidth; el._t = setTimeout(() => { if (el._n === n) el.classList.add('on'); }, 16); };
  const hideEl = (el) => { el._n = (el._n || 0) + 1; const n = el._n; el.classList.remove('on'); clearTimeout(el._t); el._t = setTimeout(() => { if (el._n === n) el.hidden = true; }, 200); };

  let pop = null; // { sid, anchor, ask }
  function togglePop(sid, anchor) { if (pop && pop.sid === sid) closePop(); else openPop(sid, anchor); }
  function openPop(sid, anchor) {
    pop = { sid, anchor, ask: false };
    ui(); renderPop(); placePop(); showEl(root.querySelector('.pop'));
    const c = cache[sid];
    if (!c || Date.now() - (c.at || 0) > REVISIT_MS) pedir(sid, true);
  }
  function closePop() { if (!pop) return; pop = null; if (root) hideEl(root.querySelector('.pop')); }
  function placePop() {
    if (!pop || !root) return;
    const el = root.querySelector('.pop'), r = pop.anchor.getBoundingClientRect();
    if (!pop.anchor.isConnected || r.bottom < 0 || r.top > innerHeight) { closePop(); return; }
    const w = Math.min(300, innerWidth - 16), h = el.offsetHeight || 260;
    let left = r.right - w, top = r.bottom + 8;
    left = Math.max(8, Math.min(left, innerWidth - w - 8));
    if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 8);
    el.style.left = left + 'px'; el.style.top = top + 'px';
  }
  const fmtData = (ts) => { try { return new Date(ts).toLocaleDateString(lang === 'pt' ? 'pt-BR' : lang === 'es' ? 'es' : 'en', { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch (_) { return ''; } };
  function renderPop() {
    if (!pop || !root) return;
    const T = L(), sid = pop.sid, c = cache[sid], p = calc(sid), el = root.querySelector('.pop');
    const title = (c && c.title) || titles[sid] || '';
    const st = state.get(sid);
    el.setAttribute('aria-label', title);
    if (!p) {
      el.innerHTML = `<div class="ph"><b>${esc(title)}</b><div class="sub"><span>${esc(st === 'error' ? T.fErr : T.fLoading)}</span></div><div class="ln"><i style="width:0"></i></div></div>
        ${st === 'error' ? `<div class="pf"><span></span><button class="lk o" data-a="refresh" type="button">${esc(T.fRetry)}</button></div>` : ''}`;
      placePop(); return;
    }
    const mins = Math.floor((Date.now() - (c.at || c.tot || Date.now())) / 60000);
    el.innerHTML = `<div class="ph"><b>${esc(title)}</b><div class="sub"><span>${esc(T.fOf(p.w, p.total))}</span><em>${p.pct}%</em></div><div class="ln"><i style="width:${p.pct}%"></i></div></div>
      ${p.novos ? `<div class="nov"><div><b>${esc(T.fNovos(p.novos))}</b><small>${esc(T.fNovosSub)}</small></div><button class="lk o" data-a="seen" type="button">${esc(T.fOk)}</button></div>` : ''}
      <div class="items">
        ${pop.feito ? `<div class="nov"><div><b>${esc(T.fAllSeenDone)}</b></div><button class="lk o" data-a="undoall" type="button">${esc(T.undo)}</button></div>` : ''}
        ${p.pct < 100 ? `<button class="it" data-a="allseen" type="button"><span class="ic">${ICO.all}</span><span class="tx"><b>${esc(T.fAllSeen)}</b><small>${esc(T.fAllSeenSub)}</small></span></button>` : ''}
        <button class="it" data-a="mark" type="button"><span class="ic">${ICO.check}</span><span class="tx"><b>${esc(T.fMark)}</b><small>${esc(T.fMarkSub)}</small></span></button>
        <button class="it" data-a="reset" type="button"><span class="ic">${ICO.reset}</span><span class="tx"><b>${esc(T.fReset)}</b><small>${esc(T.fResetSub)}</small></span></button>
        ${pop.ask ? `<div class="ask">${esc(T.fResetAsk)}<div class="row"><button class="lk" data-a="noreset" type="button">${esc(T.cancel)}</button><button class="btn pri" data-a="doreset" type="button">${esc(T.fResetGo)}</button></div></div>` : ''}
        ${p.reset ? `<button class="it" data-a="unreset" type="button"><span class="ic">${ICO.undo}</span><span class="tx"><b>${esc(T.fUndoReset)}</b><small>${esc(T.fUndoResetSub(fmtData(p.reset)))}</small></span></button>` : ''}
      </div>
      <div class="pf"><span>${st === 'loading' ? esc(T.fLoading) : esc(T.fUpdated(mins))}</span><button class="lk" data-a="refresh" type="button">${esc(T.fRefresh)}</button></div>`;
    placePop();
  }
  async function salvarUser(sid) {
    const u = user[sid];
    try {
      if (!u || (!u.r && !(u.m || []).length && !Object.keys(u.u || {}).length)) await SYNC.remove(UKEY(sid));
      else await SYNC.set({ [UKEY(sid)]: u });
    } catch (_) { // sync cheio: guarda neste navegador
      try { await ext.storage.local.set({ [UKEY(sid)]: u }); } catch (__) {}
    }
  }
  async function popAction(a) {
    if (!pop) return;
    const sid = pop.sid;
    if (a === 'mark') { const s = sid; closePop(); openPick(s); return; }
    // "Já vi todos": marca o que a Crunchyroll não contou (e tira os desmarcados) → 100%; Desfazer volta como estava
    if (a === 'allseen') {
      const c = cache[sid], p = calc(sid);
      if (c && p) {
        const u = user[sid] || {};
        pop.feito = { antes: JSON.parse(JSON.stringify(u)) };
        user[sid] = { r: u.r || 0, m: [...new Set([...(u.m || []), ...c.eps.filter((e) => !p.seen.has(e.k)).map((e) => e.k)])], u: {} };
        await salvarUser(sid); acertarConhecidos(sid); saveCache(); publicarNovos();
      }
    } else if (a === 'undoall') { if (pop.feito) { user[sid] = pop.feito.antes; pop.feito = null; await salvarUser(sid); publicarNovos(); } }
    else pop.feito = null;
    if (a === 'allseen' || a === 'undoall') { /* feito acima */ }
    else if (a === 'reset') { pop.ask = !pop.ask; }
    else if (a === 'noreset') { pop.ask = false; }
    else if (a === 'doreset') { pop.ask = false; user[sid] = { r: Date.now(), m: [], u: {} }; await salvarUser(sid); }
    else if (a === 'unreset') { const u = user[sid] || {}; user[sid] = { r: 0, m: u.m || [], u: u.u || {} }; await salvarUser(sid); }
    else if (a === 'seen') { const p = calc(sid); if (p) known[sid] = p.total; saveCache(); publicarNovos(); }
    else if (a === 'refresh') { pedir(sid, true); }
    paintRings(sid); renderPop();
  }

  // escolha de episódios: clique marca um, arrastar marca vários, Shift+clique marca o intervalo
  let pick = null; // { sid, sel:Set, tab, last, drag:{mode} }
  function openPick(sid) {
    const c = cache[sid], p = calc(sid);
    if (!c || !p) return;
    pick = { sid, sel: new Set(p.seen), tab: 0, last: -1, drag: null };
    // abre na primeira temporada com episódio não visto
    const firstOpen = c.eps.find((e) => !p.seen.has(e.k));
    if (firstOpen) pick.tab = firstOpen.s;
    ui(); renderPick(); showEl(root.querySelector('.veil')); showEl(root.querySelector('.pick'));
    setTimeout(() => { const b = root.querySelector('.pick .ep'); if (b) b.focus({ preventScroll: true }); }, 60);
  }
  function closePick() { if (!pick) return; pick = null; hideEl(root.querySelector('.pick')); hideEl(root.querySelector('.veil')); }
  function seasonName(c, i) {
    const s = c.seasons[i], T = L();
    const t = (s.t || '').trim();
    return !t || t === (c.title || '').trim() ? `${T.fSeason} ${s.n || i + 1}` : t;
  }
  function renderPick() {
    if (!pick) return;
    const T = L(), c = cache[pick.sid], el = root.querySelector('.pick');
    const cnt = (i) => c.eps.filter((e) => e.s === i && pick.sel.has(e.k)).length, tot = (i) => c.eps.filter((e) => e.s === i).length;
    el.setAttribute('aria-label', T.fMark);
    el.innerHTML = `<div class="top"><div class="ttl"><span class="kick">${esc(T.fMark)}</span><b>${esc(c.title || titles[pick.sid] || '')}</b><small>${esc(T.fPickHelp)}</small></div>
        <button class="x" data-p="close" type="button" aria-label="${esc(T.close)}" title="${esc(T.close)}">${ICO.x}</button></div>
      ${c.seasons.length > 1 ? `<div class="tabs" role="tablist">${c.seasons.map((s, i) => `<button class="tab${i === pick.tab ? ' on' : ''}" role="tab" aria-selected="${i === pick.tab}" data-p="tab" data-i="${i}" type="button" title="${esc(seasonName(c, i))}">${esc(seasonName(c, i))}<span>${cnt(i)}/${tot(i)}</span></button>`).join('')}</div>` : ''}
      <div class="tools"><button class="lk o" data-p="sall" type="button">${esc(T.fSeasonAll)}</button><button class="lk" data-p="snone" type="button">${esc(T.fSeasonNone)}</button><span class="sp"></span>
        <button class="lk o" data-p="all" type="button">${esc(T.fAll)}</button><button class="lk" data-p="none" type="button">${esc(T.fNone)}</button></div>
      <div class="grid">${c.eps.map((e, idx) => e.s !== pick.tab ? '' : `<button class="ep${pick.sel.has(e.k) ? ' on' : ''}" type="button" data-idx="${idx}" aria-pressed="${pick.sel.has(e.k)}" title="${esc(`E${e.n}${e.t ? ' · ' + e.t : ''}`)}">${esc(e.n)}</button>`).join('')}</div>
      <div class="ft"><span class="cnt">${T.fCount(`<b>${pick.sel.size}</b>`, c.eps.length)}</span><button class="lk" data-p="close" type="button">${esc(T.cancel)}</button><button class="btn pri" data-p="save" type="button">${esc(T.fSave)}</button></div>`;
  }
  function refreshPickCounts() {
    const T = L(), c = cache[pick.sid], el = root.querySelector('.pick');
    for (const b of el.querySelectorAll('.ep')) { const on = pick.sel.has(c.eps[+b.dataset.idx].k); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }
    for (const b of el.querySelectorAll('.tab')) { const i = +b.dataset.i; b.querySelector('span').textContent = `${c.eps.filter((e) => e.s === i && pick.sel.has(e.k)).length}/${c.eps.filter((e) => e.s === i).length}`; }
    el.querySelector('.cnt').innerHTML = T.fCount(`<b>${pick.sel.size}</b>`, c.eps.length);
  }
  function setEp(idx, on) { const k = cache[pick.sid].eps[idx].k; if (on) pick.sel.add(k); else pick.sel.delete(k); }
  function wirePick() {
    const el = root.querySelector('.pick');
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-p]');
      if (!b || !pick) return;
      const c = cache[pick.sid], a = b.dataset.p;
      if (a === 'close') return closePick();
      if (a === 'tab') { pick.tab = +b.dataset.i; pick.last = -1; renderPick(); return; }
      if (a === 'sall' || a === 'snone') { for (const ep of c.eps) if (ep.s === pick.tab) { if (a === 'sall') pick.sel.add(ep.k); else pick.sel.delete(ep.k); } }
      if (a === 'all') for (const ep of c.eps) pick.sel.add(ep.k);
      if (a === 'none') pick.sel.clear();
      if (a === 'save') { await salvarPick(); return; }
      refreshPickCounts();
    });
    el.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('.ep');
      if (!b || !pick || e.button !== 0) return;
      e.preventDefault();
      const idx = +b.dataset.idx, k = cache[pick.sid].eps[idx].k, mode = !pick.sel.has(k);
      if (e.shiftKey && pick.last >= 0) {
        const [a, z] = [Math.min(pick.last, idx), Math.max(pick.last, idx)], m = pick.lastMode != null ? pick.lastMode : mode;
        for (let i = a; i <= z; i++) if (cache[pick.sid].eps[i].s === pick.tab) setEp(i, m);
      } else { setEp(idx, mode); pick.lastMode = mode; }
      pick.last = idx; pick.drag = { mode: pick.lastMode };
      refreshPickCounts();
    });
    el.addEventListener('pointerover', (e) => {
      if (!pick || !pick.drag || !(e.buttons & 1)) return;
      const b = e.target.closest('.ep');
      if (!b) return;
      setEp(+b.dataset.idx, pick.drag.mode); pick.last = +b.dataset.idx; refreshPickCounts();
    });
    el.addEventListener('keydown', (e) => {
      const b = e.target.closest('.ep');
      if (!b || !pick || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      const idx = +b.dataset.idx, k = cache[pick.sid].eps[idx].k;
      setEp(idx, !pick.sel.has(k)); pick.last = idx; pick.lastMode = pick.sel.has(k); refreshPickCounts();
    });
  }
  const onUp = () => { if (pick) pick.drag = null; };
  // salvar: o que a Crunchyroll já dá como visto não precisa ser marcado; o que ela dá como visto e a pessoa desmarcou fica guardado como "desmarcado"
  async function salvarPick() {
    const sid = pick.sid, c = cache[sid], u = user[sid] || {}, r = u.r || 0, now = Date.now();
    const m = [], un = {};
    for (const e of c.eps) {
      const a = (c.auto || {})[e.k], autoV = !!(a && a > r);
      const on = pick.sel.has(e.k);
      if (on && !autoV) m.push(e.k);
      if (!on && autoV) un[e.k] = now;
    }
    user[sid] = { r, m, u: un };
    await salvarUser(sid);
    acertarConhecidos(sid); saveCache(); publicarNovos();
    closePick(); paintRings(sid);
  }

  // ───────────────────────── episódio novo: procura sozinha ─────────────────────────
  // De qualquer página da Crunchyroll, a cada 2 h (uma aba por vez): lê a Fila e conta os episódios de cada anime.
  // Se a conta subiu, a rodelinha brilha na próxima vez que a Fila abrir, e o ícone/menu da Maratona avisam.
  async function procurarNovos() {
    if (!alive() || !ligado) return;
    try {
      const l = await ext.storage.local.get(K_BG);
      if (Date.now() - (l[K_BG] || 0) < BG_MS) return;
      await ext.storage.local.set({ [K_BG]: Date.now() });
      const t = await token();
      const w = await api(`/content/v2/discover/${t.acc}/watchlist?order=desc&n=100&locale=${loc()}`);
      for (const it of w.data || []) {
        const md = (it.panel && it.panel.episode_metadata) || {}, sid = md.series_id || (it.panel && it.panel.type === 'series' ? it.panel.id : null);
        if (!sid) continue;
        if (md.series_title) titles[sid] = md.series_title;
        pedir(sid, !cache[sid]); // série nova na fila: progresso completo; as outras só a contagem
      }
    } catch (e) { if (String(e && e.message) === 'login') ligadoLogin = false; }
  }
  // assistindo um episódio da série: o aviso de episódio novo dela já foi visto
  function noEpisodio() {
    if (!/\/watch\//.test(location.pathname)) return;
    const a = document.querySelector('.erc-watch-episode a.show-title-link[href*="/series/"], a.show-title-link[href*="/series/"]');
    const m = a && a.getAttribute('href').match(/\/series\/([A-Z0-9]+)/i);
    if (!m || !cache[m[1]]) return;
    const p = calc(m[1]);
    if (p && p.novos) { known[m[1]] = p.total; saveCache(); publicarNovos(); }
  }

  // ───────────────────────── ciclo de vida ─────────────────────────
  let path = '', loopT = 0, lastVis = 0;
  function loop() {
    if (!alive()) return stop();
    if (location.pathname !== path) {
      path = location.pathname;
      observar(ligado && naFila());
      if (naFila()) lastVis = Date.now();
    }
    if (pop) placePop();
    noEpisodio();
  }
  const onVis = () => {
    if (document.visibilityState !== 'visible' || !naFila()) return;
    if (Date.now() - lastVis < REVISIT_MS) return;
    lastVis = Date.now();
    for (const sid of fila) { const c = cache[sid]; if (!c || Date.now() - (c.at || 0) > REVISIT_MS) pedir(sid, true); }
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    if (pick) { e.stopPropagation(); closePick(); } else if (pop) { e.stopPropagation(); closePop(); }
  };
  const onDocDown = (e) => {
    if (!pop || !e.isTrusted) return;
    const path2 = e.composedPath ? e.composedPath() : [];
    if (path2.includes(host) || path2.includes(pop.anchor)) return;
    closePop();
  };
  const onStore = (ch, area) => {
    if (!alive()) return;
    if (area !== 'local') {
      if (ch.lang) { lang = ch.lang.newValue || I.detect(); paintRings(); renderPop(); if (pick) renderPick(); }
      if (ch.fila) { ligado = ch.fila.newValue !== false; observar(ligado && naFila()); }
    }
    let mexeu = false;
    for (const k of Object.keys(ch)) if (k.startsWith('mtf.')) { const sid = k.slice(4); if (ch[k].newValue) user[sid] = ch[k].newValue; else delete user[sid]; mexeu = true; }
    if (area === 'local' && ch[K_KNOWN] && ch[K_KNOWN].newValue) { const nk = ch[K_KNOWN].newValue; for (const sid of Object.keys(nk)) if (known[sid] == null || nk[sid] > known[sid]) { known[sid] = nk[sid]; mexeu = true; } }
    // outra aba da Crunchyroll calculou algo mais novo (ex.: a procura de episódio novo de 2 em 2 h): junta, série por série
    if (area === 'local' && ch[K_CACHE] && ch[K_CACHE].newValue) {
      const nv = ch[K_CACHE].newValue;
      for (const sid of Object.keys(nv)) if (!cache[sid] || (nv[sid].tot || 0) > (cache[sid].tot || 0)) { cache[sid] = nv[sid]; mexeu = true; }
    }
    if (mexeu) { paintRings(); renderPop(); publicarNovos(); }
  };
  ext.storage.onChanged.addListener(onStore);

  function stop() {
    if (dead) return;
    dead = true;
    clearInterval(loopT); clearInterval(bgT);
    if (mo) mo.disconnect();
    document.removeEventListener('maratona-fila-takeover', onTakeover);
    document.removeEventListener('visibilitychange', onVis);
    document.removeEventListener('pointerdown', onDocDown, true);
    removeEventListener('keydown', onKey, true); removeEventListener('pointerup', onUp, true); removeEventListener('resize', placePop); removeEventListener('scroll', placePop, true);
    try { ext.storage.onChanged.removeListener(onStore); } catch (_) {}
    for (const h of document.querySelectorAll('maratona-ring')) h.remove();
    if (host) host.remove();
  }

  let bgT = 0;
  Promise.all([SYNC.get(null).catch(() => ({})), ext.storage.local.get(null).catch(() => ({}))]).then(([s, l]) => {
    if (dead) return;
    if (I.LANGS.includes(s.lang)) lang = s.lang;
    ligado = s.fila !== false;
    for (const k of Object.keys(l)) if (k.startsWith('mtf.')) user[k.slice(4)] = l[k]; // guardados localmente quando o sync encheu
    for (const k of Object.keys(s)) if (k.startsWith('mtf.')) user[k.slice(4)] = s[k];
    cache = l[K_CACHE] || {}; known = l[K_KNOWN] || {};
    for (const sid of Object.keys(cache)) if (cache[sid].title) titles[sid] = cache[sid].title;
    document.addEventListener('visibilitychange', onVis);
    document.addEventListener('pointerdown', onDocDown, true);
    addEventListener('keydown', onKey, true); addEventListener('pointerup', onUp, true); addEventListener('resize', placePop); addEventListener('scroll', placePop, { capture: true, passive: true });
    loop(); loopT = setInterval(loop, 700);
    setTimeout(procurarNovos, 8000); bgT = setInterval(procurarNovos, 10 * 60 * 1000);
  });
})();
