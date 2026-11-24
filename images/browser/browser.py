#!/usr/bin/env python3
"""Workspace desktop. Chrome navigation uses a private pipe, never a debug port.
Control and VNC relay run as the workspace UID; that UID is the trust boundary.
"""
import base64
import fcntl
import json
import os
from pathlib import Path
import select
import signal
import socket
import socketserver
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit, unquote

RUNTIME = Path('/tmp/agentbox-browser-' + str(os.getuid()))
CONTROL = str(RUNTIME / 'control.sock')
PROFILE = Path.home() / '.agentbox-browser'
VNC_PORT = 5909
PROXY_PORT = 18089
MAX_REQUEST = 300000


def request(value, timeout=3):
    with socket.socket(socket.AF_UNIX) as s:
        s.settimeout(timeout)
        s.connect(CONTROL)
        s.sendall(json.dumps(value).encode() + b'\n')
        with s.makefile('rb') as f:
            return json.loads(f.readline(MAX_REQUEST))


def safe_url(value):
    if not isinstance(value, str) or len(value) > 8192 or any(ord(c) < 32 for c in value):
        raise ValueError('地址格式无效')
    p = urlsplit(value)
    if p.scheme not in ('http', 'https') or not p.hostname or p.username or p.password:
        raise ValueError('仅支持不含用户名密码的 HTTP / HTTPS 地址')
    return value


