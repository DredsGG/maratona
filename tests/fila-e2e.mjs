// E2E da Fila com progresso (v1.3.0) num Chromium com a extensão de verdade.
// A Fila e a API da Crunchyroll são simuladas com o mesmo formato medido ao vivo em 2026-10-28
// (card [data-t="watch-list-card"], link /series/<id>/, imagem watchlist-card-image--*, link que cobre o card;
//  /auth/v1/token com etp_rt_cookie, /content/v2/cms/series/<id>/seasons, /cms/seasons/<id>/episodes, /content/v2/<conta>/playheads).
// Uso: node fila-e2e.mjs <pasta-da-extensao>
import { chromium } from 'playwright';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import fs from 'fs';

const EXT = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '../extension'));
const DIR = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(DIR, 'shots'); fs.mkdirSync(SHOT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (name, cond, info) => { if (!cond) ok = false; console.log((cond ? '✔' : '✘') + ' ' + name + (info !== undefined ? '  ' + JSON.stringify(info) : '')); };
const until = async (fn, ms = 15000, step = 100) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(step); } return null; };

import { DB, mkEps, past, handle } from './fila-mock.mjs';

async function routes(ctx) {
  await ctx.route('https://www.crunchyroll.com/**', async (r) => {
    const req = r.request();
    const out = handle({ method: req.method(), url: req.url(), headers: req.headers(), body: req.postData() });
    if (DB.delay && /\/content\/v2\/cms\//.test(req.url())) await wait(DB.delay);
    if (out) return r.fulfill({ status: out.status, contentType: out.type, body: out.body });
    return r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>outra página</h1>' });
  });
}

const ctx = await chromium.launchPersistentContext(path.join(os.tmpdir(), 'mt-fila-' + Date.now()), {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, locale: 'pt-BR',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--headless=new'],
});
await routes(ctx);
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
await wait(1200);
// a instalação termina ao abrir o guia (o fundo grava o tutorial "pendente" antes): só então o teste marca o tutorial como visto
for (let i = 0; i < 100 && !ctx.pages().some((pg) => pg.url().includes('COMO-INSTALAR')); i++) await new Promise((r) => setTimeout(r, 100));
for (const pg of ctx.pages()) if (pg.url().includes('COMO-INSTALAR')) await pg.close();
await sw.evaluate(() => chrome.storage.local.set({ 'mt.onboard': { tutorial: 'visto', visto: chrome.runtime.getManifest().version, novLidas: chrome.runtime.getManifest().version }, 'mt.fila.bg': Date.now(), 'mt.fila.recolhido': false }));
// v1.4.0: as checagens antigas rodam com a Fila dividida e os Completos abertos (os cards ficam clicáveis, em outra posição)
// tudo o que a extensão pede para fora: só a Crunchyroll e o GitHub; e nada que escreva na conta (só GET, mais o POST do token)
const pedidos = [];
ctx.on('request', (r) => pedidos.push({ m: r.method(), u: r.url() }));

const p = await ctx.newPage();
const rings = () => p.evaluate(() => [...document.querySelectorAll('maratona-ring')].map((h) => {
  const b = h.shadowRoot.querySelector('.rg'); return { sid: h.dataset.sid, txt: b.querySelector('.nm').textContent, title: b.title, nv: b.classList.contains('nv'), ld: b.classList.contains('ld'), bdg: (b.querySelector('.bdg') || {}).textContent || null, inImg: !!h.closest('[class*="watchlist-card-image--"]') };
}));
const ring = async (sid) => (await rings()).find((r) => r.sid === sid);
const popTxt = () => p.evaluate(() => { const h = document.querySelector('maratona-fila'); const el = h && h.shadowRoot.querySelector('.pop'); return el && !el.hidden ? el.innerText : null; });
const pickEl = (sel) => p.locator(`maratona-fila .pick ${sel}`);
const clickRing = (sid) => p.locator(`maratona-ring[data-sid="${sid}"] .rg`).click();

await p.goto('https://www.crunchyroll.com/pt-br/watchlist');
const r1 = await until(async () => { const r = await rings(); return r.length === 3 && r.every((x) => !x.ld) ? r : null; });
check('rodelinha em cada card da Fila, dentro da imagem', r1 && r1.every((x) => x.inImg), r1 && r1.map((x) => x.sid));
check('% certa (legendado e dublado contam; clip e episódio futuro não entram)', r1 && (await ring('S1')).txt === '75%' && (await ring('S2')).txt === '100%' && (await ring('S3')).txt === '0%', r1 && r1.map((x) => x.sid + '=' + x.txt));
check('token como o site (client id do script, device_id do cookie)', DB.calls.token >= 1 && DB.calls.badAuth === 0, DB.calls);
check('playheads em lotes de até 50 ids', DB.calls.playheads >= 2, DB.calls.playheads);
await wait(800);
await p.screenshot({ path: path.join(SHOT, 'fila-rodelinhas.png') });

// clique na rodelinha não abre o anime (o card inteiro é um link)
await clickRing('S1'); await wait(400);
check('clicar na rodelinha não navega', p.url().endsWith('/pt-br/watchlist'), p.url());
const t1 = await popTxt();
check('janela da rodelinha: "18 de 24 episódios"', t1 && t1.includes('18 de 24 episódios') && t1.includes('Marcar episódios vistos') && t1.includes('Recomeçar do zero'), t1);
await p.screenshot({ path: path.join(SHOT, 'fila-janela.png') });

// marcar vistos: temporada 2, arrastando do 7 ao 12
await p.locator('maratona-fila .pop [data-a="mark"]').click(); await wait(400);
await pickEl('.tab[data-i="1"]').click(); await wait(150);
const eps = pickEl('.ep');
check('escolha abre com os vistos marcados (6 da T2)', (await p.locator('maratona-fila .pick .ep.on').count()) === 6);
const b7 = await eps.nth(6).boundingBox();
await p.mouse.move(b7.x + b7.width / 2, b7.y + b7.height / 2); await p.mouse.down();
for (let i = 7; i <= 11; i++) { const bb = await eps.nth(i).boundingBox(); await p.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 4 }); }
await p.mouse.up();
await wait(200);
check('arrastar marca vários', (await p.locator('maratona-fila .pick .ep.on').count()) === 12, await p.locator('maratona-fila .pick .ep.on').count());
await p.screenshot({ path: path.join(SHOT, 'fila-marcar.png') });
await pickEl('[data-p="save"]').click(); await wait(500);
check('salvar → 100%', (await ring('S1')).txt === '100%');
// v1.4.1: o que foi marcado agora vai também para a Crunchyroll (o id do episódio, pedido do botão "Marcar como assistido")
const mk1 = await until(() => DB.calls.mark.length ? DB.calls.mark : null, 5000);
check('marcar vistos → marca também na Crunchyroll só os 6 novos (E7–E12 da T2)', mk1 && mk1.length === 1 && mk1[0].join() === 'S1BE7,S1BE8,S1BE9,S1BE10,S1BE11,S1BE12', mk1);
const nMk = DB.calls.mark.length;

