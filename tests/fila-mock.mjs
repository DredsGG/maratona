// Fila e API da Crunchyroll simuladas (v1.3.0), no formato medido ao vivo em 2026-10-28:
// card [data-t="watch-list-card"] com link /series/<id>/ e imagem watchlist-card-image--*, link que cobre o card;
// POST /auth/v1/token (etp_rt_cookie + client id do script + device_id do cookie), /content/v2/cms/series/<id>/seasons,
// /cms/seasons/<id>/episodes, /content/v2/<conta>/playheads (até 50 ids) e /content/v2/discover/<conta>/watchlist.
// Usado pelo fila-e2e.mjs (Chromium) e pelo firefox/server.mjs (Firefox de verdade no CI).
// ── dados simulados ──
export const CLIENT = 'cli_teste_123', TOKEN = 'tk_ok', ACC = 'ACC-1';
export const past = '2020-01-01T00:00:00Z', future = '2099-01-01T00:00:00Z';
export const mkEps = (season, n, opts = {}) => Array.from({ length: n }, (_, i) => ({
  id: `${season}E${i + 1}`, title: `Episódio ${i + 1} de ${season}`, episode: String((opts.base || 0) + i + 1), episode_number: (opts.base || 0) + i + 1, sequence_number: i + 1,
  is_clip: false, availability_starts: past, premium_available_date: past, audio_locale: 'pt-BR',
  versions: [{ guid: `${season}E${i + 1}`, audio_locale: 'pt-BR' }, { guid: `${season}E${i + 1}JA`, audio_locale: 'ja-JP' }],
}));
export const DB = {
  series: {
    S1: { title: 'Série Alfa', seasons: [{ id: 'S1A', title: 'Série Alfa', seq: 1, eps: mkEps('S1A', 12) }, { id: 'S1B', title: 'Série Alfa Temporada 2', seq: 2, eps: mkEps('S1B', 12, { base: 12 }) }] },
    S2: { title: 'Série Beta', seasons: [{ id: 'S2A', title: 'Série Beta', seq: 1, eps: mkEps('S2A', 10) }] },
    S3: { title: 'Série Gama', seasons: [{ id: 'S3A', title: 'Série Gama', seq: 1, eps: [...mkEps('S3A', 5),
      Object.assign(mkEps('S3A', 6)[5], { availability_starts: future, premium_available_date: future }), Object.assign(mkEps('S3X', 1)[0], { id: 'CLIP', is_clip: true, sequence_number: 99 })] }] },
  },
  // vistos: S1 temporada 1 inteira pela versão japonesa e 6 da temporada 2 pela dublada; S2 inteira
  watched: new Map([...Array.from({ length: 12 }, (_, i) => [`S1AE${i + 1}JA`, '2026-10-01T00:00:00Z']), ...Array.from({ length: 6 }, (_, i) => [`S1BE${i + 1}`, '2026-10-02T00:00:00Z']),
    ...Array.from({ length: 10 }, (_, i) => [`S2AE${i + 1}`, '2026-10-03T00:00:00Z'])]),
  calls: { token: 0, playheads: 0, badAuth: 0 },
};

