// E2E do "Apoiar ♥" (regra 16, v1.3.2) num Chromium com a extensão de verdade, numa página da Crunchyroll simulada (fila-mock.mjs).
// Confere: o código Pix gerado é IGUAL aos 4 de referência do vault (apoio.md), "Outro valor" (12,50 → 54 05 12.50), o CRC,
// o QR lido de volta da imagem (jsQR) bate com o código, copiar, Outro país → GitHub Sponsors, Voltar, Esc, clique fora,
// foco preso, escolha salva, três idiomas e nenhuma chamada de rede durante o quadro.
// Uso: node apoio-e2e.mjs <pasta-da-extensao>   (precisa de: npm i jsqr pngjs)
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { handle } from './fila-mock.mjs';

const require = createRequire(import.meta.url);
const EXT = path.resolve(process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), '../extension'));
const A = require(path.join(EXT, 'src/apoio.js'));
const DIR = path.dirname(new URL(import.meta.url).pathname);
const SHOT = path.join(DIR, 'shots'); fs.mkdirSync(SHOT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (name, cond, info) => { if (!cond) ok = false; console.log((cond ? '✔' : '✘') + ' ' + name + (info !== undefined ? '  ' + JSON.stringify(info) : '')); };
const until = async (fn, ms = 8000, step = 100) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(step); } return null; };

// 1) o código, sem navegador: igual aos de referência do vault, caractere por caractere
const REF = {
  livre: '00020126580014br.gov.bcb.pix0136fa525dad-afca-4683-845d-eee7225a53e35204000053039865802BR5918Andre Miller Fleck6009Sao Paulo62070503***63047D61',
  5: '00020126580014br.gov.bcb.pix0136fa525dad-afca-4683-845d-eee7225a53e352040000530398654045.005802BR5918Andre Miller Fleck6009Sao Paulo62070503***6304C8ED',
  10: '00020126580014br.gov.bcb.pix0136fa525dad-afca-4683-845d-eee7225a53e3520400005303986540510.005802BR5918Andre Miller Fleck6009Sao Paulo62070503***6304DCD7',
  25: '00020126580014br.gov.bcb.pix0136fa525dad-afca-4683-845d-eee7225a53e3520400005303986540525.005802BR5918Andre Miller Fleck6009Sao Paulo62070503***63044036',
};
check('Pix livre = referência', A.brcode(null) === REF.livre);
check('Pix R$ 5 = referência', A.brcode(5) === REF[5]);
check('Pix R$ 10 = referência', A.brcode(10) === REF[10]);
check('Pix R$ 25 = referência', A.brcode(25) === REF[25]);
const c1250 = A.brcode(A.lerValor('12,50'));
check('"12,50" → campo 54 05 12.50 e CRC certo', c1250.includes('540512.50') && c1250.slice(-4) === A.crc16(c1250.slice(0, -4)), c1250.slice(-30));
check('CRC16-CCITT-FALSE de "123456789" = 29B1', A.crc16('123456789') === '29B1');
check('valores fora de R$ 1–10.000 recusados, vazio = livre', Number.isNaN(A.lerValor('0,50')) && Number.isNaN(A.lerValor('10000,01')) && A.lerValor('') === null && A.lerValor('10000') === 10000);

// 2) o quadro no navegador
const ctx = await chromium.launchPersistentContext(path.join('/tmp', 'mt-apoio-' + Date.now()), {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, locale: 'pt-BR',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--headless=new'],
});
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://www.crunchyroll.com' });
await ctx.route('https://www.crunchyroll.com/**', (r) => {
  const q = r.request(), o = handle({ method: q.method(), url: q.url(), headers: q.headers(), body: q.postData() });
  return o ? r.fulfill({ status: o.status, contentType: o.type, body: o.body }) : r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Crunchyroll</h1>' });
});
await ctx.route('https://github.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>GitHub Sponsors</h1>' }));
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
await wait(1200);
for (const pg of ctx.pages()) if (pg.url().includes('COMO-INSTALAR')) await pg.close();
const VER = await sw.evaluate(() => chrome.runtime.getManifest().version);
await sw.evaluate((v) => chrome.storage.local.set({ 'mt.onboard': { tutorial: 'visto', visto: v, novLidas: v.split('.').slice(0, 3).join('.') }, 'mt.fila.bg': Date.now() }), VER);

