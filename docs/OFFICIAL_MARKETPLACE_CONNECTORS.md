# Official marketplace connector rollout

This release adds a server-side Shopify Storefront API search connector and readiness reporting for Amazon, Alibaba.com and Shopify. It does not claim that an API is connected merely because credentials exist.

## Current implementation

- **Shopify:** one authorized Shopify store can be searched through the Storefront GraphQL API. Configure the store's `*.myshopify.com` domain and a Storefront API access token. The token is used only by the Worker and is never sent to the browser. This is a single-store connector, not yet a multi-merchant Shopify OAuth installation.
- **Amazon:** readiness is tracked for the official Creators API. A working product feed still requires Amazon Associates acceptance, Creators API eligibility for the target marketplace, credentials and a tested request adapter. SP-API is a different seller-management API and is not a substitute for a public product catalogue.
- **Alibaba.com:** readiness is tracked for the official Open Platform. Developer registration, API permissions and authorized account access are required. No unsigned/scraped catalogue requests are used; the signed Open Platform adapter remains pending validation against the specific APIs granted to 343SHOP.
- **eBay:** existing Browse API connector remains unchanged.

## Cloudflare Worker secrets

Add secrets in **Cloudflare Dashboard → Workers & Pages → 343shop → Settings → Variables and Secrets → Production**. Never commit these values to GitHub or place private tokens in HTML/JavaScript.

| Secret | Purpose |
| --- | --- |
| `SHOPIFY_STORE_DOMAIN` | Authorized merchant domain, e.g. `merchant-name.myshopify.com` |
| `SHOPIFY_STOREFRONT_ACCESS_TOKEN` | Storefront API token with required product/search access |
| `AMAZON_CREATORS_CLIENT_ID` | Amazon Creators API client ID, after approval |
| `AMAZON_CREATORS_CLIENT_SECRET` | Amazon Creators API client secret |
| `AMAZON_PARTNER_TAG` | Approved Associates partner tag for the same marketplace |
| `ALIBABA_APP_KEY` | Alibaba Open Platform application key |
| `ALIBABA_APP_SECRET` | Alibaba Open Platform application secret |
| `ALIBABA_ACCESS_TOKEN` | Authorized Alibaba account access token |

The Amazon and Alibaba values are readiness placeholders until their provider-specific authentication/signing and product-search adapters are implemented and verified. Do not add these secrets until the corresponding provider grants access.

## API routes

- `GET /api/marketplaces/status` reports connector readiness. `api_configured` means required values are present; it does **not** mean a live provider call has succeeded.
- `GET /api/marketplaces/search?q=shirt&source=shopify` searches the configured Shopify store.
- `GET /api/marketplaces/search?q=shirt&source=all` includes Shopify results when configured, alongside existing connected sources.
- Amazon and Alibaba are currently returned as explicit pending statuses; they are not represented as live search results.

## Official onboarding

- Amazon developer registration: https://developer-docs.amazon/sp-api/docs/sp-api-registration-overview
- Amazon Creators API: https://affiliate-program.amazon.com/creatorsapi/docs/en-us/introduction
- Alibaba Open Platform: https://openapi.alibaba.com/
- Shopify Storefront API: https://shopify.dev/docs/api/storefront/latest
- Shopify API authentication: https://shopify.dev/docs/api/usage/authentication

## Brokerage safeguards

All third-party listings remain owned and fulfilled by their source merchant. 343SHOP must display source attribution, must not invent stock or prices, and must send customers to the source merchant's checkout unless a separately authorized brokerage process is agreed.
