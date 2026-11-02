# 343SHOP

Bilingual global shopping and brokerage marketplace connecting buyers with external marketplaces and approved supplier catalogues.

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
- `search_marketplace_products` — searches the 343SHOP showcase catalogue, registered partner catalogues and eBay when its official API credentials are configured.
- `compare_partner_offers` — compares supplier offers only within the same currency.
- `calculate_brokerage_margin` — calculates an owner-supplied commission proposal.
- `create_whatsapp_quote_link` — prepares a WhatsApp link; it does not send a message or create an order.
- `draft_supplier_listing` — returns a listing draft for review; it does not save or publish it.
- `draft_product_ad` — prepares Swahili and English ad copy; it does not publish ads or spend money.
- `check_partner_catalogue_health` — checks whether registered public partner catalogues respond with usable product data.
- `prepare_partner_shop_application` — prepares a WhatsApp application message for a shop that wants to join; it does not approve or connect the shop.
- `get_marketplace_integrations_status` — reports Amazon, Alibaba.com, eBay and KiKUU integration readiness without treating pending approvals as live connections.
- `list_global_marketplaces` — lists the official websites, direct search support and integration state for the 10-source global directory.
- `prepare_global_marketplace_search` — prepares source-specific search URLs from a product keyword; it does not scrape or return unverified product data.

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


### Inviting new partner shops

The public storefront now has a **For shops / Kwa maduka** section with a short partner application form. A shop shares its name, location, contact person, phone, product categories and (optionally) its public catalogue URL. The form opens a pre-filled WhatsApp message to 343SHOP. The shop representative must press Send; the application is not submitted automatically.

After reviewing the business and confirming the seller's permission to share its catalogue:

1. Check the public catalogue endpoint using the MCP tool `check_partner_catalogue_health` after registration.
2. Add the shop to the Cloudflare Worker variable `PARTNER_SHOPS_JSON` using the format above.
3. Confirm product prices, stock update frequency, contact person, fulfilment arrangements and seller terms.
4. Agree brokerage commission with the partner before presenting a final quote to a buyer.

There are no preset commission rates. A partner application does not automatically list or connect a shop. The current onboarding form uses the existing WhatsApp contact and does not need a new paid service or database.

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

## Global marketplace integrations

The storefront includes a **Global Market** area with 10 marketplace destinations: Amazon, Alibaba.com, AliExpress, eBay, KiKUU Tanzania, Jumia Tanzania, Etsy, Temu, Made-in-China.com and DHgate. Product keywords create source-specific official website search URLs. The directory is for discovery and hand-off; it is not 10 live product integrations.

Server routes and tools:

- `GET /api/marketplaces/status` — reports integration readiness and the official marketplace directory without exposing secrets.
- `GET /api/marketplaces/search?q=iphone&source=all&limit=12` — searches configured read-only partner catalogues and eBay when credentials are present, then also returns `external_marketplace_search_links` for the same keyword across the official directory.
- `get_marketplace_integrations_status` — exposes the integration readiness report to AI clients.
- `list_global_marketplaces` — lists all official source destinations and clearly marks what is not connected.
- `prepare_global_marketplace_search` — prepares direct search links for a chosen product keyword and optional marketplace ID.
- `search_marketplace_products` — returns live results only from configured partner feeds, configured eBay API, or clearly labelled 343SHOP showcase entries. It also includes official website search links separately.

### eBay Browse API (implemented; requires owner credentials)

Configure these on the Cloudflare Worker named `343shop`:

- Secret `EBAY_CLIENT_ID`
- Secret `EBAY_CLIENT_SECRET`
- Optional Worker Variable `EBAY_CAMPAIGN_ID` (the approved 10-digit eBay Partner Network campaign ID)
- Optional Worker Variable `EBAY_MARKETPLACE_ID` (defaults to `EBAY_US`)

The Worker obtains an OAuth client-credentials token server-side and calls the eBay Browse API. The client secret is never sent to the browser. Search can work when the developer application has the required API access; affiliate attribution is only reported as configured when a valid campaign ID is present. Production access to eBay Buy APIs may require approval. Without credentials, eBay is shown as **not connected** and no eBay products are fabricated.

### Amazon (onboarding target; not live yet)

Use the official [Amazon Creators API documentation](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/introduction). Amazon requires enrollment and final acceptance in the Associates program for the target marketplace, at least 10 qualifying sales in the previous 30 days for Creators API access, and API credentials. 343SHOP does not currently have those credentials. Do not copy or scrape Amazon listings into the catalogue.

### Alibaba.com (affiliate onboarding; not live yet)

Apply through the official [Alibaba.com Affiliate portal](https://ads.alibaba.com/). Approval and the relevant approved offers, API tools or data feeds are required before products can be displayed with affiliate attribution. Alibaba's [registration guidance](https://ads.alibaba.com/help/register.htm) explains the publisher application and agreement approval. 343SHOP does not currently have an approved Alibaba affiliate account or feed.

### KiKUU Tanzania (partnership required; not live yet)

The [KiKUU Tanzania storefront](https://www.kikuu.co.tz/) is listed as a marketplace source. A written business partnership and an authorised product catalogue/feed are required before its listings can be imported. No public product-search API is configured in this release, so the site is linked rather than scraped.

### Other approved sellers and feeds

Use `PARTNER_SHOPS_JSON` for seller-approved, read-only HTTPS JSON catalogue endpoints. A public endpoint must return a `products` array; the exact schema and example are documented above. An affiliate feed may be added only when the marketplace's terms permit it and its tracking URLs are preserved. Do not put API secrets, cookies, passwords or private access tokens inside `PARTNER_SHOPS_JSON`.

**Important:** the 10 marketplace website links are direct discovery routes. They are not scraped, and they do not imply affiliate approval or a partnership. Live product cards are returned only by connected seller feeds or the eBay Browse API after credentials are configured. Amazon, Alibaba.com and KiKUU remain onboarding targets; AliExpress, Jumia, Etsy, Temu, Made-in-China and DHgate are website-search destinations until an authorized feed/API or affiliate programme is verified. Every external product result keeps its source URL and currency. Unknown stock is never treated as confirmed. Buyers must verify stock, final price, shipping, taxes, customs, seller reliability, returns and terms with the source seller before payment. External marketplace orders are completed at the source; 343SHOP does not collect card payments for them.

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
