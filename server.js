/* ============================================================
   FINSIGHT AI — SERVER
   Report-first investor research backend

   ARCHITECTURE
   - Financial extraction:
       1. Database cache
       2. Gemini PDF extraction — ONE attempt only
       3. Local deterministic parser fallback
   - Local PDF text extraction: pdf-parse
   - Gemini: financial extraction + qualitative AI
   - OpenAI: REMOVED
   - Alpha Vantage: market data
   - DCF / Reverse DCF
   - PostgreSQL / Supabase research memory

   EXTRACTION PRIORITY

   PDF
    ↓
   SHA-256 CACHE
    ↓ miss
   GEMINI ONCE
    ↓ failure / timeout / rate limit / invalid data
   LOCAL PDF PARSER
    ↓
   DASHBOARD

   IMPORTANT
   - FinSight accepts PDFs up to 45 MB.
   - Large PDFs can bypass Gemini to save quota.
   - OpenAI is not used.
   ============================================================ */


import "dotenv/config";

import express from "express";
import multer from "multer";
import path from "node:path";
import crypto from "node:crypto";
import pdfParse from "pdf-parse";
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


/* ============================================================
   GEMINI
   ============================================================ */

const GEMINI_MODEL =
  String(
    process.env.GEMINI_MODEL ||
    "gemini-3.8-flash"
  ).trim();


const GEMINI_API_KEY =
  String(
    process.env.GEMINI_API_KEY ||
    ""
  ).trim();


/*
 * Optional fallback model.
 *
 * IMPORTANT:
 *
 * This fallback is used ONLY for normal text AI functions.
 *
 * Financial PDF extraction NEVER retries another model.
 *
 * That keeps extraction quota usage predictable:
 *
 * one report
 * =
 * maximum one Gemini extraction generation request.
 */

const GEMINI_FALLBACK_MODEL =
  String(
    process.env.GEMINI_FALLBACK_MODEL ||
    ""
  ).trim();


function environmentInteger(
  name,
  fallback,
  minimum,
  maximum
) {

  const value =
    Number(
      process.env[name]
    );


  if (
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  ) {

    return value;
  }


  return fallback;
}


const GEMINI_TEXT_TIMEOUT_MS =
  environmentInteger(
    "GEMINI_TEXT_TIMEOUT_MS",
    60000,
    15000,
    300000
  );


/*
 * Financial extraction gets a separate timeout.
 *
 * We do not want a failed Gemini request holding the
 * dashboard indefinitely before local fallback begins.
 */

const GEMINI_EXTRACTION_TIMEOUT_MS =
  environmentInteger(
    "GEMINI_EXTRACTION_TIMEOUT_MS",
    75000,
    15000,
    180000
  );


/* ============================================================
   FINANCIAL EXTRACTION CACHE VERSION
   ============================================================ */

/*
 * Increment this whenever the extraction architecture changes
 * materially.
 *
 * Old cached extractions are deliberately ignored.
 *
 * This prevents earlier incorrect local-parser results from
 * being reused forever just because the PDF hash matches.
 */

const FINANCIAL_EXTRACTION_CACHE_VERSION =
  "hybrid-v1";


/* ============================================================
   GEMINI PDF SIZE THRESHOLD
   ============================================================ */

/*
 * FinSight itself accepts PDFs up to 45 MiB.
 *
 * But to conserve Gemini quota and avoid unnecessarily large
 * multimodal requests, only PDFs below this threshold are
 * attempted through Gemini.
 *
 * Larger PDFs go directly to the local parser.
 *
 * Render optional:
 *
 * GEMINI_EXTRACTION_MAX_PDF_MB=12
 */

const GEMINI_EXTRACTION_MAX_PDF_MB =
  (() => {

    const value =
      Number(
        process.env
          .GEMINI_EXTRACTION_MAX_PDF_MB
      );


    if (
      Number.isFinite(value) &&
      value >= 1 &&
      value <= 45
    ) {

      return value;
    }


    return 12;

  })();


const GEMINI_EXTRACTION_MAX_PDF_SIZE =
  GEMINI_EXTRACTION_MAX_PDF_MB *
  1024 *
  1024;


/* ============================================================
   OTHER PROVIDERS
   ============================================================ */

const ALPHA_VANTAGE_API_KEY =
  String(
    process.env.ALPHA_VANTAGE_API_KEY ||
    ""
  ).trim();


const FINSIGHT_USERNAME =
  String(
    process.env.FINSIGHT_USERNAME ||
    ""
  );


const FINSIGHT_PASSWORD =
  String(
    process.env.FINSIGHT_PASSWORD ||
    ""
  );


/* ============================================================
   MAXIMUM PDF SIZE
   ============================================================ */

/*
 * 45 MiB.
 */

const FINSIGHT_MAX_PDF_SIZE =
  45 *
  1024 *
  1024;


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


/* ============================================================
   DATABASE QUERY
   ============================================================ */

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
    const statement
    of statements
  ) {

    try {

      await pool.query(
        statement
      );

    }

    catch (error) {

      console.error(
        "Database schema warning:",
        error.message
      );

    }

  }


  /*
   * Existing FinSight installations may contain older
   * versions of these tables.
   *
   * Add missing columns without destroying existing data.
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
    `,

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

    `
    ALTER TABLE valuation_snapshots
    ADD COLUMN IF NOT EXISTS
    created_at TIMESTAMPTZ
    DEFAULT NOW()
    `,

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

    `
    ALTER TABLE monitoring_events
    ADD COLUMN IF NOT EXISTS
    created_at TIMESTAMPTZ
    DEFAULT NOW()
    `

  ];


  for (
    const statement
    of optionalColumns
  ) {

    try {

      await pool.query(
        statement
      );

    }

    catch (error) {

      console.error(
        "Database migration warning:",
        error.message
      );

    }

  }


  /*
   * Helpful cache lookup index.
   *
   * Failure to create it is non-fatal.
   */

  try {

    await pool.query(
      `
      CREATE INDEX IF NOT EXISTS
      reports_source_hash_idx
      ON reports(source_hash)
      `
    );

  }

  catch (error) {

    console.warn(
      "Could not create report hash index:",
      error.message
    );

  }


  console.log(
    "FinSight database ready."
  );

}


/* ============================================================
   RESEARCH TABLE SAFETY
   ============================================================ */

async function ensureResearchTables() {

  if (!pool) {
    return;
  }


  await dbQuery(
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
    `
  );

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


  const safeName =
    String(
      name ||
      ticker ||
      "Unknown company"
    )
      .trim()
      .slice(
        0,
        500
      );


  const normalizedTicker =

    ticker

      ? String(ticker)
          .trim()
          .toUpperCase()
          .slice(
            0,
            100
          )

      : null;


  const normalizedExchange =

    exchange

      ? String(exchange)
          .trim()
          .toUpperCase()
          .slice(
            0,
            100
          )

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

          safeName,

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

      ORDER BY updated_at DESC

      LIMIT 1
      `,
      [
        safeName
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
          sector =
            COALESCE(
              $2,
              sector
            ),

          listing_status =
            COALESCE(
              $3,
              listing_status
            ),

          isin =
            COALESCE(
              $4,
              isin
            ),

          updated_at =
            NOW()

        WHERE id = $1

        RETURNING *
        `,
        [

          existing.rows[0].id,

          sector,

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

        safeName,

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
        FINSIGHT_MAX_PDF_SIZE

    },

    fileFilter: (
      req,
      file,
      callback
    ) => {

      const mime =
        String(
          file?.mimetype ||
          ""
        )
          .trim()
          .toLowerCase();


      /*
       * Browsers normally send application/pdf.
       *
       * Some clients may omit the MIME type entirely,
       * therefore an empty value is allowed and the PDF
       * signature is checked later.
       */

      if (
        mime &&
        mime !==
          "application/pdf"
      ) {

        const error =
          new Error(
            "FinSight accepts PDF annual reports only."
          );


        error.status = 400;


        return callback(
          error
        );
      }


      return callback(
        null,
        true
      );

    }

  });


/* ============================================================
   PDF SIGNATURE
   ============================================================ */

function validatePdfFile(
  file
) {

  if (
    !file ||
    !Buffer.isBuffer(
      file.buffer
    ) ||
    !file.buffer.length
  ) {

    const error =
      new Error(
        "Annual-report PDF is empty or unavailable."
      );


    error.status = 400;


    throw error;
  }


  if (
    file.buffer.length >
    FINSIGHT_MAX_PDF_SIZE
  ) {

    const error =
      new Error(
        "The annual-report PDF exceeds FinSight's 45 MB upload limit."
      );


    error.status = 413;


    throw error;
  }


  /*
   * A valid PDF normally begins with:
   *
   * %PDF-
   */

  const signature =
    file.buffer
      .subarray(
        0,
        5
      )
      .toString(
        "ascii"
      );


  if (
    signature !==
    "%PDF-"
  ) {

    const error =
      new Error(
        "The uploaded file does not appear to be a valid PDF."
      );


    error.status = 400;


    throw error;
  }


  return true;
}


/* ============================================================
   6. EXPRESS
   ============================================================ */

app.use(
  express.json({

    limit:
      "15mb"

  })
);


app.use(
  express.urlencoded({

    extended:
      true,

    limit:
      "15mb"

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
        decoded.indexOf(
          ":"
        );


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


      /*
       * For this project direct comparison is sufficient.
       *
       * Authentication can be upgraded later if required.
       */

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

      /*
       * Authentication fails below.
       */

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

    return res.sendFile(
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

    return res
      .status(200)
      .send(
        "ok"
      );

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

      catch (error) {

        console.error(
          "Database health:",
          error.message
        );

      }

    }


    return res.json({

      ok:
        true,

      aiConfigured:
        Boolean(
          GEMINI_API_KEY
        ),

      aiProvider:
        "gemini",

      model:
        GEMINI_MODEL,

      fallbackModel:
        GEMINI_FALLBACK_MODEL ||
        null,

      /*
       * Financial extraction architecture.
       */

      financialExtractionProvider:
        "hybrid",

      financialExtractionFlow:
        "cache -> gemini-once -> local-fallback",

      financialExtractionCacheVersion:
        FINANCIAL_EXTRACTION_CACHE_VERSION,

      financialExtractionGeminiAttempts:
        1,

      financialExtractionGeminiMaxPdfMB:
        GEMINI_EXTRACTION_MAX_PDF_MB,

      financialExtractionGeminiTimeoutMs:
        GEMINI_EXTRACTION_TIMEOUT_MS,

      financialExtractionLocalFallback:
        true,

      financialExtractionOpenAI:
        false,

      maxPdfSizeMB:
        45,

      /*
       * Other services.
       */

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
        "hybrid"

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


  let body =
    {};


  if (text) {

    try {

      body =
        JSON.parse(
          text
        );

    }

    catch {

      body = {
        raw:
          text
      };

    }

  }


  if (!response.ok) {

    const providerError =
      body?.error;


    const providerMessage =

      typeof providerError ===
      "string"

        ? providerError

        : providerError?.message;


    const message =

      providerMessage

      ||

      body?.message

      ||

      body?.raw

      ||

      `HTTP ${response.status}`;


    const error =
      new Error(

        typeof message ===
        "string"

          ? message

          : JSON.stringify(
              message
            )

      );


    error.status =
      response.status;


    error.providerStatus =
      providerError?.status ||
      null;


    error.providerDetails =
      providerError?.details ||
      null;


    throw error;
  }


  return body;
}


/* ============================================================
   11. SAFE JSON
   ============================================================ */

function safeJSON(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {

    return null;
  }


  if (
    typeof value ===
    "object"
  ) {

    return value;
  }


  const source =
    String(
      value
    ).trim();


  if (!source) {

    return null;
  }


  /*
   * First attempt:
   * direct JSON.
   */

  try {

    return JSON.parse(
      source
    );

  }

  catch {

    /*
     * Continue.
     */

  }


  /*
   * Gemini occasionally wraps JSON in Markdown.
   */

  try {

    const cleaned =
      source
        .replace(
          /^```json\s*/i,
          ""
        )
        .replace(
          /^```\s*/,
          ""
        )
        .replace(
          /\s*```$/,
          ""
        )
        .trim();


    return JSON.parse(
      cleaned
    );

  }

  catch {

    return null;
  }

}


/* ============================================================
   12. GEMINI — TEXT AI
   ============================================================ */

/*
 * This Gemini function is used for:
 *
 * - annual-report qualitative analysis
 * - Ask FinSight
 * - competitor interpretation
 * - valuation interpretation
 *
 * Financial PDF extraction uses a separate one-shot function
 * later in this section.
 */


const analystInstructions = `

You are FinSight AI, an evidence-first equity research system.

Use supplied annual-report evidence as the primary source of truth.

Never invent missing financial values.

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

Prefer consolidated figures for group-level analysis.

Never mix standalone and consolidated figures without
explicitly identifying them.

A financial anomaly is an investigation prompt,
not proof of misconduct.

Do not issue personalized buy/sell instructions.

`;


/* ============================================================
   GEMINI RESPONSE TEXT
   ============================================================ */

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
        part?.text ||
        ""
    )
    .join("\n")
    .trim();

}


/* ============================================================
   GEMINI MODEL URL
   ============================================================ */

function geminiModelUrl(
  model
) {

  return (

    "https://generativelanguage.googleapis.com/v1beta/models/"

    +

    encodeURIComponent(
      model
    )

    +

    ":generateContent"

  );

}


/* ============================================================
   GEMINI TEMPORARY ERROR
   ============================================================ */

function isGeminiTemporaryError(
  error
) {

  const status =
    Number(
      error?.status
    );


  const providerStatus =
    String(
      error?.providerStatus ||
      ""
    )
      .trim()
      .toUpperCase();


  return (

    status === 429

    ||

    status === 500

    ||

    status === 502

    ||

    status === 503

    ||

    status === 504

    ||

    providerStatus ===
      "UNAVAILABLE"

    ||

    providerStatus ===
      "RESOURCE_EXHAUSTED"

    ||

    providerStatus ===
      "INTERNAL"

    ||

    providerStatus ===
      "PROVIDER_TIMEOUT"

  );

}


/* ============================================================
   GEMINI TEXT GENERATION
   ============================================================ */

async function geminiGenerate(
  parts,
  {
    json = false
  } = {}
) {

  if (!GEMINI_API_KEY) {

    throw new Error(
      "Gemini AI is not configured."
    );
  }


  if (
    !Array.isArray(parts) ||
    !parts.length
  ) {

    throw new Error(
      "Gemini requires text input."
    );
  }


  /*
   * Text-only safety.
   *
   * This function must not receive PDFs.
   */

  const safeParts =
    parts.map(
      part => ({

        text:
          String(
            part?.text ||
            ""
          )

      })
    );


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

        parts:
          safeParts

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


  async function requestModel(
    model
  ) {

    console.log(
      `Gemini text request: ${model}`
    );


    try {

      return await fetchJSON(

        geminiModelUrl(
          model
        ),

        {

          ...requestOptions,

          signal:
            AbortSignal.timeout(
              GEMINI_TEXT_TIMEOUT_MS
            )

        }

      );

    }

    catch (error) {

      if (
        error?.name ===
          "TimeoutError"

        ||

        error?.name ===
          "AbortError"
      ) {

        const timeoutError =
          new Error(
            `Gemini request timed out after ${GEMINI_TEXT_TIMEOUT_MS} ms.`
          );


        timeoutError.status =
          504;


        timeoutError.providerStatus =
          "PROVIDER_TIMEOUT";


        throw timeoutError;
      }


      throw error;
    }

  }


  let payload;

  let modelUsed =
    GEMINI_MODEL;


  try {

    payload =
      await requestModel(
        GEMINI_MODEL
      );

  }

  catch (primaryError) {

    /*
     * Text AI may use one configured fallback model.
     *
     * Financial PDF extraction does NOT use this behavior.
     */

    if (
      !GEMINI_FALLBACK_MODEL

      ||

      GEMINI_FALLBACK_MODEL ===
        GEMINI_MODEL

      ||

      !isGeminiTemporaryError(
        primaryError
      )
    ) {

      throw primaryError;
    }


    console.warn(
      `Gemini text model ${GEMINI_MODEL} unavailable. Trying ${GEMINI_FALLBACK_MODEL}.`
    );


    payload =
      await requestModel(
        GEMINI_FALLBACK_MODEL
      );


    modelUsed =
      GEMINI_FALLBACK_MODEL;

  }


  const text =
    extractGeminiText(
      payload
    );


  if (!text) {

    const blockReason =
      payload
        ?.promptFeedback
        ?.blockReason;


    if (blockReason) {

      throw new Error(
        `Gemini returned no usable response: ${blockReason}.`
      );
    }


    throw new Error(
      "Gemini returned no usable response."
    );
  }


  console.log(
    `Gemini text generation successful using ${modelUsed}.`
  );


  return text;
}


/* ============================================================
   12B. GEMINI FINANCIAL PDF EXTRACTION
   ONE GENERATION ATTEMPT ONLY
   ============================================================ */

/*
 * IMPORTANT
 *
 * This is intentionally separate from geminiGenerate().
 *
 * Extraction policy:
 *
 * - one Gemini model
 * - one generateContent request
 * - no model fallback
 * - no retry loop
 * - no OpenAI
 *
 * Any failure immediately allows Section 14 to run
 * the local deterministic parser.
 */


/* ============================================================
   PDF PART
   ============================================================ */

