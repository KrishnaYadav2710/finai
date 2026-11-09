 /* ============================================================
   FINSIGHT AI — SERVER
   Report-first investor research backend

   FEATURES
   - Annual-report financial extraction
   - Multi-report / multi-year analysis
   - Report-grounded Ask FinSight
   - Gemini AI
   - Alpha Vantage
   - Automatic valuation support
   - DCF / Reverse DCF
   - PostgreSQL / Supabase research memory
   - Competitor annual-report comparison
   ============================================================ */


import "dotenv/config";

import express from "express";
import multer from "multer";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";

import {
  fileURLToPath
} from "node:url";

import {
  runDCF,
  reverseDCF
} from "./valuation.js";


/* ============================================================
   1. BASIC SETUP
   ============================================================ */

const { Pool } = pg;


const __filename =
  fileURLToPath(
    import.meta.url
  );


const __dirname =
  path.dirname(
    __filename
  );


const app =
  express();


const PORT =
  Number(
    process.env.PORT ||
    3000
  );


const GEMINI_MODEL =
  process.env.GEMINI_MODEL ||
  "gemini-3.5-flash-lite";


const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  "";


const ALPHA_VANTAGE_API_KEY =
  process.env.ALPHA_VANTAGE_API_KEY ||
  "";


const FINSIGHT_USERNAME =
  process.env.FINSIGHT_USERNAME ||
  "";


const FINSIGHT_PASSWORD =
  process.env.FINSIGHT_PASSWORD ||
  "";


/* ============================================================
   2. DATABASE
   ============================================================ */

const databaseEnabled =
  Boolean(
    process.env.DATABASE_URL
  );


const pool =

  databaseEnabled

    ? new Pool({

        connectionString:
          process.env.DATABASE_URL,

        ssl:

          process.env.DATABASE_SSL ===
          "false"

            ? false

            : {
                rejectUnauthorized:
                  false
              },

        max:
          Number(
            process.env
              .DATABASE_POOL_MAX ||
            5
          )

      })

    : null;


if (pool) {

  pool.on(
    "error",
    error => {

      console.error(
        "PostgreSQL pool error:",
        error
      );

    }
  );

}


async function dbQuery(
  text,
  params = []
) {

  if (!pool) {

    throw new Error(
      "Database is not configured."
    );

  }


  return pool.query(
    text,
    params
  );

}


/* ============================================================
   3. DATABASE INITIALIZATION
   ============================================================ */

async function initDatabase() {

  if (!pool) {
    return;
  }


  const statements = [

    `
    CREATE TABLE IF NOT EXISTS companies (

      id BIGSERIAL PRIMARY KEY,

      name TEXT NOT NULL,

      ticker TEXT,

      exchange TEXT,

      sector TEXT,

      listing_status TEXT,

      isin TEXT,

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      UNIQUE (ticker, exchange)

    )
    `,


    `
    CREATE TABLE IF NOT EXISTS reports (

      id BIGSERIAL PRIMARY KEY,

      company_id BIGINT
        REFERENCES companies(id)
        ON DELETE CASCADE,

      filename TEXT NOT NULL,

      report_year INTEGER,

      metrics JSONB
        NOT NULL
        DEFAULT '{}'::jsonb,

      analysis JSONB
        NOT NULL
        DEFAULT '{}'::jsonb,

      source_hash TEXT,

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()

    )
    `,


    `
    CREATE TABLE IF NOT EXISTS research_theses (

      id BIGSERIAL PRIMARY KEY,

      company_id TEXT NOT NULL,

      thesis TEXT NOT NULL,

      bull_case TEXT,

      bear_case TEXT,

      thesis_breakers JSONB
        NOT NULL
        DEFAULT '[]'::jsonb,

      status TEXT
        NOT NULL
        DEFAULT 'active',

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()

    )
    `,


    `
    CREATE TABLE IF NOT EXISTS valuation_snapshots (

      id BIGSERIAL PRIMARY KEY,

      company_id BIGINT
        REFERENCES companies(id)
        ON DELETE CASCADE,

      market JSONB
        NOT NULL
        DEFAULT '{}'::jsonb,

      fundamentals JSONB
        NOT NULL
        DEFAULT '{}'::jsonb,

      valuation JSONB
        NOT NULL
        DEFAULT '{}'::jsonb,

      ai_assessment TEXT,

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()

    )
    `,


    `
    CREATE TABLE IF NOT EXISTS management_promises (

      id BIGSERIAL PRIMARY KEY,

      company_id BIGINT
        REFERENCES companies(id)
        ON DELETE CASCADE,

      report_id BIGINT
        REFERENCES reports(id)
        ON DELETE SET NULL,

      promise TEXT NOT NULL,

      target_date DATE,

      status TEXT
        NOT NULL
        DEFAULT 'open',

      evidence JSONB
        NOT NULL
        DEFAULT '[]'::jsonb,

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()

    )
    `,


    `
    CREATE TABLE IF NOT EXISTS monitoring_events (

      id BIGSERIAL PRIMARY KEY,

      company_id BIGINT
        REFERENCES companies(id)
        ON DELETE CASCADE,

      event_type TEXT NOT NULL,

      title TEXT NOT NULL,

      severity TEXT
        NOT NULL
        DEFAULT 'info',

      payload JSONB
        NOT NULL
        DEFAULT '{}'::jsonb,

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()

    )
    `

  ];


  for (
    const statement of statements
  ) {

    try {

      await pool.query(
        statement
      );

    }

    catch (
      error
    ) {

      console.error(
        "Database schema warning:",
        error.message
      );

    }

  }


  /*
   * Existing installations may have an older companies table.
   */

  const optionalColumns = [

  /*
   * COMPANIES
   */

  `
  ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS
  listing_status TEXT
  `,

  `
  ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS
  isin TEXT
  `,


  /*
   * REPORTS
   *
   * Older FinSight databases may already have
   * this table without the newer columns.
   */

  `
  ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS
  filename TEXT
  `,

  `
  ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS
  report_year INTEGER
  `,

  `
  ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS
  metrics JSONB
  DEFAULT '{}'::jsonb
  `,

  `
  ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS
  analysis JSONB
  DEFAULT '{}'::jsonb
  `,

  `
  ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS
  source_hash TEXT
  `,

  `
  ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS
  created_at TIMESTAMPTZ
  DEFAULT NOW()
  `,


  /*
   * VALUATION SNAPSHOTS
   */

  `
  ALTER TABLE valuation_snapshots
  ADD COLUMN IF NOT EXISTS
  created_at TIMESTAMPTZ
  DEFAULT NOW()
  `,


  /*
   * MANAGEMENT PROMISES
   */

  `
  ALTER TABLE management_promises
  ADD COLUMN IF NOT EXISTS
  created_at TIMESTAMPTZ
  DEFAULT NOW()
  `,

  `
  ALTER TABLE management_promises
  ADD COLUMN IF NOT EXISTS
  updated_at TIMESTAMPTZ
  DEFAULT NOW()
  `,


  /*
   * MONITORING EVENTS
   */

  `
  ALTER TABLE monitoring_events
  ADD COLUMN IF NOT EXISTS
  created_at TIMESTAMPTZ
  DEFAULT NOW()
  `

];


  for (
    const statement of optionalColumns
  ) {

    try {

      await pool.query(
        statement
      );

    }

    catch (
      error
    ) {

      console.error(
        "Database migration warning:",
        error.message
      );

    }

  }


  console.log(
    "FinSight database ready."
  );

}


