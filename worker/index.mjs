const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
};

const AI_RATE_LIMIT = new Map();
const AI_RATE_WINDOW_MS = 60_000;
const AI_RATE_MAX = 8;

const STORE_SYSTEM_PROMPT = [
  "You are the 343SHOP shopping assistant.",
  "Be warm, concise and useful. Reply in Swahili by default; use English when the customer uses English.",
  "Help customers understand the products and how to order. Do not claim that stock, availability, delivery dates, customisation capacity or final delivery prices are confirmed.",
  "The catalogue prices are displayed in USD. Never convert to TZS unless a current exchange rate is supplied; instead say the shop will confirm the final total.",
  "Do not claim that a payment was made or an order was received. Customers submit an order only when they press Send inside WhatsApp.",
  "For an order, direct customers to add products to the bag and complete checkout, or contact the shop on WhatsApp at +255 695 981 035.",
  "The website does not collect card payments. Never ask for passwords, card numbers, PINs or one-time codes.",
  "Do not invent products, prices, discounts, delivery promises or business policies.",
  "",
  "343SHOP catalogue:",
  "Custom Photo Print — $15; Canvas Wall Art — $45; Logo Design Pack — $79; Full Brand Kit — $149;",
  "Baraka's Storybook — $18; Author Paperback Print — $22; Custom Story eBook — $35; Social Content Pack — $29;",
  "The Everyday Photo Mug — $24; Your Story Comfort Tee — $32; Memory Lane Phone Case — $29.",
  "Shipping is shown as $6.99 below a $75 subtotal and free at or above $75 in the current website cart. Tell customers that the final delivery arrangement is confirmed by the shop."
].join("\n");

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS
    }
  });
}

function overRateLimit(ip) {
  const now = Date.now();
  const current = AI_RATE_LIMIT.get(ip);
  if (current && current.resetAt > now) {
    if (current.count >= AI_RATE_MAX) return true;
    current.count += 1;
  } else {
    AI_RATE_LIMIT.set(ip, { count: 1, resetAt: now + AI_RATE_WINDOW_MS });
  }

  if (AI_RATE_LIMIT.size > 3000) {
    for (const [key, value] of AI_RATE_LIMIT) {
      if (value.resetAt <= now) AI_RATE_LIMIT.delete(key);
    }
  }
  return false;
}

function extractOpenAIText(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  const parts = [];
  for (const item of payload.output || []) {
    for (const block of item.content || []) {
      if (block.type === "output_text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
  }
  return parts.join("\n").trim();
}

async function handleAIChat(request, env, url) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return json({ error: "origin_not_allowed" }, 403);
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!request.headers.get("Content-Type")?.includes("application/json")) {
    return json({ error: "json_required" }, 415);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (overRateLimit(ip)) return json({ error: "rate_limited" }, 429);

  let raw;
  try {
    raw = await request.text();
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  if (raw.length > 12_000) return json({ error: "request_too_large" }, 413);

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const provider = body?.provider;
  if (provider !== "openai" && provider !== "claude") {
    return json({ error: "invalid_provider" }, 400);
  }

  if (!Array.isArray(body.messages)) return json({ error: "messages_required" }, 400);
  const messages = body.messages.slice(-8).map((message) => {
    if (!message || !["user", "assistant"].includes(message.role)) return null;
    if (typeof message.content !== "string") return null;
    const content = message.content.trim();
    if (!content || content.length > 1200) return null;
    return { role: message.role, content };
  });
  if (messages.length === 0 || messages.some((message) => !message) ||
      messages[messages.length - 1].role !== "user") {
    return json({ error: "invalid_messages" }, 400);
  }

  const apiKey = provider === "openai" ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: "provider_not_configured" }, 503);

  try {
    let upstream;
    if (provider === "openai") {
      upstream = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          instructions: STORE_SYSTEM_PROMPT,
          input: messages,
          max_output_tokens: 350,
          store: false
        })
      });
    } else {
      upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "anthropic-version": "2026-10-21",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "claude-haiku-5-5",
          system: STORE_SYSTEM_PROMPT,
          messages,
          max_tokens: 350
        })
      });
    }

    if (!upstream.ok) {
      if (upstream.status === 429) return json({ error: "provider_busy" }, 429);
      return json({ error: "ai_provider_error" }, 502);
    }

    const payload = await upstream.json();
    const reply = provider === "openai"
      ? extractOpenAIText(payload)
      : (payload.content || [])
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n")
          .trim();

    if (!reply) return json({ error: "empty_ai_reply" }, 502);
    return json({ reply, provider });
  } catch {
    return json({ error: "ai_unavailable" }, 502);
  }
}

