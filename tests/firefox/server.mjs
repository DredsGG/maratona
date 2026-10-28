// Crunchyroll simulada para o teste no Firefox de verdade (CI): www.crunchyroll.com e static.crunchyroll.com → este servidor (porta 443).
// Usa a mesma página do mock.mjs (DOM do player medido ao vivo) e o vídeo tests/media/ep.webm; a Fila e a API vêm do fila-mock.mjs (v1.3.0).
// Uso: sudo node server.mjs <cert.pem> <key.pem>
import https from 'https';
import fs from 'fs';
import path from 'path';
import { html, EPS, LABELS } from '../mock.mjs';
import { handle } from '../fila-mock.mjs';

const [CERT, KEY] = process.argv.slice(2);
const DIR = path.dirname(new URL(import.meta.url).pathname);
const VIDEO = fs.readFileSync(path.join(DIR, '..', 'media', 'ep.webm'));
const PAGE = html(LABELS.pt);

https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, (req, res) => {
  const u = new URL(req.url, 'https://' + req.headers.host);
  const host = (req.headers.host || '').split(':')[0];
  if (host === 'static.crunchyroll.com') {
    const m = u.pathname.match(/skip-events\/production\/([A-Z0-9]+)\.json$/);
    const e = m && EPS[m[1]];
    if (!e) { res.writeHead(404, { 'access-control-allow-origin': '*' }); return res.end('not found'); }
    const j = { lastUpdated: '2026-10-27T00:00:00Z', mediaId: m[1] };
    for (const s of e.segs) j[s.type] = { type: s.type, start: s.start, end: s.end };
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify(j));
  }
  if (host === 'www.crunchyroll.com' && u.pathname !== '/media/ep.webm' && !/\/watch\/EP\d/.test(u.pathname)) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    return req.on('end', () => {
      const out = handle({ method: req.method, url: u.href, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (!out) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
      res.writeHead(out.status, { 'content-type': out.type });
      res.end(out.body);
    });
  }
  if (u.pathname === '/media/ep.webm') {
    const total = VIDEO.length, range = req.headers.range;
    if (range) {
      const mm = range.match(/bytes=(\d+)-(\d*)/); const a = +mm[1], b = mm[2] ? Math.min(+mm[2], total - 1) : total - 1;
      res.writeHead(206, { 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${b}/${total}`, 'content-length': b - a + 1 });
      return res.end(VIDEO.subarray(a, b + 1));
    }
    res.writeHead(200, { 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'content-length': total });
    return res.end(VIDEO);
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
}).listen(443, () => console.log('ok 443'));
