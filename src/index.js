// Bumped whenever the set of allowed targets changes. Chief of Staff reads this
// from GET /__capabilities to decide whether a user's deployed proxy is new
// enough to carry a given integration, and to tell them to redeploy if not.
const PROXY_VERSION = 2;

const ALLOWED_ORIGINS = [
  "https://roamresearch.com",
  "https://www.roamresearch.com",
];

// Upstream targets this proxy is allowed to reach, mapped to the path pattern
// each is restricted to (null = any path). This worker fronts specific Chief of
// Staff integrations — it is NOT a general CORS proxy, and general LLM API
// traffic (api.openai.com, api.anthropic.com, ...) must never pass through it.
const ALLOWED_TARGETS = new Map([
  // Composio MCP.
  ["mcp.composio.dev", null],
  ["backend.composio.dev", null],

  // ChatGPT-subscription (Codex) Responses API. A deliberate, narrow exception
  // to the no-LLM-traffic rule above: Roam's built-in CORS proxy is a cloud
  // function with a 60s timeout, so it kills any Codex generation longer than
  // that (heavy skill runs, reliably). Cloudflare Workers are CPU-time limited
  // rather than wall-clock limited and stream SSE straight through, so routing
  // Codex here removes the ceiling. Path-locked to the Codex API so a ChatGPT
  // access token passing through cannot be replayed against the rest of
  // chatgpt.com (conversations, account, billing).
  ["chatgpt.com", /^\/backend-api\/codex\//],

  // Cloudflare Browser Rendering, for Chief of Staff's roam_web_fetch tool.
  // Path-locked to the browser-rendering sub-API so the user's Cloudflare API
  // token cannot be used against the rest of their Cloudflare account.
  ["api.cloudflare.com", /^\/client\/v4\/accounts\/[^/]+\/browser-rendering\//],

  // Local development.
  ["localhost", null],
  ["127.0.0.1", null],
]);

function normaliseOrigin(originValue) {
  try {
    const url = new URL(String(originValue || ""));
    return url.origin;
  } catch {
    return "";
  }
}

function isOriginAllowed(request) {
  const origin = normaliseOrigin(request.headers.get("Origin"));
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin);
}

function isPrivateIpv4Host(hostname) {
  const m = String(hostname || "").match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a === 127;
}

function isTargetAllowed(targetUrl) {
  try {
    const url = new URL(targetUrl);
    const protocol = url.protocol.toLowerCase();
    const hostname = url.hostname.toLowerCase();

    if (!["https:", "http:"].includes(protocol)) return false;

    const isLocal = isPrivateIpv4Host(hostname);
    if (!ALLOWED_TARGETS.has(hostname) && !isLocal) return false;
    if (protocol === "http:" && !(hostname === "localhost" || isLocal)) return false;

    // Hosts carrying a user credential are locked to the one sub-API we need.
    const pathPattern = ALLOWED_TARGETS.get(hostname);
    if (pathPattern && !pathPattern.test(url.pathname)) return false;

    return true;
  } catch {
    return false;
  }
}

function buildUpstreamHeaders(request, targetUrl) {
  const incoming = new Headers(request.headers);
  const headers = new Headers();
  const ALLOWED_REQUEST_HEADERS = new Set([
    "accept",
    "authorization",
    "cache-control",
    "content-type",
    "last-event-id",
    "pragma",
    "x-api-key",
    // Codex Responses API (ChatGPT subscription) — the upstream rejects the
    // request without all three.
    "chatgpt-account-id",
    "openai-beta",
    "originator",
  ]);

  // Allow a narrow set of headers plus MCP-/Composio-specific prefixes.
  for (const [rawKey, value] of incoming.entries()) {
    const key = String(rawKey || "").toLowerCase();
    if (
      ALLOWED_REQUEST_HEADERS.has(key) ||
      key.startsWith("mcp-") ||
      key.startsWith("x-composio-")
    ) {
      headers.set(key, value);
    }
  }

  // Forward the upstream origin when present (important for some MCP endpoints).
  try {
    headers.set("origin", new URL(targetUrl).origin);
  } catch { /* ignore */ }
  return headers;
}

function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

// Static headers that are always allowed through CORS preflight.
const CORS_ALLOWED_HEADERS = [
  "accept", "authorization", "cache-control", "content-type",
  "last-event-id", "pragma", "x-api-key",
  "chatgpt-account-id", "openai-beta", "originator",
];
// Dynamic prefix patterns — any header matching these is also allowed.
const CORS_ALLOWED_HEADER_PREFIXES = ["mcp-", "x-composio-"];

function getAllowedHeaders(request) {
  // Validate the browser's Access-Control-Request-Headers against our allowlist.
  // This avoids a blanket "*" while still supporting dynamic MCP-/Composio- headers.
  const requested = (request.headers.get("Access-Control-Request-Headers") || "")
    .split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
  if (requested.length === 0) return CORS_ALLOWED_HEADERS.join(", ");

  const allowed = new Set(CORS_ALLOWED_HEADERS);
  for (const h of requested) {
    if (CORS_ALLOWED_HEADER_PREFIXES.some(p => h.startsWith(p))) {
      allowed.add(h);
    }
  }
  // Only echo back headers that are in our allowlist
  const result = requested.filter(h => allowed.has(h) || CORS_ALLOWED_HEADER_PREFIXES.some(p => h.startsWith(p)));
  return result.length > 0 ? result.join(", ") : CORS_ALLOWED_HEADERS.join(", ");
}

function corsHeaders(request) {
  const origin = normaliseOrigin(request.headers.get("Origin")) || ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": getAllowedHeaders(request),
    "Access-Control-Expose-Headers": "mcp-session-id",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export default {
  async fetch(request) {
    if (!isOriginAllowed(request)) {
      return new Response("Forbidden", { status: 403 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }

    const url = new URL(request.url);

    // Capability probe. Chief of Staff calls this to find out which upstreams a
    // user's deployed proxy actually supports, so it can route around an older
    // deployment instead of failing against it, and prompt for a redeploy.
    // Older proxies have no such route and answer 400 with no CORS headers, so
    // the caller's fetch simply throws — which it treats as "too old", exactly
    // the same outcome. Do not remove or rename without a version bump.
    if (url.pathname === "/__capabilities") {
      return new Response(
        JSON.stringify({ version: PROXY_VERSION, targets: [...ALLOWED_TARGETS.keys()] }),
        { headers: { ...corsHeaders(request), "Content-Type": "application/json" } },
      );
    }

    const targetUrl = url.pathname.slice(1) + url.search;

    if (!targetUrl.startsWith("http")) {
      return new Response("Usage: /<target-url>", { status: 400, headers: corsHeaders(request) });
    }
    if (!isTargetAllowed(targetUrl)) {
      return new Response("Forbidden target", { status: 403, headers: corsHeaders(request) });
    }

    // Block MCP SSE probe (GET to /tool_router/) — Composio returns 405
    // and the browser logs a noisy red error. Intercept it here cleanly.
    if (request.method === "GET" && new URL(targetUrl).pathname.includes("/tool_router/")) {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    // An upstream that refuses the connection would otherwise surface to the
    // browser as an opaque CORS failure (an unhandled throw yields a 500 with
    // no CORS headers), which is indistinguishable from the proxy being down.
    // Answer with a readable 502 instead.
    let response;
    try {
      response = await fetch(targetUrl, {
        method: request.method,
        headers: buildUpstreamHeaders(request, targetUrl),
        body: request.method !== "GET" ? await request.text() : undefined,
        redirect: "manual",
      });
    } catch (err) {
      return new Response(`Upstream fetch failed: ${err?.message || "unknown error"}`, {
        status: 502,
        headers: corsHeaders(request),
      });
    }

    if (isRedirectStatus(response.status)) {
      const location = response.headers.get("Location");
      let redirectedTo = "";
      try {
        redirectedTo = location ? new URL(location, targetUrl).toString() : "";
      } catch { /* ignore */ }
      return new Response("Upstream redirect blocked", {
        status: 502,
        headers: corsHeaders(request),
      });
    }

    const newResponse = new Response(response.body, response);
    for (const [key, value] of Object.entries(corsHeaders(request))) {
      newResponse.headers.set(key, value);
    }
    return newResponse;
  },
};