// 343SHOP Marketplace MCP: read-only partner discovery and owner-reviewed drafts.
const MCP_PROTOCOL_LEGACY = "2025-11-25";
const MCP_PROTOCOL_MODERN = "2026-07-28";
const MCP_RATE_LIMIT = new Map();
const MCP_RATE_WINDOW_MS = 60_000;
const MCP_RATE_MAX = 30;
const PARTNER_CATALOGUE_CACHE = new Map();
const PARTNER_CACHE_TTL_MS = 45_000;

const MARKETPLACE_CATALOGUE = [
  { id: "custom-photo-print", name: "Custom Photo Print", name_sw: "Printi ya Picha Binafsi", category: "prints", description: "High-quality photo print on premium paper.", price: 15, currency: "USD" },
  { id: "canvas-wall-art", name: "Canvas Wall Art", name_sw: "Canvas ya Ukuta", category: "prints", description: "Gallery-wrapped canvas with your photo or design.", price: 45, currency: "USD" },
  { id: "logo-design-pack", name: "Logo Design Pack", name_sw: "Pakiti ya Logo Design", category: "branding", description: "Professional logo design with source files and variations.", price: 79, currency: "USD" },
  { id: "brand-kit", name: "Full Brand Kit", name_sw: "Brand Kit Kamili", category: "branding", description: "Logo, colour palette, fonts and social templates.", price: 149, currency: "USD" },
  { id: "storybook-baraka", name: "Baraka's Storybook", name_sw: "Kitabu cha Hadithi cha Baraka", category: "books", description: "A personalised Swahili storybook for little readers.", price: 18, currency: "USD" },
  { id: "author-paperback", name: "Author Paperback Print", name_sw: "Kitabu cha Mwandishi", category: "books", description: "Print your own book with quality layout guidance.", price: 22, currency: "USD" },
  { id: "custom-story-ebook", name: "Custom Story eBook", name_sw: "Hadithi Binafsi (eBook)", category: "digital", description: "Your story written and formatted as a digital book.", price: 35, currency: "USD" },
  { id: "content-pack-social", name: "Social Content Pack", name_sw: "Pakiti ya Content ya Social", category: "digital", description: "Captions and story templates tailored to your niche.", price: 29, currency: "USD" },
  { id: "custom-photo-mug", name: "The Everyday Photo Mug", name_sw: "Kikombe cha Picha", category: "mugs", description: "A ceramic mug printed with your favourite photo.", price: 24, currency: "USD" },
  { id: "personalized-comfort-tee", name: "Your Story Comfort Tee", name_sw: "Fulana ya Hadithi Yako", category: "apparel", description: "Soft cotton tee with your name, logo or message.", price: 32, currency: "USD" },
  { id: "memory-phone-case", name: "Memory Lane Phone Case", name_sw: "Kava la Simu", category: "accessories", description: "A durable phone case with your photo or design.", price: 29, currency: "USD" }
];