function geminiPdfPart(
  file
) {

  validatePdfFile(
    file
  );


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
   COMPACT FINANCIAL EXTRACTION PROMPT
   ============================================================ */

function buildFinancialExtractionPrompt() {

  /*
   * Keep this intentionally compact.
   *
   * Gemini identifies values.
   *
   * Server handles:
   *
   * - unit normalization
   * - validation
   * - ratios
   * - cache
   * - fallback
   */

  return `Extract audited financial data from this annual report.

RULES
- Prefer consolidated statements; use standalone only if consolidated is unavailable.
- Never mix consolidated and standalone values in one year.
- Extract every reliably supported reporting year.
- Use audited Balance Sheet, Profit & Loss, Cash Flow and relevant notes.
- Return monetary numbers exactly as printed. Do not convert units.
- Missing or uncertain = null. Never guess. Never use zero for missing data.
- Do not infer ticker, exchange or listing status.
- Period-end equity shares only; not weighted-average EPS shares.
- EBITDA: use explicit reported EBITDA; otherwise null.
- Return JSON only.

FIELDS PER YEAR
financial_year, year, statement_basis, source_unit,
revenue, ebitda, operating_income, net_income,
total_assets, current_assets, current_liabilities,
total_debt, cash, total_equity,
operating_cash_flow, capex,
inventory, accounts_receivable, accounts_payable,
finance_cost, shares_outstanding, shares_outstanding_unit.

JSON
{
  "company": {
    "name": "",
    "legal_name": "",
    "listing_status": "listed|unlisted|pre-IPO|proposed listing|unknown",
    "ticker": null,
    "exchange": null,
    "isin": null,
    "currency": "₹"
  },
  "financials": [
    {
      "financial_year": "",
      "year": null,
      "statement_basis": "Consolidated|Standalone",
      "source_unit": "",
      "revenue": null,
      "ebitda": null,
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
      "shares_outstanding_unit": null
    }
  ],
  "warnings": []
}`;
}


/* ============================================================
   ONE-SHOT GEMINI PDF EXTRACTION
   ============================================================ */

async function extractFinancialsWithGemini(
  file
) {

  if (!GEMINI_API_KEY) {

    const error =
      new Error(
        "Gemini AI is not configured."
      );


    error.status = 503;


    throw error;
  }


  validatePdfFile(
    file
  );


  /*
   * Quota-saving bypass.
   */

  if (
    file.buffer.length >
    GEMINI_EXTRACTION_MAX_PDF_SIZE
  ) {

    const error =
      new Error(
        `PDF is larger than the configured ${GEMINI_EXTRACTION_MAX_PDF_MB} MB Gemini extraction threshold.`
      );


    error.status = 413;


    error.code =
      "GEMINI_EXTRACTION_SIZE_BYPASS";


    throw error;
  }


  const body = {

    system_instruction: {

      parts: [

        {
          text:
            "Extract audited financial-statement data. Never invent missing values. Return JSON only."
        }

      ]

    },


    contents: [

      {

        role:
          "user",

        parts: [

          {
            text:
              buildFinancialExtractionPrompt()
          },

          geminiPdfPart(
            file
          )

        ]

      }

    ],


    generationConfig: {

      /*
       * Financial extraction should be deterministic.
       */

      temperature:
        0,

      responseMimeType:
        "application/json"

    }

  };


  console.log(
    `Gemini financial extraction: one attempt using ${GEMINI_MODEL}.`
  );


  let payload;


  try {

    payload =
      await fetchJSON(

        geminiModelUrl(
          GEMINI_MODEL
        ),

        {

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
            ),

          signal:
            AbortSignal.timeout(
              GEMINI_EXTRACTION_TIMEOUT_MS
            )

        }

      );

  }

  catch (error) {

    if (
      error?.name ===
        "TimeoutError"

      ||

      error?.name ===
        "AbortError"
    ) {

      const timeoutError =
        new Error(
          `Gemini financial extraction timed out after ${GEMINI_EXTRACTION_TIMEOUT_MS} ms.`
        );


      timeoutError.status =
        504;


      timeoutError.providerStatus =
        "PROVIDER_TIMEOUT";


      throw timeoutError;
    }


    throw error;
  }


  const text =
    extractGeminiText(
      payload
    );


  if (!text) {

    const error =
      new Error(
        "Gemini returned no financial extraction."
      );


    error.status = 502;


    throw error;
  }


  const result =
    safeJSON(
      text
    );


  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result)
  ) {

    const error =
      new Error(
        "Gemini returned invalid financial JSON."
      );


    error.status = 502;


    throw error;
  }


  console.log(
    "Gemini financial extraction response received."
  );


  return result;
}


/* ============================================================
   13. LOCAL PDF EXTRACTION
   ============================================================ */

/*
 * This is the fallback extraction engine.
 *
 * It does NOT call Gemini.
 *
 * Section 14 decides whether this engine is required.
 */


/* ============================================================
   13A. LOCAL PDF TEXT EXTRACTION
   ============================================================ */

async function extractPdfTextLocally(
  file
) {

  validatePdfFile(
    file
  );


  console.log(
    `Local PDF extraction started: ${(
      file.buffer.length /
      1024 /
      1024
    ).toFixed(1)} MB`
  );


  let parsed;


  try {

    parsed =
      await pdfParse(
        file.buffer
      );

  }

  catch (originalError) {

    console.error(
      "pdf-parse failed:",
      originalError
    );


    const error =
      new Error(
        "FinSight could not read this PDF locally. The report may be scanned, encrypted, damaged or image-only."
      );


    error.status = 422;


    throw error;
  }


  const text =
    String(
      parsed?.text ||
      ""
    )
      .replace(
        /\u0000/g,
        ""
      )
      .replace(
        /\u00a0/g,
        " "
      )
      .replace(
        /\r\n?/g,
        "\n"
      )
      .replace(
        /[ \t]+/g,
        " "
      )
      .replace(
        /[‐-‒–—]/g,
        "-"
      )
      .replace(
        /\n{4,}/g,
        "\n\n\n"
      )
      .trim();


  if (
    text.length <
    500
  ) {

    const error =
      new Error(
        "Very little text could be extracted from the PDF. The report may be scanned or image-based."
      );


    error.status = 422;


    throw error;
  }


  console.log(
    `Local PDF extraction successful: ${text.length.toLocaleString()} characters.`
  );


  return {

    text,

    pages:
      Number(
        parsed?.numpages
      ) ||
      null,

    info:
      parsed?.info ||
      {}

  };
}


/* ============================================================
   13B. REPORT TEXT NORMALIZATION
   ============================================================ */

function normalizeReportText(
  value
) {

  return String(
    value ||
    ""
  )
    .replace(
      /\u0000/g,
      ""
    )
    .replace(
      /\u00a0/g,
      " "
    )
    .replace(
      /\r\n?/g,
      "\n"
    )
    .replace(
      /[‐-‒–—]/g,
      "-"
    )
    .replace(
      /[ \t]+/g,
      " "
    )
    .replace(
      /\n{3,}/g,
      "\n\n"
    )
    .trim();
}


/* ============================================================
   13C. FINANCIAL NUMBER
   ============================================================ */

