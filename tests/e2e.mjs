// E2E da Maratona num Chromium com a extensão carregada; a Crunchyroll é simulada (mock.mjs, DOM medido ao vivo).
// Uso: node e2e.mjs <pasta-da-extensao> [pt|en|xx]
//   pt: rótulos em português + skip-events; en: rótulos em inglês; xx: rótulo desconhecido e sem skip-events (decide pela posição)
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { routes } from './mock.mjs';

const EXT = path.resolve(process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), '../extension'));
const MODE = process.argv[3] || 'pt';
const DIR = path.dirname(new URL(import.meta.url).pathname);
const VER = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).version;
const SHOT = path.join(DIR, 'shots'); fs.mkdirSync(SHOT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const res = {}; let ok = true;
const check = (name, cond, info) => { res[name] = { ok: !!cond, info }; if (!cond) ok = false; console.log((cond ? '✔' : '✘') + ' ' + name + (info !== undefined ? '  ' + JSON.stringify(info) : '')); };

const ctx = await chromium.launchPersistentContext(path.join('/tmp', 'mt-prof-' + MODE + '-' + Date.now()), {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, locale: MODE === 'pt' ? 'pt-BR' : 'en-US',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--headless=new', '--autoplay-policy=no-user-gesture-required'],
});
await routes(ctx, MODE, { events: MODE !== 'xx' });
await ctx.route('https://github.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>issue</h1>' }));
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
await wait(1500);
for (const pg of ctx.pages()) if (pg.url().includes('COMO-INSTALAR')) { res.guideOnInstall = true; await pg.screenshot({ path: path.join(SHOT, `guia-${MODE}.png`), fullPage: true }); await pg.close(); }
check('guia abre na instalação', res.guideOnInstall);
if (MODE !== 'pt') await sw.evaluate((l) => chrome.storage.sync.set({ lang: l }), MODE === 'en' ? 'en' : 'en');

const p = await ctx.newPage();
const ui = () => p.evaluate(() => {
  const h = document.querySelector('maratona-ui'); if (!h) return {};
  const r = h.shadowRoot, t = r.querySelector('.toast'), c = r.querySelector('.card');
  return { toast: t.hidden ? null : t.querySelector('.msg').textContent, act: t.hidden ? null : (t.querySelector('.act') || {}).textContent || null, card: c.hidden ? null : (c.querySelector('.ttl b') || {}).textContent };
});
const mock = () => p.evaluate(() => ({ ...window.__mock, t: document.querySelector('video').currentTime, paused: document.querySelector('video').paused, url: location.pathname }));
const until = async (fn, ms = 15000, step = 100) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(step); } return null; };
const seek = (t) => p.evaluate((t) => { const v = document.querySelector('video'); v.currentTime = t; return v.play().catch(() => {}); }, t);

await p.goto('https://www.crunchyroll.com/pt-br/watch/EP1/episodio');
await p.waitForSelector('video');

if (MODE === 'pt') {
  // 1) instalação nova → tutorial no meio da página
  const tut = await until(async () => (await ui()).card);
  check('tutorial na instalação nova', tut === 'Como usar a Maratona', tut);
  await wait(500); await p.screenshot({ path: path.join(SHOT, 'tutorial-1.png') });
  await p.locator('maratona-ui .go').click(); await wait(250);
  await p.screenshot({ path: path.join(SHOT, 'tutorial-2.png') });
  await p.keyboard.press('Escape'); await wait(250);
  check('tutorial fecha no Esc', (await ui()).card === null);
}

// 2) abertura: botão aparece em t=2 → clica na hora
await seek(0);
const c1 = await until(async () => { const m = await mock(); return m.clicks.length ? m : null; });
check('pulou a abertura', c1 && c1.clicks[0].type === 'intro' && c1.t > 10, c1 && { click: c1.clicks[0], t: c1.t });
check('reação rápida (<0,6 s do botão aparecer)', c1 && c1.clicks[0].at < 2.6, c1 && c1.clicks[0].at);
await wait(1100);
let u = await ui();
const expIntro = { pt: 'Abertura pulada', en: 'Intro skipped', xx: 'Intro skipped' }[MODE];
check('aviso "abertura pulada" com Desfazer', u.toast === expIntro && !!u.act, u);
await p.screenshot({ path: path.join(SHOT, `aviso-abertura-${MODE}.png`) });

