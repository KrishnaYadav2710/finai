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

    `
    ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS
    listing_status TEXT
    `,

    `
    ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS
    isin TEXT
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
   17. COMPARE TWO REPORTS
   ============================================================ */

async function summarizeReportForComparison(file, label) {

  const prompt = `
Analyze ${label} as a long-term investor. Return valid JSON only.
Extract the company name and concise evidence-based assessments of: business model,
competitive position, multi-year growth, profitability, cash generation, balance sheet,
management, governance, auditor observations, risks, capital allocation and valuation
inputs disclosed in the report. Prefer consolidated figures. Do not invent missing data.

Return:
{
  "company": "",
  "business_quality": "",
  "growth": "",
  "profitability": "",
  "cash_generation": "",
  "balance_sheet": "",
  "management": "",
  "governance": "",
  "auditor": "",
  "risk": "",
  "valuation": "",
  "strengths": [],
  "weaknesses": [],
  "important_questions": []
}`;

  const text = await geminiGenerate(
    [{ text: prompt }, pdfPart(file)],
    { json: true }
  );

  const result = safeJSON(text);
  if (!result) throw new Error(`${label} could not be summarized for comparison.`);
  return result;
}


app.post(
  "/api/ai/compare",
  upload.fields([
    { name: "companyA", maxCount: 1 },
    { name: "companyB", maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const reportA = req.files?.companyA?.[0];
      const reportB = req.files?.companyB?.[0];

      if (!reportA || !reportB) {
        return res.status(400).json({ error: "Upload both annual-report PDFs." });
      }

      // Process each large PDF separately. This avoids one oversized two-PDF Gemini request.
      const [companyA, companyB] = await Promise.all([
        summarizeReportForComparison(reportA, "Company A report"),
        summarizeReportForComparison(reportB, "Company B report")
      ]);

      const prompt = `
Compare these two structured annual-report analyses for a long-term investor.
Do not declare a simplistic winner. Explain trade-offs and do not invent data.

COMPANY A:
${JSON.stringify(companyA, null, 2)}

COMPANY B:
${JSON.stringify(companyB, null, 2)}

