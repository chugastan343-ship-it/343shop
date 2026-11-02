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
          model: "gpt-6-luna",
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
          model: "claude-haiku-4-5-20251001",
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
