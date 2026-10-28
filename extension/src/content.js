// Maratona — roda na página da Crunchyroll (mundo isolado da extensão).
// 1) Aperta o botão de pular da própria Crunchyroll assim que ele aparece (abertura, recapitulação, créditos, prévia).
// 2) Depois de pular os créditos, se em 5 s o episódio não trocou e não sobrou nada para ver, aperta o
//    "Próximo episódio" do player. Também destrava o fim do episódio quando o vídeo para no último quadro.
// 3) Mostra o aviso do que foi pulado (com Desfazer), o tutorial, as novidades e o aviso de versão nova (regras 12 e 14).
// 4) Menu dentro do site (v1.2.0): botão na barra do player, botão flutuante abaixo do vídeo, Alt+M e o ícone da extensão.
// 5) A Fila com progresso (v1.3.0) mora em src/fila.js; aqui só o ajuste "Progresso na Fila" e o aviso de episódio novo no menu.
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
  const DEF = { on: true, intro: true, recap: true, credits: true, next: true, toast: true, fila: true };
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
  // abertura: também respeita a exceção "assistir a abertura desta série" (menu, v1.2.0)
  const enabled = (type) => (type === 'intro' ? S.intro && !keepThisSeries() : type === 'recap' ? S.recap : S.credits);
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
  const fresh = () => ({ nextIn: 0, done: new Set(), wakes: {}, lastWake: 0, suppress: new Set(), lastClick: 0, armedAt: 0, endSince: 0, nextDone: false, lastT: -1, lastTAt: 0 });
  let ep = epId(), st = fresh();

  function tick() {
    if (!alive()) return stop();
    const e = epId();
    if (e !== ep) { ep = e; st = fresh(); hideToast(); serie = undefined; }
    if (ep && eventsFor !== ep) loadEvents(ep);
    menuFrame(); // menu: botão na barra do player, botão flutuante e status ao vivo
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
    st.nextIn = 0;
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
    if (left > 0) { st.nextIn = Math.ceil(left / 1000); if (S.toast) showCountdown(st.nextIn, left); return; }
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

  /* botão flutuante (como a coroa do Midas, no visual da Crunchyroll) */
  .fab { position: fixed; z-index: 2147483645; width: 44px; height: 44px; border: 0; border-radius: 999px; background: var(--o5); color: #000; cursor: pointer;
    display: grid; place-items: center; pointer-events: auto; touch-action: none; box-shadow: 0 10px 15px -3px rgba(0,0,0,.5), 0 4px 6px -4px rgba(0,0,0,.5);
    transition: background-color .2s var(--ease), transform .2s var(--ease); }
  .fab:hover { background: var(--o4); transform: scale(1.06); }
  .fab:active { background: var(--o6); transform: scale(.97); }
  .fab[aria-expanded="true"] { background: #fff; }
  .fab.dot::after { content: ""; position: absolute; top: 1px; right: 1px; width: 11px; height: 11px; border-radius: 99px; background: #fff; box-shadow: 0 0 0 2px var(--o5); }
  .fab[data-mode="free"] { cursor: grab; }

  /* o menu: o painel "Configurações" do player */
  .menu { position: fixed; z-index: 2147483646; background: var(--n7); border-radius: 8px; overflow: auto; pointer-events: auto; overscroll-behavior: contain;
    box-shadow: 0 20px 25px -5px rgba(0,0,0,.55), 0 8px 10px -6px rgba(0,0,0,.55); scrollbar-width: thin; scrollbar-color: var(--n5) transparent;
    opacity: 0; transform: scale(.97); transition: opacity .2s var(--ease), transform .2s var(--ease); }
  .menu.on { opacity: 1; transform: none; }
  .mh { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 12px; padding: 14px 16px; background: var(--n8); box-shadow: inset 0 -1px 0 rgba(255,255,255,.06); }
  .mh .app { width: 32px; height: 32px; }
  .mt { flex: 1; min-width: 0; }
  .mt b { display: block; font-size: 18px; font-weight: 700; letter-spacing: -.54px; line-height: 22px; }
  .mt .st { display: block; color: var(--o5); font-size: 12px; font-weight: 700; line-height: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .banner { display: flex; width: 100%; align-items: center; min-height: 40px; padding: 8px 16px; border: 0; cursor: pointer; text-align: left; background: var(--o5); color: #000;
    font-size: 13px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; transition: background-color .2s var(--ease); }
  .banner:hover { background: var(--o4); }
  .banner::after { content: "→"; margin-left: auto; font-size: 16px; }
  .mbody { transition: opacity .2s var(--ease); }
  .mbody.off { opacity: .45; pointer-events: none; }
  .mhead { padding: 16px 16px 6px; font-size: 16px; font-weight: 700; letter-spacing: -.48px; line-height: 22px; color: #fff; }
  .it { display: flex; align-items: center; gap: 12px; padding: 10px 16px; cursor: pointer; user-select: none; transition: background-color .15s var(--ease); }
  .it:hover { background: var(--n6); }
  .it:active { background: var(--n5); }
  .it .tx { flex: 1; min-width: 0; }
  .it b { display: block; font-size: 14px; font-weight: 400; line-height: 20px; color: #fff; }
  .it small { display: block; font-size: 12px; line-height: 16px; color: var(--n3); margin-top: 1px; }
  /* chave igual à "Reproduzir Próximo" do player */
  .sw { flex: none; position: relative; width: 40px; height: 24px; padding: 0; border: 2px solid var(--n4); border-radius: 999px; background: transparent; cursor: pointer;
    transition: border-color .2s var(--ease); }
  .sw i { position: absolute; left: 0; top: 0; bottom: 0; margin: auto 0; width: 20px; height: 20px; border-radius: 999px; color: var(--n4);
    transition: transform .2s var(--ease), color .2s var(--ease); }
  .sw i::before { content: ""; position: absolute; inset: 3px; border-radius: 999px; background: currentColor; transition: inset .2s var(--ease); }
  .sw i::after { content: ""; position: absolute; left: 7px; top: 4.5px; width: 4px; height: 8px; border: solid #000; border-width: 0 2px 2px 0; transform: rotate(45deg) scale(0);
    transition: transform .2s var(--ease); }
  .sw[aria-checked="true"] { border-color: var(--o5); }
  .sw[aria-checked="true"] i { transform: translateX(16px); color: var(--o5); }
  .sw[aria-checked="true"] i::before { inset: 0; }
  .sw[aria-checked="true"] i::after { transform: rotate(45deg) scale(1); }
  .sw:hover, .it:hover .sw { border-color: var(--n3); }
  .sw:hover i, .it:hover .sw i { color: var(--n3); }
  .sw[aria-checked="true"]:hover, .it:hover .sw[aria-checked="true"] { border-color: var(--o6); }
  .sw[aria-checked="true"]:hover i, .it:hover .sw[aria-checked="true"] i { color: var(--o6); }
  .fc { position: absolute; top: -6px; right: -6px; min-width: 22px; height: 20px; padding: 0 5px; border-radius: 999px; background: #fff; color: #000;
    font-size: 11px; font-weight: 700; line-height: 20px; text-align: center; box-shadow: 0 0 0 2px var(--o5); }
  .fab:has(.fc:not([hidden])) { animation: mtpulse 2s var(--ease) infinite; }
  @keyframes mtpulse { 0% { box-shadow: 0 0 0 0 rgba(255,100,10,.6), 0 10px 15px -3px rgba(0,0,0,.5); } 70% { box-shadow: 0 0 0 12px rgba(255,100,10,0), 0 10px 15px -3px rgba(0,0,0,.5); } 100% { box-shadow: 0 0 0 0 rgba(255,100,10,0), 0 10px 15px -3px rgba(0,0,0,.5); } }
  /* sininho no topo do menu */
  .bell { position: relative; flex: none; width: 36px; height: 36px; border: 0; border-radius: 999px; background: none; color: var(--n3); cursor: pointer; display: grid; place-items: center;
    transition: background-color .15s var(--ease), color .15s var(--ease); }
  .bell:hover { background: var(--n6); color: #fff; }
  .bell.on { color: var(--o5); }
  .bell.ring svg { animation: mtring 1.6s var(--ease) 2; transform-origin: 50% 10%; }
  @keyframes mtring { 0%, 50%, 100% { transform: rotate(0); } 10%, 30% { transform: rotate(14deg); } 20%, 40% { transform: rotate(-14deg); } }
  .bell .bc { position: absolute; top: 2px; right: 0; min-width: 18px; height: 16px; padding: 0 4px; border-radius: 999px; background: var(--o5); color: #000;
    font-size: 10px; font-weight: 700; line-height: 16px; text-align: center; box-shadow: 0 0 0 2px var(--n8); }
  /* lista de episódios novos */
  .nl { padding: 4px 0 2px; }
  .nh { display: flex; align-items: center; gap: 8px; padding: 12px 16px 6px; }
  .nh b { flex: 1; font-size: 16px; font-weight: 700; letter-spacing: -.48px; line-height: 22px; }
  .bk { width: 32px; height: 32px; border: 0; border-radius: 999px; background: none; color: var(--n3); cursor: pointer; display: grid; place-items: center; }
  .bk:hover { background: var(--n6); color: #fff; }
  .ni { display: flex; align-items: center; gap: 10px; padding: 10px 16px; transition: background-color .15s var(--ease); }
  .ni:hover { background: var(--n6); }
  .ni .tx { flex: 1; min-width: 0; cursor: pointer; }
  .ni b { display: block; font-size: 14px; font-weight: 700; line-height: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ni small { display: block; color: var(--o5); font-size: 12px; font-weight: 700; line-height: 16px; }
  .ni .lk { height: 30px; padding: 0 6px; font-size: 11px; }
  .nempty { padding: 6px 16px 10px; color: var(--n3); font-size: 13px; line-height: 19px; }
  .nfoot { display: flex; justify-content: space-between; padding: 4px 10px 0; }
  .nfoot .lk { height: 32px; font-size: 11px; }
  /* pop-up de episódio novo: pequeno, no canto de cima, some sozinho */
  .pop { position: fixed; z-index: 2147483646; top: 76px; right: 20px; width: 320px; max-width: calc(100vw - 32px); display: flex; gap: 12px; align-items: flex-start;
    padding: 14px 8px 14px 14px; background: var(--n7); border-left: 4px solid var(--o5); border-radius: 8px; pointer-events: auto;
    box-shadow: 0 20px 25px -5px rgba(0,0,0,.55), 0 8px 10px -6px rgba(0,0,0,.55);
    opacity: 0; transform: translateY(-8px); transition: opacity .2s var(--ease), transform .2s var(--ease); }
  .pop.on { opacity: 1; transform: none; }
  .pop .pi { flex: none; width: 32px; height: 32px; border-radius: 6px; background: var(--o5); color: #000; display: grid; place-items: center; }
  .pop .pt { flex: 1; min-width: 0; }
  .pop .pt .kick { display: block; color: var(--o5); font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; line-height: 14px; }
  .pop .pt b { display: block; font-size: 15px; font-weight: 700; letter-spacing: -.4px; line-height: 20px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pop .pt small { display: block; color: var(--n3); font-size: 12px; line-height: 16px; }
  .pop .pa { display: flex; gap: 4px; margin-top: 8px; }
  .pop .pa .btn { height: 30px; padding: 0 12px; font-size: 12px; }
  .pop .x { width: 30px; height: 30px; }
  .nb { flex: none; min-width: 28px; height: 22px; padding: 0 7px; border-radius: 999px; background: var(--o5); color: #000; font-size: 12px; font-weight: 700; line-height: 22px; text-align: center; }
  .stats { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; margin: 6px 16px 0; padding-top: 14px; border-top: 1px solid rgba(255,255,255,.06); }
  .big small { display: block; color: var(--n4); font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; line-height: 16px; }
  .big span { display: block; color: var(--o5); font-size: 26px; font-weight: 700; letter-spacing: -.78px; line-height: 32px; }
  .sm { display: flex; flex-direction: column; text-align: right; color: var(--n3); font-size: 12px; line-height: 18px; }
  .mmsg { margin: 12px 16px 0; padding: 10px 12px; background: rgba(255,100,10,.1); border-left: 3px solid var(--o5); font-size: 13px; line-height: 19px; color: #f2f2f2; }
  .mmsg a { color: var(--o5); font-weight: 700; text-transform: uppercase; text-decoration: none; letter-spacing: .04em; }
  .mf { margin: 14px 16px 0; padding: 12px 0 14px; border-top: 1px solid rgba(255,255,255,.08); display: flex; flex-direction: column; gap: 8px; }
  .mf .row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 0; }
  .mf .lk { height: auto; padding: 4px 0; margin-right: 12px; font-size: 11px; white-space: nowrap; }
  .help { margin-left: auto; width: 28px; height: 28px; border-radius: 999px; border: 2px solid var(--n6); background: transparent; color: #fff; font-weight: 700; cursor: pointer;
    transition: border-color .15s var(--ease), color .15s var(--ease); }
  .help:hover { border-color: var(--o5); color: var(--o5); }
  .sig { color: var(--n4); font-size: 12px; }
  .sig a { color: #fff; font-weight: 700; text-decoration: none; transition: color .15s var(--ease); }
  .sig a:hover { color: var(--o5); }
  .mf .langs { margin-left: auto; padding: 0; }
  .mf .langs button { padding: 4px 6px; }
  @media (prefers-reduced-motion: reduce) { .toast, .card, .dots i, .menu, .fab, .sw, .sw i, .pop { transition: none; } .fab, .bell.ring svg { animation: none !important; } }
  `;
  const ICO = {
    bell: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/></svg>',
    back: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
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
      root.innerHTML = `<style>${CSS}</style><div class="wrap"><div class="toast" role="status" hidden></div><div class="card" role="dialog" aria-modal="false" hidden></div>
        <button class="fab" type="button" aria-label="Maratona" hidden><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">${ICON_PATH}</svg><span class="fc" hidden></span></button>
        <div class="pop" role="status" hidden></div>
        <div class="menu" role="dialog" aria-modal="false" hidden></div></div>`;
      // nada que acontece no nosso painel chega ao player (em tela cheia ele fica dentro do player: um clique pausaria o vídeo)
      for (const t of ['click', 'dblclick', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'keydown', 'keyup', 'wheel', 'contextmenu']) host.addEventListener(t, (e) => e.stopPropagation());
      const f = root.querySelector('.fab');
      f.addEventListener('pointerdown', onFabDown); f.addEventListener('pointermove', onFabMove); f.addEventListener('pointerup', onFabUp);
      f.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMenu('fab'); } });
      root.querySelector('.menu').addEventListener('click', (e) => {
        const el = e.target.closest('[data-act]');
        if (!el) return;
        e.preventDefault();
        menuAction(el.dataset.act, el);
      });
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
  async function marcarNovLidas() {
    try { const ob = (await ext.storage.local.get('mt.onboard'))['mt.onboard'] || {}; await ext.storage.local.set({ 'mt.onboard': Object.assign({}, ob, { novLidas: BASE }) }); } catch (_) {}
  }
  const visivel = () => new Promise((ok) => {
    if (document.visibilityState === 'visible') return ok();
    const f = () => { if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', f); ok(); } };
    document.addEventListener('visibilitychange', f);
  });
  function closeCard(byX) {
    if (!root) return;
    const was = open;
    if (was === 'news') marcarNovLidas();
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
  const baseVer = (v) => String(v || '').split('.').slice(0, 3).join('.');
  const BASE = baseVer(VERSION);
  const versaoAnterior = (v) => Object.keys(NOV.en || NOV.pt || {}).filter((x) => cmpVer(x, v) < 0).sort((a, b) => cmpVer(b, a))[0] || '';
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
    c.setAttribute('aria-label', T.newsTitle(BASE));
    c.innerHTML = `${head(ICO.star, 'Maratona', T.newsTitle(BASE))}<div class="bd"><ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>${langsHtml()}
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
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'KeyM' || /^m$/i.test(e.key))) {
      const t = e.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));
      if (!typing) { e.preventDefault(); e.stopPropagation(); toggleMenu('auto'); }
      return;
    }
    if (e.key === 'Escape' && menuOpen && !open) { closeMenu(); e.stopPropagation(); return; }
    if (e.key !== 'Escape' || !open) return;
    if (open === 'update' && urgente()) { e.stopPropagation(); return; }
    closeCard(open === 'update'); e.stopPropagation();
  };
  addEventListener('keydown', onKey, true);

  // procura de versão nova enquanto a página está aberta: ao abrir e ao voltar para a aba (o fundo limita a 1 vez / 10 min)
  const procurarAgora = () => { if (alive()) updCmd('check-soft'); };
  const onVis = () => { if (document.visibilityState === 'visible') { procurarAgora(); avisarNovos(); } };
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
    // tutorial e novidades só aparecem com a aba na frente: uma aba em segundo plano não "gasta" o quadro
    await visivel();
    if (dead) return;
    setTimeout(avisarNovos, 2500); // episódio novo que saiu enquanto a Crunchyroll estava fechada ou em outra aba
    try { ob = (await ext.storage.local.get('mt.onboard'))['mt.onboard'] || ob; } catch (_) {}
    if (!ob || ob.tutorial === 'pendente') {
      await ext.storage.local.set({ 'mt.onboard': Object.assign({}, ob || {}, { tutorial: 'visto', visto: VERSION, novLidas: BASE }) });
      return tutorial();
    }
    // "Novidades da vX.Y.Z": aparece depois de atualizar e só conta como lido quando a pessoa fecha o quadro
    // (X, Esc ou Entendi; chave novLidas = versão base X.Y.Z). Uma versão de teste X.Y.Z.n não gasta o quadro da versão de verdade.
    // (A 1.3.0 marcava "novidades" ao mostrar: quem tem essa chave vê de novo o que mudou desde a versão anterior a ela.)
    if (ob.visto !== VERSION) await ext.storage.local.set({ 'mt.onboard': Object.assign({}, ob, { visto: VERSION }) });
    if (ob.novLidas !== BASE) {
      let from = ob.novLidas ? ob.novLidas : ob.novidades ? versaoAnterior(ob.novidades) : (ob.visto || '');
      if (from && cmpVer(baseVer(from), BASE) >= 0) from = versaoAnterior(BASE);
      newsFrom = from;
      news();
      if (open) return;
      marcarNovLidas(); // nada novo para mostrar
    }
    maybeUpdate();
  }

  // ───────────────────────── menu dentro da Crunchyroll (v1.2.0) ─────────────────────────
  // Pedido do André: tudo num menu dentro do site (no lugar do popup do ícone), parecido com o HUD do Midas, sem nunca
  // ficar em cima do vídeo. Duas portas de entrada, um painel só:
  //  - botão da Maratona na barra do player, ao lado da engrenagem (abre como o menu "Configurações" do player, também
  //    em tela cheia; mantém os controles acordados enquanto está aberto);
  //  - botão flutuante laranja: na página do episódio fica preso logo abaixo do player (some se não há espaço abaixo
  //    dele e em tela cheia); nas outras páginas fica no canto, arrastável, com a posição lembrada.
  // Atalho Alt+M. O ícone da extensão na barra do navegador abre este mesmo menu.
  const BAR_ID = 'maratona-bar-btn';
  const ICON_PATH = '<path d="M3.5 6v12l8-6zM11.5 6v12l8-6z"/><rect x="19.5" y="6" width="2" height="12" rx=".6"/>';
  const MITEMS = ['intro', 'recap', 'credits', 'next', 'toast'];
  let menuOpen = false, menuAnchor = null, menuMsg = null, lastStatus = '', lastWakeMenu = 0;
  let stats = { seconds: 0, skips: 0, eps: 0 }, keepIntro = {}, fabPos = null, fabMode = 'free', filaNovos = [], menuView = 'main';
  let serie; // undefined = ainda não procurada neste episódio; null = sem série

  function seriesInfo() {
    if (serie !== undefined && serie) return serie;
    const a = $('.erc-watch-episode a[href*="/series/"]') || $('a.show-title-link[href*="/series/"]');
    const m = a && (a.getAttribute('href') || '').match(/\/series\/([A-Za-z0-9]+)/);
    serie = m ? { id: m[1], name: (a.textContent || '').trim().slice(0, 80) } : null;
    return serie;
  }
  const novosTotal = () => (S.fila ? filaNovos.reduce((a, n) => a + (n.n || 0), 0) : 0);
  const langPath = () => { const m = location.pathname.match(/^\/([a-z]{2}(?:-[a-z]{2})?)\//); return m ? '/' + m[1] : ''; };
  function keepThisSeries() { const s = ep && seriesInfo(); return !!(s && keepIntro[s.id]); }

  // botão na barra do player: mesma forma, cor e efeito dos botões do player (copia a classe da engrenagem)
  function barButton() { return document.getElementById(BAR_ID); }
  function ensureBarButton() {
    const set = $('[data-testid="player-settings-menu-button"]');
    if (!set || !set.parentElement) return null;
    // a fileira da direita é <stack> → <div> (casinha) → <div> → <button>: o nosso entra como casinha nova, antes da engrenagem
    const stack = set.closest('[data-testid="bottom-right-controls-stack"]');
    let slot = set;
    if (stack) while (slot.parentElement && slot.parentElement !== stack) slot = slot.parentElement;
    if (!stack || slot === set) slot = set.parentElement; // estrutura diferente: ao lado do botão mesmo
    const row = slot.parentElement;
    let b = barButton();
    if (b && b.isConnected && b.parentElement && b.parentElement.parentElement === row) return b;
    if (b && b.parentElement) b.parentElement.remove();
    const wrap = document.createElement('div');
    wrap.className = slot.className;
    b = document.createElement('button');
    b.type = 'button'; b.id = BAR_ID;
    b.className = set.className;
    b.style.position = 'relative';
    const svgCls = (set.querySelector('svg') && set.querySelector('svg').getAttribute('class')) || '';
    b.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" class="${esc(svgCls)}">${ICON_PATH}</svg><span data-dot hidden style="position:absolute;top:7px;right:7px;width:9px;height:9px;border-radius:99px;background:#ff640a;box-shadow:0 0 0 2px #000"></span><span data-count hidden style="position:absolute;top:2px;right:0;min-width:18px;height:16px;padding:0 4px;border-radius:99px;background:#ff640a;color:#000;font:700 10px/16px DMSans,'DM Sans',sans-serif;text-align:center;box-shadow:0 0 0 2px #000"></span>`;
    const stopEv = (ev) => ev.stopPropagation();
    for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick']) b.addEventListener(t, stopEv);
    b.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); toggleMenu('bar'); });
    wrap.appendChild(b);
    row.insertBefore(wrap, slot);
    paintBarButton();
    return b;
  }
  function paintBarButton() {
    const b = barButton(); if (!b) return;
    b.setAttribute('aria-label', 'Maratona');
    b.title = `Maratona · ${L().menuHint}`;
    b.setAttribute('aria-expanded', String(menuOpen && menuAnchor === 'bar'));
    const dot = b.querySelector('[data-dot]'), cnt = b.querySelector('[data-count]'), n = novosTotal();
    if (cnt) { cnt.hidden = !n; cnt.textContent = '+' + Math.min(n, 99); }
    if (dot) dot.hidden = !!n || !(upd.disponivel && upd.ultima && cmpVer(upd.ultima, VERSION) > 0);
  }

  // botão flutuante: na página do episódio, preso logo abaixo do player; em tela cheia, escondido
  function placeFab() {
    const r0 = ui(), f = r0.querySelector('.fab');
    const fs = !!document.fullscreenElement;
    const pc = ep && ($('#player-container') || ($('.video-player-wrapper')));
    let x, y, show = !fs;
    if (show && pc) {
      const r = pc.getBoundingClientRect();
      fabMode = 'dock';
      if (r.width < 100) show = false;
      else if (r.bottom < 0) { x = innerWidth - 44 - 24; y = innerHeight - 44 - 24; } // player rolou para cima: canto da tela
      else { x = Math.min(innerWidth - 44 - 16, r.right - 44 - 16); y = r.bottom + 12; if (y + 44 > innerHeight - 8) show = false; } // sem espaço abaixo do vídeo
    } else if (show) {
      fabMode = 'free';
      const p = fabPos || { r: 24, b: 24 };
      x = innerWidth - 44 - Math.min(Math.max(p.r, 8), innerWidth - 60);
      y = innerHeight - 44 - Math.min(Math.max(p.b, 8), innerHeight - 60);
    }
    f.hidden = !show;
    if (show) { f.style.left = Math.round(x) + 'px'; f.style.top = Math.round(y) + 'px'; f.dataset.mode = fabMode; }
    const n = novosTotal();
    f.classList.toggle('dot', !n && !!(upd.disponivel && upd.ultima && cmpVer(upd.ultima, VERSION) > 0));
    const fc = f.querySelector('.fc');
    if (fc) { fc.hidden = !n; fc.textContent = '+' + Math.min(n, 99); }
    f.setAttribute('aria-expanded', String(menuOpen && menuAnchor === 'fab'));
  }

  function menuFrame() {
    if (dead) return;
    if (ep) ensureBarButton();
    placeFab();
    if (!menuOpen) return;
    if (menuAnchor === 'bar') {
      const b = barButton();
      if (!b || !b.isConnected) { menuAnchor = autoAnchor(); }
      else if (Date.now() - lastWakeMenu > 1500) { lastWakeMenu = Date.now(); wake(); } // controles ficam visíveis com o menu aberto
    }
    if (menuAnchor === 'fab' && ui().querySelector('.fab').hidden) menuAnchor = autoAnchor();
    placeMenu();
    const s = statusText();
    if (s !== lastStatus) { lastStatus = s; const el = root.querySelector('.menu .st'); if (el) el.textContent = s; }
  }

  const fmtClock = (secs) => { secs = Math.max(0, Math.round(secs)); const m = Math.floor(secs / 60), r = secs % 60; return `${m}:${String(r).padStart(2, '0')}`; };
  function statusText() {
    const T = L();
    if (!S.on) return T.stOff;
    if (urgente()) return T.urgPaused;
    if (!ep) return T.stNoEp;
    if (st.nextIn > 0) return T.tNextIn(st.nextIn);
    const v = video();
    if (v && events && events.length) {
      const t = v.currentTime;
      const prox = events.filter((s) => enabled(s.type) && !st.done.has(s.type) && !st.suppress.has(s.type === 'preview' ? 'credits' : s.type) && s.end > t + 1)
        .sort((a, b) => a.start - b.start)[0];
      if (prox) return prox.start <= t ? T.stNow(T.segName[prox.type]) : T.stIn(T.segName[prox.type], fmtClock(prox.start - t));
      return T.stDone;
    }
    return T.stWatching;
  }

  function autoAnchor() {
    if (document.fullscreenElement && ensureBarButton()) return 'bar';
    if (!ui().querySelector('.fab').hidden) return 'fab';
    if (ep && ensureBarButton()) return 'bar';
    return 'center';
  }
  function toggleMenu(anchor) { if (menuOpen && (!anchor || anchor === menuAnchor || anchor === 'auto')) closeMenu(); else openMenu(anchor); }
  async function openMenu(anchor) {
    if (dead) return;
    menuAnchor = !anchor || anchor === 'auto' ? autoAnchor() : anchor;
    if (menuAnchor === 'bar') { wake(); lastWakeMenu = Date.now(); }
    menuOpen = true; menuMsg = null;
    try { stats = (await ext.storage.local.get('mt.stats'))['mt.stats'] || stats; } catch (_) {}
    renderMenu();
    showEl(root.querySelector('.menu'));
    placeMenu(); paintBarButton(); placeFab();
  }
  function closeMenu() {
    menuView = 'main';
    if (!menuOpen) return;
    menuOpen = false;
    hideEl(root.querySelector('.menu'));
    paintBarButton(); placeFab();
  }
  function placeMenu() {
    const m = root.querySelector('.menu');
    if (!m || m.hidden) return;
    const W = Math.min(340, innerWidth - 24);
    m.style.width = W + 'px';
    let left, top, maxH, origin = 'bottom right';
    if (menuAnchor === 'bar' && barButton()) {
      const r = barButton().getBoundingClientRect();
      left = Math.min(Math.max(12, r.right - W), innerWidth - W - 12);
      maxH = Math.max(160, r.top - 20);
      top = Math.max(12, r.top - 8 - Math.min(m.scrollHeight, maxH));
    } else if (menuAnchor === 'fab') {
      const r = root.querySelector('.fab').getBoundingClientRect();
      left = Math.min(Math.max(12, r.right - W), innerWidth - W - 12);
      const below = innerHeight - r.bottom - 20, above = r.top - 20;
      // preso abaixo do player: abre para baixo (nunca por cima do vídeo); solto: abre para o lado com mais espaço
      if (fabMode === 'dock' || below >= Math.min(m.scrollHeight, 420) || below >= above) { top = r.bottom + 8; maxH = Math.max(160, below); origin = 'top right'; }
      else { maxH = above; top = Math.max(12, r.top - 8 - Math.min(m.scrollHeight, maxH)); }
    } else {
      left = (innerWidth - W) / 2; maxH = innerHeight - 48; top = Math.max(24, (innerHeight - Math.min(m.scrollHeight, maxH)) / 2); origin = 'center';
    }
    m.style.left = Math.round(left) + 'px'; m.style.top = Math.round(top) + 'px';
    m.style.maxHeight = Math.round(maxH) + 'px'; m.style.transformOrigin = origin;
  }

  function fmtSaved(sec) { const mm = Math.round((sec || 0) / 60); return mm < 60 ? `${mm} min` : `${Math.floor(mm / 60)} h ${String(mm % 60).padStart(2, '0')} min`; }
  // a mensagem guarda o tipo, não o texto: trocar o idioma traduz ela também
  function msgHtml(mg) {
    const T = L();
    if (mg.k === 'checking') return esc(T.checking);
    if (mg.k === 'err') return esc(T.checkErr);
    if (mg.k === 'nova') return `${esc(T.newVer(mg.v))} <a href="#" data-act="apply">${esc(T.updGo)}</a>`;
    return esc(T.upToDate);
  }
  function renderMenu() {
    const T = L(), m = root.querySelector('.menu'), s = ep ? seriesInfo() : null;
    const nova = upd.disponivel && upd.ultima && cmpVer(upd.ultima, VERSION) > 0;
    lastStatus = statusText();
    m.setAttribute('aria-label', 'Maratona');
    const nTot = novosTotal(), lista = S.fila ? filaNovos : [];
    const notifHtml = `<div class="nl"><div class="nh"><button class="bk" data-act="bell" type="button" aria-label="${esc(T.back)}" title="${esc(T.back)}">${ICO.back}</button><b>${esc(T.notifTitle)}</b></div>
        ${lista.length ? lista.map((n) => `<div class="ni"><div class="tx" data-act="nsee" data-sid="${esc(n.sid)}"><b>${esc(n.t)}</b><small>${esc(T.notifSub(n.n))}</small></div>
          <button class="lk o" data-act="nsee" data-sid="${esc(n.sid)}" type="button">${esc(T.notifSee)}</button><button class="lk" data-act="ndis" data-sid="${esc(n.sid)}" type="button">${esc(T.notifDismiss)}</button></div>`).join('')
          : `<p class="nempty">${esc(S.fila ? T.notifEmpty : T.notifOff)}</p>`}
        <div class="nfoot"><button class="lk" data-act="fila" type="button">${esc(T.fOpenFila)}</button>${lista.length > 1 ? `<button class="lk" data-act="nall" type="button">${esc(T.notifAll)}</button>` : ''}</div></div>`;
    m.innerHTML = `<div class="mh"><span class="app">${ICO.app}</span><div class="mt"><b>Maratona</b><small class="st">${esc(lastStatus)}</small></div>
        <button class="bell${menuView === 'notif' ? ' on' : ''}${nTot && menuView !== 'notif' ? ' ring' : ''}" data-act="bell" type="button" aria-label="${esc(T.notifTitle)}${nTot ? ' (' + nTot + ')' : ''}" title="${esc(T.notifTitle)}">${ICO.bell}${nTot ? `<span class="bc">+${Math.min(nTot, 99)}</span>` : ''}</button>
        <button class="sw" data-act="on" role="switch" aria-checked="${!!S.on}" aria-label="${esc(S.on ? T.master : T.masterOff)}" title="${esc(S.on ? T.master : T.masterOff)}" type="button"><i></i></button></div>
      ${nova ? `<button class="banner" data-act="apply" type="button">${esc(upd.urgente ? T.bannerUrg(upd.ultima) : T.banner(upd.ultima))}</button>` : ''}
      ${menuView === 'notif' ? notifHtml : `<div class="mbody${S.on ? '' : ' off'}">
        <div class="mhead">${esc(T.section)}</div>
        ${MITEMS.map((k) => `<div class="it" data-act="set" data-k="${k}"><div class="tx"><b>${esc(T[k])}</b><small>${esc(T[k + 'Sub'])}</small></div>
          <button class="sw" type="button" role="switch" tabindex="-1" aria-checked="${!!S[k]}" aria-label="${esc(T[k])}"><i></i></button></div>`).join('')}
        ${s ? `<div class="mhead">${esc(T.thisSeries)}</div>
        <div class="it" data-act="keep"><div class="tx"><b>${esc(T.keepIntro)}</b><small>${esc(s.name)}</small></div>
          <button class="sw" type="button" role="switch" tabindex="-1" aria-checked="${!!keepIntro[s.id]}" aria-label="${esc(T.keepIntro)}"><i></i></button></div>` : ''}
      </div>
      <div class="mhead">${esc(T.fHead)}</div>
      ${nTot ? `<div class="it" data-act="bell"><div class="tx"><b>${esc(T.fMenuNovos)}</b><small>${esc(filaNovos.slice(0, 3).map((n) => `${n.t} (+${n.n})`).join(' · '))}</small></div><span class="nb">+${nTot}</span></div>` : ''}
      <div class="it" data-act="set" data-k="fila"><div class="tx"><b>${esc(T.fila)}</b><small>${esc(T.filaSub)}</small></div>
        <button class="sw" type="button" role="switch" tabindex="-1" aria-checked="${!!S.fila}" aria-label="${esc(T.fila)}"><i></i></button></div>`}
      <div class="stats"><div class="big"><small>${esc(T.saved)}</small><span>${esc(fmtSaved(stats.seconds))}</span></div>
        <div class="sm"><span>${esc(T.skips(stats.skips || 0))}</span><span>${esc(T.eps(stats.eps || 0))}</span></div></div>
      ${menuMsg ? `<p class="mmsg">${msgHtml(menuMsg)}</p>` : ''}
      <div class="mf"><div class="row"><button class="lk" data-act="check" type="button">${esc(T.check)}</button><button class="lk" data-act="report" type="button">${esc(T.report)}</button><button class="lk" data-act="news" type="button">${esc(T.newsLink)}</button>
          <button class="help" data-act="help" type="button" title="${esc(T.howto)}" aria-label="${esc(T.howto)}">?</button></div>
        <div class="row"><span class="sig">${esc(T.madeBy)} <a href="https://github.com/DredsGG" target="_blank" rel="noopener noreferrer">Dreds</a> · v${esc(VERSION)}</span>${langsHtml()}</div></div>`;
    for (const b of m.querySelectorAll('.langs button')) b.addEventListener('click', async (ev) => {
      ev.stopPropagation(); lang = b.dataset.l;
      try { await SYNC.set({ lang }); } catch (_) {}
      renderMenu(); placeMenu(); paintBarButton();
    });
  }
  async function menuAction(act, el) {
    const T = L();
    if (act === 'on') { S.on = !S.on; await SYNC.set({ on: S.on }).catch(() => {}); }
    else if (act === 'set') { const k = el.dataset.k; S[k] = !S[k]; await SYNC.set({ [k]: S[k] }).catch(() => {}); }
    else if (act === 'keep') {
      const s = seriesInfo(); if (!s) return;
      if (keepIntro[s.id]) delete keepIntro[s.id]; else keepIntro[s.id] = s.name;
      const ks = Object.keys(keepIntro); if (ks.length > 300) delete keepIntro[ks[0]];
      await SYNC.set({ keepIntro }).catch(() => {});
    } else if (act === 'apply') { updCmd('apply'); }
    else if (act === 'fila') { closeMenu(); location.href = `${location.origin}${langPath()}/watchlist`; return; }
    else if (act === 'bell') { menuView = menuView === 'notif' ? 'main' : 'notif'; }
    else if (act === 'nsee') { closeMenu(); location.href = `${location.origin}${langPath()}/series/${el.dataset.sid}`; return; }
    else if (act === 'ndis' || act === 'nall') { await dispensarNovos(act === 'nall' ? filaNovos.map((n) => n.sid) : [el.dataset.sid]); }
    else if (act === 'help') { closeMenu(); ready = true; tutorial(); return; }
    else if (act === 'news') { closeMenu(); ready = true; newsFrom = versaoAnterior(versaoAnterior(BASE)); news(); return; } // as duas últimas versões
    else if (act === 'check') {
      menuMsg = { k: 'checking' }; renderMenu(); placeMenu();
      const r = await updCmd('check');
      menuMsg = !r || r.erro ? { k: 'err' } : r.disponivel ? { k: 'nova', v: r.ultima } : { k: 'ok' };
    } else if (act === 'report') { abrirRelato(); return; }
    if (menuOpen) { renderMenu(); placeMenu(); }
  }

  // "Já vi" na lista do sininho: a contagem conhecida da série passa a ser o total de agora (src/fila.js junta e recalcula)
  async function dispensarNovos(sids) {
    try {
      const k = (await ext.storage.local.get('mt.fila.known'))['mt.fila.known'] || {};
      for (const sid of sids) { const n = filaNovos.find((x) => x.sid === sid); if (n && n.tot) k[sid] = Math.max(k[sid] || 0, n.tot); }
      await ext.storage.local.set({ 'mt.fila.known': k });
    } catch (_) {}
  }
  // pop-up de episódio novo: aparece uma vez por episódio novo (em qualquer página da Crunchyroll, na aba que está na frente)
  let popTimer = 0, popSid = null;
  async function avisarNovos() {
    if (!S.fila || !filaNovos.length || document.visibilityState !== 'visible' || urgente() || !alive()) return;
    let av = {};
    try { av = (await ext.storage.local.get('mt.fila.avisados'))['mt.fila.avisados'] || {}; } catch (_) { return; }
    const fresh = filaNovos.filter((n) => n.tot && (av[n.sid] || 0) < n.tot);
    if (!fresh.length) return;
    for (const n of fresh) av[n.sid] = n.tot;
    try { await ext.storage.local.set({ 'mt.fila.avisados': av }); } catch (_) {}
    mostrarPop(fresh);
  }
  function mostrarPop(fresh) {
    const T = L(), el = ui().querySelector('.pop'), one = fresh.length === 1 ? fresh[0] : null;
    popSid = one ? one.sid : null;
    el.innerHTML = `<span class="pi">${ICO.bell}</span><div class="pt"><span class="kick">${esc(T.notifKick)}</span>
        <b>${esc(one ? one.t : T.notifMany(fresh.length))}</b><small>${esc(one ? T.notifSub(one.n) : fresh.map((n) => n.t).join(' · '))}</small>
        <div class="pa"><button class="btn pri" data-pa="see" type="button">${esc(T.notifSee)}</button></div></div>
      <button class="x" data-pa="x" type="button" aria-label="${esc(T.close)}" title="${esc(T.close)}">${ICO.x}</button>`;
    el.onclick = (e) => {
      const b = e.target.closest('[data-pa]'); if (!b) return;
      hidePop();
      if (b.dataset.pa === 'see') { if (popSid) location.href = `${location.origin}${langPath()}/series/${popSid}`; else { menuView = 'notif'; openMenu('auto'); } }
    };
    el.onmouseenter = () => clearTimeout(popTimer);
    el.onmouseleave = () => { clearTimeout(popTimer); popTimer = setTimeout(hidePop, 6000); };
    showEl(el);
    clearTimeout(popTimer); popTimer = setTimeout(hidePop, 12000);
  }
  function hidePop() { clearTimeout(popTimer); if (root) { const el = root.querySelector('.pop'); if (!el.hidden) hideEl(el); } }

  // "Relatar bug": abre o relato nos Issues do repo com a versão e um diagnóstico sem dado pessoal (regra 9)
  function navegador() {
    const ua = navigator.userAgent, m = ua.match(/(Firefox|Edg|OPR|Chrome)\/(\d+)/);
    const nome = !m ? 'unknown' : m[1] === 'Edg' ? 'Edge' : m[1] === 'OPR' ? 'Opera' : (m[1] === 'Chrome' && navigator.brave) ? 'Brave' : m[1];
    const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : 'other';
    return `${nome} ${m ? m[2] : ''} · ${os}`;
  }
  async function abrirRelato() {
    const T = L();
    let loc = {}, diag = {};
    try { loc = await ext.storage.local.get(['mt.log', 'mt.update', 'mt.disco']); } catch (_) {}
    diag = (await updCmd('diag')) || {};
    const agora = Date.now();
    const log = (loc['mt.log'] || []).map((e) => `- ${Math.round((agora - e.em) / 60000)} min: ${e.type} ${e.ok ? 'ok' : 'FAIL'}${e.s ? ` (${e.s}s)` : ''}`).join('\n') || '- (empty)';
    const u = loc['mt.update'] || {};
    const txt = [`Maratona v${VERSION}`, `Browser: ${navegador()}`, `Install: ${diag.instalacao || '?'}`, `UI: ${lang} / ${navigator.language}`,
      `Settings: ${MITEMS.concat('on', 'fila').map((k) => `${k}=${S[k] ? 1 : 0}`).join(' ')} keepIntro=${Object.keys(keepIntro).length} filaNew=${filaNovos.length}`,
      `Player: bar=${barButton() ? 1 : 0} fab=${fabMode} fullscreen=${document.fullscreenElement ? 1 : 0}`,
      `Update check: latest=${u.ultima || '-'} err=${u.erro || '-'}`,
      loc['mt.disco'] ? `Disk: ${loc['mt.disco'].estado || '-'} (${loc['mt.disco'].noDisco || '-'})` : null, '', 'Last events:', log].filter((x) => x !== null).join('\n');
    const body = `${T.bugBody}\n---\n\`\`\`\n${txt}\n\`\`\``;
    window.open(`https://github.com/DredsGG/maratona/issues/new?title=${encodeURIComponent(T.bugTitle)}&body=${encodeURIComponent(body)}&labels=bug`, '_blank', 'noopener');
  }

  // botão flutuante: clique abre o menu; solto (fora do episódio), dá para arrastar e a posição fica salva
  let drag = null;
  function onFabDown(e) {
    if (e.button !== 0) return;
    const f = root.querySelector('.fab');
    drag = { x: e.clientX, y: e.clientY, moved: false, r0: f.getBoundingClientRect() };
    f.setPointerCapture && f.setPointerCapture(e.pointerId);
  }
  function onFabMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (fabMode !== 'free') return; // preso abaixo do player: não arrasta
    drag.moved = true;
    const nx = drag.r0.left + dx, ny = drag.r0.top + dy;
    fabPos = { r: Math.round(innerWidth - nx - 44), b: Math.round(innerHeight - ny - 44) };
    placeFab(); if (menuOpen) placeMenu();
  }
  function onFabUp() {
    if (!drag) return;
    const moved = drag.moved; drag = null;
    if (moved) { try { ext.storage.local.set({ 'mt.fab': fabPos }); } catch (_) {} return; }
    toggleMenu('fab');
  }

  // clique fora fecha o menu (o clique dentro do menu ou do botão não fecha)
  const onDocDown = (e) => {
    if (!menuOpen || !e.isTrusted) return; // os cliques que a própria Maratona dá no player (pular, próximo) não fecham o menu
    const path = e.composedPath ? e.composedPath() : [];
    if (path.includes(host) || path.includes(barButton())) return;
    closeMenu();
  };
  document.addEventListener('pointerdown', onDocDown, true);
  const onScroll = () => { placeFab(); if (menuOpen) placeMenu(); };
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll);

  // ───────────────────────── ajustes, mensagens e ciclo de vida ─────────────────────────
  const onStore = (ch, area) => {
    if (!alive()) return;
    if (area !== 'local') {
      for (const k of Object.keys(DEF)) if (ch[k]) S[k] = ch[k].newValue === undefined ? DEF[k] : ch[k].newValue;
      if (ch.lang) { lang = ch.lang.newValue || I.detect(); if (open === 'tutorial') renderTutorial(); else if (open === 'news') news(); else if (open === 'update') updateCard(); paintBarButton(); }
      if (ch.keepIntro) keepIntro = ch.keepIntro.newValue || {};
      if (menuOpen) { renderMenu(); placeMenu(); }
    }
    if (area === 'local' && ch['mt.fila.novos']) { filaNovos = ch['mt.fila.novos'].newValue || []; avisarNovos(); paintBarButton(); placeFab(); if (menuOpen) { renderMenu(); placeMenu(); } }
    if (area === 'local' && ch['mt.stats']) { stats = ch['mt.stats'].newValue || stats; if (menuOpen) { renderMenu(); placeMenu(); } }
    if (area === 'local' && ch['mt.adiado']) { adiado = ch['mt.adiado'].newValue || null; maybeUpdate(); }
    if (area === 'local' && ch['mt.update']) {
      upd = ch['mt.update'].newValue || {};
      if (open === 'update' && upd.disponivel) updateCard(); else maybeUpdate();
      paintBarButton(); placeFab(); if (menuOpen) { renderMenu(); placeMenu(); }
    }
  };
  ext.storage.onChanged.addListener(onStore);
  const onMsg = (m) => {
    if (!alive() || !m) return;
    if (m.type === 'maratona:tutorial') { ready = true; tutorial(); }
    if (m.type === 'maratona:news') { newsFrom = ''; news(); }
    if (m.type === 'maratona:menu') toggleMenu('auto'); // clique no ícone da extensão na barra do navegador
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
    document.removeEventListener('pointerdown', onDocDown, true);
    removeEventListener('scroll', onScroll); removeEventListener('resize', onScroll);
    const bb = barButton(); if (bb && bb.parentElement) bb.parentElement.remove();
    try { ext.storage.onChanged.removeListener(onStore); ext.runtime.onMessage.removeListener(onMsg); } catch (_) {}
    if (host) host.remove();
  }

  SYNC.get(null).then((s) => {
    for (const k of Object.keys(DEF)) if (k in s) S[k] = s[k];
    if (I.LANGS.includes(s.lang)) lang = s.lang;
    if (s.keepIntro && typeof s.keepIntro === 'object') keepIntro = s.keepIntro;
  }).catch(() => {}).then(() => ext.storage.local.get(['mt.fab', 'mt.stats', 'mt.fila.novos']).then((l) => { fabPos = l['mt.fab'] || null; stats = l['mt.stats'] || stats; filaNovos = l['mt.fila.novos'] || []; }, () => {})).finally(() => {
    if (dead) return;
    timer = setInterval(tick, 250);
    timerUpd = setInterval(maybeUpdate, 30000); // o adiamento de 1 h vence → o aviso volta sozinho
    startBoxes();
  });
})();
