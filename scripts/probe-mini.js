/* ----------------------------------------------------------------------------
 * Minimal probe: two numbers are enough.
 *
 * Run in the Firefox Browser Console:
 *   about:config -> devtools.chrome.enabled = true
 *   Ctrl+Shift+J, paste, Enter
 *
 * Prerequisites: signed in to a Firefox Account, the built-in VPN has
 * connected at least once, and no proxy is active.
 * -------------------------------------------------------------------------- */

(async () => {
  // 1. Egress check
  try {
    const geo = await (await fetch("https://ipinfo.io/json")).json();
    console.log("1) egress:", geo.country, geo.ip);
  } catch (error) {
    console.log("1) egress: unknown (not fatal)");
  }

  // 2. Obtain an OAuth token
  let token = null;
  try {
    const { IPProtectionService } = ChromeUtils.importESModule(
      "moz-src:///toolkit/components/ipprotection/IPProtectionService.sys.mjs"
    );
    token = (await IPProtectionService.authProvider.getToken()).token;
  } catch (error) {
    try {
      const { getFxAccountsSingleton } = ChromeUtils.importESModule(
        "resource://gre/modules/FxAccounts.sys.mjs"
      );
      token = (await getFxAccountsSingleton().getOAuthToken({ service: "vpn" })).token;
    } catch (nested) {
      console.log("2) token failed:", String(nested));
    }
  }
  if (!token) {
    console.log("2) no token. Connect the built-in VPN once with a proxy, then retry.");
    return;
  }
  console.log("2) token acquired, length", token.length);

  // 3. The two requests
  const hit = async path => {
    const response = await fetch("https://vpn.mozilla.org" + path, {
      headers: { Authorization: "Bearer " + token },
    });
    const body = await response.text();
    console.log(path, "=>", response.status, body.slice(0, 110));
    return response.status;
  };
  const lowercase = await hit("/api/v1/fpn/token");
  const uppercase = await hit("/API/v1/fpn/token");

  // 4. Verdict
  console.log("---- verdict ----");
  console.log("lowercase /api/ =", lowercase, "(expected 451)");
  if (uppercase === 200) console.log("uppercase /API/ = 200: the case variant works");
  else if (uppercase === 451) console.log("uppercase /API/ = 451: blocked at the origin too");
  else if (uppercase === 401) console.log("uppercase /API/ = 401: token rejected");
  else if (uppercase === 403) console.log("uppercase /API/ = 403: no entitlement");
  else console.log("uppercase /API/ =", uppercase, ": report this value");
})();
