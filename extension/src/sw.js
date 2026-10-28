// Maratona — fundo da extensão: procura versão nova, se recarrega quando a pasta muda e põe a versão nova nas abas abertas.
// O mesmo arquivo roda como service worker nos Chromium (Chrome, Edge, Brave, Opera GX) e como event page no Firefox
// (manifest com "service_worker" e "scripts"). Por isso nada de window/DOM aqui.
const ext = (globalThis.browser && globalThis.browser.runtime) ? globalThis.browser : globalThis.chrome;
const IS_FF = !!(ext.runtime && ext.runtime.getBrowserInfo); // só o Firefox tem
const SYNC = ext.storage.sync || ext.storage.local; // Opera: sync pode não existir
const REPO = 'DredsGG/maratona';
const UPD_KEY = 'mt.update';
const CR_TABS = ['https://www.crunchyroll.com/*'];
const CONTENT = ['src/i18n.js', 'src/novidades.js', 'src/content.js', 'src/fila.js'];

const cmpVer = (a, b) => {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0), pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
};
const versaoAtual = () => ext.runtime.getManifest().version;
const tipoInstalacao = async () => { try { return (await ext.management.getSelf()).installType; } catch (_) { return 'development'; } };
async function salvarUpd(patch) {
  const cur = (await ext.storage.local.get(UPD_KEY))[UPD_KEY] || {};
  const novo = Object.assign({}, cur, patch);
  await ext.storage.local.set({ [UPD_KEY]: novo });
  return novo;
}

// ───────────────────────── atualização (regras 7 e 14 do hub) ─────────────────────────
// Procura nos Releases do GitHub (regra 14, revisada 2026-10-27 20h): ao abrir o navegador, na instalação, a cada 30 min,
// quando a página da Crunchyroll abre ou volta a ficar visível (no máximo 1 vez a cada 10 min) e no botão do menu.
// Release com "URGENTE" no título (ou na tag) = urgente: o quadro aparece sem X e a Maratona pausa até atualizar.
async function procurar() {
  const base = { procuradoEm: Date.now(), atual: versaoAtual(), instalacao: await tipoInstalacao() };
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
    if (r.status === 404) return salvarUpd(Object.assign(base, { ultima: null, disponivel: false, erro: null, semRelease: true }));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const ultima = String(j.tag_name || '').replace(/^v/i, '');
    const asset = (re) => ((j.assets || []).find((a) => re.test(a.name)) || {}).browser_download_url || null;
    const urgente = /urgent/i.test(String(j.name || '') + ' ' + String(j.tag_name || ''));
    return salvarUpd(Object.assign(base, { ultima, urgente, titulo: String(j.name || '').slice(0, 120), notas: String(j.body || '').slice(0, 4000), pagina: j.html_url || null, zip: asset(/\.zip$/i), xpi: asset(/\.xpi$/i),
      firefox: IS_FF, disponivel: !!ultima && cmpVer(ultima, versaoAtual()) > 0, erro: null, semRelease: false }));
  } catch (e) {
    return salvarUpd(Object.assign(base, { erro: String((e && e.message) || e) }));
  }
}

