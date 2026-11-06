-- FinSight research-memory repair
-- Run once in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS companies (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  ticker TEXT,
  exchange TEXT,
  sector TEXT,
  listing_status TEXT,
  isin TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Remove only the broken/empty thesis table created by failed migrations.
DROP TABLE IF EXISTS research_theses;
CREATE TABLE research_theses (
  id BIGSERIAL PRIMARY KEY,
  company_id TEXT NOT NULL,
  thesis TEXT NOT NULL,
  bull_case TEXT,
  bear_case TEXT,
  thesis_breakers JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_research_theses_company_id ON research_theses(company_id);
