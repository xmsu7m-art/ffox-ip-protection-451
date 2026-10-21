# Usage and Operations

## Daily use

1. Log in to Windows and wait a few seconds.
2. Open Firefox and click the VPN button in the toolbar.
3. Connect.

No proxy, no script, no terminal. The shim starts with the session and only
handles the credential request; browsing traffic goes straight to the Mozilla
relay.

---

## What is running

| Component | Location |
|---|---|
| Shim | `scripts/guardian-shim.py` |
| Visible launcher | `launchers/start-shim.bat` |
| Silent launcher | `launchers/shim-hidden.vbs` |
| Log | `shim.log` in the repository root |
| Firefox preference | `browser.ipProtection.guardian.endpoint` = `http://127.0.0.1:8787/` |

The shim binds to `127.0.0.1` only. Nothing on the network can reach it.

---

## Check that it is running

Open this URL in any browser:

```
http://127.0.0.1:8787/API/v1/fpn/status
```

- A JSON body (typically `{"code":401,...}`) means the shim is alive. The 401 is
  expected because the request carries no token.
- "Unable to connect" means the shim is not running.

Alternatively, look at the last line of `shim.log`. A timestamp within the last
few minutes means it is alive.

---

## Log

A healthy rotation looks like this:

```
2026-10-21 17:02:11 GET /API/v1/fpn/token -> 200 OK (1234 bytes)
```

One line every two minutes or so is normal. The client rotates the pass shortly
before it expires.

---

## Troubleshooting

| Symptom | Meaning | Action |
|---|---|---|
| `200 OK` lines but the VPN drops | relay-side or network issue | disconnect and reconnect the VPN |
| `-> 451` in the log | the edge rule changed; the case variant no longer works | fall back to routing only `vpn.mozilla.org` through a proxy |
| `-> 401` | the OAuth token was rejected | reconnect the VPN; if it persists, sign in to Firefox again |
| `-> 403` | the account has no Guardian entitlement | enroll the account first |
| `-> 502` | the shim could not reach `vpn.mozilla.org` | check DNS and general connectivity |
| no new log lines | the shim is not running | run `launchers/start-shim.bat` and read the console |
| `Cannot bind 127.0.0.1:8787` | another instance is already running | nothing to do |
| VPN connects but no pages load | relay side | reconnect; try another server location |

---

## Start automatically at logon

Copy `launchers/shim-hidden.vbs` into:

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\
```

The script resolves the repository root from its own location, so a copy in the
Startup folder still works as long as the repository stays where it is.

To remove the autostart, delete that copy.

---

## Uninstall

1. Delete the copy in the Startup folder, if present.
2. In `about:config`, set `browser.ipProtection.guardian.endpoint` back to
   `https://vpn.mozilla.org/`.
3. End any `pythonw.exe` process running `guardian-shim.py`.

No other system changes are made.

---

## Notes

- Run only one instance. A second one exits with a bind error.
- Firefox updates do not affect the shim or the preference.
- If the VPN autostarts at login and reports unavailable before the shim is up,
  set `browser.ipProtection.autoStartEnabled` to `false` and connect manually.
- The shim is a workaround for a vendor-side configuration defect, not a
  supported feature.
