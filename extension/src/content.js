// Maratona — roda na página da Crunchyroll (mundo isolado da extensão).
// 1) Aperta o botão de pular da própria Crunchyroll assim que ele aparece (abertura, recapitulação, créditos, prévia).
// 2) Depois de pular os créditos, se em 5 s o episódio não trocou e não sobrou nada para ver, aperta o
//    "Próximo episódio" do player. Também destrava o fim do episódio quando o vídeo para no último quadro.
// 3) Mostra o aviso do que foi pulado (com Desfazer), o tutorial, as novidades e o aviso de versão nova (regras 12 e 14).
// Mapa do player (medido ao vivo em 2026-10-27): ver Jarvis/02-projetos/extensoes/crunchyroll/maratona-engenharia-reversa.md
(() => {
  'use strict';
  const ext = (globalThis.browser && globalThis.browser.runtime) ? globalThis.browser : globalThis.chrome;
  const I = globalThis.MT_I18N;
  const NOV = globalThis.MT_NOVIDADES || {};
  if (!ext || !ext.runtime || !I) return;

  // Uma instância por aba: a extensão recarregada injeta uma nova, e a antiga (órfã) para sozinha.
  document.dispatchEvent(new Event('maratona-takeover'));
  let dead = false;
  const onTakeover = () => stop();
  setTimeout(() => document.addEventListener('maratona-takeover', onTakeover), 0);
  const alive = () => { try { return !dead && !!ext.runtime.id; } catch (_) { return false; } };

  const SYNC = ext.storage.sync || ext.storage.local; // Opera: sync pode não existir
  const DEF = { on: true, intro: true, recap: true, credits: true, next: true, toast: true };
  let S = Object.assign({}, DEF);
  let lang = I.detect();
  const L = () => I.T[lang] || I.T.en;
  const VERSION = ext.runtime.getManifest().version;
  const IS_FF = /Firefox\//.test(navigator.userAgent);

  // ───────────────────────── seletores do player ─────────────────────────
  const SEL = {
    controls: '[data-testid="player-controls-root"]',
    skipIcon: '[data-testid^="skip-"][data-testid$="-icon"]', // hoje: skip-intro-icon (o mesmo botão serve para tudo)
    next: '[data-testid="next-episode-button"]',
    back10: '[data-testid="jump-backward-button"]',
    video: '#player-container video, .video-player-wrapper video, video',
  };
  // O botão é um só e muda de texto ("Pular introdução" → "Pular créditos"). O texto diz o tipo; se o idioma for
  // um que não está aqui, a posição no vídeo decide (primeira metade = abertura, segunda = créditos).
  const RE = {
    skip: /skip|pular|saltar|omitir|passer|überspring|salta|пропуст|تخطي|छोड़/i,
    recap: /recap|resum|zusammenfass|riepilog|riassun|récap|пересказ|краткое|ملخص/i,
    preview: /preview|pr[ée]via|avance|vorschau|anteprima|aper[çc]u|превью|анонс|معاينة/i,
    credits: /cr[ée]dit|abspann|titoli|титр|الشارة|ختام|क्रेडिट|ending|encerramento|cierre/i,
    intro: /intro|abertura|opening|g[ée]n[ée]rique|vorspann|sigla|заставк|المقدمة|इंट्रो/i,
  };

  const $ = (s, r) => (r || document).querySelector(s);
  const video = () => $(SEL.video);
  const epId = () => { const m = location.pathname.match(/\/watch\/([A-Za-z0-9]+)/); return m ? m[1] : null; };
  const visible = (el) => !!el && el.getAttribute('aria-hidden') !== 'true' && !el.disabled && el.getClientRects().length > 0
    && getComputedStyle(el).pointerEvents !== 'none' && getComputedStyle(el).visibility !== 'hidden';

  function findSkip() {
    const root = $(SEL.controls);
    if (!root) return null;
    for (const ic of root.querySelectorAll(SEL.skipIcon)) { const b = ic.closest('button'); if (b) return b; }
    // reserva: botão sem data-testid cujo rótulo é "pular/skip..." (os de avançar 10 s têm número e data-testid)
    for (const b of root.querySelectorAll('button[aria-label]')) {
      const a = b.getAttribute('aria-label') || '';
      if (!b.hasAttribute('data-testid') && RE.skip.test(a) && !/\d/.test(a)) return b;
    }
    return null;
  }
  // tempos dos trechos que o próprio player usa (skip-events): dizem o tipo sem depender do idioma
  let events = null, eventsFor = null;
  async function loadEvents(id) {
    eventsFor = id; events = null;
    try {
      const r = await fetch(`https://static.crunchyroll.com/skip-events/production/${id}.json`, { credentials: 'omit' });
      if (!r.ok || eventsFor !== id) return; // 404 = episódio sem marcação
      const j = await r.json();
      events = ['intro', 'recap', 'credits', 'preview'].map((t) => (j[t] && j[t].start != null && j[t].end != null ? { type: t, start: +j[t].start, end: +j[t].end } : null)).filter((x) => x && x.end > x.start);
    } catch (_) { /* sem rede ou formato novo: fica pelo rótulo */ }
  }
  const segAt = (t, pad) => (events || []).find((s) => t >= s.start - pad && t < s.end + pad) || null;
  function classify(b, v) {
    const ev = v && segAt(v.currentTime, 1);
    if (ev) return ev.type;
    const lab = (b.getAttribute('aria-label') || b.textContent || '').trim();
    if (RE.recap.test(lab)) return 'recap';
    if (RE.preview.test(lab)) return 'preview';
    if (RE.credits.test(lab)) return 'credits';
    if (RE.intro.test(lab)) return 'intro';
    return v && v.duration > 0 && v.currentTime > v.duration / 2 ? 'credits' : 'intro';
  }
  const enabled = (type) => (type === 'intro' ? S.intro : type === 'recap' ? S.recap : S.credits);
  // clique "de verdade" (a sequência que o React do player espera)
  function press(el) {
    const r = el.getBoundingClientRect(), o = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    try { el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerType: 'mouse', isPrimary: true }, o))); } catch (_) {}
    el.dispatchEvent(new MouseEvent('mousedown', o));
    try { el.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerType: 'mouse', isPrimary: true }, o))); } catch (_) {}
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.click();
  }

  // "Acorda" os controles como um mouse passando por cima (o player escuta na raiz dos controles; medido ao vivo)
  function wake() {
    const el = $(SEL.controls);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    for (const t of ['pointerover', 'pointerenter', 'pointermove']) { try { el.dispatchEvent(new PointerEvent(t, Object.assign({ pointerType: 'mouse', isPrimary: true }, o))); } catch (_) {} }
    for (const t of ['mouseover', 'mouseenter', 'mousemove']) el.dispatchEvent(new MouseEvent(t, o));
  }

  // ───────────────────────── estado por episódio ─────────────────────────
  // done: tipos já pulados neste episódio (voltar a barra para rever a abertura não faz pular de novo)
  // suppress: grupos desfeitos pela pessoa (não pula mais neste episódio)
  const fresh = () => ({ done: new Set(), wakes: {}, lastWake: 0, suppress: new Set(), lastClick: 0, armedAt: 0, endSince: 0, nextDone: false, lastT: -1, lastTAt: 0 });
  let ep = epId(), st = fresh();

  function tick() {
    if (!alive()) return stop();
    const e = epId();
    if (e !== ep) { ep = e; st = fresh(); hideToast(); }
    if (ep && eventsFor !== ep) loadEvents(ep);
    // desligada, fora de um episódio ou com atualização URGENTE pendente (regra 14): não faz nada
    if (!S.on || !ep || urgente()) { hideCountdown(); return; }
    const v = video();
    if (v) { if (Math.abs(v.currentTime - st.lastT) > 0.05) { st.lastT = v.currentTime; st.lastTAt = Date.now(); } }

    // 1) pular
    const b = findSkip();
    if (b && visible(b) && Date.now() - st.lastClick > 2000) {
      const type = classify(b, v);
      const grp = type === 'preview' ? 'credits' : type;
      if (enabled(type) && !st.suppress.has(grp) && !st.done.has(type)) {
        const from = v ? v.currentTime : null, epAt = ep;
        st.lastClick = Date.now();
        press(b);
        (async () => { // o player começa o pulo ~0,65 s depois do clique: confere por até 2,5 s
          let to = null;
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 250));
            if (ep !== epAt || dead) return;
            to = v ? v.currentTime : null;
            if (from != null && to != null && to - from > 2) break;
          }
          const ok = from != null && to != null && to - from > 2;
          record({ type, ok, s: ok ? Math.round(to - from) : 0 });
          if (ok) { st.done.add(type); addStats({ seconds: to - from, skips: 1 }); if (S.toast) toastSkip(type, to - from); }
          if (grp === 'credits') st.armedAt = st.lastClick; // os 5 s contam a partir do clique em "Pular créditos"
        })();
      }
    } else if (b && v && !v.paused && Date.now() - st.lastWake > 1500) {
      // O botão só fica sozinho na tela uns 5 s; depois some até os controles aparecerem (e escondido o clique não vale).
      // Se o skip-events diz que ainda estamos dentro de um trecho ligado, "acorda" os controles com um movimento de mouse.
      const s = segAt(v.currentTime, 0);
      const grp = s && (s.type === 'preview' ? 'credits' : s.type);
      if (s && enabled(s.type) && !st.suppress.has(grp) && !st.done.has(s.type) && v.currentTime < s.end - 3 && (st.wakes[s.type] || 0) < 3) {
        st.wakes[s.type] = (st.wakes[s.type] || 0) + 1;
        st.lastWake = Date.now();
        wake();
      }
    }

    // 2) próximo episódio
    if (!S.next || !v || !(v.duration > 60) || st.nextDone) { hideCountdown(); return; }
    const rem = v.duration - v.currentTime;
    const stalled = Date.now() - st.lastTAt > 1200;
    const atEnd = v.ended || (rem < 2.5 && (v.paused || stalled));
    if (atEnd) { if (!st.endSince) st.endSince = Date.now(); } else st.endSince = 0;
    let due = st.endSince ? st.endSince + 5000 : 0;
    // pediu "créditos pulados → 5 s → próximo": só se não sobrou nada para ver (cena pós-créditos continua tocando)
    if (st.armedAt && rem <= 10) due = due ? Math.min(due, st.armedAt + 5000) : st.armedAt + 5000;
    if (!due) { hideCountdown(); return; }
    const nb = $(SEL.next);
    if (!nb || nb.disabled) { hideCountdown(); return; } // último episódio: nada a fazer
    const left = due - Date.now();
    if (left > 0) { if (S.toast) showCountdown(Math.ceil(left / 1000), left); return; }
    st.nextDone = true;
    hideCountdown();
    press(nb);
    record({ type: 'next', ok: true, s: 0 });
    addStats({ eps: 1 });
    if (S.toast) toast(L().tNext, null);
  }

  // ───────────────────────── registro e estatística (local, sem dado pessoal) ─────────────────────────
  async function record(ev) {
    try {
      const k = 'mt.log', cur = (await ext.storage.local.get(k))[k] || [];
      cur.push(Object.assign({ em: Date.now() }, ev));
      await ext.storage.local.set({ [k]: cur.slice(-15) });
    } catch (_) {}
  }
  async function addStats(d) {
    try {
      const k = 'mt.stats', cur = (await ext.storage.local.get(k))[k] || { seconds: 0, skips: 0, eps: 0 };
      for (const [a, b] of Object.entries(d)) cur[a] = (cur[a] || 0) + b;
      await ext.storage.local.set({ [k]: cur });
    } catch (_) {}
  }

  // ───────────────────────── interface (shadow DOM, segue a tela cheia) ─────────────────────────
  // Visual da própria Crunchyroll (medido ao vivo em 2026-10-27; ver pesquisa/2026-10-27-design-crunchyroll):
  // painel #272727 com raio 8 do menu do player, laranja #ff640a da marca, DM Sans (a fonte do site), botões
  // retos em maiúsculas do site, aviso em pílula como o "Pular introdução", curva cubic-bezier(.4,0,.2,1) em .2s.
  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .wrap { --o5: #ff640a; --o4: #ff8036; --o6: #d25108; --n8: #151515; --n7: #272727; --n6: #414141; --n5: #636363; --n4: #8c8c8c; --n3: #bbb; --n2: #d8d8d8;
    --ease: cubic-bezier(.4,0,.2,1);
    font-family: DMSans, "DM Sans", "Helvetica Neue", helvetica, sans-serif; font-size: 14px; line-height: 20px; color: #fff;
    -webkit-font-smoothing: antialiased; }
  button { font-family: inherit; }
  button:focus-visible { outline: 2px solid var(--o5); outline-offset: 2px; }
  [hidden] { display: none !important; }

  /* aviso no player: pílula como o botão "Pular introdução", escura para não confundir com o do site */
  .toast { position: fixed; z-index: 2147483646; display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 6px 0 14px;
    border-radius: 999px; background: var(--n7); box-shadow: 0 10px 15px -3px rgba(0,0,0,.45), 0 4px 6px -4px rgba(0,0,0,.45);
    overflow: hidden; pointer-events: auto; max-width: min(460px, calc(100vw - 32px));
    opacity: 0; transform: translateY(8px); transition: opacity .2s var(--ease), transform .2s var(--ease); }
  .toast.on { opacity: 1; transform: none; }
  .toast .ic { flex: none; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 999px; background: var(--o5); color: #000; }
  .msg { font-size: 16px; font-weight: 700; letter-spacing: -.48px; line-height: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 4px; }
  .toast:not(:has(.act)) { padding-right: 18px; }
  .act { flex: none; height: 32px; padding: 0 14px; border: 0; border-radius: 999px; background: transparent; color: var(--o5); cursor: pointer;
    font-size: 13px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; transition: background-color .15s var(--ease), color .15s var(--ease); }
  .act:hover { background: rgba(255,100,10,.14); color: var(--o4); }
  .act:active { color: var(--o6); }
  .bar { position: absolute; left: 0; bottom: 0; height: 3px; width: 100%; background: var(--o5); transform-origin: left center; }

  /* quadros no meio da tela: o painel "Configurações" do player */
  .card { position: fixed; z-index: 2147483647; left: 50%; top: 50%; width: 400px; max-width: calc(100vw - 32px);
    background: var(--n7); border-radius: 8px; overflow: hidden; pointer-events: auto;
    box-shadow: 0 20px 25px -5px rgba(0,0,0,.55), 0 8px 10px -6px rgba(0,0,0,.55);
    opacity: 0; transform: translate(-50%, -47%) scale(.98); transition: opacity .2s var(--ease), transform .2s var(--ease); }
  .card.on { opacity: 1; transform: translate(-50%, -50%); }
  .card::before { content: ""; display: block; height: 4px; background: var(--o5); }
  .top { display: flex; align-items: flex-start; gap: 12px; padding: 18px 12px 6px 20px; }
  .app { flex: none; width: 36px; height: 36px; border-radius: 6px; background: var(--o5); color: #000; display: grid; place-items: center; }
  .ttl { flex: 1; min-width: 0; }
  .kick { display: block; color: var(--o5); font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; line-height: 16px; }
  .ttl b { display: block; font-size: 18px; font-weight: 700; letter-spacing: -.54px; line-height: 24px; }
  .ttl small { display: block; color: var(--n3); font-size: 12px; line-height: 16px; margin-top: 2px; }
  .x { flex: none; width: 36px; height: 36px; border: 0; border-radius: 999px; background: none; color: var(--n3); cursor: pointer; display: grid; place-items: center;
    transition: background-color .15s var(--ease), color .15s var(--ease); }
  .x:hover { background: var(--n6); color: #fff; }
  .x:active { background: var(--n5); }
  .bd { padding: 8px 20px 4px; }
  .bd h3 { margin: 0 0 6px; font-size: 16px; font-weight: 700; letter-spacing: -.48px; line-height: 22px; }
  .bd p { margin: 0; color: var(--n2); font-size: 14px; line-height: 21px; }
  .bd b { color: #fff; }
  ul { margin: 0; padding: 0; list-style: none; }
  li { position: relative; padding: 7px 0 7px 18px; color: var(--n2); font-size: 14px; line-height: 20px; border-top: 1px solid rgba(255,255,255,.06); }
  li:first-child { border-top: 0; }
  li::before { content: ""; position: absolute; left: 0; top: 14px; width: 8px; height: 8px; background: var(--o5); }
  .note { margin: 10px 0 0; padding: 10px 12px; background: rgba(255,100,10,.1); border-left: 3px solid var(--o5); color: #f2f2f2; font-size: 13px; line-height: 19px; }
  .warn { margin: 6px 0 2px; display: inline-block; padding: 3px 8px; background: var(--o5); color: #000; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  .langs { display: flex; gap: 2px; align-items: center; padding: 12px 20px 0; }
  .langs button { border: 0; background: none; color: var(--n4); cursor: pointer; padding: 6px 8px; font-size: 12px; font-weight: 700; letter-spacing: .06em;
    transition: color .15s var(--ease), box-shadow .15s var(--ease); }
  .langs button:hover { color: #fff; }
  .langs button.on { color: #fff; box-shadow: inset 0 -2px 0 var(--o5); }
  .ft { display: flex; align-items: center; gap: 8px; padding: 16px 20px 20px; }
  .dots { display: flex; gap: 4px; margin-right: auto; }
  .dots i { width: 16px; height: 4px; background: var(--n6); transition: background-color .2s var(--ease), width .2s var(--ease); }
  .dots i.on { width: 24px; background: var(--o5); }
  .btn { height: 40px; padding: 0 16px; border: 0; border-radius: 0; cursor: pointer; font-size: 14px; font-weight: 700; letter-spacing: .04em; line-height: 1;
    text-transform: uppercase; transition: background-color .2s var(--ease), color .2s var(--ease), box-shadow .2s var(--ease); }
  .pri { background: var(--o5); color: #000; }
  .pri:hover { background: var(--o4); }
  .pri:active { background: var(--o6); }
  .sec { background: transparent; color: var(--o5); box-shadow: inset 0 0 0 2px var(--o5); }
  .sec:hover { color: var(--o4); box-shadow: inset 0 0 0 2px var(--o4); }
  .btn[disabled] { background: var(--n6); color: var(--n4); box-shadow: none; cursor: default; }
  .lk { border: 0; background: none; color: var(--n3); cursor: pointer; padding: 0 8px; height: 40px; font-size: 13px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
    transition: color .15s var(--ease); }
  .lk:hover { color: #fff; }
  kbd { font-family: inherit; font-weight: 700; color: #fff; background: var(--n6); padding: 0 6px; border-radius: 4px; }
  @media (prefers-reduced-motion: reduce) { .toast, .card, .dots i { transition: none; } }
  `;
  const ICO = {
    ff: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M5 6.5v11l7-5.5zM12.5 6.5v11l7-5.5z"/></svg>',
    app: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M3.5 6v12l8-6zM11.5 6v12l8-6z"/><rect x="19.5" y="6" width="2" height="12" rx=".6"/></svg>',
    x: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    gift: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
    star: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="m12 3 2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z"/></svg>',
    alert: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M12 2.5 1.5 21h21zm-1 7h2v6h-2zm0 7.5h2v2h-2z"/></svg>',
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let host = null, root = null;
  function ui() {
    if (!host) {
      host = document.createElement('maratona-ui');
      root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${CSS}</style><div class="wrap"><div class="toast" role="status" hidden></div><div class="card" role="dialog" aria-modal="false" hidden></div></div>`;
    }
    const parent = document.fullscreenElement || document.body;
    if (host.parentNode !== parent && parent) parent.appendChild(host);
    return root;
  }
  const onFs = () => { if (host) ui(); placeToast(); };
  document.addEventListener('fullscreenchange', onFs);

  // entra e sai com a mesma transição do botão de pular do player (opacidade .2s)
  // (cada "mostrar" tem um número: um "esconder" no meio cancela a entrada pendente, senão o quadro reacenderia)
  let seq = 0;
  const showEl = (el) => {
    clearTimeout(el._t); el.hidden = false;
    const n = el._n = ++seq;
    void el.offsetWidth; // força o estilo inicial para a transição rodar
    el._t = setTimeout(() => { if (el._n === n) el.classList.add('on'); }, 16);
  };
  const hideEl = (el) => { el._n = 0; el.classList.remove('on'); clearTimeout(el._t); el._t = setTimeout(() => { if (!el._n) el.hidden = true; }, 200); };

  // aviso no canto de baixo do vídeo, acima da barra de controles
  function placeToast() {
    if (!root) return;
    const t = root.querySelector('.toast');
    if (!t || t.hidden) return;
    const v = video(), r = v && v.getBoundingClientRect();
    const box = r && r.width > 100 ? r : { left: 0, bottom: innerHeight, width: innerWidth };
    t.style.left = Math.max(12, box.left + 24) + 'px';
    t.style.top = Math.max(12, Math.min(innerHeight, box.bottom) - 156) + 'px';
  }
  addEventListener('resize', placeToast);

  let toastTimer = 0, countdownOn = false, toastOpen = false;
  function toast(msg, action, ms, bar) {
    const t = ui().querySelector('.toast');
    countdownOn = false;
    t.innerHTML = `<span class="ic">${ICO.ff}</span><span class="msg">${esc(msg)}</span>${action ? `<button class="act" type="button">${esc(action.label)}</button>` : ''}${bar ? '<span class="bar"></span>' : ''}`;
    if (action) t.querySelector('.act').addEventListener('click', (e) => { e.stopPropagation(); action.run(); });
    if (bar) { // barra laranja que esvazia, como a linha do tempo do player
      const b = t.querySelector('.bar');
      b.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: bar, easing: 'linear', fill: 'forwards' });
    }
    toastOpen = true;
    showEl(t);
    placeToast();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, ms || 5000);
  }
  function hideToast() { if (root && toastOpen) hideEl(root.querySelector('.toast')); toastOpen = false; countdownOn = false; clearTimeout(toastTimer); }
  // Desfazer usa o "Retroceder 10 segundos" do próprio player: mudar video.currentTime direto trava o player
  // da Crunchyroll em carregamento (medido ao vivo em 2026-10-27).
  async function rewind(secs) {
    const jb = $(SEL.back10);
    if (!jb) return false;
    const n = Math.min(30, Math.ceil(secs / 10));
    for (let i = 0; i < n && !dead; i++) { press(jb); await new Promise((r) => setTimeout(r, 150)); }
    return true;
  }
  function toastSkip(type, jumped) {
    const msg = { intro: L().tIntro, recap: L().tRecap, credits: L().tCredits, preview: L().tPreview }[type];
    const epAt = ep, grp = type === 'preview' ? 'credits' : type;
    toast(msg, { label: L().undo, run: () => {
      const v = video();
      if (ep !== epAt || !v) return hideToast();
      st.suppress.add(grp);
      if (grp === 'credits') st.armedAt = 0;
      rewind(jumped);
      record({ type: 'undo-' + type, ok: true, s: 0 });
      toast(L().undone, null, 3500);
    } });
  }
  let lastCount = 0;
  function showCountdown(s, msLeft) {
    if (countdownOn) {
      if (s !== lastCount) { lastCount = s; const m = root.querySelector('.toast .msg'); if (m) m.textContent = L().tNextIn(s); }
      return placeToast();
    }
    lastCount = s;
    toast(L().tNextIn(s), { label: L().cancel, run: () => { st.nextDone = true; record({ type: 'next-cancel', ok: true, s: 0 }); hideToast(); } }, 8000, msLeft || s * 1000);
    countdownOn = true;
  }
  function hideCountdown() { if (countdownOn) hideToast(); }

  // ───────────────────────── quadros no meio da tela (tutorial, novidades, versão nova) ─────────────────────────
  // Regra 14 do hub (revisada 2026-10-27 20h): procura sozinha (ao abrir, a cada 30 min pelo fundo e ao voltar para a aba,
  // no máximo 1 vez a cada 10 min); versão nova aparece na hora; o X só adia 1 h (nesta página; noutra abertura volta);
  // Release com "URGENTE" no título: quadro sem X e a Maratona pausa até atualizar.
  const PAGE_ID = Math.random().toString(36).slice(2);
  const ADIA_MS = 60 * 60 * 1000;
  let open = null, step = 0, newsFrom = '', upd = {}, adiado = null, updBusy = false, updDone = null, ready = false;
  const card = () => ui().querySelector('.card');
  const urgente = () => !!(upd.disponivel && upd.urgente && upd.ultima && cmpVer(upd.ultima, VERSION) > 0);
  const adiadoAqui = () => !!(adiado && adiado.pagina === PAGE_ID && adiado.ultima === upd.ultima && adiado.ate > Date.now());
  function langsHtml() {
    return `<div class="langs" role="radiogroup" aria-label="${esc(L().lang)}">${I.LANGS.map((l) => `<button type="button" data-l="${l}" role="radio" aria-checked="${lang === l}" class="${lang === l ? 'on' : ''}">${l.toUpperCase()}</button>`).join('')}</div>`;
  }
  function wire(c, redraw) {
    const x = c.querySelector('.x');
    if (x) x.addEventListener('click', () => closeCard(true));
    for (const b of c.querySelectorAll('.langs button')) b.addEventListener('click', async () => {
      lang = b.dataset.l;
      try { await SYNC.set({ lang }); } catch (_) {}
      redraw();
    });
  }
  function head(icon, kick, title, sub, noX) {
    return `<div class="top"><span class="app">${icon}</span><span class="ttl"><span class="kick">${esc(kick)}</span><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>
      ${noX ? '' : `<button class="x" type="button" title="${esc(L().close)}" aria-label="${esc(L().close)}">${ICO.x}</button>`}</div>`;
  }
  function paint(c) { if (c.hidden || !c.classList.contains('on')) showEl(c); }
  function closeCard(byX) {
    if (!root) return;
    const was = open;
    if (was === 'update' && urgente()) return; // urgente: não fecha
    hideEl(card());
    open = null;
    if (was === 'update') { // X ou Esc: adia 1 h (só nesta página)
      adiado = { ultima: upd.ultima, ate: Date.now() + ADIA_MS, pagina: PAGE_ID };
      try { ext.storage.local.set({ 'mt.adiado': adiado }); } catch (_) {}
    } else setTimeout(maybeUpdate, 400); // o aviso de versão espera o tutorial/novidades
  }
  function renderTutorial() {
    const T = L(), n = T.steps.length, [h, p] = T.steps[step], last = step === n - 1, c = card();
    c.setAttribute('aria-label', T.tutTitle);
    c.innerHTML = `${head(ICO.app, 'Maratona', T.tutTitle, T.step(step + 1, n))}
      <div class="bd"><h3>${esc(h)}</h3><p>${p}</p></div>${langsHtml()}
      <div class="ft"><span class="dots">${T.steps.map((_, i) => `<i class="${i === step ? 'on' : ''}"></i>`).join('')}</span>
        ${last ? '' : `<button class="lk skip" type="button">${esc(T.skip)}</button>`}
        ${step ? `<button class="btn sec back" type="button">${esc(T.back)}</button>` : ''}
        <button class="btn pri go" type="button">${esc(last ? T.ok : T.nextBtn)}</button></div>`;
    wire(c, renderTutorial);
    const sk = c.querySelector('.skip'); if (sk) sk.addEventListener('click', () => closeCard(false));
    const bk = c.querySelector('.back'); if (bk) bk.addEventListener('click', () => { step--; renderTutorial(); });
    c.querySelector('.go').addEventListener('click', () => { if (last) closeCard(false); else { step++; renderTutorial(); } });
  }
  function tutorial() { if (urgente()) return; open = 'tutorial'; step = 0; renderTutorial(); paint(card()); }
  const cmpVer = (a, b) => { const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0), pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; } return 0; };
  const itensDe = (from, to) => {
    const N = NOV[lang] || NOV.en || {};
    const vs = Object.keys(N).filter((x) => cmpVer(x, to) <= 0 && (!from || cmpVer(x, from) > 0)).sort((a, b) => cmpVer(b, a));
    return [].concat(...vs.map((x) => N[x] || [])).slice(0, 8);
  };
  function news() {
    const items = itensDe(newsFrom, VERSION);
    if (!items.length || urgente()) return;
    open = 'news';
    const T = L(), c = card();
    c.setAttribute('aria-label', T.newsTitle(VERSION));
    c.innerHTML = `${head(ICO.star, 'Maratona', T.newsTitle(VERSION))}<div class="bd"><ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>${langsHtml()}
      <div class="ft"><span class="dots"></span><button class="btn pri go" type="button">${esc(T.ok)}</button></div>`;
    wire(c, news);
    c.querySelector('.go').addEventListener('click', () => closeCard(false));
    paint(c);
  }
  const updCmd = (cmd, data) => new Promise((ok) => {
    try { ext.runtime.sendMessage({ type: 'maratona:update', cmd, data }).then(ok, () => ok(null)); } catch (_) { ok(null); }
  });
  const noteItems = (md) => String(md || '').split(/\r?\n/).filter((l) => !/^\s*#/.test(l)) // títulos do Release não viram item
    .map((l) => l.replace(/^\s*(#+|[-*+]|\d+\.)\s*/, '').replace(/[*_`]/g, '').trim())
    .filter((l) => l && !/^(install|download|works on|chrome, edge|firefox 1|open .?chrome|drag the zip)/i.test(l))
    .slice(0, 4);
  function updateCard() {
    open = 'update';
    const T = L(), c = card(), items = noteItems(upd.notas), urg = urgente();
    const note = updDone === 'xpi' || (updDone && IS_FF) ? T.updXpi : updDone === 'loja' ? T.updStore : updDone ? T.updZip : '';
    c.setAttribute('aria-label', urg ? T.urgTitle(upd.ultima) : T.updTitle(upd.ultima));
    c.innerHTML = `${head(urg ? ICO.alert : ICO.gift, urg ? T.urgKick : 'Maratona', urg ? T.urgTitle(upd.ultima) : T.updTitle(upd.ultima), `v${VERSION} → v${upd.ultima}`, urg)}
      <div class="bd">${urg ? `<span class="warn">${esc(T.urgPaused)}</span><p>${esc(T.urgSub)}</p>` : ''}
        ${items.length ? `<ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}${note ? `<div class="note">${esc(note)}</div>` : ''}</div>${langsHtml()}
      <div class="ft"><span class="dots"></span><button class="lk how" type="button">${esc(T.updHow)}</button>
        <button class="btn pri go" type="button"${updBusy ? ' disabled' : ''}>${esc(updBusy ? '…' : T.updGo)}</button></div>`;
    wire(c, updateCard);
    c.querySelector('.how').addEventListener('click', () => updCmd('guide', '#atualizar'));
    c.querySelector('.go').addEventListener('click', async () => {
      updBusy = true; updateCard();
      const r = await updCmd('apply');
      updBusy = false; updDone = (r && r.modo) || 'download';
      if (open === 'update') updateCard();
    });
    paint(c);
  }
  function maybeUpdate() {
    if (!ready || dead) return;
    const tem = upd.disponivel && upd.ultima && cmpVer(upd.ultima, VERSION) > 0;
    if (!tem) { if (open === 'update') { open = null; hideEl(card()); } return; }
    if (urgente()) { if (open !== 'update') { hideToast(); updateCard(); } return; } // urgente passa na frente de tudo
    if (open || adiadoAqui()) return;
    updateCard();
  }
  const onKey = (e) => {
    if (e.key !== 'Escape' || !open) return;
    if (open === 'update' && urgente()) { e.stopPropagation(); return; }
    closeCard(open === 'update'); e.stopPropagation();
  };
  addEventListener('keydown', onKey, true);

  // procura de versão nova enquanto a página está aberta: ao abrir e ao voltar para a aba (o fundo limita a 1 vez / 10 min)
  const procurarAgora = () => { if (alive()) updCmd('check-soft'); };
  const onVis = () => { if (document.visibilityState === 'visible') procurarAgora(); };
  document.addEventListener('visibilitychange', onVis);
  addEventListener('focus', procurarAgora);

  async function startBoxes() {
    let ob;
    try { ob = (await ext.storage.local.get('mt.onboard'))['mt.onboard']; } catch (_) { return; }
    try { upd = (await ext.storage.local.get('mt.update'))['mt.update'] || {}; } catch (_) {}
    procurarAgora();
    await new Promise((r) => setTimeout(r, 1500)); // deixa a Crunchyroll desenhar primeiro
    if (dead) return;
    ready = true;
    if (urgente()) return maybeUpdate();
    if (!ob || ob.tutorial === 'pendente') {
      await ext.storage.local.set({ 'mt.onboard': Object.assign({}, ob || {}, { tutorial: 'visto', visto: VERSION }) });
      return tutorial();
    }
    if (ob.visto !== VERSION) {
      await ext.storage.local.set({ 'mt.onboard': Object.assign({}, ob, { visto: VERSION }) });
      newsFrom = ob.visto || '';
      news();
      if (open) return;
    }
    maybeUpdate();
  }

  // ───────────────────────── ajustes, mensagens e ciclo de vida ─────────────────────────
  const onStore = (ch, area) => {
    if (!alive()) return;
    if (area !== 'local') {
      for (const k of Object.keys(DEF)) if (ch[k]) S[k] = ch[k].newValue === undefined ? DEF[k] : ch[k].newValue;
      if (ch.lang) { lang = ch.lang.newValue || I.detect(); if (open === 'tutorial') renderTutorial(); else if (open === 'news') news(); else if (open === 'update') updateCard(); }
    }
    if (area === 'local' && ch['mt.adiado']) { adiado = ch['mt.adiado'].newValue || null; maybeUpdate(); }
    if (area === 'local' && ch['mt.update']) {
      upd = ch['mt.update'].newValue || {};
      if (open === 'update' && upd.disponivel) updateCard(); else maybeUpdate();
    }
  };
  ext.storage.onChanged.addListener(onStore);
  const onMsg = (m) => {
    if (!alive() || !m) return;
    if (m.type === 'maratona:tutorial') { ready = true; tutorial(); }
    if (m.type === 'maratona:news') { newsFrom = ''; news(); }
  };
  ext.runtime.onMessage.addListener(onMsg);

  let timer = 0, timerUpd = 0;
  function stop() {
    if (dead) return;
    dead = true;
    clearInterval(timer); clearInterval(timerUpd);
    document.removeEventListener('maratona-takeover', onTakeover);
    document.removeEventListener('fullscreenchange', onFs);
    document.removeEventListener('visibilitychange', onVis);
    removeEventListener('focus', procurarAgora);
    removeEventListener('keydown', onKey, true);
    removeEventListener('resize', placeToast);
    try { ext.storage.onChanged.removeListener(onStore); ext.runtime.onMessage.removeListener(onMsg); } catch (_) {}
    if (host) host.remove();
  }

  SYNC.get(null).then((s) => {
    for (const k of Object.keys(DEF)) if (k in s) S[k] = s[k];
    if (I.LANGS.includes(s.lang)) lang = s.lang;
  }).catch(() => {}).finally(() => {
    if (dead) return;
    timer = setInterval(tick, 250);
    timerUpd = setInterval(maybeUpdate, 30000); // o adiamento de 1 h vence → o aviso volta sozinho
    startBoxes();
  });
})();
