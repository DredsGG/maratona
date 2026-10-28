"""Teste real no Firefox (CI): instala a Maratona como temporária e roda o fluxo principal numa Crunchyroll simulada
(server.mjs): tutorial de instalação nova, pular abertura com o aviso, pular créditos e ir para o próximo episódio
5 s depois cena pós-créditos respeitada, o menu dentro do site (v1.2.0) e a Fila com progresso (v1.3.0: token e API pelo content.fetch do Firefox). Uso: python run_firefox.py <pasta-da-extensao> <pasta-de-saida>"""
import json, os, sys, time
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.actions.action_builder import ActionBuilder

EXT, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
o = Options()
o.add_argument('-headless')
o.accept_insecure_certs = True
o.set_preference('intl.accept_languages', 'pt-BR')
o.set_preference('media.autoplay.default', 0)
d = webdriver.Firefox(options=o)
d.set_window_size(1280, 900)
res = {'firefox': d.capabilities.get('browserVersion')}
ok = True
VER = json.load(open(os.path.join(EXT, 'manifest.json')))['version']


def check(name, cond, info=None):
    global ok
    res[name] = {'ok': bool(cond), 'info': info}
    ok = ok and bool(cond)
    print(('OK  ' if cond else 'FAIL') + ' ' + name + ('  ' + json.dumps(info, ensure_ascii=False) if info is not None else ''), flush=True)


def js(s):
    return d.execute_script(s)


def wait_for(fn, t=15):
    end = time.time() + t
    while time.time() < end:
        try:
            v = fn()
            if v:
                return v
        except Exception:
            pass
        time.sleep(0.2)
    return None


UI = """const h = document.querySelector('maratona-ui'); if (!h) return {};
const c = h.shadowRoot.querySelector('.card'), t = h.shadowRoot.querySelector('.toast');
return { card: c && !c.hidden ? c.querySelector('.ttl b').textContent : null, toast: t && !t.hidden ? t.querySelector('.msg').textContent : null };"""
MOCK = "const v = document.querySelector('video'); return Object.assign({}, window.__mock, { t: v.currentTime, paused: v.paused, url: location.pathname });"


def click(x, y):
    a = ActionBuilder(d); a.pointer_action.move_to_location(int(x), int(y)).click(); a.perform()


def seek(t):
    js("const v = document.querySelector('video'); v.currentTime = %s; v.play();" % t)


