# Testes da Maratona

E2E num Chromium com a extensão carregada. A Crunchyroll é simulada (`mock.mjs`) com o mesmo DOM do player medido ao vivo em 2026-10-27:
`player-controls-root`, botão único de pular com `svg[data-testid="skip-intro-icon"]` (o rótulo muda), botão visível só 5 s no começo do trecho
(depois só com os controles acordados), `next-episode-button`, `jump-backward-button` e o vídeo parando pausado no último quadro.

## Preparação (uma vez)

1. `npm i playwright` (ou use um Playwright já instalado).
2. Gere o vídeo de teste (WebM, porque o Chromium do Playwright não toca H.264):
   ```
   ffmpeg -f lavfi -i testsrc2=size=320x180:rate=10 -f lavfi -i sine=frequency=330 -t 100 -c:v libvpx -b:v 150k -c:a libopus media/ep.webm
   ```

## Rodar

```
node e2e.mjs ../extension pt   # tudo: tutorial, abertura, Desfazer, créditos → próximo, recap, pós-créditos, acordar controles, último episódio, chaves, novidades, versão nova, popup, Relatar bug, ES
node e2e.mjs ../extension en   # rótulos em inglês
node e2e.mjs ../extension xx   # rótulo desconhecido e sem skip-events: decide pela posição no vídeo
```

Tem que terminar com `TUDO PASSOU`. As capturas vão para `shots/`.

Sem argumento, os scripts usam `../extension` (a extensão do repo). No PC do André, use `../instalada`.

Outros:
- `node shot-popup.mjs` gera prints do popup e do guia em `shots/`.
- `MT_VIDEO=pretty.webm node prints-github.mjs` gera os prints da página do GitHub (em inglês) em `../docs/`. Vídeo de fundo:
  `ffmpeg -f lavfi -i "gradients=s=1280x720:c0=0x0b0b0f:c1=0x3a2414:c2=0x101a26:n=3:speed=0.01:r=10,format=yuv420p" -f lavfi -i sine=frequency=330 -t 100 -c:v libvpx -b:v 300k -c:a libopus media/pretty.webm`

## Firefox de verdade

Roda no GitHub Actions (workflow `Test`, a cada push): `web-ext lint` sem erro e o Firefox do runner com a extensão instalada como temporária,
numa Crunchyroll simulada servida por `firefox/server.mjs` (www.crunchyroll.com e static.crunchyroll.com apontam para 127.0.0.1).
O roteiro está em `firefox/run_firefox.py`: tutorial, Esc, abertura pulada com o aviso, créditos → próximo episódio em ~5 s e cena pós-créditos.
