#!/usr/bin/env python3
"""
RetroPlayer dev server.

- Serves static files (index.html, css, js)
- Provides /proxy?url=<encoded> endpoint that fetches a remote URL and
  re-streams it with restrictive headers (CORP, COEP, CSP) stripped.
- Provides a small REST API for saved playlists (LAN-shared library):
    GET    /api/playlists           → list (no tracks)
    GET    /api/playlists/<id>      → full playlist with tracks
    POST   /api/playlists           → save (body: {name, tracks})
    DELETE /api/playlists/<id>      → remove
    Storage: JSON files in ./playlists/ next to this script.

Usage:  python server.py [--port 8765] [--host 0.0.0.0]

Default --host is 0.0.0.0 so other devices on the same WiFi can access
the player at http://<your-lan-ip>:8765/.
"""

from __future__ import annotations

import argparse
import http.server
import json
import os
import re
import socket
import socketserver
import ssl
import sys
import time
import urllib.parse
import urllib.request
import http.cookiejar
import uuid
from pathlib import Path

DEFAULT_PORT = 8765
DEFAULT_HOST = '0.0.0.0'
DIRECTORY = Path(os.path.dirname(os.path.abspath(__file__)))
PLAYLISTS_DIR = DIRECTORY / 'playlists'
PLAYLISTS_DIR.mkdir(exist_ok=True)
LOGS_DIR = DIRECTORY / 'logs'
LOGS_DIR.mkdir(exist_ok=True)
LOG_FILE = LOGS_DIR / 'server.log'

# ===================== Logger =====================

import logging

_logger = logging.getLogger('retroplayer')
_logger.setLevel(logging.DEBUG)

# File handler — persistent log
_fh = logging.FileHandler(str(LOG_FILE), encoding='utf-8')
_fh.setLevel(logging.DEBUG)
_fh.setFormatter(logging.Formatter(
    '[%(asctime)s] [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
))
_logger.addHandler(_fh)

# Console handler
_ch = logging.StreamHandler(sys.stderr)
_ch.setLevel(logging.INFO)
_ch.setFormatter(logging.Formatter(
    '[%(asctime)s] [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
))
_logger.addHandler(_ch)

log = _logger

# Headers from upstream we DO NOT forward through the proxy.
BLOCKED_RESPONSE_HEADERS = {
    'cross-origin-resource-policy',
    'cross-origin-embedder-policy',
    'cross-origin-opener-policy',
    'content-security-policy',
    'x-content-security-policy',
    'x-frame-options',
    'access-control-allow-origin',
    'access-control-allow-headers',
    'access-control-allow-credentials',
    'access-control-expose-headers',
    'access-control-allow-methods',
    'transfer-encoding',
    'connection',
    'content-encoding',
}

API_PLAYLIST_RE = re.compile(r'^/api/playlists(?:/([^/?#]+))?/?$')

# Shared cookie-enabled opener for proxy requests.
# Google Drive (and similar) requires cookies for redirects & download tokens.
_cookie_jar = http.cookiejar.CookieJar()
_ssl_ctx = ssl.create_default_context()
_url_opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(_cookie_jar),
    urllib.request.HTTPSHandler(context=_ssl_ctx),
)

PROXY_UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/125.0.0.0 Safari/537.36'
)


# ===================== Playlist storage =====================

def _playlist_path(pid: str) -> Path:
    # Defensive: keep id alphanum/dash only
    safe = re.sub(r'[^a-zA-Z0-9_-]', '', pid)
    if not safe:
        raise ValueError('invalid id')
    return PLAYLISTS_DIR / f'{safe}.json'


def list_playlists() -> list[dict]:
    items = []
    for p in PLAYLISTS_DIR.glob('*.json'):
        try:
            data = json.loads(p.read_text(encoding='utf-8'))
            items.append({
                'id': data.get('id', p.stem),
                'name': data.get('name', 'Untitled'),
                'trackCount': len(data.get('tracks', []) or []),
                'importedAt': data.get('importedAt', 0),
            })
        except Exception as e:
            log.warning(f'skip corrupt playlist {p.name}: {e}')
    items.sort(key=lambda x: x.get('importedAt') or 0, reverse=True)
    return items