async function ensureResearchTables() {

  if (!pool) return;

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS research_theses (
      id BIGSERIAL PRIMARY KEY,
      company_id TEXT NOT NULL,
      thesis TEXT NOT NULL,
      bull_case TEXT,
      bear_case TEXT,
      thesis_breakers JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

}


/* ============================================================
   4. COMPANY DATABASE HELPER
   ============================================================ */

async function upsertCompany({

  name,

  ticker = null,

  exchange = null,

  sector = null,

  listingStatus = null,

  isin = null

}) {

  if (!pool) {

    throw new Error(
      "Database is not configured."
    );

  }


  const normalizedTicker =

    ticker

      ? String(ticker)
          .trim()
          .toUpperCase()

      : null;


  const normalizedExchange =

    exchange

      ? String(exchange)
          .trim()
          .toUpperCase()

      : null;


  if (
    normalizedTicker &&
    normalizedExchange
  ) {

    const result =
      await dbQuery(
        `
        INSERT INTO companies
        (
          name,
          ticker,
          exchange,
          sector,
          listing_status,
          isin
        )

        VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6
        )

        ON CONFLICT
        (
          ticker,
          exchange
        )

        DO UPDATE SET

          name =
            EXCLUDED.name,

          sector =
            COALESCE(
              EXCLUDED.sector,
              companies.sector
            ),

          listing_status =
            COALESCE(
              EXCLUDED.listing_status,
              companies.listing_status
            ),

          isin =
            COALESCE(
              EXCLUDED.isin,
              companies.isin
            ),

          updated_at =
            NOW()

        RETURNING *
        `,
        [
          name ||
          normalizedTicker,

          normalizedTicker,

          normalizedExchange,

          sector,

          listingStatus,

          isin
        ]
      );


    return result.rows[0];

  }


  const existing =
    await dbQuery(
      `
      SELECT *
      FROM companies

      WHERE LOWER(name) =
            LOWER($1)

      LIMIT 1
      `,
      [
        name ||
        "Unknown company"
      ]
    );


  if (
    existing.rows[0]
  ) {

    const updated =
      await dbQuery(
        `
        UPDATE companies

        SET
          listing_status =
            COALESCE(
              $2,
              listing_status
            ),

          isin =
            COALESCE(
              $3,
              isin
            ),

          updated_at =
            NOW()

        WHERE id = $1

        RETURNING *
        `,
        [
          existing.rows[0].id,
          listingStatus,
          isin
        ]
      );


    return updated.rows[0];

  }


  const result =
    await dbQuery(
      `
      INSERT INTO companies
      (
        name,
        ticker,
        exchange,
        sector,
        listing_status,
        isin
      )

      VALUES
      (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6
      )

      RETURNING *
      `,
      [
        name ||
        "Unknown company",

        normalizedTicker,

        normalizedExchange,

        sector,

        listingStatus,

        isin
      ]
    );


  return result.rows[0];

}


/* ============================================================
   5. FILE UPLOAD
   ============================================================ */

const upload =
  multer({

    storage:
      multer.memoryStorage(),

    limits: {

      fileSize:
        45 *
        1024 *
        1024

    }

  });


/* ============================================================
   6. EXPRESS
   ============================================================ */

app.use(
  express.json({
    limit: "15mb"
  })
);


app.use(
  express.urlencoded({
    extended: true,
    limit: "15mb"
  })
);


/* ============================================================
   7. BASIC AUTH
   ============================================================ */

function basicAuth(
  req,
  res,
  next
) {

  if (
    req.path ===
    "/healthz"
  ) {

    return next();

  }


  if (
    !FINSIGHT_USERNAME ||
    !FINSIGHT_PASSWORD
  ) {

    return next();

  }


  const raw =
    req.headers.authorization ||
    "";


  const [
    kind,
    encoded
  ] =
    raw.split(" ");


  if (
    kind === "Basic" &&
    encoded
  ) {

    try {

      const decoded =
        Buffer
          .from(
            encoded,
            "base64"
          )
          .toString(
            "utf8"
          );


      const separator =
        decoded.indexOf(":");


      const username =

        separator >= 0

          ? decoded.slice(
              0,
              separator
            )

          : decoded;


      const password =

        separator >= 0

          ? decoded.slice(
              separator + 1
            )

          : "";


      if (
        username ===
          FINSIGHT_USERNAME

        &&

        password ===
          FINSIGHT_PASSWORD
      ) {

        return next();

      }

    }

    catch {

      /* Authentication fails below. */

    }

  }


  res.set(
    "WWW-Authenticate",
    'Basic realm="FinSight"'
  );


  return res
    .status(401)
    .send(
      "Authentication required."
    );

}


app.use(
  basicAuth
);


/* ============================================================
   8. STATIC SITE
   ============================================================ */

app.use(
  express.static(
    __dirname
  )
);


app.get(
  "/",
  (
    req,
    res
  ) => {

    res.sendFile(
      path.join(
        __dirname,
        "finsight-investor.html"
      )
    );

  }
);


/* ============================================================
   9. HEALTH
   ============================================================ */

app.get(
  "/healthz",
  (
    req,
    res
  ) => {

    res
      .status(200)
      .send("ok");

  }
);


app.get(
  "/api/health",
  async (
    req,
    res
  ) => {

    let databaseReady =
      false;


    if (pool) {

      try {

        await dbQuery(
          "SELECT 1"
        );


        databaseReady =
          true;

      }

      catch (
        error
      ) {

        console.error(
          "Database health:",
          error.message
        );

      }

    }


    res.json({

      ok:
        true,

      aiConfigured:
        Boolean(
          GEMINI_API_KEY
        ),

      model:
        GEMINI_MODEL,

      marketProvider:
        "alphavantage",

      marketConfigured:
        Boolean(
          ALPHA_VANTAGE_API_KEY
        ),

      databaseConfigured:
        databaseEnabled,

      databaseReady,

      protected:
        Boolean(
          FINSIGHT_USERNAME &&
          FINSIGHT_PASSWORD
        ),

      reportFinancialExtraction:
        true,

      multiReportAnalysis:
        true,

      reportGroundedQA:
        true,

      automaticMarketData:
        true,

      automaticValuation:
        true,

      pdfProcessing:
        "server-side"

    });

  }
);


/* ============================================================
   10. JSON FETCH HELPER
   ============================================================ */

async function fetchJSON(
  url,
  options = {}
) {

  const response =
    await fetch(
      url,
      options
    );


  const text =
    await response.text();


  let body = {};


  if (text) {

    try {

      body =
        JSON.parse(text);

    }

    catch {

      body = {
        raw:
          text
      };

    }

  }


  if (!response.ok) {

    /*
     * Google/Gemini and several other JSON APIs return errors as
     * structured objects (for example { error: { message, status } }).
     * Passing that object directly to Error() produces "[object Object]"
     * and hides the actual provider failure. Preserve a readable message
     * and the upstream HTTP status instead.
     */

    const providerError =
      body?.error;

    const providerMessage =
      typeof providerError === "string"
        ? providerError
        : providerError?.message;

    const message =
      providerMessage
      || body?.message
      || body?.raw
      || `HTTP ${response.status}`;

    const error =
      new Error(
        typeof message === "string"
          ? message
          : JSON.stringify(message)
      );

    error.status =
      response.status;

    error.providerStatus =
      providerError?.status || null;

    error.providerDetails =
      providerError?.details || null;

    throw error;

  }


  return body;

}


/* ============================================================
   11. SAFE JSON
   ============================================================ */

function safeJSON(value) {

  if (
    value == null
  ) {
    return null;
  }


  if (
    typeof value ===
    "object"
  ) {
    return value;
  }


  try {

    return JSON.parse(
      value
    );

  }

  catch {

    return null;

  }

}


/* ============================================================
   12. GEMINI
   ============================================================ */

const analystInstructions = `

You are FinSight AI, an evidence-first equity research system.

The supplied annual report is the primary source of truth.

Never invent missing financial values.

Never substitute example-company data.

Never invent:

- ticker symbols
- exchanges
- listing status
- financial numbers
- page references
- auditor findings
- management statements
- share prices
- valuation multiples

Distinguish:

REPORTED FACT

CALCULATED METRIC

MANAGEMENT CLAIM

AI INTERPRETATION

When consolidated financial statements are available,
prefer consolidated figures for group-level investor analysis.

Never mix standalone and consolidated figures without
explicitly identifying them.

When multiple annual reports are present in one PDF,
analyze each reporting period separately first.

A financial anomaly is an investigation prompt,
not proof of misconduct.

Do not issue personalized buy/sell instructions.

`;


function extractGeminiText(
  payload
) {

  return (

    payload
      ?.candidates
      ?.[0]
      ?.content
      ?.parts

    ||

    []

  )

    .map(
      part =>
        part.text ||
        ""
    )

    .join("\n")

    .trim();

}


async function geminiGenerate(
  parts,
  {
    json = false
  } = {}
) {

  if (
    !GEMINI_API_KEY
  ) {

    throw new Error(
      "Gemini AI is not configured."
    );

  }


  const url =

    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      GEMINI_MODEL
    )}:generateContent`;


  const body = {

    system_instruction: {

      parts: [
        {
          text:
            analystInstructions
        }
      ]

    },

    contents: [

      {
        role:
          "user",

        parts
      }

    ],

    generationConfig:

      json

        ? {
            temperature:
              0.1,

            responseMimeType:
              "application/json"
          }

        : {
            temperature:
              0.15
          }

  };


  const requestOptions = {

    method:
      "POST",

    headers: {

      "Content-Type":
        "application/json",

      "x-goog-api-key":
        GEMINI_API_KEY

    },

    body:
      JSON.stringify(
        body
      )

  };


  let payload;

  const fetchGeminiWithRetry = async targetUrl => {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await fetchJSON(targetUrl, requestOptions);
      } catch (error) {
        lastError = error;
        const retryable = error?.status === 429 || (error?.status >= 500 && error?.status < 600);
        if (!retryable || attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 900 * (attempt + 1)));
      }
    }
    throw lastError;
  };


  try {

    payload =
      await fetchGeminiWithRetry(
        url
      );

  }

  catch (error) {

    /*
     * Gemini 2.5 generation can return NOT_FOUND for projects that do
     * not have legacy 2.5 inference eligibility. If an old Render
     * GEMINI_MODEL setting still points at 2.5, retry once on the
     * current Flash-Lite model rather than failing every PDF upload.
     */

    const legacy25 =
      /^gemini-2\.5-/i.test(
        GEMINI_MODEL
      );

    const unavailable =
      error?.status === 404 ||
      error?.providerStatus === "NOT_FOUND";

    if (!legacy25 || !unavailable) {
      throw error;
    }

    const fallbackModel =
      "gemini-3.5-flash-lite";

    const fallbackUrl =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        fallbackModel
      )}:generateContent`;

    console.warn(
      `Gemini model ${GEMINI_MODEL} is unavailable for generation; retrying with ${fallbackModel}.`
    );

    payload =
      await fetchGeminiWithRetry(
        fallbackUrl
      );

  }


  const text =
    extractGeminiText(
      payload
    );


  if (!text) {

    throw new Error(
      payload
        ?.promptFeedback
        ?.blockReason

      ||

      "Gemini returned no usable response."
    );

  }


  return text;

}


/* ============================================================
   13. PDF PART
   ============================================================ */

function pdfPart(file) {

  return {

    inlineData: {

      mimeType:
        "application/pdf",

      data:
        file.buffer
          .toString(
            "base64"
          )

    }

  };

}

/* ============================================================
   FINANCIAL UNIT NORMALIZATION
   All frontend financial values must be INR crore.
   ============================================================ */

