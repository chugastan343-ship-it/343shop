# 343SHOP official marketplace integrations

343SHOP is a brokerage/discovery marketplace. Third-party products remain owned, priced and fulfilled by their source merchants. 343SHOP-owned books and original scripts are separate inventory.

This guide describes the current code in the Worker branch. It distinguishes a configured credential from a successfully verified live provider connection.

## 1. Amazon Creators API — live adapter implemented

The Worker implements OAuth 2.0 token retrieval/caching and `SearchItems` requests against the official Creators API. Both credential families documented by Amazon are supported:

- v3 credentials: versions `3.1`, `3.2`, `3.3`, using regional Login with Amazon token endpoints.
- v2 credentials: versions `2.1`, `2.2`, `2.3`, using regional Cognito token endpoints and the versioned Authorization header.

### Cloudflare Worker Secrets / Variables

| Name | Example / purpose |
| --- | --- |
| `AMAZON_CREATORS_CLIENT_ID` | Credentials issued by Associates Central |
| `AMAZON_CREATORS_CLIENT_SECRET` | Private Creators API secret |
| `AMAZON_PARTNER_TAG` | Approved Associates tag for the selected locale |
| `AMAZON_MARKETPLACE` | `www.amazon.com`, `www.amazon.co.uk`, etc. |
| `AMAZON_CREATORS_CREDENTIAL_VERSION` | `3.1`, `3.2`, `3.3` or matching `2.x` version; defaults to `3.1` |

Never commit these values to Git or put them in frontend code. A valid partner tag and approved access for the target marketplace are still required. The adapter only requests product data; it does not guarantee that products can be shipped to Tanzania.

API route: `GET /api/marketplaces/search?q=android%20phone&source=amazon`.

## 2. Shopify Storefront API — multi-store search adapter implemented

The Worker queries each explicitly authorised merchant store using the versioned Storefront GraphQL endpoint. Private Storefront tokens stay on the server and use Shopify's private-token header and buyer-IP header. Public tokens use the public Storefront access-token header.

### Preferred multi-store secret

Set `SHOPIFY_PARTNER_STORES_JSON` as one Cloudflare Worker Secret containing a JSON array:

```json
[
  {
    "id": "merchant-a",
    "name": "Merchant A",
    "domain": "merchant-a.myshopify.com",
    "private_access_token": "PRIVATE_STOREFRONT_TOKEN"
  },
  {
    "id": "merchant-b",
    "name": "Merchant B",
    "domain": "merchant-b.myshopify.com",
    "public_access_token": "PUBLIC_STOREFRONT_TOKEN"
  }
]
```

Use the token type actually issued to the authorised Shopify app. Request only the Storefront scopes needed for product discovery. Each merchant must explicitly authorise their store; 343SHOP must not copy an Admin API token or access a store without permission.

For one store, the compatibility variables `SHOPIFY_STORE_DOMAIN` plus either `SHOPIFY_STOREFRONT_PRIVATE_TOKEN` or `SHOPIFY_STOREFRONT_ACCESS_TOKEN` remain supported.

API route: `GET /api/marketplaces/search?q=mug&source=shopify`.

This release supports secure multi-store token configuration, not a self-service OAuth installation/merchant onboarding portal. That needs a registered Shopify app, redirect URL, consent flow, token storage and merchant-specific revocation.

## 3. Alibaba.com Open Platform GGS — authorised seller catalogue path

Alibaba's official Open Platform onboarding requires developer registration, app review, App Key/App Secret, permission approval and seller authorisation. The official guide describes seller-authorisation and buyer-sourcing capabilities; it is not an unrestricted public search API.

The current 343SHOP build will only search Alibaba-labelled catalogue feeds when the owner has explicitly marked the seller as authorised. It does **not** scrape Alibaba pages, and it does **not** claim that an App Key alone enables a live global product search.

### Seller catalogue feed configuration

After 343SHOP has obtained the required Alibaba developer permissions and the supplier has explicitly authorised the app, add the seller's approved catalogue-feed endpoint to the Cloudflare Worker Secret `PARTNER_SHOPS_JSON`:

```json
[
  {
    "id": "alibaba-supplier-01",
    "name": "Authorised Alibaba Supplier",
    "marketplace": "alibaba",
    "seller_authorized": true,
    "catalog_url": "https://YOUR-APPROVED-SELLER-FEED.example/catalog.json",
    "city": "China",
    "categories": ["Electronics", "Accessories"]
  }
]
```

The feed endpoint must return JSON in the existing 343SHOP partner catalogue format:

```json
{
  "products": [
    {
      "id": "seller-item-001",
      "name": "Product name supplied by seller",
      "description": "Seller-provided description",
      "category": "Accessories",
      "price": 12.5,
      "currency": "USD",
      "availability": "unknown",
      "url": "https://www.alibaba.com/product-detail/..."
    }
  ]
}
```

The feed URL must be an HTTPS endpoint controlled by the authorised supplier or the approved integration service. Do not use an unofficial scraper or mark a seller as authorised before written/API consent.

API route: `GET /api/marketplaces/search?q=cotton&source=alibaba`.

**Important:** the current code supports the authorised seller-feed path, but does not yet implement Alibaba's direct GGS OAuth/signing and buyer-sourcing call. That final adapter must be implemented against the exact API product and permissions Alibaba grants to 343SHOP; the public onboarding guide alone does not provide a universal endpoint for every app.

## Search and status routes

- `GET /api/marketplaces/status` reports marketplace credential readiness and authorised Alibaba feed count.
- `GET /api/marketplaces/search?q=shirt&source=all` checks available configured feeds/APIs.
- `GET /api/marketplaces/search?q=shirt&source=amazon`
- `GET /api/marketplaces/search?q=shirt&source=alibaba`
- `GET /api/marketplaces/search?q=shirt&source=shopify`
- `GET /api/marketplaces/search?q=shirt&source=ebay`

A credential being present means only that it is configured. A live response is reported separately by each search request.

## Official documentation

- Amazon Creators API introduction: https://affiliate-program.amazon.com/creatorsapi/docs/en-us/introduction
- Amazon Creators API onboarding: https://affiliate-program.amazon.com/creatorsapi/docs/en-us/onboarding
- Amazon SearchItems reference: https://affiliate-program.amazon.com/creatorsapi/docs/en-us/api-reference/operations/search-items
- Amazon OAuth and HTTP examples: https://affiliate-program.amazon.com/creatorsapi/docs/en-us/get-started/using-curl
- Alibaba.com Open Platform GGS guide: https://openapi.alibaba.com/doc/doc.htm
- Shopify Storefront API 2026-10: https://shopify.dev/docs/api/storefront/2026-10

## Brokerage safeguards

All external listings must display their source attribution. Confirm price freshness, stock, minimum order quantity, freight, shipping to Tanzania, customs, local taxes, warranty, returns and seller reliability before taking a buyer's money. External checkout remains with the source marketplace/seller unless a separate authorised brokerage arrangement is established.