const p = await ctx.newPage();
const fora = [];
const has = (t, x) => !!t && t.toLowerCase().includes(x.toLowerCase());
const card = () => p.evaluate(() => { const c = document.querySelector('maratona-ui').shadowRoot.querySelector('.card'); return c.hidden ? null : c.innerText; });
const abrir = async () => { await p.keyboard.press('Alt+m'); await wait(400); await p.locator('maratona-ui .menu [data-act="apoio"]').click(); await wait(500); };
async function lerQR() {
  const el = p.locator('maratona-ui .card .qr');
  const buf = await el.screenshot();
  const png = PNG.sync.read(buf);
  const r = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return r && r.data;
}
await p.goto('https://www.crunchyroll.com/pt-br/watchlist');
await wait(2000);
const menuTxt = await (async () => { await p.keyboard.press('Alt+m'); await wait(400); const t = await p.evaluate(() => document.querySelector('maratona-ui').shadowRoot.querySelector('.menu .mf').innerText); await p.keyboard.press('Escape'); await wait(300); return t; })();
check('rodapé do menu: Procurar atualização … Apoiar ♥ … feito por Dreds', /PROCURAR ATUALIZAÇÃO[\s\S]*APOIAR ♥[\s\S]*feito por Dreds/i.test(menuTxt), menuTxt.replace(/\n/g, ' | '));

p.on('request', (r) => { const u = new URL(r.url()); if (!/crunchyroll\.com$/.test(u.hostname)) fora.push(u.href); });
await abrir();
let t = await card();
check('PT: abre "De onde você é?" com Brasil e Outro país', t && has(t, 'De onde você é?') && has(t, 'Brasil') && has(t, 'Pix, em reais, na hora') && has(t, 'Outro país') && has(t, 'É opcional e não muda nada na Maratona'), t);
const hl = await p.evaluate(() => [...document.querySelector('maratona-ui').shadowRoot.querySelectorAll('.apc')].map((b) => b.dataset.ap + ':' + b.classList.contains('hl')));
check('PT destaca o Brasil', hl.join() === 'br:true,int:false', hl);
await p.screenshot({ path: path.join(SHOT, 'apoio-pt-escolha.png') });

// foco preso
const dentro = [];
for (let i = 0; i < 9; i++) { await p.keyboard.press('Tab'); dentro.push(await p.evaluate(() => { const r = document.querySelector('maratona-ui').shadowRoot; const a = r.activeElement; return !!(a && r.querySelector('.card').contains(a)); })); }
check('Tab fica preso dentro do quadro', dentro.every(Boolean), dentro);

await p.locator('maratona-ui .card [data-ap="br"]').click(); await wait(400);
t = await card();
check('Brasil: valores, QR, copiar, chave e instrução', has(t, 'R$ 5') && has(t, 'R$ 25') && has(t, 'Outro valor') && has(t, 'Copiar código Pix') && has(t, 'fa525dad-afca-4683-845d-eee7225a53e3') && has(t, 'O nome que aparece é Andre Miller Fleck'), t);
const alt10 = await p.evaluate(() => document.querySelector('maratona-ui').shadowRoot.querySelector('.qr svg').getAttribute('aria-label'));
check('texto alternativo do QR "QR Code Pix de R$ 10"', alt10 === 'QR Code Pix de R$ 10', alt10);
await p.screenshot({ path: path.join(SHOT, 'apoio-pt-brasil.png') });

for (const v of [5, 10, 25]) {
  await p.locator(`maratona-ui .card .apv[data-v="${v}"]`).click(); await wait(250);
  const q = await lerQR();
  check(`QR lido da imagem (R$ ${v}) = referência do vault`, q === REF[v], q && q.slice(-40));
}
await p.locator('maratona-ui .card .apv[data-v="outro"]').click(); await wait(250);
check('Outro valor vazio → QR de valor livre = referência', (await lerQR()) === REF.livre);
await p.locator('maratona-ui .card .apo input').fill('12,50'); await wait(300);
const q1250 = await lerQR();
check('Outro valor "12,50" → QR com 540512.50 e CRC certo', q1250 === c1250, q1250 && q1250.slice(-40));
await p.locator('maratona-ui .card [data-cp="code"]').click(); await wait(300);
const clip = await p.evaluate(() => navigator.clipboard.readText());
const btnTxt = await p.evaluate(() => document.querySelector('maratona-ui').shadowRoot.querySelector('[data-cp="code"]').innerText);
check('"Copiar código Pix" copia o código certo e mostra "Copiado!"', clip === c1250 && /Copiado!/i.test(btnTxt), { clip: clip.slice(-20), btnTxt });
await p.locator('maratona-ui .card [data-cp="key"]').click(); await wait(300);
check('copiar a chave', (await p.evaluate(() => navigator.clipboard.readText())) === 'fa525dad-afca-4683-845d-eee7225a53e3');
await p.locator('maratona-ui .card .apo input').fill('0,50'); await wait(300);
t = await card();
check('valor fora do limite avisa e cai no QR livre', has(t, 'Digite um valor de R$ 1 a R$ 10.000') && (await lerQR()) === REF.livre);
await p.locator('maratona-ui .card .apv[data-v="10"]').click(); await wait(250);

