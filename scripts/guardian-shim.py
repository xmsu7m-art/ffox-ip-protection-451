#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
guardian-shim.py - make Firefox's built-in VPN token endpoint reachable
from regions where the production edge returns HTTP 451.

Why this works
--------------
vpn.mozilla.org sits behind a Fastly/Varnish edge that rejects requests
whose raw URL path starts with the lowercase prefix "/api/" when the
client IP is outside the supported regions. The origin application is an
Express app, and Express routes are case-insensitive by default. As a
result, "/API/v1/fpn/token" bypasses the case-sensitive edge rule and is
still routed to the very same token handler.

This program listens on 127.0.0.1 only, rewrites "/api/" to "/API/" and
forwards the request to vpn.mozilla.org over a direct TLS connection.
It never proxies browsing traffic and needs no upstream proxy.

Usage
-----
    python guardian-shim.py
    python guardian-shim.py --port 8787 --log shim.log

Then set this pref in about:config:

    browser.ipProtection.guardian.endpoint = http://127.0.0.1:8787/

Notes
-----
* Do not use this shim for the initial enrollment/activation flow: the
  client drives that through a hidden browser and checks the endpoint
  origin against an allow-list, which a 127.0.0.1 origin will fail.
  Enroll once with a working proxy, then switch the pref.
* The listener is bound to the loopback interface only.
* Requires Python 3.8+. Standard library only, no pip install.
"""

import argparse
import http.client
import http.server
import ssl
import sys
import threading
import time

UPSTREAM_HOST = "vpn.mozilla.org"
UPSTREAM_PORT = 443

# Only these request headers are forwarded. Host is set by http.client.
FORWARD_HEADERS = ("Authorization", "Content-Type", "Accept")

# Recomputed or intentionally dropped on the way back.
DROP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "server",
    "date",
    "set-cookie",
}

LOG_PATH = None
LOG_LOCK = threading.Lock()


def say(message):
    """Print when a console exists; stay silent under pythonw."""
    if sys.stdout is not None:
        try:
            print(message)
            sys.stdout.flush()
        except Exception:
            pass


def log_line(message):
    line = "%s %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), message)
    if LOG_PATH:
        try:
            with LOG_LOCK:
                with open(LOG_PATH, "a", encoding="utf-8") as handle:
                    handle.write(line + "\n")
            return
        except Exception:
            pass
    if sys.stderr is not None:
        try:
            sys.stderr.write(line + "\n")
            sys.stderr.flush()
        except Exception:
            pass


class GuardianShim(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "guardian-shim/1.1"

    def _rewrite(self, raw_path):
        if raw_path.startswith("/api/"):
            return "/API" + raw_path[4:]
        return raw_path

    def _handle(self):
        upstream_path = self._rewrite(self.path)

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        body = self.rfile.read(length) if length > 0 else None

        headers = {"Host": UPSTREAM_HOST}
        for name in FORWARD_HEADERS:
            value = self.headers.get(name)
            if value:
                headers[name] = value

        context = ssl.create_default_context()
        connection = http.client.HTTPSConnection(
            UPSTREAM_HOST, UPSTREAM_PORT, timeout=30, context=context
        )

        try:
            connection.request(
                self.command, upstream_path, body=body, headers=headers
            )
            response = connection.getresponse()
            payload = response.read()
            status = response.status
            reason = response.reason
            response_headers = response.getheaders()
        except Exception as exc:
            log_line(
                "!! upstream error: %s %s -> %s"
                % (self.command, upstream_path, exc)
            )
            try:
                self.send_error(502, "upstream error")
            except Exception:
                pass
            connection.close()
            return

        connection.close()

        self.send_response(status)
        for name, value in response_headers:
            if name.lower() in DROP_HEADERS:
                continue
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()

        if self.command != "HEAD":
            try:
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass

        log_line(
            "%s %s -> %s %s (%d bytes)"
            % (self.command, upstream_path, status, reason, len(payload))
        )

    def do_GET(self):
        self._handle()

    def do_HEAD(self):
        self._handle()

    def do_POST(self):
        self._handle()

    def log_message(self, fmt, *args):
        pass


def main():
    global LOG_PATH

    parser = argparse.ArgumentParser(
        description="Firefox IP Protection /api/ -> /API/ shim"
    )
    parser.add_argument("--host", default="127.0.0.1", help="bind address")
    parser.add_argument("--port", type=int, default=8787, help="bind port")
    parser.add_argument(
        "--log",
        default=None,
        help="append logs to this file (useful with pythonw)",
    )
    args = parser.parse_args()

    LOG_PATH = args.log
    if LOG_PATH:
        log_line("=== guardian-shim starting on %s:%d ===" % (args.host, args.port))

    try:
        server = http.server.ThreadingHTTPServer((args.host, args.port), GuardianShim)
    except OSError as exc:
        message = (
            "Cannot bind %s:%d -> %s (another instance may already be running)"
            % (args.host, args.port, exc)
        )
        log_line(message)
        say(message)
        return 1

    say("guardian-shim listening on http://%s:%d/" % (args.host, args.port))
    say("  rewrite: /api/... -> https://%s/API/..." % UPSTREAM_HOST)
    say("  set in about:config:")
    say(
        "    browser.ipProtection.guardian.endpoint = http://%s:%d/"
        % (args.host, args.port)
    )
    say("  Press Ctrl+C to stop. Every forwarded request is logged.")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        say("\nStopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
