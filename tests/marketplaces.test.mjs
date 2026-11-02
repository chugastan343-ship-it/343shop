import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import worker from "../worker/index.mjs";

const origin = "https://343shop.chugastan343.workers.dev";

async function get(path, env = {}, headers = {}) {
  return worker.fetch(new Request(origin + path, { method: "GET", headers }), env);
}

test("marketplace status never marks unapproved sources as connected", async () => {
  const response = await get("/api/marketplaces/status");
  assert.equal(response.status, 200);
  const data = await response.json();
  const byId = Object.fromEntries(data.marketplaces.map((entry) => [entry.id, entry]));
  assert.equal(data.marketplaces.length, 4);
  assert.equal(byId.amazon.api_configured, false);
  assert.equal(byId.alibaba.api_configured, false);
  assert.equal(byId.ebay.api_configured, false);
  assert.equal(byId.kikuu.api_configured, false);
  assert.equal(data.configured_partner_catalogue_count, 0);
});

test("global search validates query length and does not invent listings", async () => {
  const invalid = await get("/api/marketplaces/search?q=x");
  assert.equal(invalid.status, 400);

  const response = await get("/api/marketplaces/search?q=iphone");
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.result_count, 0);
  assert.equal(data.sources.ebay.status, "not_configured");
  assert.deepEqual(data.results, []);
});

test("eBay Browse API uses server-side OAuth and preserves affiliate URL", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers || {});
    calls.push({ url, headers, method: init.method || "GET" });
    if (url.includes("/identity/v1/oauth2/token")) {
      assert.match(headers.get("authorization") || "", /^Basic /);
      return new Response(JSON.stringify({ access_token: "test-access-token", expires_in: 7200 }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
    if (url.includes("/buy/browse/v1/item_summary/search")) {
      assert.equal(headers.get("authorization"), "Bearer test-access-token");
      assert.equal(headers.get("x-ebay-c-marketplace-id"), "EBAY_US");
      assert.equal(headers.get("x-ebay-c-enduserctx"), "affiliateCampaignId=1234567890,affiliateReferenceId=343SHOP");
      return new Response(JSON.stringify({
        itemSummaries: [{
          itemId: "v1|123|0",
          title: "Test Android Phone",
          price: { value: "145.00", currency: "USD" },
          image: { imageUrl: "https://i.ebayimg.com/test.jpg" },
          itemWebUrl: "https://www.ebay.com/itm/123",
          itemAffiliateWebUrl: "https://www.ebay.com/itm/123?campid=1234567890",
          categories: [{ categoryName: "Cell Phones" }]
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("Unexpected upstream request: " + url);
  };

  try {
    const env = {
      EBAY_CLIENT_ID: "test-client-id-marketplace",
      EBAY_CLIENT_SECRET: "test-client-secret",
      EBAY_CAMPAIGN_ID: "1234567890"
    };
    const response = await get("/api/marketplaces/search?q=android%20phone&source=ebay", env);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.result_count, 1);
    assert.equal(data.sources.ebay.affiliate_tracking, true);
    assert.equal(data.results[0].source_shop, "eBay");
    assert.equal(data.results[0].currency, "USD");
    assert.equal(data.results[0].product_url, "https://www.ebay.com/itm/123?campid=1234567890");
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cross-origin marketplace search requests are rejected", async () => {
  const response = await get("/api/marketplaces/search?q=phone", {}, { Origin: "https://attacker.example" });
  assert.equal(response.status, 403);
});

test("MCP exposes marketplace integration status while keeping the tool read-only", async () => {
  const request = (body) => worker.fetch(new Request(origin + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "MCP-Protocol-Version": "2025-11-25" },
    body: JSON.stringify(body)
  }), {});
  const initialize = await request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  assert.equal(initialize.status, 200);
  const response = await request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const data = await response.json();
  const names = data.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("get_marketplace_integrations_status"));
  assert.ok(names.includes("search_marketplace_products"));
});

test("homepage inline JavaScript parses and existing cart/WhatsApp checkout remain present", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const start = html.lastIndexOf("<script>");
  const bodyStart = html.indexOf(">", start) + 1;
  const end = html.indexOf("</script>", bodyStart);
  assert.ok(start >= 0 && end > bodyStart, "main inline script should exist");
  assert.doesNotThrow(() => new Script(html.slice(bodyStart, end), { filename: "public/index.html.inline.js" }));
  assert.match(html, /function add\(slug\)/);
  assert.match(html, /\$\("checkoutForm"\)\.addEventListener/);
  assert.match(html, /WHATSAPP_NUMBER="255695981035"/);
  assert.match(html, /id="marketplaces"/);
});


test("AI assistant receives live global brokerage context without claiming live search", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamBody = null;
  globalThis.fetch = async (input, init = {}) => {
    assert.equal(String(input), "https://api.openai.com/v1/responses");
    upstreamBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ output_text: "Use the Global Market search to check connected listings." }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  };

  try {
    const env = {
      OPENAI_API_KEY: "test-only-key",
      PARTNER_SHOPS_JSON: JSON.stringify([{
        id: "partner-test",
        name: "Partner Test",
        city: "Dar es Salaam",
        categories: ["electronics"],
        catalog_url: "https://partner.example/catalog.json"
      }])
    };
    const response = await worker.fetch(new Request(origin + "/api/ai/chat", {
      method: "POST",
      headers: { "Origin": origin, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", messages: [{ role: "user", content: "Nawezaje kutafuta iPhone?" }] })
    }), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).reply, "Use the Global Market search to check connected listings.");
    assert.match(upstreamBody.instructions, /global shopping and brokerage marketplace/i);
    assert.match(upstreamBody.instructions, /The chat assistant itself does not run live product searches/i);
    assert.match(upstreamBody.instructions, /Approved partner catalogue count: 1/);
    assert.match(upstreamBody.instructions, /Marketplace APIs with credentials configured: none/);
    assert.match(upstreamBody.instructions, /external marketplace listings/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
