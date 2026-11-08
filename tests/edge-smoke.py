"""Run an isolated Edge integration test. Requires Python, websockets and cryptography."""
import base64
import hashlib
import json
import os
import secrets
import ssl
import subprocess
import tempfile
import threading
import time
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from websockets.sync.client import connect

ROOT = Path(__file__).resolve().parents[1]
EDGE = Path(os.environ.get("EDGE_BINARY", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"))
GIT_DOC = Path(r"C:\Program Files\Git\mingw64\share\doc\git-doc\git-status.html")
FIXTURE = """<!doctype html><html lang="en"><meta charset="utf-8"><title>Motor control manual</title>
<style>body{font:18px system-ui;margin:32px;max-width:760px}p{margin:18px 0}</style>
<nav><p>Navigation private sentinel</p><a href="#details">Menu index</a></nav><aside><p>Motor sidebar</p></aside><main><article><h1>Control loops</h1>
<p id="first">The current loop controls torque. Read the <a href="#details">drive guide</a>.</p>
<p id="codes">Measure the torque with <code>sampleIq()</code> at 20 kHz.</p>
<pre>CODE_PRIVATE_SENTINEL</pre><math><mi>FORMULA_PRIVATE_SENTINEL</mi></math>
<textarea>INPUT_PRIVATE_SENTINEL</textarea><div contenteditable>EDITOR_PRIVATE_SENTINEL</div>
<div style="height:2600px"></div><p id="far">The encoder reports a distant position.</p></article></main></html>"""


def until(fn, description, timeout=12):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            result = fn()
        except RuntimeError as error:
            if "Cannot find default execution context" not in str(error) and "Execution context was destroyed" not in str(error):
                raise
            result = None
        if result:
            return result
        time.sleep(0.12)
    raise AssertionError("Timed out: " + description)


class DevTools:
    def __init__(self, url):
        self.ws = connect(url, max_size=20_000_000, proxy=None)
        self.seq = 0

    def call(self, method, params=None, session=None):
        self.seq += 1
        request = {"id": self.seq, "method": method, "params": params or {}}
        if session:
            request["sessionId"] = session
        self.ws.send(json.dumps(request))
        while True:
            msg = json.loads(self.ws.recv(timeout=15))
            if msg.get("id") == self.seq:
                if "error" in msg:
                    raise RuntimeError(method + ": " + str(msg["error"]))
                return msg.get("result", {})

    def targets(self):
        return self.call("Target.getTargets")["targetInfos"]

    def tab(self, url):
        target = self.call("Target.createTarget", {"url": url})["targetId"]
        session = self.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
        until(lambda: self.js(session, "location.href") == url, "navigation to " + url)
        return session

    def js(self, session, expression):
        result = self.call("Runtime.evaluate", {"expression": expression, "awaitPromise": True,
                            "userGesture": True, "returnByValue": True}, session)
        if "exceptionDetails" in result:
            raise RuntimeError(result["exceptionDetails"].get("exception", {}).get("description", "JS error"))
        return result["result"].get("value")


class Fixture:
    def __init__(self, stack, temp):
        self.calls = []
        self.fail = False
        self.delay = 0
        self.key = secrets.token_hex(16)
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def send_body(self, data, mime, status=200):
                self.send_response(status)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                if self.path == "/speed":
                    html = '<html lang="en"><title>Example</title><style>body{font:13px sans-serif}p{margin:1px}</style><main>'
                    html += ''.join(f'<p>Example number {i} describes a current loop.</p>' for i in range(12))
                    data = (html + '</main></html>').encode()
                elif self.path == "/git-status.html":
                    data = GIT_DOC.read_bytes()
                else:
                    data = FIXTURE.encode()
                self.send_body(data, "text/html; charset=utf-8")

            def do_POST(self):
                assert self.path == "/v1/chat/completions"
                assert self.headers.get("Authorization") == "Bearer " + owner.key
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                meta, source = body["messages"][-1]["content"].split("\n\n", 1)
                payload = json.loads(meta)
                payload["items"] = payload.pop("paragraphs")
                if len(payload["items"]) == 1:
                    payload["items"][0]["text"] = source
                else:
                    for item, block in zip(payload["items"], source.split("\n\n"), strict=True):
                        tag, item["text"] = block.split("\n", 1)
                        assert tag == "%%" + item["id"] + "%%"
                owner.calls.append(payload)
                if owner.delay:
                    time.sleep(owner.delay)
                if owner.fail:
                    self.send_body(b'{"error":{"code":"rate_limit"}}', "application/json", 429)
                    return
                translations = []
                for item in payload["items"]:
                    text = item["text"].replace("current loop", "电流环").replace("controls torque", "控制转矩")
                    translations.append({"id": item["id"], "text": "测试译文 " + text})
                output = translations[0]["text"] if len(translations) == 1 else "\n\n".join(
                    "%%" + item["id"] + "%%\n" + item["text"] for item in translations)
                output += '\n%%TERMS%%\n[["current loop","电流环"]]'
                data = {"choices": [{"message": {"content": output}, "finish_reason": "stop"}]}
                self.send_body(json.dumps(data).encode(), "application/json")

        def server():
            srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            stack.callback(srv.server_close)
            return srv

        plain, secure = server(), server()
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
        now = datetime.now(timezone.utc)
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
                .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=1))
                .not_valid_after(now+timedelta(days=1)).sign(key, hashes.SHA256()))
        keyfile, certfile = temp/"server.key", temp/"server.pem"
        keyfile.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        certfile.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(certfile, keyfile)
        secure.socket = tls.wrap_socket(secure.socket, server_side=True)
        spki = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        self.spki = base64.b64encode(hashlib.sha256(spki).digest()).decode()
        for srv in (plain, secure):
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            stack.callback(srv.shutdown)
        self.site = "http://127.0.0.1:" + str(plain.server_port)
        self.api = "https://127.0.0.1:" + str(secure.server_port)


