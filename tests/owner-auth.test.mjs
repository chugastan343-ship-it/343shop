import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index.mjs";

const origin = "https://343shop.chugastan343.workers.dev";
const ownerPassword = "Mango-River-343SHOP-Owner-Access-2026!";

class FakeD1 {
  prepare() {
    return {
      bind() { return this; },
      async run() { return { meta: { changes: 1 } }; },
      async all() { return { results: [] }; },
      async first() { return null; }
    };
  }
}

async function login(password, env, ip = "198.51.100.31", requestOrigin = origin) {
  return worker.fetch(new Request(origin + "/api/admin/login", {
    method: "POST",
    headers: {
      Origin: requestOrigin,
      "Content-Type": "application/json",
      "CF-Connecting-IP": ip
    },
    body: JSON.stringify({ password })
  }), env);
}

test("owner password login issues a secure HttpOnly session without using the MCP write token", async () => {
  const env = { OWNER_PASSWORD: ownerPassword, DB: new FakeD1() };
  const response = await login(ownerPassword, env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie") || "", /343shop_owner_session=/);
  assert.match(response.headers.get("set-cookie") || "", /HttpOnly/);
  assert.match(response.headers.get("set-cookie") || "", /Secure/);
  assert.match(response.headers.get("set-cookie") || "", /SameSite=Strict/);
  assert.doesNotMatch(response.headers.get("set-cookie") || "", /MCP_WRITE_TOKEN/);

  const cookie = (response.headers.get("set-cookie") || "").split(";")[0];
  const dashboard = await worker.fetch(new Request(origin + "/api/admin/status", {
    headers: { Cookie: cookie }
  }), env);
  assert.equal(dashboard.status, 200);
  assert.equal((await dashboard.json()).owner_authenticated, true);
});

test("owner dashboard rejects a wrong password", async () => {
  const response = await login("not-the-owner-password", { OWNER_PASSWORD: ownerPassword, DB: new FakeD1() }, "198.51.100.32");
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "invalid_owner_password");
  assert.equal(response.headers.get("set-cookie"), null);
});

test("owner login requires a same-origin browser request", async () => {
  const response = await login(ownerPassword, { OWNER_PASSWORD: ownerPassword }, "198.51.100.33", "https://attacker.example");
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "origin_not_allowed");
});

test("owner login requires a separate OWNER_PASSWORD secret of at least 8 characters", async () => {
  const missing = await login(ownerPassword, { MCP_WRITE_TOKEN: "existing-mcp-secret" }, "198.51.100.34");
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).error, "owner_password_not_configured");

  const short = await login("1234567", { OWNER_PASSWORD: "1234567" }, "198.51.100.35");
  assert.equal(short.status, 503);
  assert.equal((await short.json()).error, "owner_password_too_short");

  const eightChars = "12345678";
  const accepted = await login(eightChars, { OWNER_PASSWORD: eightChars }, "198.51.100.36");
  assert.equal(accepted.status, 200);
});

test("owner logout expires the session cookie", async () => {
  const response = await worker.fetch(new Request(origin + "/api/admin/logout", {
    method: "POST",
    headers: { Origin: origin }
  }), {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie") || "", /Max-Age=0/);
  assert.match(response.headers.get("set-cookie") || "", /HttpOnly/);
});

test("dashboard password cannot authorize AI MCP write tools", async () => {
  const response = await worker.fetch(new Request(origin + "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "save_product_draft", arguments: {} }
    })
  }), { OWNER_PASSWORD: ownerPassword });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.result.isError, true);
  assert.match(payload.result.content[0].text, /owner_authorization_required/);
});
