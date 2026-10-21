/* ============================================================================
 * Built-in VPN - token endpoint probe
 *
 * Where to run: the Browser Console
 *   about:support -> "Open Browser Console", or Ctrl+Shift+J
 *   (the console command line must be enabled:
 *    about:config -> devtools.chrome.enabled = true, then reopen the window)
 *
 * Requirements:
 *   1) A browser account signed in, and the built-in VPN has connected
 *      successfully at least once (so the refresh token carries the vpn scope)
 *   2) System/router proxy disabled, so the egress is the real local IP
 *   3) browser.ipProtection.enabled = true
 *
 * The script changes nothing and writes no files. It reads one OAuth token,
 * runs seven requests, and never prints the token or the proxy pass.
 * ========================================================================== */

(async () => {
  "use strict";

  const BASE = "https://vpn.mozilla.org";
  const rows = [];
  const started = Date.now();

  const mask = value =>
    typeof value === "string" && value.length > 20
      ? value.slice(0, 6) + "..." + value.slice(-4) + ` (len ${value.length})`
      : String(value);

  const decodeJwt = jwt => {
    const part = String(jwt).split(".")[1];
    if (!part) throw new Error("not a JWT");
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  };

  const log = (...args) => console.log("[probe]", ...args);

  // ---------------------------------------------------------------- egress check
  let geo = null;
  try {
    const response = await fetch("https://ipinfo.io/json", { cache: "no-store" });
    geo = await response.json();
    log("egress:", geo.ip, "|", geo.country, "|", geo.org);
    if (geo.country !== "CN") {
      console.warn(
        `[probe] WARNING: egress is ${geo.country}, not CN. ` +
          "This run does not represent mainland China. Disable any proxy and retry."
      );
    }
  } catch (error) {
    console.warn("[probe] egress check failed (not fatal):", String(error));
  }

  // ---------------------------------------------------------------- get a token
  let token = null;
  let tokenSource = "";
  const tokenErrors = [];

  const grab = async (label, fn) => {
    try {
      const value = await fn();
      if (typeof value === "string" && value.length > 0) {
        token = value;
        tokenSource = label;
      } else {
        tokenErrors.push(label + ": empty result");
      }
    } catch (error) {
      tokenErrors.push(label + ": " + (error && error.message ? error.message : String(error)));
    }
  };

  await grab("IPProtectionService.authProvider.getToken()", async () => {
    const { IPProtectionService } = ChromeUtils.importESModule(
      "moz-src:///toolkit/components/ipprotection/IPProtectionService.sys.mjs"
    );
    const handle = await IPProtectionService.authProvider.getToken();
    return handle && handle.token ? handle.token : typeof handle === "string" ? handle : null;
  });

  if (!token) {
    await grab("FxAccounts.getOAuthToken({service:'vpn'})", async () => {
      const { getFxAccountsSingleton } = ChromeUtils.importESModule(
        "resource://gre/modules/FxAccounts.sys.mjs"
      );
      const handle = await getFxAccountsSingleton().getOAuthToken({ service: "vpn" });
      return handle && handle.token ? handle.token : typeof handle === "string" ? handle : null;
    });
  }

  if (!token) {
    console.error("[probe] could not obtain an OAuth token; the rest is meaningless.");
    console.error("[probe] details:", tokenErrors);
    console.error(
      "[probe] fix: connect the built-in VPN once with a working proxy, then disable the proxy and rerun."
    );
    return;
  }

  log("token source:", tokenSource, "| token:", mask(token));
  try {
    const claims = decodeJwt(token);
    log("token claims:", {
      aud: claims.aud,
      scope: claims.scope,
      exp: claims.exp ? new Date(claims.exp * 1000).toISOString() : undefined,
    });
  } catch (error) {
    log("token claim decode failed (not fatal):", String(error));
  }

  // ---------------------------------------------------------------- requests
  const call = async (id, label, url, options) => {
    const opts = options || {};
    const method = opts.method || "GET";
    const headers = { "Content-Type": "application/json" };
    if (opts.auth) headers.Authorization = "Bearer " + token;

    const record = { id, label, status: "-", contentType: "-", servedBy: "", quota: "", note: "" };

    try {
      const response = await fetch(url, { method, cache: "no-cache", headers });
      record.status = response.status;
      record.contentType = response.headers.get("content-type") || "-";
      record.servedBy = (response.headers.get("x-served-by") || "").split(",").pop().trim();

      const quotaKeys = ["x-quota-unlimited", "x-quota-limit", "x-quota-remaining", "x-quota-reset"];
      record.quota = quotaKeys
        .map(key => (response.headers.get(key) ? key + "=" + response.headers.get(key) : ""))
        .filter(Boolean)
        .join(" ");

      const body = method === "HEAD" ? "" : await response.text();
      record.note = (body || "").replace(/\s+/g, " ").slice(0, 120);

      if (response.status === 200 && method === "GET" && /\/token$/i.test(url)) {
        try {
          const data = JSON.parse(body);
          if (data && typeof data.token === "string") {
            const claims = decodeJwt(data.token);
            const ttl = claims.exp - Math.floor(Date.now() / 1000);
            record.note =
              "pass issued | iss=" +
              claims.iss +
              " | aud=" +
              claims.aud +
              " | ttl " +
              (ttl / 60).toFixed(1) +
              " min";
            globalThis.__vpnPass = data.token;
          } else {
            record.note = "200 but no token field: " + record.note;
          }
        } catch (error) {
          record.note = "200 but parse failed: " + String(error);
        }
      }
    } catch (error) {
      record.status = "FETCH_ERROR";
      record.note = String(error);
    }

    rows.push(record);
    return record;
  };

  await call("A1", "lowercase /api/ without token (baseline)", BASE + "/api/v1/fpn/token");
  await call("A2", "lowercase /api/ with token (control)", BASE + "/api/v1/fpn/token", { auth: true });
  await call("B1", "uppercase /API/ without token (baseline)", BASE + "/API/v1/fpn/token");
  const B2 = await call("B2", "uppercase /API/ with token (decisive)", BASE + "/API/v1/fpn/token", {
    auth: true,
  });
  await call("B3", "uppercase /API/status with token", BASE + "/API/v1/fpn/status", { auth: true });
  await call("B4", "uppercase /API/token HEAD (quota)", BASE + "/API/v1/fpn/token", {
    auth: true,
    method: "HEAD",
  });
  await call("C1", "FxA profile (token sanity check)", "https://profile.accounts.firefox.com/v1/profile", {
    auth: true,
  });

  console.table(rows);
  log("full records:", rows);

  // ---------------------------------------------------------------- verdict
  console.log("\n================ verdict ================");

  if (B2.status === 200) {
    console.log("B2=200: the case variant works and the token endpoint is reachable directly.");
    console.log("The pass is stored in globalThis.__vpnPass. Do not publish it.");
  } else if (B2.status === 403) {
    console.log("B2=403: token is valid but the account has no Guardian entitlement.");
    console.log("Activate first: POST /API/v1/fpn/activate with the same token.");
  } else if (B2.status === 401) {
    console.log("B2=401: token rejected (missing scope or expired).");
    console.log("Connect the built-in VPN once with a proxy, then disable it and rerun.");
  } else if (B2.status === 451) {
    console.log("B2=451: the origin applies a second region check; the case variant does not help.");
  } else if (B2.status === "FETCH_ERROR") {
    console.log("B2 fetch failed: " + B2.note + " - try the about:debugging console or curl.");
  } else {
    console.log("B2=" + B2.status + ": unexpected; keep the status code and body.");
  }

  console.log(`control A1 should be 451, A2 should also be 451 (the edge never reads the token). actual A1=${rows[0].status} A2=${rows[1].status}`);
  console.log(`C1 200 or 403 both mean the token itself is valid; 401 means it is not. actual C1=${rows[6].status}`);
  console.log("elapsed", ((Date.now() - started) / 1000).toFixed(1), "s");
})();
