// Página da Crunchyroll simulada, com o mesmo DOM do player medido ao vivo em 2026-10-27
// (player-controls-root, botão único de pular com svg[data-testid="skip-intro-icon"] e rótulo que muda,
// next-episode-button dentro de bottom-controls-autohide). O botão aparece só 5 s no começo de cada trecho,
// como no site, e o vídeo para pausado no último quadro (não troca de episódio sozinho).
import fs from 'fs';
import path from 'path';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const VIDEO = fs.readFileSync(path.join(DIR, 'media', process.env.MT_VIDEO || 'ep.webm'));

// episódios: EP1 normal; EP2 com cena pós-créditos (créditos 70–80, cena até o fim); EP3 sem próximo
export const EPS = {
  EP1: { segs: [{ type: 'intro', start: 2, end: 12 }, { type: 'credits', start: 85, end: 99.95 }], next: 'EP2' },
  EP2: { segs: [{ type: 'recap', start: 1, end: 6 }, { type: 'intro', start: 8, end: 18 }, { type: 'credits', start: 70, end: 80 }], next: 'EP3' },
  EP3: { segs: [{ type: 'intro', start: 2, end: 12 }, { type: 'credits', start: 85, end: 99.95 }], next: null },
};
export const LABELS = {
  pt: { intro: 'Pular introdução', credits: 'Pular créditos', recap: 'Pular recapitulação', next: 'Próximo episódio' },
  en: { intro: 'Skip Intro', credits: 'Skip Credits', recap: 'Skip Recap', next: 'Next Episode' },
  xx: { intro: 'Überspringen', credits: 'Überspringen', recap: 'Überspringen', next: 'Weiter' }, // idioma sem regex de tipo: decide pela posição
};

export function html(labels) {
  return `<!doctype html><html lang="pt"><head><meta charset="utf-8"><title>Crunchyroll (simulada)</title>
<style>body{margin:0;background:#000;color:#ddd;font-family:system-ui}.video-player-wrapper{width:960px;margin:0 auto}
#player-container{position:relative;aspect-ratio:16/9}video{width:100%;height:100%;display:block;background:#111}
[data-testid=player-controls-root]{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:flex-end;pointer-events:none}
.skip{align-self:flex-end;margin:0 40px 90px 0;padding:12px 24px;border-radius:99px;border:0;background:#fafafa;font-weight:700;transition:opacity .2s;pointer-events:auto}
.skip[aria-hidden=true]{opacity:0;pointer-events:none}
[data-testid=bottom-controls-autohide]{opacity:0;pointer-events:none;display:flex;justify-content:flex-end;padding:10px}
.meta{width:960px;margin:12px auto}</style></head><body>
<div class="erc-watch-episode"><div class="video-player-wrapper"><div id="player-container" class="player-container">
<div class="bitmovinplayer-container aspect-16x9"><video id="bitmovinplayer-video-null" src="/media/ep.webm" muted playsinline></video></div>
<div class="katamariDesktop"><div data-testid="player-controls-root">
  <button type="button" class="skip" aria-hidden="true" tabindex="0"><span class="lb"></span><span><svg data-testid="skip-intro-icon" width="10" height="10"></svg></span></button>
  <div data-testid="bottom-controls-autohide"><button type="button" data-testid="jump-backward-button" aria-label="Retroceder 10 segundos"></button><button type="button" data-testid="next-episode-button"><svg data-testid="next-episode-icon" width="10" height="10"></svg></button></div>
</div></div></div></div><div class="meta">Episódio <b id="ep"></b></div></div>
<script>
const EPS = ${JSON.stringify(EPS)}; const LB = ${JSON.stringify(labels)};
const v = document.querySelector('video'), sk = document.querySelector('.skip'), nb = document.querySelector('[data-testid=next-episode-button]');
nb.setAttribute('aria-label', LB.next);
window.__mock = { clicks: [], nav: [] };
const ep = () => (location.pathname.match(/watch\\/([A-Z0-9]+)/) || [])[1];
let cur = null;
let controlsUntil = 0;
document.querySelector('[data-testid=player-controls-root]').addEventListener('pointermove', () => { controlsUntil = Date.now() + 2000; window.__mock.wakes = (window.__mock.wakes || 0) + 1; });
function seg() { const e = EPS[ep()]; if (!e) return null; const awake = Date.now() < controlsUntil;
  return e.segs.find((s) => v.currentTime >= s.start && v.currentTime < s.end && (awake || v.currentTime < s.start + 5)) || null; }
setInterval(() => {
  document.getElementById('ep').textContent = ep();
  const s = seg();
  cur = s;
  if (s) { sk.setAttribute('aria-hidden', 'false'); sk.setAttribute('aria-label', LB[s.type]); sk.querySelector('.lb').textContent = LB[s.type]; }
  else sk.setAttribute('aria-hidden', 'true');
  // como no site: depois de pular para o fim, o vídeo fica parado no último quadro, pausado, sem trocar
  if (v.duration && v.currentTime >= v.duration - 0.2 && !v.paused) v.pause();
}, 100);
sk.addEventListener('click', () => {
  if (sk.getAttribute('aria-hidden') === 'true' || !cur) return; // escondido: o clique não faz nada (medido ao vivo)
  window.__mock.clicks.push({ ep: ep(), type: cur.type, at: v.currentTime, ts: Date.now() });
  v.currentTime = Math.min(cur.end, v.duration - 0.05);
});
document.querySelector('[data-testid=jump-backward-button]').addEventListener('click', () => { window.__mock.back = (window.__mock.back || 0) + 1; v.currentTime = Math.max(0, v.currentTime - 10); });
nb.addEventListener('click', () => {
  const nx = EPS[ep()] && EPS[ep()].next;
  window.__mock.nav.push({ from: ep(), to: nx, ts: Date.now() });
  if (!nx) return;
  history.pushState({}, '', '/pt-br/watch/' + nx + '/episodio');
  v.currentTime = 0; v.play();
  if (!EPS[nx].next) nb.remove(); // como no site: último episódio não tem o botão
});
if (EPS[ep()] && !EPS[ep()].next) nb.remove();
</script></body></html>`;
}

export async function routes(ctx, lang = 'pt', { events = true } = {}) {
  const labels = LABELS[lang] || LABELS.pt;
  await ctx.route('https://static.crunchyroll.com/skip-events/**', (r) => {
    const id = r.request().url().match(/production\/([A-Z0-9]+)\.json/)[1];
    const e = EPS[id];
    if (!events || !e) return r.fulfill({ status: 404, body: 'not found' });
    const j = { lastUpdated: '2026-10-27T00:00:00Z', mediaId: id };
    for (const s of e.segs) j[s.type] = { type: s.type, start: s.start, end: s.end };
    return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(j) });
  });
  await ctx.route('https://www.crunchyroll.com/**', async (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/media/ep.webm') {
      const range = r.request().headers()['range'];
      const total = VIDEO.length;
      if (range) {
        const m = range.match(/bytes=(\d+)-(\d*)/);
        const a = +m[1], b = m[2] ? Math.min(+m[2], total - 1) : total - 1;
        return r.fulfill({ status: 206, headers: { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': String(b - a + 1) }, body: VIDEO.subarray(a, b + 1) });
      }
      return r.fulfill({ status: 200, headers: { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Length': String(total) }, body: VIDEO });
    }
    return r.fulfill({ status: 200, contentType: 'text/html', body: html(labels) });
  });
}
