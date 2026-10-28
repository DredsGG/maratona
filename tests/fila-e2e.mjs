// E2E da Fila com progresso (v1.3.0) num Chromium com a extensão de verdade.
// A Fila e a API da Crunchyroll são simuladas com o mesmo formato medido ao vivo em 2026-10-28
// (card [data-t="watch-list-card"], link /series/<id>/, imagem watchlist-card-image--*, link que cobre o card;
//  /auth/v1/token com etp_rt_cookie, /content/v2/cms/series/<id>/seasons, /cms/seasons/<id>/episodes, /content/v2/<conta>/playheads).
// Uso: node fila-e2e.mjs <pasta-da-extensao>
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

const EXT = path.resolve(process.argv[2] || '../maratona');
const DIR = path.dirname(new URL(import.meta.url).pathname);
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
    if (out) return r.fulfill({ status: out.status, contentType: out.type, body: out.body });
    return r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>outra página</h1>' });
  });
}

const ctx = await chromium.launchPersistentContext(path.join('/tmp', 'mt-fila-' + Date.now()), {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, locale: 'pt-BR',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--headless=new'],
});
await routes(ctx);
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
await wait(1200);
for (const pg of ctx.pages()) if (pg.url().includes('COMO-INSTALAR')) await pg.close();
await sw.evaluate(() => chrome.storage.local.set({ 'mt.onboard': { tutorial: 'visto', visto: chrome.runtime.getManifest().version, novidades: chrome.runtime.getManifest().version }, 'mt.fila.bg': Date.now() }));

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
await p.evaluate(() => { const wl = document.getElementById('wl'); const c = wl.firstElementChild; wl.removeChild(c); setTimeout(() => wl.appendChild(c.cloneNode(true)), 300); });
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

// novidades da versão: aparecem mesmo se uma versão de teste (X.Y.Z.n) já tinha marcado esta como vista
await sw.evaluate(() => chrome.storage.local.set({ 'mt.onboard': { tutorial: 'visto', visto: chrome.runtime.getManifest().version } }));
await p.reload();
const nv = await until(() => p.evaluate(() => { const c = document.querySelector('maratona-ui') && document.querySelector('maratona-ui').shadowRoot.querySelector('.card'); return c && !c.hidden ? c.innerText : null; }), 8000);
check('quadro "Novidades" da versão aparece na Fila, com a rodelinha e o "Já vi todos"', nv && /Novidades da v\d/.test(nv) && nv.includes('Progresso na Fila') && nv.includes('Já vi todos'), nv && nv.slice(0, 200));
await p.screenshot({ path: path.join(SHOT, 'fila-novidades.png') });
await p.keyboard.press('Escape'); await wait(300);
await p.reload(); await wait(2500);
check('e só uma vez', await p.evaluate(() => { const c = document.querySelector('maratona-ui').shadowRoot.querySelector('.card'); return c.hidden; }));

// a escolha de episódios fica salva depois de fechar e abrir o navegador (storage)
const saved = await sw.evaluate(() => chrome.storage.sync.get(null));
check('decisões salvas no storage.sync por série', !!saved['mtf.S1'] && Array.isArray(saved['mtf.S1'].m), Object.keys(saved).filter((k) => k.startsWith('mtf.')));

await ctx.close();
console.log(ok ? '\nTUDO PASSOU' : '\nFALHOU ALGO');
process.exit(ok ? 0 : 1);
