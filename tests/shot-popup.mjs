// Prints do popup (PT) e do guia, para conferir o visual. Uso: node shot-popup.mjs [pasta-da-extensao]
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
const DIR = path.dirname(new URL(import.meta.url).pathname);
const EXT = path.resolve(process.argv[2] || path.join(DIR, '../extension'));
const SHOT = path.join(DIR, 'shots'); fs.mkdirSync(SHOT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ctx = await chromium.launchPersistentContext(path.join('/tmp', 'mt-shot-' + Date.now()), { channel: 'chromium', headless: true, viewport: { width: 340, height: 820 }, deviceScaleFactor: 2, locale: 'pt-BR',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--headless=new'] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const id = sw.url().split('/')[2]; await wait(1200);
for (const pg of ctx.pages()) if (pg.url().includes('COMO-INSTALAR')) { await pg.setViewportSize({ width: 1100, height: 900 }); await wait(800); await pg.screenshot({ path: path.join(SHOT, 'guia.png') }); await pg.close(); }
await sw.evaluate(() => chrome.storage.local.set({ 'mt.stats': { seconds: 3 * 3600 + 27 * 60, skips: 84, eps: 41 } }));
const pp = await ctx.newPage(); await pp.goto(`chrome-extension://${id}/popup/popup.html`); await wait(800);
const h = await pp.evaluate(() => document.querySelector('.app').offsetHeight);
await pp.screenshot({ path: path.join(SHOT, 'popup-final.png'), clip: { x: 0, y: 0, width: 340, height: h } });
await pp.locator('.it[data-k="recap"]').click(); await pp.locator('.it[data-k="toast"]').click(); await wait(400);
await pp.screenshot({ path: path.join(SHOT, 'popup-chaves.png'), clip: { x: 0, y: 0, width: 340, height: h } });
await sw.evaluate(() => chrome.storage.local.set({ 'mt.update': { disponivel: true, ultima: '9.9.9', urgente: false } })); await wait(400);
const h2 = await pp.evaluate(() => document.querySelector('.app').offsetHeight);
await pp.screenshot({ path: path.join(SHOT, 'popup-banner.png'), clip: { x: 0, y: 0, width: 340, height: h2 } });
console.log('ok', SHOT); await ctx.close();