def get_playlist(pid: str) -> dict | None:
    try:
        path = _playlist_path(pid)
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return None


def save_playlist(name: str, tracks: list[dict]) -> dict:
    pid = uuid.uuid4().hex[:12]
    payload = {
        'id': pid,
        'name': (name or 'Untitled').strip()[:200] or 'Untitled',
        'tracks': tracks or [],
        'importedAt': int(time.time() * 1000),
    }
    _playlist_path(pid).write_text(
        json.dumps(payload, ensure_ascii=False), encoding='utf-8'
    )
    return payload


def delete_playlist(pid: str) -> bool:
    try:
        path = _playlist_path(pid)
        if path.exists():
            path.unlink()
            return True
    except Exception:
        pass
    return False


# ===================== HTTP handler =====================

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIRECTORY), **kwargs)

    # -------- Routing --------

    def do_GET(self):
        if self.path.startswith('/proxy?') or self.path.startswith('/proxy/?'):
            self._handle_proxy(head_only=False)
            return
        if self.path.startswith('/api/playlists'):
            self._handle_api_get()
            return
        super().do_GET()

    def do_HEAD(self):
        if self.path.startswith('/proxy?') or self.path.startswith('/proxy/?'):
            self._handle_proxy(head_only=True)
            return
        super().do_HEAD()

    def do_POST(self):
        if self.path.startswith('/api/playlists'):
            self._handle_api_post()
            return
        self.send_error(404)

    def do_DELETE(self):
        if self.path.startswith('/api/playlists'):
            self._handle_api_delete()
            return
        self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, HEAD, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    # -------- Helpers --------

    def _cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')

    def _send_json(self, status: int, body):
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self._cors_headers()
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def _read_json_body(self) -> dict | None:
        try:
            length = int(self.headers.get('Content-Length', '0') or 0)
            if length <= 0 or length > 50 * 1024 * 1024:
                return None
            raw = self.rfile.read(length)
            return json.loads(raw.decode('utf-8'))
        except Exception:
            return None

    def _parse_api_path(self) -> tuple[bool, str | None]:
        """Return (is_api_playlists, id_or_None). False if path is malformed."""
        path = urllib.parse.urlparse(self.path).path
        m = API_PLAYLIST_RE.match(path)
        if not m:
            return False, None
        return True, m.group(1)

    # -------- API: GET --------

    def _handle_api_get(self):
        ok, pid = self._parse_api_path()
        if not ok:
            self._send_json(404, {'error': 'not found'})
            return

        if pid is None:
            self._send_json(200, {'playlists': list_playlists()})
            return

        item = get_playlist(pid)
        if not item:
            self._send_json(404, {'error': 'playlist not found'})
            return
        self._send_json(200, item)

    # -------- API: POST --------

    def _handle_api_post(self):
        ok, pid = self._parse_api_path()
        if not ok or pid is not None:
            self._send_json(405, {'error': 'method not allowed'})
            return

        body = self._read_json_body()
        if not isinstance(body, dict):
            self._send_json(400, {'error': 'invalid JSON body'})
            return

        name = body.get('name')
        tracks = body.get('tracks')
        if not isinstance(tracks, list):
            self._send_json(400, {'error': 'tracks must be a list'})
            return

        # Sanitize tracks: only keep strings/numbers in known fields
        clean = []
        for t in tracks:
            if not isinstance(t, dict):
                continue
            url = str(t.get('url', '')).strip()
            if not url:
                continue
            clean.append({
                'title': str(t.get('title', ''))[:500],
                'duration': float(t.get('duration', 0) or 0),
                'url': url[:2000],
            })

        if not clean:
            self._send_json(400, {'error': 'no valid tracks'})
            return

        saved = save_playlist(name, clean)
        # Return the summary entry to slot directly into the client list
        self._send_json(201, {
            'id': saved['id'],
            'name': saved['name'],
            'trackCount': len(saved['tracks']),
            'importedAt': saved['importedAt'],
        })

    # -------- API: DELETE --------

    def _handle_api_delete(self):
        ok, pid = self._parse_api_path()
        if not ok or pid is None:
            self._send_json(400, {'error': 'id required'})
            return

        if delete_playlist(pid):
            self._send_json(200, {'deleted': pid})
        else:
            self._send_json(404, {'error': 'playlist not found'})

    # -------- Proxy --------

    def _handle_proxy(self, head_only: bool):
        try:
            qs = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(qs)
            target = params.get('url', [None])[0]

            if not target:
                self.send_error(400, 'Missing url parameter')
                return

            if not (target.startswith('http://') or target.startswith('https://')):
                self.send_error(400, 'Only http(s) URLs are allowed')
                return

            # Extract short name for logging
            short = target.split('/')[-1][:60] if '/' in target else target[:60]
            log.info(f'PROXY START → {short}')

            req_headers = {
                'User-Agent': PROXY_UA,
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
            }
            range_h = self.headers.get('Range')
            if range_h:
                req_headers['Range'] = range_h
                log.debug(f'  Range: {range_h}')

            # Google Drive: resolve download URL with confirmation token
            actual_url = target
            if 'drive.google.com' in target or 'drive.usercontent.google.com' in target:
                actual_url = self._resolve_gdrive_url(target, req_headers)

            max_retries = 3
            last_err = None
            resp = None

            for attempt in range(1, max_retries + 1):
                try:
                    req = urllib.request.Request(actual_url, headers=req_headers)
                    resp = _url_opener.open(req, timeout=30)
                    break
                except urllib.error.HTTPError as he:
                    log.warning(f'PROXY HTTP {he.code} ← {short}')
                    self.send_response(he.code)
                    for k, v in he.headers.items():
                        if k.lower() in BLOCKED_RESPONSE_HEADERS:
                            continue
                        self.send_header(k, v)
                    self._cors_headers()
                    self.end_headers()
                    if not head_only:
                        try:
                            self.wfile.write(he.read())
                        except Exception:
                            pass
                    return
                except (ConnectionResetError, ConnectionAbortedError,
                        OSError, urllib.error.URLError, TimeoutError) as e:
                    last_err = e
                    log.warning(
                        f'PROXY RETRY {attempt}/{max_retries} '
                        f'{type(e).__name__}: {e} ← {short}'
                    )
                    if attempt < max_retries:
                        time.sleep(1 * attempt)
                    continue
            else:
                log.error(f'PROXY FAILED after {max_retries} retries ← {short}: {last_err}')
                self.send_error(502, f'Proxy failed after {max_retries} retries: {last_err}')
                return

            with resp:
                ct = resp.headers.get('Content-Type', '?')
                cl = resp.headers.get('Content-Length', '?')
                log.info(f'PROXY OK {resp.status} [{ct}] {cl}B ← {short}')

                self.send_response(resp.status)
                for k, v in resp.headers.items():
                    if k.lower() in BLOCKED_RESPONSE_HEADERS:
                        continue
                    self.send_header(k, v)

                self._cors_headers()
                self.send_header('Access-Control-Allow-Headers', '*')
                self.send_header(
                    'Access-Control-Expose-Headers',
                    'Content-Length, Content-Range, Accept-Ranges, Content-Type',
                )
                self.end_headers()

                if head_only:
                    return

                bytes_sent = 0
                while True:
                    try:
                        chunk = resp.read(64 * 1024)
                    except (ConnectionResetError, ConnectionAbortedError,
                            OSError, TimeoutError) as e:
                        log.warning(f'PROXY upstream read error after {bytes_sent}B: {e}')
                        break
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                        bytes_sent += len(chunk)
                    except (BrokenPipeError, ConnectionResetError,
                            ConnectionAbortedError, OSError):
                        # Client disconnected (e.g. user skipped track) — this is normal
                        log.debug(f'PROXY client disconnected after {bytes_sent}B ← {short}')
                        break

                log.info(f'PROXY DONE {bytes_sent}B ← {short}')

        except Exception as e:
            log.error(f'PROXY ERROR {type(e).__name__}: {e}')
            try:
                self.send_error(502, f'Proxy error: {e}')
            except Exception:
                pass

    def _resolve_gdrive_url(self, url: str, headers: dict) -> str:
        """Follow Google Drive redirects and handle confirmation tokens."""
        try:
            log.debug(f'GDrive resolving: {url[:80]}')
            req = urllib.request.Request(url, headers=headers)
            resp = _url_opener.open(req, timeout=15)
            final_url = resp.url

            content_type = resp.headers.get('Content-Type', '')
            if 'text/html' in content_type:
                body = resp.read(50000).decode('utf-8', errors='ignore')
                resp.close()

                import re as _re
                confirm_match = _re.search(
                    r'confirm=([a-zA-Z0-9_-]+)', body
                )
                if confirm_match:
                    token = confirm_match.group(1)
                    parsed = urllib.parse.urlparse(url)
                    qs = urllib.parse.parse_qs(parsed.query)
                    file_id = qs.get('id', [''])[0]
                    if file_id:
                        confirmed = (
                            f'https://drive.usercontent.google.com/download'
                            f'?id={file_id}&export=download&confirm={token}'
                        )
                        log.info(f'GDrive confirm token: {token}')
                        return confirmed

                dl_match = _re.search(
                    r'href="(/uc\?export=download[^"]*)"', body
                )
                if dl_match:
                    resolved = 'https://drive.google.com' + dl_match.group(1).replace('&amp;', '&')
                    log.info('GDrive resolved from HTML link')
                    return resolved

                log.warning('GDrive returned HTML but no confirm token found')
                return url
            else:
                resp.close()
                if final_url != url:
                    log.info(f'GDrive redirected → {final_url[:80]}')
                return final_url
        except Exception as e:
            log.warning(f'GDrive resolve failed: {e}, using original URL')
            return url

    def log_message(self, fmt, *args):
        log.debug(fmt % args)