def start_browser(stack, temp, fixtures, extension):
    profile = temp/"profile"
    args = [str(EDGE), "--headless=new", "--no-first-run", "--no-default-browser-check",
            "--disable-background-networking", "--disable-sync", "--disable-component-update",
            "--remote-debugging-port=0", "--user-data-dir=" + str(profile), "--window-size=1160,820",
            "--ignore-certificate-errors-spki-list=" + fixtures.spki, "--load-extension=" + str(extension),
            "--disable-features=DisableLoadExtensionCommandLineSwitch", "about:blank"]
    process = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    def stop():
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=8)
    stack.callback(stop)
    portfile = profile/"DevToolsActivePort"
    port = until(lambda: portfile.exists() and portfile.read_text().splitlines()[0], "Edge debugging port")
    with urlopen("http://127.0.0.1:" + port + "/json/version", timeout=4) as response:
        version = json.load(response)
    client = DevTools(version["webSocketDebuggerUrl"])
    stack.callback(client.ws.close)
    def close():
        try:
            client.call("Browser.close")
            process.wait(timeout=8)
        except Exception:
            pass
    stack.callback(close)
    print("Edge", version["Browser"], flush=True)
    manager = client.tab("edge://extensions/")
    expected = json.loads((extension/"manifest.json").read_text(encoding="utf-8"))["name"]
    query = "chrome.developerPrivate.getExtensionsInfo().then(xs=>xs.find(x=>x.name===" + json.dumps(expected) + ")?.id)"
    ext_id = until(lambda: client.js(manager, query), "load installed extension " + expected)
    print("Loaded production extension:", ext_id, flush=True)
    return client, ext_id


