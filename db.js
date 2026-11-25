import pg from 'pg';

const { Pool } = pg;
export const databaseEnabled = Boolean(process.env.DATABASE_URL);
export const pool = databaseEnabled ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: Number(process.env.DATABASE_POOL_MAX || 5),
}) : null;

export async function initDatabase() {
  if (!pool) return { enabled: false, ready: false };
  const statements = [
    `CREATE TABLE IF NOT EXISTS companies (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      ticker TEXT,
      exchange TEXT DEFAULT 'NSE',
      sector TEXT,
      listing_status TEXT,
      isin TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (ticker, exchange)
    )`,
    `CREATE TABLE IF NOT EXISTS reports (
      id BIGSERIAL PRIMARY KEY,
      company_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      report_year INTEGER,
      metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
      analysis JSONB NOT NULL DEFAULT '{}'::jsonb,
      source_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS research_theses (
      id BIGSERIAL PRIMARY KEY,
      company_id TEXT NOT NULL,
      thesis TEXT NOT NULL,
      bull_case TEXT,
      bear_case TEXT,
      thesis_breakers JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS valuation_snapshots (
      id BIGSERIAL PRIMARY KEY,
      company_id TEXT NOT NULL,
      market JSONB NOT NULL DEFAULT '{}'::jsonb,
      fundamentals JSONB NOT NULL DEFAULT '{}'::jsonb,
      valuation JSONB NOT NULL DEFAULT '{}'::jsonb,
      ai_assessment TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS management_promises (
      id BIGSERIAL PRIMARY KEY,
      company_id TEXT NOT NULL,
      report_id BIGINT REFERENCES reports(id) ON DELETE SET NULL,
      promise TEXT NOT NULL,
      target_date DATE,
      status TEXT NOT NULL DEFAULT 'open',
      evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS monitoring_events (
      id BIGSERIAL PRIMARY KEY,
      company_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      title TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_reports_company_created ON reports(company_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_valuations_company_created ON valuation_snapshots(company_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_events_company_created ON monitoring_events(company_id, created_at DESC)`,
    `ALTER TABLE companies ADD COLUMN IF NOT EXISTS listing_status TEXT`,
    `ALTER TABLE companies ADD COLUMN IF NOT EXISTS isin TEXT`
  ];
  for (const sql of statements) await pool.query(sql);
  return { enabled: true, ready: true };
}

export async function dbQuery(text, params = []) {
  if (!pool) throw new Error('Database is not configured. Add DATABASE_URL.');
  return pool.query(text, params);
}

export async function upsertCompany({ name, ticker = null, exchange = null, sector = null, listingStatus = null, isin = null }) {
  if (!pool) throw new Error('Database is not configured.');
  const normalizedTicker = ticker ? String(ticker).trim().toUpperCase() : null;
  const normalizedExchange = exchange ? String(exchange).trim().toUpperCase() : null;
  if (normalizedTicker && normalizedExchange) {
    const q = await pool.query(
      `INSERT INTO companies(name,ticker,exchange,sector,listing_status,isin) VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (ticker,exchange) DO UPDATE SET name=EXCLUDED.name, sector=COALESCE(EXCLUDED.sector,companies.sector), listing_status=COALESCE(EXCLUDED.listing_status,companies.listing_status), isin=COALESCE(EXCLUDED.isin,companies.isin), updated_at=NOW()
       RETURNING *`,
      [name || normalizedTicker, normalizedTicker, normalizedExchange, sector, listingStatus, isin]
    );
    return q.rows[0];
  }
  const q = await pool.query(
    `INSERT INTO companies(name,sector,listing_status,isin) VALUES($1,$2,$3,$4) RETURNING *`,
    [name || 'Unknown company', sector, listingStatus, isin]
  );
  return q.rows[0];
}
