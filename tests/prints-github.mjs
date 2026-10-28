// Prints da página do GitHub (em inglês), com a extensão de verdade numa Crunchyroll simulada (mock.mjs) e um vídeo
// gerado (sem imagem de anime nem dado pessoal). Uso: MT_VIDEO=pretty.webm node prints-github.mjs [pasta-da-extensao] [saida]
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { routes } from './mock.mjs';
import { DB, handle } from './fila-mock.mjs';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const EXT = path.resolve(process.argv[2] || path.join(DIR, '../extension'));
const OUT = path.resolve(process.argv[3] || path.join(DIR, '../docs'));
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(100); } return null; };

const ctx = await chromium.launchPersistentContext(path.join('/tmp', 'mt-prints-' + Date.now()), {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 1180 }, deviceScaleFactor: 1.5, locale: 'en-US',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--headless=new', '--autoplay-policy=no-user-gesture-required'],
});
await routes(ctx, 'en');
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const id = sw.url().split('/')[2];
await wait(1500);
for (const pg of ctx.pages()) if (pg.url().includes('COMO-INSTALAR')) await pg.close();
await sw.evaluate(() => chrome.storage.sync.set({ lang: 'en' }));

const p = await ctx.newPage();
const card = () => p.evaluate(() => { const h = document.querySelector('maratona-ui'); const c = h && h.shadowRoot.querySelector('.card'); return c && !c.hidden ? c.querySelector('.ttl b').textContent : null; });
const toast = () => p.evaluate(() => { const h = document.querySelector('maratona-ui'); const t = h && h.shadowRoot.querySelector('.toast'); return t && !t.hidden ? t.querySelector('.msg').textContent : null; });
const clip = async () => { const r = await p.evaluate(() => { const b = document.querySelector('video').getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; }); return r; };
const seek = (t) => p.evaluate((t) => { const v = document.querySelector('video'); v.currentTime = t; return v.play().catch(() => {}); }, t);

await p.goto('https://www.crunchyroll.com/en/watch/EP1/episode');
await p.waitForSelector('video');
await until(card); await wait(600);
await p.screenshot({ path: path.join(OUT, 'maratona-tutorial.png'), clip: await clip() });
await p.keyboard.press('Escape'); await wait(400);

await seek(0);
await until(async () => (await toast()) === 'Intro skipped'); await wait(500);
await p.screenshot({ path: path.join(OUT, 'maratona-intro-skipped.png'), clip: await clip() });

await seek(84);
await until(async () => /Next episode in/.test((await toast()) || ''), 15000); await wait(900);
await p.screenshot({ path: path.join(OUT, 'maratona-next-episode.png'), clip: await clip() });
await until(async () => p.url().includes('/EP2/'), 10000);

await sw.evaluate(() => chrome.storage.local.set({ 'mt.update': { disponivel: true, ultima: '1.2.0', urgente: false, notas: '- Skips a little faster\n- Fix for the next-episode countdown' } }));
await until(card); await wait(600);
await p.screenshot({ path: path.join(OUT, 'maratona-update.png'), clip: await clip() });
await sw.evaluate(() => chrome.storage.local.set({ 'mt.update': { disponivel: true, ultima: '1.2.1', urgente: true, notas: '- Fixes a serious problem' } }));
await until(async () => /1\.2\.1/.test((await card()) || '')); await wait(600);
await p.screenshot({ path: path.join(OUT, 'maratona-urgent.png'), clip: await clip() });
await sw.evaluate(() => chrome.storage.local.set({ 'mt.update': { disponivel: false } }));