class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


# ===================== Local IP discovery =====================

def get_lan_ips() -> list[str]:
    """Return list of non-loopback IPv4 addresses bound to local interfaces."""
    ips: set[str] = set()
    try:
        # Trick: open a UDP socket to a public IP (no actual packet sent),
        # then read back which local interface the OS chose.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('8.8.8.8', 80))
            ips.add(s.getsockname()[0])
    except Exception:
        pass

    # Also enumerate via getaddrinfo in case there are multiple interfaces
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if ip and not ip.startswith('127.'):
                ips.add(ip)
    except Exception:
        pass

    return sorted(ips)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=DEFAULT_PORT)
    parser.add_argument('--host', default=DEFAULT_HOST,
                        help='Default 0.0.0.0 (all interfaces) for LAN access')
    args = parser.parse_args()

    httpd = ThreadedServer((args.host, args.port), Handler)

    print('=' * 60)
    print(' RetroPlayer server starting')
    print('=' * 60)
    print(f' Static root:  {DIRECTORY}')
    print(f' Playlists DB: {PLAYLISTS_DIR}')
    print()
    print(' Access from this device:')
    print(f'   http://localhost:{args.port}/')
    lan_ips = get_lan_ips()
    if lan_ips:
        print()
        print(' Access from other devices on same WiFi/LAN:')
        for ip in lan_ips:
            print(f'   http://{ip}:{args.port}/')
    else:
        print(' (no LAN IP detected — check WiFi connection)')
    print()
    print(' Press Ctrl+C to stop.')
    print('=' * 60)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\nShutdown')
        httpd.server_close()


if __name__ == '__main__':
    main()