Return valid JSON only:
{
  "company_a": "",
  "company_b": "",
  "summary": "",
  "business_quality": {"company_a":"","company_b":"","edge":""},
  "growth": {"company_a":"","company_b":"","edge":""},
  "profitability": {"company_a":"","company_b":"","edge":""},
  "cash_generation": {"company_a":"","company_b":"","edge":""},
  "balance_sheet": {"company_a":"","company_b":"","edge":""},
  "management": {"company_a":"","company_b":"","edge":""},
  "governance": {"company_a":"","company_b":"","edge":""},
  "risk": {"company_a":"","company_b":"","edge":""},
  "valuation": {"company_a":"","company_b":"","edge":""},
  "company_a_strengths": [],
  "company_a_weaknesses": [],
  "company_b_strengths": [],
  "company_b_weaknesses": [],
  "important_tradeoffs": [],
  "questions_before_choosing_a": [],
  "questions_before_choosing_b": []
}`;

      const text = await geminiGenerate([{ text: prompt }], { json: true });
      const comparison = safeJSON(text);
      if (!comparison) throw new Error("Gemini returned an unreadable comparison.");

      return res.json({ comparison, model: GEMINI_MODEL });
    } catch (error) {
      console.error("AI comparison:", error);
      const status = Number(error?.status);
      return res.status(status >= 400 && status < 600 ? status : 500).json({
        error: error?.message || "Company comparison failed."
      });
    }
  }
);


/* ============================================================
   18. ALPHA VANTAGE MARKET QUOTE
   ============================================================ */

async function resolveAlphaVantageSymbol({ ticker, companyName, exchange }) {

  const cleanTicker = String(ticker || "").trim().toUpperCase();
  const cleanCompany = String(companyName || "").trim();
  const cleanExchange = String(exchange || "").trim().toUpperCase();
  const keywords = cleanCompany || cleanTicker;

  const url = new URL("https://www.alphavantage.co/query");
  url.searchParams.set("function", "SYMBOL_SEARCH");
  url.searchParams.set("keywords", keywords);
  url.searchParams.set("apikey", ALPHA_VANTAGE_API_KEY);

  const data = await fetchJSON(url);
  if (data.Note || data.Information) throw new Error(data.Note || data.Information);

  const matches = Array.isArray(data.bestMatches) ? data.bestMatches : [];
  if (!matches.length) return { symbol: cleanTicker, resolved: false, reason: "No symbol-search matches." };

  const normalizeName = value => String(value || "")
    .toLowerCase()
    .replace(/\b(limited|ltd|plc|inc|corporation|corp)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  const wantedName = normalizeName(cleanCompany);
  const scored = matches.map(item => {
    const symbol = String(item["1. symbol"] || "").toUpperCase();
    const name = String(item["2. name"] || "");
    const region = String(item["4. region"] || "").toLowerCase();
    const currency = String(item["8. currency"] || "");
    let score = (Number(item["9. matchScore"]) || 0) * 100;
    if (symbol === cleanTicker) score += 120;
    if (symbol.startsWith(`${cleanTicker}.`)) score += 100;
    if ((cleanExchange === "NSE" || cleanExchange === "BSE") && region.includes("india")) score += 80;
    if (cleanExchange === "BSE" && symbol.endsWith(".BSE")) score += 100;
    const candidateName = normalizeName(name);
    if (wantedName && candidateName && (candidateName.includes(wantedName) || wantedName.includes(candidateName))) score += 120;
    return { symbol, name, region, currency, score, type: item["3. type"] || null, alphaVantageMatchScore: item["9. matchScore"] || null };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < 80) {
    return { symbol: cleanTicker, resolved: false, reason: "No sufficiently reliable symbol match.", candidates: scored.slice(0, 5) };
  }
  return { ...best, resolved: true };
}


app.get(
  "/api/market/:ticker",
  async (req, res) => {
    try {
      if (!ALPHA_VANTAGE_API_KEY) {
        return res.status(503).json({ ok: false, error: "Alpha Vantage is not configured." });
      }

      const ticker = String(req.params.ticker || "").trim().toUpperCase();
      const exchange = String(req.query.exchange || "").trim().toUpperCase();
      const companyName = String(req.query.company || "").trim();
      const bseCode = String(req.query.bseCode || "").trim().toUpperCase();
      if (!ticker && !bseCode) return res.status(400).json({ ok: false, error: "Ticker or BSE code is required." });

      let resolution = { symbol: ticker, resolved: false, reason: "Direct symbol candidates used." };
      const candidates = [];
      if (bseCode) candidates.push(`${bseCode}.BSE`);
      if (exchange === "BSE" && ticker) candidates.push(ticker.endsWith(".BSE") ? ticker : `${ticker}.BSE`);

      // Alpha Vantage documents Indian global equities using BSE-style symbols.
      // If the report supplied a BSE code, try it before spending a request on SYMBOL_SEARCH.
      if (!candidates.length && ticker) {
        try {
          resolution = await resolveAlphaVantageSymbol({ ticker, companyName, exchange });
          if (resolution.symbol) candidates.push(resolution.symbol);
        } catch (e) {
          resolution = { symbol: ticker, resolved: false, reason: e.message };
        }
      }
      if (ticker && !candidates.includes(ticker)) candidates.push(ticker);

      let data = null, quote = null, price = null, symbol = null;
      let lastInfo = null;
      for (const candidate of [...new Set(candidates.filter(Boolean))]) {
        const url = new URL("https://www.alphavantage.co/query");
        url.searchParams.set("function", "GLOBAL_QUOTE");
        url.searchParams.set("symbol", candidate);
        url.searchParams.set("apikey", ALPHA_VANTAGE_API_KEY);
        data = await fetchJSON(url);
        if (data.Note || data.Information) { lastInfo = data.Note || data.Information; break; }
        quote = data["Global Quote"] || {};
        const candidatePrice = Number(quote["05. price"]);
        if (Number.isFinite(candidatePrice) && candidatePrice > 0) {
          price = candidatePrice; symbol = candidate; break;
        }
      }
      if (lastInfo) return res.status(429).json({ ok:false, error:lastInfo, symbolResolution:resolution });
      if (!Number.isFinite(price) || price <= 0) {
        return res.status(404).json({ ok:false, error:`Alpha Vantage returned no usable quote for the verified company symbols.`, ticker, bseCode, exchange, triedSymbols:candidates, symbolResolution:resolution });
      }

      let currency = resolution.currency || null;
      if (!currency && (exchange === "NSE" || exchange === "BSE")) currency = "INR";
      if (!currency && ["NASDAQ", "NYSE", "AMEX"].includes(exchange)) currency = "USD";

      const num = key => {
        const value = Number(quote[key]);
        return Number.isFinite(value) ? value : null;
      };

      return res.json({
        ok: true,
        provider: "Alpha Vantage Free",
        requestedTicker: ticker,
        ticker,
        symbol,
        companyName: companyName || resolution.name || null,
        exchange: exchange || null,
        currency,
        price,
        open: num("02. open"),
        high: num("03. high"),
        low: num("04. low"),
        previousClose: num("08. previous close"),
        change: num("09. change"),
        changePercent: quote["10. change percent"] || null,
        volume: num("06. volume"),
        asOf: quote["07. latest trading day"] || null,
        freshness: "last available / end-of-day; not live",
        live: false,
        symbolResolution: resolution
      });
    } catch (error) {
      console.error("Alpha Vantage market error:", error);
      const status = Number(error?.status);
      return res.status(status >= 400 && status < 600 ? status : 503).json({ ok: false, error: error?.message || "Automatic market-price lookup failed." });
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