function finiteFinancialNumber(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {

    return null;
  }


  if (
    typeof value ===
    "number"
  ) {

    return Number.isFinite(
      value
    )

      ? value

      : null;
  }


  let text =
    String(
      value
    ).trim();


  if (!text) {

    return null;
  }


  /*
   * Accounting dash means reported zero only when the
   * dash itself is the complete value.
   */

  if (
    /^(?:-|–|—)$/.test(
      text
    )
  ) {

    return 0;
  }


  text =
    text
      .replace(
        /^[*#]+/,
        ""
      )
      .replace(
        /[*#]+$/,
        ""
      )
      .trim();


  let negative =
    false;


  /*
   * Accounting negative.
   */

  if (
    /^$begin:math:text$\[\^\(\)\]\+$end:math:text$$/.test(
      text
    )
  ) {

    negative = true;


    text =
      text
        .slice(
          1,
          -1
        )
        .trim();
  }


  text =
    text
      .replace(
        /₹/g,
        ""
      )
      .replace(
        /\bINR\b/gi,
        ""
      )
      .replace(
        /\bRs\.?\b/gi,
        ""
      )
      .replace(
        /,/g,
        ""
      )
      .trim();


  if (
    !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(
      text
    )
  ) {

    return null;
  }


  const number =
    Number(
      text
    );


  if (
    !Number.isFinite(
      number
    )
  ) {

    return null;
  }


  return negative

    ? -Math.abs(
        number
      )

    : number;
}


/* ============================================================
   ROUND FINANCIAL NUMBER
   ============================================================ */

function roundFinancial(
  value
) {

  if (
    value === null ||
    !Number.isFinite(
      value
    )
  ) {

    return null;
  }


  return Math.round(
    value *
    100
  ) /
  100;
}

/* ============================================================
   13D. ACCOUNTING NUMBER TOKENIZER
   ============================================================ */

function extractAccountingNumbers(
  text
) {

  const source =
    String(
      text ||
      ""
    );


  /*
   * Supported:
   *
   * 123
   * 1,234
   * 12,345.67
   * -123
   * -1,234.50
   * (123)
   * (1,234.50)
   *
   * This returns numeric values only.
   */

  const numberPattern =
    /\(?-?\d{1,3}(?:,\d{2,3})*(?:\.\d+)?\)?|\(?-?\d+(?:\.\d+)?\)?/g;


  const matches =
    source.match(
      numberPattern
    );


  if (!matches) {

    return [];

  }


  return matches

    .map(
      value =>
        finiteFinancialNumber(
          value
        )
    )

    .filter(
      value =>
        value !== null &&
        Number.isFinite(
          value
        )
    );

}


/* ============================================================
   13E. YEAR HELPERS
   ============================================================ */

function normalizeYear(
  value
) {

  const year =
    Number(
      value
    );


  if (
    !Number.isInteger(
      year
    ) ||
    year < 2000 ||
    year > 2200
  ) {

    return null;

  }


  return year;

}


function financialYearLabel(
  year
) {

  const normalized =
    normalizeYear(
      year
    );


  if (!normalized) {

    return null;

  }


  return (
    `FY${normalized - 1}-` +
    String(
      normalized
    ).slice(
      -2
    )
  );

}

/* ============================================================
   DETECT STATEMENT YEARS
   ============================================================ */

function detectStatementYears(
  section
) {

  if (!section) {

    return [];
  }


  /*
   * Only inspect the beginning of the detected statement.
   *
   * This prevents unrelated accounting-standard years such
   * as 2013 or incorporation years such as 2019 from becoming
   * financial columns.
   */

  const header =
    String(
      section
    )
      .slice(
        0,
        5000
      );


  const currentYear =
    new Date()
      .getFullYear();


  const candidates =
    new Map();


  const matches =
    header.matchAll(
      /\b(20\d{2})\b/g
    );


  for (
    const match
    of matches
  ) {

    const year =
      Number(
        match[1]
      );


    if (
      !Number.isInteger(
        year
      ) ||
      year < 2000 ||
      year >
        currentYear + 2
    ) {

      continue;
    }


    const position =
      match.index ||
      0;


    const existing =
      candidates.get(
        year
      ) ||
      {
        count:
          0,

        positionScore:
          0
      };


    existing.count +=
      1;


    existing.positionScore +=
      Math.max(
        0,
        5000 -
        position
      );


    candidates.set(
      year,
      existing
    );

  }


  if (
    !candidates.size
  ) {

    return [];
  }


  const ranked =
    [
      ...candidates.entries()
    ]
      .sort(
        (
          a,
          b
        ) => {

          const scoreA =
            a[1].count *
            10000

            +

            a[1]
              .positionScore;


          const scoreB =
            b[1].count *
            10000

            +

            b[1]
              .positionScore;


          if (
            scoreB !==
            scoreA
          ) {

            return scoreB -
              scoreA;
          }


          return b[0] -
            a[0];

        }
      )
      .map(
        entry =>
          entry[0]
      );


  /*
   * Financial statements almost always present:
   *
   * current year
   * comparative previous year
   *
   * Use the latest credible year and its immediately
   * preceding comparative year.
   */

  const latest =
    Math.max(
      ...ranked
    );


  const result =
    [];


  if (
    candidates.has(
      latest
    )
  ) {

    result.push(
      latest
    );
  }


  if (
    candidates.has(
      latest - 1
    )
  ) {

    result.push(
      latest - 1
    );
  }


  if (
    !result.length
  ) {

    result.push(
      latest
    );
  }


  return result;
}


/* ============================================================
   13F. COMPANY NAME
   ============================================================ */

function cleanCompanyCandidate(
  value
) {

  return String(
    value ||
    ""
  )
    .replace(
      /\s+/g,
      " "
    )
    .replace(
      /\bannual report\b.*$/i,
      ""
    )
    .trim();
}


function detectCompanyName(
  text,
  info = {}
) {

  const metadata =
    cleanCompanyCandidate(

      info?.Title

      ||

      info?.title

      ||

      ""

    );


  if (
    metadata &&
    metadata.length >= 4 &&
    metadata.length <= 180 &&
    !/^(annual report|report|document|untitled)$/i.test(
      metadata
    )
  ) {

    if (
      /\b(limited|ltd|corporation|corp|company|industries|bank|finance|financial|technologies|technology|telecom|platforms|holdings|enterprises)\b/i.test(
        metadata
      )
    ) {

      return metadata;
    }

  }


  const lines =
    String(
      text ||
      ""
    )
      .split(
        "\n"
      )
      .map(
        line =>
          cleanCompanyCandidate(
            line
          )
      )
      .filter(
        Boolean
      )
      .slice(
        0,
        300
      );


  const patterns = [

    /\b[A-Za-z][A-Za-z0-9&.,'() -]{2,120}\s+Limited\b/i,

    /\b[A-Za-z][A-Za-z0-9&.,'() -]{2,120}\s+Ltd\.?\b/i,

    /\b[A-Za-z][A-Za-z0-9&.,'() -]{2,120}\s+Corporation\b/i,

    /\b[A-Za-z][A-Za-z0-9&.,'() -]{2,120}\s+Company\b/i

  ];


  for (
    const line
    of lines
  ) {

    if (
      /independent auditor|auditor's report|auditors' report/i.test(
        line
      )
    ) {

      continue;
    }


    for (
      const pattern
      of patterns
    ) {

      const match =
        line.match(
          pattern
        );


      if (
        match?.[0]
      ) {

        return cleanCompanyCandidate(
          match[0]
        );
      }

    }

  }


  return "Unknown company";
}


/* ============================================================
   13G. STATEMENT HEADINGS
   ============================================================ */

const PROFIT_STATEMENT_HEADINGS = [

  "consolidated statement of profit and loss",

  "consolidated statement of profit & loss",

  "consolidated profit and loss account",

  "consolidated income statement",

  "consolidated statement of income",

  "statement of consolidated income",

  "statement of profit and loss",

  "statement of profit & loss",

  "profit and loss account",

  "income statement"

];


const BALANCE_SHEET_HEADINGS = [

  "consolidated balance sheet",

  "consolidated statement of financial position",

  "statement of consolidated financial position",

  "balance sheet",

  "statement of financial position"

];


const CASH_FLOW_HEADINGS = [

  "consolidated statement of cash flows",

  "consolidated statement of cash flow",

  "consolidated cash flow statement",

  "statement of cash flows",

  "statement of cash flow",

  "cash flow statement"

];


/* ============================================================
   13H. HEADING POSITIONS
   ============================================================ */

function findAllHeadingPositions(
  text,
  headings
) {

  const source =
    String(
      text ||
      ""
    );


  const lower =
    source.toLowerCase();


  const results =
    [];


  for (
    const heading
    of headings
  ) {

    const needle =
      String(
        heading
      )
        .toLowerCase();


    let position =
      0;


    while (
      position <
      lower.length
    ) {

      const index =
        lower.indexOf(
          needle,
          position
        );


      if (
        index ===
        -1
      ) {

        break;
      }


      results.push({

        index,

        heading

      });


      position =
        index +
        needle.length;

    }

  }


  return results.sort(
    (
      a,
      b
    ) =>
      a.index -
      b.index
  );
}


/* ============================================================
   13I. SCORE STATEMENT CANDIDATE
   ============================================================ */

function scoreStatementCandidate(
  text,
  candidate,
  type
) {

  const window =
    text.slice(
      candidate.index,
      candidate.index +
      45000
    );


  const lower =
    window.toLowerCase();


  let score =
    0;


  if (
    candidate.heading
      .toLowerCase()
      .includes(
        "consolidated"
      )
  ) {

    score += 15;
  }


  if (
    /\bconsolidated\b/i.test(
      window.slice(
        0,
        1200
      )
    )
  ) {

    score += 8;
  }


  /*
   * Penalize contents/index references.
   */

  if (
    /table of contents|contents/i.test(
      window.slice(
        0,
        500
      )
    )
  ) {

    score -= 20;
  }


  const numberCount =
    extractAccountingNumbers(
      window.slice(
        0,
        20000
      )
    ).length;


  if (
    numberCount >= 30
  ) {

    score += 8;
  }

  else if (
    numberCount >= 10
  ) {

    score += 4;
  }


  const years =
    detectStatementYears(
      window
    );


  if (
    years.length >= 2
  ) {

    score += 8;
  }

  else if (
    years.length === 1
  ) {

    score += 3;
  }


  if (
    type ===
    "profit"
  ) {

    if (
      lower.includes(
        "revenue"
      )
    ) {

      score += 4;
    }


    if (
      lower.includes(
        "profit"
      )
    ) {

      score += 4;
    }


    if (
      lower.includes(
        "finance cost"
      )
    ) {

      score += 2;
    }

  }


  if (
    type ===
    "balance"
  ) {

    if (
      lower.includes(
        "total assets"
      )
    ) {

      score += 5;
    }


    if (
      lower.includes(
        "total equity"
      )
    ) {

      score += 4;
    }


    if (
      lower.includes(
        "liabilities"
      )
    ) {

      score += 4;
    }

  }


  if (
    type ===
    "cash"
  ) {

    if (
      lower.includes(
        "operating activities"
      )
    ) {

      score += 6;
    }


    if (
      lower.includes(
        "investing activities"
      )
    ) {

      score += 3;
    }


    if (
      lower.includes(
        "financing activities"
      )
    ) {

      score += 3;
    }

  }


  /*
   * Early occurrences are often contents pages.
   */

  const fraction =
    candidate.index /
    Math.max(
      text.length,
      1
    );


  if (
    fraction <
    0.05
  ) {

    score -= 8;
  }


  return score;
}


/* ============================================================
   13J. FIND BEST STATEMENT
   ============================================================ */

function findBestStatement(
  text,
  headings,
  type,
  maxLength = 120000
) {

  const source =
    normalizeReportText(
      text
    );


  const candidates =
    findAllHeadingPositions(
      source,
      headings
    );


  if (
    !candidates.length
  ) {

    return {

      text:
        "",

      heading:
        null,

      index:
        -1,

      score:
        null

    };
  }


  let best =
    null;


  for (
    const candidate
    of candidates
  ) {

    const score =
      scoreStatementCandidate(
        source,
        candidate,
        type
      );


    if (
      !best ||
      score >
        best.score
    ) {

      best = {

        ...candidate,

        score

      };
    }

  }


  if (!best) {

    return {

      text:
        "",

      heading:
        null,

      index:
        -1,

      score:
        null

    };
  }


  return {

    text:
      source.slice(
        best.index,
        best.index +
        maxLength
      ),

    heading:
      best.heading,

    index:
      best.index,

    score:
      best.score

  };
}


/* ============================================================
   13K. FINANCIAL UNIT DETECTION
   ============================================================ */

function detectFinancialUnit(
  statementText,
  fallbackText = ""
) {

  function detect(
    source
  ) {

    const text =
      String(
        source ||
        ""
      )
        .slice(
          0,
          50000
        )
        .replace(
          /\u00a0/g,
          " "
        )
        .replace(
          /\s+/g,
          " "
        )
        .toLowerCase();


    /*
     * IMPORTANT:
     *
     * pdf-parse may corrupt the rupee symbol.
     *
     * Example from the supplied Jio report:
     *
     * "The Consolidated Financial Statements are presented
     * in Indian Rupees (C) and all values are rounded
     * to the nearest crore (C 00,00,000)"
     *
     * Therefore explicit wording about Indian Rupees and
     * nearest crore is sufficient evidence of INR crore.
     */

    if (
      /indian rupees?[^.]{0,250}(?:nearest\s+)?crore/i.test(
        text
      )

      ||

      /all values are rounded[^.]{0,150}(?:nearest\s+)?crore/i.test(
        text
      )

      ||

      /(?:₹|rs\.?|inr|rupees?|amounts?|figures?)[^.!?\n]{0,120}\bcrores?\b/i.test(
        text
      )

      ||

      /\bcrores?\b[^.!?\n]{0,80}(?:₹|rs\.?|inr|rupees?)/i.test(
        text
      )
    ) {

      return "INR crore";
    }


    if (
      /indian rupees?[^.]{0,250}(?:nearest\s+)?million/i.test(
        text
      )

      ||

      /(?:₹|rs\.?|inr|rupees?|amounts?|figures?)[^.!?\n]{0,120}\bmillions?\b/i.test(
        text
      )

      ||

      /\bmillions?\b[^.!?\n]{0,80}(?:₹|rs\.?|inr|rupees?)/i.test(
        text
      )
    ) {

      return "INR million";
    }


    if (
      /indian rupees?[^.]{0,250}(?:nearest\s+)?lakh/i.test(
        text
      )

      ||

      /(?:₹|rs\.?|inr|rupees?|amounts?|figures?)[^.!?\n]{0,120}\blakhs?\b/i.test(
        text
      )

      ||

      /\blakhs?\b[^.!?\n]{0,80}(?:₹|rs\.?|inr|rupees?)/i.test(
        text
      )
    ) {

      return "INR lakh";
    }


    if (
      /indian rupees?[^.]{0,250}(?:nearest\s+)?billion/i.test(
        text
      )

      ||

      /(?:₹|rs\.?|inr|rupees?|amounts?|figures?)[^.!?\n]{0,120}\bbillions?\b/i.test(
        text
      )

      ||

      /\bbillions?\b[^.!?\n]{0,80}(?:₹|rs\.?|inr|rupees?)/i.test(
        text
      )
    ) {

      return "INR billion";
    }


    return null;
  }


  const statementUnit =
    detect(
      statementText
    );


  if (
    statementUnit
  ) {

    return statementUnit;
  }


  return detect(
    fallbackText
  );
}


/* ============================================================
   13L. UNIT FACTOR
   ============================================================ */

function monetaryCroreFactor(
  sourceUnit
) {

  const unit =
    String(
      sourceUnit ||
      ""
    )
      .toLowerCase()
      .trim();


  if (
    unit.includes(
      "crore"
    )
  ) {

    return 1;
  }


  if (
    unit.includes(
      "million"
    )
  ) {

    return 0.1;
  }


  if (
    unit.includes(
      "lakh"
    )
  ) {

    return 0.01;
  }


  if (
    unit.includes(
      "billion"
    )
  ) {

    return 100;
  }


  return null;
}


/* ============================================================
   13M. STATEMENT LINES
   ============================================================ */

function statementLines(
  section
) {

  return String(
    section ||
    ""
  )
    .split(
      "\n"
    )
    .map(
      line =>
        line
          .replace(
            /\s+/g,
            " "
          )
          .trim()
    )
    .filter(
      Boolean
    );
}


/* ============================================================
   13N. LABEL NORMALIZATION
   ============================================================ */

function normalizedLabelText(
  value
) {

  return String(
    value ||
    ""
  )
    .toLowerCase()
    .replace(
      /&/g,
      " and "
    )
    .replace(
      /[’']/g,
      ""
    )
    .replace(
      /[^a-z0-9 ]+/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}


function lineMatchesLabel(
  line,
  labels
) {

  const normalized =
    normalizedLabelText(
      line
    );


  return labels.some(
    label => {

      const target =
        normalizedLabelText(
          label
        );


      if (!target) {

        return false;
      }


      return (

        normalized ===
          target

        ||

        normalized.startsWith(
          `${target} `
        )

        ||

        normalized.includes(
          ` ${target} `
        )

        ||

        normalized.endsWith(
          ` ${target}`
        )

      );

    }
  );
}


/* ============================================================
   END BLOCK 1A

   BLOCK 1B CONTINUES DIRECTLY FROM HERE.

   DO NOT ADD:
   }
   );
   boot();
   OR ANY OTHER CODE BETWEEN 1A AND 1B.
   ============================================================ */
/* ============================================================
   13O. EXCLUDE UNWANTED ROWS
   ============================================================ */

function lineContainsExcludedText(
  line,
  exclude = []
) {

  if (
    !Array.isArray(exclude) ||
    !exclude.length
  ) {

    return false;
  }


  const normalized =
    normalizedLabelText(
      line
    );


  return exclude.some(
    item =>
      normalized.includes(
        normalizedLabelText(
          item
        )
      )
  );
}


/* ============================================================
   13P. FIND METRIC ROW
   ============================================================ */

/*
 * pdf-parse does not always preserve tables perfectly.
 *
 * A statement row may appear as:
 *
 * Revenue from operations 23 128218 117819
 *
 * OR:
 *
 * Revenue from operations
 * 23
 * 128218
 * 117819
 *
 * Therefore inspect the matched line and a small number of
 * immediately following lines.
 *
 * Do NOT search a huge notes section after matching a label.
 */

function findMetricRow(
  section,
  labels,
  {
    exclude = [],
    lookAheadLines = 4
  } = {}
) {

  if (!section) {

    return null;
  }


  const lines =
    statementLines(
      section
    );


  for (
    let index = 0;
    index < lines.length;
    index++
  ) {

    const line =
      lines[index];


    if (
      !lineMatchesLabel(
        line,
        labels
      )
    ) {

      continue;
    }


    if (
      lineContainsExcludedText(
        line,
        exclude
      )
    ) {

      continue;
    }


    /*
     * Build only a small local row window.
     *
     * This is deliberately narrow so values from unrelated
     * note disclosures are not accidentally attached to the
     * matched financial-statement label.
     */

    const rowLines =
      [
        line
      ];


    for (
      let offset = 1;
      offset <= lookAheadLines;
      offset++
    ) {

      const next =
        lines[
          index +
          offset
        ];


      if (!next) {
        break;
      }


      /*
       * Stop if the next line clearly looks like another
       * statement label rather than continuation numbers.
       */

      const nextNormalized =
        normalizedLabelText(
          next
        );


      const nextNumbers =
        extractAccountingNumbers(
          next
        );


      const mostlyText =
        nextNormalized.length > 12 &&
        nextNumbers.length === 0;


      if (
        offset > 1 &&
        mostlyText
      ) {

        break;
      }


      rowLines.push(
        next
      );


      /*
       * Two or more amounts are normally enough for current
       * and comparative columns.
       */

      const currentNumbers =
        extractAccountingNumbers(
          rowLines.join(" ")
        );


      if (
        currentNumbers.length >= 3
      ) {

        break;
      }

    }


    const combined =
      rowLines.join(
        " "
      );


    const values =
      extractAccountingNumbers(
        combined
      );


    if (
      values.length
    ) {

      return {

        index,

        line,

        combined,

        values

      };
    }

  }


  return null;
}


/* ============================================================
   13Q. REMOVE LIKELY NOTE NUMBER
   ============================================================ */

function removeLikelyNoteNumber(
  values,
  expectedColumns = 2
) {

  if (
    !Array.isArray(values)
  ) {

    return [];
  }


  const cleaned =
    values.filter(
      value =>
        Number.isFinite(
          value
        )
    );


  if (
    cleaned.length <=
    expectedColumns
  ) {

    return cleaned;
  }


  /*
   * Common Indian statement layout:
   *
   * Metric | Note | 2026 | 2025
   *
   * A small first integer is often the note reference.
   */

  if (
    cleaned.length >=
      expectedColumns + 1

    &&

    Number.isInteger(
      cleaned[0]
    )

    &&

    cleaned[0] >= 1

    &&

    cleaned[0] <= 500
  ) {

    return cleaned.slice(
      1
    );
  }


  return cleaned;
}


/* ============================================================
   13R. MAP ROW VALUES TO YEARS
   ============================================================ */

function mapValuesToYears(
  values,
  years
) {

  const result =
    {};


  if (
    !Array.isArray(years) ||
    !years.length
  ) {

    return result;
  }


  let amounts =
    removeLikelyNoteNumber(
      values,
      years.length
    );


  /*
   * If there are extra values after removing a note number,
   * prefer the first N financial columns.
   *
   * Do not use trailing percentages or note references.
   */

  if (
    amounts.length >
    years.length
  ) {

    amounts =
      amounts.slice(
        0,
        years.length
      );
  }


  for (
    let index = 0;
    index < years.length;
    index++
  ) {

    const year =
      years[index];


    const value =
      amounts[index];


    result[year] =

      Number.isFinite(
        value
      )

        ? value

        : null;
  }


  return result;
}


/* ============================================================
   13S. EXTRACT MONEY METRIC
   ============================================================ */

function extractMoneyMetric(
  section,
  labels,
  years,
  factor,
  options = {}
) {

  const result =
    {};


  for (
    const year
    of years
  ) {

    result[year] =
      null;
  }


  if (
    !section ||
    factor === null
  ) {

    return result;
  }


  const row =
    findMetricRow(
      section,
      labels,
      options
    );


  if (!row) {

    return result;
  }


  const mapped =
    mapValuesToYears(
      row.values,
      years
    );


  for (
    const year
    of years
  ) {

    const raw =
      finiteFinancialNumber(
        mapped[year]
      );


    result[year] =

      raw === null

        ? null

        : roundFinancial(
            raw *
            factor
          );
  }


  return result;
}


/* ============================================================
   13T. EXTRACT RAW METRIC
   ============================================================ */

function extractRawMetric(
  section,
  labels,
  years,
  options = {}
) {

  const result =
    {};


  for (
    const year
    of years
  ) {

    result[year] =
      null;
  }


  const row =
    findMetricRow(
      section,
      labels,
      options
    );


  if (!row) {

    return result;
  }


  const mapped =
    mapValuesToYears(
      row.values,
      years
    );


  for (
    const year
    of years
  ) {

    result[year] =
      finiteFinancialNumber(
        mapped[year]
      );
  }


  return result;
}


/* ============================================================
   13U. MERGE METRIC BY YEAR
   ============================================================ */

function valueForYear(
  metric,
  year
) {

  if (
    !metric ||
    typeof metric !== "object"
  ) {

    return null;
  }


  return finiteFinancialNumber(
    metric[year]
  );
}


/* ============================================================
   13V. SAFE CALCULATIONS
   ============================================================ */

function safeRatio(
  numerator,
  denominator,
  multiplier = 1
) {

  const a =
    finiteFinancialNumber(
      numerator
    );


  const b =
    finiteFinancialNumber(
      denominator
    );


  if (
    a === null ||
    b === null ||
    Math.abs(b) <
      0.0000001
  ) {

    return null;
  }


  return roundFinancial(
    (
      a /
      b
    ) *
    multiplier
  );
}


function safeDifference(
  first,
  second
) {

  const a =
    finiteFinancialNumber(
      first
    );


  const b =
    finiteFinancialNumber(
      second
    );


  if (
    a === null ||
    b === null
  ) {

    return null;
  }


  return roundFinancial(
    a -
    b
  );
}


/* ============================================================
   13W. EXTRACT SHARES OUTSTANDING
   ============================================================ */

/*
 * This is deliberately conservative.
 *
 * It does not use weighted-average EPS shares.
 */

function extractSharesOutstanding(
  text
) {

  const source =
    normalizeReportText(
      text
    );


  const searchTerms = [

    "issued, subscribed and paid-up",

    "issued subscribed and paid-up",

    "issued, subscribed and paid up",

    "issued subscribed and paid up",

    "issued and paid-up",

    "issued and paid up",

    "equity share capital"

  ];


  const lower =
    source.toLowerCase();


  const candidateWindows =
    [];


  for (
    const term
    of searchTerms
  ) {

    let position =
      0;


    while (
      position <
      lower.length
    ) {

      const index =
        lower.indexOf(
          term,
          position
        );


      if (
        index < 0
      ) {

        break;
      }


      candidateWindows.push(
        source.slice(
          Math.max(
            0,
            index -
            1500
          ),
          index +
          7000
        )
      );


      position =
        index +
        term.length;
    }

  }


  for (
    const window
    of candidateWindows
  ) {

    /*
     * Explicit crore shares.
     */

    const crore =
      window.match(
        /(\d[\d,]*(?:\.\d+)?)\s+crores?\s+(?:equity\s+)?shares?/i
      );


    if (
      crore?.[1]
    ) {

      const value =
        finiteFinancialNumber(
          crore[1]
        );


      if (
        value !== null &&
        value > 0
      ) {

        return {

          value:
            value,

          unit:
            "crore shares"

        };
      }

    }


    /*
     * Explicit lakh shares.
     */

    const lakh =
      window.match(
        /(\d[\d,]*(?:\.\d+)?)\s+lakhs?\s+(?:equity\s+)?shares?/i
      );


    if (
      lakh?.[1]
    ) {

      const value =
        finiteFinancialNumber(
          lakh[1]
        );


      if (
        value !== null &&
        value > 0
      ) {

        return {

          value:
            roundFinancial(
              value /
              100
            ),

          unit:
            "crore shares"

        };
      }

    }


    /*
     * Explicit million shares.
     */

    const million =
      window.match(
        /(\d[\d,]*(?:\.\d+)?)\s+millions?\s+(?:equity\s+)?shares?/i
      );


    if (
      million?.[1]
    ) {

      const value =
        finiteFinancialNumber(
          million[1]
        );


      if (
        value !== null &&
        value > 0
      ) {

        return {

          value:
            roundFinancial(
              value /
              10
            ),

          unit:
            "crore shares"

        };
      }

    }


    /*
     * Explicit billion shares.
     */

    const billion =
      window.match(
        /(\d[\d,]*(?:\.\d+)?)\s+billions?\s+(?:equity\s+)?shares?/i
      );


    if (
      billion?.[1]
    ) {

      const value =
        finiteFinancialNumber(
          billion[1]
        );


      if (
        value !== null &&
        value > 0
      ) {

        return {

          value:
            roundFinancial(
              value *
              100
            ),

          unit:
            "crore shares"

        };
      }

    }


    /*
     * Absolute number of shares.
     *
     * Require at least six digits to avoid accidentally
     * interpreting face value or note numbers as shares.
     */

    const absolute =
      window.match(
        /(\d[\d,]{5,})\s+(?:fully\s+paid[- ]?up\s+)?(?:equity\s+)?shares?\b/i
      );


    if (
      absolute?.[1]
    ) {

      const value =
        finiteFinancialNumber(
          absolute[1]
        );


      if (
        value !== null &&
        value > 0
      ) {

        return {

          value:
            roundFinancial(
              value /
              10000000
            ),

          unit:
            "crore shares"

        };
      }

    }

  }


  return {

    value:
      null,

    unit:
      null

  };
}


/* ============================================================
   13X. LOCAL FINANCIAL EXTRACTION ENGINE
   ============================================================ */

function extractFinancialsLocally(
  pdfData
) {

  const text =
    normalizeReportText(
      pdfData?.text
    );


  if (!text) {

    const error =
      new Error(
        "No locally extracted annual-report text is available."
      );


    error.status =
      422;


    throw error;
  }


  const companyName =
    detectCompanyName(
      text,
      pdfData?.info ||
      {}
    );


  console.log(
    "Local financial extraction company:",
    companyName
  );


  /* ----------------------------------------------------------
     FIND STATEMENTS
     ---------------------------------------------------------- */

  const profitStatement =
    findBestStatement(
      text,
      PROFIT_STATEMENT_HEADINGS,
      "profit"
    );


  const balanceStatement =
    findBestStatement(
      text,
      BALANCE_SHEET_HEADINGS,
      "balance"
    );


  const cashStatement =
    findBestStatement(
      text,
      CASH_FLOW_HEADINGS,
      "cash"
    );


  console.log(
    "Local statement detection:",
    {

      profitLoss:
        Boolean(
          profitStatement.text
        ),

      balanceSheet:
        Boolean(
          balanceStatement.text
        ),

      cashFlow:
        Boolean(
          cashStatement.text
        ),

      profitHeading:
        profitStatement.heading,

      balanceHeading:
        balanceStatement.heading,

      cashHeading:
        cashStatement.heading,

      profitScore:
        profitStatement.score,

      balanceScore:
        balanceStatement.score,

      cashScore:
        cashStatement.score

    }
  );


  if (
    !profitStatement.text &&
    !balanceStatement.text &&
    !cashStatement.text
  ) {

    const error =
      new Error(
        "FinSight could not locate audited financial statements in the locally extracted PDF text."
      );


    error.status =
      422;


    throw error;
  }


  const statementCombined =
    [
      profitStatement.text,
      balanceStatement.text,
      cashStatement.text
    ]
      .filter(
        Boolean
      )
      .join(
        "\n"
      );


  const consolidatedDetected =
    /\bconsolidated\b/i.test(
      [
        profitStatement.heading,
        balanceStatement.heading,
        cashStatement.heading
      ]
        .filter(
          Boolean
        )
        .join(
          " "
        )
    );


  console.log(
    "Consolidated financial statements detected:",
    consolidatedDetected
  );


  /* ----------------------------------------------------------
     DETECT YEARS
     ---------------------------------------------------------- */

  const profitYears =
    detectStatementYears(
      profitStatement.text
    );


  const balanceYears =
    detectStatementYears(
      balanceStatement.text
    );


  const cashYears =
    detectStatementYears(
      cashStatement.text
    );


  const allYears =
    [
      ...new Set(
        [
          ...profitYears,
          ...balanceYears,
          ...cashYears
        ]
      )
    ]
      .filter(
        year =>
          Number.isInteger(
            year
          )
      )
      .sort(
        (
          a,
          b
        ) =>
          b -
          a
      )
      .slice(
        0,
        3
      );


  if (
    !allYears.length
  ) {

    const error =
      new Error(
        "FinSight located financial statements but could not reliably identify their reporting years."
      );


    error.status =
      422;


    throw error;
  }


  console.log(
    "Local statement years:",
    {
      profitYears,
      balanceYears,
      cashYears,
      allYears
    }
  );


  /* ----------------------------------------------------------
     DETECT UNITS
     ---------------------------------------------------------- */

  const profitUnit =
    detectFinancialUnit(
      profitStatement.text,
      text
    );


  const balanceUnit =
    detectFinancialUnit(
      balanceStatement.text,
      text
    );


  const cashUnit =
    detectFinancialUnit(
      cashStatement.text,
      text
    );


  const profitFactor =
    monetaryCroreFactor(
      profitUnit
    );


  const balanceFactor =
    monetaryCroreFactor(
      balanceUnit
    );


  const cashFactor =
    monetaryCroreFactor(
      cashUnit
    );


  console.log(
    "Local financial units:",
    {
      profitUnit,
      balanceUnit,
      cashUnit,
      profitFactor,
      balanceFactor,
      cashFactor
    }
  );


  /*
   * If all statement units are unknown, monetary extraction
   * would be unsafe.
   */

  if (
    profitFactor === null &&
    balanceFactor === null &&
    cashFactor === null
  ) {

    const error =
      new Error(
        "FinSight found the financial statements but could not establish their monetary unit safely."
      );


    error.status =
      422;


    throw error;
  }


  /* ----------------------------------------------------------
     PROFIT & LOSS
     ---------------------------------------------------------- */

  const revenue =
    extractMoneyMetric(
      profitStatement.text,
      [
        "revenue from operations",
        "revenue from operation",
        "revenue"
      ],
      profitYears,
      profitFactor,
      {
        exclude: [
          "other revenue",
          "revenue growth",
          "segment revenue"
        ]
      }
    );


  const otherIncome =
    extractMoneyMetric(
      profitStatement.text,
      [
        "other income"
      ],
      profitYears,
      profitFactor
    );


  const totalIncome =
    extractMoneyMetric(
      profitStatement.text,
      [
        "total income"
      ],
      profitYears,
      profitFactor
    );


  const ebitda =
    extractMoneyMetric(
      profitStatement.text,
      [
        "ebitda",
        "earnings before interest tax depreciation and amortisation",
        "earnings before interest taxes depreciation and amortization"
      ],
      profitYears,
      profitFactor,
      {
        exclude: [
          "margin",
          "adjusted"
        ]
      }
    );


  const operatingIncome =
    extractMoneyMetric(
      profitStatement.text,
      [
        "operating profit",
        "profit from operations",
        "operating income",
        "ebit"
      ],
      profitYears,
      profitFactor,
      {
        exclude: [
          "margin",
          "segment"
        ]
      }
    );


  const profitBeforeTax =
    extractMoneyMetric(
      profitStatement.text,
      [
        "profit before tax",
        "profit before taxation"
      ],
      profitYears,
      profitFactor
    );


  const netIncome =
    extractMoneyMetric(
      profitStatement.text,
      [
        "profit for the year",
        "profit for the period",
        "profit after tax",
        "profit after taxation",
        "net profit"
      ],
      profitYears,
      profitFactor,
      {
        exclude: [
          "attributable",
          "margin"
        ]
      }
    );


  const financeCost =
    extractMoneyMetric(
      profitStatement.text,
      [
        "finance costs",
        "finance cost",
        "finance expenses",
        "interest expense"
      ],
      profitYears,
      profitFactor
    );


  const cogs =
    extractMoneyMetric(
      profitStatement.text,
      [
        "cost of goods sold",
        "cost of materials consumed",
        "cost of revenue"
      ],
      profitYears,
      profitFactor
    );


  /* ----------------------------------------------------------
     BALANCE SHEET
     ---------------------------------------------------------- */

  const totalAssets =
    extractMoneyMetric(
      balanceStatement.text,
      [
        "total assets"
      ],
      balanceYears,
      balanceFactor
    );


  const currentAssets =
    extractMoneyMetric(
      balanceStatement.text,
      [
        "total current assets",
        "current assets"
      ],
      balanceYears,
      balanceFactor,
      {
        exclude: [
          "non current assets"
        ]
      }
    );


  const currentLiabilities =
    extractMoneyMetric(
      balanceStatement.text,
      [
        "total current liabilities",
        "current liabilities"
      ],
      balanceYears,
      balanceFactor,
      {
        exclude: [
          "non current liabilities"
        ]
      }
    );


  const totalEquity =
    extractMoneyMetric(
      balanceStatement.text,
      [
        "total equity",
        "total shareholders equity",
        "equity attributable to owners",
        "equity attributable to shareholders"
      ],
      balanceYears,
      balanceFactor,
      {
        exclude: [
          "liabilities and equity",
          "total equity and liabilities"
        ]
      }
    );


  const cash =
    extractMoneyMetric(
      balanceStatement.text,
      [
        "cash and cash equivalents",
        "cash cash equivalents"
      ],
      balanceYears,
      balanceFactor
    );


  const inventory =
    extractMoneyMetric(
      balanceStatement.text,
      [
        "inventories",
        "inventory"
      ],
      balanceYears,
      balanceFactor
    );


  const accountsReceivable =
    extractMoneyMetric(
      balanceStatement.text,
      [
        "trade receivables",
        "accounts receivable",
        "trade and other receivables"
      ],
      balanceYears,
      balanceFactor
    );


  const accountsPayable =
    extractMoneyMetric(
      balanceStatement.text,
      [
        "trade payables",
        "accounts payable",
        "trade and other payables"
      ],
      balanceYears,
      balanceFactor
    );


  const totalDebt =
    extractMoneyMetric(
      balanceStatement.text,
      [
        "total borrowings",
        "total debt",
        "borrowings"
      ],
      balanceYears,
      balanceFactor
    );


  /* ----------------------------------------------------------
     CASH FLOW
     ---------------------------------------------------------- */

  const operatingCashFlow =
    extractMoneyMetric(
      cashStatement.text,
      [
        "net cash generated from operating activities",
        "net cash generated by operating activities",
        "net cash from operating activities",
        "net cash flows from operating activities",
        "cash generated from operating activities"
      ],
      cashYears,
      cashFactor
    );


  const capexRaw =
    extractMoneyMetric(
      cashStatement.text,
      [
        "purchase of property plant and equipment",
        "payments for property plant and equipment",
        "purchase of fixed assets",
        "capital expenditure"
      ],
      cashYears,
      cashFactor
    );


  /* ----------------------------------------------------------
     SHARES
     ---------------------------------------------------------- */

  const shares =
    extractSharesOutstanding(
      text
    );


  /* ----------------------------------------------------------
     BUILD ROWS
     ---------------------------------------------------------- */

  const rows =
    [];


  for (
    const year
    of allYears
  ) {

    const rowRevenue =
      valueForYear(
        revenue,
        year
      );


    const rowEbitda =
      valueForYear(
        ebitda,
        year
      );


    const rowOperatingIncome =
      valueForYear(
        operatingIncome,
        year
      );


    const rowNetIncome =
      valueForYear(
        netIncome,
        year
      );


    const rowTotalAssets =
      valueForYear(
        totalAssets,
        year
      );


    const rowCurrentAssets =
      valueForYear(
        currentAssets,
        year
      );


    const rowCurrentLiabilities =
      valueForYear(
        currentLiabilities,
        year
      );


    let rowTotalDebt =
      valueForYear(
        totalDebt,
        year
      );


    const rowCash =
      valueForYear(
        cash,
        year
      );


    const rowTotalEquity =
      valueForYear(
        totalEquity,
        year
      );


    const rowOperatingCashFlow =
      valueForYear(
        operatingCashFlow,
        year
      );


    let rowCapex =
      valueForYear(
        capexRaw,
        year
      );


    const rowInventory =
      valueForYear(
        inventory,
        year
      );


    const rowReceivable =
      valueForYear(
        accountsReceivable,
        year
      );


    const rowPayable =
      valueForYear(
        accountsPayable,
        year
      );


    let rowFinanceCost =
      valueForYear(
        financeCost,
        year
      );


    const rowCogs =
      valueForYear(
        cogs,
        year
      );


    /*
     * Capex is displayed as an investment amount.
     */

    if (
      rowCapex !== null
    ) {

      rowCapex =
        Math.abs(
          rowCapex
        );
    }


    /*
     * Borrowings should not be negative.
     */

    if (
      rowTotalDebt !== null &&
      rowTotalDebt < 0
    ) {

      rowTotalDebt =
        null;
    }


    /*
     * Finance cost may be represented as a cash/accounting
     * outflow with parentheses. Dashboard coverage ratios use
     * its magnitude.
     */

    if (
      rowFinanceCost !== null
    ) {

      rowFinanceCost =
        Math.abs(
          rowFinanceCost
        );
    }


    const row = {

      company:
        companyName,

      financial_year:
        financialYearLabel(
          year
        ),

      year,

      statement_basis:

        consolidatedDetected

          ? "Consolidated"

          : "Standalone/Unconfirmed",

      source_unit:
        "INR crore",

      original_source_unit: {

        profit:
          profitUnit,

        balance:
          balanceUnit,

        cash_flow:
          cashUnit

      },

      revenue:
        rowRevenue,

      other_income:
        valueForYear(
          otherIncome,
          year
        ),

      total_income:
        valueForYear(
          totalIncome,
          year
        ),

      ebitda:
        rowEbitda,

      cogs:
        rowCogs,

      operating_income:
        rowOperatingIncome,

      profit_before_tax:
        valueForYear(
          profitBeforeTax,
          year
        ),

      net_income:
        rowNetIncome,

      total_assets:
        rowTotalAssets,

      current_assets:
        rowCurrentAssets,

      current_liabilities:
        rowCurrentLiabilities,

      total_debt:
        rowTotalDebt,

      cash:
        rowCash,

      total_equity:
        rowTotalEquity,

      operating_cash_flow:
        rowOperatingCashFlow,

      capex:
        rowCapex,

      inventory:
        rowInventory,

      accounts_receivable:
        rowReceivable,

      accounts_payable:
        rowPayable,

      finance_cost:
        rowFinanceCost,

      shares_outstanding:
        shares.value,

      shares_outstanding_unit:
        shares.unit,

      source_pages:
        [],

      extraction_notes:
        ""

    };


    /* --------------------------------------------------------
       DERIVED DASHBOARD METRICS
       -------------------------------------------------------- */

    row.ebitda_margin =
      safeRatio(
        row.ebitda,
        row.revenue,
        100
      );


    row.operating_margin =
      safeRatio(
        row.operating_income,
        row.revenue,
        100
      );


    row.net_margin =
      safeRatio(
        row.net_income,
        row.revenue,
        100
      );


    row.current_ratio =
      safeRatio(
        row.current_assets,
        row.current_liabilities
      );


    row.debt_equity =
      safeRatio(
        row.total_debt,
        row.total_equity
      );


    row.net_debt =
      safeDifference(
        row.total_debt,
        row.cash
      );


    row.cash_conversion =
      safeRatio(
        row.operating_cash_flow,
        row.net_income
      );


    row.simplified_fcf =
      safeDifference(
        row.operating_cash_flow,
        row.capex
      );


    row.interest_coverage =
      safeRatio(
        row.operating_income,
        row.finance_cost
      );


    /*
     * Average-balance metrics are calculated later once
     * comparative rows exist.
     */

    row.roe =
      null;

    row.roa =
      null;

    row.roce =
      null;

    row.asset_turnover =
      null;

    row.receivable_days =
      null;

    row.inventory_days =
      null;

    row.payable_days =
      null;


    rows.push(
      row
    );

  }


  /* ----------------------------------------------------------
     REMOVE COMPLETELY EMPTY YEARS
     ---------------------------------------------------------- */

  const meaningfulFields = [

    "revenue",
    "ebitda",
    "operating_income",
    "net_income",
    "total_assets",
    "total_equity",
    "operating_cash_flow"

  ];


  const usableRows =
    rows.filter(
      row =>
        meaningfulFields.some(
          field =>
            finiteFinancialNumber(
              row[field]
            ) !==
            null
        )
    );


  if (
    !usableRows.length
  ) {

    const error =
      new Error(
        "The PDF text was extracted successfully, but FinSight could not reliably locate audited financial-statement values."
      );


    error.status =
      422;


    throw error;
  }


  usableRows.sort(
    (
      a,
      b
    ) =>
      b.year -
      a.year
  );


  /* ----------------------------------------------------------
     AVERAGE-BALANCE METRICS
     ---------------------------------------------------------- */

  for (
    let index = 0;
    index < usableRows.length;
    index++
  ) {

    const current =
      usableRows[index];


    const previous =
      usableRows[
        index +
        1
      ] ||
      null;


    /*
     * Receivable days can be calculated without a prior year.
     */

    if (
      current.accounts_receivable !== null &&
      current.revenue !== null &&
      current.revenue > 0
    ) {

      current.receivable_days =
        safeRatio(
          current.accounts_receivable,
          current.revenue,
          365
        );
    }


    if (
      current.inventory !== null &&
      current.cogs !== null &&
      Math.abs(
        current.cogs
      ) > 0.01
    ) {

      current.inventory_days =
        safeRatio(
          current.inventory,
          Math.abs(
            current.cogs
          ),
          365
        );
    }


    if (
      current.accounts_payable !== null &&
      current.cogs !== null &&
      Math.abs(
        current.cogs
      ) > 0.01
    ) {

      current.payable_days =
        safeRatio(
          current.accounts_payable,
          Math.abs(
            current.cogs
          ),
          365
        );
    }


    if (!previous) {

      continue;
    }


    if (
      current.total_equity !== null &&
      previous.total_equity !== null
    ) {

      const averageEquity =
        (
          current.total_equity +
          previous.total_equity
        ) /
        2;


      if (
        Math.abs(
          averageEquity
        ) > 0.01
      ) {

        current.roe =
          safeRatio(
            current.net_income,
            averageEquity,
            100
          );
      }

    }


    if (
      current.total_assets !== null &&
      previous.total_assets !== null
    ) {

      const averageAssets =
        (
          current.total_assets +
          previous.total_assets
        ) /
        2;


      if (
        averageAssets > 0
      ) {

        current.roa =
          safeRatio(
            current.net_income,
            averageAssets,
            100
          );


        current.asset_turnover =
          safeRatio(
            current.revenue,
            averageAssets
          );
      }

    }


    if (
      current.total_assets !== null &&
      current.current_liabilities !== null &&
      previous.total_assets !== null &&
      previous.current_liabilities !== null
    ) {

      const currentCapital =
        current.total_assets -
        current.current_liabilities;


      const previousCapital =
        previous.total_assets -
        previous.current_liabilities;


      const averageCapital =
        (
          currentCapital +
          previousCapital
        ) /
        2;


      if (
        Math.abs(
          averageCapital
        ) > 0.01
      ) {

        current.roce =
          safeRatio(
            current.operating_income,
            averageCapital,
            100
          );
      }

    }

  }


  /* ----------------------------------------------------------
     VALIDATION NOTES
     ---------------------------------------------------------- */

  const warnings =
    [];


  if (!profitStatement.text) {

    warnings.push(
      "Profit-and-loss statement could not be located reliably."
    );
  }


  if (!balanceStatement.text) {

    warnings.push(
      "Balance sheet could not be located reliably."
    );
  }


  if (!cashStatement.text) {

    warnings.push(
      "Cash-flow statement could not be located reliably."
    );
  }


  if (
    profitFactor === null
  ) {

    warnings.push(
      "Profit-and-loss monetary unit could not be established reliably."
    );
  }


  if (
    balanceFactor === null
  ) {

    warnings.push(
      "Balance-sheet monetary unit could not be established reliably."
    );
  }


  if (
    cashFactor === null
  ) {

    warnings.push(
      "Cash-flow monetary unit could not be established reliably."
    );
  }


  if (
    shares.value === null
  ) {

    warnings.push(
      "Period-end shares outstanding could not be established reliably."
    );
  }


  const latestRow =
    usableRows[0];


  const criticalNames = [

    "revenue",
    "net_income",
    "total_assets",
    "total_equity",
    "operating_cash_flow"

  ];


  const missingCriticalFields =
    criticalNames.filter(
      field =>
        finiteFinancialNumber(
          latestRow?.[field]
        ) ===
        null
    );


  let confidence =
    "Low";


  const statementCount =
    [
      profitStatement.text,
      balanceStatement.text,
      cashStatement.text
    ]
      .filter(
        Boolean
      )
      .length;


  const unitCount =
    [
      profitFactor,
      balanceFactor,
      cashFactor
    ]
      .filter(
        value =>
          value !==
          null
      )
      .length;


  if (
    statementCount === 3 &&
    unitCount === 3 &&
    missingCriticalFields.length <= 1
  ) {

    confidence =
      "High";
  }

  else if (
    statementCount >= 2 &&
    unitCount >= 2
  ) {

    confidence =
      "Medium";
  }


  console.log(
    "Local financial extraction result:",
    usableRows.map(
      row => ({

        financial_year:
          row.financial_year,

        revenue:
          row.revenue,

        ebitda:
          row.ebitda,

        operating_income:
          row.operating_income,

        net_income:
          row.net_income,

        total_assets:
          row.total_assets,

        current_assets:
          row.current_assets,

        current_liabilities:
          row.current_liabilities,

        total_equity:
          row.total_equity,

        total_debt:
          row.total_debt,

        cash:
          row.cash,

        operating_cash_flow:
          row.operating_cash_flow,

        capex:
          row.capex,

        inventory:
          row.inventory,

        accounts_receivable:
          row.accounts_receivable,

        accounts_payable:
          row.accounts_payable,

        finance_cost:
          row.finance_cost,

        shares_outstanding:
          row.shares_outstanding,

        roe:
          row.roe,

        roce:
          row.roce

      })
    )
  );


  console.log(
    "Local financial extraction successful:",
    {

      company:
        companyName,

      rows:
        usableRows.length,

      years:
        usableRows.map(
          row =>
            row.financial_year
        ),

      confidence,

      pages:
        pdfData?.pages ||
        null

    }
  );


  return {

    company: {

      name:
        companyName,

      legal_name:
        companyName,

      listing_status:
        "unknown",

      ticker:
        null,

      exchange:
        null,

      isin:
        null,

      currency:
        "₹",

      nse_code:
        null,

      bse_code:
        null,

      extraction_confidence:
        confidence

    },


    financials:
      usableRows,


    validation: {

      consolidated_preferred:
        true,

      years_found:
        usableRows.map(
          row =>
            row.financial_year
        ),

      missing_critical_fields:
        missingCriticalFields,

      warnings

    }

  };
}


/* ============================================================
   13Y. GEMINI FINANCIAL UNIT NORMALIZATION
   ============================================================ */

function financialUnitFactor(
  sourceUnit
) {

  const unit =
    String(
      sourceUnit ||
      ""
    )
      .toLowerCase()
      .replace(
        /\s+/g,
        " "
      )
      .trim();


  if (!unit) {

    return null;
  }


  if (
    /\bcrores?\b/.test(
      unit
    )
  ) {

    return 1;
  }


  if (
    /\bmillions?\b/.test(
      unit
    )
  ) {

    return 0.1;
  }


  if (
    /\blakhs?\b/.test(
      unit
    )
  ) {

    return 0.01;
  }


  if (
    /\bbillions?\b/.test(
      unit
    )
  ) {

    return 100;
  }


  return null;
}


/* ============================================================
   13Z. GEMINI SHARE NORMALIZATION
   ============================================================ */

function normalizeSharesToCrore(
  value,
  unit
) {

  const number =
    finiteFinancialNumber(
      value
    );


  if (
    number === null ||
    number < 0
  ) {

    return null;
  }


  const normalizedUnit =
    String(
      unit ||
      ""
    )
      .toLowerCase()
      .replace(
        /\s+/g,
        " "
      )
      .trim();


  if (
    /\bcrores?\b/.test(
      normalizedUnit
    )
  ) {

    return roundFinancial(
      number
    );
  }


  if (
    /\blakhs?\b/.test(
      normalizedUnit
    )
  ) {

    return roundFinancial(
      number /
      100
    );
  }


  if (
    /\bmillions?\b/.test(
      normalizedUnit
    )
  ) {

    return roundFinancial(
      number /
      10
    );
  }


  if (
    /\bbillions?\b/.test(
      normalizedUnit
    )
  ) {

    return roundFinancial(
      number *
      100
    );
  }


  if (
    normalizedUnit === "shares" ||
    normalizedUnit === "share" ||
    normalizedUnit === "absolute shares" ||
    normalizedUnit === "number" ||
    normalizedUnit.includes(
      "number of shares"
    )
  ) {

    return roundFinancial(
      number /
      10000000
    );
  }


  return null;
}


/* ============================================================
   13AA. NORMALIZE GEMINI FINANCIAL EXTRACTION
   ============================================================ */

function normalizeGeminiFinancialExtraction(
  raw
) {

  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    !Array.isArray(
      raw.financials
    )
  ) {

    throw new Error(
      "Gemini financial extraction has no financial rows."
    );
  }


  const monetaryFields = [

    "revenue",
    "ebitda",
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


  const rows =
    [];


  for (
    const rawRow
    of raw.financials
  ) {

    if (
      !rawRow ||
      typeof rawRow !== "object" ||
      Array.isArray(
        rawRow
      )
    ) {

      continue;
    }


    const year =
      normalizeYear(
        rawRow.year
      );


    if (!year) {

      continue;
    }


    const factor =
      financialUnitFactor(
        rawRow.source_unit
      );


    /*
     * If the unit cannot be established, the row cannot safely
     * be displayed as INR crore.
     *
     * Reject the row instead of silently guessing its scale.
     */

    if (
      factor === null
    ) {

      continue;
    }


    const row = {

      company:
        rawRow.company ||
        raw?.company?.name ||
        raw?.company?.legal_name ||
        null,

      financial_year:
        rawRow.financial_year ||
        financialYearLabel(
          year
        ),

      year,

      statement_basis:
        rawRow.statement_basis ||
        "Unknown",

      /*
       * Dashboard values below are normalized to crore.
       */

      source_unit:
        "INR crore",

      original_source_unit:
        rawRow.source_unit ||
        null,

      source_pages:
        [],

      extraction_notes:
        ""

    };


    for (
      const field
      of monetaryFields
    ) {

      const value =
        finiteFinancialNumber(
          rawRow[field]
        );


      row[field] =

        value === null

          ? null

          : roundFinancial(
              value *
              factor
            );
    }


    /*
     * Capex is presented as a positive investment amount.
     */

    if (
      row.capex !== null
    ) {

      row.capex =
        Math.abs(
          row.capex
        );
    }


    /*
     * Debt cannot be negative.
     */

    if (
      row.total_debt !== null &&
      row.total_debt < 0
    ) {

      row.total_debt =
        null;
    }


    /*
     * Balance-sheet asset values cannot normally be negative.
     * Null is safer than propagating a malformed extraction.
     */

    for (
      const field
      of [
        "total_assets",
        "current_assets",
        "current_liabilities",
        "cash",
        "inventory",
        "accounts_receivable",
        "accounts_payable"
      ]
    ) {

      if (
        row[field] !== null &&
        row[field] < 0
      ) {

        row[field] =
          null;
      }

    }


    /*
     * Finance cost can appear in parentheses.
     * Dashboard coverage calculations use magnitude.
     */

    if (
      row.finance_cost !== null
    ) {

      row.finance_cost =
        Math.abs(
          row.finance_cost
        );
    }


    const shares =
      normalizeSharesToCrore(
        rawRow.shares_outstanding,
        rawRow.shares_outstanding_unit
      );


    row.shares_outstanding =
      shares;


    row.shares_outstanding_unit =

      shares === null

        ? null

        : "crore shares";


    /* --------------------------------------------------------
       DERIVED DASHBOARD METRICS
       -------------------------------------------------------- */

    row.ebitda_margin =
      safeRatio(
        row.ebitda,
        row.revenue,
        100
      );


    row.operating_margin =
      safeRatio(
        row.operating_income,
        row.revenue,
        100
      );


    row.net_margin =
      safeRatio(
        row.net_income,
        row.revenue,
        100
      );


    row.current_ratio =
      safeRatio(
        row.current_assets,
        row.current_liabilities
      );


    row.debt_equity =
      safeRatio(
        row.total_debt,
        row.total_equity
      );


    row.net_debt =
      safeDifference(
        row.total_debt,
        row.cash
      );


    row.cash_conversion =
      safeRatio(
        row.operating_cash_flow,
        row.net_income
      );


    row.simplified_fcf =
      safeDifference(
        row.operating_cash_flow,
        row.capex
      );


    row.interest_coverage =
      safeRatio(
        row.operating_income,
        row.finance_cost
      );


    row.roe =
      null;

    row.roa =
      null;

    row.roce =
      null;

    row.asset_turnover =
      null;

    row.receivable_days =
      null;

    row.inventory_days =
      null;

    row.payable_days =
      null;


    rows.push(
      row
    );

  }


  rows.sort(
    (
      a,
      b
    ) =>
      b.year -
      a.year
  );


  if (
    !rows.length
  ) {

    throw new Error(
      "Gemini did not return any safely usable financial rows."
    );
  }


  /* ----------------------------------------------------------
     DERIVED MULTI-YEAR RATIOS
     ---------------------------------------------------------- */

  for (
    let index = 0;
    index < rows.length;
    index++
  ) {

    const current =
      rows[index];


    const previous =
      rows[
        index +
        1
      ] ||
      null;


    if (
      current.accounts_receivable !== null &&
      current.revenue !== null &&
      current.revenue > 0
    ) {

      current.receivable_days =
        safeRatio(
          current.accounts_receivable,
          current.revenue,
          365
        );
    }


    if (!previous) {

      continue;
    }


    if (
      current.total_equity !== null &&
      previous.total_equity !== null
    ) {

      const averageEquity =
        (
          current.total_equity +
          previous.total_equity
        ) /
        2;


      if (
        Math.abs(
          averageEquity
        ) >
        0.01
      ) {

        current.roe =
          safeRatio(
            current.net_income,
            averageEquity,
            100
          );
      }

    }


    if (
      current.total_assets !== null &&
      previous.total_assets !== null
    ) {

      const averageAssets =
        (
          current.total_assets +
          previous.total_assets
        ) /
        2;


      if (
        averageAssets >
        0
      ) {

        current.roa =
          safeRatio(
            current.net_income,
            averageAssets,
            100
          );


        current.asset_turnover =
          safeRatio(
            current.revenue,
            averageAssets
          );
      }

    }


    if (
      current.total_assets !== null &&
      current.current_liabilities !== null &&
      previous.total_assets !== null &&
      previous.current_liabilities !== null
    ) {

      const currentCapital =
        current.total_assets -
        current.current_liabilities;


      const previousCapital =
        previous.total_assets -
        previous.current_liabilities;


      const averageCapital =
        (
          currentCapital +
          previousCapital
        ) /
        2;


      if (
        Math.abs(
          averageCapital
        ) >
        0.01
      ) {

        current.roce =
          safeRatio(
            current.operating_income,
            averageCapital,
            100
          );
      }

    }

  }


  /* ----------------------------------------------------------
     COMPANY
     ---------------------------------------------------------- */

  const company =

    raw.company &&
    typeof raw.company === "object" &&
    !Array.isArray(
      raw.company
    )

      ? {
          ...raw.company
        }

      : {};


  company.name =
    company.name ||
    company.legal_name ||
    rows[0]?.company ||
    "Unknown company";


  company.legal_name =
    company.legal_name ||
    company.name;


  const allowedListingStatuses =
    new Set(
      [
        "listed",
        "unlisted",
        "pre-IPO",
        "proposed listing",
        "unknown"
      ]
    );


  if (
    !allowedListingStatuses.has(
      company.listing_status
    )
  ) {

    company.listing_status =
      "unknown";
  }


  /*
   * Do not retain market identifiers unless the report
   * explicitly established current listed status.
   */

  if (
    company.listing_status !==
    "listed"
  ) {

    company.ticker =
      null;

    company.exchange =
      null;
  }


  company.isin =
    company.isin ||
    null;


  company.currency =
    company.currency ||
    "₹";


  company.extraction_confidence =
    "High";


  return {

    company,

    financials:
      rows,

    validation: {

      consolidated_preferred:
        true,

      years_found:
        rows.map(
          row =>
            row.financial_year
        ),

      missing_critical_fields:
        [],

      warnings:
        Array.isArray(
          raw.warnings
        )
          ? raw.warnings
          : []

    }

  };
}


/* ============================================================
   13AB. FINANCIAL EXTRACTION VALIDATOR
   ============================================================ */

/*
 * AI output is NOT trusted merely because it is valid JSON.
 *
 * The server validates the result before allowing it onto
 * the dashboard.
 *
 * Failed validation activates the local fallback.
 */

function validateFinancialExtractionResult(
  result
) {

  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !Array.isArray(
      result.financials
    ) ||
    !result.financials.length
  ) {

    throw new Error(
      "Financial extraction returned no usable financial rows."
    );
  }


  const criticalFields = [

    "revenue",
    "net_income",
    "total_assets",
    "total_equity",
    "operating_cash_flow"

  ];


  let reliableRows =
    0;


  for (
    const row
    of result.financials
  ) {

    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row)
    ) {

      continue;
    }


    const year =
      normalizeYear(
        row.year
      );


    if (!year) {

      continue;
    }


    /*
     * Count supported core fields.
     */

    const supported =
      criticalFields.filter(
        field =>
          finiteFinancialNumber(
            row[field]
          ) !==
          null
      ).length;


    if (
      supported >= 2
    ) {

      reliableRows++;
    }


    /* --------------------------------------------------------
       SANITY CHECKS
       -------------------------------------------------------- */

    const revenue =
      finiteFinancialNumber(
        row.revenue
      );


    const assets =
      finiteFinancialNumber(
        row.total_assets
      );


    const equity =
      finiteFinancialNumber(
        row.total_equity
      );


    const debt =
      finiteFinancialNumber(
        row.total_debt
      );


    const currentAssets =
      finiteFinancialNumber(
        row.current_assets
      );


    const currentLiabilities =
      finiteFinancialNumber(
        row.current_liabilities
      );


    const cash =
      finiteFinancialNumber(
        row.cash
      );


    /*
     * Revenue cannot normally be negative.
     */

    if (
      revenue !== null &&
      revenue < 0
    ) {

      row.revenue =
        null;
    }


    /*
     * Total assets must be positive.
     */

    if (
      assets !== null &&
      assets <= 0
    ) {

      row.total_assets =
        null;

      row.roa =
        null;

      row.roce =
        null;

      row.asset_turnover =
        null;
    }


    /*
     * Current assets/liabilities cannot be negative.
     */

    if (
      currentAssets !== null &&
      currentAssets < 0
    ) {

      row.current_assets =
        null;

      row.current_ratio =
        null;
    }


    if (
      currentLiabilities !== null &&
      currentLiabilities < 0
    ) {

      row.current_liabilities =
        null;

      row.current_ratio =
        null;

      row.roce =
        null;
    }


    if (
      cash !== null &&
      cash < 0
    ) {

      row.cash =
        null;

      row.net_debt =
        null;
    }


    if (
      debt !== null &&
      debt < 0
    ) {

      row.total_debt =
        null;

      row.debt_equity =
        null;

      row.net_debt =
        null;
    }


    /*
     * Catch extreme scale corruption.
     *
     * Example:
     *
     * assets = 600000
     * equity = 0.15
     *
     * This is much more likely to be a bad table-column
     * extraction than a real consolidated balance sheet.
     */

    if (
      assets !== null &&
      assets > 0 &&
      equity !== null &&
      Math.abs(
        equity
      ) <
        Math.abs(
          assets
        ) *
        0.00001
    ) {

      row.total_equity =
        null;

      row.debt_equity =
        null;

      row.roe =
        null;
    }


    /*
     * Current assets should not exceed total assets by a
     * massive amount. Allow a small tolerance for extraction
     * rounding but reject obviously incompatible values.
     */

    if (
      finiteFinancialNumber(
        row.total_assets
      ) !== null &&
      finiteFinancialNumber(
        row.current_assets
      ) !== null &&
      row.current_assets >
        row.total_assets *
        1.05
    ) {

      row.current_assets =
        null;

      row.current_ratio =
        null;
    }


    /*
     * Cash cannot reasonably exceed total assets.
     */

    if (
      finiteFinancialNumber(
        row.total_assets
      ) !== null &&
      finiteFinancialNumber(
        row.cash
      ) !== null &&
      row.cash >
        row.total_assets *
        1.05
    ) {

      row.cash =
        null;

      row.net_debt =
        null;
    }

  }


  if (
    reliableRows === 0
  ) {

    throw new Error(
      "Financial extraction failed reliability validation."
    );
  }


  return result;
}


/* ============================================================
   13AC. CACHE LOOKUP
   ============================================================ */

/*
 * Same PDF uploaded again:
 *
 * valid hybrid cache
 *       ↓
 * zero Gemini calls
 * zero pdf-parse calls
 */

async function findCachedFinancialExtraction(
  sourceHash
) {

  if (
    !pool ||
    !sourceHash
  ) {

    return null;
  }


  try {

    const cached =
      await dbQuery(
        `
        SELECT
          id,
          company_id,
          filename,
          report_year,
          metrics,
          created_at

        FROM reports

        WHERE source_hash = $1

        ORDER BY created_at DESC

        LIMIT 10
        `,
        [
          sourceHash
        ]
      );


    for (
      const row
      of cached.rows
    ) {

      const metrics =
        row.metrics;


      /*
       * Critical:
       *
       * Ignore old extraction rows created before this
       * architecture.
       */

      if (
        metrics?.cacheVersion !==
        FINANCIAL_EXTRACTION_CACHE_VERSION
      ) {

        continue;
      }


      const result = {

        company:
          metrics.company ||
          {},

        financials:
          metrics.financials ||
          [],

        validation:
          metrics.validation ||
          {}

      };


      try {

        validateFinancialExtractionResult(
          result
        );


        return {

          result,

          reportId:
            row.id,

          companyId:
            row.company_id,

          createdAt:
            row.created_at,

          originalProvider:
            metrics.extractionProvider ||
            null

        };

      }

      catch {

        /*
         * Bad cache entry.
         *
         * Ignore it and continue searching.
         */

      }

    }

  }

  catch (error) {

    /*
     * Cache failure must not stop extraction.
     */

    console.warn(
      "Financial extraction cache lookup failed:",
      error?.message
    );

  }


  return null;
}


/* ============================================================
   14. FINANCIAL EXTRACTION ROUTE
   CACHE -> GEMINI ONCE -> LOCAL FALLBACK
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

      /* ------------------------------------------------------
         REQUIRE PDF
         ------------------------------------------------------ */

      if (!req.file) {

        return res
          .status(400)
          .json({

            ok:
              false,

            error:
              "Upload an annual-report PDF.",

            code:
              "REPORT_REQUIRED"

          });
      }


      validatePdfFile(
        req.file
      );


      /* ------------------------------------------------------
         HASH PDF
         ------------------------------------------------------ */

      const sourceHash =
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


      /* ======================================================
         STEP 1
         DATABASE CACHE
         ====================================================== */

      const cached =
        await findCachedFinancialExtraction(
          sourceHash
        );


      if (cached) {

        console.log(
          "Financial extraction cache hit:",
          {
            file:
              req.file.originalname,

            originalProvider:
              cached.originalProvider
          }
        );


        return res.json({

          ok:
            true,

          ...cached.result,

          persisted: {

            companyId:
              cached.companyId,

            reportId:
              cached.reportId,

            createdAt:
              cached.createdAt

          },

          provider:
            "cache",

          originalProvider:
            cached.originalProvider,

          model:
            null,

          cached:
            true,

          cacheVersion:
            FINANCIAL_EXTRACTION_CACHE_VERSION,

          geminiFallbackUsed:
            false

        });
      }


      /* ======================================================
         STEP 2
         GEMINI ONE-SHOT EXTRACTION
         ====================================================== */

      let result =
        null;


      let extractionProvider =
        null;


      let geminiFailure =
        null;


      const useGemini =

        Boolean(
          GEMINI_API_KEY
        )

        &&

        req.file.buffer.length <=
          GEMINI_EXTRACTION_MAX_PDF_SIZE;


      if (
        useGemini
      ) {

        try {

          console.log(
            "Trying Gemini financial extraction:",
            {
              file:
                req.file.originalname,

              sizeMB:
                roundFinancial(
                  req.file.buffer.length /
                  1024 /
                  1024
                ),

              model:
                GEMINI_MODEL,

              attempts:
                1
            }
          );


          const rawGemini =
            await extractFinancialsWithGemini(
              req.file
            );


          result =
            normalizeGeminiFinancialExtraction(
              rawGemini
            );


          result =
            validateFinancialExtractionResult(
              result
            );


          extractionProvider =
            "gemini";


          console.log(
            "Gemini financial extraction passed validation:",
            {
              company:
                result.company?.name,

              years:
                result.financials.map(
                  row =>
                    row.financial_year
                )
            }
          );

        }

        catch (error) {

          geminiFailure =
            error;


          /*
           * IMPORTANT:
           *
           * ANY Gemini extraction failure switches directly
           * to local parsing.
           *
           * No second Gemini extraction attempt.
           */

          console.warn(
            "Gemini financial extraction failed. Switching to local parser:",
            {
              status:
                error?.status ||
                null,

              providerStatus:
                error?.providerStatus ||
                null,

              message:
                error?.message ||
                "Unknown Gemini extraction error"
            }
          );


          result =
            null;

        }

      }

      else {

        if (
          !GEMINI_API_KEY
        ) {

          console.log(
            "Gemini financial extraction skipped: Gemini API key is not configured."
          );

        }

        else {

          console.log(
            "Gemini financial extraction skipped to conserve quota:",
            {
              pdfSizeMB:
                roundFinancial(
                  req.file.buffer.length /
                  1024 /
                  1024
                ),

              thresholdMB:
                GEMINI_EXTRACTION_MAX_PDF_MB
            }
          );

        }

      }


      /* ======================================================
         STEP 3
         LOCAL FALLBACK
         ====================================================== */

      let pdfData =
        null;


      if (!result) {

        console.log(
          "Running deterministic local financial fallback."
        );


        pdfData =
          await extractPdfTextLocally(
            req.file
          );


        result =
          extractFinancialsLocally(
            pdfData
          );


        result =
          validateFinancialExtractionResult(
            result
          );


        extractionProvider =
          "local-fallback";


        result.validation =
          result.validation &&
          typeof result.validation ===
            "object"

            ? result.validation

            : {};


        result.validation.warnings =
          Array.isArray(
            result.validation.warnings
          )

            ? result.validation.warnings

            : [];


        if (
          geminiFailure
        ) {

          result.validation.warnings.push(
            "Gemini extraction was unavailable or failed reliability validation. FinSight automatically used its local deterministic parser."
          );
        }


        console.log(
          "Local financial fallback passed validation:",
          {
            company:
              result.company?.name,

            years:
              result.financials.map(
                row =>
                  row.financial_year
              )
          }
        );

      }


      /* ======================================================
         STEP 4
         FINAL RESULT VALIDATION
         ====================================================== */

      result =
        validateFinancialExtractionResult(
          result
        );


      result.company =
        result.company &&
        typeof result.company === "object"

          ? result.company

          : {};


      result.validation =
        result.validation &&
        typeof result.validation === "object"

          ? result.validation

          : {};


      result.validation.years_found =
        result.financials
          .map(
            row =>
              row.financial_year ||
              row.year
          )
          .filter(
            Boolean
          );


      result.validation.warnings =
        Array.isArray(
          result.validation.warnings
        )

          ? result.validation.warnings

          : [];


      result.validation.missing_critical_fields =
        Array.isArray(
          result.validation.missing_critical_fields
        )

          ? result.validation.missing_critical_fields

          : [];


      /* ======================================================
         STEP 5
         SAVE SUCCESSFUL EXTRACTION
         ====================================================== */

      let persisted =
        null;


      if (pool) {

        try {

          const companyRow =
            await upsertCompany({

              name:
                result.company?.legal_name ||
                result.company?.name ||
                "Unknown company",

              ticker:
                result.company?.ticker ||
                null,

              exchange:
                result.company?.exchange ||
                null,

              listingStatus:
                result.company?.listing_status ||
                "unknown",

              isin:
                result.company?.isin ||
                null

            });


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

                req.file.originalname,

                latestYear,

                {

                  cacheVersion:
                    FINANCIAL_EXTRACTION_CACHE_VERSION,

                  extractionProvider,

                  company:
                    result.company,

                  financials:
                    result.financials,

                  validation:
                    result.validation,

                  pdf:

                    pdfData

                      ? {

                          pages:
                            pdfData.pages,

                          extractedCharacters:
                            pdfData.text.length

                        }

                      : {

                          /*
                           * Gemini path intentionally avoids a
                           * second local PDF parse just to obtain
                           * page count.
                           *
                           * That saves CPU and memory.
                           */

                          pages:
                            null,

                          extractedCharacters:
                            null

                        }

                },

                {},

                sourceHash

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


          console.log(
            "Financial extraction cached:",
            {
              reportId:
                persisted.reportId,

              provider:
                extractionProvider,

              cacheVersion:
                FINANCIAL_EXTRACTION_CACHE_VERSION
            }
          );

        }

        catch (
          databaseError
        ) {

          /*
           * Database failure must NEVER destroy a successful
           * extraction.
           */

          console.error(
            "Could not save financial extraction:",
            databaseError
          );


          result.validation.warnings.push(
            "Financial extraction succeeded, but the result could not be cached in FinSight research memory."
          );

        }

      }


      /* ======================================================
         SUCCESS
         ====================================================== */

      console.log(
        "Financial extraction successful:",
        {
          company:
            result.company?.name ||
            result.company?.legal_name ||
            "Unknown company",

          provider:
            extractionProvider,

          years:
            result.financials.map(
              row =>
                row.financial_year
            ),

          cached:
            false
        }
      );


      return res.json({

        ok:
          true,

        ...result,

        persisted,

        provider:
          extractionProvider,

        model:

          extractionProvider ===
          "gemini"

            ? GEMINI_MODEL

            : "pdf-parse + deterministic FinSight extractor",

        cached:
          false,

        cacheVersion:
          FINANCIAL_EXTRACTION_CACHE_VERSION,

        geminiFallbackUsed:
          extractionProvider ===
          "local-fallback"

      });

    }

    catch (error) {

      console.error(
        "Financial extraction failed:",
        error
      );


      let status =
        Number(
          error?.status
        );


      if (
        !Number.isInteger(
          status
        ) ||
        status < 400 ||
        status > 599
      ) {

        status =
          500;
      }


      let code =
        "FINANCIAL_EXTRACTION_FAILED";


      if (
        status ===
        413
      ) {

        code =
          "REPORT_TOO_LARGE";
      }

      else if (
        status ===
        400
      ) {

        code =
          "INVALID_REPORT";
      }

      else if (
        status ===
        422
      ) {

        code =
          "FINANCIAL_STATEMENTS_NOT_LOCATED";
      }


      return res
        .status(
          status
        )
        .json({

          ok:
            false,

          error:
            error?.message ||
            "FinSight could not extract reliable financial statements from this annual report.",

          code,

          provider:
            "hybrid"

     
      });

    }

  }
);


/* ============================================================
   END BLOCK 1
   SECTIONS 1–14 COMPLETE

   NEXT:
   SECTION 15 — ANNUAL REPORT AI
   ============================================================ */
/* ============================================================
   15. ANNUAL REPORT AI
   ============================================================ */

/*
 * Architecture:
 *
 * PDF
 *  ↓
 * local pdf-parse
 *  ↓
 * selected annual-report text
 *  ↓
 * Gemini text analysis
 *
 * IMPORTANT
 *
 * The PDF itself is NOT sent to Gemini here.
 *
 * Financial extraction was already handled by Section 14:
 *
 * cache -> Gemini once -> local fallback
 *
 * This endpoint is for qualitative investor analysis only.
 */


/* ============================================================
   15A. BUILD COMPACT REPORT CONTEXT
   ============================================================ */

/*
 * Sending an entire 400+ page report to Gemini again wastes
 * tokens.
 *
 * This helper selects useful text windows locally.
 *
 * It tries to preserve:
 *
 * - business / management discussion
 * - risk disclosures
 * - auditor material
 * - governance
 * - financial statement context
 *
 * The output is deliberately bounded.
 */

function findTextWindow(
  text,
  terms,
  {
    before = 4000,
    after = 18000
  } = {}
) {

  const source =
    String(
      text ||
      ""
    );


  const lower =
    source.toLowerCase();


  let bestIndex =
    -1;


  for (
    const term
    of terms
  ) {

    const index =
      lower.indexOf(
        String(
          term
        ).toLowerCase()
      );


    if (
      index >= 0 &&
      (
        bestIndex < 0 ||
        index < bestIndex
      )
    ) {

      bestIndex =
        index;
    }

  }


  if (
    bestIndex < 0
  ) {

    return "";
  }


  return source.slice(

    Math.max(
      0,
      bestIndex -
      before
    ),

    Math.min(
      source.length,
      bestIndex +
      after
    )

  );
}


/* ============================================================
   DEDUPLICATE REPORT CONTEXT
   ============================================================ */

function deduplicateTextBlocks(
  blocks
) {

  const seen =
    new Set();


  const output =
    [];


  for (
    const block
    of blocks
  ) {

    const text =
      String(
        block ||
        ""
      ).trim();


    if (
      text.length <
      100
    ) {

      continue;
    }


    /*
     * Lightweight fingerprint.
     */

    const key =
      text
        .slice(
          0,
          500
        )
        .replace(
          /\s+/g,
          " "
        )
        .toLowerCase();


    if (
      seen.has(
        key
      )
    ) {

      continue;
    }


    seen.add(
      key
    );


    output.push(
      text
    );

  }


  return output;
}


/* ============================================================
   SELECT QUALITATIVE REPORT TEXT
   ============================================================ */

function buildQualitativeReportContext(
  fullText
) {

  const text =
    normalizeReportText(
      fullText
    );


  if (!text) {

    return "";
  }


  const blocks =
    [];


  /*
   * Beginning of report.
   *
   * Usually contains company overview, management commentary,
   * strategy and operating information.
   */

  blocks.push(
    text.slice(
      0,
      70000
    )
  );


  /*
   * Business / management.
   */

  blocks.push(
    findTextWindow(
      text,
      [
        "management discussion and analysis",
        "management discussion",
        "business overview",
        "our business",
        "company overview",
        "strategic priorities"
      ],
      {
        before:
          5000,

        after:
          40000
      }
    )
  );


  /*
   * Risks.
   */

  blocks.push(
    findTextWindow(
      text,
      [
        "risk management",
        "risk factors",
        "principal risks",
        "enterprise risk management",
        "material risks"
      ],
      {
        before:
          4000,

        after:
          35000
      }
    )
  );


  /*
   * Governance.
   */

  blocks.push(
    findTextWindow(
      text,
      [
        "corporate governance",
        "governance report",
        "related party transactions",
        "related-party transactions"
      ],
      {
        before:
          4000,

        after:
          30000
      }
    )
  );


  /*
   * Auditor.
   */

  blocks.push(
    findTextWindow(
      text,
      [
        "independent auditor's report",
        "independent auditors' report",
        "independent auditor report",
        "key audit matters"
      ],
      {
        before:
          3000,

        after:
          45000
      }
    )
  );


  /*
   * Consolidated financial statement context.
   *
   * We do NOT need to send all notes.
   */

  blocks.push(
    findTextWindow(
      text,
      PROFIT_STATEMENT_HEADINGS,
      {
        before:
          2000,

        after:
          22000
      }
    )
  );


  blocks.push(
    findTextWindow(
      text,
      BALANCE_SHEET_HEADINGS,
      {
        before:
          2000,

        after:
          22000
      }
    )
  );


  blocks.push(
    findTextWindow(
      text,
      CASH_FLOW_HEADINGS,
      {
        before:
          2000,

        after:
          22000
      }
    )
  );


  /*
   * End of report can contain important financial/auditor
   * material missed by heading detection.
   */

  blocks.push(
    text.slice(
      Math.max(
        0,
        text.length -
        40000
      )
    )
  );


  const unique =
    deduplicateTextBlocks(
      blocks
    );


  /*
   * Hard character limit.
   *
   * This is significantly smaller than sending 500k–700k
   * characters on every analysis request.
   */

  const MAX_CONTEXT_CHARACTERS =
    260000;


  let output =
    "";


  for (
    const block
    of unique
  ) {

    if (
      output.length >=
      MAX_CONTEXT_CHARACTERS
    ) {

      break;
    }


    const remaining =
      MAX_CONTEXT_CHARACTERS -
      output.length;


    const selected =
      block.slice(
        0,
        remaining
      );


    output +=

      `

============================================================
REPORT EVIDENCE SECTION
============================================================

${selected}

`;

  }


  return output.trim();
}


/* ============================================================
   15B. ANALYZE REPORT
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

            ok:
              false,

            error:
              "Upload an annual-report PDF."

          });
      }


      validatePdfFile(
        req.file
      );


      /* ------------------------------------------------------
         LOCAL PDF TEXT
         ------------------------------------------------------ */

      const pdfData =
        await extractPdfTextLocally(
          req.file
        );


      const metrics =
        safeJSON(
          req.body.metrics
        );


      const pdfContext =
        safeJSON(
          req.body.pdfContext
        );


      /*
       * Only selected evidence is sent to Gemini.
       */

      const reportText =
        buildQualitativeReportContext(
          pdfData.text
        );


      if (
        reportText.length <
        500
      ) {

        const error =
          new Error(
            "FinSight could not prepare enough annual-report text for qualitative analysis."
          );


        error.status =
          422;


        throw error;
      }


      console.log(
        "Annual-report qualitative AI context:",
        {
          originalCharacters:
            pdfData.text.length,

          selectedCharacters:
            reportText.length,

          pages:
            pdfData.pages
        }
      );


      const prompt = `Analyze this annual report for a long-term investor.

Use ONLY supplied evidence.
Do not invent missing facts or numbers.

STRUCTURED FINANCIALS
${JSON.stringify(
  metrics || {},
  null,
  2
)}

LOCAL PDF CONTEXT
${JSON.stringify(
  pdfContext || {},
  null,
  2
)}

SELECTED REPORT EVIDENCE
${reportText}

ANALYZE
- business model, segments, revenue drivers, competitive position
- growth drivers
- profitability and cash quality
- working capital, leverage and liquidity
- management strategy and execution
- capital allocation
- governance and related parties
- auditor opinion, qualifications and key audit matters
- material risks
- management commitments and later evidence where available

RULES
- Structured financials are authoritative where supplied.
- Missing evidence = say it is unavailable.
- Do not invent page references.
- Do not convert an anomaly into an allegation.
- Do not provide personalized buy/sell advice.
- Keep the output concise.
- Return JSON only.

JSON
{
  "company": "",
  "report_type": "single|multi",
  "financial_years": [],
  "overall_view": "",
  "confidence": "High|Medium|Low",

  "yearly_analysis": [
    {
      "financial_year": "",
      "statement_basis": "Consolidated|Standalone|Mixed|Unknown",
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
}`;


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


      const analysis =
        safeJSON(
          text
        );


      if (
        !analysis ||
        typeof analysis !== "object" ||
        Array.isArray(
          analysis
        )
      ) {

        throw new Error(
          "Gemini returned an unreadable annual-report analysis."
        );
      }


      /* ------------------------------------------------------
         DEFENSIVE STRUCTURE
         ------------------------------------------------------ */

      const arrayFields = [

        "financial_years",
        "yearly_analysis",
        "management_promise_tracker",
        "good",
        "bad",
        "watch",
        "red_flags",
        "growth_drivers",
        "investor_questions",
        "missing_information"

      ];


      for (
        const field
        of arrayFields
      ) {

        if (
          !Array.isArray(
            analysis[field]
          )
        ) {

          analysis[field] =
            [];
        }

      }


      analysis.trend_analysis =

        analysis.trend_analysis &&
        typeof analysis.trend_analysis ===
          "object" &&
        !Array.isArray(
          analysis.trend_analysis
        )

          ? analysis.trend_analysis

          : {};


      analysis.changes =

        analysis.changes &&
        typeof analysis.changes ===
          "object" &&
        !Array.isArray(
          analysis.changes
        )

          ? analysis.changes

          : {};


      return res.json({

        ok:
          true,

        analysis,

        model:
          GEMINI_MODEL,

        provider:
          "gemini",

        pdfProcessing:
          "local-text-selection",

        pdf: {

          pages:
            pdfData.pages,

          extractedCharacters:
            pdfData.text.length,

          aiContextCharacters:
            reportText.length

        }

      });

    }

    catch (error) {

      console.error(
        "Annual Report AI:",
        error
      );


      const upstreamStatus =
        Number(
          error?.status
        );


      let status =
        500;


      if (
        upstreamStatus === 400
      ) {

        status =
          400;
      }

      else if (
        upstreamStatus === 413
      ) {

        status =
          413;
      }

      else if (
        upstreamStatus === 422
      ) {

        status =
          422;
      }

      else if (
        upstreamStatus === 429
      ) {

        status =
          429;
      }

      else if (
        upstreamStatus === 401 ||
        upstreamStatus === 403
      ) {

        status =
          503;
      }

      else if (
        upstreamStatus >= 500
      ) {

        status =
          503;
      }


      return res
        .status(
          status
        )
        .json({

          ok:
            false,

          error:
            error?.message ||
            "Annual-report analysis failed.",

          provider:
            "gemini"

        });

    }

  }
);