class Navigation:
    def __init__(self, launch, command):
        chrome_input, self.output = os.pipe()
        self.input, chrome_output = os.pipe()
        self.buffer = bytearray()
        self.request_id = 0
        self.sessions = {}
        self.active = ''
        self.restore = None
        os.set_blocking(self.output, False)
        try:
            self.process = launch([sys.executable, '-I', __file__, 'chrome-pipe', str(chrome_input), str(chrome_output),
                                   *command, '--remote-debugging-pipe', 'about:blank'], pass_fds=(chrome_input, chrome_output))
        except Exception:
            self.close()
            raise
        finally:
            os.close(chrome_input)
            os.close(chrome_output)

    def close(self):
        os.close(self.input)
        os.close(self.output)

    def call(self, method, params=None, session=None):
        self.request_id += 1
        message = {'id': self.request_id, 'method': method, 'params': params or {}}
        if session:
            message['sessionId'] = session
        deadline = time.monotonic() + 2
        payload = memoryview(json.dumps(message).encode() + b'\0')
        while payload:
            if not select.select([], [self.output], [], max(0, deadline - time.monotonic()))[1]:
                raise TimeoutError('Chrome navigation pipe unavailable')
            payload = payload[os.write(self.output, payload):]
        while time.monotonic() < deadline:
            end = self.buffer.find(0)
            if end >= 0:
                reply = json.loads(self.buffer[:end])
                del self.buffer[:end + 1]
                if reply.get('id') == self.request_id:
                    if 'error' in reply:
                        raise ValueError('Chrome navigation command failed')
                    return reply.get('result', {})
                if reply.get('method') == 'Target.detachedFromTarget':
                    expired = reply['params']['sessionId']
                    self.sessions = {tab: session for tab, session in self.sessions.items() if session != expired}
                continue
            if not select.select([self.input], [], [], max(0, deadline - time.monotonic()))[0]:
                break
            chunk = os.read(self.input, 65536)
            if not chunk or len(self.buffer) + len(chunk) > MAX_REQUEST * 4:
                break
            self.buffer.extend(chunk)
        raise TimeoutError('Chrome navigation response unavailable')

    def tabs(self):
        tabs = [t for t in self.call('Target.getTargets')['targetInfos'] if t['type'] == 'page' and not t.get('subtype')]
        self.sessions = {t['targetId']: self.sessions[t['targetId']] for t in tabs if t['targetId'] in self.sessions}
        return tabs

    def session(self, tab):
        if tab not in self.sessions:
            self.sessions[tab] = self.call('Target.attachToTarget', {'targetId': tab, 'flatten': True})['sessionId']
        return self.sessions[tab]

    def selected(self, tabs):
        visible = []
        for tab in tabs:
            target = tab['targetId']
            try:
                attention = self.call('Runtime.evaluate', {'expression':
                    'document.hasFocus() ? 2 : document.visibilityState === "visible" ? 1 : 0',
                    'returnByValue': True}, self.session(target))['result'].get('value')
            except ValueError:
                self.sessions.pop(target, None)
                continue  # A tab can close or change processes while scanning.
            if attention == 2:
                return target
            if attention == 1:
                visible.append(target)
        candidates = visible or [tab['targetId'] for tab in tabs]
        return self.active if self.active in candidates else next(iter(candidates), '')

    def page(self, method, params=None):
        return self.call('Page.' + method, params, self.session(self.active))

    def fullscreen(self, enabled):
        if not enabled:
            if not self.restore:
                return
            window, previous = self.restore
            if previous == 'fullscreen':
                self.restore = None
                return
            try:
                self.call('Browser.getWindowBounds', {'windowId': window})
            except ValueError:
                # The original window can close while another window stays open.
                self.restore = None
                return
            self.call('Browser.setWindowBounds', {'windowId': window, 'bounds': {'windowState': 'normal'}})
            if previous != 'normal':
                self.call('Browser.setWindowBounds', {'windowId': window, 'bounds': {'windowState': previous}})
            self.restore = None
            return
        bounds = self.call('Browser.getWindowForTarget', {'targetId': self.active})
        window = bounds['windowId']
        if self.restore and self.restore[0] == window:
            return
        self.fullscreen(False)
        previous = bounds['bounds'].get('windowState', 'normal')
        if previous != 'fullscreen':
            self.call('Browser.setWindowBounds', {'windowId': window, 'bounds': {'windowState': 'fullscreen'}})
        self.restore = (window, previous)

    def handle(self, data):
        action = data['operation']
        tabs = self.tabs()
        self.active = self.selected(tabs)
        if action == 'fullscreen':
            self.fullscreen(data['enabled'])
        elif action == 'new':
            url = safe_url(data['url']) if data.get('url') else 'about:blank'
            self.active = self.call('Target.createTarget', {'url': url})['targetId']
            self.call('Target.activateTarget', {'targetId': self.active})
        elif action == 'select':
            target = data['tab']
            if target not in {tab['targetId'] for tab in tabs}:
                raise ValueError('Tab no longer exists')
            self.call('Target.activateTarget', {'targetId': target})
            self.active = target
        elif action == 'close':
            target = data['tab']
            if len(tabs) > 1 and target in {tab['targetId'] for tab in tabs}:
                self.call('Target.closeTarget', {'targetId': target})
        elif action != 'state' and self.active:
            if action in ('back', 'forward'):
                history = self.page('getNavigationHistory')
                index = history['currentIndex'] + (-1 if action == 'back' else 1)
                if 0 <= index < len(history['entries']):
                    self.page('navigateToHistoryEntry', {'entryId': history['entries'][index]['id']})
            elif action == 'reload':
                self.page('reload')
            elif action == 'navigate':
                self.page('navigate', {'url': safe_url(data['url'])})
        tabs = self.tabs()
        if self.active not in {tab['targetId'] for tab in tabs}:
            self.active = self.selected(tabs)
        if self.restore and self.active and action in ('new', 'select', 'close'):
            self.fullscreen(True)
        history = {'entries': [], 'currentIndex': 0}
        if self.active:
            try:
                history = self.page('getNavigationHistory')
            except ValueError:
                # Chrome may replace its page target between receiving and
                # committing navigation. The next status poll reads the new page.
                self.sessions.pop(self.active, None)
        return {'active': self.active, 'fullscreen': bool(self.restore),
                'tabs': [{'id': tab['targetId'], 'title': tab['title'][:300], 'url': tab['url'][:8192]} for tab in tabs],
                'back': history['currentIndex'] > 0,
                'forward': history['currentIndex'] < len(history['entries']) - 1}


def chrome_pipe():
    endpoints = [int(value) for value in sys.argv[2:4]]
    copies = [fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 5) for fd in endpoints]
    for fd in endpoints:
        os.close(fd)
    for source, target in zip(copies, (3, 4)):
        os.dup2(source, target)
        os.close(source)
    os.execv(sys.argv[4], sys.argv[4:])


def pump(a, b):
    # A bounded idle timeout also collects abandoned CONNECT requests.
    while True:
        ready, _, _ = select.select([a, b], [], [], 90)
        if not ready:
            return
        for source in ready:
            data = source.recv(65536)
            if not data:
                return
            (b if source is a else a).sendall(data)