async function aplicar() {
  const st = (await ext.storage.local.get(UPD_KEY))[UPD_KEY] || {};
  const pagina = st.pagina || `https://github.com/${REPO}/releases/latest`;
  if (IS_FF) { // abrir o .xpi assinado faz o Firefox perguntar se instala (ele também se atualiza pelo update_url)
    await ext.tabs.create({ url: st.xpi && /^https:\/\/github\.com\//.test(st.xpi) ? st.xpi : pagina });
    await salvarUpd({ baixadoEm: Date.now() });
    return { modo: st.xpi ? 'xpi' : 'pagina' };
  }
  if (await tipoInstalacao() === 'normal' && ext.runtime.requestUpdateCheck) {
    const res = await ext.runtime.requestUpdateCheck().then((r) => (r && r.status) || r).catch(() => 'no_update');
    if (res === 'update_available') { setTimeout(() => ext.runtime.reload(), 1500); return { modo: 'loja' }; }
  }
  // por pasta (modo desenvolvedor): baixa o zip do Release; o guia ensina a extrair por cima da pasta
  if (st.zip && /^https:\/\/github\.com\//.test(st.zip)) {
    try { await ext.downloads.download({ url: st.zip, conflictAction: 'uniquify', saveAs: false }); } catch (_) { await ext.tabs.create({ url: pagina }); }
  } else await ext.tabs.create({ url: pagina });
  await salvarUpd({ baixadoEm: Date.now() });
  return { modo: 'download' };
}

// a página pede ao abrir e ao voltar para a aba: no máximo 1 consulta a cada 10 min
const INTERVALO_MIN_MS = 10 * 60 * 1000;
async function procurarSeVelho() {
  const st = (await ext.storage.local.get(UPD_KEY))[UPD_KEY] || {};
  if (st.procuradoEm && Date.now() - st.procuradoEm < INTERVALO_MIN_MS && st.atual === versaoAtual()) return st;
  return procurar();
}

function abrirGuia(ancora) {
  const a = /^#[a-z]+$/.test(ancora || '') ? ancora : '';
  return ext.tabs.create({ url: ext.runtime.getURL('COMO-INSTALAR.html') + a }).then(() => ({ ok: true }));
}

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'maratona:update') return;
  const run = msg.cmd === 'check' ? procurar() : msg.cmd === 'check-soft' ? procurarSeVelho() : msg.cmd === 'apply' ? aplicar() : msg.cmd === 'guide' ? abrirGuia(msg.data)
    : msg.cmd === 'diag' ? tipoInstalacao().then((instalacao) => ({ instalacao, firefox: IS_FF }))
    : msg.cmd === 'dismiss' ? salvarUpd({ dispensada: typeof msg.data === 'string' ? msg.data.slice(0, 20) : null }) : Promise.resolve({});
  run.then((r) => sendResponse(r || {}), (e) => sendResponse({ erro: String((e && e.message) || e) }));
  return true;
});

// ───────────────────────── ícone da extensão: abre o menu dentro da Crunchyroll (v1.2.0, sem popup) ─────────────────────────
// Na aba da Crunchyroll, abre/fecha o menu da página. Em qualquer outra aba (ou se a página ainda não tem a extensão), abre a Crunchyroll.
ext.action.onClicked.addListener(async (tab) => {
  const naCr = tab && /^https:\/\/www\.crunchyroll\.com\//.test(tab.url || '');
  if (naCr) {
    try { await ext.tabs.sendMessage(tab.id, { type: 'maratona:menu' }); return; } catch (_) {}
    if (!IS_FF && ext.scripting) { // aba aberta antes da instalação: põe a extensão nela e abre o menu
      try { await ext.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT }); await ext.tabs.sendMessage(tab.id, { type: 'maratona:menu' }); return; } catch (_) {}
    }
  }
  ext.tabs.create({ url: 'https://www.crunchyroll.com/' });
});

// ───────────────────────── selo no ícone: "!" urgente, "OFF" desligada, "↑" versão nova, "+N" episódios novos na Fila ─────────────────────────
async function selo() {
  try {
    const s = await SYNC.get({ on: true, fila: true });
    const l = await ext.storage.local.get([UPD_KEY, 'mt.fila.novos']);
    const u = l[UPD_KEY] || {}, novos = s.fila ? (l['mt.fila.novos'] || []).reduce((a, n) => a + (n.n || 0), 0) : 0;
    const nova = u.disponivel && u.ultima && cmpVer(u.ultima, versaoAtual()) > 0;
    const txt = nova && u.urgente ? '!' : !s.on ? 'OFF' : nova ? '↑' : novos ? '+' + Math.min(novos, 99) : '';
    const laranja = nova || (!!novos && s.on);
    await ext.action.setBadgeText({ text: txt });
    await ext.action.setBadgeBackgroundColor({ color: laranja ? '#ff640a' : '#414141' });
    if (ext.action.setBadgeTextColor) await ext.action.setBadgeTextColor({ color: laranja ? '#000000' : '#ffffff' }).catch(() => {});
  } catch (_) {}
}
ext.storage.onChanged.addListener((ch, area) => { if ((area !== 'local' && (ch.on || ch.fila)) || (area === 'local' && (ch[UPD_KEY] || ch['mt.fila.novos']))) selo(); });