// desmarcar um que a Crunchyroll dá como visto, e Shift+clique num intervalo
await clickRing('S1'); await wait(300);
await p.locator('maratona-fila .pop [data-a="mark"]').click(); await wait(300);
await pickEl('.tab[data-i="0"]').click(); await wait(100);
await pickEl('.ep').nth(0).click(); // desmarca E1
await pickEl('.ep').nth(2).click(); // desmarca E3
await pickEl('.ep').nth(5).click({ modifiers: ['Shift'] }); // Shift: desmarca de E3 a E6
await wait(150);
const onT1 = await p.locator('maratona-fila .pick .ep.on').count();
check('Shift+clique desmarca o intervalo (E1, E3–E6 → 7 marcados na T1)', onT1 === 7, onT1);
await pickEl('[data-p="save"]').click(); await wait(400);
check('desmarcar o que a Crunchyroll deu como visto conta: 19/24 = 79%', (await ring('S1')).txt === '79%', (await ring('S1')).txt);
await wait(600);
check('desmarcar não escreve nada na Crunchyroll', DB.calls.mark.length === nMk, DB.calls.mark.length - nMk);

// recomeçar do zero e voltar a contar tudo
await clickRing('S2'); await wait(300);
await p.locator('maratona-fila .pop [data-a="reset"]').click(); await wait(200);
check('recomeçar pede confirmação', ((await popTxt()) || '').includes('Zerar o progresso'));
await p.screenshot({ path: path.join(SHOT, 'fila-recomecar.png') });
await p.locator('maratona-fila .pop [data-a="doreset"]').click(); await wait(500);
check('recomeçar → 0%', (await ring('S2')).txt === '0%');
check('aparece "Voltar a contar tudo"', ((await popTxt()) || '').includes('Voltar a contar tudo'));
// depois do recomeço, assistir de novo conta
DB.watched.set('S2AE1', new Date(Date.now() + 1000).toISOString());
await p.locator('maratona-fila .pop [data-a="refresh"]').click();
await until(async () => (await ring('S2')).txt === '10%', 8000);
check('depois de recomeçar, o que você reassiste volta a contar (1/10)', (await ring('S2')).txt === '10%', (await ring('S2')).txt);
await p.locator('maratona-fila .pop [data-a="unreset"]').click(); await wait(400);
check('voltar a contar tudo → 100%', (await ring('S2')).txt === '100%');
await p.keyboard.press('Escape'); await wait(300);
check('Esc fecha a janela', (await popTxt()) === null);

