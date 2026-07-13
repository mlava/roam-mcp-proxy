# roam-mcp-proxy

A lightweight Cloudflare Worker that adds CORS headers to proxied requests, for use with [Chief of Staff](https://github.com/mlava/chief-of-staff). Browser security policy blocks cross-origin requests from the Roam Research SPA to endpoints that don't return CORS headers.

**One deployment serves two uses:**

| Use | Why it needs this worker |
|---|---|
| **Composio MCP** | Composio's MCP endpoint returns no CORS headers. |
| **Web page fetching** (`roam_web_fetch`) | Cloudflare's Browser Rendering API is not callable cross-origin from Roam. |

LLM API calls (Anthropic, OpenAI, Gemini, …) use Roam's own built-in CORS proxy and do **not** go through this worker.

> **Already deployed this worker?** Built-in support for web page fetching landed in **v2** (`api.cloudflare.com` is allowlisted out of the box, path-locked to the Browser Rendering API). Redeploy (`npx wrangler deploy`) to pick it up — your worker URL doesn't change and no settings need updating.

> **Why not ChatGPT-subscription (Codex) traffic?** It was attempted and it cannot work. Cloudflare's runtime stamps a `Cf-Worker` header onto every subrequest a Worker makes, *after* user code runs, so it cannot be stripped. OpenAI's WAF blocks any request carrying it (403 HTML block page). Verified by bisection: an otherwise identical `curl` to the Codex endpoint returns 401 — and returns 403 the instant `Cf-Worker` is added by hand. No Cloudflare Worker can proxy `chatgpt.com`, so the ~60s Codex ceiling (Roam's proxy timeout) needs a proxy on a *non-Cloudflare* platform, not this one.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mlava/roam-mcp-proxy)

---

## Prerequisites

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- Node.js 18+ and npm

---

## Deploy your own proxy

### 1. Install Wrangler

```bash
npm install -g wrangler
```

### 2. Authenticate

```bash
wrangler login
```

This opens a browser window to authorise Wrangler with your Cloudflare account.

### 3. Install dependencies

```bash
npm install
```

### 4. Deploy

```bash
npx wrangler deploy
```

Wrangler will output the deployed URL, e.g.:

```
Published roam-mcp-proxy (x.xx sec)
  https://roam-mcp-proxy.<your-subdomain>.workers.dev
```

Copy this URL — you'll need it when configuring Chief of Staff.

---

## Configure Chief of Staff

In **Roam → Settings → Chief of Staff → Show Integration Settings**, set **CORS Proxy URL** to your worker URL:

```
https://roam-mcp-proxy.<your-subdomain>.workers.dev
```

That single setting covers both uses. Chief of Staff appends the real target URL as the path; the worker strips the leading `/`, forwards the request to that target, and adds CORS headers to the response.

### Capability detection

The worker reports its version and allowed targets at `GET /__capabilities`:

```json
{ "version": 2, "targets": ["mcp.composio.dev", "backend.composio.dev", "api.cloudflare.com", "localhost", "127.0.0.1"] }
```

Use it to check what your deployment supports without digging through the dashboard:

```bash
curl -s -H "Origin: https://roamresearch.com" https://roam-mcp-proxy.<you>.workers.dev/__capabilities
```

If that returns `Usage: /<target-url>` instead of JSON, you are running a pre-v2 worker — redeploy.

---

## How it works

For every incoming request:

1. **Origin check** — rejects requests whose `Origin` header is not an exact match for an allowlisted Roam origin (`https://roamresearch.com` or `https://www.roamresearch.com`).
2. **OPTIONS** (CORS preflight) — returns CORS headers with validated `Access-Control-Allow-Headers` (echoes back only headers from the static allowlist plus `mcp-*` and `x-composio-*` prefixes — no wildcard `*`). Methods restricted to `GET, POST, OPTIONS`.
3. **`GET /__capabilities`** — returns the worker's version and allowed target hosts, so you can check what a deployment supports.
4. **GET to `/tool_router/`** — returns `204 No Content`. Composio's MCP endpoint returns `405` for SSE probe GETs, which causes noisy browser console errors. The proxy intercepts these silently.
5. **Target allowlist check** — only proxies to allowlisted upstream hosts, and for hosts that carry a user credential, only on a specific path (see Security below).
6. **Redirect hardening** — upstream redirects are blocked (the worker does not follow redirects).
7. **CORS response headers** — all responses, *including errors*, include `Vary: Origin` for correct cache behaviour, origin-specific `Access-Control-Allow-Origin` (no wildcard), and validated `Access-Control-Allow-Headers`. Error responses carry them too, so the browser shows the real reason instead of an opaque CORS failure.
8. **Everything else** — forwards the request (method, allowlisted headers, body) to the target URL extracted from the path, then streams the response back with CORS headers added. Response bodies stream rather than buffer, so SSE passes straight through.

---

## Local development

```bash
npm run dev
```

This starts a local dev server (typically `http://localhost:8787`). You can point your CORS Proxy URL at `http://localhost:8787` for testing.

---

## Security

The proxy applies multiple layers of security:

1. **Caller origin allowlist (exact match)** — only requests from:
   - `https://roamresearch.com`
   - `https://www.roamresearch.com`
2. **Upstream target allowlist** — only proxies to:

   | Host | Allowed paths |
   |---|---|
   | `mcp.composio.dev` | any (Composio MCP hostname) |
   | `backend.composio.dev` | any (Composio streamable HTTP / tool router hostname) |
   | `api.cloudflare.com` | **only** `/client/v4/accounts/<id>/browser-rendering/…` |
   | `localhost`, `127.0.0.1`, private IPv4 | any (local development) |

Requests to any other target host — or to an allowed host on a disallowed path — are rejected with `403 Forbidden target`.

**Why the path lock on `api.cloudflare.com`.** That request carries your Cloudflare API token. Allowing the whole host would mean a bug — or a malicious page that got a request past the origin check — could aim that token at the rest of your Cloudflare account (zones, DNS, Workers). Locking it to the one sub-API Chief of Staff actually calls means the token is only ever usable for the thing it was sent for.

LLM API traffic (`api.openai.com`, `api.anthropic.com`, `chatgpt.com`, …) is blocked and stays blocked.

3. **CORS hardening**:
   - `Vary: Origin` header on all responses (correct cache behaviour when serving multiple origins)
   - Methods restricted to `GET, POST, OPTIONS` only (no PUT, DELETE, PATCH)
   - `Access-Control-Allow-Headers` uses a validated echo approach: the browser's `Access-Control-Request-Headers` are checked against a static allowlist (`accept`, `authorization`, `cache-control`, `content-type`, `last-event-id`, `pragma`, `x-api-key`) plus the `mcp-*` / `x-composio-*` prefix patterns. Disallowed headers are silently dropped. No wildcard `*`.
   - `Access-Control-Max-Age: 86400` reduces preflight round-trips

4. **Redirect blocking** — upstream redirects are intercepted (`redirect: "manual"`) and return `502` to prevent SSRF via redirect chains

5. **Header filtering** — only a narrow set of request headers are forwarded upstream (see "Notes on forwarded headers" below)

This means the worker is not a general-purpose CORS proxy.

### Customising allowlisted upstream hosts

If your Composio endpoint uses a different hostname (for example, a region-specific or custom domain), add it to `ALLOWED_TARGETS` in `src/index.js` and redeploy. Each entry maps a host to the path pattern it's restricted to — use `null` for "any path":

```js
const ALLOWED_TARGETS = new Map([
  ["mcp.composio.dev", null],
  ["backend.composio.dev", null],
  ["my-custom-composio-host.example.com", null],
  ["api.cloudflare.com", /^\/client\/v4\/accounts\/[^/]+\/browser-rendering\//],
  ["localhost", null],
  ["127.0.0.1", null],
]);
```

If you add a host, bump `PROXY_VERSION` too — Chief of Staff reads it from `/__capabilities` to decide whether your deployment is current.

To allow additional origins (e.g. a local dev server), edit the `ALLOWED_ORIGINS` array at the top of `src/index.js`:

```js
const ALLOWED_ORIGINS = [
  "https://roamresearch.com",
  "https://www.roamresearch.com",
  "http://localhost:3000",  // local dev
];
```

Then redeploy with `npx wrangler deploy`.

### Optional: shared secret header

For additional protection, you can require a secret header. Set a Cloudflare Worker secret:

```bash
npx wrangler secret put PROXY_SECRET
```

Then check it in the worker:

```js
// Change export to accept env:
export default {
  async fetch(request, env) {
    if (request.headers.get("x-proxy-secret") !== env.PROXY_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
    // ... rest of handler
  }
};
```

You would then need to add this header in the extension's transport fetch. This is an advanced setup and not required for basic use.

### Notes on forwarded headers

The worker forwards only a small allowlist of request headers (for example `Authorization`, `Content-Type`, `Accept`, MCP headers like `mcp-*`, and Composio headers like `x-composio-*`). It also rewrites the upstream `Origin` header to match the target URL.

This reduces accidental leakage and avoids proxy/header confusion issues.

### Redirect handling

The worker sets `redirect: "manual"` for upstream fetches and blocks redirects. This prevents an allowlisted hostname from redirecting the proxy to a non-allowlisted destination.

---

## Testing

The proxy has two test suites:

All 96 tests run via vitest in the Cloudflare Workers test pool:

```bash
npx vitest run
```

The test suite is split into two files:

- **`test/security.test.mjs`** — Pure-logic unit tests covering origin allowlist, target host allowlist, private IP detection, redirect status detection, local dev targets, CORS `getAllowedHeaders` validated echo, and CORS response headers. These re-declare the proxy's validation functions inline.
- **`test/index.spec.js`** — Integration tests using `@cloudflare/vitest-pool-workers` to test the full worker `fetch()` handler with synthetic requests.

---

## Updating

To deploy changes after editing `src/index.js`:

```bash
npx wrangler deploy
```

The worker URL stays the same — no need to update Chief of Staff settings.