if (MODE === 'pt') {
  // Desfazer: volta e não pula de novo neste episódio
  await p.locator('maratona-ui .act').click(); await wait(2500);
  const m = await mock();
  check('Desfazer volta pelo botão de 10 s do player e não repete', m.t < 6 && m.clicks.length === 1 && m.back >= 1 && m.back <= 2, { t: m.t, clicks: m.clicks.length, back: m.back });
}

// 3) créditos → para no fim → 5 s → próximo episódio
// (o "Desfazer" anterior aperta o voltar-10-s do player simulado com atraso; espera ele terminar e confere que o seek pegou)
await wait(1200);
await seek(84);
if (!(await until(async () => (await mock()).t >= 83, 3000))) await seek(84);
const c2 = await until(async () => { const m = await mock(); return m.clicks.find((c) => c.ep === 'EP1' && c.type === 'credits') ? m : null; });
const credTs = c2 && c2.clicks.find((c) => c.type === 'credits').ts;
check('pulou os créditos', !!c2, c2 && c2.clicks);
await wait(2000);
u = await ui();
check('contagem para o próximo episódio', /\d/.test(u.toast || ''), u);
await p.screenshot({ path: path.join(SHOT, `contagem-${MODE}.png`) });
const n1 = await until(async () => { const m = await mock(); return m.nav.length ? m : null; }, 12000);
const dt = n1 ? (n1.nav[0].ts - credTs) / 1000 : null;
check('foi para o EP2 ~5 s depois de pular os créditos', n1 && n1.url.includes('/EP2/') && dt >= 4.5 && dt <= 7, { dt, url: n1 && n1.url });