try:
    d.install_addon(EXT, temporary=True)
    time.sleep(3)
    main = d.current_window_handle
    for h in d.window_handles:  # o guia de instalação abre numa aba própria
        if h != main:
            d.switch_to.window(h); res['guideTab'] = d.current_url[:60]
            try:
                d.save_screenshot(os.path.join(OUT, 'ff-guia.png'))
            except Exception:
                pass  # o Firefox não tira print de página interna da extensão (moz-extension://)
            d.close()
    d.switch_to.window(main)
    check('guia abre na instalação', 'guideTab' in res, res.get('guideTab'))

    d.get('https://www.crunchyroll.com/pt-br/watch/EP1/episodio')
    tut = wait_for(lambda: js(UI).get('card'))
    check('tutorial na instalação nova', tut == 'Como usar a Maratona', tut)
    time.sleep(0.6); d.save_screenshot(os.path.join(OUT, 'ff-tutorial.png'))
    ActionChains(d).send_keys('').perform(); time.sleep(0.5)  # Esc
    check('tutorial fecha no Esc', js(UI).get('card') is None)

    seek(0)
    m = wait_for(lambda: (lambda x: x if x.get('clicks') else None)(js(MOCK)), 15)
    check('pulou a abertura', m and m['clicks'][0]['type'] == 'intro' and m['t'] > 10, m and {'click': m['clicks'][0], 't': m['t']})
    toast = wait_for(lambda: js(UI).get('toast'), 4)
    check('aviso "Abertura pulada"', toast == 'Abertura pulada', toast)
    d.save_screenshot(os.path.join(OUT, 'ff-aviso.png'))

    seek(84)
    m = wait_for(lambda: (lambda x: x if any(c['type'] == 'credits' for c in x.get('clicks', [])) else None)(js(MOCK)), 15)
    check('pulou os créditos', bool(m))
    cd = wait_for(lambda: (lambda t: t if t and 'Próximo episódio em' in t else None)(js(UI).get('toast')), 6)
    check('contagem para o próximo episódio', bool(cd), cd)
    d.save_screenshot(os.path.join(OUT, 'ff-contagem.png'))
    n = wait_for(lambda: (lambda x: x if x.get('nav') else None)(js(MOCK)), 12)
    dt = n and (n['nav'][0]['ts'] - [c for c in n['clicks'] if c['type'] == 'credits'][0]['ts']) / 1000
    check('foi para o EP2 ~5 s depois dos créditos', n and '/EP2/' in n['url'] and 4.5 <= dt <= 7.5, {'dt': dt, 'url': n and n['url']})

    seek(69)
    wait_for(lambda: any(c['ep'] == 'EP2' and c['type'] == 'credits' for c in js(MOCK).get('clicks', [])), 15)
    time.sleep(7.5)
    m = js(MOCK)
    check('cena pós-créditos continua tocando', '/EP2/' in m['url'] and not m['paused'] and m['t'] > 85, {'url': m['url'], 't': m['t']})

    # menu dentro da Crunchyroll (v1.2.0): botão na barra do player e botão laranja preso abaixo do vídeo
    d.get('https://www.crunchyroll.com/pt-br/watch/EP1/episodio'); time.sleep(2.5)
    FAB = ("const f = document.querySelector('maratona-ui').shadowRoot.querySelector('.fab'), r = f.getBoundingClientRect(), "
           "v = document.querySelector('video').getBoundingClientRect(); return { hidden: f.hidden, x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, vb: v.bottom, mode: f.dataset.mode };")
    fb = wait_for(lambda: (lambda x: x if x and not x['hidden'] else None)(js(FAB)), 8)
    check('botão laranja preso abaixo do vídeo', fb and fb['mode'] == 'dock' and fb['top'] >= fb['vb'], fb)
    check('botão na barra do player', js("return !!document.getElementById('maratona-bar-btn')"))
    if fb:
        click(fb['x'], fb['y'])
    menu = wait_for(lambda: js("const m = document.querySelector('maratona-ui').shadowRoot.querySelector('.menu'); return !m.hidden && m.classList.contains('on') ? m.querySelector('.mt b').textContent : null"), 5)
    check('menu abre no Firefox', menu == 'Maratona', menu)
    time.sleep(0.4); d.save_screenshot(os.path.join(OUT, 'ff-menu.png'))

    # Fila com progresso (v1.3.0): no Firefox o pedido à API sai pelo content.fetch (como a própria página)
    d.get('https://www.crunchyroll.com/pt-br/watchlist')
    RINGS = "return [...document.querySelectorAll('maratona-ring')].map((h) => { const b = h.shadowRoot.querySelector('.rg'); return { sid: h.dataset.sid, txt: b.querySelector('.nm').textContent, ld: b.classList.contains('ld') }; });"
    rg = wait_for(lambda: (lambda r: r if r and len(r) == 3 and all(not x['ld'] for x in r) else None)(js(RINGS)), 20)
    check('Fila: rodelinha em cada anime com a % certa', rg and [x['txt'] for x in rg] == ['75%', '100%', '0%'], rg or js(RINGS))
    if rg:
        r1 = js("const b = document.querySelector('maratona-ring[data-sid=\"S1\"]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };")
        click(r1['x'], r1['y'])
        pop = wait_for(lambda: js("const p = document.querySelector('maratona-fila') && document.querySelector('maratona-fila').shadowRoot.querySelector('.pop'); return p && !p.hidden ? p.innerText : null;"), 5)
        check('Fila: clique abre a janela sem sair da página', pop and '18 de 24' in pop and d.current_url.endswith('/watchlist'), pop and pop[:80])
        time.sleep(0.4); d.save_screenshot(os.path.join(OUT, 'ff-fila.png'))

finally:
    d.quit()

res['ok'] = ok
print(json.dumps(res, indent=1, ensure_ascii=False))
with open(os.path.join(OUT, 'resultado.json'), 'w') as fh:
    json.dump(res, fh, indent=1, ensure_ascii=False)
sys.exit(0 if ok else 1)