function normalizeFinancialUnitsToCrore(financials) {

  if (!Array.isArray(financials)) {
    return [];
  }

  const monetaryFields = [
    "revenue",
    "ebitda",
    "cogs",
    "operating_income",
    "net_income",
    "total_assets",
    "current_assets",
    "current_liabilities",
    "total_debt",
    "cash",
    "total_equity",
    "operating_cash_flow",
    "capex",
    "inventory",
    "accounts_receivable",
    "accounts_payable",
    "finance_cost"
  ];


  return financials.map(row => {

    const normalized = {
      ...row
    };


    const unit =
      String(
        row.source_unit || ""
      )
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();


    let divisor = 1;


    /*
     * INR million -> INR crore
     *
     * 10 million = 1 crore
     */

    if (
      unit.includes("million") ||
      unit.includes("mn")
    ) {

      divisor = 10;

    }


    /*
     * INR lakh -> INR crore
     *
     * 100 lakh = 1 crore
     */

    else if (
      unit.includes("lakh") ||
      unit.includes("lac")
    ) {

      divisor = 100;

    }


    /*
     * INR billion -> INR crore
     *
     * 1 billion = 100 crore
     *
     * Therefore multiply by 100.
     */

    else if (
      unit.includes("billion") ||
      /\bbn\b/.test(unit)
    ) {

      divisor = 0.01;

    }


    /*
     * Crore already requires no conversion.
     */

    else if (
      unit.includes("crore") ||
      unit.includes("cr")
    ) {

      divisor = 1;

    }


    /*
     * Unknown unit:
     * DO NOT guess.
     */

    else {

      normalized.extraction_notes =
        [
          row.extraction_notes,
          `Unit normalization not applied because source_unit "${row.source_unit || "unknown"}" was not recognized.`
        ]
          .filter(Boolean)
          .join(" ");

      return normalized;

    }


    for (const field of monetaryFields) {

      const value =
        Number(
          row[field]
        );


      if (
        Number.isFinite(value)
      ) {

        normalized[field] =
          value / divisor;

      }

    }


    normalized.original_source_unit =
      row.source_unit || null;


    normalized.source_unit =
      "INR crore";


    normalized.extraction_notes =
      [
        row.extraction_notes,

        divisor !== 1
          ? `Server normalized monetary values from ${row.source_unit} to INR crore.`
          : null
      ]
        .filter(Boolean)
        .join(" ");


    return normalized;

  });

}


/* ============================================================
   14. FINANCIAL EXTRACTION
   ============================================================ */

app.post(
  "/api/ai/extract-financials",

  upload.single(
    "report"
  ),

  async (
    req,
    res
  ) => {

    try {

      if (!req.file) {

        return res
          .status(400)
          .json({

            error:
              "Upload an annual-report PDF."

          });

      }


      const pdfContext =
        safeJSON(
          req.body.pdfContext
        );


      const prompt = `

Extract investor-grade structured financial data from
the attached annual-report document.

The PDF may contain one annual report or several annual
reports from different years.

Optional browser context (do not rely on this instead of the audited statements):

${JSON.stringify(
  pdfContext || {},
  null,
  2
)}


============================================================
COMPANY IDENTITY
============================================================

Identify:

- legal company name
- common company name
- listing status
- ticker ONLY if explicitly supported
- exchange ONLY if explicitly supported
- ISIN where disclosed
- reporting currency

listing_status MUST be one of:

"listed"
"unlisted"
"pre-IPO"
"proposed listing"
"unknown"


IMPORTANT:

Do NOT guess ticker or exchange.

A proposed IPO does NOT mean the company is already listed.

If the report does not establish a current public ticker,
return ticker and exchange as null.


============================================================
FINANCIAL SOURCE RULE
============================================================

For group-level investor analysis:

1. Prefer CONSOLIDATED financial statements.

2. Use standalone figures only when consolidated figures
   are unavailable.

3. Do not mix standalone and consolidated figures within
   one financial-year row.

4. If multiple annual reports contain the same financial
   year as a comparative figure, use the newest audited
   annual report presentation unless there is a clear reason
   not to.

5. FINANCIAL UNITS ARE CRITICAL. Read the unit printed on the audited statement itself.
   Normalize every monetary amount to INR CRORE before returning JSON:
   - if source says "₹ in million" / "H in million" / "INR million", divide by 10
   - if source says "₹ in billion" / "H Bn", multiply by 100
   - if source says "₹ in crore", keep the number unchanged
   Do not label a billion or million figure as crore without conversion.

6. shares_outstanding should be returned in CRORE SHARES
   when reliably calculable.

7. If a field cannot be reliably extracted, return null.

8. Never use zero to represent missing information.


============================================================
EXTRACT EVERY AVAILABLE REPORTING YEAR
============================================================

SOURCE PRIORITY (MANDATORY):

A. First locate the audited CONSOLIDATED Balance Sheet, Consolidated Statement of Profit and Loss, and Consolidated Cash Flow Statement.
B. Extract financial-statement numbers from those audited statements and their notes.
C. Do NOT use "Year in Review", highlights, investor presentation KPIs, pre-sales, adjusted PAT, adjusted EBITDA, or standalone statements as substitutes for audited consolidated line items when consolidated statements exist.
D. Use the exact comparative prior-year column from the newest audited consolidated statements for the prior year.
E. EBITDA may come from an explicitly reported consolidated EBITDA disclosure; if it is an adjusted/non-GAAP KPI, mark it clearly in extraction_notes and do not present it as audited EBITDA.
F. Return source_unit and source_pages for auditability.

For each usable financial year extract:

- revenue
- EBITDA
- cost of goods sold / comparable operating cost if clearly available
- operating income / EBIT
- net income attributable/appropriate for group analysis
- total assets
- current assets
- current liabilities
- total borrowings / debt
- cash and cash equivalents where reliably available
- total equity
- operating cash flow
- capital expenditure where reliably available
- inventory
- trade/accounts receivable
- trade/accounts payable
- finance cost
- shares outstanding

For each row identify:

- financial year
- year-end year
- statement basis
- source pages when reliable
- extraction notes


============================================================
EBITDA RULE
============================================================

Use reported EBITDA when explicitly disclosed.

If EBITDA is not explicitly reported but can be reliably
calculated from disclosed financial data, calculate it and
state that in extraction_notes.

Otherwise return null.


============================================================
SHARES OUTSTANDING RULE
============================================================

Extract shares outstanding only when the annual report
provides enough evidence to calculate it reliably.

Be careful with:

- face value
- number of shares
- crore/lakh share units
- stock splits
- bonus issues
- weighted-average EPS shares versus period-end shares

For automatic market capitalization, period-end shares
outstanding are preferred.

If uncertain return null.


============================================================
OUTPUT
============================================================

Return VALID JSON ONLY:

{
  "company": {
    "name": "",
    "legal_name": "",
    "listing_status": "listed|unlisted|pre-IPO|proposed listing|unknown",
    "ticker": null,
    "exchange": null,
    "isin": null,
    "currency": "₹",
    "nse_code": null,
    "bse_code": null,
    "extraction_confidence": "High|Medium|Low"
  },

  "financials": [
    {
      "company": "",
      "financial_year": "FY2025-26",
      "year": 2026,
      "statement_basis": "Consolidated",
      "source_unit": "INR million|INR crore|INR billion",

      "revenue": null,
      "ebitda": null,
      "cogs": null,
      "operating_income": null,
      "net_income": null,

      "total_assets": null,
      "current_assets": null,
      "current_liabilities": null,

      "total_debt": null,
      "cash": null,
      "total_equity": null,

      "operating_cash_flow": null,
      "capex": null,

      "inventory": null,
      "accounts_receivable": null,
      "accounts_payable": null,

      "finance_cost": null,

      "shares_outstanding": null,

      "source_pages": [],
      "extraction_notes": ""
    }
  ],

  "validation": {
    "consolidated_preferred": true,
    "years_found": [],
    "missing_critical_fields": [],
    "warnings": []
  }
}

Return only supported reporting years.

Do not manufacture a complete row by combining incompatible
financial statements.

`;


      const text =
        await geminiGenerate(
          [
            {
              text:
                prompt
            },

            pdfPart(
              req.file
            )
          ],
          {
            json:
              true
          }
        );


      const result =
        safeJSON(text);


      if (
        !result ||
        !Array.isArray(
          result.financials
        )
      ) {

        throw new Error(
          "Gemini did not return usable financial extraction."
        );

      }


      /*
       * Defensive cleanup.
       */

      result.company =
        result.company ||
        {};


      if (
        result.company
          .listing_status !==
        "listed"
      ) {

        /*
         * Never retain an AI-guessed ticker for a company
         * it did not classify as currently listed.
         */

        result.company.ticker =
          null;

        result.company.exchange =
          null;

      }


      /*
       * Save extracted report if database is available.
       */

      let persisted =
        null;


      if (pool) {

        try {

          const companyRow =
            await upsertCompany({

              name:
                result.company
                  .legal_name

                ||

                result.company
                  .name

                ||

                "Unknown company",

              ticker:
                result.company
                  .ticker,

              exchange:
                result.company
                  .exchange,

              listingStatus:
                result.company
                  .listing_status,

              isin:
                result.company
                  .isin

            });


          const hash =
            crypto
              .createHash(
                "sha256"
              )
              .update(
                req.file.buffer
              )
              .digest(
                "hex"
              );


          const years =

            result.financials

              .map(
                row =>
                  Number(
                    row.year
                  )
              )

              .filter(
                Number.isFinite
              );


          const latestYear =
            years.length
              ? Math.max(
                  ...years
                )
              : null;


          const inserted =
            await dbQuery(
              `
              INSERT INTO reports
              (
                company_id,
                filename,
                report_year,
                metrics,
                analysis,
                source_hash
              )

              VALUES
              (
                $1,
                $2,
                $3,
                $4,
                $5,
                $6
              )

              RETURNING
                id,
                created_at
              `,
              [
                companyRow.id,

                req.file
                  .originalname,

                latestYear,

                {
                  financials:
                    result.financials,

                  validation:
                    result.validation ||
                    {},

                  pdfContext:
                    pdfContext ||
                    null
                },

                {},

                hash
              ]
            );


          persisted = {

            companyId:
              companyRow.id,

            reportId:
              inserted.rows[0].id,

            createdAt:
              inserted.rows[0]
                .created_at

          };

        }

        catch (error) {

          console.error(
            "Failed to persist financial extraction:",
            error
          );

        }

      }


      return res.json({

        ok: true,

        ...result,

        persisted

      });

    }

    catch (error) {

      console.error(
        "Financial extraction full error:",
        error
      );

      let message =
        "Annual-report financial extraction failed.";

      if (typeof error === "string") {
        message = error;
      } else if (
        error?.message &&
        typeof error.message === "string"
      ) {
        message = error.message;
      } else if (
        error &&
        typeof error === "object"
      ) {
        try {
          message = JSON.stringify(error);
        } catch {
          message =
            "Unknown financial extraction error.";
        }
      }

      const status =
        Number.isInteger(error?.status) &&
        error.status >= 400 &&
        error.status < 600
          ? error.status
          : 500;

      return res
        .status(status)
        .json({
          ok: false,
          error: message,
          providerStatus:
            error?.providerStatus || null
        });

    }

  }
);