// ───────────────────────── versão nova na pasta (modo desenvolvedor) ─────────────────────────
// O navegador não deixa a extensão trocar os próprios arquivos. Quando a versão nova chega na pasta
// (zip extraído por cima, ou gravada pela IA com o manifest por último), a extensão percebe em até 1 min e se recarrega.
// Depois ela se injeta nas abas abertas da Crunchyroll, sem recarregar a página (não interrompe o episódio).
let recargaPendente = null;
const anotarDisco = (o) => ext.storage.local.set({ 'mt.disco': Object.assign({ em: Date.now(), rodando: versaoAtual() }, o) }).catch(() => {});
async function conferirDisco() {
  if (await tipoInstalacao() !== 'development') return;
  try {
    const r = await fetch(ext.runtime.getURL('manifest.json') + '?t=' + Date.now(), { cache: 'no-store' });
    const noDisco = (await r.json()).version;
    if (!noDisco || noDisco === versaoAtual() || recargaPendente === noDisco) { anotarDisco({ noDisco, estado: recargaPendente === noDisco ? 'recarregando' : 'igual' }); return; }
    anotarDisco({ noDisco, estado: 'recarregando' });
    recargaPendente = noDisco;
    setTimeout(() => ext.runtime.reload(), 15000); // dá tempo de o resto dos arquivos terminar de chegar
  } catch (_) { /* manifest no meio da gravação: tenta no próximo minuto */ }
}

async function injetarNasAbas() {
  if (IS_FF || !ext.scripting) return; // o Firefox já injeta sozinho nas abas abertas
  try {
    for (const t of await ext.tabs.query({ url: CR_TABS })) {
      if (t.discarded) continue;
      ext.scripting.executeScript({ target: { tabId: t.id }, files: CONTENT }).catch(() => {});
    }
  } catch (_) {}
}

const agendar = () => {
  ext.alarms.create('mt-procura', { delayInMinutes: 1, periodInMinutes: 30 });
  ext.alarms.create('mt-disco', { delayInMinutes: 1, periodInMinutes: 1 });
};
ext.alarms.onAlarm.addListener((a) => {
  if (a.name === 'mt-procura') procurar();
  if (a.name === 'mt-disco') conferirDisco();
});
ext.runtime.onStartup.addListener(() => { agendar(); procurar(); selo(); });
ext.runtime.onInstalled.addListener(async (d) => {
  agendar();
  selo();
  // regra 12: instalação nova → tutorial na primeira abertura da Crunchyroll; atualização → quadro de novidades
  try {
    const ob = (await ext.storage.local.get('mt.onboard'))['mt.onboard'];
    if (d.reason === 'install' && !ob) await ext.storage.local.set({ 'mt.onboard': { tutorial: 'pendente', visto: versaoAtual() } });
    if (d.reason === 'update' && !ob) await ext.storage.local.set({ 'mt.onboard': { tutorial: 'pulado', visto: d.previousVersion || '' } });
  } catch (_) {}
  if (d.reason === 'install') ext.tabs.create({ url: ext.runtime.getURL('COMO-INSTALAR.html#usar') });
  if (d.reason === 'update') await salvarUpd({ acabouDeAtualizar: { de: d.previousVersion || null, para: versaoAtual(), em: Date.now() }, disponivel: false, atual: versaoAtual() });
  injetarNasAbas();
  procurar();
});
// o service worker pode dormir: garante os alarmes sempre que acordar
ext.alarms.get('mt-disco').then((a) => { if (!a) agendar(); }, () => agendar());
