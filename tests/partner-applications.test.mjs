import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index.mjs";

const origin = "https://343shop.chugastan343.workers.dev";

class FakeD1 {
  constructor() { this.applications = []; }

  prepare(sql) {
    const db = this;
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async run() {
        if (sql.startsWith("INSERT INTO partner_applications")) {
          const [id, shop_name, location, contact_name, phone, phone_normalized, categories, catalogue_url, , owner_note, created_at, updated_at] = values;
          db.applications.push({
            id, shop_name, location, contact_name, phone, phone_normalized, categories, catalogue_url,
            status: "pending", owner_note: owner_note || "", created_at, updated_at, reviewed_at: null
          });
        } else if (sql.startsWith("UPDATE partner_applications")) {
          const [status, owner_note, updated_at, reviewed_at, id] = values;
          const row = db.applications.find((item) => item.id === id);
          if (row) Object.assign(row, { status, owner_note, updated_at, reviewed_at });
        }
        return { meta: { changes: 1 } };
      },
      async first() {
        if (sql.includes("WHERE phone_normalized = ?")) {
          return db.applications.find((item) =>
            item.phone_normalized === values[0] &&
            item.shop_name.toLowerCase() === String(values[1]).toLowerCase() &&
            ["pending", "contacted", "approved"].includes(item.status)
          ) || null;
        }
        if (sql.includes("SELECT id, owner_note FROM partner_applications")) {
          const row = db.applications.find((item) => item.id === values[0]);
          return row ? { id: row.id, owner_note: row.owner_note } : null;
        }
        if (sql.includes("FROM partner_applications WHERE id = ?")) {
          return db.applications.find((item) => item.id === values[0]) || null;
        }
        return null;
      },
      async all() {
        if (!sql.includes("FROM partner_applications")) return { results: [] };
        const rows = sql.includes("WHERE status = ?")
          ? db.applications.filter((item) => item.status === values[0])
          : db.applications;
        return { results: rows.slice().reverse() };
      }
    };
  }
}

const validApplication = (overrides = {}) => ({
  shop_name: "Dar Tech Store",
  location: "Dar es Salaam",
  contact_name: "Asha M.",
  phone: "+255 712 345 678",
  categories: "Phones and accessories",
  catalogue_url: "https://example.com/catalogue",
  ...overrides
});

async function submit(body, env, ip = "198.51.100.10", requestOrigin = origin) {
  return worker.fetch(new Request(origin + "/api/partner/applications", {
    method: "POST",
    headers: {
      Origin: requestOrigin,
      "Content-Type": "application/json",
      "CF-Connecting-IP": ip
    },
    body: JSON.stringify(body)
  }), env);
}

test("seller application is stored as private pending record", async () => {
  const DB = new FakeD1();
  const response = await submit(validApplication(), { DB }, "198.51.100.11");
  const payload = await response.json();
  assert.equal(response.status, 201);
  assert.equal(payload.accepted, true);
  assert.equal(payload.status, "pending");
  assert.equal(DB.applications.length, 1);
  assert.equal(DB.applications[0].status, "pending");
  assert.equal(DB.applications[0].catalogue_url, "https://example.com/catalogue");
});

test("seller application rejects non-HTTPS catalogue links", async () => {
  const response = await submit(validApplication({ catalogue_url: "http://example.com" }), { DB: new FakeD1() }, "198.51.100.12");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "catalogue_url_must_be_https");
});

test("seller application requires a same-origin browser request", async () => {
  const response = await submit(validApplication(), { DB: new FakeD1() }, "198.51.100.13", "https://attacker.example");
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "origin_not_allowed");
});

test("duplicate seller application is not inserted twice", async () => {
  const DB = new FakeD1();
  const first = await submit(validApplication(), { DB }, "198.51.100.14");
  const duplicate = await submit(validApplication({ phone: "255712345678" }), { DB }, "198.51.100.15");
  const payload = await duplicate.json();
  assert.equal(first.status, 201);
  assert.equal(duplicate.status, 200);
  assert.equal(payload.duplicate, true);
  assert.equal(DB.applications.length, 1);
});

test("public seller applications are only visible through owner-authenticated API", async () => {
  const DB = new FakeD1();
  await submit(validApplication(), { DB }, "198.51.100.16");
  const denied = await worker.fetch(new Request(origin + "/api/admin/partner-applications"), { DB, MCP_WRITE_TOKEN: "owner-secret" });
  assert.equal(denied.status, 401);

  const allowed = await worker.fetch(new Request(origin + "/api/admin/partner-applications", {
    headers: { Authorization: "Bearer owner-secret" }
  }), { DB, MCP_WRITE_TOKEN: "owner-secret" });
  assert.equal(allowed.status, 200);
  const payload = await allowed.json();
  assert.equal(payload.applications.length, 1);
  assert.equal(payload.applications[0].shop_name, "Dar Tech Store");
});

test("owner can review application without auto-connecting a seller catalogue", async () => {
  const DB = new FakeD1();
  await submit(validApplication(), { DB }, "198.51.100.17");
  const id = DB.applications[0].id;
  const response = await worker.fetch(new Request(origin + "/api/admin/partner-applications/" + id, {
    method: "PATCH",
    headers: { Authorization: "Bearer owner-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ status: "approved" })
  }), { DB, MCP_WRITE_TOKEN: "owner-secret" });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.application.status, "approved");
  assert.equal(DB.applications.length, 1);
});