if (MODE === 'pt') {
  // 4) EP2: recapitulação e abertura; créditos com cena pós-créditos → NÃO troca enquanto a cena toca
  await seek(0);
  const r2 = await until(async () => { const m = await mock(); const t = m.clicks.filter((c) => c.ep === 'EP2').map((c) => c.type); return t.includes('recap') && t.includes('intro') ? t : null; }, 25000);
  check('EP2: pulou recapitulação e abertura', !!r2, r2);
  await seek(69);
  await until(async () => (await mock()).clicks.find((c) => c.ep === 'EP2' && c.type === 'credits'));
  await wait(7500);
  let m = await mock();
  check('cena pós-créditos: continua tocando, sem trocar', m.url.includes('/EP2/') && !m.paused && m.t > 85, { url: m.url, t: m.t, paused: m.paused });
  await seek(98.6);
  const n2 = await until(async () => { const m = await mock(); return m.url.includes('/EP3/') ? m : null; }, 14000);
  check('fim do EP2 travado → próximo episódio', !!n2);

  // 5) EP3: botão já escondido (passou dos 5 s) → acorda os controles pelo skip-events e pula
  await p.evaluate(() => { const v = document.querySelector('video'); v.pause(); });
  await seek(7.3);
  const w = await until(async () => { const m = await mock(); return m.clicks.find((c) => c.ep === 'EP3' && c.type === 'intro') ? m : null; }, 6000);
  check('botão escondido: acorda os controles e pula', !!w && w.wakes >= 1, w && { wakes: w.wakes, click: w.clicks.find((c) => c.ep === 'EP3') });
  // último episódio: sem botão de próximo → não faz nada
  await seek(84);
  await until(async () => (await mock()).clicks.find((c) => c.ep === 'EP3' && c.type === 'credits'));
  await wait(7000);
  m = await mock(); u = await ui();
  check('último episódio: fica parado, sem contagem', m.url.includes('/EP3/') && !/\d/.test(u.toast || ''), { url: m.url, toast: u.toast });

  // 6) desligar "Pular abertura" no popup → não pula
  await sw.evaluate(() => chrome.storage.sync.set({ intro: false }));
  await p.goto('https://www.crunchyroll.com/pt-br/watch/EP1/episodio'); await p.waitForSelector('video');
  await seek(0); await wait(7000);
  m = await mock();
  check('abertura desligada: não pula', m.clicks.length === 0, m.clicks);
  await sw.evaluate(() => chrome.storage.sync.set({ intro: true }));

  // 7) novidades depois de atualizar (simulado)
  await sw.evaluate(() => chrome.storage.local.set({ 'mt.onboard': { tutorial: 'visto', visto: '0.9.0' } }));
  await p.reload(); await p.waitForSelector('video');
  const nv = await until(async () => (await ui()).card);
  check('quadro de novidades', nv === `Novidades da v${VER}`, nv);
  await wait(500); await p.screenshot({ path: path.join(SHOT, 'novidades.png') });
  await p.locator('maratona-ui .x').click(); await wait(400);
  await p.reload(); await wait(3000);
  check('novidades só uma vez', (await ui()).card == null);

  // 7b) regra 14 (revisada 2026-10-27 20h), com a página JÁ ABERTA: o GitHub é simulado dentro do fundo da extensão
  const fakeRelease = (tag, name) => sw.evaluate(([tag, name]) => {
    globalThis.__realFetch = globalThis.__realFetch || globalThis.fetch;
    globalThis.fetch = async (u, o) => (String(u).includes('api.github.com')
      ? new Response(JSON.stringify({ tag_name: tag, name, body: '## What changed\n- Skips faster\n- Fix for the next episode', html_url: 'https://github.com/DredsGG/maratona/releases/tag/' + tag,
        assets: [{ name: 'maratona-' + tag + '.zip', browser_download_url: 'https://github.com/DredsGG/maratona/releases/download/' + tag + '/maratona-' + tag + '.zip' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      : globalThis.__realFetch(u, o));
    return chrome.storage.local.get('mt.update').then((r) => chrome.storage.local.set({ 'mt.update': Object.assign({}, r['mt.update'] || {}, { procuradoEm: 0 }) }));
  }, [tag, name]);
  const lastCheck = () => sw.evaluate(() => chrome.storage.local.get('mt.update').then((r) => (r['mt.update'] || {}).procuradoEm || 0));
  await fakeRelease('v9.1.0', 'v9.1.0');
  let t0 = Date.now();
  await p.evaluate(() => window.dispatchEvent(new Event('focus'))); // a pessoa volta para a aba
  const up = await until(async () => (await ui()).card, 8000);
  check('regra 14: Release novo aparece sozinho na página aberta, sem recarregar', up === 'Nova versão v9.1.0', { up, ms: Date.now() - t0 });
  await wait(500); await p.screenshot({ path: path.join(SHOT, 'versao-nova.png') });
  const c1 = await lastCheck();
  await p.evaluate(() => window.dispatchEvent(new Event('focus'))); await wait(1000);
  check('regra 14: no máximo 1 consulta a cada 10 min', (await lastCheck()) === c1);
  await p.locator('maratona-ui .x').click(); await wait(400);
  check('regra 14: X fecha o aviso', (await ui()).card == null);
  await wait(1500);
  const ad = await sw.evaluate(() => chrome.storage.local.get('mt.adiado').then((r) => r['mt.adiado']));
  check('regra 14: X só adia 1 h', (await ui()).card == null && ad && Math.abs(ad.ate - Date.now() - 3600e3) < 60000, ad && { faltamMin: Math.round((ad.ate - Date.now()) / 60000) });
  await sw.evaluate(() => chrome.storage.local.get('mt.adiado').then((r) => chrome.storage.local.set({ 'mt.adiado': Object.assign({}, r['mt.adiado'], { ate: Date.now() - 1 }) }))); // a 1 h passou
  const back = await until(async () => (await ui()).card, 6000);
  check('regra 14: passada 1 h o aviso volta sozinho', back === 'Nova versão v9.1.0', back);
  await p.keyboard.press('Escape'); await wait(400);
  check('regra 14: Esc também adia', (await ui()).card == null);
  await p.reload(); await p.waitForSelector('video');
  const again = await until(async () => (await ui()).card, 6000);
  check('regra 14: na próxima abertura volta', again === 'Nova versão v9.1.0', again);
  await p.locator('maratona-ui .x').click(); await wait(400);

  // URGENTE: sem X, Esc não fecha, a Maratona pausa até atualizar
  await fakeRelease('v9.2.0', 'v9.2.0 URGENTE');
  t0 = Date.now();
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const urg = await until(async () => (await ui()).card, 8000);
  check('URGENTE aparece sozinho na página aberta', urg === 'Atualize para a v9.2.0', { urg, ms: Date.now() - t0 });
  const noX = await p.evaluate(() => !document.querySelector('maratona-ui').shadowRoot.querySelector('.card .x'));
  await p.keyboard.press('Escape'); await wait(400);
  check('URGENTE: sem X e o Esc não fecha', noX && (await ui()).card === 'Atualize para a v9.2.0');
  await wait(300); await p.screenshot({ path: path.join(SHOT, 'urgente.png') });
  const nBefore = (await mock()).clicks.length;
  await seek(0); await wait(6000);
  check('URGENTE pausa a Maratona (não pula a abertura)', (await mock()).clicks.length === nBefore);
  await sw.evaluate(() => { if (globalThis.__realFetch) globalThis.fetch = globalThis.__realFetch; });
  await sw.evaluate(() => chrome.storage.local.get('mt.update').then((r) => chrome.storage.local.set({ 'mt.update': Object.assign({}, r['mt.update'], { disponivel: false, urgente: false }) }))); // atualizou
  await wait(600);
  check('depois de atualizar o quadro some', (await ui()).card == null);
  await seek(0);
  const res2 = await until(async () => { const m = await mock(); return m.clicks.length > nBefore ? m : null; }, 8000);
  check('depois de atualizar volta a pular', !!res2);

  // 8) menu dentro da Crunchyroll (v1.2.0)
  await p.goto('https://www.crunchyroll.com/pt-br/watch/EP1/episodio'); await p.waitForSelector('video'); await wait(1800);
  const M = () => p.evaluate(() => {
    const h = document.querySelector('maratona-ui'); if (!h) return {};
    const r = h.shadowRoot, f = r.querySelector('.fab'), m = r.querySelector('.menu');
    const vr = document.querySelector('video').getBoundingClientRect(), fr = f.getBoundingClientRect(), mr = m.getBoundingClientRect();
    const bb = document.getElementById('maratona-bar-btn'), q = (sel) => m.querySelector(sel);
    const txt = (sel) => (q(sel) ? q(sel).textContent.replace(/\s+/g, ' ').trim() : null);
    return { fab: !f.hidden, fabTop: fr.top, videoBottom: vr.bottom, mode: f.dataset.mode, menu: !m.hidden && m.classList.contains('on'), menuTop: mr.top,
      st: txt('.st'), bar: !!bb, barNext: !!(bb && bb.parentElement.nextElementSibling && bb.parentElement.nextElementSibling.querySelector('[data-testid=player-settings-menu-button]')),
      barRow: !!bb && Math.abs(bb.getBoundingClientRect().top - document.querySelector('[data-testid=player-settings-menu-button]').getBoundingClientRect().top) < 2,
      sig: txt('.sig'), href: q('.sig a') && q('.sig a').href, check: txt('[data-act=check]'), report: txt('[data-act=report]'), saved: txt('.big span'), eps: txt('.sm'), series: txt('[data-act=keep] small'),
      fs: !!document.fullscreenElement, hostInFs: !!document.fullscreenElement && document.fullscreenElement.contains(h) };
  });
  let mm = await M();
  check('menu: botão ⏭ na barra do player, ao lado da engrenagem e na mesma fileira', mm.bar && mm.barNext && mm.barRow, { bar: mm.bar, barNext: mm.barNext, barRow: mm.barRow });
  check('menu: botão laranja preso logo abaixo do vídeo (nunca em cima)', mm.fab && mm.mode === 'dock' && mm.fabTop >= mm.videoBottom, { fabTop: mm.fabTop, videoBottom: mm.videoBottom });
  await p.locator('maratona-ui .fab').click(); await wait(400);
  mm = await M();
  check('menu abre pelo botão laranja, para baixo, sem cobrir o vídeo', mm.menu && mm.menuTop >= mm.videoBottom, { menuTop: mm.menuTop, videoBottom: mm.videoBottom });
  check(`menu: rodapé feito por Dreds · v${VER} com link`, mm.sig === `feito por Dreds · v${VER}` && mm.href === 'https://github.com/DredsGG', mm.sig);
  check('menu: Procurar atualização e Relatar bug', mm.check === 'Procurar atualização' && mm.report === 'Relatar bug', { check: mm.check, report: mm.report });
  check('menu: tempo economizado contando', /min/.test(mm.saved || '') && /episódios emendados/.test(mm.eps || ''), { saved: mm.saved, eps: mm.eps });
  check('menu: série detectada', mm.series === 'Série Teste', mm.series);
  await seek(70); await wait(900);
  mm = await M();
  check('menu: status ao vivo ("Créditos em …")', /^Créditos em 0:1\d$/.test(mm.st || ''), mm.st);
  await wait(200); await p.screenshot({ path: path.join(SHOT, 'menu-abaixo.png') });
  await p.locator('maratona-ui .it[data-k="recap"]').click(); await wait(250);
  check('menu: chave grava', (await sw.evaluate(() => chrome.storage.sync.get('recap'))).recap === false);
  await p.locator('maratona-ui .it[data-k="recap"]').click(); await wait(200);
  await p.locator('maratona-ui .it[data-act="keep"]').click(); await wait(250);
  const kept = await sw.evaluate(() => chrome.storage.sync.get('keepIntro'));
  check('menu: "assistir a abertura desta série" grava', kept.keepIntro && kept.keepIntro.SER1 === 'Série Teste', kept);
  await p.mouse.click(1250, 840); await wait(400);
  check('menu fecha no clique fora', !(await M()).menu);
  await p.goto('https://www.crunchyroll.com/pt-br/watch/EP3/episodio'); await p.waitForSelector('video'); await wait(600);
  await seek(0); await wait(6500);
  let mk = await mock();
  check('série com a abertura liberada: não pula a abertura', !mk.clicks.some((c) => c.type === 'intro'), mk.clicks);
  await sw.evaluate(() => chrome.storage.sync.set({ keepIntro: {} }));
  await p.keyboard.press('Alt+m'); await wait(400);
  check('Alt+M abre o menu', (await M()).menu);
  await p.keyboard.press('Escape'); await wait(400);
  check('Esc fecha o menu', !(await M()).menu);
  await sw.evaluate(async () => { const [t] = await chrome.tabs.query({ url: 'https://www.crunchyroll.com/*' }); await chrome.tabs.sendMessage(t.id, { type: 'maratona:menu' }); });
  await wait(400);
  check('ícone da extensão abre o menu na página', (await M()).menu);
  await p.keyboard.press('Escape'); await wait(300);

  // tela cheia: o botão laranja some; o botão da barra abre o menu dentro do player; clicar no menu não pausa
  await p.mouse.move(600, 300); await p.mouse.move(620, 310); await wait(250);
  await p.locator('[data-testid="fullscreen-button"]').click(); await wait(900);
  mm = await M();
  check('tela cheia: botão laranja some', mm.fs && !mm.fab, { fs: mm.fs, fab: mm.fab });
  await p.mouse.move(600, 300); await p.mouse.move(620, 320); await wait(250);
  await p.locator('#maratona-bar-btn').click(); await wait(500);
  mm = await M();
  check('tela cheia: botão da barra abre o menu dentro do player', mm.menu && mm.hostInFs, { menu: mm.menu, hostInFs: mm.hostInFs });
  await wait(300); await p.screenshot({ path: path.join(SHOT, 'menu-tela-cheia.png') });
  const tog0 = (await mock()).toggles;
  await p.locator('maratona-ui .it[data-k="toast"]').click(); await wait(250);
  await p.locator('maratona-ui .it[data-k="toast"]').click(); await wait(300);
  mk = await mock();
  check('clicar no menu não pausa o vídeo', mk.toggles === tog0, { toggles: mk.toggles, antes: tog0 });
  await wait(2600);
  const ahOp = await p.evaluate(() => getComputedStyle(document.querySelector('[data-testid=bottom-controls-autohide]')).opacity);
  check('menu aberto mantém os controles do player visíveis', (await M()).menu && ahOp === '1', ahOp);
  await p.keyboard.press('Escape'); await wait(300);
  await p.evaluate(() => document.exitFullscreen()); await wait(900);
  mm = await M();
  check('saindo da tela cheia o botão laranja volta', !mm.fs && mm.fab, { fs: mm.fs, fab: mm.fab });

  // fora de um episódio: botão no canto, arrastável, posição lembrada
  await p.goto('https://www.crunchyroll.com/pt-br/'); await wait(1500);
  mm = await M();
  check('fora do episódio: botão no canto, solto', mm.fab && mm.mode === 'free', mm.mode);
  const fb = await p.locator('maratona-ui .fab').boundingBox();
  await p.mouse.move(fb.x + 22, fb.y + 22); await p.mouse.down(); await p.mouse.move(fb.x - 200, fb.y - 150, { steps: 8 }); await p.mouse.up(); await wait(300);
  const fpos = await sw.evaluate(() => chrome.storage.local.get('mt.fab').then((r) => r['mt.fab']));
  check('arrastar o botão grava a posição', !!fpos && fpos.r > 150 && fpos.b > 100, fpos);
  check('arrastar não abre o menu', !(await M()).menu);
  await p.reload(); await wait(1500);
  const fb2 = await p.locator('maratona-ui .fab').boundingBox();
  check('posição lembrada depois de recarregar', Math.abs(fb2.x - (fb.x - 200)) < 30 && Math.abs(fb2.y - (fb.y - 150)) < 30, { fb2, alvo: { x: fb.x - 200, y: fb.y - 150 } });
  await p.locator('maratona-ui .fab').click(); await wait(400);
  await sw.evaluate(() => chrome.storage.local.get('mt.update').then((r) => chrome.storage.local.set({ 'mt.update': Object.assign({}, r['mt.update'], { disponivel: true, urgente: false, ultima: '9.9.9' }) })));
  const ban = await until(() => p.evaluate(() => { const b = document.querySelector('maratona-ui').shadowRoot.querySelector('.menu .banner'); return b ? b.textContent : null; }), 3000);
  check('menu: faixa de versão nova', ban === 'Nova versão v9.9.9', ban);
  await sw.evaluate(() => chrome.storage.local.get('mt.update').then((r) => chrome.storage.local.set({ 'mt.update': Object.assign({}, r['mt.update'], { disponivel: false }) })));
  await wait(500);
  if (!(await M()).menu) { await p.locator('maratona-ui .fab').click(); await wait(400); }
  await p.locator('maratona-ui .menu [data-act="check"]').click();
  const chk = await until(() => p.evaluate(() => { const m = document.querySelector('maratona-ui').shadowRoot.querySelector('.menu .mmsg'); return m && !/Procurando/.test(m.textContent) ? m.textContent : null; }), 15000);
  check('menu: Procurar atualização responde', !!chk, chk);
  await p.locator('maratona-ui .menu .langs button[data-l="es"]').click(); await wait(300);
  check('menu em espanhol', await p.evaluate(() => document.querySelector('maratona-ui').shadowRoot.querySelector('.menu [data-act=report]').textContent) === 'Reportar error');
  await wait(300); await p.screenshot({ path: path.join(SHOT, 'menu-es.png') });
  const [issue] = await Promise.all([ctx.waitForEvent('page'), p.locator('maratona-ui .menu [data-act="report"]').click()]);
  await wait(300);
  const iu = decodeURIComponent(issue.url());
  check('Relatar bug abre o Issue com versão e diagnóstico', iu.startsWith('https://github.com/DredsGG/maratona/issues/new') && iu.includes(`Maratona v${VER}`) && iu.includes('Last events') && !/crunchyroll\.com|EP1|Série Teste/.test(iu), iu.slice(0, 160));
  await issue.close();
  // a página da Crunchyroll mudou de idioma junto (o quadro usa o mesmo ajuste)
  await p.bringToFront();
  await p.goto('https://www.crunchyroll.com/pt-br/watch/EP2/episodio'); await p.waitForSelector('video'); // episódio novo: nada pulado ainda
  await seek(0);
  const es = await until(async () => (await ui()).toast, 8000);
  check('aviso no idioma escolhido (ES)', es === 'Resumen saltado', es);
  await wait(300); await p.screenshot({ path: path.join(SHOT, 'aviso-es.png') });
}

fs.writeFileSync(path.join(DIR, `resultado-${MODE}.json`), JSON.stringify(res, null, 2));
console.log(ok ? `\nTUDO PASSOU (${MODE})` : `\nFALHOU (${MODE})`);
await ctx.close();
process.exit(ok ? 0 : 1);