const MCP_TOOLS = [
  { name: "get_marketplace_profile", description: "Explains 343SHOP brokerage marketplace model, buyer/seller roles and operating limits.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "list_partner_shops", description: "Lists supplier/partner shops configured by the 343SHOP owner. Never invents partner shops.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "get_partner_integration_guide", description: "Returns the public JSON catalogue API format a partner shop must expose to be searchable.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  {
    name: "search_marketplace_products",
    description: "Searches 343SHOP showcase listings and configured partner shop catalogues. Reports source shop, currency and stock-verification status.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", maxLength: 100, description: "Product name or keyword; empty means browse." },
      category: { type: "string", maxLength: 60 },
      source: { type: "string", enum: ["all", "343shop", "partners"] },
      limit: { type: "integer", minimum: 1, maximum: 25 }
    }, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "compare_partner_offers",
    description: "Compares matching offers from connected partner catalogues. Compares prices only within the same currency.",
    inputSchema: { type: "object", properties: {
      product_name: { type: "string", minLength: 2, maxLength: 100 },
      category: { type: "string", maxLength: 60 }
    }, required: ["product_name"], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "calculate_brokerage_margin",
    description: "Calculates an agent/broker commission and seller net from a proposed deal. Does not change a real shop price.",
    inputSchema: { type: "object", properties: {
      supplier_price: { type: "number", minimum: 0 },
      customer_price: { type: "number", minimum: 0 },
      commission_type: { type: "string", enum: ["percentage", "fixed"] },
      commission_value: { type: "number", minimum: 0 },
      currency: { type: "string", minLength: 3, maxLength: 3 }
    }, required: ["supplier_price", "customer_price", "commission_type", "commission_value", "currency"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "create_whatsapp_quote_link",
    description: "Prepares a WhatsApp link to confirm stock, final price and terms. It never sends a message or creates an order.",
    inputSchema: { type: "object", properties: {
      product_name: { type: "string", minLength: 2, maxLength: 120 },
      quantity: { type: "integer", minimum: 1, maximum: 50 },
      partner_shop: { type: "string", maxLength: 100 },
      quoted_price: { type: "number", minimum: 0 },
      currency: { type: "string", minLength: 3, maxLength: 3 },
      customer_note: { type: "string", maxLength: 300 }
    }, required: ["product_name", "quantity"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "draft_supplier_listing",
    description: "Prepares a structured supplier listing draft for owner review. It is not saved or published.",
    inputSchema: { type: "object", properties: {
      partner_shop: { type: "string", minLength: 2, maxLength: 100 },
      product_name: { type: "string", minLength: 2, maxLength: 120 },
      description: { type: "string", minLength: 5, maxLength: 700 },
      category: { type: "string", minLength: 2, maxLength: 60 },
      supplier_price: { type: "number", minimum: 0 },
      currency: { type: "string", minLength: 3, maxLength: 3 },
      image_url: { type: "string", maxLength: 500 },
      supplier_product_url: { type: "string", maxLength: 500 }
    }, required: ["partner_shop", "product_name", "description", "category", "supplier_price", "currency"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "draft_product_ad",
    description: "Creates Swahili and English promotional copy. Does not publish an advert or spend money.",
    inputSchema: { type: "object", properties: {
      product_name: { type: "string", minLength: 2, maxLength: 120 },
      target_customer: { type: "string", maxLength: 120 },
      key_benefit: { type: "string", minLength: 2, maxLength: 240 },
      price: { type: "number", minimum: 0 },
      currency: { type: "string", minLength: 3, maxLength: 3 },
      contact_url: { type: "string", maxLength: 500 }
    }, required: ["product_name", "key_benefit"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "check_partner_catalogue_health",
    description: "Checks the public catalogue endpoints of registered partner shops and reports which ones respond with a valid product catalogue.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "prepare_partner_shop_application",
    description: "Prepares a WhatsApp application message for a shop that wants to join the 343SHOP brokerage partner network. It does not approve, register or connect the shop.",
    inputSchema: { type: "object", properties: {
      shop_name: { type: "string", minLength: 2, maxLength: 100 },
      location: { type: "string", minLength: 2, maxLength: 100 },
      contact_name: { type: "string", minLength: 2, maxLength: 80 },
      phone: { type: "string", minLength: 7, maxLength: 25 },
      categories: { type: "string", minLength: 2, maxLength: 220 },
      catalogue_url: { type: "string", maxLength: 300 }
    }, required: ["shop_name", "location", "contact_name", "phone", "categories"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
];

function mcpJson(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...extraHeaders }
  });
}
function mcpResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function mcpError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

function mcpRateLimited(ip) {
  const now = Date.now();
  const current = MCP_RATE_LIMIT.get(ip);
  if (current && current.resetAt > now) {
    if (current.count >= MCP_RATE_MAX) return true;
    current.count += 1;
  } else {
    MCP_RATE_LIMIT.set(ip, { count: 1, resetAt: now + MCP_RATE_WINDOW_MS });
  }
  if (MCP_RATE_LIMIT.size > 2500) {
    for (const [key, value] of MCP_RATE_LIMIT) if (value.resetAt <= now) MCP_RATE_LIMIT.delete(key);
  }
  return false;
}
function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
}
function isAllowedMcpOrigin(origin) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.protocol === "https:" && !u.username && !u.password &&
      ["chatgpt.com", "chat.openai.com", "claude.ai", "grok.com", "grok.x.ai"].includes(u.hostname.toLowerCase());
  } catch { return false; }
}
function parsePartnerShops(env) {
  if (!env.PARTNER_SHOPS_JSON) return [];
  try {
    const raw = JSON.parse(env.PARTNER_SHOPS_JSON);
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 20).filter((shop) => {
      if (!shop || typeof shop !== "object" || typeof shop.id !== "string" ||
          !/^[a-z0-9][a-z0-9_-]{1,39}$/i.test(shop.id) ||
          typeof shop.name !== "string" || !shop.name.trim() || shop.name.length > 100 ||
          typeof shop.catalog_url !== "string" || shop.catalog_url.length > 500) return false;
      try {
        const u = new URL(shop.catalog_url);
        const host = u.hostname.toLowerCase();
        const local = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".test");
        const ipLike = /^[0-9.]+$/.test(host) || host.includes(":");
        return u.protocol === "https:" && !u.username && !u.password && !u.port && !local && !ipLike && host.includes(".");
      } catch { return false; }
    }).map((shop) => ({
      id: shop.id, name: shop.name.trim(),
      city: typeof shop.city === "string" ? shop.city.slice(0, 80) : "Not supplied",
      categories: Array.isArray(shop.categories) ? shop.categories.filter(x => typeof x === "string").slice(0, 12) : [],
      catalog_url: shop.catalog_url
    }));
  } catch { return []; }
}
function safeHttpsLink(value) {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch { return null; }
}
function normaliseSearchText(value) {
  return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function normalizePartnerProduct(product, shop) {
  if (!product || typeof product !== "object") return null;
  const name = typeof product.name === "string" ? product.name.trim() : (typeof product.title === "string" ? product.title.trim() : "");
  const price = Number(product.price);
  const currency = typeof product.currency === "string" ? product.currency.toUpperCase() : "";
  if (!name || name.length > 120 || !Number.isFinite(price) || price < 0 || !/^[A-Z]{3}$/.test(currency)) return null;
  const availabilityValues = ["in_stock", "out_of_stock", "limited", "unknown"];
  return {
    id: typeof product.id === "string" ? product.id.slice(0, 80) : name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80),
    name, description: typeof product.description === "string" ? product.description.slice(0, 700) : "",
    category: typeof product.category === "string" ? product.category.slice(0, 60) : "other",
    price, currency, source_type: "partner_shop", source_shop_id: shop.id, source_shop: shop.name, city: shop.city,
    availability: availabilityValues.includes(product.availability) ? product.availability : "unknown",
    stock_last_updated: typeof product.updated_at === "string" ? product.updated_at.slice(0, 50) : null,
    image_url: safeHttpsLink(product.image_url), product_url: safeHttpsLink(product.url || product.product_url)
  };
}
async function fetchPartnerCatalogue(shop) {
  const cached = PARTNER_CATALOGUE_CACHE.get(shop.id);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const response = await fetch(shop.catalog_url, {
      method: "GET", headers: { "Accept": "application/json" }, redirect: "manual", signal: AbortSignal.timeout(6500)
    });
    if (!response.ok || response.status >= 300 || !(response.headers.get("content-type") || "").toLowerCase().includes("application/json")) {
      throw new Error("partner_catalog_unavailable");
    }
    if (Number(response.headers.get("content-length") || 0) > 350000) throw new Error("partner_catalog_too_large");
    const raw = await response.text();
    if (raw.length > 350000) throw new Error("partner_catalog_too_large");
    const parsed = JSON.parse(raw);
    const products = Array.isArray(parsed) ? parsed : parsed?.products;
    if (!Array.isArray(products)) throw new Error("partner_catalog_invalid_shape");
    const value = { products: products.slice(0, 100).map(p => normalizePartnerProduct(p, shop)).filter(Boolean), status: "connected" };
    PARTNER_CATALOGUE_CACHE.set(shop.id, { value, expiresAt: Date.now() + PARTNER_CACHE_TTL_MS });
    return value;
  } catch {
    const value = { products: [], status: "unavailable" };
    PARTNER_CATALOGUE_CACHE.set(shop.id, { value, expiresAt: Date.now() + 12000 });
    return value;
  }
}
async function searchMarketplaceProducts(args, env) {
  const query = normaliseSearchText(args.query || "");
  const category = normaliseSearchText(args.category || "");
  const source = args.source || "all";
  const limit = Number.isInteger(args.limit) ? Math.min(25, Math.max(1, args.limit)) : 15;
  const own = source === "partners" ? [] : MARKETPLACE_CATALOGUE.map(p => ({
    ...p, source_type: "343shop_showcase", source_shop_id: "343shop",
    source_shop: "343SHOP curated catalogue", city: "Online",
    availability: "confirm_with_supplier", stock_last_updated: null, image_url: null, product_url: null
  }));
  const shops = source === "343shop" ? [] : parsePartnerShops(env);
  const partnerLists = await Promise.all(shops.map(async shop => (await fetchPartnerCatalogue(shop)).products));
  const combined = [...own, ...partnerLists.flat()];
  const filtered = combined.filter(p => {
    const text = normaliseSearchText([p.name, p.description, p.category, p.source_shop].join(" "));
    return (!query || text.includes(query)) && (!category || normaliseSearchText(p.category).includes(category));
  });
  return {
    query: args.query || "", checked_at: new Date().toISOString(),
    result_count: Math.min(filtered.length, limit), connected_partner_count: shops.length,
    results: filtered.slice(0, limit),
    note: shops.length === 0
      ? "No partner shops are connected yet. Results contain only 343SHOP showcase listings. Configure partner public catalogue endpoints in Cloudflare PARTNER_SHOPS_JSON to search other shops."
      : "Partner data is supplied by partner shops. Confirm current stock, final price, delivery, seller terms and brokerage commission before accepting an order."
  };
}

async function runMcpTool(name, args, env) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be a JSON object.");

  if (name === "get_marketplace_profile") return {
    marketplace: "343SHOP", business_model: "brokerage_and_marketplace",
    role: "Connects buyers with independent shops, suppliers and service providers. The owner acts as a broker/agent (winga), not as the assumed stock owner.",
    customer_flow: ["discover a product", "identify the supplying partner shop", "confirm stock and final price", "agree agent commission and delivery", "complete the order through the agreed contact channel"],
    order_contact_whatsapp: "+255695981035",
    payment: "The current site does not collect card payments. Do not claim that any order or payment is complete.",
    inventory_policy: "343SHOP showcase listings do not prove stock. Partner stock must be confirmed with the source shop.",
    commission_policy: "No default commission rate has been set. Use calculate_brokerage_margin only after the owner supplies the agreed figures."
  };

  if (name === "list_partner_shops") {
    const shops = parsePartnerShops(env);
    return {
      connected_partner_count: shops.length,
      partners: shops.map(({ catalog_url, ...shop }) => ({ ...shop, catalogue_api: "configured_public_read_only_json" })),
      note: shops.length ? "Only partner shops registered in PARTNER_SHOPS_JSON are listed." : "No external partner shops have been connected yet. The owner must register each supplier's public catalogue endpoint first."
    };
  }

  if (name === "get_partner_integration_guide") return {
    setup_variable: "PARTNER_SHOPS_JSON",
    description: "Cloudflare Worker variable containing a JSON array. Do not place API secrets or private customer information in this variable.",
    example: [{ id: "shop-mbande-01", name: "Example Partner Shop", city: "Dar es Salaam", categories: ["electronics", "fashion"], catalog_url: "https://partner.example/api/public/catalogue" }],
    partner_catalogue_response_example: { products: [{
      id: "p-100", name: "Example Product", description: "Accurate product description", category: "electronics",
      price: 45000, currency: "TZS", availability: "unknown", updated_at: "2026-11-02T12:00:00Z",
      image_url: "https://partner.example/images/p-100.jpg", product_url: "https://partner.example/products/p-100"
    }] },
    accepted_availability_values: ["in_stock", "out_of_stock", "limited", "unknown"],
    rules: [
      "Partner catalogues must use HTTPS and return application/json.",
      "Each product must include name, numeric price and a three-letter currency code.",
      "Missing/unknown stock is never treated as in stock.",
      "This MCP reads partner catalogues only; it does not change another shop's inventory or prices.",
      "Authenticated partner APIs require a separately secured connector; do not put tokens in PARTNER_SHOPS_JSON."
    ]
  };

  if (name === "search_marketplace_products") {
    if (!["all", "343shop", "partners", undefined].includes(args.source)) throw new Error("Invalid source filter.");
    if (args.query !== undefined && (typeof args.query !== "string" || args.query.length > 100)) throw new Error("Invalid search query.");
    if (args.category !== undefined && (typeof args.category !== "string" || args.category.length > 60)) throw new Error("Invalid category.");
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 25)) throw new Error("Limit must be between 1 and 25.");
    return searchMarketplaceProducts(args, env);
  }

  if (name === "compare_partner_offers") {
    if (typeof args.product_name !== "string" || args.product_name.trim().length < 2 || args.product_name.length > 100) throw new Error("Enter a product name with at least two characters.");
    const found = await searchMarketplaceProducts({ query: args.product_name, category: args.category, source: "partners", limit: 25 }, env);
    const grouped = {};
    for (const offer of found.results) (grouped[offer.currency] ||= []).push(offer);
    for (const currency of Object.keys(grouped)) grouped[currency].sort((x, y) => x.price - y.price);
    return {
      query: args.product_name, checked_at: found.checked_at, matching_offer_count: found.result_count,
      offers_by_currency: grouped,
      note: found.note + " Different currencies are not directly comparable. Confirm freight, taxes, commission and availability before quoting a customer."
    };
  }

  if (name === "calculate_brokerage_margin") {
    const supplier = Number(args.supplier_price), customer = Number(args.customer_price), value = Number(args.commission_value);
    const currency = typeof args.currency === "string" ? args.currency.toUpperCase() : "";
    if (![supplier, customer, value].every(Number.isFinite) || supplier < 0 || customer < 0 || value < 0 || !/^[A-Z]{3}$/.test(currency)) {
      throw new Error("Enter valid non-negative prices and a three-letter currency code.");
    }
    if (args.commission_type === "percentage" && value > 100) throw new Error("Commission percentage cannot exceed 100.");
    if (!["percentage", "fixed"].includes(args.commission_type)) throw new Error("Commission type must be percentage or fixed.");
    const commission = args.commission_type === "percentage" ? customer * value / 100 : value;
    const afterCost = customer - supplier - commission;
    return {
      currency, supplier_price: supplier, customer_price: customer, commission_type: args.commission_type,
      commission_value: value, broker_commission: Number(commission.toFixed(2)),
      amount_for_supplier_after_commission: Number((customer - commission).toFixed(2)),
      broker_result_after_supplier_cost: Number(afterCost.toFixed(2)),
      status: afterCost >= 0 ? "non_negative_before_other_expenses" : "loss_before_other_expenses",
      note: "Calculation only, not a contract or agreed commission. Taxes, delivery, refunds and other costs are excluded."
    };
  }

  if (name === "create_whatsapp_quote_link") {
    if (typeof args.product_name !== "string" || args.product_name.trim().length < 2 || args.product_name.length > 120) throw new Error("Enter a valid product name.");
    const quantity = Number(args.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) throw new Error("Quantity must be between 1 and 50.");
    const lines = [
      "Habari 343SHOP, naomba kuthibitisha bei na upatikanaji wa bidhaa hii kabla ya kuagiza.",
      "Bidhaa: " + args.product_name.trim(),
      "Idadi: " + quantity,
      args.partner_shop ? "Duka/muuzaji: " + String(args.partner_shop).slice(0, 100) : "",
      Number.isFinite(Number(args.quoted_price)) && args.quoted_price !== undefined ? "Bei iliyoorodheshwa: " + args.quoted_price + " " + String(args.currency || "").toUpperCase() : "",
      args.customer_note ? "Maelezo: " + String(args.customer_note).slice(0, 300) : "",
      "Tafadhali thibitisha stock, bei ya mwisho, usafirishaji na makubaliano ya udalali."
    ].filter(Boolean);
    const message = lines.join("\n");
    return { whatsapp_url: "https://wa.me/255695981035?text=" + encodeURIComponent(message), message, sent: false, order_created: false, note: "Link imeandaliwa tu. Haijafungua WhatsApp, kutuma ujumbe wala kuunda oda." };
  }

  if (name === "draft_supplier_listing") {
    for (const key of ["partner_shop", "product_name", "description", "category", "currency"]) {
      if (typeof args[key] !== "string" || !args[key].trim()) throw new Error("Missing or invalid " + key + ".");
    }
    const price = Number(args.supplier_price), currency = args.currency.toUpperCase();
    if (!Number.isFinite(price) || price < 0 || !/^[A-Z]{3}$/.test(currency)) throw new Error("Invalid supplier price or currency.");
    const image = args.image_url ? safeHttpsLink(args.image_url) : null;
    const productUrl = args.supplier_product_url ? safeHttpsLink(args.supplier_product_url) : null;
    if (args.image_url && !image) throw new Error("Image URL must use HTTPS.");
    if (args.supplier_product_url && !productUrl) throw new Error("Supplier product URL must use HTTPS.");
    return {
      status: "draft_only_not_saved",
      listing: { partner_shop: args.partner_shop.trim(), product_name: args.product_name.trim(), description: args.description.trim(), category: args.category.trim(), supplier_price: price, currency, image_url: image, supplier_product_url: productUrl, availability: "must_be_confirmed_with_supplier" },
      required_owner_checks: ["confirm supplier identity", "confirm stock", "agree agent commission", "confirm buyer price and delivery", "approve publication"],
      note: "Draft only. The current Worker has no product database/write integration."
    };
  }

  if (name === "check_partner_catalogue_health") {
    const shops = parsePartnerShops(env);
    const results = await Promise.all(shops.map(async (shop) => {
      const catalogue = await fetchPartnerCatalogue(shop);
      return {
        shop_id: shop.id,
        shop_name: shop.name,
        city: shop.city,
        status: catalogue.status,
        product_count: catalogue.products.length,
        check_note: catalogue.status === "connected"
          ? "Public catalogue responded with valid product data."
          : "Could not read a valid public JSON catalogue. Confirm the HTTPS URL, response format and availability."
      };
    }));
    return {
      checked_at: new Date().toISOString(),
      registered_partner_count: shops.length,
      connected_count: results.filter(x => x.status === "connected").length,
      unavailable_count: results.filter(x => x.status !== "connected").length,
      partners: results,
      note: shops.length ? "A successful technical check does not guarantee stock. Confirm each seller's current stock and terms before quoting a buyer."
        : "No partner shops have been registered yet. Invite suppliers through the partner application form and add their public catalogue endpoint after verification."
    };
  }

  if (name === "prepare_partner_shop_application") {
    for (const key of ["shop_name", "location", "contact_name", "phone", "categories"]) {
      if (typeof args[key] !== "string" || args[key].trim().length < 2) {
        throw new Error("Missing or invalid " + key + ".");
      }
    }
    const trimmed = {
      shop_name: args.shop_name.trim().slice(0, 100),
      location: args.location.trim().slice(0, 100),
      contact_name: args.contact_name.trim().slice(0, 80),
      phone: args.phone.trim().slice(0, 25),
      categories: args.categories.trim().slice(0, 220)
    };
    let catalogue = "";
    if (args.catalogue_url) {
      catalogue = safeHttpsLink(args.catalogue_url);
      if (!catalogue) throw new Error("Catalogue URL must be a valid HTTPS link.");
    }
    const message = [
      "Habari 343SHOP, naomba kujiunga kama duka mshirika kwenye marketplace ya udalali.",
      "Jina la duka: " + trimmed.shop_name,
      "Eneo: " + trimmed.location,
      "Mtu wa mawasiliano: " + trimmed.contact_name,
      "Simu: " + trimmed.phone,
      "Bidhaa/huduma: " + trimmed.categories,
      catalogue ? "Catalogue/website: " + catalogue : "",
      "Naomba maelezo ya verification na makubaliano ya commission/udalali."
    ].filter(Boolean).join("\\n");
    return {
      status: "application_message_prepared_not_sent",
      whatsapp_url: "https://wa.me/255695981035?text=" + encodeURIComponent(message),
      message,
      shop_registered: false,
      catalogue_connected: false,
      note: "The shop must send the WhatsApp application. 343SHOP must verify the business and catalogue, then the owner registers the partner endpoint in Cloudflare."
    };
  }

  if (name === "draft_product_ad") {
    if (typeof args.product_name !== "string" || args.product_name.trim().length < 2 || typeof args.key_benefit !== "string" || !args.key_benefit.trim()) {
      throw new Error("Product name and a real key benefit are required.");
    }
    const target = typeof args.target_customer === "string" && args.target_customer.trim() ? args.target_customer.trim() : "wateja wanaohitaji bidhaa hii";
    const priceText = Number.isFinite(Number(args.price)) && args.price !== undefined ? " Bei iliyoorodheshwa: " + args.price + " " + String(args.currency || "").toUpperCase() + "." : "";
    const contact = args.contact_url ? safeHttpsLink(args.contact_url) : null;
    if (args.contact_url && !contact) throw new Error("Contact URL must use HTTPS.");
    return {
      status: "draft_only_not_published",
      swahili: { headline: args.product_name.trim() + " — chaguo lako, mguso wako", body: args.key_benefit.trim() + ". Inafaa kwa " + target + "." + priceText + " Wasiliana nasi kuthibitisha upatikanaji, bei ya mwisho na usafirishaji.", call_to_action: "Uliza bei na upatikanaji" },
      english: { headline: args.product_name.trim() + " — made for your choice", body: args.key_benefit.trim() + ". A thoughtful option for " + target + "." + priceText + " Contact us to confirm availability, final pricing and delivery.", call_to_action: "Check price and availability" },
      contact_url: contact, paid_ad_published: false, money_spent: false,
      note: "Draft only. Nothing was posted to Google Ads, social media or any advertising account."
    };
  }

  throw new Error("Unknown tool.");
}