// Voltar → Outro país
await p.locator('maratona-ui .card [data-back]').click(); await wait(300);
check('← Voltar volta para a escolha', has(await card(), 'De onde você é?'));
await p.locator('maratona-ui .card [data-ap="int"]').click(); await wait(300);
t = await card();
check('Outro país: texto e "Abrir o GitHub Sponsors"', has(t, 'a partir de US$ 1') && has(t, 'Abrir o GitHub Sponsors'), t);
await p.screenshot({ path: path.join(SHOT, 'apoio-pt-outro.png') });
const [np] = await Promise.all([ctx.waitForEvent('page'), p.locator('maratona-ui .card [data-sp]').click()]);
await np.waitForLoadState().catch(() => {});
check('abre https://github.com/sponsors/DredsGG em aba nova', np.url() === 'https://github.com/sponsors/DredsGG', np.url());
await np.close();
await p.bringToFront();

// Esc fecha; reabre no mesmo lugar (Outro país); clique fora fecha
await p.keyboard.press('Escape'); await wait(400);
check('Esc fecha', (await card()) === null);
await abrir();
check('reabre no mesmo lugar (Outro país)', has(await card(), 'Abrir o GitHub Sponsors'));
await p.mouse.click(40, 860); await wait(400);
check('clique fora fecha', (await card()) === null);
const extern = fora.filter((u) => !u.startsWith('https://github.com/sponsors/DredsGG'));
check('nenhuma chamada de rede fora da Crunchyroll durante o quadro (só a aba do Sponsors, que a pessoa abriu)', extern.length === 0, extern);

// EN e ES (os dois caminhos)
for (const [l, titulo, outro, brTxt, intTxt] of [['en', 'Where are you from?', 'Another country', 'Copy Pix code', 'Open GitHub Sponsors'], ['es', '¿De dónde eres?', 'Otro país', 'Copiar código Pix', 'Abrir GitHub Sponsors']]) {
  await sw.evaluate((x) => chrome.storage.sync.set({ lang: x }), l);
  await sw.evaluate(() => chrome.storage.local.set({ 'mt.apoio': { pais: null, valor: 10 } }));
  await wait(400);
  await abrir();
  t = await card();
  const h = await p.evaluate(() => [...document.querySelector('maratona-ui').shadowRoot.querySelectorAll('.apc')].map((b) => b.dataset.ap + ':' + b.classList.contains('hl')).join());
  check(`${l.toUpperCase()}: "${titulo}" e destaca ${outro}`, has(t, titulo) && h === 'br:false,int:true', { h, t: t && t.slice(0, 120) });
  await p.locator('maratona-ui .card [data-ap="br"]').click(); await wait(300);
  t = await card();
  check(`${l.toUpperCase()}: caminho Brasil traduzido e QR = referência`, has(t, brTxt) && (await lerQR()) === REF[10]);
  await p.screenshot({ path: path.join(SHOT, `apoio-${l}-brasil.png`) });
  await p.locator('maratona-ui .card [data-back]').click(); await wait(250);
  await p.locator('maratona-ui .card [data-ap="int"]').click(); await wait(300);
  t = await card();
  check(`${l.toUpperCase()}: caminho outro país traduzido`, has(t, intTxt));
  await p.screenshot({ path: path.join(SHOT, `apoio-${l}-outro.png`) });
  await p.keyboard.press('Escape'); await wait(300);
}
const perms = await sw.evaluate(() => chrome.runtime.getManifest().permissions);
check('sem permissão nova no manifest', JSON.stringify(perms) === JSON.stringify(['storage', 'alarms', 'downloads', 'scripting']), perms);

await ctx.close();
console.log(ok ? '\nTUDO PASSOU' : '\nFALHOU ALGO');
process.exit(ok ? 0 : 1);
