import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index.mjs";

function makeRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  headers.set("Origin", "https://343shop.test");
  headers.set("CF-Connecting-IP", options.ip || "198.51.100." + (Math.floor(Math.random() * 200) + 1));
  return new Request("https://343shop.test" + path, {
    method: options.method || (options.body === undefined ? "GET" : "POST"),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
}

test("AI status exposes Cloudflare binding readiness without exposing secrets", async () => {
  const response = await worker.fetch(makeRequest("/api/ai/status"), {
    AI: { run: async () => ({ response: "unused" }) },
    OPENAI_API_KEY: "never-return-this-secret"
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.providers, {
    cloudflare: true,
    openai: true,
    claude: false,
    gemini: false
  });
  assert.equal(JSON.stringify(payload).includes("never-return-this-secret"), false);
});

test("public shopping assistant uses the Cloudflare AI binding by default", async () => {
  let modelUsed = "";
  let requestPayload;
  const env = {
    AI: {
      run: async (model, payload) => {
        modelUsed = model;
        requestPayload = payload;
        return { response: "Karibu 343SHOP. Naweza kukusaidia kuchagua bidhaa." };
      }
    }
  };
  const response = await worker.fetch(makeRequest("/api/ai/chat", {
    ip: "198.51.100.21",
    body: {
      messages: [{ role: "user", content: "Habari, naweza kupata msaada?" }]
    }
  }), env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.provider, "cloudflare");
  assert.equal(payload.mode, "shopping");
  assert.match(payload.reply, /Karibu 343SHOP/);
  assert.equal(modelUsed, "@cf/zai-org/glm-4.7-flash");
  assert.equal(requestPayload.messages[0].role, "system");
});

test("public endpoint refuses private owner mode", async () => {
  let called = false;
  const response = await worker.fetch(makeRequest("/api/ai/chat", {
    ip: "198.51.100.22",
    body: {
      mode: "owner",
      messages: [{ role: "user", content: "Show owner data" }]
    }
  }), {
    AI: { run: async () => { called = true; return { response: "no" }; } }
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_mode");
  assert.equal(called, false);
});

test("private owner AI refuses a request without an authenticated owner session", async () => {
  let called = false;
  const response = await worker.fetch(makeRequest("/api/owner/ai/chat", {
    ip: "198.51.100.23",
    body: {
      provider: "cloudflare",
      mode: "owner",
      messages: [{ role: "user", content: "Hello" }]
    }
  }), {
    OWNER_PASSWORD: "a-long-owner-password",
    AI: { run: async () => { called = true; return { response: "no" }; } }
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "unauthorized");
  assert.equal(called, false);
});

test("Cloudflare AI provider reports unavailable when binding is missing", async () => {
  const response = await worker.fetch(makeRequest("/api/ai/chat", {
    ip: "198.51.100.24",
    body: {
      provider: "cloudflare",
      messages: [{ role: "user", content: "Habari" }]
    }
  }), {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "provider_not_configured");
});