/* ============================================================
   16. ASK FINSIGHT
   ============================================================ */

/*
 * No PDF is sent here.
 *
 * Ask FinSight works from already prepared structured data.
 *
 * Therefore every question is much cheaper than sending the
 * annual report again.
 */

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
        req.body ||
        {};


      const cleanQuestion =
        String(
          question ||
          ""
        ).trim();


      if (!cleanQuestion) {

        return res
          .status(400)
          .json({

            ok:
              false,

            error:
              "Question is required."

          });
      }


      if (
        !company ||
        typeof company !==
          "object"
      ) {

        return res
          .status(400)
          .json({

            ok:
              false,

            error:
              "Company evidence is required. Upload an annual report first."

          });
      }


      /*
       * Keep Ask FinSight context bounded.
       *
       * reportAnalysis should already be compact JSON.
       */

      const prompt = `Answer the investor's question using ONLY supplied FinSight evidence.

QUESTION
${cleanQuestion}

COMPANY
${JSON.stringify(
  company || {},
  null,
  2
)}

FINANCIALS
${JSON.stringify(
  financials || [],
  null,
  2
)}

MARKET
${JSON.stringify(
  market || null,
  null,
  2
)}

VALUATION
${JSON.stringify(
  valuation || null,
  null,
  2
)}

REPORT ANALYSIS
${JSON.stringify(
  reportAnalysis || null,
  null,
  2
)}

PDF CONTEXT
${JSON.stringify(
  pdfContext || null,
  null,
  2
)}

RULES
- Answer the question directly.
- Use only supplied evidence.
- Missing evidence = "Not established from the loaded annual-report evidence."
- Never invent numbers, ticker, market price, page references, auditor findings or management claims.
- Distinguish reported fact, calculated metric, management claim and interpretation.
- No personalized buy/sell advice.
- Keep the answer concise.
- Return JSON only.

JSON
{
  "answer": "",
  "reported_facts": [],
  "calculated_metrics": [],
  "management_claims": [],
  "ai_interpretation": [],
  "evidence": [],
  "risks": [],
  "what_to_investigate_next": []
}`;


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
        safeJSON(
          text
        );


      if (
        !answer ||
        typeof answer !==
          "object" ||
        Array.isArray(
          answer
        )
      ) {

        throw new Error(
          "Gemini returned an unreadable answer."
        );
      }


      const arrayFields = [

        "reported_facts",
        "calculated_metrics",
        "management_claims",
        "ai_interpretation",
        "evidence",
        "risks",
        "what_to_investigate_next"

      ];


      for (
        const field
        of arrayFields
      ) {

        if (
          !Array.isArray(
            answer[field]
          )
        ) {

          answer[field] =
            [];
        }

      }


      return res.json({

        ok:
          true,

        answer,

        model:
          GEMINI_MODEL,

        provider:
          "gemini"

      });

    }

    catch (error) {

      console.error(
        "Ask FinSight:",
        error
      );


      const upstreamStatus =
        Number(
          error?.status
        );


      let status =
        500;


      if (
        upstreamStatus === 400
      ) {

        status =
          400;
      }

      else if (
        upstreamStatus === 429
      ) {

        status =
          429;
      }

      else if (
        upstreamStatus === 401 ||
        upstreamStatus === 403
      ) {

        status =
          503;
      }

      else if (
        upstreamStatus >= 500
      ) {

        status =
          503;
      }


      return res
        .status(
          status
        )
        .json({

          ok:
            false,

          error:
            error?.message ||
            "FinSight could not answer the question.",

          provider:
            "gemini"

        });

    }

  }
);


