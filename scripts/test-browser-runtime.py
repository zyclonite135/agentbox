#!/usr/bin/env python3
"""Exercise the browser proxy adapter against synthetic loopback upstreams."""
import importlib.util
from pathlib import Path
import socket
import socketserver
import threading
import unittest
from unittest.mock import Mock
from urllib.parse import urlsplit

spec=importlib.util.spec_from_file_location('browser',Path(__file__).resolve().parent.parent/'images/browser/browser.py')
browser=importlib.util.module_from_spec(spec)
spec.loader.exec_module(browser)

class RuntimeTest(unittest.TestCase):
    def test_urls(self):
        self.assertEqual(browser.safe_url('https://claude.ai/'),'https://claude.ai/')
        for url in ['file:///etc/passwd','javascript:alert(1)','https://u:p@host','https://host\n','--no-sandbox']:
            with self.assertRaises(ValueError):browser.safe_url(url)

    def test_fullscreen_moves_to_surviving_window(self):
        navigation = browser.Navigation.__new__(browser.Navigation)
        navigation.active = 'popup'
        navigation.restore = (41, 'maximized')
        windows = {42: 'maximized'}

        def chrome(method, params):
            if method == 'Browser.getWindowForTarget':
                return {'windowId': 42, 'bounds': {'windowState': windows[42]}}
            window = params['windowId']
            if window not in windows:
                raise ValueError('Chrome navigation command failed')
            if method == 'Browser.getWindowBounds':
                return {'bounds': {'windowState': windows[window]}}
            self.assertEqual(method, 'Browser.setWindowBounds')
            windows[window] = params['bounds']['windowState']

        navigation.call = chrome
        navigation.fullscreen(True)
        self.assertEqual(windows[42], 'fullscreen')
        navigation.fullscreen(False)
        self.assertEqual(windows[42], 'maximized')
        self.assertIsNone(navigation.restore)

    def test_fullscreen_preserves_existing_chrome_fullscreen(self):
        navigation = browser.Navigation.__new__(browser.Navigation)
        navigation.active = 'tab'
        navigation.restore = None
        navigation.call = Mock(return_value={'windowId': 41, 'bounds': {'windowState': 'fullscreen'}})

        navigation.fullscreen(True)
        navigation.fullscreen(False)

        navigation.call.assert_called_once_with('Browser.getWindowForTarget', {'targetId': 'tab'})
        self.assertIsNone(navigation.restore)

    def test_proxy_http_connect_and_websocket(self):
        captured=[]
        class Upstream(socketserver.StreamRequestHandler):
            def handle(self):
                lines=[]
                while True:
                    line=self.rfile.readline()
                    if line==b'\r\n':break
                    lines.append(line)
                captured.append(b''.join(lines))
                if lines[0].startswith(b'CONNECT'):
                    self.wfile.write(b'HTTP/1.1 200 Connection Established\r\n\r\n')
                else:
                    self.wfile.write(b'HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n')
                self.wfile.flush()
                self.wfile.write(self.rfile.read(4))
        with socketserver.ThreadingTCPServer(('127.0.0.1',0),Upstream) as upstream:
            thread=threading.Thread(target=upstream.serve_forever,daemon=True);thread.start()
            with browser.ProxyServer(('127.0.0.1',0),browser.Proxy) as proxy:
                proxy.upstream=urlsplit('http://user:pass@127.0.0.1:'+str(upstream.server_address[1]))
                worker=threading.Thread(target=proxy.serve_forever,daemon=True);worker.start()
                for line,extra in [(b'CONNECT fixture.invalid:443 HTTP/1.1',b''),
                                   (b'POST http://fixture.invalid/path HTTP/1.1',b'Content-Length: 4\r\n'),
                                   (b'GET http://fixture.invalid/ws HTTP/1.1',b'Upgrade: websocket\r\nConnection: Upgrade\r\n')]:
                    with socket.create_connection(proxy.server_address,timeout=3) as conn:
                        conn.sendall(line+b'\r\nHost: fixture.invalid\r\nProxy-Authorization: Basic bogus\r\n'+extra+b'\r\nTEST')
                        response=b''
                        while not response.endswith(b'TEST'):
                            data=conn.recv(4096)
                            if not data:break
                            response+=data
                        self.assertTrue(response.endswith(b'TEST'),response)
                    self.assertIn(b'Proxy-Authorization: Basic dXNlcjpwYXNz',captured[-1])
                    self.assertNotIn(b'bogus',captured[-1])
                self.assertIn(b'Connection: Upgrade',captured[-1])
                # Missing upstream must return failure, never contact destination.
                proxy.upstream=urlsplit('http://127.0.0.1:1')
                with socket.create_connection(proxy.server_address,timeout=3) as conn:
                    conn.sendall(b'CONNECT fixture.invalid:443 HTTP/1.1\r\n\r\n')
                    self.assertIn(b'502',conn.recv(4096))
                proxy.shutdown();worker.join()
            upstream.shutdown();thread.join()

if __name__=='__main__':unittest.main()
