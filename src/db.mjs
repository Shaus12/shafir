// Postgres (Supabase transaction pooler, port 6543) for the server only. DATABASE_URL is read from the
// environment and never logged. Tables live in the private schema "app" with row level security enabled and
// no policies, so the Supabase Data API exposes nothing; the server connects with the database role.
//
// The schema is created on first use per server instance: schema_version records the applied migrations, and
// each missing migration runs in one transaction under an advisory lock, so concurrent instances cannot race.

import postgres from "postgres";

export class DbError extends Error {
  constructor(code) {
    super(code);
    this.name = "DbError";
    this.code = code;
  }
}

export const dbConfigured = () => Boolean(String(process.env.DATABASE_URL ?? "").trim());

let client;

function connection() {
  const url = String(process.env.DATABASE_URL ?? "").trim();
  if (!url) throw new DbError("not_configured");
  // prepare: false because the transaction pooler does not support prepared statements.
  client ??= postgres(url, { prepare: false, max: 1, idle_timeout: 20, connect_timeout: 10, ssl: "require" });
  return client;
}

/** Add later schema changes as new entries with the next version number; never edit an applied one. */
const MIGRATIONS = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS app.supplier_documents (
        id bigserial PRIMARY KEY,
        client_id text NOT NULL,
        sender_phone text,
        doc_type text NOT NULL CHECK (doc_type IN ('invoice', 'delivery_note')),
        supplier_name text,
        supplier_name_normalized text NOT NULL DEFAULT '',
        supplier_id text,
        supplier_id_key text NOT NULL DEFAULT '',
        supplier_key text NOT NULL DEFAULT '',
        doc_number text,
        doc_number_key text NOT NULL DEFAULT '',
        date date,
        currency text,
        subtotal numeric,
        vat numeric,
        total numeric,
        referenced_delivery_notes text[] NOT NULL DEFAULT '{}',
        status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'matched')),
        matched_invoice_id bigint REFERENCES app.supplier_documents (id) ON DELETE SET NULL,
        match_report jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS app.supplier_document_items (
        id bigserial PRIMARY KEY,
        client_id text NOT NULL,
        document_id bigint NOT NULL REFERENCES app.supplier_documents (id) ON DELETE CASCADE,
        description text,
        sku text,
        quantity numeric,
        unit text,
        unit_price numeric,
        line_total numeric
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS supplier_documents_unique_doc
        ON app.supplier_documents (client_id, doc_type, supplier_key, doc_number_key)
        WHERE supplier_key <> '' AND doc_number_key <> ''`,
      `CREATE INDEX IF NOT EXISTS supplier_documents_open
        ON app.supplier_documents (client_id, doc_type, status, supplier_id_key, supplier_name_normalized)`,
      `CREATE INDEX IF NOT EXISTS supplier_document_items_doc
        ON app.supplier_document_items (client_id, document_id)`,
      `ALTER TABLE app.supplier_documents ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE app.supplier_document_items ENABLE ROW LEVEL SECURITY`,
    ],
  },
  {
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS app.signed_forms (
        id bigserial PRIMARY KEY,
        client_id text NOT NULL,
        form_id text NOT NULL,
        form_title text NOT NULL,
        customer_name text NOT NULL DEFAULT '',
        customer_name_normalized text NOT NULL DEFAULT '',
        fields jsonb NOT NULL DEFAULT '{}'::jsonb,
        storage_path text NOT NULL,
        content_hash text NOT NULL,
        worker_phone text,
        token_hash text NOT NULL,
        signed_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS signed_forms_token ON app.signed_forms (client_id, token_hash)`,
      `CREATE INDEX IF NOT EXISTS signed_forms_by_client ON app.signed_forms (client_id, form_id, signed_at DESC)`,
      `ALTER TABLE app.signed_forms ENABLE ROW LEVEL SECURITY`,
    ],
  },
  {
    version: 3,
    statements: [
      `CREATE TABLE IF NOT EXISTS app.supplier_prices (
        id bigserial PRIMARY KEY,
        client_id text NOT NULL,
        supplier_key text NOT NULL,
        supplier_name text,
        item_key text NOT NULL,
        sku text,
        description text,
        description_key text NOT NULL DEFAULT '',
        unit text,
        currency text,
        price numeric NOT NULL,
        source text NOT NULL DEFAULT 'invoice' CHECK (source IN ('invoice', 'manual')),
        last_invoice_id bigint REFERENCES app.supplier_documents (id) ON DELETE SET NULL,
        last_date date,
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (client_id, supplier_key, item_key)
      )`,
      // id is the short per-client number used in commands ("אשר 12"), allocated under an advisory lock.
      `CREATE TABLE IF NOT EXISTS app.price_changes (
        client_id text NOT NULL,
        id integer NOT NULL,
        supplier_key text NOT NULL,
        item_key text NOT NULL,
        old_price numeric NOT NULL,
        new_price numeric NOT NULL,
        new_unit text,
        percent numeric,
        note text,
        invoice_id bigint REFERENCES app.supplier_documents (id) ON DELETE SET NULL,
        status text NOT NULL CHECK (status IN ('auto', 'pending', 'approved', 'rejected')),
        decided_by_phone text,
        created_at timestamptz NOT NULL DEFAULT now(),
        decided_at timestamptz,
        PRIMARY KEY (client_id, id)
      )`,
      `CREATE INDEX IF NOT EXISTS supplier_prices_search ON app.supplier_prices (client_id, updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS price_changes_pending ON app.price_changes (client_id, status, id)`,
      `ALTER TABLE app.supplier_prices ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE app.price_changes ENABLE ROW LEVEL SECURITY`,
    ],
  },
];

let ready;

async function migrate() {
  const sql = connection();
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(727001)`;
    await tx.unsafe("CREATE SCHEMA IF NOT EXISTS app");
    await tx.unsafe("CREATE TABLE IF NOT EXISTS app.schema_version (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    await tx.unsafe("ALTER TABLE app.schema_version ENABLE ROW LEVEL SECURITY");
    // Supabase's API roles get no access to the private schema (skipped where the roles do not exist).
    await tx.unsafe(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON SCHEMA app FROM anon; END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON SCHEMA app FROM authenticated; END IF;
    END $$`);
    const [{ current }] = await tx`SELECT COALESCE(MAX(version), 0) AS current FROM app.schema_version`;
    for (const migration of MIGRATIONS.filter(m => m.version > current)) {
      for (const statement of migration.statements) await tx.unsafe(statement);
      await tx`INSERT INTO app.schema_version (version) VALUES (${migration.version})`;
    }
  });
}

/** The connection, after the schema is up to date. A failed setup is retried on the next call. */
export async function getDb() {
  const sql = connection();
  ready ??= migrate().catch(error => {
    ready = undefined;
    throw error;
  });
  await ready;
  return sql;
}

/** Log an error without values: status/code and type only. */
export function logDbError(label, error) {
  console.error(label, error?.code || error?.name || "Error");
}