/* ============================================================
   17. COMPETITOR COMPARISON
   ============================================================ */

/*
 * Credit-efficient architecture:
 *
 * Company A PDF
 *       ↓
 * local pdf-parse
 *       ↓
 * local deterministic financial extraction
 *       ↓
 * selected qualitative text
 *       ↓
 * ONE Gemini compact-profile call
 *
 *
 * Company B PDF
 *       ↓
 * same process
 *
 *
 * Compact profile A + B
 *       ↓
 * ONE small Gemini comparison call
 *
 *
 * The PDFs themselves are NOT sent to Gemini in this section.
 */


/* ============================================================
   17A. PREPARE COMPARISON REPORT
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
        )
          .trim()
          .slice(
            0,
            200
          );


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


      validatePdfFile(
        report
      );


      console.log(
        "Preparing comparison report:",
        {
          label,

          file:
            report.originalname,

          sizeMB:
            roundFinancial(
              report.buffer.length /
              1024 /
              1024
            )
        }
      );


      /* ------------------------------------------------------
         LOCAL PDF
         ------------------------------------------------------ */

      const pdfData =
        await extractPdfTextLocally(
          report
        );


      /* ------------------------------------------------------
         LOCAL FINANCIALS
         ------------------------------------------------------ */

      let localFinancials =
        null;


      try {

        localFinancials =
          extractFinancialsLocally(
            pdfData
          );


        localFinancials =
          validateFinancialExtractionResult(
            localFinancials
          );

      }

      catch (
        extractionError
      ) {

        /*
         * Comparison can still continue qualitatively.
         *
         * Do not fabricate financial values.
         */

        console.warn(
          `Local comparison financial extraction incomplete for ${label}:`,
          extractionError?.message
        );


        localFinancials =
          null;

      }


      /* ------------------------------------------------------
         COMPACT QUALITATIVE CONTEXT
         ------------------------------------------------------ */

      const reportText =
        buildQualitativeReportContext(
          pdfData.text
        );


      const prompt = `Create a compact investor profile for ${label} using ONLY supplied annual-report evidence.

LOCAL FINANCIALS
${JSON.stringify(
  localFinancials || null,
  null,
  2
)}

SELECTED REPORT EVIDENCE
${reportText}

RULES
- Prefer consolidated evidence.
- Local financial values are authoritative where supplied.
- Missing financial value = null.
- Never guess ticker, exchange, market price or valuation.
- Do not treat missing information as zero.
- Do not invent risks or auditor findings.
- Keep descriptions concise.
- Return JSON only.

JSON
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
}`;


      const resultText =
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


      /* ------------------------------------------------------
         DEFENSIVE OBJECTS
         ------------------------------------------------------ */

      const objectFields = [

        "company",
        "financials",
        "business",
        "management",
        "governance",
        "auditor"

      ];


      for (
        const field
        of objectFields
      ) {

        if (
          !research[field] ||
          typeof research[field] !==
            "object" ||
          Array.isArray(
            research[field]
          )
        ) {

          research[field] =
            {};
        }

      }


      const arrayFields = [

        "risks",
        "strengths",
        "weaknesses",
        "investor_questions"

      ];


      for (
        const field
        of arrayFields
      ) {

        if (
          !Array.isArray(
            research[field]
          )
        ) {

          research[field] =
            [];
        }

      }


      /*
       * Preserve locally detected identity if Gemini omitted it.
       */

      if (
        !research.company.name &&
        localFinancials?.company?.name
      ) {

        research.company.name =
          localFinancials.company.name;
      }


      /*
       * Preserve latest locally extracted year.
       */

      if (
        !research.company.financial_year &&
        localFinancials?.financials?.[0]
          ?.financial_year
      ) {

        research.company.financial_year =
          localFinancials
            .financials[0]
            .financial_year;
      }


      console.log(
        "Comparison profile ready:",
        {
          label,

          company:
            research.company?.name ||
            report.originalname
        }
      );


      return res.json({

        ok:
          true,

        label,

        fileName:
          report.originalname,

        research,

        localFinancials,

        model:
          GEMINI_MODEL,

        provider:
          "gemini",

        pdfProcessing:
          "local",

        pdf: {

          pages:
            pdfData.pages,

          extractedCharacters:
            pdfData.text.length,

          aiContextCharacters:
            reportText.length

        }

      });

    }

    catch (error) {

      console.error(
        "Prepare comparison report:",
        error
      );


      const upstreamStatus =
        Number(
          error?.status
        );


      let status =
        500;


      if (
        upstreamStatus === 400
      ) {

        status =
          400;
      }

      else if (
        upstreamStatus === 413
      ) {

        status =
          413;
      }

      else if (
        upstreamStatus === 422
      ) {

        status =
          422;
      }

      else if (
        upstreamStatus === 429
      ) {

        status =
          429;
      }

      else if (
        upstreamStatus === 401 ||
        upstreamStatus === 403
      ) {

        status =
          503;
      }

      else if (
        upstreamStatus >= 500
      ) {

        status =
          503;
      }


      return res
        .status(
          status
        )
        .json({

          ok:
            false,

          error:
            error?.message ||
            "Could not prepare annual report for comparison.",

          provider:
            "gemini"

        });

    }

  }
);


