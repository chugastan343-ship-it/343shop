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

test("MCP exposes marketplace discovery and owner-authenticated product management tools", async () => {
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
  assert.ok(names.includes("save_product_draft"));
  assert.ok(names.includes("list_product_drafts"));
  assert.ok(names.includes("publish_store_product"));
  const saveTool = data.result.tools.find((tool) => tool.name === "save_product_draft");
  assert.equal(saveTool.annotations.readOnlyHint, false);
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


function makeProductD1Mock() {
  const rows = [];
  let schemaStatements = 0;
  return {
    rows,
    get schemaStatements() { return schemaStatements; },
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async run() {
          if (/^\\s*CREATE TABLE IF NOT EXISTS store_products/i.test(sql) ||
              /^\\s*CREATE INDEX IF NOT EXISTS idx_store_products_/i.test(sql)) {
            schemaStatements += 1;
            return { success: true, meta: { changes: 0 } };
          }
          if (sql.includes("INSERT INTO store_products")) {
            if (rows.some(row => row.source_url === values[7])) throw new Error("UNIQUE constraint failed: store_products.source_url");
            rows.push({
              id: values[0], slug: values[1], product_name: values[2], description: values[3],
              category: values[4], source_marketplace: values[5], source_seller: values[6],
              source_url: values[7], source_price: values[8], currency: values[9], image_url: values[10],
              availability: values[11], status: "draft", created_at: values[12], updated_at: values[13], published_at: null
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE store_products SET status = 'published'")) {
            const row = rows.find(item => item.id === values[2] && item.status === "draft");
            if (!row) return { success: true, meta: { changes: 0 } };
            row.status = "published"; row.updated_at = values[0]; row.published_at = values[1];
            return { success: true, meta: { changes: 1 } };
          }
          throw new Error("Unexpected mock D1 run: " + sql);
        },
        async first() {
          if (sql.includes("FROM store_products WHERE id = ?")) {
            return rows.find(item => item.id === values[0]) || null;
          }
          throw new Error("Unexpected mock D1 first: " + sql);
        },
        async all() {
          if (sql.includes("WHERE status = 'draft'")) {
            return { results: rows.filter(item => item.status === "draft").slice(0, values[0]) };
          }
          if (sql.includes("WHERE status = 'published'")) {
            return { results: rows.filter(item => item.status === "published").slice(0, 60) };
          }
          throw new Error("Unexpected mock D1 all: " + sql);
        }
      };
    }
  };
}

async function callMcpTool(name, args, env, token) {
  const headers = { "content-type": "application/json", "MCP-Protocol-Version": "2025-11-25" };
  if (token) headers.Authorization = "Bearer " + token;
  const response = await worker.fetch(new Request(origin + "/mcp", {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name, arguments: args } })
  }), env);
  const payload = await response.json();
  return { response, payload, result: payload.result };
}

test("MCP product writes are blocked without the owner token", async () => {
  const DB = makeProductD1Mock();
  const env = { DB, MCP_WRITE_TOKEN: "test-owner-write-token" };
  const result = await callMcpTool("save_product_draft", {
    product_name: "Wireless Headphones", description: "Bluetooth headphones listed by the source seller.",
    category: "electronics", source_marketplace: "Supplier Demo",
    source_url: "https://seller.example/products/headphones", source_price: 25, currency: "USD"
  }, env);
  assert.equal(result.response.status, 200);
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /owner_authorization_required/);
  assert.equal(DB.rows.length, 0);
});

test("owner can save, review and explicitly publish a sourced product draft", async () => {
  const DB = makeProductD1Mock();
  const env = { DB, MCP_WRITE_TOKEN: "test-owner-write-token" };
  const token = env.MCP_WRITE_TOKEN;
  const saved = await callMcpTool("save_product_draft", {
    product_name: "Wireless Headphones", description: "Bluetooth headphones listed by the source seller.",
    category: "electronics", source_marketplace: "Supplier Demo", source_seller: "Demo Seller",
    source_url: "https://seller.example/products/headphones", source_price: 25, currency: "USD",
    image_url: "https://seller.example/images/headphones.jpg", availability: "unknown"
  }, env, token);
  assert.equal(saved.result.isError, false);
  const draft = JSON.parse(saved.result.content[0].text);
  assert.equal(draft.status, "draft_saved");
  assert.equal(draft.published, false);
  assert.equal(DB.rows[0].status, "draft");
  assert.equal(DB.schemaStatements, 3, "the Worker should create the table and both indexes automatically");

  const listed = await callMcpTool("list_product_drafts", { limit: 10 }, env, token);
  assert.equal(listed.result.isError, false);
  assert.equal(JSON.parse(listed.result.content[0].text).draft_count, 1);

  const refused = await callMcpTool("publish_store_product", {
    product_id: draft.product.id, confirmation_phrase: "PUBLISH",
    owner_confirmed_source_rights: true, owner_confirmed_price_and_stock: true,
    owner_confirmed_seller_terms: true, owner_confirmed_image_rights: false
  }, env, token);
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /image usage rights/);
  assert.equal(DB.rows[0].status, "draft");

  const published = await callMcpTool("publish_store_product", {
    product_id: draft.product.id, confirmation_phrase: "PUBLISH",
    owner_confirmed_source_rights: true, owner_confirmed_price_and_stock: true,
    owner_confirmed_seller_terms: true, owner_confirmed_image_rights: true
  }, env, token);
  assert.equal(published.result.isError, false);
  assert.equal(JSON.parse(published.result.content[0].text).status, "published");

  const publicResponse = await get("/api/store/products", env);
  assert.equal(publicResponse.status, 200);
  const publicData = await publicResponse.json();
  assert.equal(publicData.products.length, 1);
  assert.equal(publicData.products[0].product_name, "Wireless Headphones");
  assert.equal(publicData.products[0].source_url, "https://seller.example/products/headphones");
});

test("product drafts reject unsafe source links and duplicate source URLs", async () => {
  const DB = makeProductD1Mock();
  const env = { DB, MCP_WRITE_TOKEN: "test-owner-write-token" };
  const token = env.MCP_WRITE_TOKEN;
  const base = {
    product_name: "Wireless Headphones", description: "Bluetooth headphones listed by the source seller.",
    category: "electronics", source_marketplace: "Supplier Demo",
    source_url: "https://seller.example/products/headphones", source_price: 25, currency: "USD"
  };
  const unsafe = await callMcpTool("save_product_draft", { ...base, source_url: "http://seller.example/product" }, env, token);
  assert.equal(unsafe.result.isError, true);
  assert.match(unsafe.result.content[0].text, /valid HTTPS/);
  const first = await callMcpTool("save_product_draft", base, env, token);
  assert.equal(first.result.isError, false);
  const duplicate = await callMcpTool("save_product_draft", base, env, token);
  assert.equal(duplicate.result.isError, true);
  assert.match(duplicate.result.content[0].text, /duplicate_product_source/);
});

test("public sourced-product endpoint stays unavailable until D1 is configured", async () => {
  const response = await get("/api/store/products");
  assert.equal(response.status, 503);
  const status = await get("/api/mcp/status");
  const data = await status.json();
  assert.equal(data.product_database_configured, false);
  assert.equal(data.writes_enabled, false);
});