class Proxy(socketserver.StreamRequestHandler):
    """Local adapter: Chrome cannot put Basic proxy credentials in --proxy-server.
    Forward through the configured bridge only; never retry directly.
    """
    def handle(self):
        self.connection.settimeout(30)
        try:
            first = self.rfile.readline(MAX_REQUEST)
            if not first.endswith(b'\r\n'):
                return
            headers, size = [], len(first)
            upgrade = False
            while True:
                line = self.rfile.readline(MAX_REQUEST)
                size += len(line)
                if size > MAX_REQUEST or not line.endswith(b'\r\n'):
                    return
                if line == b'\r\n':
                    break
                if line.split(b':', 1)[0].lower() == b'upgrade':
                    upgrade = True
                if line.split(b':', 1)[0].lower() not in (b'proxy-authorization', b'proxy-connection', b'connection'):
                    headers.append(line)
            upstream = self.server.upstream
            with socket.create_connection((upstream.hostname, upstream.port or 80), timeout=20) as out:
                auth = base64.b64encode((unquote(upstream.username or '') + ':' + unquote(upstream.password or '')).encode())
                out.sendall(first + b''.join(headers) + b'Proxy-Authorization: Basic ' + auth +
                            (b'\r\nConnection: Upgrade\r\n\r\n' if upgrade else b'\r\nConnection: close\r\n\r\n'))
                # Unbuffered rfile prevents consuming pipelined tunnel/body bytes.
                pump(self.connection, out)
        except (OSError, ValueError):
            try:
                self.connection.sendall(b'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
            except OSError:
                pass

    rbufsize = 0


class ProxyServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def browser_proxy_flags():
    # Chrome applies resolver rules to the proxy address too, even when it is
    # an IPv4 literal. Keep the loopback adapter resolvable while blocking
    # local resolution of destination names (the upstream proxy resolves them).
    return ['--proxy-server=http://127.0.0.1:' + str(PROXY_PORT),
            '--proxy-bypass-list=<-loopback>',
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']


def serve():
    os.umask(0o077)
    PROFILE.mkdir(mode=0o700, parents=True, exist_ok=True)
    download = Path('/workspace/Downloads')
    download.mkdir(exist_ok=True)
    # Chrome uses XDG's download directory on first launch; subsequent user
    # preferences belong to Chrome and are deliberately left alone.
    config = PROFILE / 'xdg'
    config.mkdir(exist_ok=True)
    (config / 'user-dirs.dirs').write_text('XDG_DOWNLOAD_DIR="/workspace/Downloads"\n')
    env = {**os.environ, 'XDG_CONFIG_HOME': str(config)}
    children = []
    chrome = None
    navigation = None
    proxy = None
    control = socket.socket(socket.AF_UNIX)
    stopping = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopping.set())
    signal.signal(signal.SIGINT, lambda *_: stopping.set())
    def launch(argv, **kwargs):
        p = subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True, **kwargs)
        children.append(p)
        return p
    try:
        # Allocate an unused X display, avoiding stale :99 locks after a crash.
        readfd, writefd = os.pipe()
        with os.fdopen(readfd, 'rb') as display:
            try:
                # Xvnc can resize the X screen itself on a VNC client's request.
                # Clipboard traffic still uses the explicit UTF-8 control API.
                vnc = launch(['Xtigervnc', '-displayfd', str(writefd), '-geometry', '1440x900',
                              '-depth', '24', '-nolisten', 'tcp', '-rfbport', str(VNC_PORT),
                              '-localhost', '-SecurityTypes', 'None', '-AlwaysShared',
                              '-AcceptSetDesktopSize=1', '-AcceptCutText=0', '-SendCutText=0'],
                             pass_fds=(writefd,))
            finally:
                os.close(writefd)
            if not select.select([display], [], [], 10)[0]:
                raise RuntimeError('显示服务启动超时')
            number = display.readline(16).decode().strip()
        if not number.isdigit():
            raise RuntimeError('显示服务启动失败')
        env['DISPLAY'] = ':' + number
        launch(['openbox'])
        flags = ['--user-data-dir=' + str(PROFILE / 'profile'), '--no-first-run',
                 '--no-default-browser-check', '--restore-last-session',
                 '--disable-session-crashed-bubble', '--password-store=basic',
                 '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
                 '--start-maximized']
        upstream = os.environ.get('AGENTBOX_BROWSER_PROXY', '')
        if upstream:
            parsed = urlsplit(upstream)
            if parsed.scheme != 'http' or not parsed.hostname:
                raise RuntimeError('浏览器代理配置无效')
            proxy = ProxyServer(('127.0.0.1', PROXY_PORT), Proxy)
            proxy.upstream = parsed
            threading.Thread(target=proxy.serve_forever, daemon=True).start()
            flags += browser_proxy_flags()
        # No browser instance exists here (start is serialized). Chrome's old
        # hostname/PID lock may survive container recreation; only remove those
        # three singleton markers, never profile contents.
        for name in ('SingletonLock', 'SingletonSocket', 'SingletonCookie'):
            (PROFILE / 'profile' / name).unlink(missing_ok=True)
        command = ['/usr/local/bin/agentbox-browser', *flags]
        navigation = Navigation(launch, command)
        chrome = navigation.process
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if chrome.poll() is not None or vnc.poll() is not None:
                raise RuntimeError('浏览器启动失败，请检查镜像及用户命名空间沙箱支持')
            try:
                with socket.create_connection(('127.0.0.1', VNC_PORT), timeout=3) as test:
                    if test.recv(12).startswith(b'RFB '):
                        break
            except OSError:
                pass
            time.sleep(.1)
        else:
            raise RuntimeError('远程桌面启动超时')
        CONTROL_PATH = Path(CONTROL)
        CONTROL_PATH.unlink(missing_ok=True)
        control.bind(CONTROL)
        control.listen(8)
        control.settimeout(.5)
        browser = 'Chromium' if os.uname().machine in ('aarch64', 'arm64') else 'Google Chrome'
        info = {'running': True, 'browser': browser, 'proxy': bool(upstream), 'navigation': True,
                'network_key': os.environ.get('AGENTBOX_BROWSER_NETWORK_KEY', '')}
        while not stopping.is_set() and all(p.poll() is None for p in children):
            try:
                conn, _ = control.accept()
            except socket.timeout:
                continue
            with conn:
                conn.settimeout(3)
                try:
                    with conn.makefile('rb') as f:
                        data = json.loads(f.readline(MAX_REQUEST))
                    response = info
                    if data['action'] == 'clipboard':
                        if data.get('write'):
                            text = data.get('text', '')
                            if not isinstance(text, str) or len(text.encode()) > 65536:
                                raise ValueError('剪贴板内容过长')
                            subprocess.run(['xclip', '-selection', 'clipboard', '-in'],
                                           input=text.encode(), env=env, stdout=subprocess.DEVNULL,
                                           stderr=subprocess.DEVNULL, timeout=3, check=True)
                            response = {'text': text}
                        else:
                            proc = subprocess.Popen(['xclip', '-selection', 'clipboard', '-out'],
                                                    env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                            timer = threading.Timer(3, proc.kill)
                            timer.start()
                            try:
                                raw = proc.stdout.read(65537)
                                proc.kill()
                                proc.wait()
                                if len(raw) > 65536:
                                    raise ValueError('剪贴板内容过长')
                                response = {'text': raw.decode('utf-8', errors='replace')}
                            finally:
                                timer.cancel()
                                proc.stdout.close()
                    elif data['action'] == 'stop':
                        stopping.set()
                    elif data['action'] == 'navigation':
                        response = navigation.handle(data)
                    elif data['action'] == 'open':
                        url = safe_url(data['url'])
                        # Chrome hands the URL to the existing instance and exits.
                        p = subprocess.run([*command, '--new-tab', url], env=env,
                                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                           stderr=subprocess.DEVNULL, timeout=5)
                        if p.returncode:
                            raise RuntimeError('打开网页失败')
                    elif data['action'] != 'status':
                        raise ValueError('未知操作')
                    conn.sendall(json.dumps(response).encode() + b'\n')
                except (ValueError, KeyError, RuntimeError, OSError, subprocess.SubprocessError):
                    conn.sendall(b'{"error":"Browser command failed"}\n')
    except Exception as exc:
        (RUNTIME / 'error').write_text(str(exc))
    finally:
        control.close()
        # Close Chrome windows through the window manager before terminating X
        # or the browser's network process: killing the entire process group
        # immediately can discard recently written cookies.
        if chrome is not None and chrome.poll() is None:
            try:
                windows = subprocess.run(['wmctrl', '-lp'], env=env, capture_output=True,
                                         text=True, timeout=3, check=True).stdout
                for line in windows.splitlines():
                    columns = line.split(None, 4)
                    if len(columns) >= 3 and columns[2] == str(chrome.pid):
                        subprocess.run(['wmctrl', '-ic', columns[0]], env=env,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
                chrome.wait(timeout=8)
            except (OSError, subprocess.SubprocessError):
                if chrome.poll() is None:
                    chrome.terminate()
                    try:
                        chrome.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        pass
        for p in reversed(children):
            if p.poll() is None:
                try:
                    os.killpg(p.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        for p in children:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGKILL)
                p.wait()
        if navigation:
            navigation.close()
        if proxy:
            proxy.shutdown()
            proxy.server_close()
        Path(CONTROL).unlink(missing_ok=True)


def main():
    action = sys.argv[1]
    if action == 'chrome-pipe':
        chrome_pipe()
        return
    if action == 'relay':
        # Raw RFB on Docker's attached stdin/stdout, no public VNC listener.
        with socket.create_connection(('127.0.0.1', VNC_PORT), timeout=10) as sock:
            sock.settimeout(None)
            while True:
                ready, _, _ = select.select([sock, sys.stdin.buffer], [], [], 90)
                if not ready:
                    continue
                if sock in ready:
                    data = sock.recv(65536)
                    if not data:
                        return
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                if sys.stdin.buffer in ready:
                    data = os.read(0, 65536)
                    if not data:
                        return
                    sock.sendall(data)
        return
    RUNTIME.mkdir(mode=0o700, exist_ok=True)
    if action == 'serve':
        serve()
        return
    data = json.load(sys.stdin)
    with (RUNTIME / 'lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            info = request({'action': 'status'})
        except (OSError, ValueError):
            info = {'running': False}
        if action == 'clipboard':
            if not info['running']:
                raise RuntimeError('浏览器未运行')
            data['action'] = 'clipboard'
            print(json.dumps(request(data, timeout=8), ensure_ascii=False))
            return
        if action == 'navigation':
            if not info['running'] or not info.get('navigation'):
                raise RuntimeError('浏览器未运行')
            data['action'] = 'navigation'
            print(json.dumps(request(data, timeout=8), ensure_ascii=False))
            return
        if action == 'status':
            print(json.dumps(info))
            return
        if action == 'stop':
            if info['running']:
                request({'action': 'stop'})
                for _ in range(200):
                    if not Path(CONTROL).exists():
                        break
                    time.sleep(.1)
                else:
                    raise RuntimeError('浏览器尚未完全停止，请稍后重试')
            print('{"running":false}')
            return
        if action != 'start':
            raise ValueError('未知操作')
        url = safe_url(data['url']) if data.get('url') else ''
        key = os.environ.get('AGENTBOX_BROWSER_NETWORK_KEY', '')
        if info['running'] and info.get('network_key') != key:
            request({'action': 'stop'})
            for _ in range(150):
                if not Path(CONTROL).exists():
                    break
                time.sleep(.1)
            else:
                raise RuntimeError('浏览器网络切换超时，请停止工作空间后重试')
            info = {'running': False}
        if not info['running']:
            (RUNTIME / 'error').unlink(missing_ok=True)
            # Only the browser proxy is passed in, never model/API credentials.
            subprocess.Popen([sys.executable, '-I', __file__, 'serve'], env=os.environ,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
            for _ in range(250):
                if (RUNTIME / 'error').exists():
                    raise RuntimeError((RUNTIME / 'error').read_text())
                try:
                    info = request({'action': 'status'})
                    break
                except (OSError, ValueError):
                    time.sleep(.1)
            else:
                raise RuntimeError('浏览器启动超时')
        if url:
            result = request({'action': 'open', 'url': url}, timeout=8)
            if result.get('error'):
                raise RuntimeError('打开网页失败')
        print(json.dumps(info))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
        sys.exit(1)