/* ============================================================
   15. ANNUAL REPORT AI
   ============================================================ */

app.post(
  "/api/ai/analyze-report",

  upload.single(
    "report"
  ),

  async (
    req,
    res
  ) => {

    try {

      if (!req.file) {

        return res
          .status(400)
          .json({

            error:
              "Upload an annual-report PDF."

          });

      }


      const metrics =
        safeJSON(
          req.body.metrics
        );


      const pdfContext =
        safeJSON(
          req.body.pdfContext
        );


      const detectedReports =

        Array.isArray(
          pdfContext?.reports
        )

          ? pdfContext.reports

          : [];


      const isMultiReport =
        detectedReports.length > 1;


      const prompt = `

Analyze the attached annual-report document as an
evidence-first long-term investor.

Structured FinSight financial context:

${JSON.stringify(
  metrics || {},
  null,
  2
)}

Detected PDF structure:

${JSON.stringify(
  pdfContext || {},
  null,
  2
)}

${
  isMultiReport

    ?

`The PDF appears to contain ${detectedReports.length}
annual reports.

Analyze each financial year separately first, then
compare the years longitudinally.`

    :

`Analyze the available annual-report period.`
}


============================================================
ANALYZE
============================================================

For each financial year investigate:

BUSINESS
- business model
- revenue drivers
- products/services
- segments
- geographic exposure
- competitive position

FINANCIAL QUALITY
- revenue
- EBITDA
- margins
- profit
- operating cash flow
- cash conversion
- working capital
- leverage
- returns

MANAGEMENT
- strategy
- guidance
- targets
- promises
- execution

CAPITAL ALLOCATION
- capex
- acquisitions
- disposals
- dividends
- debt
- investments

GOVERNANCE
- board observations
- related-party transactions
- promoter/parent relationships
- material governance issues

AUDITOR
- opinion
- qualifications
- key audit matters
- internal controls
- audit trail observations

RISKS
- regulatory
- competition
- technology
- leverage
- litigation
- contingent liabilities
- customer concentration
- cybersecurity
- execution


============================================================
MULTI-YEAR ANALYSIS
============================================================

Where multiple reporting years exist, analyze:

- revenue trend
- EBITDA trend
- profit trend
- margin trend
- cash-flow trend
- debt trend
- working-capital trend
- return trend
- capex trend
- strategy changes
- risk changes
- auditor changes
- governance changes


============================================================
MANAGEMENT PROMISE TRACKER
============================================================

Identify forward-looking promises or commitments in earlier
reports and compare them with later evidence.

Use only:

Achieved
Partially achieved
Pending
Changed
Not verifiable


============================================================
OUTPUT
============================================================

Return valid JSON only:

{
  "company": "",
  "report_type": "single|multi",
  "financial_years": [],
  "overall_view": "",
  "confidence": "High|Medium|Low",

  "yearly_analysis": [
    {
      "financial_year": "",
      "statement_basis": "Consolidated|Standalone|Mixed",
      "business_summary": "",
      "financial_summary": {},
      "good": [],
      "bad": [],
      "watch": [],
      "risks": [],
      "management": "",
      "governance": "",
      "auditor": "",
      "capital_allocation": ""
    }
  ],

  "trend_analysis": {
    "revenue": "",
    "ebitda": "",
    "profit": "",
    "margins": "",
    "cash_flow": "",
    "cash_conversion": "",
    "debt": "",
    "finance_cost": "",
    "working_capital": "",
    "receivables": "",
    "inventory": "",
    "returns": "",
    "capital_expenditure": "",
    "capital_allocation": ""
  },

  "management_promise_tracker": [
    {
      "promise": "",
      "made_in_year": "",
      "later_evidence": "",
      "status": "Achieved|Partially achieved|Pending|Changed|Not verifiable"
    }
  ],

  "changes": {
    "new_risks": [],
    "increased_risks": [],
    "reduced_risks": [],
    "resolved_risks": [],
    "new_growth_drivers": [],
    "strategy_changes": [],
    "auditor_changes": [],
    "governance_changes": []
  },

  "good": [],
  "bad": [],
  "watch": [],
  "red_flags": [],
  "growth_drivers": [],

  "management_assessment": "",
  "governance_assessment": "",
  "auditor_assessment": "",
  "cash_quality_assessment": "",

  "investor_questions": [],
  "missing_information": []
}

For good, bad, watch, red_flags and growth_drivers use:

{
  "title": "",
  "explanation": "",
  "evidence": [],
  "priority": "High|Medium|Low"
}

Do not invent evidence.

`;


      const text =
        await geminiGenerate(
          [
            {
              text:
                prompt
            },

            pdfPart(
              req.file
            )
          ],
          {
            json:
              true
          }
        );


      const analysis =
        safeJSON(text);


      if (!analysis) {

        throw new Error(
          "Gemini returned an unreadable annual-report analysis."
        );

      }


      return res.json({

        analysis,

        model:
          GEMINI_MODEL

      });

    }

    catch (
      error
    ) {

      console.error(
        "Annual Report AI:",
        error
      );


      return res
        .status(500)
        .json({

          error:
            error.message ||
            "Annual-report analysis failed."

        });

    }

  }
);


/* ============================================================
   16. ASK FINSIGHT
   ============================================================ */

app.post(
  "/api/ai/ask",

  async (
    req,
    res
  ) => {

    try {

      const {

        question,

        company,

        financials,

        market,

        valuation,

        reportAnalysis,

        pdfContext

      } =
        req.body || {};


      if (
        !question?.trim()
      ) {

        return res
          .status(400)
          .json({

            error:
              "Question is required."

          });

      }


      if (!company) {

        return res
          .status(400)
          .json({

            error:
              "Company evidence is required. Upload an annual report first."

          });

      }


      /*
       * Ask FinSight receives the structured annual-report
       * extraction and qualitative report analysis.
       *
       * It does NOT use unsourced general knowledge as a
       * substitute for missing report evidence.
       */

      const prompt = `

Answer the investor's question about the loaded company.

QUESTION:

${question}


============================================================
COMPANY IDENTITY
============================================================

${JSON.stringify(
  company || {},
  null,
  2
)}


============================================================
EXTRACTED FINANCIAL HISTORY
============================================================

${JSON.stringify(
  financials || [],
  null,
  2
)}


============================================================
MARKET DATA
============================================================

${JSON.stringify(
  market || null,
  null,
  2
)}


============================================================
VALUATION
============================================================

${JSON.stringify(
  valuation || null,
  null,
  2
)}


============================================================
ANNUAL-REPORT AI ANALYSIS
============================================================

${JSON.stringify(
  reportAnalysis || null,
  null,
  2
)}


============================================================
LOCAL PDF EVIDENCE
============================================================

${JSON.stringify(
  pdfContext || null,
  null,
  2
)}


============================================================
ANSWER RULES
============================================================

Answer the actual question directly.

You may answer questions about:

- what the company does
- how it makes money
- products/services
- segments
- strategy
- competitive position
- revenue
- profitability
- cash flow
- debt
- working capital
- management
- governance
- auditor
- related parties
- contingent liabilities
- risks
- growth drivers
- capital allocation
- listing status
- market valuation
- report disclosures
- multi-year changes

Use only the supplied FinSight company/report context.

If the supplied evidence cannot support the answer,
say:

"Not established from the loaded annual-report evidence."

Do not fill the gap with generic knowledge.

Separate the answer into evidence categories where relevant:

REPORTED FACT

CALCULATED METRIC

MANAGEMENT CLAIM

AI INTERPRETATION

Return valid JSON only:

{
  "answer": "",
  "reported_facts": [],
  "calculated_metrics": [],
  "management_claims": [],
  "ai_interpretation": [],
  "evidence": [],
  "risks": [],
  "what_to_investigate_next": []
}

`;


      const text =
        await geminiGenerate(
          [
            {
              text:
                prompt
            }
          ],
          {
            json:
              true
          }
        );


      const answer =
        safeJSON(text);


      if (!answer) {

        throw new Error(
          "Gemini returned an unreadable answer."
        );

      }


      return res.json({

        answer,

        model:
          GEMINI_MODEL

      });

    }

    catch (
      error
    ) {

      console.error(
        "Ask FinSight:",
        error
      );


      return res
        .status(500)
        .json({

          error:
            error.message ||
            "FinSight could not answer the question."

        });

    }

  }
);


/* ============================================================
   17. COMPETITOR ANNUAL-REPORT COMPARISON
   ============================================================ */

/*
 * Architecture:
 *
 * Company A PDF
 *      ↓
 * /api/ai/prepare-comparison-report
 *      ↓
 * compact JSON A
 *
 * Company B PDF
 *      ↓
 * /api/ai/prepare-comparison-report
 *      ↓
 * compact JSON B
 *
 * JSON A + JSON B
 *      ↓
 * /api/ai/compare
 *      ↓
 * final AI comparison
 *
 * IMPORTANT:
 * /api/ai/compare NEVER receives PDFs.
 */


/* ============================================================
   17A. PREPARE ONE REPORT
   ============================================================ */

