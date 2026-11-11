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

Firefox real: não roda neste ambiente (sem Firefox). Vai no workflow de teste do repo, no padrão do Salva Stories (`salva-stories\testes\firefox\run_firefox.py`).

## Fila (v1.3.0+) e faixas (v1.4.0)

```
node fila-e2e.mjs ../extension   # 89 checagens na v1.4.1: rodelinha, janela, marcar, recomeçar, episódio novo, sininho, faixas e marcar na Crunchyroll
node apoio-e2e.mjs ../extension  # botão Apoiar ♥
```

A Fila simulada (`fila-mock.mjs`) imita a lista virtual medida ao vivo em 2026-11-11: TanStack Virtual em modo janela, uma `div`
absoluta com `translateY` por linha de 4 cards (279 px), só as linhas na tela mais 5 acima e 5 abaixo no DOM.

**Windows (app Claude, MSIX):** o Chromium do Playwright fica numa pasta virtualizada e o `spawn` dá `spawn UNKNOWN`. Defina
`PLAYWRIGHT_BROWSERS_PATH` com o caminho real (`%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Local\ms-playwright`). Playwright 1.63.0.

**Oscilação conhecida no `e2e.mjs pt`:** o salto para 84 s logo depois do Desfazer às vezes não pega e caem 5 checagens seguidas
(créditos → próximo episódio). Em 2026-11-11 aconteceu 1 vez em 4 com a 1.3.2 e 1 vez em 3 com a 1.4.0; rodar de novo.

**Máquina carregada (outra sessão rodando navegadores de teste):** as checagens com prazo fixo ("ícone sem selo", "guia abre na instalação", "depois de atualizar o quadro some") falham de vez em quando. Em 2026-11-11, com a CPU entre 60% e 100%, cada uma falhou em 1 corrida e passou na seguinte. Confira a carga antes de concluir que é bug.