// episódio novo: S2 ganha o episódio 11
DB.series.S2.seasons[0].eps.push(mkEps('S2A', 11)[10]);
await clickRing('S2'); await wait(200);
await p.locator('maratona-fila .pop [data-a="refresh"]').click();
await until(async () => (await ring('S2')).txt === '90%', 8000);
const rn = await ring('S2');
check('episódio novo: a % cai (10/11 = 90%) e a rodelinha brilha com +1', rn.txt === '90%' && rn.nv && rn.bdg === '+1', rn);
check('janela avisa "1 episódio novo"', ((await popTxt()) || '').includes('1 episódio novo'));
await p.keyboard.press('Escape'); await wait(300);
await p.mouse.move(10, 10);
await wait(900);
await p.screenshot({ path: path.join(SHOT, 'fila-novo.png') });
// pop-up de episódio novo na aba que está na frente, e o botão da Maratona com "+1"
const popN = await until(() => p.evaluate(() => { const el = document.querySelector('maratona-ui').shadowRoot.querySelector('.pop'); return el && !el.hidden ? el.innerText : null; }), 5000);
check('pop-up "Episódio novo na sua Fila · Série Beta"', popN && popN.includes('Série Beta') && popN.includes('1 episódio novo'), popN);
await p.screenshot({ path: path.join(SHOT, 'fila-popup.png') });
const fc = await p.evaluate(() => { const f = document.querySelector('maratona-ui').shadowRoot.querySelector('.fab .fc'); return f && !f.hidden ? f.textContent : null; });
check('botão da Maratona mostra +1', fc === '+1', fc);
await p.locator('maratona-ui .pop [data-pa="x"]').click(); await wait(300);
await p.reload(); await until(async () => (await rings()).length === 3); await wait(3500);
check('o pop-up não repete para o mesmo episódio', await p.evaluate(() => document.querySelector('maratona-ui').shadowRoot.querySelector('.pop').hidden));
// sininho no menu
await p.keyboard.press('Alt+m'); await wait(400);
const bc = await p.evaluate(() => { const b = document.querySelector('maratona-ui').shadowRoot.querySelector('.menu .bell .bc'); return b && b.textContent; });
check('sininho no menu com +1', bc === '+1', bc);
await p.locator('maratona-ui .menu .bell').click(); await wait(300);
const nlist = await p.evaluate(() => document.querySelector('maratona-ui').shadowRoot.querySelector('.menu .nl').innerText);
check('lista do sininho: Série Beta · 1 episódio novo · Ver · Já vi', nlist.includes('Série Beta') && nlist.includes('1 episódio novo') && /VER/i.test(nlist) && /JÁ VI/i.test(nlist), nlist);
await p.screenshot({ path: path.join(SHOT, 'fila-sininho.png') });
await p.keyboard.press('Escape'); await wait(300);
const badge = await sw.evaluate(() => chrome.action.getBadgeText({}));
check('ícone da extensão mostra +1', badge === '+1', badge);
// menu da Maratona lista a novidade
await p.keyboard.press('Alt+m'); await wait(500);
const menuTxt = await p.evaluate(() => { const m = document.querySelector('maratona-ui').shadowRoot.querySelector('.menu'); return m.hidden ? null : m.innerText; });
check('menu da Maratona: "Episódios novos na Fila" e a chave da Fila', menuTxt && menuTxt.includes('Episódios novos na Fila') && menuTxt.includes('Série Beta') && menuTxt.includes('Progresso na Fila'), menuTxt && menuTxt.slice(0, 400));
await p.keyboard.press('Escape'); await wait(300);

// assistir um episódio da série tira o brilho
await p.goto('https://www.crunchyroll.com/pt-br/watch/S2/ep'); await wait(2000);
await p.goto('https://www.crunchyroll.com/pt-br/watchlist');
await until(async () => (await rings()).length === 3);
await wait(400);
const ra = await ring('S2');
check('depois de abrir um episódio da série, o brilho some (a % continua 90%)', !ra.nv && ra.txt === '90%', ra);
check('ícone sem selo', (await sw.evaluate(() => chrome.action.getBadgeText({}))) === '');

// recarregar a página: a rodelinha vem do que já foi calculado, na hora
const before = DB.calls.playheads;
await p.reload(); await until(async () => (await rings()).length === 3, 5000);
const rr = await rings();
check('depois de recarregar, já aparece a % sem esperar a API', rr.every((x) => !x.ld) && (await ring('S1')).txt === '79%', rr.map((x) => x.txt));
check('e não refaz tudo se tem menos de 10 min', DB.calls.playheads === before, DB.calls.playheads - before);

// lista virtual: o card sai e volta → a rodelinha volta
await p.evaluate(() => { window.__vl.setOrder([]); setTimeout(() => window.__vl.setOrder(['S1', 'S2', 'S3']), 300); });
await wait(1200);
check('card redesenhado pela lista virtual ganha a rodelinha de novo', (await rings()).length === 3);

// chave "Progresso na Fila" no menu
await p.keyboard.press('Alt+m'); await wait(400);
await p.locator('maratona-ui .menu [data-k="fila"]').click(); await wait(800);
check('desligar "Progresso na Fila" tira as rodelinhas', (await rings()).length === 0);
await p.locator('maratona-ui .menu [data-k="fila"]').click(); await wait(1200);
check('religar traz de volta', (await rings()).length === 3);
await p.keyboard.press('Escape');

// idioma
await sw.evaluate(() => chrome.storage.sync.set({ lang: 'en' })); await wait(500);
check('EN: "79% watched"', ((await ring('S1')).title || '').startsWith('79% watched'), (await ring('S1')).title);
await sw.evaluate(() => chrome.storage.sync.set({ lang: 'es' })); await wait(500);
check('ES: "79% visto"', ((await ring('S1')).title || '').startsWith('79% visto'), (await ring('S1')).title);
await sw.evaluate(() => chrome.storage.sync.set({ lang: 'pt' }));

// procura sozinha de episódio novo a partir de outra página (a cada 2 h)
Object.assign(DB.series.S3.seasons[0].eps[5], { availability_starts: past, premium_available_date: past }); // o 6º agora saiu
await sw.evaluate(() => chrome.storage.local.set({ 'mt.fila.bg': 0 }));
const p2 = await ctx.newPage();
await p2.goto('https://www.crunchyroll.com/pt-br/watch/S1/ep');
const nov = await until(async () => { const l = (await sw.evaluate(() => chrome.storage.local.get('mt.fila.novos')))['mt.fila.novos'] || []; return l.find((x) => x.sid === 'S3') ? l : null; }, 20000, 500);
check('de outra página, a Maratona descobre o episódio novo sozinha', !!nov, nov);
await p2.close();
await p.reload(); await until(async () => (await rings()).length === 3);
await wait(500);
const g = await ring('S3');
check('na Fila, a Gama brilha com +1', g.nv && g.bdg === '+1' && g.txt === '0%', g);
// "Já vi" no sininho tira o aviso (rodelinha, botão e ícone)
await p.keyboard.press('Alt+m'); await wait(400);
await p.locator('maratona-ui .menu .bell').click(); await wait(300);
await p.locator('maratona-ui .menu [data-act="ndis"][data-sid="S3"]').click(); await wait(800);
const g2 = await ring('S3');
const nl2 = await p.evaluate(() => document.querySelector('maratona-ui').shadowRoot.querySelector('.menu').innerText);
check('"Já vi" no sininho: some da lista e a rodelinha para de brilhar', !g2.nv && nl2.includes('Nada novo por enquanto'), { g2, nl2: nl2.slice(0, 160) });
check('botão sem contagem e ícone sem selo', (await p.evaluate(() => document.querySelector('maratona-ui').shadowRoot.querySelector('.fab .fc').hidden)) && (await sw.evaluate(() => chrome.action.getBadgeText({}))) === '');
await p.keyboard.press('Escape'); await wait(300);