/* ============================================================
   17B. COMPARE PREPARED PROFILES
   ============================================================ */

/*
 * JSON only.
 *
 * No PDF.
 * No local parsing.
 *
 * This makes the final comparison relatively inexpensive.
 */

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
          "object" ||
        Array.isArray(
          companyA
        )
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
          "object" ||
        Array.isArray(
          companyB
        )
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


      const serializedA =
        JSON.stringify(
          companyA
        );


      const serializedB =
        JSON.stringify(
          companyB
        );


      /*
       * Prevent accidentally sending enormous frontend state
       * into Gemini.
       */

      const MAX_PROFILE_SIZE =
        180000;


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
        "Company comparison started:",
        companyAName,
        "vs",
        companyBName
      );


      const prompt = `Compare these two companies using ONLY supplied annual-report research.

COMPANY A
${serializedA}

COMPANY B
${serializedB}

Compare:
- business quality
- growth
- profitability
- cash generation
- balance sheet
- capital allocation
- management
- governance
- auditor
- risks
- valuation only if supplied evidence supports it

EDGE must be exactly one of:
"Company A"
"Company B"
"Mixed"
"Similar"
"Insufficient evidence"

RULES
- Missing data is not a negative result.
- Never treat null as zero.
- Do not invent market prices or valuation multiples.
- Do not use outside company knowledge.
- Explain trade-offs rather than automatically declaring a winner.
- No personalized buy/sell advice.
- Keep the output concise.
- Return JSON only.

JSON
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
}`;


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


      const arrayFields = [

        "company_a_strengths",
        "company_a_weaknesses",
        "company_b_strengths",
        "company_b_weaknesses",
        "important_tradeoffs",
        "questions_before_choosing_a",
        "questions_before_choosing_b"

      ];


      for (
        const field
        of arrayFields
      ) {

        if (
          !Array.isArray(
            comparison[field]
          )
        ) {

          comparison[field] =
            [];
        }

      }


      console.log(
        "Company comparison complete:",
        comparison.company_a,
        "vs",
        comparison.company_b
      );


      return res.json({

        ok:
          true,

        comparison,

        model:
          GEMINI_MODEL,

        provider:
          "gemini"

      });

    }

    catch (error) {

      console.error(
        "Company comparison failed:",
        error
      );


      const upstreamStatus =
        Number(
          error?.status
        );


      let status =
        500;


      if (
        upstreamStatus === 400
      ) {

        status =
          400;
      }

      else if (
        upstreamStatus === 413
      ) {

        status =
          413;
      }

      else if (
        upstreamStatus === 429
      ) {

        status =
          429;
      }

      else if (
        upstreamStatus === 401 ||
        upstreamStatus === 403
      ) {

        status =
          503;
      }

      else if (
        upstreamStatus >= 500
      ) {

        status =
          503;
      }


      return res
        .status(
          status
        )
        .json({

          ok:
            false,

          error:
            error?.message ||
            "Company comparison failed.",

          provider:
            "gemini"

        });

    }

  }/* ============================================================
   18. ALPHA VANTAGE MARKET QUOTE
   ONE API REQUEST PER BUTTON PRESS
   ============================================================ */

