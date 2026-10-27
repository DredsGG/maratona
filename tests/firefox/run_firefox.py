"""Teste real no Firefox (CI): instala a Maratona como temporária e roda o fluxo principal numa Crunchyroll simulada
(server.mjs): tutorial de instalação nova, pular abertura com o aviso, pular créditos e ir para o próximo episódio
5 s depois e cena pós-créditos respeitada. Uso: python run_firefox.py <pasta-da-extensao> <pasta-de-saida>"""
import json, os, sys, time
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.action_chains import ActionChains

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

finally:
    d.quit()

res['ok'] = ok
print(json.dumps(res, indent=1, ensure_ascii=False))
with open(os.path.join(OUT, 'resultado.json'), 'w') as fh:
    json.dump(res, fh, indent=1, ensure_ascii=False)
sys.exit(0 if ok else 1)
