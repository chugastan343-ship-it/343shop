# 343SHOP

Premium bilingual storefront for personalised gifts and creative services.

## Live order flow

Customers browse, search, filter products, add items to the cart and submit order details through WhatsApp. An order is only submitted after the customer presses Send in WhatsApp. No payment is collected or marked as paid by this site.

## AI shopping assistant

The floating assistant supports two server-side API providers:

- OpenAI Responses API: `gpt-5.6-luna`
- Anthropic Messages API: `claude-haiku-5-5`

Configure one or both secrets on the Cloudflare Worker named `343shop`:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`

In Cloudflare: Workers & Pages → 343shop → Settings → Variables and Secrets → Add → Secret. Save each API key as a Secret, not as a plain text variable. Never add API keys to `public/index.html`, GitHub source files, or browser storage.

The assistant checks `/api/ai/status` and only enables configured providers. Chat requests are sent to `/api/ai/chat`; conversation content is not saved in a 343SHOP database. The Worker applies request-size, message-count and basic per-IP rate limits. Add Cloudflare WAF/rate-limiting rules for stronger production abuse protection.

API usage is billed separately by OpenAI or Anthropic. A ChatGPT or Claude consumer subscription does not include API usage.


## 343SHOP Marketplace MCP connector

The Worker exposes a remote Model Context Protocol (MCP) endpoint at:

- `https://343shop.chugastan343.workers.dev/mcp`
- Status: `https://343shop.chugastan343.workers.dev/api/mcp/status`

The MCP describes 343SHOP as a **brokerage marketplace**: it connects buyers with independent shops and suppliers. It must not assume that 343SHOP owns partner stock.

### Available tools

- `get_marketplace_profile` — explains the broker/agent workflow and policies.
- `list_partner_shops` — lists only partner shops configured by the owner.
- `get_partner_integration_guide` — explains the public supplier catalogue API.
- `search_marketplace_products` — searches the 343SHOP showcase catalogue and registered partner catalogues.
- `compare_partner_offers` — compares supplier offers only within the same currency.
- `calculate_brokerage_margin` — calculates an owner-supplied commission proposal.
- `create_whatsapp_quote_link` — prepares a WhatsApp link; it does not send a message or create an order.
- `draft_supplier_listing` — returns a listing draft for review; it does not save or publish it.
- `draft_product_ad` — prepares Swahili and English ad copy; it does not publish ads or spend money.

### Registering other shops

Partner shops must first agree to share their product catalogue. Each partner must expose a public, read-only HTTPS JSON endpoint. In Cloudflare → Workers & Pages → 343shop → Settings → Variables and Secrets, add a Worker **Variable** named `PARTNER_SHOPS_JSON` containing an array like:

```json
[
  {
    "id": "shop-mbande-01",
    "name": "Partner Shop Name",
    "city": "Dar es Salaam",
    "categories": ["electronics", "fashion"],
    "catalog_url": "https://partner.example/api/public/catalogue"
  }
]
```

The endpoint must return `application/json` with a `products` array. Each product must include `name`, numeric `price` and a three-letter ISO currency code. Optional fields include `id`, `description`, `category`, `availability`, `updated_at`, `image_url` and `product_url`. Availability values are `in_stock`, `out_of_stock`, `limited` or `unknown`. Unknown stock is never treated as available.

Do not place private access tokens, passwords or customer information in `PARTNER_SHOPS_JSON`. The first version supports public read-only catalogues only; partner inventory and prices cannot be changed by 343SHOP. Partner endpoints are fetched on demand and briefly cached.

### Safety and current limitations

- The MCP endpoint is read-only. It cannot publish new catalogue entries, submit orders, modify supplier inventories, message suppliers or run paid advertising.
- WhatsApp links and product/ad drafts are prepared for a person to review and send.
- The current 343SHOP catalogue is a showcase list, not proof of physical stock.
- No commission rate is assumed. The owner supplies the agreed amount when calculating a brokerage deal.
- Partner shops are not automatically discovered. They must be registered with the owner's permission.
- No database or partner API credentials are required for this read-only first release.

The server supports Streamable HTTP, validates browser origins, limits request size and applies a basic per-IP request limit. If `MCP_ACCESS_TOKEN` is configured as a Worker Secret, requests must include `Authorization: Bearer <token>`; leave it unset for the initial read-only connector unless a fixed-token authentication setup is intended.

### Connecting an AI client

Add a custom remote MCP connector using the endpoint above. It can be connected to clients that support remote MCP, subject to each client's account-plan and authentication requirements. In ChatGPT, custom MCP access and write permissions depend on the workspace plan; read-only access is the safe starting point. Claude and other clients may ask you to choose OAuth or fixed request-header authentication.

## Google AdSense Auto ads

The AdSense loader and `public/ads.txt` seller record are included for publisher `ca-pub-3341309354110699`.

To make ads appear:

1. Add the public 343SHOP site URL to the AdSense Sites page and complete ownership verification.
2. Wait until Google marks the site `Ready`; Google review is not automatic approval from this code change.
3. In AdSense → Ads → your site → Edit, switch on Auto ads and save.

Google may take time to review a newly added site. The code does not bypass AdSense approval or policy checks.

## Deployment

This project is a Cloudflare Worker with Static Assets. It has no database dependency and is designed to deploy through the existing Workers Builds connection.

- Root directory: /
- Deploy command: `npx wrangler deploy`
- Static files: `public/`
- Worker entry: `worker/index.mjs`

## Store settings

The WhatsApp order destination is set in `public/index.html` as `WHATSAPP_NUMBER`. Update it there if the store contact changes.

Product prices are displayed in USD as supplied in the original project catalogue. Confirm currency, delivery terms and product availability with the customer before accepting payment.

## Local preview

Install Node.js 20+ and run:

```bash
npx wrangler dev
```