export function filaHtml() {
  const card = (sid, s) => `<div class="erc-my-lists-item"><div class="watchlist-card--YfKgo" data-t="watch-list-card" style="position:relative;width:240px">
      <a class="watchlist-card__content-link--Ujiaq" href="/pt-br/series/${sid}/slug" style="position:absolute;inset:0;z-index:2" aria-label="${s.title}"></a>
      <div class="watchlist-card-image--CMvVM" style="position:relative;width:240px;height:135px;background:linear-gradient(135deg,#2a2a40,#553311)">
        <div class="watchlist-card-image__tags--cnj48" style="position:absolute;top:4px;left:4px;z-index:1;background:#e33;color:#fff;font:700 10px sans-serif;padding:2px 4px">A14</div></div>
      <div class="watchlist-card-body--ZpYFy"><h4 class="watchlist-card-title--o1sAO" style="margin:8px 0 4px;color:#fff;font:700 16px sans-serif">${s.title}</h4>
        <a href="/pt-br/watch/${s.seasons[0].eps[0].id}/x" style="color:#aaa;font:14px sans-serif;position:relative;z-index:2">Continuar: E1</a></div></div></div>`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Fila (simulada)</title>
<script>window.__APP_CONFIG__ = {"cxApiParams":{"apiDomain":"https://www.crunchyroll.com","accountAuthClientId":"${CLIENT}","anonClientId":"anon"}};</script>
<style>body{margin:0;background:#000;color:#fff;font-family:system-ui}.watchlist-body{display:grid;grid-template-columns:repeat(4,240px);gap:30px;padding:40px 60px}</style></head>
<body><h2 style="padding:20px 60px 0;margin:0">Minhas Listas · Fila</h2><div class="watchlist-body" id="wl">${Object.entries(DB.series).map(([sid, s]) => card(sid, s)).join('')}</div>
<script>document.cookie='device_id=dev-site-1; path=/';</script></body></html>`;
}
const watchHtml = (sid) => `<!doctype html><html><head><meta charset="utf-8"><title>Episódio</title></head><body style="background:#000;color:#fff">
<div class="erc-watch-episode"><a class="show-title-link" href="/pt-br/series/${sid}/slug"><h4>${DB.series[sid].title}</h4></a></div></body></html>`;


// responde um pedido para www.crunchyroll.com, ou null se não for da Fila
export function handle({ method, url, headers, body }) {
  const u = new URL(url), json = (o, status = 200) => ({ status, type: 'application/json', body: JSON.stringify(o) });
  const auth = headers['authorization'] || '';
  if (u.pathname === '/auth/v1/token' && method === 'POST') {
    DB.calls.token++;
    const b = new URLSearchParams(body || '');
    const okAuth = auth === 'Basic ' + Buffer.from(CLIENT + ':').toString('base64');
    if (!okAuth || b.get('grant_type') !== 'etp_rt_cookie' || b.get('device_id') !== 'dev-site-1') { DB.calls.badAuth++; return json({ error: 'invalid' }, 400); }
    return json({ access_token: TOKEN, refresh_token: 'r', expires_in: 300, token_type: 'Bearer', account_id: ACC, profile_id: 'P' });
  }
  if (u.pathname.startsWith('/content/v2/')) {
    if (auth !== 'Bearer ' + TOKEN) return json({ error: 'unauthorized' }, 401);
    let m;
    if ((m = u.pathname.match(/^\/content\/v2\/cms\/series\/(\w+)\/seasons$/))) {
      const s = DB.series[m[1]];
      if (!s) return json({ total: 0, data: [] });
      return json({ total: s.seasons.length, data: s.seasons.map((x, i) => ({ id: x.id, title: x.title, season_number: i + 1, season_sequence_number: x.seq, season_display_number: '', number_of_episodes: x.eps.length, audio_locale: 'pt-BR' })) });
    }
    if ((m = u.pathname.match(/^\/content\/v2\/cms\/seasons\/(\w+)\/episodes$/))) {
      const se = Object.values(DB.series).flatMap((s) => s.seasons).find((x) => x.id === m[1]);
      return json({ total: se ? se.eps.length : 0, data: se ? se.eps : [] });
    }
    if ((m = u.pathname.match(/^\/content\/v2\/([\w-]+)\/playheads$/))) {
      DB.calls.playheads++;
      if (m[1] !== ACC) return json({ error: 'acc' }, 403);
      const ids = (u.searchParams.get('content_ids') || '').split(',');
      if (ids.length > 50) return json({ error: 'too many' }, 400);
      return json({ total: 0, data: ids.filter((id) => DB.watched.has(id)).map((id) => ({ content_id: id, playhead: 1400, fully_watched: true, last_modified: DB.watched.get(id) })) });
    }
    if ((m = u.pathname.match(/^\/content\/v2\/discover\/([\w-]+)\/watchlist$/))) {
      return json({ total: 3, data: Object.entries(DB.series).map(([sid, s]) => ({ new: false, fully_watched: false, never_watched: false, playhead: 0, is_favorite: false, panel: { id: 'X', type: 'episode', episode_metadata: { series_id: sid, series_title: s.title } } })) });
    }
    return json({ data: [] });
  }
  const w = u.pathname.match(/\/watch\/(S\d)\//);
  if (w) return { status: 200, type: 'text/html; charset=utf-8', body: watchHtml(w[1]) };
  if (/\/series\//.test(u.pathname)) return { status: 200, type: 'text/html; charset=utf-8', body: '<h1>página da série</h1>' };
  if (/\/watchlist(\/|$)/.test(u.pathname)) return { status: 200, type: 'text/html; charset=utf-8', body: filaHtml() };
  return null;
}