async function handleMcp(request, env, url) {
  const origin = request.headers.get("Origin");
  if (!isAllowedMcpOrigin(origin)) return mcpJson({ error: "origin_not_allowed" }, 403);
  const cors = origin ? {
    "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, last-event-id",
    "Access-Control-Max-Age": "86400", "Vary": "Origin"
  } : {};
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...cors } });
  if (request.method !== "POST") return mcpJson({ error: "method_not_allowed", endpoint: "/mcp", allowed: ["POST", "OPTIONS"] }, 405, { "Allow": "POST, OPTIONS", ...cors });
  if (env.MCP_ACCESS_TOKEN && !safeEqual(request.headers.get("Authorization") || "", "Bearer " + env.MCP_ACCESS_TOKEN)) {
    return mcpJson({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer", ...cors });
  }
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (mcpRateLimited(ip)) return mcpJson({ error: "rate_limited" }, 429, cors);
  if (!(request.headers.get("Content-Type") || "").toLowerCase().includes("application/json")) return mcpJson({ error: "json_required" }, 415, cors);

  let raw;
  try { raw = await request.text(); } catch { return mcpJson({ error: "invalid_request" }, 400, cors); }
  if (raw.length > 24000) return mcpJson({ error: "request_too_large" }, 413, cors);
  let body;
  try { body = JSON.parse(raw); } catch { return mcpJson({ error: "invalid_json" }, 400, cors); }
  if (!body || Array.isArray(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return mcpJson(mcpError(body?.id ?? null, -32600, "Invalid JSON-RPC request."), 400, cors);
  }

  const version = request.headers.get("MCP-Protocol-Version");
  const modern = version === MCP_PROTOCOL_MODERN;
  if (version && ![MCP_PROTOCOL_MODERN, MCP_PROTOCOL_LEGACY, "2025-06-18", "2025-03-26"].includes(version)) {
    return mcpJson(mcpError(body.id ?? null, -32600, "Unsupported MCP protocol version."), 400, cors);
  }
  if (modern) {
    const bodyVersion = body.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
    if (bodyVersion !== MCP_PROTOCOL_MODERN || request.headers.get("Mcp-Method") !== body.method ||
        (body.method === "tools/call" && request.headers.get("Mcp-Name") !== body.params?.name)) {
      return mcpJson(mcpError(body.id ?? null, -32020, "MCP request headers do not match the JSON-RPC body."), 400, cors);
    }
  }

  const hasId = Object.prototype.hasOwnProperty.call(body, "id");
  if (!hasId) return new Response(null, { status: 202, headers: { ...SECURITY_HEADERS, ...cors } });
  const id = body.id;

  if (body.method === "initialize") {
    const requested = body.params?.protocolVersion;
    const legacyVersions = [MCP_PROTOCOL_LEGACY, "2025-06-18", "2025-03-26"];
    const negotiated = legacyVersions.includes(requested) ? requested : MCP_PROTOCOL_LEGACY;
    return mcpJson(mcpResult(id, {
      protocolVersion: negotiated, capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "343SHOP Marketplace", version: "1.0.0" },
      instructions: "343SHOP is a brokerage marketplace. Search only configured partner catalogues; never invent suppliers or stock. This read-only server cannot publish listings, submit orders or spend advertising money."
    }), 200, cors);
  }
  if (body.method === "ping") return mcpJson(mcpResult(id, {}), 200, cors);
  if (body.method === "tools/list") return mcpJson(mcpResult(id, { tools: MCP_TOOLS }), 200, cors);
  if (body.method === "tools/call") {
    const name = body.params?.name;
    if (typeof name !== "string") return mcpJson(mcpError(id, -32602, "Tool name is required."), 400, cors);
    try {
      const result = await runMcpTool(name, body.params?.arguments || {}, env);
      return mcpJson(mcpResult(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false }), 200, cors);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool call failed.";
      return mcpJson(mcpResult(id, { content: [{ type: "text", text: message }], isError: true }), 200, cors);
    }
  }
  if (body.method === "resources/list") return mcpJson(mcpResult(id, { resources: [] }), 200, cors);
  if (body.method === "prompts/list") return mcpJson(mcpResult(id, { prompts: [] }), 200, cors);
  return mcpJson(mcpError(id, -32601, "Method not found."), 404, cors);
}