app.post(
  "/api/ai/prepare-comparison-report",

  upload.single(
    "report"
  ),

  async (
    req,
    res
  ) => {

    try {

      const report =
        req.file;


      const label =
        String(
          req.body?.label ||
          "Company"
        ).trim();


      if (!report) {

        return res
          .status(400)
          .json({

            ok:
              false,

            error:
              "Annual-report PDF is required."

          });

      }


      if (
        report.mimetype &&
        report.mimetype !==
          "application/pdf"
      ) {

        return res
          .status(400)
          .json({

            ok:
              false,

            error:
              "Comparison currently requires an annual-report PDF."

          });

      }


      console.log(
        `Preparing comparison research for ${label}:`,
        report.originalname,
        `(${Math.round(
          report.size /
          1024 /
          1024 *
          10
        ) / 10} MB)`
      );


      const prompt = `

You are FinSight AI.

Create a COMPACT, evidence-first investor profile from
the attached annual report.

This profile will later be compared with another company.

LABEL:

${label}


============================================================
SOURCE RULES
============================================================

1. The attached annual report is the source of truth.

2. Prefer AUDITED CONSOLIDATED financial statements.

3. Do not use standalone financial statements when
   consolidated statements are available for group-level
   investor analysis.

4. Do not mix standalone and consolidated numbers.

5. Preserve the actual financial year.

6. Do not invent missing information.

7. Do not guess ticker symbols, exchanges or market prices.

8. Do not issue a personalized buy/sell recommendation.

9. Keep explanations concise because this JSON will be sent
   into a later comparison request.


============================================================
FINANCIAL UNIT RULE — CRITICAL
============================================================

Read the unit printed on the audited financial statements.

Normalize monetary financial-statement values to:

₹ CRORE

Conversions:

If source is INR / ₹ million:

value in crore =
value in million ÷ 10


If source is INR / ₹ billion:

value in crore =
value in billion × 100


If source is INR / ₹ crore:

leave unchanged.


Example:

166,762 INR million

=

₹16,676.2 crore


Never treat:

166.7 billion

as:

₹166.7 crore.


============================================================
FINANCIAL SOURCE PRIORITY
============================================================

First locate:

- Consolidated Balance Sheet
- Consolidated Statement of Profit and Loss
- Consolidated Cash Flow Statement

Use their audited numbers where available.

Do NOT substitute:

- Year in Review
- highlights
- investor presentation KPIs
- pre-sales
- bookings
- adjusted PAT
- adjusted EBITDA

for audited consolidated financial-statement values.

An explicitly disclosed adjusted/non-GAAP metric may be
mentioned qualitatively, but identify it as adjusted.


============================================================
FINANCIAL ANALYSIS
============================================================

Where reliably available extract:

- revenue
- revenue growth
- EBITDA
- EBITDA margin
- operating profit
- net profit
- net margin
- operating cash flow
- free cash flow
- total assets
- total equity
- total debt
- cash
- net debt
- debt/equity
- current assets
- current liabilities
- current ratio
- receivables
- inventory
- finance cost
- ROE
- ROCE

Return null for unsupported figures.

Never use zero to mean missing information.


============================================================
QUALITATIVE ANALYSIS
============================================================

Analyze concisely:

BUSINESS

- business model
- major operating segments
- revenue drivers
- competitive strengths
- growth drivers

CASH QUALITY

- operating cash generation
- profit-to-cash conversion
- important cash-flow concerns

BALANCE SHEET

- leverage
- liquidity
- debt
- financial flexibility

MANAGEMENT

- strategy
- execution
- capital allocation

GOVERNANCE

- governance observations
- related-party issues where relevant

AUDITOR

- audit opinion
- qualifications
- key audit matters

RISKS

- business
- regulatory
- leverage
- execution
- concentration
- litigation
- governance
- other material risks


============================================================
OUTPUT
============================================================

Return VALID JSON ONLY.

Use exactly this structure:

{
  "company": {
    "name": "",
    "financial_year": "",
    "statement_basis": "",
    "original_unit": "",
    "normalized_unit": "₹ crore"
  },

  "financials": {
    "revenue": null,
    "revenue_growth": null,

    "ebitda": null,
    "ebitda_margin": null,

    "operating_profit": null,

    "net_profit": null,
    "net_margin": null,

    "operating_cash_flow": null,
    "cash_conversion": null,

    "free_cash_flow": null,

    "total_assets": null,
    "total_equity": null,

    "total_debt": null,
    "cash": null,
    "net_debt": null,

    "debt_equity": null,

    "current_assets": null,
    "current_liabilities": null,
    "current_ratio": null,

    "receivables": null,
    "inventory": null,

    "finance_cost": null,

    "roe": null,
    "roce": null
  },

  "business": {
    "business_model": "",
    "major_segments": [],
    "competitive_strengths": [],
    "growth_drivers": []
  },

  "cash_quality": "",

  "balance_sheet_assessment": "",

  "management": {
    "strategy": "",
    "capital_allocation": "",
    "execution": ""
  },

  "governance": {
    "assessment": "",
    "important_observations": []
  },

  "auditor": {
    "opinion": "",
    "key_audit_matters": [],
    "qualifications": []
  },

  "risks": [],

  "strengths": [],

  "weaknesses": [],

  "investor_questions": [],

  "confidence": "High|Medium|Low"
}

`;


      const resultText =
        await geminiGenerate(
          [
            {
              text:
                prompt
            },

            pdfPart(
              report
            )
          ],
          {
            json:
              true
          }
        );


      const research =
        safeJSON(
          resultText
        );


      if (
        !research ||
        typeof research !==
          "object" ||
        Array.isArray(
          research
        )
      ) {

        throw new Error(
          "Gemini returned unusable structured comparison data."
        );

      }


      /*
       * Ensure predictable structure.
       */

      research.company =
        research.company ||
        {};


      research.financials =
        research.financials ||
        {};


      research.business =
        research.business ||
        {};


      research.management =
        research.management ||
        {};


      research.governance =
        research.governance ||
        {};


      research.auditor =
        research.auditor ||
        {};


      research.risks =
        Array.isArray(
          research.risks
        )
          ? research.risks
          : [];


      research.strengths =
        Array.isArray(
          research.strengths
        )
          ? research.strengths
          : [];


      research.weaknesses =
        Array.isArray(
          research.weaknesses
        )
          ? research.weaknesses
          : [];


      research.investor_questions =
        Array.isArray(
          research.investor_questions
        )
          ? research.investor_questions
          : [];


      console.log(
        `${label} comparison research ready:`,
        research.company?.name ||
        report.originalname
      );


      return res.json({

        ok:
          true,

        label,

        fileName:
          report.originalname,

        research,

        model:
          GEMINI_MODEL

      });

    }

    catch (
      error
    ) {

      console.error(
        "Prepare comparison report:",
        error
      );


      const status =

        Number.isInteger(
          error?.status
        ) &&
        error.status >= 400 &&
        error.status < 600

          ? error.status

          : 500;


      return res
        .status(status)
        .json({

          ok:
            false,

          error:
            error?.message ||
            "Could not prepare annual report for comparison.",

          providerStatus:
            error?.providerStatus ||
            null

        });

    }

  }
);


/* ============================================================
   17B. COMPARE PREPARED COMPANY PROFILES
   ============================================================ */