await sw.evaluate(() => chrome.storage.local.set({ 'mt.stats': { seconds: 3 * 3600 + 27 * 60, skips: 84, eps: 41 } }));
// menu pelo botão da barra do player (dentro do vídeo, como o menu Configurações)
await p.goto('https://www.crunchyroll.com/en/watch/EP1/episode'); await p.waitForSelector('video'); await wait(1500);
await seek(40); await wait(600);
await p.mouse.move(500, 300); await p.mouse.move(520, 310); await wait(250);
await p.locator('#maratona-bar-btn').click(); await wait(700);
await p.screenshot({ path: path.join(OUT, 'maratona-menu-player.png'), clip: await clip() });
await p.keyboard.press('Escape'); await wait(400);
// menu pelo botão laranja preso abaixo do vídeo (abre para baixo, sem cobrir o vídeo)
await p.locator('maratona-ui .fab').click(); await wait(700);
const vb = await clip();
await p.screenshot({ path: path.join(OUT, 'maratona-menu-below.png'), clip: { x: vb.x, y: vb.y + vb.height - 220, width: vb.width, height: 1180 - (vb.y + vb.height - 220) } });
// Fila com progresso (v1.3.0): títulos inventados e capas geradas (sem arte de anime)
Object.assign(DB.series.S1, { title: 'Starfall Academy' }); Object.assign(DB.series.S2, { title: 'Iron Tide' }); Object.assign(DB.series.S3, { title: 'The Quiet Lantern' });
DB.series.S1.seasons[0].title = 'Starfall Academy'; DB.series.S1.seasons[1].title = 'Starfall Academy Season 2'; DB.series.S2.seasons[0].title = 'Iron Tide'; DB.series.S3.seasons[0].title = 'The Quiet Lantern';
await ctx.route('https://www.crunchyroll.com/en/watchlist', (r) => { const q = r.request(); const o = handle({ method: q.method(), url: q.url().replace('/en/', '/pt-br/'), headers: q.headers(), body: q.postData() }); return r.fulfill({ status: o.status, contentType: o.type, body: o.body.replace('Minhas Listas · Fila', 'My Lists · Queue').replace(/Continuar/g, 'Continue') }); });
for (const ap of ['/auth/v1/token', '/content/v2/**']) await ctx.route('https://www.crunchyroll.com' + ap, (r) => { const q = r.request(); const o = handle({ method: q.method(), url: q.url(), headers: q.headers(), body: q.postData() }); return r.fulfill({ status: o.status, contentType: o.type, body: o.body }); });
await p.goto('https://www.crunchyroll.com/en/watchlist');
await until(() => p.evaluate(() => { const r = [...document.querySelectorAll('maratona-ring')]; return r.length === 3 && r.every((h) => !h.shadowRoot.querySelector('.rg').classList.contains('ld')); }), 15000);
// episódio novo na Iron Tide: a rodelinha cai de 100% e brilha
DB.series.S2.seasons[0].eps.push(Object.assign({}, DB.series.S2.seasons[0].eps[9], { id: 'S2AE11', episode: '11', episode_number: 11, sequence_number: 11, versions: [{ guid: 'S2AE11', audio_locale: 'pt-BR' }] }));
await p.locator('maratona-ring[data-sid="S2"] .rg').click(); await wait(300);
await p.locator('maratona-fila .pop [data-a="refresh"]').click(); await wait(1500);
await p.keyboard.press('Escape'); await wait(400);
await p.evaluate(() => { document.getElementById('wl').style.paddingLeft = '260px'; }); await wait(300);
await p.locator('maratona-ring[data-sid="S1"] .rg').click(); await wait(700);
await p.screenshot({ path: path.join(OUT, 'maratona-queue.png'), clip: { x: 160, y: 110, width: 1100, height: 410 } });
await p.locator('maratona-fila .pop [data-a="mark"]').click(); await wait(700);
const pb = await p.locator('maratona-fila .pick').boundingBox();
await p.screenshot({ path: path.join(OUT, 'maratona-queue-mark.png'), clip: { x: pb.x - 20, y: pb.y - 20, width: pb.width + 40, height: pb.height + 40 } });
console.log('prints ok →', OUT, fs.readdirSync(OUT));
await ctx.close();