function mcpStatus(env) {
  return {
    ok: true, name: "343SHOP Marketplace MCP", endpoint: "/mcp",
    transport: "Streamable HTTP", supported_protocols: [MCP_PROTOCOL_MODERN, MCP_PROTOCOL_LEGACY, "2025-06-18", "2025-03-26"],
    tool_count: MCP_TOOLS.length, connected_partner_shops: parsePartnerShops(env).length,
    access_token_required: Boolean(env.MCP_ACCESS_TOKEN),
    mode: "read-only discovery and owner-reviewed drafts", writes_enabled: false, ad_spend_enabled: false
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/mcp/status") {
      return json(mcpStatus(env));
    }

    if (url.pathname === "/mcp") {
      return handleMcp(request, env, url);
    }

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        app: "343SHOP",
        orderFlow: "whatsapp",
        payment: "manual-confirmation",
        storage: "not-required"
      });
    }

    if (url.pathname === "/api/ai/status") {
      return json({
        providers: {
          openai: Boolean(env.OPENAI_API_KEY),
          claude: Boolean(env.ANTHROPIC_API_KEY)
        }
      });
    }

    if (url.pathname === "/api/ai/chat") {
      return handleAIChat(request, env, url);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "not_found" }, 404);
    }

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      headers.set(key, value);
    }
    headers.set("X-Robots-Tag", "index, follow");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
};
