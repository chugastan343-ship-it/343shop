-- 343SHOP owner-managed sourced product catalogue.
-- Drafts are private. Only owner-approved products are returned by the public API.
CREATE TABLE IF NOT EXISTS store_products (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  product_name TEXT NOT NULL CHECK(length(product_name) BETWEEN 2 AND 120),
  description TEXT NOT NULL CHECK(length(description) BETWEEN 5 AND 700),
  category TEXT NOT NULL CHECK(length(category) BETWEEN 2 AND 60),
  source_marketplace TEXT NOT NULL CHECK(length(source_marketplace) BETWEEN 2 AND 80),
  source_seller TEXT NOT NULL DEFAULT 'Not supplied',
  source_url TEXT NOT NULL UNIQUE,
  source_price REAL NOT NULL CHECK(source_price >= 0),
  currency TEXT NOT NULL CHECK(length(currency) = 3),
  image_url TEXT,
  availability TEXT NOT NULL DEFAULT 'unknown'
    CHECK(availability IN ('in_stock', 'out_of_stock', 'limited', 'unknown')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft', 'published', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_store_products_status_published
  ON store_products(status, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_store_products_category_status
  ON store_products(category, status);