def exercise(client, ext_id, fixture):
    base = "chrome-extension://" + ext_id
    options = client.tab(base+"/options.html")
    until(lambda: client.js(options, "!!document.querySelector('#provider option')"), "settings form")
    for origin in (fixture.api, fixture.site):
        assert client.js(options, "chrome.permissions.contains({origins:[" + json.dumps(origin+"/*") + "]})"), "test grant missing: " + origin
    def set_value(id_, value, event="input"):
        client.js(options, f"(()=>{{const e=document.getElementById({json.dumps(id_)});e.value={json.dumps(value)};"
                  f"e.dispatchEvent(new Event({json.dumps(event)},{{bubbles:true}}));}})()")
    set_value("provider", "custom", "change")
    set_value("base-url", fixture.api + "/v1")
    set_value("model", "test-reader")
    set_value("api-key", fixture.key)
    client.js(options, "document.querySelector('#save').click()")
    until(lambda: client.js(options, "chrome.runtime.sendMessage({type:'config.get'}).then(r=>Boolean(r.data?.config))"), "saved configuration")
    client.js(options, "document.querySelector('#test').click()")
    until(lambda: len(fixture.calls) == 1, "test connection through HTTPS")
    page = client.tab(fixture.site+"/article")
    client.js(page, "window.scrollTo(0, 0)")
    time.sleep(0.7)
    assert len(fixture.calls) == 1 and client.js(page, "document.querySelectorAll('[data-eat-translation]').length") == 0
    print("PASS new site idle, settings and HTTPS connection", flush=True)

    # Keep the article in the foreground so the real visibility observer fires;
    # an extension-page tab drives the same messages as the action popup.
    popup = client.tab(base+"/popup.html")
    client.call("Page.bringToFront", {}, page)
    tab_id = client.js(popup, "chrome.tabs.query({}).then(t=>t.find(a=>a.url?.endsWith('/article')).id)")
    def popup_call(type_, **kwargs):
        message = {"type": "popup."+type_, "tabId": tab_id, **kwargs}
        result = client.js(popup, "chrome.runtime.sendMessage(" + json.dumps(message) + ")")
        assert result["ok"], result.get("error")
        return result.get("data")
    def translations():
        return client.js(page, "Array.from(document.querySelectorAll('[data-eat-translation]'),e=>e.shadowRoot?.textContent||e.textContent).join(' ')") or ""
    assert popup_call("status")["mode"] == "original"
    popup_call("mode", mode="bilingual")
    try:
        until(lambda: "电流环" in translations(), "visible translations")
    except AssertionError:
        print("Reader:", popup_call("status"), "requests:", len(fixture.calls), "document:",
              client.js(page, "({href:location.href,visible:document.visibilityState,hosts:document.querySelectorAll('[data-eat-translation]').length})"), flush=True)
        raise
    until(lambda: "sampleIq" in translations(), "protected inline code")
    until(lambda: "Control loops" in translations(), "visible heading")
    assert all("distant position" not in i["text"] for batch in fixture.calls for i in batch["items"])
    assert all("PRIVATE_SENTINEL" not in json.dumps(call) and "Navigation private" not in json.dumps(call) for call in fixture.calls)
    assert client.js(page, "document.querySelector('#first a').getAttribute('href')") == "#details"
    link = client.js(page, """(()=>{document.querySelector('#first > a').addEventListener('click',e=>{
        e.preventDefault();document.getElementById('first').dataset.followed='yes';});
        const a=document.querySelector('#first [data-eat-translation]').shadowRoot.querySelector('a');
        const r=a.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()""")
    for kind in ("mousePressed", "mouseReleased"):
        client.call("Input.dispatchMouseEvent", {"type":kind,"button":"left","clickCount":1,**link}, page)
    assert client.js(page, "document.querySelector('#first').dataset.followed==='yes'")
    count = len(fixture.calls)
    popup_call("mode", mode="translation")
    assert client.js(page, "document.querySelector('#first').hasAttribute('data-eat-source-hidden')")
    popup_call("mode", mode="original")
    assert client.js(page, "document.querySelectorAll('[data-eat-translation]').length") == 0
    assert client.js(page, "getComputedStyle(document.querySelector('#first > a')).display!=='none'")
    popup_call("mode", mode="bilingual")
    until(lambda: "电流环" in translations(), "cached reading mode")
    assert len(fixture.calls) == count, [(b["kind"], [i["text"] for i in b["items"]]) for b in fixture.calls]
    print("PASS visible-first, skip protected text, preserve link, restore and reuse cache", flush=True)
    # Reinitialize the popup UI while the article is the active tab.
    client.call("Page.reload", {}, popup)
    until(lambda: client.js(popup, "document.querySelector('[data-scope=full]')?.disabled === false"), "scope control")
    client.js(popup, "document.querySelector('[data-scope=full]').click()")
    until(lambda: all(s in translations() for s in ("Navigation private sentinel","Menu index","Motor sidebar")), "whole page menus")
    assert all("INPUT_PRIVATE_SENTINEL" not in json.dumps(b) and "EDITOR_PRIVATE_SENTINEL" not in json.dumps(b) for b in fixture.calls)
    until(lambda: client.js(popup, "document.querySelector('[data-scope=main]').disabled === false"), "scope switch ready")
    count = len(fixture.calls)
    client.js(popup, "document.querySelector('[data-scope=main]').click()")
    until(lambda: not client.js(page, "Boolean(document.querySelector('nav [data-eat-translation],aside [data-eat-translation]'))"), "restore main scope")
    assert "电流环" in translations() and len(fixture.calls) == count
    print("PASS popup one-click main/full, preserves body translations and protects inputs", flush=True)
    client.js(page, """const near=document.createElement('p');near.id='just-below';
      near.textContent='Upcoming content near the viewport.';near.style.position='absolute';
      near.style.top=(scrollY+innerHeight+110)+'px';document.querySelector('main').append(near)""")
    until(lambda: client.js(page, "!!document.querySelector('#just-below [data-eat-translation]')"), "near viewport prefetch")
    assert client.js(page, "document.querySelector('#just-below').getBoundingClientRect().top > innerHeight")
    assert not client.js(page, "!!document.querySelector('#far [data-eat-translation]')")
    client.js(page, "document.querySelector('#far').scrollIntoView()")
    until(lambda: any("distant position" in i["text"] for b in fixture.calls for i in b["items"]), "scroll request")
    client.js(page, "document.querySelector('#far').insertAdjacentHTML('afterend','<p id=dynamic>A new motor paragraph is loaded.</p>');document.querySelector('#dynamic').scrollIntoView()")
    until(lambda: any("A new motor" in i["text"] for b in fixture.calls for i in b["items"]), "dynamic request")
    print("PASS scroll and dynamic article", flush=True)

    popup_call("auto", enabled=True)
    before_reload = client.js(page, "history.scrollRestoration='manual';window.scrollTo(0,0);performance.timeOrigin")
    client.call("Page.reload", {}, page)
    until(lambda: client.js(page, "performance.timeOrigin") != before_reload and
          client.js(page, "!!document.getElementById('first')"), "reloaded article")
    client.js(page, "document.getElementById('first').scrollIntoView({block:'center'})")
    until(lambda: "电流环" in translations(), "automatic translation after reload")
    popup_call("mode", mode="original")
    client.js(page, "(()=>{const node=document.querySelector('#first').firstChild;const r=new Range();r.setStart(node,4);r.setEnd(node,16);getSelection().removeAllRanges();getSelection().addRange(r)})()")
    client.js(popup, f"chrome.tabs.sendMessage({tab_id},{{type:'reader.selection',text:'current loop'}})")
    selection = until(lambda: next((b for b in fixture.calls if b["kind"] == "selection"), None), "selection with context")
    assert selection["items"][0]["text"] == "current loop" and "controls torque" in selection["items"][0]["after"]
    until(lambda: client.js(page, "document.querySelector('[data-eat-card]')?.shadowRoot.textContent.includes('测试译文 电流环')"), "selection result")
    hover_coords = client.js(page, """(()=>{const hover=document.createElement('p');hover.textContent='Hover over this special paragraph.';
        document.querySelector('#first').after(hover);hover.scrollIntoView({block:'center'});const r=hover.getBoundingClientRect();
        hover.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,altKey:true}));
        return {x:r.x+Math.min(r.width/2,35),y:r.y+r.height/2};})()""")
    time.sleep(0.5)
    assert not any("Hover over this" in i["text"] for b in fixture.calls for i in b["items"]), "synthetic Alt hover incurred a request"
    client.call("Input.dispatchMouseEvent", {"type":"mouseMoved", "modifiers":1, **hover_coords}, page)
    until(lambda: any("Hover over this" in i["text"] for b in fixture.calls for i in b["items"]), "Alt hover")
    print("PASS site auto reload, selection and Alt hover", flush=True)
    fixture.fail = True
    popup_call("mode", mode="bilingual")
    client.js(page, "document.querySelector('#first').insertAdjacentHTML('afterend','<p>Rate limited request from the fixture.</p>')")
    paused = until(lambda: (info if (info := popup_call("status")).get("paused") else None), "visible rate limit")
    assert "429" in paused["error"]
    count = len(fixture.calls)
    time.sleep(1)
    assert len(fixture.calls) == count
    fixture.fail = False
    popup_call("retry")
    until(lambda: "Rate limited" in translations(), "explicit retry")
    print("PASS rate limit pauses, manual retry recovers", flush=True)
    if GIT_DOC.exists():
        doc = client.tab(fixture.site + "/git-status.html")
        until(lambda: client.js(doc, "document.querySelectorAll('[data-eat-translation]').length"), "Git manual")
        print("PASS installed Git English technical manual", flush=True)
    second = client.tab(fixture.site + "/another-article")
    until(lambda: client.js(second, "Boolean(document.querySelector('#first [data-eat-translation]'))"), "second automatic tab")
    client.call("Page.bringToFront", {}, page)
    popup_call("auto", enabled=False)
    count = len(fixture.calls)
    for active in (page, second):
        client.call("Page.bringToFront", {}, active)
        client.js(active, "document.querySelector('#first').insertAdjacentHTML('beforebegin','<p id=revoked>This must stay private after disabling.</p>');document.querySelector('#revoked').scrollIntoView()")
        time.sleep(0.5)
        assert not client.js(active, "Boolean(document.querySelector('#revoked [data-eat-translation]'))")
    assert len(fixture.calls) == count, "an open tab sent new text after disabling the site's rule"
    client.call("Page.reload", {}, page)
    time.sleep(0.8)
    assert len(fixture.calls) == count
    assert not client.js(page, "Boolean(document.querySelector('[data-eat-translation]'))")
    print("PASS disabling site stops future requests", flush=True)

    assert client.js(options, "chrome.commands.getAll().then(cs=>cs.find(c=>c.name==='translate-full-page')?.shortcut)") == "Alt+A"
    assert not client.js(options, "chrome.permissions.contains({origins:[" + json.dumps(fixture.site+"/*") + "]})")
    hotkey_page = client.tab(fixture.site + "/shortcut")
    client.call("Page.bringToFront", {}, hotkey_page)
    def press_alt_a():
        for kind, key, code, vk, modifiers in [
            ("rawKeyDown","Alt","AltLeft",18,1), ("rawKeyDown","a","KeyA",65,1),
            ("keyUp","a","KeyA",65,1), ("keyUp","Alt","AltLeft",18,0)
        ]:
            client.call("Input.dispatchKeyEvent", {"type":kind, "key":key, "code":code, "modifiers":modifiers,
                        "windowsVirtualKeyCode":vk, "nativeVirtualKeyCode":vk, "isSystemKey":True}, hotkey_page)
    press_alt_a()
    until(lambda: client.js(hotkey_page, "['nav p','aside p','#first','#codes','h1','nav a'].every(s=>document.querySelector(s+' [data-eat-translation]'))"),
          "Alt+A translates article and navigation on a site without a standing grant")
    count = len(fixture.calls)
    press_alt_a()
    time.sleep(.3)
    assert len(fixture.calls) == count and client.js(hotkey_page, "!!document.querySelector('nav [data-eat-translation]')")
    print("PASS Edge Alt+A starts full scope on a fresh tab; repeating reuses translations", flush=True)

    # The same fixture and fixed one-second response delay used to time v1.0.
    # Grant test-site access for sending the real popup messages headlessly.
    manager = client.tab("edge://extensions/")
    client.js(manager, "chrome.developerPrivate.addHostPermission(" + json.dumps(ext_id) + "," + json.dumps(fixture.site+"/*") + ")")
    assert client.js(popup, "chrome.permissions.request({origins:[" + json.dumps(fixture.site+"/*") + "]})")
    page = client.tab(fixture.site + "/speed")
    tab_id = client.js(popup, "chrome.tabs.query({}).then(t=>t.find(x=>x.url?.endsWith('/speed')).id)")
    fixture.delay = 1
    def timed_translation(label):
        start, count = time.perf_counter(), len(fixture.calls)
        popup_call("mode", mode="bilingual")
        marks = {}
        while time.perf_counter() - start < 12:
            n = client.js(page, "document.querySelectorAll('[data-eat-translation]').length")
            if n:
                marks.setdefault(n, time.perf_counter() - start)
            if n == 12:
                break
            time.sleep(.015)
        assert 12 in marks, marks
        delta = len(fixture.calls) - count
        print(f"BENCH {label}: first={min(marks.values()):.2f}s all={marks[12]:.2f}s calls={delta}", flush=True)
        return delta
    assert timed_translation("cold") == 3
    batches = fixture.calls[-3:]
    assert sorted(len(b["items"]) for b in batches) == [1, 5, 6]
    assert len({i["text"] for b in batches for i in b["items"]}) == 12
    popup_call("mode", mode="original")
    assert timed_translation("same-page") == 0
    def reload_speed():
        old = client.js(page, "performance.timeOrigin")
        client.call("Page.reload", {}, page)
        until(lambda: client.js(page, "performance.timeOrigin") != old and client.js(page, "document.querySelectorAll('main p').length") == 12, "speed reload")
    reload_speed()
    assert timed_translation("reload") == 0
    # Clearing the setting must actually remove the cross-refresh entries.
    client.js(options, "document.querySelector('#clear-cache').click()")
    until(lambda: client.js(options, "document.querySelector('#config-notice').textContent.includes('缓存已清除')"), "cache clear")
    reload_speed()
    assert timed_translation("after clear") == 3
    fixture.delay = 0


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="duanyi-edge-test-", ignore_cleanup_errors=True) as tmp, ExitStack() as stack:
        temp = Path(tmp)
        fixtures = Fixture(stack, temp)
        origins = [origin + "/*" for origin in (fixtures.api, fixtures.site)]
        client, ext_id = start_browser(stack, temp, fixtures, ROOT)
        manager = client.tab("edge://extensions/")
        options = client.tab("chrome-extension://" + ext_id + "/options.html")
        # Pre-authorize these test origins via Edge's real manager in the temporary profile,
        # then exercise the real optional permission APIs. The native prompt itself is not clicked.
        for origin in origins:
            client.js(manager, "chrome.developerPrivate.addHostPermission(" + json.dumps(ext_id) + "," + json.dumps(origin) + ")")
            grant = json.dumps({"origins":[origin]})
            approved = client.js(options, "chrome.permissions.request(" + grant + ")")
            assert approved and client.js(options, "chrome.permissions.contains(" + grant + ")")
        exercise(client, ext_id, fixtures)