app.get(
  "/api/market/:identifier",

  async (
    req,
    res
  ) => {

    try {

      if (!ALPHA_VANTAGE_API_KEY) {

        return res
          .status(503)
          .json({

            ok:
              false,

            error:
              "Alpha Vantage API key is not configured."

          });

      }


      const identifier =
        String(
          req.params.identifier ||
          ""
        )
          .trim()
          .toUpperCase();


      const ticker =
        String(
          req.query.ticker ||
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


      const bseCode =
        String(
          req.query.bseCode ||
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
        )
          .trim()
          .slice(
            0,
            300
          );


      /* ------------------------------------------------------
         RESOLVE ONE MARKET SYMBOL
         ------------------------------------------------------ */

      let symbol =
        null;


      let identifierSource =
        null;


      if (bseCode) {

        symbol =

          bseCode.endsWith(
            ".BSE"
          )

            ? bseCode

            : `${bseCode}.BSE`;


        identifierSource =
          "BSE security code";

      }

      else if (ticker) {

        if (
          exchange === "BSE" &&
          !ticker.endsWith(
            ".BSE"
          )
        ) {

          symbol =
            `${ticker}.BSE`;

        }

        else {

          symbol =
            ticker;

        }


        identifierSource =
          "verified ticker";

      }

      else if (nseCode) {

        symbol =
          nseCode;


        identifierSource =
          "NSE code";

      }

      else if (identifier) {

        symbol =
          identifier;


        identifierSource =
          "market identifier";

      }


      if (!symbol) {

        return res
          .status(400)
          .json({

            ok:
              false,

            error:
              "No verified market identifier is available."

          });

      }


      /*
       * Defensive symbol length.
       */

      symbol =
        String(
          symbol
        )
          .trim()
          .slice(
            0,
            100
          );


      console.log(
        "Alpha Vantage quote request:",
        {
          company:
            companyName,

          symbol,

          identifierSource
        }
      );


      /* ------------------------------------------------------
         EXACTLY ONE ALPHA VANTAGE REQUEST
         ------------------------------------------------------ */

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


      const response =
        await fetch(
          url,
          {
            signal:
              AbortSignal.timeout(
                30000
              )
          }
        );


      if (!response.ok) {

        throw new Error(
          `Alpha Vantage HTTP ${response.status}`
        );

      }


      const data =
        await response.json();


      /*
       * Alpha Vantage can return HTTP 200 for provider limits.
       */

      if (
        data.Note ||
        data.Information
      ) {

        const providerMessage =
          data.Note ||
          data.Information;


        console.warn(
          "Alpha Vantage provider message:",
          providerMessage
        );


        return res
          .status(429)
          .json({

            ok:
              false,

            error:
              providerMessage,

            provider:
              "Alpha Vantage",

            symbol,

            identifierSource

          });

      }


      if (
        data[
          "Error Message"
        ]
      ) {

        return res
          .status(404)
          .json({

            ok:
              false,

            error:
              data[
                "Error Message"
              ],

            provider:
              "Alpha Vantage",

            symbol,

            identifierSource

          });

      }


      const quote =
        data[
          "Global Quote"
        ] ||
        {};


      const price =
        finiteFinancialNumber(
          quote[
            "05. price"
          ]
        );


      if (
        price === null ||
        price <= 0
      ) {

        return res
          .status(404)
          .json({

            ok:
              false,

            error:
              `Alpha Vantage returned no usable price for ${symbol}.`,

            provider:
              "Alpha Vantage",

            symbol,

            identifierSource

          });

      }


      function numberValue(
        key
      ) {

        return finiteFinancialNumber(
          quote[key]
        );

      }


      /* ------------------------------------------------------
         CURRENCY
         ------------------------------------------------------ */

      let currency =
        null;


      if (
        exchange === "NSE" ||
        exchange === "BSE" ||
        symbol.endsWith(
          ".BSE"
        )
      ) {

        currency =
          "INR";

      }

      else if (
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


      console.log(
        "Alpha Vantage quote successful:",
        symbol,
        price
      );


      return res.json({

        ok:
          true,

        provider:
          "Alpha Vantage",

        identifierSource,

        requestedIdentifier:
          identifier,

        symbol,

        ticker:
          ticker ||
          null,

        nseCode:
          nseCode ||
          null,

        bseCode:
          bseCode ||
          null,

        companyName:
          companyName ||
          null,

        exchange:
          exchange ||
          null,

        currency,

        price,

        open:
          numberValue(
            "02. open"
          ),

        high:
          numberValue(
            "03. high"
          ),

        low:
          numberValue(
            "04. low"
          ),

        volume:
          numberValue(
            "06. volume"
          ),

        asOf:
          quote[
            "07. latest trading day"
          ] ||
          null,

        previousClose:
          numberValue(
            "08. previous close"
          ),

        change:
          numberValue(
            "09. change"
          ),

        changePercent:
          quote[
            "10. change percent"
          ] ||
          null,

        live:
          false,

        freshness:
          "last available / end-of-day"

      });

    }

    catch (error) {

      console.error(
        "Alpha Vantage market error:",
        error
      );


      return res
        .status(503)
        .json({

          ok:
            false,

          error:
            error?.message ||
            "Alpha Vantage market-price lookup failed."

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

      if (!ALPHA_VANTAGE_API_KEY) {

        return res
          .status(503)
          .json({

            ok:
              false,

            error:
              "Alpha Vantage is not configured."

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


      if (!ticker) {

        return res
          .status(400)
          .json({

            ok:
              false,

            error:
              "Ticker is required."

          });

      }


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


      const response =
        await fetch(
          url,
          {
            signal:
              AbortSignal.timeout(
                30000
              )
          }
        );


      if (!response.ok) {

        throw new Error(
          `Alpha Vantage HTTP ${response.status}`
        );

      }


      const data =
        await response.json();


      if (
        data.Note ||
        data.Information
      ) {

        return res
          .status(429)
          .json({

            ok:
              false,

            error:
              data.Note ||
              data.Information,

            provider:
              "Alpha Vantage"

          });

      }


      if (
        data[
          "Error Message"
        ]
      ) {

        return res
          .status(404)
          .json({

            ok:
              false,

            error:
              data[
                "Error Message"
              ],

            provider:
              "Alpha Vantage"

          });

      }


      const series =
        data[
          "Time Series (Daily)"
        ];


      if (!series) {

        return res
          .status(404)
          .json({

            ok:
              false,

            error:
              "Historical market data unavailable.",

            provider:
              "Alpha Vantage"

          });

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
                finiteFinancialNumber(
                  values[
                    "1. open"
                  ]
                ),

              high:
                finiteFinancialNumber(
                  values[
                    "2. high"
                  ]
                ),

              low:
                finiteFinancialNumber(
                  values[
                    "3. low"
                  ]
                ),

              close:
                finiteFinancialNumber(
                  values[
                    "4. close"
                  ]
                ),

              volume:
                finiteFinancialNumber(
                  values[
                    "5. volume"
                  ]
                )

            })
          )

          .filter(
            row =>
              row.close !==
              null
          )

          .sort(
            (
              a,
              b
            ) =>
              a.date.localeCompare(
                b.date
              )
          );


      return res.json({

        ok:
          true,

        ticker,

        symbol,

        exchange,

        provider:
          "Alpha Vantage",

        live:
          false,

        rows

      });

    }

    catch (error) {

      console.error(
        "Historical market data:",
        error
      );


      return res
        .status(503)
        .json({

          ok:
            false,

          error:
            error?.message ||
            "Historical market data unavailable."

        });

    }

  }
);


/* ============================================================
   20. AI VALUATION
   ============================================================ */

/*
 * No PDF.
 *
 * Gemini receives structured data only.
 */

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
        req.body ||
        {};


      const marketPrice =
        finiteFinancialNumber(
          market?.price
        );


      if (
        marketPrice === null ||
        marketPrice <= 0
      ) {

        return res
          .status(400)
          .json({

            ok:
              false,

            error:
              "Verified market price is required for public-market valuation."

          });

      }


      const prompt = `Interpret this valuation using ONLY supplied FinSight evidence.

COMPANY
${JSON.stringify(
  company || {},
  null,
  2
)}

MARKET
${JSON.stringify(
  market || {},
  null,
  2
)}

FINANCIALS
${JSON.stringify(
  fundamentals || [],
  null,
  2
)}

VALUATION
${JSON.stringify(
  valuation || {},
  null,
  2
)}

REPORT ANALYSIS
${JSON.stringify(
  reportAnalysis || null,
  null,
  2
)}

RULES
- Structured financials and valuation metrics are authoritative.
- Do not invent or estimate missing metrics.
- Do not replace supplied metric definitions with different calculations.
- Earnings quality must consider operating cash flow, free cash flow, cash conversion and working capital.
- Do not infer sector norms or industry facts unless supplied.
- Preserve reported vs adjusted/non-GAAP distinctions.
- Do not call manually entered price a live quote.
- No personalized buy/sell advice.
- Keep the answer concise.
- Return JSON only.

Assess:
- business quality
- earnings quality
- balance-sheet quality
- valuation multiples
- earnings yield
- FCF yield where available
- leverage
- expectations implied by valuation
- assumptions that could invalidate the conclusion

JSON
{
  "answer": "",
  "reported_facts": [],
  "calculated_metrics": [],
  "management_claims": [],
  "ai_interpretation": [],
  "evidence": [],
  "risks": [],
  "what_to_investigate_next": []
}`;


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
        safeJSON(
          text
        );


      if (
        !assessment ||
        typeof assessment !==
          "object" ||
        Array.isArray(
          assessment
        )
      ) {

        throw new Error(
          "Gemini returned an unreadable valuation assessment."
        );

      }


      const arrayFields = [

        "reported_facts",
        "calculated_metrics",
        "management_claims",
        "ai_interpretation",
        "evidence",
        "risks",
        "what_to_investigate_next"

      ];


      for (
        const field
        of arrayFields
      ) {

        if (
          !Array.isArray(
            assessment[field]
          )
        ) {

          assessment[field] =
            [];

        }

      }


      return res.json({

        ok:
          true,

        assessment,

        model:
          GEMINI_MODEL,

        provider:
          "gemini"

      });

    }

    catch (error) {

      console.error(
        "AI valuation:",
        error
      );


      const upstreamStatus =
        Number(
          error?.status
        );


      let status =
        500;


      if (
        upstreamStatus === 400
      ) {

        status = 400;

      }

      else if (
        upstreamStatus === 429
      ) {

        status = 429;

      }

      else if (
        upstreamStatus === 401 ||
        upstreamStatus === 403
      ) {

        status = 503;

      }

      else if (
        upstreamStatus >= 500
      ) {

        status = 503;

      }


      return res
        .status(status)
        .json({

          ok:
            false,

          error:
            error?.message ||
            "Valuation interpretation failed.",

          provider:
            "gemini"

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
          req.body ||
          {}
        );


      return res.json({

        ok:
          true,

        ...result

      });

    }

    catch (error) {

      console.error(
        "DCF:",
        error
      );


      return res
        .status(400)
        .json({

          ok:
            false,

          error:
            error?.message ||
            "DCF calculation failed."

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
          req.body ||
          {}
        );


      return res.json({

        ok:
          true,

        ...result

      });

    }

    catch (error) {

      console.error(
        "Reverse DCF:",
        error
      );


      return res
        .status(400)
        .json({

          ok:
            false,

          error:
            error?.message ||
            "Reverse DCF calculation failed."

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

            ok:
              false,

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

        thesisBreakers =
          []

      } =
        req.body ||
        {};


      const cleanCompany =
        String(
          company ||
          ""
        ).trim();


      const cleanThesis =
        String(
          thesis ||
          ""
        ).trim();


      if (!cleanCompany) {

        return res
          .status(400)
          .json({

            ok:
              false,

            error:
              "Company is required."

          });

      }


      if (!cleanThesis) {

        return res
          .status(400)
          .json({

            ok:
              false,

            error:
              "Investment thesis is required."

          });

      }


      const companyRow =
        await upsertCompany({

          name:
            cleanCompany,

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

            String(
              companyRow.id
            ),

            cleanThesis,

            bullCase ||
            null,

            bearCase ||
            null,

            Array.isArray(
              thesisBreakers
            )

              ? thesisBreakers

              : []

          ]
        );


      return res.json({

        ok:
          true,

        company:
          companyRow,

        thesis:
          result.rows[0]

      });

    }

    catch (error) {

      console.error(
        "Save thesis:",
        error
      );


      return res
        .status(500)
        .json({

          ok:
            false,

          error:
            error?.message ||
            "Could not save investment thesis."

        });

    }

  }
);


/* ============================================================
   24. RESEARCH MEMORY HELPERS
   ============================================================ */

async function loadCompanyResearch(
  company
) {

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
            String(
              company.id
            )
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


  return {

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

  };
}


/* ============================================================
   24A. LOAD RESEARCH MEMORY
   ============================================================ */

app.get(
  "/api/research",

  async (
    req,
    res
  ) => {

    try {

      if (!pool) {

        return res
          .status(503)
          .json({

            ok:
              false,

            error:
              "Research memory database is not configured."

          });

      }


      await ensureResearchTables();


      const ticker =
        String(
          req.query.ticker ||
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


      if (
        !ticker &&
        !companyName
      ) {

        return res
          .status(400)
          .json({

            ok:
              false,

            error:
              "Company name or ticker is required."

          });

      }


      let companyResult =
        null;


      if (ticker) {

        companyResult =
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

      }


      if (
        (
          !companyResult ||
          !companyResult.rows[0]
        )

        &&

        companyName
      ) {

        companyResult =
          await dbQuery(
            `
            SELECT *
            FROM companies

            WHERE LOWER(name) =
                  LOWER($1)

            ORDER BY updated_at DESC

            LIMIT 1
            `,
            [
              companyName
            ]
          );

      }


      const company =
        companyResult
          ?.rows
          ?.[0];


      if (!company) {

        return res
          .status(404)
          .json({

            ok:
              false,

            error:
              "Company not found in FinSight research memory."

          });

      }


      const research =
        await loadCompanyResearch(
          company
        );


      return res.json({

        ok:
          true,

        ...research

      });

    }

    catch (error) {

      console.error(
        "Research memory:",
        error
      );


      return res
        .status(500)
        .json({

          ok:
            false,

          error:
            error?.message ||
            "Research memory could not be loaded."

        });

    }

  }
);


/* ============================================================
   24B. LOAD RESEARCH MEMORY BY TICKER
   ============================================================ */

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

            ok:
              false,

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


      if (!ticker) {

        return res
          .status(400)
          .json({

            ok:
              false,

            error:
              "Ticker is required."

          });

      }


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

            ok:
              false,

            error:
              "Company not found in FinSight research memory."

          });

      }


      const research =
        await loadCompanyResearch(
          company
        );


      return res.json({

        ok:
          true,

        ...research

      });

    }

    catch (error) {

      console.error(
        "Research memory by ticker:",
        error
      );


      return res
        .status(500)
        .json({

          ok:
            false,

          error:
            error?.message ||
            "Research memory could not be loaded."

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

            ok:
              false,

            error:
              "Research memory database is not configured."

          });

      }


      const {

        company,

        ticker,

        exchange,

        market =
          {},

        fundamentals =
          {},

        valuation =
          {},

        aiAssessment =
          null

      } =
        req.body ||
        {};


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

        ok:
          true,

        company:
          companyRow,

        snapshot:
          result.rows[0]

      });

    }

    catch (error) {

      console.error(
        "Valuation snapshot:",
        error
      );


      return res
        .status(500)
        .json({

          ok:
            false,

          error:
            error?.message ||
            "Valuation snapshot could not be saved."

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

        connected:
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

    catch (error) {

      console.error(
        "Database status:",
        error
      );


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
            error?.message ||
            "Database connection failed."

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
   28. GLOBAL ERROR HANDLER
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


    /* ------------------------------------------------------
       MULTER
       ------------------------------------------------------ */

    if (
      error instanceof
      multer.MulterError
    ) {

      if (
        error.code ===
        "LIMIT_FILE_SIZE"
      ) {

        return res
          .status(413)
          .json({

            ok:
              false,

            error:
              "The annual-report PDF exceeds FinSight's 45 MB upload limit.",

            code:
              "REPORT_TOO_LARGE"

          });

      }


      return res
        .status(400)
        .json({

          ok:
            false,

          error:
            `File upload error: ${error.message}`,

          code:
            "FILE_UPLOAD_ERROR"

        });

    }


    /* ------------------------------------------------------
       NORMAL APPLICATION ERROR
       ------------------------------------------------------ */

    const errorStatus =
      Number(
        error?.status
      );


    const status =

      Number.isInteger(
        errorStatus
      ) &&
      errorStatus >= 400 &&
      errorStatus <= 599

        ? errorStatus

        : 500;


    return res
      .status(status)
      .json({

        ok:
          false,

        error:
          error?.message ||
          "Unexpected server error."

      });

  }
);


/* ============================================================
   29. START
   ============================================================ */

async function boot() {

  /* ----------------------------------------------------------
     DATABASE INITIALIZATION
     ---------------------------------------------------------- */

  try {

    if (pool) {

      await initDatabase();

    }

  }

  catch (error) {

    /*
     * Database failure must not prevent the application
     * itself from starting.
     */

    console.error(
      "Database initialization failed:",
      error?.message
    );

  }


  /* ----------------------------------------------------------
     SERVER
     ---------------------------------------------------------- */

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
        `Gemini model: ${GEMINI_MODEL}`
      );


      console.log(
        `Gemini text fallback model: ${
          GEMINI_FALLBACK_MODEL ||
          "DISABLED"
        }`
      );


      console.log(
        "OpenAI: REMOVED"
      );


      console.log(
        "Financial extraction architecture:"
      );


      console.log(
        "CACHE -> GEMINI ONCE -> LOCAL FALLBACK"
      );


      console.log(
        `Financial extraction cache version: ${FINANCIAL_EXTRACTION_CACHE_VERSION}`
      );


      console.log(
        "Gemini financial extraction attempts per new report: MAXIMUM 1"
      );


      console.log(
        `Gemini extraction PDF threshold: ${GEMINI_EXTRACTION_MAX_PDF_MB} MB`
      );


      console.log(
        `Gemini extraction timeout: ${GEMINI_EXTRACTION_TIMEOUT_MS} ms`
      );


      console.log(
        "If Gemini extraction fails: LOCAL PARSER AUTOMATICALLY RUNS"
      );


      console.log(
        "If Gemini returns invalid financial JSON: LOCAL PARSER AUTOMATICALLY RUNS"
      );


      console.log(
        "If Gemini financial result fails reliability validation: LOCAL PARSER AUTOMATICALLY RUNS"
      );


      console.log(
        "Same successfully cached PDF uploaded again: ZERO GEMINI EXTRACTION CALLS"
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
        "Annual-report qualitative analysis: LOCAL TEXT -> GEMINI"
      );


      console.log(
        "Ask FinSight: STRUCTURED CONTEXT -> GEMINI"
      );


      console.log(
        "Competitor report preparation: LOCAL PDF -> COMPACT GEMINI PROFILE"
      );


      console.log(
        "Competitor final comparison: COMPACT JSON -> GEMINI"
      );


      console.log(
        "DCF / Reverse DCF: LOCAL"
      );


      console.log(
        "FinSight AI service: READY"
      );

    }

  );

}


boot();
);


/* ============================================================
   END BLOCK 2
   SECTIONS 15–17 COMPLETE

   NEXT:
   SECTION 18 — ALPHA VANTAGE
   THROUGH
   SECTION 29 — SERVER START
   ============================================================ */