app.post(
  "/api/ai/compare",

  async (
    req,
    res
  ) => {

    try {

      const companyA =
        req.body?.companyA;


      const companyB =
        req.body?.companyB;


      if (
        !companyA ||
        typeof companyA !==
          "object"
      ) {

        return res
          .status(400)
          .json({

            ok:
              false,

            error:
              "Prepared Company A research is required."

          });

      }


      if (
        !companyB ||
        typeof companyB !==
          "object"
      ) {

        return res
          .status(400)
          .json({

            ok:
              false,

            error:
              "Prepared Company B research is required."

          });

      }


      /*
       * This route must remain lightweight.
       *
       * If PDFs accidentally reach this route,
       * something is wrong in the frontend.
       */

      const serializedA =
        JSON.stringify(
          companyA
        );


      const serializedB =
        JSON.stringify(
          companyB
        );


      const MAX_PROFILE_SIZE =
        250000;


      if (
        serializedA.length >
          MAX_PROFILE_SIZE ||
        serializedB.length >
          MAX_PROFILE_SIZE
      ) {

        return res
          .status(413)
          .json({

            ok:
              false,

            error:
              "Prepared company research is unexpectedly large. Re-process the annual reports before comparing them."

          });

      }


      const companyAName =

        companyA
          ?.company
          ?.name

        ||

        "Company A";


      const companyBName =

        companyB
          ?.company
          ?.name

        ||

        "Company B";


      console.log(
        "Lightweight comparison started:",
        companyAName,
        "vs",
        companyBName
      );


      const prompt = `

You are FinSight AI.

Compare two companies using ONLY the structured annual-report
research supplied below.

Do not invent missing information.

Do not supplement the supplied evidence with unsourced general
knowledge.

Do not automatically declare one company the winner.

Do not provide personalized buy/sell advice.

Your job is to explain the INVESTOR TRADE-OFFS.


============================================================
COMPANY A
============================================================

${JSON.stringify(
  companyA,
  null,
  2
)}


============================================================
COMPANY B
============================================================

${JSON.stringify(
  companyB,
  null,
  2
)}


============================================================
COMPARISON FRAMEWORK
============================================================

Compare the companies on:

1. Business model and business quality

2. Growth

3. Revenue durability

4. Profitability

5. EBITDA and operating margins

6. Operating cash generation

7. Earnings quality

8. Working capital

9. Balance-sheet strength

10. Debt and leverage

11. Liquidity

12. ROE / ROCE where supported

13. Capital allocation

14. Management strategy

15. Management execution

16. Governance

17. Auditor observations

18. Key audit matters

19. Major risks

20. Growth opportunities


============================================================
EDGE RULE
============================================================

For each category, edge must be one of:

"Company A"
"Company B"
"Mixed"
"Similar"
"Insufficient evidence"


Do not award an edge merely because one company has more
disclosure.

Do not treat missing information as a negative financial
result.

Do not treat null as zero.


============================================================
VALUATION
============================================================

These profiles are primarily annual-report based.

If neither profile contains sufficient public-market valuation
evidence, state:

"Insufficient evidence"

Do not invent market prices or valuation multiples.


============================================================
OUTPUT
============================================================

Return VALID JSON ONLY.

Use exactly:

{
  "company_a": "",
  "company_b": "",

  "summary": "",

  "business_quality": {
    "company_a": "",
    "company_b": "",
    "edge": "Company A|Company B|Mixed|Similar|Insufficient evidence"
  },

  "growth": {
    "company_a": "",
    "company_b": "",
    "edge": "Company A|Company B|Mixed|Similar|Insufficient evidence"
  },

  "profitability": {
    "company_a": "",
    "company_b": "",
    "edge": "Company A|Company B|Mixed|Similar|Insufficient evidence"
  },

  "cash_generation": {
    "company_a": "",
    "company_b": "",
    "edge": "Company A|Company B|Mixed|Similar|Insufficient evidence"
  },

  "balance_sheet": {
    "company_a": "",
    "company_b": "",
    "edge": "Company A|Company B|Mixed|Similar|Insufficient evidence"
  },

  "capital_allocation": {
    "company_a": "",
    "company_b": "",
    "edge": "Company A|Company B|Mixed|Similar|Insufficient evidence"
  },

  "management": {
    "company_a": "",
    "company_b": "",
    "edge": "Company A|Company B|Mixed|Similar|Insufficient evidence"
  },

  "governance": {
    "company_a": "",
    "company_b": "",
    "edge": "Company A|Company B|Mixed|Similar|Insufficient evidence"
  },

  "auditor": {
    "company_a": "",
    "company_b": "",
    "edge": "Company A|Company B|Mixed|Similar|Insufficient evidence"
  },

  "risk": {
    "company_a": "",
    "company_b": "",
    "edge": "Company A|Company B|Mixed|Similar|Insufficient evidence"
  },

  "valuation": {
    "company_a": "",
    "company_b": "",
    "edge": "Company A|Company B|Mixed|Similar|Insufficient evidence"
  },

  "company_a_strengths": [],

  "company_a_weaknesses": [],

  "company_b_strengths": [],

  "company_b_weaknesses": [],

  "important_tradeoffs": [],

  "questions_before_choosing_a": [],

  "questions_before_choosing_b": [],

  "overall_interpretation": ""
}

`;


      /*
       * IMPORTANT:
       *
       * Only text/JSON goes to Gemini here.
       * No PDF is included.
       */

      const comparisonText =
        await geminiGenerate(
          [
            {
              text:
                prompt
            }
          ],
          {
            json:
              true
          }
        );


      const comparison =
        safeJSON(
          comparisonText
        );


      if (
        !comparison ||
        typeof comparison !==
          "object" ||
        Array.isArray(
          comparison
        )
      ) {

        throw new Error(
          "Gemini returned an unusable company comparison."
        );

      }


      /*
       * Defensive company names.
       */

      if (
        !comparison.company_a
      ) {

        comparison.company_a =
          companyAName;

      }


      if (
        !comparison.company_b
      ) {

        comparison.company_b =
          companyBName;

      }


      console.log(
        "Lightweight comparison complete:",
        comparison.company_a,
        "vs",
        comparison.company_b
      );


      return res.json({

        ok:
          true,

        comparison,

        model:
          GEMINI_MODEL

      });

    }

    catch (
      error
    ) {

      console.error(
        "Lightweight comparison failed:",
        error
      );


      const status =

        Number.isInteger(
          error?.status
        ) &&
        error.status >= 400 &&
        error.status < 600

          ? error.status

          : 500;


      return res
        .status(status)
        .json({

          ok:
            false,

          error:
            error?.message ||
            "Company comparison failed.",

          providerStatus:
            error?.providerStatus ||
            null

        });

    }

  }
);

/* ============================================================
   18. ALPHA VANTAGE MARKET QUOTE
   Identifier-first market lookup

   Priority for Indian companies:
   1. BSE security code
   2. NSE code
   3. Verified ticker

   No company-name symbol search.
   No guessed ticker.
   ============================================================ */


const marketQuoteCache =
  new Map();


const MARKET_CACHE_MS =
  6 * 60 * 60 * 1000;


/* ============================================================
   MARKET CACHE
   ============================================================ */

function getCachedMarketQuote(key) {

  const cached =
    marketQuoteCache.get(key);


  if (!cached) {
    return null;
  }


  if (
    Date.now() -
      cached.savedAt >
    MARKET_CACHE_MS
  ) {

    marketQuoteCache.delete(key);

    return null;

  }


  return cached.data;

}


function cacheMarketQuote(
  key,
  data
) {

  marketQuoteCache.set(
    key,
    {
      savedAt:
        Date.now(),

      data
    }
  );

}


/* ============================================================
   ONE ALPHA VANTAGE QUOTE REQUEST
   ============================================================ */

async function fetchAlphaQuote(
  symbol
) {

  const url =
    new URL(
      "https://www.alphavantage.co/query"
    );


  url.searchParams.set(
    "function",
    "GLOBAL_QUOTE"
  );


  url.searchParams.set(
    "symbol",
    symbol
  );


  url.searchParams.set(
    "apikey",
    ALPHA_VANTAGE_API_KEY
  );


  const data =
    await fetchJSON(url);


  /*
   * Alpha Vantage sometimes returns HTTP 200
   * with an API-limit message in the JSON.
   */

  if (
    data?.Note ||
    data?.Information
  ) {

    const error =
      new Error(
        data.Note ||
        data.Information
      );


    error.status =
      429;


    throw error;

  }


  const quote =
    data?.["Global Quote"] ||
    {};


  const price =
    Number(
      quote["05. price"]
    );


  if (
    !Number.isFinite(price) ||
    price <= 0
  ) {

    return null;

  }


  const numeric =
    key => {

      const value =
        Number(
          quote[key]
        );


      return Number.isFinite(value)
        ? value
        : null;

    };


  return {

    symbol,

    price,

    open:
      numeric(
        "02. open"
      ),

    high:
      numeric(
        "03. high"
      ),

    low:
      numeric(
        "04. low"
      ),

    volume:
      numeric(
        "06. volume"
      ),

    asOf:
      quote[
        "07. latest trading day"
      ] ||
      null,

    previousClose:
      numeric(
        "08. previous close"
      ),

    change:
      numeric(
        "09. change"
      ),

    changePercent:
      quote[
        "10. change percent"
      ] ||
      null

  };

}


/* ============================================================
   BUILD VERIFIED MARKET IDENTIFIERS
   ============================================================ */

function buildMarketCandidates({

  ticker,

  exchange,

  nseCode,

  bseCode

}) {

  const candidates =
    [];


  const cleanTicker =
    String(
      ticker || ""
    )
      .trim()
      .toUpperCase();


  const cleanExchange =
    String(
      exchange || ""
    )
      .trim()
      .toUpperCase();


  const cleanNSE =
    String(
      nseCode || ""
    )
      .trim()
      .toUpperCase();


  const cleanBSE =
    String(
      bseCode || ""
    )
      .trim()
      .toUpperCase();


  /*
   * PRIORITY 1
   *
   * BSE security code explicitly extracted
   * from annual report.
   *
   * Example:
   *
   * 543287
   *
   * becomes:
   *
   * 543287.BSE
   */

  if (cleanBSE) {

    candidates.push({

      symbol:

        cleanBSE.endsWith(
          ".BSE"
        )

          ? cleanBSE

          : `${cleanBSE}.BSE`,

      source:
        "BSE security code"

    });

  }


  /*
   * PRIORITY 2
   *
   * Explicit NSE code from annual report.
   */

  if (cleanNSE) {

    candidates.push({

      symbol:
        cleanNSE,

      source:
        "NSE code"

    });

  }


  /*
   * PRIORITY 3
   *
   * Generic ticker is allowed only because
   * it came from annual-report extraction.
   */

  if (cleanTicker) {

    /*
     * BSE ticker
     */

    if (
      cleanExchange ===
      "BSE"
    ) {

      candidates.push({

        symbol:

          cleanTicker.endsWith(
            ".BSE"
          )

            ? cleanTicker

            : `${cleanTicker}.BSE`,

        source:
          "Verified BSE ticker"

      });

    }


    /*
     * NSE / other verified ticker
     */

    else {

      candidates.push({

        symbol:
          cleanTicker,

        source:
          "Verified ticker"

      });

    }

  }


  /*
   * Remove duplicate symbols.
   */

  const seen =
    new Set();


  return candidates.filter(
    candidate => {

      if (
        !candidate.symbol ||
        seen.has(
          candidate.symbol
        )
      ) {

        return false;

      }


      seen.add(
        candidate.symbol
      );


      return true;

    }
  );

}


/* ============================================================
   MARKET PRICE ENDPOINT
   ============================================================ */

