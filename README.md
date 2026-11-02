# 343SHOP

Premium bilingual storefront for personalised gifts and creative services.

## Live order flow
Customers browse, search, filter products, add items to the cart and submit order details through WhatsApp. An order is only submitted after the customer presses Send in WhatsApp. No payment is collected or marked as paid by this site.

## Deployment
This project is a Cloudflare Worker with Static Assets. It has no database dependency and is designed to deploy through the existing Workers Builds connection.

- Root directory: /
- Deploy command: npx wrangler deploy
- Static files: public/
- Worker entry: worker/index.mjs

## Store settings
The WhatsApp order destination is set in public/index.html as WHATSAPP_NUMBER. Update it there if the store contact changes.

Product prices are displayed in USD as supplied in the original project catalogue. Confirm currency, delivery terms and product availability with the customer before accepting payment.

## Local preview
Install Node.js 20+ and run:
```bash
npx wrangler dev
```
