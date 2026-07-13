import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(targetUrl, { origin = "https://roamresearch.com", method = "GET" } = {}) {
  const proxyUrl = `https://proxy.test/${targetUrl}`;
  return new Request(proxyUrl, {
    method,
    headers: { Origin: origin, "Content-Type": "application/json" },
  });
}

async function fetchWorker(request) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

// ---------------------------------------------------------------------------
// 1. Origin allowlist
// ---------------------------------------------------------------------------

describe("Origin allowlist", () => {
  it("allows https://roamresearch.com", async () => {
    const res = await fetchWorker(makeRequest("https://mcp.composio.dev/foo", { origin: "https://roamresearch.com" }));
    expect(res.status).not.toBe(403);
  });

  it("allows https://www.roamresearch.com", async () => {
    const res = await fetchWorker(makeRequest("https://mcp.composio.dev/foo", { origin: "https://www.roamresearch.com" }));
    expect(res.status).not.toBe(403);
  });

  it("blocks unknown origin", async () => {
    const res = await fetchWorker(makeRequest("https://mcp.composio.dev/foo", { origin: "https://evil.com" }));
    expect(res.status).toBe(403);
  });

  it("blocks missing origin", async () => {
    const req = new Request("https://proxy.test/https://mcp.composio.dev/foo");
    // No Origin header at all
    const res = await fetchWorker(req);
    expect(res.status).toBe(403);
  });

  it("blocks http:// variant of roamresearch.com", async () => {
    const res = await fetchWorker(makeRequest("https://mcp.composio.dev/foo", { origin: "http://roamresearch.com" }));
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 2. Target host allowlist
// ---------------------------------------------------------------------------

describe("Target host allowlist", () => {
  it("allows mcp.composio.dev", async () => {
    const res = await fetchWorker(makeRequest("https://mcp.composio.dev/api/v1/tools"));
    expect(res.status).not.toBe(403);
  });

  it("allows backend.composio.dev", async () => {
    const res = await fetchWorker(makeRequest("https://backend.composio.dev/api/v1/auth"));
    expect(res.status).not.toBe(403);
  });

  it("allows localhost (http)", async () => {
    // Localhost passes the allowlist but fetch may fail with a network error
    // in the Workers test pool (nothing running on that port). Either outcome
    // — a non-403 response or a network error — proves the allowlist allowed it.
    try {
      const res = await fetchWorker(makeRequest("http://localhost:3000/test"));
      expect(res.status).not.toBe(403);
    } catch (e) {
      expect(e.message).toMatch(/network|connection|fetch/i);
    }
  });

  it("allows 127.0.0.1 (http)", async () => {
    try {
      const res = await fetchWorker(makeRequest("http://127.0.0.1:8080/test"));
      expect(res.status).not.toBe(403);
    } catch (e) {
      expect(e.message).toMatch(/network|connection|fetch/i);
    }
  });

  it("blocks arbitrary external host", async () => {
    const res = await fetchWorker(makeRequest("https://evil.com/steal-data"));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden target");
  });

  it("blocks api.openai.com (LLM traffic should NOT go through this proxy)", async () => {
    const res = await fetchWorker(makeRequest("https://api.openai.com/v1/chat/completions"));
    expect(res.status).toBe(403);
  });

  it("blocks api.anthropic.com", async () => {
    const res = await fetchWorker(makeRequest("https://api.anthropic.com/v1/messages"));
    expect(res.status).toBe(403);
  });

  it("blocks ftp:// protocol", async () => {
    const res = await fetchWorker(makeRequest("ftp://mcp.composio.dev/file"));
    // ftp:// is caught by the !startsWith("http") guard before isTargetAllowed(),
    // so the proxy returns 400 (bad request) rather than 403 (forbidden target).
    expect(res.status).toBe(400);
  });

  it("allows https:// to localhost (in ALLOWED_TARGET_HOSTS)", async () => {
    // localhost IS in ALLOWED_TARGET_HOSTS and https is a valid protocol,
    // so this passes the allowlist. Fetch may fail with a network error
    // in the Workers test pool — that's fine, proves allowlist didn't block it.
    try {
      const res = await fetchWorker(makeRequest("https://localhost:3000/test"));
      expect(res.status).not.toBe(403);
    } catch (e) {
      expect(e.message).toMatch(/network|connection|fetch/i);
    }
  });

  it("blocks http:// to non-local host (Composio must be https)", async () => {
    const res = await fetchWorker(makeRequest("http://mcp.composio.dev/api"));
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 2b. Credential-bearing targets are path-locked
// ---------------------------------------------------------------------------

describe("Path-locked targets", () => {
  // A request that clears the allowlist still reaches the real upstream, which
  // may answer 401/403/405 to an unauthenticated probe (chatgpt.com answers 403)
  // or fail to connect in the test pool. So status alone cannot tell "we blocked
  // it" from "upstream rejected it" — the "Forbidden target" body is the only
  // reliable marker of a block by this proxy.
  async function expectAllowed(targetUrl) {
    try {
      const res = await fetchWorker(makeRequest(targetUrl, { method: "POST" }));
      expect(await res.text()).not.toBe("Forbidden target");
    } catch (e) {
      expect(e.message).toMatch(/network|connection|fetch/i);
    }
  }

  it("blocks chatgpt.com — a Worker cannot proxy it (Cf-Worker header → OpenAI WAF 403)", async () => {
    // Not an oversight. See the comment on ALLOWED_TARGETS in src/index.js.
    const res = await fetchWorker(makeRequest("https://chatgpt.com/backend-api/codex/responses", { method: "POST" }));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden target");
  });

  it("allows api.cloudflare.com on the browser-rendering path", async () => {
    await expectAllowed("https://api.cloudflare.com/client/v4/accounts/abc123/browser-rendering/markdown");
  });

  it("blocks api.cloudflare.com outside browser-rendering", async () => {
    // The user's Cloudflare API token must not be usable against the rest of
    // their account (zones, DNS, workers).
    const res = await fetchWorker(makeRequest("https://api.cloudflare.com/client/v4/accounts/abc123/workers/scripts", { method: "POST" }));
    expect(res.status).toBe(403);
  });

  it("still blocks api.openai.com (LLM traffic does not belong here)", async () => {
    const res = await fetchWorker(makeRequest("https://api.openai.com/v1/chat/completions", { method: "POST" }));
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 2c. Capability probe
// ---------------------------------------------------------------------------

describe("GET /__capabilities", () => {
  it("reports version and allowed targets", async () => {
    const req = new Request("https://proxy.test/__capabilities", {
      headers: { Origin: "https://roamresearch.com" },
    });
    const res = await fetchWorker(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.version).toBeGreaterThanOrEqual(2);
    expect(body.targets).toContain("api.cloudflare.com");
    expect(body.targets).not.toContain("chatgpt.com");
    expect(body.targets).toContain("mcp.composio.dev");
  });

  it("is readable cross-origin (CORS headers present)", async () => {
    // Without these the caller's fetch throws and it cannot tell a current
    // proxy apart from an outdated one.
    const req = new Request("https://proxy.test/__capabilities", {
      headers: { Origin: "https://roamresearch.com" },
    });
    const res = await fetchWorker(req);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://roamresearch.com");
  });

  it("is not reachable from a foreign origin", async () => {
    const req = new Request("https://proxy.test/__capabilities", {
      headers: { Origin: "https://evil.com" },
    });
    const res = await fetchWorker(req);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 3. Redirect blocking (SSRF defence)
// ---------------------------------------------------------------------------

describe("Redirect blocking", () => {
  // We can't easily mock fetch in the Workers runtime, but we can verify
  // the proxy doesn't follow redirects by checking the `redirect: "manual"`
  // behaviour. The actual redirect-blocking logic is tested via the code path
  // in isRedirectStatus(). We test that the target allowlist prevents
  // redirect-based SSRF at the entry point.

  it("blocks target that could redirect to internal service", async () => {
    // An attacker might try to redirect through an allowed host to an internal one.
    // The proxy uses `redirect: "manual"` and returns 502 on any redirect status.
    // We verify the allowlist blocks direct internal targets:
    const res = await fetchWorker(makeRequest("https://internal-service.example.com/admin"));
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 4. SSE probe interception (/tool_router/ GET → 204)
// ---------------------------------------------------------------------------

describe("SSE probe interception", () => {
  it("returns 204 for GET /tool_router/ on Composio", async () => {
    const res = await fetchWorker(makeRequest("https://mcp.composio.dev/tool_router/foo", { method: "GET" }));
    expect(res.status).toBe(204);
  });

  it("does NOT intercept POST to /tool_router/", async () => {
    const res = await fetchWorker(makeRequest("https://mcp.composio.dev/tool_router/foo", { method: "POST" }));
    // POST should pass through to upstream (not be intercepted as 204)
    expect(res.status).not.toBe(204);
  });
});

// ---------------------------------------------------------------------------
// 5. CORS headers
// ---------------------------------------------------------------------------

describe("CORS headers", () => {
  it("OPTIONS preflight returns CORS headers", async () => {
    const req = makeRequest("https://mcp.composio.dev/api", { method: "OPTIONS" });
    const res = await fetchWorker(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://roamresearch.com");
  });

  it("echoes correct origin in CORS header", async () => {
    const req = makeRequest("https://mcp.composio.dev/api", { origin: "https://www.roamresearch.com", method: "OPTIONS" });
    const res = await fetchWorker(req);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://www.roamresearch.com");
  });

  it("403 responses include CORS headers for blocked targets", async () => {
    const res = await fetchWorker(makeRequest("https://evil.com/steal"));
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
  });

  it("400 responses include CORS headers", async () => {
    // Without CORS headers the browser reports an opaque CORS failure instead
    // of the actual reason, which is indistinguishable from the proxy being down.
    const req = new Request("https://proxy.test/not-a-url", {
      headers: { Origin: "https://roamresearch.com" },
    });
    const res = await fetchWorker(req);
    expect(res.status).toBe(400);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
  });

});

// ---------------------------------------------------------------------------
// 6. Malformed input
// ---------------------------------------------------------------------------

describe("Malformed input", () => {
  it("rejects non-http target URL", async () => {
    const req = new Request("https://proxy.test/not-a-url", {
      headers: { Origin: "https://roamresearch.com" },
    });
    const res = await fetchWorker(req);
    expect(res.status).toBe(400);
  });

  it("rejects empty path", async () => {
    const req = new Request("https://proxy.test/", {
      headers: { Origin: "https://roamresearch.com" },
    });
    const res = await fetchWorker(req);
    expect(res.status).toBe(400);
  });
});