app.get(
  "/api/market/:ticker",

  async (
    req,
    res
  ) => {

    try {

      if (
        !ALPHA_VANTAGE_API_KEY
      ) {

        return res
          .status(503)
          .json({

            ok:
              false,

            error:
              "Alpha Vantage API key is not configured."

          });

      }


      const ticker =
        String(
          req.params.ticker ||
          ""
        )
          .trim()
          .toUpperCase();


      const exchange =
        String(
          req.query.exchange ||
          ""
        )
          .trim()
          .toUpperCase();


      const companyName =
        String(
          req.query.company ||
          ""
        ).trim();


      const bseCode =
        String(
          req.query.bseCode ||
          ""
        )
          .trim()
          .toUpperCase();


      const nseCode =
        String(
          req.query.nseCode ||
          ""
        )
          .trim()
          .toUpperCase();


      const isin =
        String(
          req.query.isin ||
          ""
        )
          .trim()
          .toUpperCase();


      /*
       * We store ISIN as verification metadata.
       *
       * Alpha Vantage GLOBAL_QUOTE does not use
       * the ISIN directly here.
       */

      const candidates =
        buildMarketCandidates({

          ticker,

          exchange,

          nseCode,

          bseCode

        });


      if (
        !candidates.length
      ) {

        return res
          .status(400)
          .json({

            ok:
              false,

            error:
              "No verified BSE code, NSE code or ticker was extracted from the annual report."

          });

      }


      /*
       * Use identifiers as the cache key.
       */

      const cacheKey =

        [
          bseCode,
          nseCode,
          ticker,
          exchange
        ]

          .filter(Boolean)
          .join("|");


      const cached =
        getCachedMarketQuote(
          cacheKey
        );


      if (cached) {

        return res.json({

          ...cached,

          cached:
            true

        });

      }


      let selectedQuote =
        null;


      let selectedCandidate =
        null;


      let rateLimitError =
        null;


      const triedSymbols =
        [];


      /*
       * Try identifiers in priority order.
       */

      for (
        const candidate of
        candidates
      ) {

        triedSymbols.push({

          symbol:
            candidate.symbol,

          source:
            candidate.source

        });


        try {

          const quote =
            await fetchAlphaQuote(
              candidate.symbol
            );


          if (quote) {

            selectedQuote =
              quote;


            selectedCandidate =
              candidate;


            break;

          }

        }

        catch (
          error
        ) {

          /*
           * Stop immediately if the provider
           * says the request limit was reached.
           */

          if (
            error?.status ===
            429
          ) {

            rateLimitError =
              error;

            break;

          }


          console.warn(
            `Market lookup failed for ${candidate.symbol}:`,
            error.message
          );

        }

      }


      /*
       * Alpha Vantage limit reached.
       */

      if (rateLimitError) {

        return res
          .status(429)
          .json({

            ok:
              false,

            error:
              rateLimitError.message,

            rateLimited:
              true,

            triedSymbols

          });

      }


      /*
       * No identifier returned a quote.
       */

      if (
        !selectedQuote ||
        !selectedCandidate
      ) {

        return res
          .status(404)
          .json({

            ok:
              false,

            error:
              "No market quote was returned for the verified company identifiers.",

            companyName:
              companyName ||
              null,

            ticker:
              ticker ||
              null,

            exchange:
              exchange ||
              null,

            nseCode:
              nseCode ||
              null,

            bseCode:
              bseCode ||
              null,

            isin:
              isin ||
              null,

            triedSymbols

          });

      }


      /*
       * Determine currency.
       */

      let currency =
        null;


      if (
        bseCode ||
        nseCode ||
        exchange === "NSE" ||
        exchange === "BSE" ||
        selectedQuote
          .symbol
          .endsWith(
            ".BSE"
          )
      ) {

        currency =
          "INR";

      }


      if (
        [
          "NASDAQ",
          "NYSE",
          "AMEX"
        ].includes(
          exchange
        )
      ) {

        currency =
          "USD";

      }


      const result = {

        ok:
          true,

        provider:
          "Alpha Vantage",

        companyName:
          companyName ||
          null,

        ticker:
          ticker ||
          null,

        exchange:
          exchange ||
          null,

        identifiers: {

          bseCode:
            bseCode ||
            null,

          nseCode:
            nseCode ||
            null,

          isin:
            isin ||
            null

        },

        /*
         * Actual Alpha Vantage identifier
         * that produced the quote.
         */

        symbol:
          selectedQuote.symbol,

        identifierSource:
          selectedCandidate.source,

        currency,

        price:
          selectedQuote.price,

        open:
          selectedQuote.open,

        high:
          selectedQuote.high,

        low:
          selectedQuote.low,

        previousClose:
          selectedQuote.previousClose,

        change:
          selectedQuote.change,

        changePercent:
          selectedQuote.changePercent,

        volume:
          selectedQuote.volume,

        asOf:
          selectedQuote.asOf,

        freshness:
          "last available / end-of-day",

        live:
          false,

        cached:
          false,

        triedSymbols

      };


      cacheMarketQuote(
        cacheKey,
        result
      );


      console.log(
        "Market quote resolved:",
        companyName ||
          ticker,
        "→",
        result.symbol,
        `via ${result.identifierSource}`,
        "→",
        result.price
      );


      return res.json(
        result
      );

    }

    catch (
      error
    ) {

      console.error(
        "Market quote error:",
        error
      );


      return res
        .status(
          error?.status === 429
            ? 429
            : 503
        )
        .json({

          ok:
            false,

          error:
            error?.message ||
            "Automatic market-price lookup failed."

        });

    }

  }
);

/* ============================================================
   19. HISTORICAL MARKET DATA
   ============================================================ */

app.get(
  "/api/market-history/:ticker",

  async (
    req,
    res
  ) => {

    try {

      if (
        !ALPHA_VANTAGE_API_KEY
      ) {

        throw new Error(
          "Alpha Vantage is not configured."
        );

      }


      const ticker =
        String(
          req.params.ticker ||
          ""
        )
          .trim()
          .toUpperCase();


      const exchange =
        String(
          req.query.exchange ||
          ""
        )
          .trim()
          .toUpperCase();


      const symbol =

        exchange === "BSE" &&
        !ticker.endsWith(
          ".BSE"
        )

          ? `${ticker}.BSE`

          : ticker;


      const url =
        new URL(
          "https://www.alphavantage.co/query"
        );


      url.searchParams.set(
        "function",
        "TIME_SERIES_DAILY"
      );


      url.searchParams.set(
        "symbol",
        symbol
      );


      url.searchParams.set(
        "outputsize",
        "compact"
      );


      url.searchParams.set(
        "apikey",
        ALPHA_VANTAGE_API_KEY
      );


      const data =
        await fetchJSON(url);


      const series =
        data[
          "Time Series (Daily)"
        ];


      if (!series) {

        throw new Error(

          data.Note

          ||

          data.Information

          ||

          "Historical market data unavailable."

        );

      }


      const rows =

        Object.entries(
          series
        )

          .map(
            (
              [
                date,
                values
              ]
            ) => ({

              date,

              open:
                Number(
                  values[
                    "1. open"
                  ]
                ),

              high:
                Number(
                  values[
                    "2. high"
                  ]
                ),

              low:
                Number(
                  values[
                    "3. low"
                  ]
                ),

              close:
                Number(
                  values[
                    "4. close"
                  ]
                ),

              volume:
                Number(
                  values[
                    "5. volume"
                  ]
                )

            })
          )

          .filter(
            row =>
              Number.isFinite(
                row.close
              )
          )

          .sort(
            (a, b) =>
              a.date.localeCompare(
                b.date
              )
          );


      return res.json({

        ticker,

        exchange,

        provider:
          "Alpha Vantage",

        live:
          false,

        rows

      });

    }

    catch (
      error
    ) {

      return res
        .status(503)
        .json({

          error:
            error.message

        });

    }

  }
);


/* ============================================================
   20. AI VALUATION
   ============================================================ */

app.post(
  "/api/ai/valuation",

  async (
    req,
    res
  ) => {

    try {

      const {

        company,

        market,

        fundamentals,

        valuation,

        reportAnalysis

      } =
        req.body || {};


      if (
        !market?.price
      ) {

        return res
          .status(400)
          .json({

            error:
              "Verified market price is required for public-market valuation."

          });

      }


      const prompt = `

Interpret the following company valuation for an investor.

Do not invent missing values.

COMPANY:

${JSON.stringify(
  company || {},
  null,
  2
)}

MARKET:

${JSON.stringify(
  market || {},
  null,
  2
)}

FINANCIAL HISTORY:

${JSON.stringify(
  fundamentals || [],
  null,
  2
)}

VALUATION METRICS:

${JSON.stringify(
  valuation || {},
  null,
  2
)}

ANNUAL REPORT ANALYSIS:

${JSON.stringify(
  reportAnalysis || null,
  null,
  2
)}

Assess:

- business quality
- earnings quality
- balance-sheet quality
- valuation multiples
- earnings yield
- free-cash-flow yield where available
- leverage
- what expectations may already be priced in
- what assumptions could invalidate the conclusion

You may use:

Attractive
Fair
Premium
Expensive

only as evidence-supported valuation descriptions.

Do not issue a personalized buy/sell recommendation.

Return valid JSON only:

{
  "answer": "",
  "reported_facts": [],
  "calculated_metrics": [],
  "management_claims": [],
  "ai_interpretation": [],
  "evidence": [],
  "risks": [],
  "what_to_investigate_next": []
}

`;


      const text =
        await geminiGenerate(
          [
            {
              text:
                prompt
            }
          ],
          {
            json:
              true
          }
        );


      const assessment =
        safeJSON(text);


      if (!assessment) {

        throw new Error(
          "Gemini returned an unreadable valuation assessment."
        );

      }


      return res.json({

        assessment,

        model:
          GEMINI_MODEL

      });

    }

    catch (
      error
    ) {

      console.error(
        "AI valuation:",
        error
      );


      return res
        .status(500)
        .json({

          error:
            error.message ||
            "Valuation interpretation failed."

        });

    }

  }
);


/* ============================================================
   21. DCF
   ============================================================ */

app.post(
  "/api/valuation/dcf",

  (
    req,
    res
  ) => {

    try {

      const result =
        runDCF(
          req.body || {}
        );


      return res.json(
        result
      );

    }

    catch (
      error
    ) {

      return res
        .status(400)
        .json({

          error:
            error.message

        });

    }

  }
);


/* ============================================================
   22. REVERSE DCF
   ============================================================ */

app.post(
  "/api/valuation/reverse-dcf",

  (
    req,
    res
  ) => {

    try {

      const result =
        reverseDCF(
          req.body || {}
        );


      return res.json(
        result
      );

    }

    catch (
      error
    ) {

      return res
        .status(400)
        .json({

          error:
            error.message

        });

    }

  }
);


/* ============================================================
   23. SAVE THESIS
   ============================================================ */