// "Já vi todos": deixa em 100% de uma vez, com Desfazer
await clickRing('S3'); await wait(400);
await p.locator('maratona-fila .pop [data-a="allseen"]').click(); await wait(500);
const ga = await ring('S3');
check('"Já vi todos" → 100% na hora e sem brilho', ga.txt === '100%' && !ga.nv, ga);
const ta = (await popTxt()) || '';
check('mostra "Marcado como 100%" com Desfazer e some o "Já vi todos"', ta.includes('Marcado como 100%') && !ta.includes('Já vi todos'), ta.slice(0, 160));
await p.screenshot({ path: path.join(SHOT, 'fila-vi-todos.png') });
await p.locator('maratona-fila .pop [data-a="undoall"]').click(); await wait(500);
check('Desfazer volta para 0%', (await ring('S3')).txt === '0%', (await ring('S3')).txt);
await p.locator('maratona-fila .pop [data-a="allseen"]').click(); await wait(400);
await p.keyboard.press('Escape'); await wait(200);
await p.reload(); await until(async () => (await rings()).length === 3); await wait(300);
check('"Já vi todos" fica salvo depois de recarregar', (await ring('S3')).txt === '100%', (await ring('S3')).txt);

// novidades: quem estava na 1.3.0 (o quadro foi "gasto" numa aba sem ninguém ver) vê de novo o que mudou desde a 1.2.0
const cardTxt = () => p.evaluate(() => { const c = document.querySelector('maratona-ui') && document.querySelector('maratona-ui').shadowRoot.querySelector('.card'); return c && !c.hidden ? c.innerText : null; });
await sw.evaluate(() => chrome.storage.local.set({ 'mt.onboard': { tutorial: 'visto', visto: '1.3.0', novidades: '1.3.0' } }));
await p.reload();
const nv = await until(cardTxt, 8000);
// (até 8 frases, as mais novas primeiro: na 1.4.0 entram as da 1.4.0, 1.3.2 e 1.3.1; antes da 1.4.0 eram as da 1.3.x com "Já vi todos")
check('quadro "Novidades" aparece na Fila com o que mudou desde a 1.3.0, a versão nova primeiro', nv && /Novidades da v\d/.test(nv) && nv.indexOf('Fila agora vem dividida') >= 0 && nv.indexOf('Fila agora vem dividida') < nv.indexOf('Sininho no menu'), nv && nv.slice(0, 220));
await p.screenshot({ path: path.join(SHOT, 'fila-novidades.png') });
await p.reload();
check('se a pessoa não fechou, o quadro volta na próxima abertura', !!(await until(cardTxt, 8000)));
await p.keyboard.press('Escape'); await wait(400);
await p.reload(); await wait(2500);
check('fechou (Esc) → não volta mais', (await cardTxt()) === null);
// rever pelo menu: "Novidades" no rodapé
await p.keyboard.press('Alt+m'); await wait(400);
await p.locator('maratona-ui .menu [data-act="news"]').click();
const nm = await until(cardTxt, 4000);
check('"Novidades" no rodapé do menu reabre o quadro', nm && nm.includes('Novidades da v'), nm && nm.slice(0, 80));
await p.keyboard.press('Escape'); await wait(300);

// a escolha de episódios fica salva depois de fechar e abrir o navegador (storage)
const saved = await sw.evaluate(() => chrome.storage.sync.get(null));
check('decisões salvas no storage.sync por série', !!saved['mtf.S1'] && Array.isArray(saved['mtf.S1'].m), Object.keys(saved).filter((k) => k.startsWith('mtf.')));

