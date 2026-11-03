# 343SHOP Cloudflare deployment

The Worker uses `wrangler.jsonc` as the source of truth. It includes:

- Worker entry point: `worker/index.mjs`
- Static site assets: `./public/` (binding `ASSETS`)
- D1 product database: `343shop-products` (binding `DB`)

## Fix the Workers Builds command

The previous Cloudflare build used plain `npx wrangler deploy` and failed to locate the static assets directory. The deployment command is now explicit in `package.json`.

In Cloudflare Dashboard:

1. Open **Workers & Pages → 343shop → Settings → Builds** (Build configuration).
2. Keep the project root directory as `/`.
3. Set **Deploy command** to exactly `npm run deploy`.
4. Keep **Build command** empty; this project has no frontend compilation step.
5. Save the build configuration and deploy the latest commit from `main`.

The deploy script runs:

```sh
wrangler deploy --config ./wrangler.jsonc --assets ./public/
```

The explicit `--assets` flag prevents the previous static-directory auto-detection failure. The Wrangler config supplies the D1 `DB` binding; do not create a second database.

## Owner write secret

After the Worker is deployed, open **Settings → Variables and Secrets → Add → Secret**:

- Name: `MCP_WRITE_TOKEN`
- Value: generate a long random private value and store it securely.

Never put this value in GitHub, website JavaScript or a chat message.

## Verify

Open these URLs after deployment:

- `https://343shop.chugastan343.workers.dev/api/mcp/status`
- `https://343shop.chugastan343.workers.dev/api/store/products`

Expected status after D1 is deployed: `product_database_configured: true`.
After adding `MCP_WRITE_TOKEN`, expected: `writes_enabled: true`.
The empty public catalogue should respond with `{"ok":true,"products":[]}` until an owner-approved product is published.

The CI workflow also runs a Wrangler dry-run with the same config and assets directory to catch deployment-bundle errors before merge.
