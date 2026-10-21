# Built-in Browser VPN: Reaching the Token Endpoint Without an Upstream Proxy

The browser's built-in VPN (IP Protection) uses a vendor-operated relay and a
separate control plane. From mainland China the relay itself
is reachable over plain TCP, but the control-plane call that issues the proxy
credential (`GET /api/v1/fpn/token`) returns `451 Unavailable For Legal Reasons`,
so the client ends up in a permanent "VPN unavailable" state.

This repository documents the actual cause of that 451, a way to reach the same
token handler without any upstream proxy, and a small local shim that makes
the browser use it.

Measured on 2026-10-21 from a residential China Mobile line in Guangdong
(AS9808).

---

## TL;DR

The 451 is **not** an account or entitlement decision. It is a case-sensitive
path rule evaluated at the CDN edge:

| Request path | Result | Answered by |
|---|---|---|
| `/api/v1/fpn/token` | `451 {"error":"unavailable_in_region"}` | Fastly/Varnish edge |
| `/API/v1/fpn/token` | `400 Missing Authorization header` (no token) / `401` (bad token) / **`200` + pass (valid token)** | Express origin |

The origin is an Express application, and Express routes are case-insensitive by
default. The edge rule matches the raw lowercase prefix `/api/`. Changing three
letters is enough to skip the rule while still hitting the same handler.

A local loopback shim rewrites `/api/` to `/API/` and connects directly to
the service. No proxy, no relay in the middle, no third party sees the token.

---

## Evidence

### 1. The 451 is synthesized at the edge, not by the origin

| | `/api/v1/fpn/token` (451) | `/API/v1/fpn/token` (400) |
|---|---|---|
| `Server` | **Varnish** | **nginx** |
| `Via` | `1.1 varnish` | `1.1 google, 1.1 varnish, 1.1 varnish, 1.1 varnish` |
| `X-Served-By` | one POP | four POPs |
| `Content-Security-Policy` | absent | present (helmet defaults) |
| `Set-Cookie` | absent | `session=...` |
| `Connection` | `close` | `keep-alive` |
| Body | `{"error":"unavailable_in_region"}` | `{"error":"Bad Request: Missing Authorization header"}` |

The 451 never crosses the Google hop, carries no origin CSP or cookies, and is
served by a single edge POP. The request does not reach the application.

### 2. The rule matches the raw URL, case-sensitively

- Every `/api/...` path returns 451, including routes that do not exist.
  The rule is a prefix match, not a route-level guard.
- `/api/v2/...`, `/api/fpn/...`, `/api/v1//...`, `/api/v1%2F...` all return 451.
- `/api%2Fv1/...` returns 404 from the origin: the literal prefix `"/api/"` no
  longer exists, which confirms the rule inspects the raw string.
- `/Api/...`, `/API/...` and `/%61pi/...` reach the origin.

### 3. The same handler answers on the case variant

- `GET /API/v1/fpn/token` without credentials -> `400 Missing Authorization header`
- with a bogus JWT -> `401 {"error":"Unauthorized"}`
- `GET /API/v1/fpn/status` -> `401`
- `POST /API/v1/fpn/activate` -> `401 {"error":"jwt malformed"}`
- `GET /API/v1/fpn/auth?experiment=alpha` -> `302` to the real account-service
  authorization URL (`client_id=e6eb0d1e856335fc`)

With a real account OAuth token, `/API/v1/fpn/token` returns `200` and a
ProxyPass JWT.

---

## How the shim works

```
Client  --HTTP--> 127.0.0.1:8787 --TLS--> vpn.mozilla.org/API/v1/fpn/token
```

- The shim listens on the loopback interface only.
- It rewrites the path prefix and forwards the request over a direct TLS
  connection.
- It forwards `Authorization` and `Content-Type`, returns the origin status,
  body and quota headers, and strips `Set-Cookie` and hop-by-hop headers.
- Browsing traffic never touches it. Only token rotation does.

The client builds the URL as `new URL(guardianEndpoint)` with the pathname
hard-coded to `/api/v1/fpn/token`, so the preference alone cannot change the
case. The shim is the smallest way to change it without patching the client.

---

## Quick start (Windows)

1. Install Python 3 and make sure `python` works in a terminal.
2. Run the shim:

   ```
   launchers\start-shim.bat
   ```

   or, for a silent background process:

   ```
   wscript launchers\shim-hidden.vbs
   ```

3. In `about:config`, set:

   ```
   browser.ipProtection.guardian.endpoint = http://127.0.0.1:8787/
   ```

4. Restart the browser and connect the built-in VPN.

Every two minutes or so the shim log shows a rotation:

```
2026-10-21 17:02:11 GET /API/v1/fpn/token -> 200 OK (1234 bytes)
```

To make it start at logon, put a copy of `shim-hidden.vbs` (or a shortcut to it)
in `shell:startup`.

To roll back, set the preference back to `https://vpn.mozilla.org/` and stop the
shim.

---

## Verification

`scripts/probe-console.js` runs in the Browser Console. It reads one
OAuth token, sends seven requests, and prints a verdict.

Requirements:

- signed in to the browser account, and the built-in VPN has connected at least
  once (so the refresh token carries the `vpn` scope);
- no router or system proxy;
- `about:config` -> `devtools.chrome.enabled = true` so the Browser Console has
  a command line.

Expected result:

```
A1  lowercase /api/ without token   451
A2  lowercase /api/ with token      451
B1  uppercase /API/ without token   400
B2  uppercase /API/ with token      200
```

`A1 == A2 == 451` is the important control: the edge never reads the token.
`B2 == 200` is the decisive result.

`scripts/probe-mini.js` is a shorter version that prints only the two numbers.

---

## Repository layout

```
.
├── docs/
│   ├── analysis.md        full write-up: evidence, mechanism, limits
│   └── usage.md           day-to-day use, troubleshooting, rollback
├── launchers/
│   ├── start-shim.bat     visible console
│   └── shim-hidden.vbs    silent background start
└── scripts/
    ├── guardian-shim.py   the loopback path rewriter
    ├── probe-console.js   full Browser Console probe
    └── probe-mini.js      minimal probe
```

---

## Limits and caveats

- This relies on a configuration defect: a case-sensitive edge rule in front of
  a case-insensitive Express router. If the vendor tightens either side, the method
  stops working.
- The initial enrollment/activation flow goes through a hidden browser and
  validates the endpoint origin against an allow-list. Enroll once with a
  working network path, then switch the preference.
- Using the service outside its supported regions may conflict with the vendor's
  terms. This is documented for research and interoperability purposes; use it
  at your own risk.
- The relay accepted `CONNECT` from the same client IP in this environment. That
  is an observation, not a guarantee.
- `experiment=alpha|beta|gamma|delta` only tags the account-service OAuth
  flow. All four values produce identical `client_id`, `scope` and
  `redirect_uri`; none of them changes the region decision.

---

## Disclaimer

Not affiliated with the vendor. All product names and marks belong to their
respective owners. This repository contains no credentials and no vendor source
code.