// ───────────── v1.4.0: Fila dividida em faixas (EPISÓDIO NOVO · EM ANDAMENTO · COMPLETOS) ─────────────
// Aqui: S1 79% e S2 90% (em andamento), S3 100% ("Já vi todos").
const fx = () => p.evaluate(() => {
  const h = document.querySelector('maratona-faixas');
  const heads = h ? [...h.shadowRoot.querySelectorAll('.fx')].map((e) => ({ t: e.textContent.replace(/\s+/g, ' ').trim(), up: getComputedStyle(e.querySelector('.tt')).textTransform, top: Math.round(e.getBoundingClientRect().top), exp: e.getAttribute('aria-expanded') })) : [];
  const cards = [...document.querySelectorAll('.erc-my-lists-item')].map((it) => {
    const r = it.getBoundingClientRect(), a = it.querySelector('a[href*="/series/"]'), ring = it.querySelector('maratona-ring');
    return { sid: a && a.getAttribute('href').match(/series\/(\w+)/)[1], x: Math.round(r.left), y: Math.round(r.top), vis: getComputedStyle(it).visibility, ringVis: ring ? getComputedStyle(ring).visibility : null, tr: it.style.transform };
  });
  const note = document.querySelector('maratona-faixas-nota'), wl = document.getElementById('wl');
  return { heads, cards, note: note ? note.shadowRoot.querySelector('.nota').textContent.trim() : null, mb: wl.style.marginBottom, rows: window.__vl.rows(), total: window.__vl.total() };
});
const cd = (f, sid) => f.cards.find((c) => c.sid === sid);
const nomes = (f) => f.heads.map((h) => h.t);
const settle = async () => { await wait(700); };
// "sem buraco": em cada faixa aberta, o k-ésimo card fica na k-ésima vaga (4 colunas de 270 px, linhas de 279 px, logo abaixo do cabeçalho)
function semBuraco(f) {
  const x0 = Math.min(...f.cards.filter((c) => c.vis === 'visible').map((c) => c.x)), erros = [];
  const vis = f.cards.filter((c) => c.vis === 'visible').sort((a, b) => a.y - b.y || a.x - b.x);
  for (let i = 0; i < f.heads.length; i++) {
    const h = f.heads[i], fim = i + 1 < f.heads.length ? f.heads[i + 1].top : Infinity;
    const l = vis.filter((c) => c.y > h.top && c.y < fim);
    l.forEach((c, k) => { if (c.x - x0 !== (k % 4) * 270 || c.y - h.top !== 48 + 8 + Math.floor(k / 4) * 279) erros.push({ h: h.t, k, sid: c.sid, dx: c.x - x0, dy: c.y - h.top }); });
  }
  return erros;
}
await sw.evaluate(() => chrome.storage.local.remove('mt.fila.recolhido')); // de fábrica
await p.reload(); await until(async () => (await fx()).heads.length >= 2, 8000); await settle();
let f = await fx();
check('faixas: EM ANDAMENTO · 2 em cima, COMPLETOS · 1 embaixo; faixa vazia (Episódio novo) não aparece', f.heads.length === 2 && /^Em andamento\s*· 2$/.test(f.heads[0].t) && /^Completos\s*· 1$/.test(f.heads[1].t) && f.heads[0].top < f.heads[1].top && f.heads[0].up === 'uppercase', nomes(f));
check('Completos recolhida de fábrica: card e rodelinha escondidos', cd(f, 'S3').vis === 'hidden' && cd(f, 'S3').ringVis === 'hidden' && f.heads[1].exp === 'false', cd(f, 'S3'));
check('dentro da faixa, a ordem do site (Alfa e depois Beta, lado a lado, abaixo do título)', cd(f, 'S1').x < cd(f, 'S2').x && cd(f, 'S1').y === cd(f, 'S2').y && cd(f, 'S1').y > f.heads[0].top && cd(f, 'S1').y < f.heads[1].top, [cd(f, 'S1'), cd(f, 'S2')]);
check('a ordem dos nós do site não mudou (só transform)', await p.evaluate(() => [...document.querySelectorAll('.erc-my-lists-item a[href*="/series/"]')].map((a) => a.getAttribute('href').match(/series\/(\w+)/)[1]).join() === 'S1,S2,S3'));
await p.screenshot({ path: path.join(SHOT, 'fila-faixas.png') });
await p.locator('maratona-faixas .fx.b2').click(); await settle();
f = await fx();
check('clique no título abre COMPLETOS: o card aparece embaixo, com a rodelinha', cd(f, 'S3').vis === 'visible' && cd(f, 'S3').ringVis === 'visible' && cd(f, 'S3').y > f.heads[1].top && f.heads[1].exp === 'true' && p.url().endsWith('/watchlist'), cd(f, 'S3'));
check('estado salvo no storage.local (aberta)', (await sw.evaluate(() => chrome.storage.local.get('mt.fila.recolhido')))['mt.fila.recolhido'] === false);
await p.screenshot({ path: path.join(SHOT, 'fila-faixas-aberta.png') });
await p.reload(); await until(async () => (await fx()).heads.length >= 2, 8000); await settle();
check('depois de recarregar, COMPLETOS continua aberta', cd(await fx(), 'S3').vis === 'visible');
await p.locator('maratona-faixas .fx.b2').click(); await settle();
check('clique de novo recolhe e salva', cd(await fx(), 'S3').vis === 'hidden' && (await sw.evaluate(() => chrome.storage.local.get('mt.fila.recolhido')))['mt.fila.recolhido'] === true);
// clique no card que mudou de lugar abre o anime certo (a linha de baixo não rouba o clique)
await p.locator('maratona-faixas .fx.b2').click(); await settle();
{ const bb = await p.locator('.erc-my-lists-item:has(a[href*="/series/S3/"]) h4').boundingBox(); await p.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); } await wait(600);
check('clique no card movido abre o anime certo', p.url().includes('/series/S3/'), p.url());
await p.goto('https://www.crunchyroll.com/pt-br/watchlist'); await until(async () => (await fx()).heads.length >= 2, 8000); await settle();
// episódio novo num anime em 100%: sobe sozinho para EPISÓDIO NOVO
DB.series.S3.seasons[0].eps.push(Object.assign(mkEps('S3A', 7)[6], { sequence_number: 7 }));
await clickRing('S3'); await wait(300);
await p.locator('maratona-fila .pop [data-a="refresh"]').click();
await until(async () => (await ring('S3')).nv, 8000);
await p.keyboard.press('Escape'); await settle();
f = await fx();
check('episódio novo em série 100% → EPISÓDIO NOVO no topo (e COMPLETOS some, vazia)', f.heads.length === 2 && /^Episódio novo\s*· 1$/.test(f.heads[0].t) && /^Em andamento\s*· 2$/.test(f.heads[1].t) && cd(f, 'S3').y < cd(f, 'S1').y && cd(f, 'S3').vis === 'visible', { h: nomes(f), s3: cd(f, 'S3') });
await p.screenshot({ path: path.join(SHOT, 'fila-faixas-novo.png') });
// "Já vi todos" leva para COMPLETOS
await clickRing('S1'); await wait(300);
await p.locator('maratona-fila .pop [data-a="allseen"]').click(); await wait(300);
await p.keyboard.press('Escape'); await settle();
f = await fx();
check('"Já vi todos" → o anime vai para COMPLETOS', f.heads.length === 3 && /^Completos\s*· 1$/.test(f.heads[2].t) && cd(f, 'S1').y > f.heads[2].top && /^Em andamento\s*· 1$/.test(f.heads[1].t), { h: nomes(f), s1: cd(f, 'S1') });
check('as três faixas na ordem certa: EPISÓDIO NOVO, EM ANDAMENTO, COMPLETOS', /^Episódio novo/.test(f.heads[0].t) && /^Em andamento/.test(f.heads[1].t) && /^Completos/.test(f.heads[2].t) && f.heads[0].top < f.heads[1].top && f.heads[1].top < f.heads[2].top, nomes(f));
check('nenhum buraco nas faixas', semBuraco(f).length === 0, semBuraco(f));
await p.screenshot({ path: path.join(SHOT, 'fila-faixas-tres.png') });
// chave "Dividir a Fila" desligada: volta a ordem original inteira
await p.keyboard.press('Alt+m'); await wait(400);
const mtx = await p.evaluate(() => document.querySelector('maratona-ui').shadowRoot.querySelector('.menu').innerText);
check('menu (seção Fila) tem a chave "Dividir a Fila", ligada', mtx.includes('Dividir a Fila') && (await p.locator('maratona-ui .menu [data-k="faixas"] .sw').getAttribute('aria-checked')) === 'true');
await p.locator('maratona-ui .menu [data-k="faixas"]').click(); await settle();
f = await fx();
check('desligada: sem títulos, sem transform, ordem do site (Alfa, Beta, Gama na mesma linha)', f.heads.length === 0 && f.cards.every((c) => !c.tr && c.vis === 'visible') && cd(f, 'S1').x < cd(f, 'S2').x && cd(f, 'S2').x < cd(f, 'S3').x && cd(f, 'S1').y === cd(f, 'S3').y && !f.mb, f.cards);
check('desligada fica salva no storage.sync', (await sw.evaluate(() => chrome.storage.sync.get('faixas'))).faixas === false);
await p.locator('maratona-ui .menu [data-k="faixas"]').click(); await settle();
check('religada: faixas de volta', (await fx()).heads.length === 3);
await p.keyboard.press('Escape'); await wait(300);
// sem a % de todos ainda: não mostra faixa errada
await sw.evaluate(() => chrome.storage.local.remove('mt.fila.cache'));
DB.delay = 1500;
await p.reload(); await wait(1200);
f = await fx();
check('enquanto a % não chegou: nada de faixa, ordem do site', f.heads.length === 0 && f.cards.every((c) => !c.tr), nomes(f));
DB.delay = 0;
await until(async () => (await fx()).heads.length === 3, 20000); await settle();
check('chegou a % de todos: faixas aparecem', (await fx()).heads.length === 3);
// EN e ES
await sw.evaluate(() => chrome.storage.sync.set({ lang: 'en' })); await settle();
f = await fx();
check('EN: New episode · In progress · Completed', /^New episode/.test(f.heads[0].t) && /^In progress/.test(f.heads[1].t) && /^Completed/.test(f.heads[2].t), nomes(f));
await sw.evaluate(() => chrome.storage.sync.set({ lang: 'es' })); await settle();
f = await fx();
check('ES: Episodio nuevo · En curso · Completados', /^Episodio nuevo/.test(f.heads[0].t) && /^En curso/.test(f.heads[1].t) && /^Completados/.test(f.heads[2].t), nomes(f));
await p.screenshot({ path: path.join(SHOT, 'fila-faixas-es.png') });
await sw.evaluate(() => chrome.storage.sync.set({ lang: 'pt' })); await settle();
// lista virtual maior (12 animes, 3 linhas, todas no DOM): rolar não abre buraco
for (let i = 1; i <= 9; i++) { DB.series['G0' + i] = { title: 'Gerada ' + i, seasons: [{ id: 'G0' + i + 'A', title: 'Gerada ' + i, seq: 1, eps: mkEps('G0' + i + 'A', 4) }] }; for (let e = 1; e <= 4; e++) DB.watched.set(`G0${i}AE${e}`, '2026-10-05T00:00:00Z'); } // 9 completos
await p.reload();
await until(async () => { const r = await rings(); return r.length === 12 && r.every((x) => !x.ld); }, 30000); await settle();
await until(async () => (await fx()).heads.length === 3, 8000);
const f0 = await fx();
await p.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await settle();
await p.evaluate(() => scrollTo(0, 0)); await settle();
const f1 = await fx();
check('12 animes: todos no lugar, nenhum buraco, rolar não muda nada', semBuraco(f1).length === 0 && f1.rows === f1.total && JSON.stringify(f0.cards) === JSON.stringify(f1.cards) && /^Em andamento\s*· 1$/.test(f1.heads[1].t) && /^Completos\s*· 10$/.test(f1.heads[2].t), { erros: semBuraco(f1), h: nomes(f1) });
// COMPLETOS (10) recolhida: a lista encolhe, o rodapé sobe para dentro da área antiga da lista e tem de continuar clicável
await p.locator('maratona-faixas .fx.b2').click(); await settle();
const rod = await p.evaluate(() => { const wl = document.getElementById('wl'), r = document.querySelector('footer').getBoundingClientRect(), w = wl.getBoundingClientRect(); const y = r.top + 10; scrollTo(0, Math.max(0, y + scrollY - innerHeight / 2)); const r2 = document.querySelector('footer').getBoundingClientRect(); const el = document.elementFromPoint(r2.left + 40, r2.top + 10); return { sobreposto: r.top < w.bottom, alvo: el && el.tagName }; });
check('COMPLETOS recolhida: o rodapé que sobe por baixo da lista continua clicável', rod.sobreposto && rod.alvo === 'FOOTER', rod);
await p.evaluate(() => scrollTo(0, 0));
await p.locator('maratona-faixas .fx.b2').click(); await settle();
// redesenho do site (como voltar Fila → Histórico → Fila): a divisão volta sozinha
await p.evaluate(() => window.__vl.remount()); await settle();
const f2 = await fx();
check('lista redesenhada pelo site: faixas reaplicadas, iguais', f2.heads.length === 3 && JSON.stringify(f2.cards.map((c) => [c.sid, c.x, c.y])) === JSON.stringify(f1.cards.map((c) => [c.sid, c.x, c.y])));
// 7 linhas (28 animes): no topo o site desenha todas, mas rolando até o fim ele tiraria as primeiras. Ou divide e continua inteira
// até o fim, ou fica na ordem do site; nunca troca no meio da rolagem nem deixa buraco.
for (let i = 10; i <= 25; i++) DB.series['G' + i] = { title: 'Gerada ' + i, seasons: [{ id: 'G' + i + 'A', title: 'Gerada ' + i, seq: 1, eps: mkEps('G' + i + 'A', 2) }] };
await p.reload();
await until(async () => { const r = await rings(); return r.length >= 28 && r.every((x) => !x.ld); }, 40000); await settle();
const l7a = await fx();
await p.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await settle();
const l7b = await fx();
await p.evaluate(() => scrollTo(0, 0)); await settle();
const l7c = await fx();
check('7 linhas: rolar até o fim não tira linha nem abre buraco (dividida ou não, sem trocar no meio)', l7a.total === 7 && l7a.heads.length === l7b.heads.length && l7b.heads.length === l7c.heads.length && (l7b.heads.length === 0 ? l7b.cards.every((c) => !c.tr) && !!l7b.note : l7b.rows === l7b.total && semBuraco(l7b).length === 0), { linhas: [l7a.rows, l7b.rows, l7c.rows], faixas: [l7a.heads.length, l7b.heads.length, l7c.heads.length], nota: !!l7b.note });
for (let i = 10; i <= 25; i++) delete DB.series['G' + i];
// lista longa (63 animes, só parte das linhas no DOM): não divide (ficaria buraco) e avisa; rola sem quebrar
for (let i = 10; i <= 60; i++) DB.series['G' + i] = { title: 'Gerada ' + i, seasons: [{ id: 'G' + i + 'A', title: 'Gerada ' + i, seq: 1, eps: mkEps('G' + i + 'A', 2) }] };
await p.reload(); await wait(2500);
f = await fx();
check('lista longa: não divide e mostra o aviso, na ordem do site', f.rows < f.total && f.heads.length === 0 && f.cards.every((c) => !c.tr) && /Fila longa demais/.test(f.note || ''), { rows: f.rows, total: f.total, note: f.note });
await p.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await settle();
const fl = await fx();
await p.evaluate(() => scrollTo(0, 0)); await settle();
const fl2 = await fx();
check('lista longa rolando: o site troca as linhas, nada dividido, nada escondido, sem piscar de volta', fl.heads.length === 0 && fl2.heads.length === 0 && fl.cards.every((c) => !c.tr && c.vis === 'visible') && fl.cards.some((c) => c.sid === 'G60'), { n: fl.cards.length });
for (let i = 10; i <= 60; i++) delete DB.series['G' + i];
await p.reload(); await until(async () => (await fx()).heads.length === 3, 15000); await settle();
check('a lista voltou a caber: divide de novo', (await fx()).heads.length === 3 && !(await fx()).note);
// ───────────── v1.4.1: marcar também na Crunchyroll ─────────────
// Aqui a Beta está em 10/11 (90%, em andamento) e o E11 nunca foi visto na Crunchyroll.
const popNow = async () => (await popTxt()) || '';
let n0 = DB.calls.mark.length;
await clickRing('S2'); await wait(300);
await p.locator('maratona-fila .pop [data-a="allseen"]').click();
await until(async () => (await popNow()).includes('marcado também na Crunchyroll'), 5000);
check('"Já vi todos" → marca na Crunchyroll só o que faltava (S2AE11) e avisa', DB.calls.mark.length === n0 + 1 && DB.calls.mark[n0].join() === 'S2AE11' && DB.watched.has('S2AE11') && (await popNow()).includes('1 episódio marcado também na Crunchyroll'), { calls: DB.calls.mark.slice(n0), pop: (await popNow()).slice(0, 200) });
await p.locator('maratona-fila .pop [data-a="undoall"]').click(); await wait(500);
check('Desfazer: volta para 90% e avisa que na Crunchyroll continua marcado', (await ring('S2')).txt === '90%' && (await popNow()).includes('continua marcado'), { r: (await ring('S2')).txt, pop: (await popNow()).slice(0, 220) });
// salvar a escolha de episódios antes de a Crunchyroll devolver a marca não pode apagar o "desmarcado"
await p.locator('maratona-fila .pop [data-a="mark"]').click(); await wait(400);
await pickEl('[data-p="save"]').click(); await wait(500);
await clickRing('S2'); await wait(300);
await p.locator('maratona-fila .pop [data-a="refresh"]').click(); await wait(2500);
check('depois de salvar a escolha e reler a Crunchyroll (que agora tem o E11 como visto), o Desfazer continua valendo: 90%', (await ring('S2')).txt === '90%', (await ring('S2')).txt);
check('Desfazer não escreve nada na Crunchyroll', DB.calls.mark.length === n0 + 1);
// duplo clique no "Já vi todos" não estraga o Desfazer (a janela da Beta continua aberta)
await p.evaluate(() => { const b = document.querySelector('maratona-fila').shadowRoot.querySelector('.pop [data-a="allseen"]'); b.click(); b.click(); });
await until(async () => (await popNow()).includes('Marcado como 100%'), 4000); await wait(600);
await p.locator('maratona-fila .pop [data-a="undoall"]').click(); await wait(600);
check('duplo clique em "Já vi todos" e Desfazer: volta para 90% (e nada reenviado: a Crunchyroll já tinha o E11)', (await ring('S2')).txt === '90%' && DB.calls.mark.length === n0 + 1, { r: (await ring('S2')).txt, novos: DB.calls.mark.length - n0 - 1 });
await p.keyboard.press('Escape'); await wait(300);
// chave "Marcar também na Crunchyroll" desligada: só na Maratona
await p.keyboard.press('Alt+m'); await wait(400);
const mtx2 = await p.evaluate(() => document.querySelector('maratona-ui').shadowRoot.querySelector('.menu').innerText);
check('menu (seção Fila): chave "Marcar também na Crunchyroll", ligada de fábrica', mtx2.includes('Marcar também na Crunchyroll') && (await p.locator('maratona-ui .menu [data-k="filaConta"] .sw').getAttribute('aria-checked')) === 'true');
await p.locator('maratona-ui .menu [data-k="filaConta"]').click(); await wait(400);
await p.keyboard.press('Escape'); await wait(300);
n0 = DB.calls.mark.length;
await clickRing('S2'); await wait(300);
await p.locator('maratona-fila .pop [data-a="allseen"]').click(); await wait(1200);
check('chave desligada: "Já vi todos" fica só na Maratona (100%, nenhum pedido)', (await ring('S2')).txt === '100%' && DB.calls.mark.length === n0, DB.calls.mark.length - n0);
await p.locator('maratona-fila .pop [data-a="undoall"]').click(); await wait(400);
await p.keyboard.press('Escape'); await wait(300);
await p.keyboard.press('Alt+m'); await wait(400);
await p.locator('maratona-ui .menu [data-k="filaConta"]').click(); await wait(400);
await p.keyboard.press('Escape'); await wait(300);
// falha (Crunchyroll fora do ar): fica marcado na Maratona, avisa e tenta de novo sozinha depois
const g3 = DB.series.S3.seasons[0].eps.length; // a Gama ganhou o E7, que ninguém viu
DB.markFail = true; n0 = DB.calls.mark.length;
await clickRing('S3'); await wait(300);
await p.locator('maratona-fila .pop [data-a="allseen"]').click();
await until(async () => (await popNow()).includes('tenta de novo'), 10000);
const pend1 = (await sw.evaluate(() => chrome.storage.local.get('mt.fila.pendentes')))['mt.fila.pendentes'] || {};
check('falhou na Crunchyroll: 100% na Maratona, aviso e pendente guardado', (await ring('S3')).txt === '100%' && (await popNow()).includes('tenta de novo') && (pend1.S3 || []).length >= 1 && DB.calls.mark.length > n0, { pend1, tent: DB.calls.mark.length - n0, g3 });
await p.keyboard.press('Escape'); await wait(300);
DB.markFail = false;
await p.reload();
const pend2 = await until(async () => { const v = (await sw.evaluate(() => chrome.storage.local.get('mt.fila.pendentes')))['mt.fila.pendentes'] || {}; return !v.S3 ? v : null; }, 25000, 500);
check('na próxima abertura, tenta de novo sozinha e marca na Crunchyroll', !!pend2 && DB.watched.has('S3AE7'), { pend2, ultimo: DB.calls.mark[DB.calls.mark.length - 1] });
// rede: nada novo e nada que escreva na conta
const http = pedidos.filter((r) => /^https?:/.test(r.u));
const fora = http.filter((r) => !/^https:\/\/(www|static)\.crunchyroll\.com\/|^https:\/\/api\.github\.com\//.test(r.u));
const api = http.filter((r) => /crunchyroll\.com\/(content|auth)\//.test(r.u)).map((r) => r.m + ' ' + new URL(r.u).pathname);
const okApi = /^(POST \/auth\/v1\/token|POST \/content\/v2\/discover\/[\w-]+\/mark_as_watched\/[^/]+|GET \/content\/v2\/cms\/series\/\w+\/seasons|GET \/content\/v2\/cms\/seasons\/\w+\/episodes|GET \/content\/v2\/[\w-]+\/playheads|GET \/content\/v2\/discover\/[\w-]+\/watchlist)$/;
check('nenhuma requisição fora da Crunchyroll e do GitHub', fora.length === 0, fora.slice(0, 5));
const escritas = http.filter((r) => r.m !== 'GET' && !/\/auth\/v1\/token$/.test(r.u));
check('nenhuma chamada de API nova; a única escrita na conta é o "Marcar como assistido", só quando a pessoa marca', api.length > 0 && api.every((x) => okApi.test(x)) && escritas.every((r) => r.m === 'POST' && /\/content\/v2\/discover\/[\w-]+\/mark_as_watched\//.test(r.u)) && escritas.length === DB.calls.mark.length, { fora: [...new Set(api.filter((x) => !okApi.test(x)))].slice(0, 5), escritas: escritas.length, marcas: DB.calls.mark.length });

await ctx.close();
console.log(ok ? '\nTUDO PASSOU' : '\nFALHOU ALGO');
process.exit(ok ? 0 : 1);
