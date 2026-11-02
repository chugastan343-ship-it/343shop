# 343SHOP

Premium bilingual storefront for personalised gifts and creative services.

## Live order flow

Customers browse, search, filter products, add items to the cart and submit order details through WhatsApp. An order is only submitted after the customer presses Send in WhatsApp. No payment is collected or marked as paid by this site.

## AI shopping assistant

The floating assistant supports two server-side API providers:

- OpenAI Responses API: `gpt-6-luna`
- Anthropic Messages API: `claude-haiku-4-5-20251001`

Configure one or both secrets on the Cloudflare Worker named `343shop`:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`

Both names are declared in `wrangler.jsonc` under `secrets.required`. The deploy is intentionally blocked until both are stored as Cloudflare Worker Secrets.

In Cloudflare: Workers & Pages → 343shop → Settings → Variables and Secrets → Add → Secret. Save each API key as a Secret, not as a plain text variable. Never add API keys to `public/index.html`, GitHub source files, or browser storage.

The assistant checks `/api/ai/status` and only enables configured providers. Chat requests are sent to `/api/ai/chat`; conversation content is not saved in a 343SHOP database. The Worker applies request-size, message-count and basic per-IP rate limits. Add Cloudflare WAF/rate-limiting rules for stronger production abuse protection.

API usage is billed separately by OpenAI or Anthropic. A ChatGPT or Claude consumer subscription does not include API usage.

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