app.post(
  "/api/thesis",

  async (
    req,
    res
  ) => {

    try {

      if (!pool) {

        return res
          .status(503)
          .json({

            error:
              "Research memory database is not configured."

          });

      }


      await ensureResearchTables();


      const {

        company,

        ticker,

        exchange,

        thesis,

        bullCase,

        bearCase,

        thesisBreakers = []

      } =
        req.body || {};


      if (
        !company
      ) {

        return res
          .status(400)
          .json({

            error:
              "Company is required."

          });

      }


      if (
        !thesis?.trim()
      ) {

        return res
          .status(400)
          .json({

            error:
              "Investment thesis is required."

          });

      }


      const companyRow =
        await upsertCompany({

          name:
            company,

          ticker,

          exchange

        });


      const result =
        await dbQuery(
          `
          INSERT INTO research_theses
          (
            company_id,
            thesis,
            bull_case,
            bear_case,
            thesis_breakers
          )

          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5
          )

          RETURNING *
          `,
          [
            String(companyRow.id),

            thesis,

            bullCase ||
            null,

            bearCase ||
            null,

            thesisBreakers
          ]
        );


      return res.json({

        company:
          companyRow,

        thesis:
          result.rows[0]

      });

    }

    catch (
      error
    ) {

      console.error(
        "Save thesis:",
        error
      );


      return res
        .status(500)
        .json({

          error:
            error.message

        });

    }

  }
);


/* ============================================================
   24. LOAD RESEARCH MEMORY
   ============================================================ */

app.get(
  "/api/research",
  async (req, res) => {
    try {
      if (!pool) return res.status(503).json({ error: "Research memory database is not configured." });
      await ensureResearchTables();

      const ticker = String(req.query.ticker || "").trim().toUpperCase();
      const exchange = String(req.query.exchange || "").trim().toUpperCase();
      const companyName = String(req.query.company || "").trim();
      if (!ticker && !companyName) return res.status(400).json({ error: "Company name or ticker is required." });

      let companyResult;
      if (ticker) {
        companyResult = await dbQuery(
          `SELECT * FROM companies WHERE ticker = $1 AND ($2 = '' OR exchange = $2) ORDER BY updated_at DESC LIMIT 1`,
          [ticker, exchange]
        );
      }
      if ((!companyResult || !companyResult.rows[0]) && companyName) {
        companyResult = await dbQuery(
          `SELECT * FROM companies WHERE LOWER(name) = LOWER($1) ORDER BY updated_at DESC LIMIT 1`,
          [companyName]
        );
      }

      const company = companyResult?.rows?.[0];
      if (!company) return res.status(404).json({ error: "Company not found in FinSight research memory." });

      const [reports, theses, valuations, promises, events] = await Promise.all([
        dbQuery(`SELECT * FROM reports WHERE company_id = $1 ORDER BY created_at DESC LIMIT 20`, [company.id]),
        dbQuery(`SELECT * FROM research_theses WHERE company_id = $1 ORDER BY updated_at DESC LIMIT 20`, [String(company.id)]),
        dbQuery(`SELECT * FROM valuation_snapshots WHERE company_id = $1 ORDER BY created_at DESC LIMIT 20`, [company.id]),
        dbQuery(`SELECT * FROM management_promises WHERE company_id = $1 ORDER BY updated_at DESC LIMIT 50`, [company.id]),
        dbQuery(`SELECT * FROM monitoring_events WHERE company_id = $1 ORDER BY created_at DESC LIMIT 100`, [company.id])
      ]);

      return res.json({ company, reports: reports.rows, theses: theses.rows, valuations: valuations.rows, promises: promises.rows, events: events.rows });
    } catch (error) {
      console.error("Research memory:", error);
      return res.status(500).json({ error: error.message });
    }
  }
);


app.get(
  "/api/research/:ticker",

  async (
    req,
    res
  ) => {

    try {

      if (!pool) {

        return res
          .status(503)
          .json({

            error:
              "Research memory database is not configured."

          });

      }


      await ensureResearchTables();


      const ticker =
        String(
          req.params.ticker ||
          ""
        )
          .trim()
          .toUpperCase();


      const exchange =
        String(
          req.query.exchange ||
          ""
        )
          .trim()
          .toUpperCase();


      const companyResult =
        await dbQuery(
          `
          SELECT *
          FROM companies

          WHERE ticker = $1

          AND (
            $2 = ''
            OR exchange = $2
          )

          ORDER BY updated_at DESC

          LIMIT 1
          `,
          [
            ticker,
            exchange
          ]
        );


      const company =
        companyResult.rows[0];


      if (!company) {

        return res
          .status(404)
          .json({

            error:
              "Company not found in FinSight research memory."

          });

      }


      const [

        reports,

        theses,

        valuations,

        promises,

        events

      ] =
        await Promise.all(
          [

            dbQuery(
              `
              SELECT *
              FROM reports
              WHERE company_id = $1
              ORDER BY created_at DESC
              LIMIT 20
              `,
              [
                company.id
              ]
            ),

            dbQuery(
              `
              SELECT *
              FROM research_theses
              WHERE company_id = $1
              ORDER BY updated_at DESC
              LIMIT 20
              `,
              [
                company.id
              ]
            ),

            dbQuery(
              `
              SELECT *
              FROM valuation_snapshots
              WHERE company_id = $1
              ORDER BY created_at DESC
              LIMIT 20
              `,
              [
                company.id
              ]
            ),

            dbQuery(
              `
              SELECT *
              FROM management_promises
              WHERE company_id = $1
              ORDER BY updated_at DESC
              LIMIT 50
              `,
              [
                company.id
              ]
            ),

            dbQuery(
              `
              SELECT *
              FROM monitoring_events
              WHERE company_id = $1
              ORDER BY created_at DESC
              LIMIT 100
              `,
              [
                company.id
              ]
            )

          ]
        );


      return res.json({

        company,

        reports:
          reports.rows,

        theses:
          theses.rows,

        valuations:
          valuations.rows,

        promises:
          promises.rows,

        events:
          events.rows

      });

    }

    catch (
      error
    ) {

      console.error(
        "Research memory:",
        error
      );


      return res
        .status(500)
        .json({

          error:
            error.message

        });

    }

  }
);


/* ============================================================
   25. SAVE VALUATION SNAPSHOT
   ============================================================ */

app.post(
  "/api/valuation/snapshot",

  async (
    req,
    res
  ) => {

    try {

      if (!pool) {

        return res
          .status(503)
          .json({

            error:
              "Research memory database is not configured."

          });

      }


      const {

        company,

        ticker,

        exchange,

        market = {},

        fundamentals = {},

        valuation = {},

        aiAssessment = null

      } =
        req.body || {};


      const companyRow =
        await upsertCompany({

          name:
            company ||
            ticker ||
            "Unknown company",

          ticker,

          exchange

        });


      const result =
        await dbQuery(
          `
          INSERT INTO valuation_snapshots
          (
            company_id,
            market,
            fundamentals,
            valuation,
            ai_assessment
          )

          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5
          )

          RETURNING *
          `,
          [
            companyRow.id,

            market,

            fundamentals,

            valuation,

            aiAssessment
          ]
        );


      return res.json({

        company:
          companyRow,

        snapshot:
          result.rows[0]

      });

    }

    catch (
      error
    ) {

      console.error(
        "Valuation snapshot:",
        error
      );


      return res
        .status(500)
        .json({

          error:
            error.message

        });

    }

  }
);


/* ============================================================
   26. DATABASE STATUS
   ============================================================ */

app.get(
  "/api/database/status",

  async (
    req,
    res
  ) => {

    if (!pool) {

      return res.json({

        ok:
          true,

        configured:
          false,

        message:
          "Database-backed research memory is inactive."

      });

    }


    try {

      const result =
        await dbQuery(
          "SELECT NOW() AS server_time"
        );


      return res.json({

        ok:
          true,

        configured:
          true,

        connected:
          true,

        serverTime:
          result.rows[0]
            .server_time

      });

    }

    catch (
      error
    ) {

      return res
        .status(500)
        .json({

          ok:
            false,

          configured:
            true,

          connected:
            false,

          error:
            error.message

        });

    }

  }
);


/* ============================================================
   27. 404
   ============================================================ */

app.use(
  (
    req,
    res
  ) => {

    return res
      .status(404)
      .json({

        ok:
          false,

        error:
          "Route not found",

        path:
          req.path

      });

  }
);


/* ============================================================
   28. ERROR HANDLER
   ============================================================ */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(
      "Unhandled FinSight error:",
      error
    );


    if (
      error instanceof
      multer.MulterError
    ) {

      return res
        .status(400)
        .json({

          error:

            "File upload error: "

            +

            error.message

        });

    }


    return res
      .status(500)
      .json({

        error:
          error.message ||
          "Unexpected server error."

      });

  }
);


/* ============================================================
   29. START
   ============================================================ */

async function boot() {

  try {

    if (pool) {

      await initDatabase();

    }

  }

  catch (
    error
  ) {

    console.error(
      "Database initialization failed:",
      error.message
    );

  }


  app.listen(
    PORT,
    "0.0.0.0",
    () => {

      console.log(
        `FinSight AI running on port ${PORT}`
      );


      console.log(
        `Gemini: ${
          GEMINI_API_KEY
            ? "READY"
            : "NOT CONFIGURED"
        }`
      );


      console.log(
        `Alpha Vantage: ${
          ALPHA_VANTAGE_API_KEY
            ? "READY"
            : "NOT CONFIGURED"
        }`
      );


      console.log(
        `Database: ${
          databaseEnabled
            ? "CONFIGURED"
            : "NOT CONFIGURED"
        }`
      );


      console.log(
        "Annual-report financial extraction: READY"
      );


      console.log(
        "Multi-report analysis: READY"
      );


      console.log(
        "Report-grounded Q&A: READY"
      );

    }
  );

}


boot();
