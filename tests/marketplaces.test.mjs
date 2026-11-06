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
  assert.equal(data.marketplaces.length, 5);
  assert.equal(byId.amazon.api_configured, false);
  assert.equal(byId.alibaba.api_configured, false);
  assert.equal(byId.shopify.api_configured, false);
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


test("marketplace connectivity probe separates eBay host from a control host", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method });
    if (url === "https://api.sandbox.ebay.com/identity/v1/oauth2/token" && init.method === "POST") {
      const headers = new Headers(init.headers || {});
      assert.match(headers.get("authorization") || "", /^Basic /);
      assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
      assert.match(String(init.body), /grant_type=client_credentials/);
      return new Response(JSON.stringify({ error: "invalid_client" }), {
        status: 401, headers: { "content-type": "application/json" }
      });
    }
    if (url === "https://api.sandbox.ebay.com/identity/v1/oauth2/token" && init.method === "GET") {
      return new Response("method not allowed", { status: 405 });
    }
    if (url === "https://example.com/") {
      return new Response("ok", { status: 200 });
    }
    throw new Error("Unexpected diagnostic destination");
  };

  try {
    const response = await get("/api/marketplaces/connectivity", {
      EBAY_SANDBOX_CLIENT_ID: "test-sandbox-id",
      EBAY_SANDBOX_CLIENT_SECRET: "test-sandbox-secret"
    });
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.equal(data.environment, "sandbox");
    assert.deepEqual(data.probes.ebay_api_host, { reachable: true, http_status: 405 });
    assert.deepEqual(data.probes.ebay_oauth_post, { reachable: true, http_status: 401 });
    assert.deepEqual(data.probes.external_control_host, { reachable: true, http_status: 200 });
    assert.equal(calls.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("eBay Sandbox credentials use Sandbox OAuth and Browse API endpoints", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("api.sandbox.ebay.com/identity/v1/oauth2/token")) {
      const headers = new Headers(init.headers || {});
      assert.match(headers.get("authorization") || "", /^Basic /);
      return new Response(JSON.stringify({ access_token: "sandbox-test-token", expires_in: 7200 }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
    if (url.includes("api.sandbox.ebay.com/buy/browse/v1/item_summary/search")) {
      const headers = new Headers(init.headers || {});
      assert.equal(headers.get("authorization"), "Bearer sandbox-test-token");
      assert.equal(headers.get("x-ebay-c-marketplace-id"), "EBAY_US");
      return new Response(JSON.stringify({
        itemSummaries: [{
          itemId: "v1|sandbox-123|0",
          title: "Sandbox Android Phone",
          price: { value: "99.00", currency: "USD" },
          itemWebUrl: "https://sandbox.ebay.com/itm/sandbox-123",
          categories: [{ categoryName: "Cell Phones" }]
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("Unexpected endpoint for Sandbox environment: " + url);
  };

  try {
    const env = {
      // With both keysets present and no explicit selector, Sandbox must be the safe default.
      EBAY_SANDBOX_CLIENT_ID: "sandbox-client-id",
      EBAY_SANDBOX_CLIENT_SECRET: "sandbox-client-secret",
      EBAY_CLIENT_ID: "production-client-id",
      EBAY_CLIENT_SECRET: "production-client-secret"
    };
    const response = await get("/api/marketplaces/search?q=android%20phone&source=ebay", env);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.sources.ebay.status, "available");
    assert.equal(data.result_count, 1);
    assert.equal(data.results[0].name, "Sandbox Android Phone");
    assert.equal(data.results[0].source_shop, "eBay");
    assert.ok(calls.every(url => url.includes("api.sandbox.ebay.com")));
    const status = await get("/api/marketplaces/status", env);
    const statusData = await status.json();
    const ebay = statusData.marketplaces.find(item => item.id === "ebay");
    assert.equal(ebay.environment, "sandbox");
    assert.equal(ebay.api_configured, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("eBay Sandbox returns a safe OAuth failure code without exposing credentials", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.match(String(input), /^https:\/\/api\.sandbox\.ebay\.com\/identity\/v1\/oauth2\/token$/);
    return new Response(JSON.stringify({ error: "invalid_client", error_description: "Credentials are invalid." }), {
      status: 401, headers: { "content-type": "application/json" }
    });
  };

  try {
    const response = await get("/api/marketplaces/search?q=android%20phone&source=ebay", {
      EBAY_ENVIRONMENT: "sandbox",
      EBAY_SANDBOX_CLIENT_ID: "diagnostic-client-id",
      EBAY_SANDBOX_CLIENT_SECRET: "diagnostic-client-secret"
    });
    const data = await response.json();
    assert.equal(data.sources.ebay.status, "temporarily_unavailable");
    assert.equal(data.sources.ebay.error_code, "ebay_oauth_http_401");
    assert.equal(JSON.stringify(data).includes("diagnostic-client-secret"), false);
    assert.equal(JSON.stringify(data).includes("Credentials are invalid"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("eBay Sandbox identifies OAuth network failures without exposing secrets", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("simulated network failure");
  };

  try {
    const response = await get("/api/marketplaces/search?q=android%20phone&source=ebay", {
      EBAY_ENVIRONMENT: "sandbox",
      EBAY_SANDBOX_CLIENT_ID: "diagnostic-client-id",
      EBAY_SANDBOX_CLIENT_SECRET: "diagnostic-client-secret"
    });
    const data = await response.json();
    assert.equal(data.sources.ebay.status, "temporarily_unavailable");
    assert.equal(data.sources.ebay.error_code, "ebay_oauth_network_error");
    assert.equal(JSON.stringify(data).includes("diagnostic-client-secret"), false);
    assert.equal(JSON.stringify(data).includes("simulated network failure"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
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


test("mobile navigation exposes all main sections and supports accessible open/close controls", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="mobileMenuBtn"[^>]*aria-controls="mobileMenu"[^>]*aria-expanded="false"/);
  assert.match(html, /<nav class="mobile-menu" id="mobileMenu"[^>]*aria-hidden="true"/);
  for (const section of ["departments", "marketplaces", "shop", "about", "partners", "contact"]) {
    assert.match(html, new RegExp('href="#' + section + '"'));
  }
  assert.match(html, /function setMobileMenu\(open\)/);
  assert.match(html, /setMobileMenu\(false\)/);
  assert.match(html, /\.mobile-menu\.is-open\{display:grid/);
});

test("343SHOP-owned storefront catalogue contains only its books and never invents delivery charges", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const start = html.indexOf("const PRODUCTS=[");
  const end = html.indexOf("\n];", start);
  assert.ok(start >= 0 && end > start);
  const catalogue = html.slice(start, end);
  assert.equal((catalogue.match(/slug:/g) || []).length, 3);
  assert.match(catalogue, /storybook-baraka/);
  assert.match(catalogue, /author-paperback/);
  assert.match(catalogue, /custom-story-ebook/);
  assert.doesNotMatch(catalogue, /custom-photo-print|canvas-wall-art|logo-design-pack|brand-kit|custom-photo-mug|personalized-comfort-tee|memory-phone-case|content-pack-social/);
  assert.match(html, /OWNED BY 343SHOP/);
  assert.match(html, /Vitabu na scripts zetu/);
  assert.doesNotMatch(html, /FREE_SHIPPING|SHIPPING=6\.99|Complimentary/);
  assert.match(html, /Delivery: To be confirmed before order/);
});

test("MCP owned-book search excludes independent seller products", async () => {
  const own = await callMcpTool("search_marketplace_products", { query: "storybook", source: "343shop" }, {});
  assert.equal(own.result.isError, false);
  const ownData = JSON.parse(own.result.content[0].text);
  assert.equal(ownData.result_count, 1);
  assert.equal(ownData.results[0].source_shop_id, "343shop");
  assert.equal(ownData.results[0].category, "books");
  const external = await callMcpTool("search_marketplace_products", { query: "phone case", source: "343shop" }, {});
  assert.equal(external.result.isError, false);
  const externalData = JSON.parse(external.result.content[0].text);
  assert.equal(externalData.result_count, 0);
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
    assert.match(upstreamBody.instructions, /In Product Finder mode, the Worker supplies a verified search snapshot/i);
    assert.match(upstreamBody.instructions, /Approved partner catalogue count: 1/);
    assert.match(upstreamBody.instructions, /Marketplace APIs with credentials configured: none/);
    assert.match(upstreamBody.instructions, /external marketplace listings/i);
    assert.match(upstreamBody.instructions, /owns its original books and original scripts/i);
    assert.match(upstreamBody.instructions, /External listings must never be added to the 343SHOP-owned books\/scripts checkout bag/i);
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
          if (/^\s*CREATE TABLE IF NOT EXISTS store_products/i.test(sql) ||
              /^\s*CREATE INDEX IF NOT EXISTS idx_store_products_/i.test(sql)) {
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
test("Shopify Storefront API search is server-side and preserves source attribution", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    assert.equal(String(input), "https://sample-store.myshopify.com/api/2026-10/graphql.json");
    const headers = new Headers(init.headers || {});
    assert.equal(headers.get("x-shopify-storefront-access-token"), "storefront-test-token");
    assert.equal(init.method, "POST");
    return new Response(JSON.stringify({
      data: { search: { nodes: [{
        id: "gid://shopify/Product/1",
        title: "Cotton T-Shirt",
        description: "Supplier product",
        productType: "Apparel",
        onlineStoreUrl: "https://sample-store.myshopify.com/products/cotton-shirt",
        featuredImage: { url: "https://cdn.shopify.com/s/files/1/shirt.jpg", altText: "shirt" },
        priceRange: { minVariantPrice: { amount: "12.50", currencyCode: "USD" } },
        availableForSale: true
      }] } }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const response = await get("/api/marketplaces/search?q=cotton%20shirt&source=shopify", {
      SHOPIFY_STORE_DOMAIN: "sample-store.myshopify.com",
      SHOPIFY_STOREFRONT_ACCESS_TOKEN: "storefront-test-token"
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.result_count, 1);
    assert.equal(data.results[0].source_shop_id, "shopify-shopify-store");
    assert.equal(data.results[0].name, "Cotton T-Shirt");
    assert.equal(data.results[0].price, 12.5);
    assert.equal(data.sources.shopify.status, "available");
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});



test("Amazon Creators API uses regional OAuth credentials and returns attributed SearchItems", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://api.amazon.co.uk/auth/o2/token") {
      assert.equal(init.method, "POST");
      assert.equal(new Headers(init.headers).get("content-type"), "application/json");
      const body = JSON.parse(init.body);
      assert.equal(body.client_id, "amazon-test-client");
      assert.equal(body.scope, "creatorsapi::default");
      return new Response(JSON.stringify({ access_token: "amazon-test-token", expires_in: 3600 }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
    if (url === "https://creatorsapi.amazon/catalog/v1/searchItems") {
      const headers = new Headers(init.headers);
      assert.equal(headers.get("authorization"), "Bearer amazon-test-token");
      assert.equal(headers.get("x-marketplace"), "www.amazon.co.uk");
      const body = JSON.parse(init.body);
      assert.equal(body.keywords, "android phone");
      assert.equal(body.marketplace, "www.amazon.co.uk");
      assert.equal(body.partnerTag, "343shop-21");
      assert.equal(body.itemCount, 10);
      return new Response(JSON.stringify({
        searchResult: { items: [{
          asin: "B000343SHOP",
          detailPageURL: "https://www.amazon.co.uk/dp/B000343SHOP?tag=343shop-21",
          itemInfo: {
            title: { displayValue: "Android Phone" },
            features: { displayValues: ["Unlocked", "128GB"] }
          },
          images: { primary: { medium: { url: "https://m.media-amazon.com/images/phone.jpg" } } },
          offersV2: { listings: [{
            price: { money: { amount: 199.99, currency: "GBP" } },
            availability: { type: "IN_STOCK" }
          }] }
        }] }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("Unexpected Amazon endpoint: " + url);
  };
  try {
    const env = {
      AMAZON_CREATORS_CLIENT_ID: "amazon-test-client",
      AMAZON_CREATORS_CLIENT_SECRET: "amazon-test-secret",
      AMAZON_PARTNER_TAG: "343shop-21",
      AMAZON_MARKETPLACE: "www.amazon.co.uk",
      AMAZON_CREATORS_CREDENTIAL_VERSION: "3.2"
    };
    const response = await get("/api/marketplaces/search?q=android%20phone&source=amazon", env);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.result_count, 1);
    assert.equal(data.sources.amazon.status, "available");
    assert.equal(data.results[0].source_shop_id, "amazon");
    assert.equal(data.results[0].name, "Android Phone");
    assert.equal(data.results[0].price, 199.99);
    assert.equal(data.results[0].currency, "GBP");
    assert.equal(data.results[0].availability, "in_stock");
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Amazon Creators API rejects an unapproved marketplace hostname before network access", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("should not call network"); };
  try {
    const response = await get("/api/marketplaces/search?q=phone&source=amazon", {
      AMAZON_CREATORS_CLIENT_ID: "bad-market-client",
      AMAZON_CREATORS_CLIENT_SECRET: "amazon-test-secret",
      AMAZON_PARTNER_TAG: "343shop-21",
      AMAZON_MARKETPLACE: "attacker.example"
    });
    const data = await response.json();
    assert.equal(data.sources.amazon.status, "invalid_marketplace_config");
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Shopify multi-store search uses private/public token headers and preserves each seller", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers || {});
    calls.push(url);
    assert.equal(init.method, "POST");
        assert.match(String(JSON.parse(init.body).query), /types: \[PRODUCT\]/);
    if (url.includes("private-store.myshopify.com")) {
      assert.equal(headers.get("shopify-storefront-private-token"), "private-storefront-token");
      assert.equal(headers.get("shopify-storefront-buyer-ip"), "203.0.113.8");
    } else if (url.includes("public-store.myshopify.com")) {
      assert.equal(headers.get("x-shopify-storefront-access-token"), "public-storefront-token");
    } else {
      throw new Error("Unexpected Shopify store URL: " + url);
    }
    const domain = new URL(url).hostname;
    return new Response(JSON.stringify({
      data: { search: { nodes: [{
        id: "gid://shopify/Product/" + domain,
        title: domain === "private-store.myshopify.com" ? "Private Store Mug" : "Public Store Mug",
        description: "Partner product",
        productType: "Homeware",
        onlineStoreUrl: "https://" + domain + "/products/mug",
        featuredImage: { url: "https://cdn.shopify.com/s/files/1/mug.jpg", altText: "mug" },
        priceRange: { minVariantPrice: { amount: "8.00", currencyCode: "USD" } },
        availableForSale: true
      }] } }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const env = {
      SHOPIFY_PARTNER_STORES_JSON: JSON.stringify([
        { id: "merchant-a", name: "Merchant A", domain: "private-store.myshopify.com", private_access_token: "private-storefront-token" },
        { id: "merchant-b", name: "Merchant B", domain: "public-store.myshopify.com", public_access_token: "public-storefront-token" }
      ])
    };
    const response = await get("/api/marketplaces/search?q=mug&source=shopify", env, { "CF-Connecting-IP": "203.0.113.8" });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.result_count, 2);
    assert.equal(data.sources.shopify.store_count, 2);
    assert.deepEqual(data.results.map(item => item.source_shop).sort(), ["Merchant A", "Merchant B"]);
    assert.ok(calls.some(url => url.includes("private-store.myshopify.com")));
    assert.ok(calls.some(url => url.includes("public-store.myshopify.com")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Alibaba search only includes explicitly seller-authorised GGS partner catalogues", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://seller-authorized.example/catalog.json") {
      return new Response(JSON.stringify({ products: [{
        id: "alibaba-supplier-1", name: "Wholesale Cotton Fabric",
        description: "Fabric sourced from authorised GGS seller",
        category: "Textiles", price: 3.5, currency: "USD",
        availability: "unknown", url: "https://www.alibaba.com/product-detail/fabric_123.html"
      }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "https://seller-not-authorized.example/catalog.json") {
      throw new Error("Unauthorised seller feed must not be fetched");
    }
    throw new Error("Unexpected seller feed URL: " + url);
  };
  try {
    const env = {
      PARTNER_SHOPS_JSON: JSON.stringify([
        { id: "alibaba-approved", name: "Approved GGS Seller", marketplace: "alibaba", seller_authorized: true, catalog_url: "https://seller-authorized.example/catalog.json" },
        { id: "alibaba-pending", name: "Pending GGS Seller", marketplace: "alibaba", seller_authorized: false, catalog_url: "https://seller-not-authorized.example/catalog.json" }
      ])
    };
    const response = await get("/api/marketplaces/search?q=cotton%20fabric&source=alibaba", env);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.result_count, 1);
    assert.equal(data.sources.alibaba.count, 1);
    assert.equal(data.results[0].source_marketplace, "Alibaba.com");
    assert.equal(data.results[0].source_shop_id, "alibaba-approved");
    assert.equal(calls.length, 1);
    const statusResponse = await get("/api/marketplaces/status", env);
    const status = await statusResponse.json();
    const alibaba = status.marketplaces.find(item => item.id === "alibaba");
    assert.equal(alibaba.authorized_seller_catalogue_count, 1);
    assert.equal(alibaba.api_configured, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("Gemini API status and chat use server-side secret with the official GenerateContent endpoint", async () => {
  const statusMissing = await get("/api/ai/status");
  assert.deepEqual(await statusMissing.json(), {
    providers: { cloudflare: false, openai: false, claude: false, gemini: false }
  });

  const statusReady = await get("/api/ai/status", { GEMINI_API_KEY: "gemini-test-secret" });
  assert.deepEqual(await statusReady.json(), {
    providers: { cloudflare: false, openai: false, claude: false, gemini: true }
  });

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    assert.equal(String(input), "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    const headers = new Headers(init.headers || {});
    assert.equal(headers.get("x-goog-api-key"), "gemini-test-secret");
    assert.equal(headers.get("content-type"), "application/json");
    const body = JSON.parse(init.body);
    assert.match(body.systemInstruction.parts[0].text, /343SHOP global shopping and brokerage marketplace assistant/);
    assert.deepEqual(body.contents, [
      { role: "user", parts: [{ text: "Habari 343SHOP" }] }
    ]);
    assert.equal(body.generationConfig.maxOutputTokens, 500);
    assert.deepEqual(body.generationConfig, { maxOutputTokens: 500 }, "Gemini 3.8 Flash should not receive deprecated sampling parameters");
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Karibu 343SHOP." }] } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const response = await worker.fetch(new Request(origin + "/api/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "gemini", messages: [{ role: "user", content: "Habari 343SHOP" }] })
    }), { GEMINI_API_KEY: "gemini-test-secret" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { reply: "Karibu 343SHOP.", provider: "gemini", mode: "shopping" });
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("private owner APIs require an owner password session and the public first-party shelf waits for D1", async () => {
  const missing = await get("/api/admin/status");
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).error, "owner_password_not_configured");

  const ownerPassword = "Owner-Password-For-343SHOP-Tests-2026!";
  const env = { OWNER_PASSWORD: ownerPassword };
  const invalid = await worker.fetch(new Request(origin + "/api/admin/status", {
    headers: { authorization: "Bearer wrong-token" }
  }), env);
  assert.equal(invalid.status, 401);
  assert.equal((await invalid.json()).error, "unauthorized");

  const login = await worker.fetch(new Request(origin + "/api/admin/login", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.77" },
    body: JSON.stringify({ password: ownerPassword })
  }), env);
  assert.equal(login.status, 200);
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const missingDb = await worker.fetch(new Request(origin + "/api/admin/status", {
    headers: { Cookie: cookie }
  }), env);
  assert.equal(missingDb.status, 503);
  assert.equal((await missingDb.json()).error, "product_database_not_configured");

  const publicShelf = await get("/api/store/owner-products");
  assert.equal(publicShelf.status, 503);
  assert.deepEqual(await publicShelf.json(), {
    ok: false, products: [], error: "product_database_not_configured"
  });
});

test("owner dashboard and dedicated Gift Cards page scripts parse and stay separate from the homepage", async () => {
  const admin = await readFile(new URL("../public/admin.html", import.meta.url), "utf8");
  const gift = await readFile(new URL("../public/gift-cards.html", import.meta.url), "utf8");
  const homepage = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  for (const [name, html] of [["admin.html", admin], ["gift-cards.html", gift]]) {
    const start = html.lastIndexOf("<script>");
    const bodyStart = html.indexOf(">", start) + 1;
    const end = html.indexOf("</script>", bodyStart);
    assert.ok(start >= 0 && end > bodyStart, name + " inline script should exist");
    assert.doesNotThrow(() => new Script(html.slice(bodyStart, end), { filename: name + ".inline.js" }));
  }
  assert.match(admin, /id="productForm"/);
  assert.match(admin, /id="walletForm"/);
  assert.match(admin, /MCP_WRITE_TOKEN/);
  assert.match(gift, /data-filter="gaming"/);
  assert.match(gift, /data-filter="entertainment"/);
  assert.match(gift, /Amazon\.com Gift Card is for eligible purchases on Amazon\.com only/);
  assert.match(homepage, /href="gift-cards\.html"/);
  assert.match(homepage, /clicks>=6/);
  assert.match(homepage, /ownerUnlock=1/);
  assert.doesNotMatch(homepage, /href="\/admin\.html"/);
  assert.match(admin, /params\.get\("ownerUnlock"\)==="1"/);
  assert.doesNotMatch(homepage, /id="giftcards"/);
});

test("343SHOP restores the white and green storefront and displays real seller listings, not inspiration galleries", async () => {
  const homepage = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const admin = await readFile(new URL("../public/admin.html", import.meta.url), "utf8");
  const deals = await readFile(new URL("../public/deals.html", import.meta.url), "utf8");
  const giftCards = await readFile(new URL("../public/gift-cards.html", import.meta.url), "utf8");
  const logo = await readFile(new URL("../public/images/343shop-logo.svg", import.meta.url), "utf8");
  const icon = await readFile(new URL("../public/images/343shop-icon.svg", import.meta.url), "utf8");
  const covers = await Promise.all(["storybook.svg", "paperback.svg", "ebook.svg"].map(name =>
    readFile(new URL("../public/images/" + name, import.meta.url), "utf8")
  ));

  assert.match(homepage, /data-theme="light"/);
  assert.match(homepage, /--forest:#176b3b/);
  assert.match(homepage, /--shop-green:#16834b/);
  assert.doesNotMatch(homepage, /--shop-ink:#edf5ff/);
  assert.match(homepage, /JBL GO 4/);
  assert.match(homepage, /JBL TUNE 310C/);
  assert.match(homepage, /SanDisk 128GB/);
  assert.match(homepage, /virginmegastore\.ae\/medias\/1000290-main\.jpg/);
  assert.match(homepage, /empire\.co\.tz\/products\/jbl-go-4-portable-waterproof-speaker/);
  assert.match(homepage, /empire\.co\.tz\/products\/jbl-tune-310c-wired-usb-c-in-ear-headphones/);
  assert.match(homepage, /empire\.co\.tz\/products\/sandisk-128gb-ultra-micro-uhs-i-sdxc-card/);
  assert.doesNotMatch(homepage, /id="styleSamples"|class="style-samples|class="inspiration-tile|gift-teaser-samples/);
  assert.doesNotMatch(homepage, /marketplace-hero\.svg/);
  assert.doesNotMatch(homepage, /featured-local-placeholder/);
  assert.match(homepage, /BOOK COVER PREVIEW/);
  assert.match(homepage, /owner-store-no-image/);
  assert.match(homepage, /no-image-note/);
  assert.match(deals, /data-theme="light"/);
  assert.match(deals, /--bg:#fff/);
  assert.match(deals, /Seller has not supplied a product image/);
  assert.match(giftCards, /data-theme="light"/);
  assert.doesNotMatch(giftCards, /class="hero-showcase|class="gift-photo-strip/);
  assert.match(giftCards, /OFFICIAL BRAND/);
  assert.match(giftCards, /request categories/);
  assert.match(admin, /class="owner-hero"/);
  assert.match(admin, /class="owner-shortcuts"/);
  assert.match(admin, /src="\/images\/343shop-icon\.svg"/);
  for (const asset of [logo, icon, ...covers]) {
    assert.match(asset, /<svg[\s>]/);
    assert.match(asset, /viewBox=/);
  }
});

test("customer print portfolio embeds a verified WebP directly for reliable rendering", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const match = html.match(/const PRINT_PORTFOLIO_WEBP="([A-Za-z0-9+/=]+)";/);
  assert.ok(match, "the compressed portfolio WebP should be embedded");
  assert.equal(match[1].length, 30144);
  assert.ok(match[1].startsWith("UklGR"), "the payload should have a WebP RIFF header");
  assert.match(html, /data:image\/webp;base64,/);
  assert.match(html, /data-print-sample="left"/);
  assert.match(html, /data-print-sample="right"/);
  assert.match(html, /id="printWorkTitle"/);
});


test("customer storefront keeps its approved design while adding theme, card-brand and gift-photo controls", async () => {
  const homepage = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const deals = await readFile(new URL("../public/deals.html", import.meta.url), "utf8");
  const gift = await readFile(new URL("../public/gift-cards.html", import.meta.url), "utf8");

  for (const [name, html] of [["homepage", homepage], ["deals", deals], ["gift cards", gift]]) {
    assert.match(html, /data-theme-toggle/);
    assert.match(html, /343shop-theme/);
    const themeScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(themeScripts.some(match => match[1].includes('localStorage.getItem(key)')),
      name + " should include the theme preference script");
    for (const match of themeScripts) {
      assert.doesNotThrow(() => new Script(match[1], { filename: name + ".inline.js" }));
    }
  }

  assert.match(homepage, /payment-visa/);
  assert.match(homepage, /payment-mastercard/);
  assert.match(homepage, /Card checkout is not connected yet/);
  assert.match(homepage, /Hatuombi wala kuhifadhi taarifa za kadi hapa/);
  assert.match(gift, /gift-photo-strip/);
  assert.match(gift, /cdn\.pixabay\.com\/photo\/2020\/12\/09/);
  assert.match(gift, /images\.unsplash\.com\/photo-1518291043933-49e998050694/);
});
