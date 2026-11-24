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


const GEMINI_MODEL =
  process.env.GEMINI_MODEL ||
  "gemini-3.8-flash";


const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  "";


function aiTimeoutSetting(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 15000 && value <= 300000
    ? value : fallback;
}

const GEMINI_TEXT_TIMEOUT_MS = aiTimeoutSetting("GEMINI_TEXT_TIMEOUT_MS", 60000);
const GEMINI_PDF_TIMEOUT_MS = aiTimeoutSetting("GEMINI_PDF_TIMEOUT_MS", 180000);


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

      aiPrimaryProvider: "gemini",
      aiFallbackProvider: OPENAI_FALLBACK_ENABLED ? "openai" : null,
      aiProviders: {
        gemini: {
          configured: Boolean(GEMINI_API_KEY),
          model: GEMINI_MODEL,
          generationAttemptsPerModel: 1,
          requestTimeoutMs: GEMINI_TEXT_TIMEOUT_MS,
          pdfRequestTimeoutMs: GEMINI_PDF_TIMEOUT_MS,
          fallbackModel: process.env.GEMINI_FALLBACK_MODEL || "gemini-3.8-flash"
        },
        openai: {
          configured: Boolean(openai),
          enabled: OPENAI_FALLBACK_ENABLED,
          model: OPENAI_MODEL,
          scope: "text and PDF fallback after temporary Gemini failures",
          generationAttempts: 1
        }
      },
      aiPdfProviders: OPENAI_FALLBACK_ENABLED ? ["gemini", "openai"] : ["gemini"],
      aiPdfFallbackProvider: OPENAI_FALLBACK_ENABLED ? "openai" : null,
      aiPdfFallbackMode: OPENAI_FALLBACK_ENABLED
        ? "gemini-primary-once-then-gemini-fallback-once-then-openai-once"
        : "gemini-primary-once-then-gemini-fallback-once",

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
   12. GEMINI — TEXT ONLY
   ============================================================ */

/*
 * IMPORTANT ARCHITECTURE
 *
 * Gemini is NOT used for financial-statement extraction.
 *
 * PDF financial extraction is performed locally in Section 13/14.
 *
 * Gemini is used only for qualitative text analysis after
 * the PDF has already been converted to text locally.
 */


const analystInstructions = `

You are FinSight AI, an evidence-first equity research system.

The supplied annual-report evidence is the primary source of truth.

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

A financial anomaly is an investigation prompt,
not proof of misconduct.

Do not issue personalized buy/sell instructions.

`;


/* ============================================================
   GEMINI RESPONSE TEXT
   ============================================================ */

function extractGeminiText(payload) {

  return (
    payload
      ?.candidates
      ?.[0]
      ?.content
      ?.parts

    || []

  )
    .map(
      part =>
        part?.text || ""
    )
    .join("\n")
    .trim();

}


/* ============================================================
   GEMINI MODEL URL
   ============================================================ */

function geminiModelUrl(model) {

  return (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    +
    encodeURIComponent(model)
    +
    ":generateContent"
  );

}


/* ============================================================
   GEMINI ERROR CHECK
   ============================================================ */

function isGeminiTemporaryError(error) {

  const status =
    Number(
      error?.status
    );


  const providerStatus =
    String(
      error?.providerStatus || ""
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
    providerStatus === "UNAVAILABLE"
    ||
    providerStatus === "RESOURCE_EXHAUSTED"
    ||
    providerStatus === "INTERNAL"
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
   * Gemini is text-only in the new FinSight architecture.
   */

  const safeParts =
    parts.map(
      part => ({
        text:
          String(
            part?.text || ""
          )
      })
    );


  const primaryModel =
    String(
      GEMINI_MODEL ||
      "gemini-3.8-flash"
    ).trim();


  const fallbackModel =
    String(
      process.env.GEMINI_FALLBACK_MODEL ||
      ""
    ).trim();


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


  async function requestModel(model) {

    console.log(
      `Gemini text request: ${model}`
    );


    try {

      return await fetchJSON(
        geminiModelUrl(model),
        {
          ...requestOptions,

          signal:
            AbortSignal.timeout(
              60000
            )
        }
      );

    }

    catch (error) {

      console.error(
        `Gemini ${model} failed:`,
        {
          status:
            error?.status,

          providerStatus:
            error?.providerStatus,

          message:
            error?.message
        }
      );


      throw error;

    }

  }


  let payload;
  let modelUsed =
    primaryModel;


  try {

    payload =
      await requestModel(
        primaryModel
      );

  }

  catch (primaryError) {

    /*
     * Only use the second Gemini model for temporary
     * capacity/provider failures.
     */

    if (
      !fallbackModel ||
      fallbackModel === primaryModel ||
      !isGeminiTemporaryError(primaryError)
    ) {

      throw primaryError;

    }


    console.warn(
      `Gemini primary unavailable. Trying ${fallbackModel}.`
    );


    payload =
      await requestModel(
        fallbackModel
      );


    modelUsed =
      fallbackModel;

  }


  const text =
    extractGeminiText(
      payload
    );


  if (!text) {

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
   13. LOCAL PDF EXTRACTION
   ============================================================ */

/*
 * The PDF is now processed locally by Node.js.
 *
 * NO Gemini PDF upload.
 * NO OpenAI PDF upload.
 * NO external AI dependency for financial extraction.
 */


const FINSIGHT_MAX_PDF_SIZE =
  45 * 1024 * 1024;


/* ============================================================
   LOCAL PDF TEXT EXTRACTION
   ============================================================ */

async function extractPdfTextLocally(file) {

  if (
    !file ||
    !Buffer.isBuffer(file.buffer) ||
    !file.buffer.length
  ) {

    const error =
      new Error(
        "Annual-report PDF is empty or unavailable."
      );


    error.status =
      400;


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


    error.status =
      413;


    throw error;

  }


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

  catch (error) {

    console.error(
      "Local PDF parser error:",
      error
    );


    const localError =
      new Error(
        "The PDF could not be read locally. Confirm that it is a valid text-based PDF."
      );


    localError.status =
      400;


    throw localError;

  }


  const text =
    String(
      parsed?.text || ""
    )
      .replace(
        /\u0000/g,
        ""
      )
      .replace(
        /\r/g,
        "\n"
      )
      .replace(
        /[ \t]+/g,
        " "
      )
      .replace(
        /\n{4,}/g,
        "\n\n\n"
      )
      .trim();


  if (
    text.length < 500
  ) {

    const error =
      new Error(
        "Very little text could be extracted from this PDF. The report may be scanned or image-based."
      );


    error.status =
      400;


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
      ) || null,

    info:
      parsed?.info || null

  };

}


/* ============================================================
   FINANCIAL NUMBER PARSER
   ============================================================ */

function finiteFinancialNumber(value) {

  if (
    value === null ||
    value === undefined
  ) {

    return null;

  }


  if (
    typeof value === "number"
  ) {

    return Number.isFinite(value)
      ? value
      : null;

  }


  let text =
    String(value)
      .trim();


  if (!text) {

    return null;

  }


  if (
    /^[-—–]$/.test(text)
  ) {

    return 0;

  }


  let negative =
    false;


  if (
    /^\(.+\)$/.test(text)
  ) {

    negative =
      true;


    text =
      text.slice(
        1,
        -1
      );

  }


  text =
    text
      .replace(
        /₹/g,
        ""
      )
      .replace(
        /,/g,
        ""
      )
      .trim();


  if (
    !/^[+-]?\d+(?:\.\d+)?$/.test(
      text
    )
  ) {

    return null;

  }


  const parsed =
    Number(text);


  if (
    !Number.isFinite(parsed)
  ) {

    return null;

  }


  return negative
    ? -parsed
    : parsed;

}


/* ============================================================
   REPORT TEXT NORMALIZATION
   ============================================================ */

function normalizeReportText(text) {

  return String(
    text || ""
  )
    .replace(
      /\u00a0/g,
      " "
    )
    .replace(
      /[ \t]+/g,
      " "
    )
    .replace(
      /\r/g,
      "\n"
    )
    .replace(
      /\n{3,}/g,
      "\n\n"
    )
    .trim();

}


/* ============================================================
   FIND FINANCIAL STATEMENT SECTIONS
   ============================================================ */

function findStatementSection(
  text,
  headings,
  maxLength = 50000
) {

  const normalized =
    normalizeReportText(
      text
    );


  const lower =
    normalized.toLowerCase();


  let bestIndex =
    -1;


  for (
    const heading
    of headings
  ) {

    const index =
      lower.indexOf(
        heading.toLowerCase()
      );


    if (
      index >= 0 &&
      (
        bestIndex === -1 ||
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


  return normalized.slice(
    bestIndex,
    bestIndex + maxLength
  );

}


/* ============================================================
   EXTRACT SOURCE UNIT
   ============================================================ */

function detectFinancialUnit(text) {

  const sample =
    String(
      text || ""
    )
      .slice(
        0,
        10000
      )
      .toLowerCase();


  const patterns = [

    {
      regex:
        /(?:₹|rs\.?|inr|indian rupees?)[^\n]{0,40}\bcrores?\b/i,

      unit:
        "INR crore"
    },

    {
      regex:
        /(?:₹|rs\.?|inr|indian rupees?)[^\n]{0,40}\bmillions?\b/i,

      unit:
        "INR million"
    },

    {
      regex:
        /(?:₹|rs\.?|inr|indian rupees?)[^\n]{0,40}\blakhs?\b/i,

      unit:
        "INR lakh"
    },

    {
      regex:
        /(?:₹|rs\.?|inr|indian rupees?)[^\n]{0,40}\bbillions?\b/i,

      unit:
        "INR billion"
    },

    {
      regex:
        /\bamounts?\s+in\s+crores?\b/i,

      unit:
        "INR crore"
    },

    {
      regex:
        /\bamounts?\s+in\s+millions?\b/i,

      unit:
        "INR million"
    },

    {
      regex:
        /\bamounts?\s+in\s+lakhs?\b/i,

      unit:
        "INR lakh"
    }

  ];


  for (
    const item
    of patterns
  ) {

    if (
      item.regex.test(sample)
    ) {

      return item.unit;

    }

  }


  return null;

}


/* ============================================================
   UNIT CONVERSION
   ============================================================ */

function monetaryCroreFactor(
  sourceUnit
) {

  const unit =
    String(
      sourceUnit || ""
    )
      .toLowerCase();


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
   LINE VALUE EXTRACTION
   ============================================================ */

function extractLineValues(
  section,
  labels
) {

  if (!section) {

    return null;

  }


  const lines =
    section
      .split("\n")
      .map(
        line =>
          line.trim()
      )
      .filter(Boolean);


  for (
    const line
    of lines
  ) {

    const lower =
      line.toLowerCase();


    const matched =
      labels.some(
        label =>
          lower.includes(
            label.toLowerCase()
          )
      );


    if (!matched) {

      continue;

    }


    /*
     * Extract accounting-style numbers:
     *
     * 12,345
     * 12,345.50
     * (12,345)
     * -123
     */

    const matches =
      line.match(
        /\(?-?\d[\d,]*(?:\.\d+)?\)?/g
      );


    if (
      !matches ||
      !matches.length
    ) {

      continue;

    }


    const values =
      matches
        .map(
          finiteFinancialNumber
        )
        .filter(
          value =>
            value !== null
        );


    if (
      values.length
    ) {

      return {
        line,
        values
      };

    }

  }


  return null;

}


/* ============================================================
   VALUE FROM STATEMENT
   ============================================================ */

function firstFinancialValue(
  section,
  labels
) {

  const result =
    extractLineValues(
      section,
      labels
    );


  if (
    !result ||
    !result.values.length
  ) {

    return null;

  }


  /*
   * Financial statements frequently contain a note number
   * before the actual amount.
   *
   * Taking the LAST numeric value is generally safer than
   * taking the first number on the line.
   */

  return result.values[
    result.values.length - 1
  ];

}


/* ============================================================
   DETECT FINANCIAL YEARS
   ============================================================ */

function detectFinancialYears(
  text
) {

  const matches =
    [
      ...String(
        text || ""
      ).matchAll(
        /\b(?:20\d{2})\s*[-–]\s*(?:20)?(\d{2})\b/g
      )
    ];


  const years =
    new Set();


  for (
    const match
    of matches
  ) {

    const full =
      match[0]
        .replace(
          /–/g,
          "-"
        );


    years.add(
      full
    );

  }


  return [
    ...years
  ].slice(
    0,
    10
  );

}


/* ============================================================
   COMPANY NAME
   ============================================================ */

function detectCompanyName(
  text,
  info = {}
) {

  const metadataTitle =
    String(
      info?.Title ||
      info?.title ||
      ""
    ).trim();


  if (
    metadataTitle &&
    metadataTitle.length < 200
  ) {

    return metadataTitle;

  }


  const firstLines =
    String(
      text || ""
    )
      .split("\n")
      .map(
        line =>
          line.trim()
      )
      .filter(Boolean)
      .slice(
        0,
        80
      );


  const companyLine =
    firstLines.find(
      line =>
        /\b(limited|ltd\.?|corporation|industries|company)\b/i.test(
          line
        ) &&
        line.length <= 160
    );


  return companyLine ||
    "Unknown company";

}


/* ============================================================
   SHARES OUTSTANDING
   ============================================================ */

function extractSharesOutstanding(
  text
) {

  const section =
    findStatementSection(
      text,
      [
        "share capital",
        "equity share capital",
        "issued subscribed and paid",
        "issued, subscribed and paid"
      ],
      30000
    );


  if (!section) {

    return {
      value:
        null,

      unit:
        null
    };

  }


  const lines =
    section
      .split("\n")
      .map(
        line =>
          line.trim()
      )
      .filter(Boolean);


  for (
    const line
    of lines
  ) {

    if (
      !/\bshares?\b/i.test(
        line
      )
    ) {

      continue;

    }


    const matches =
      line.match(
        /\d[\d,]*(?:\.\d+)?/g
      );


    if (
      !matches ||
      !matches.length
    ) {

      continue;

    }


    const values =
      matches
        .map(
          finiteFinancialNumber
        )
        .filter(
          value =>
            value !== null &&
            value > 0
        );


    if (!values.length) {

      continue;

    }


    /*
     * Prefer a large absolute share count.
     */

    const candidate =
      Math.max(
        ...values
      );


    if (
      candidate >= 100000
    ) {

      return {

        value:
          candidate /
          10000000,

        unit:
          "crore shares"

      };

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
   LOCAL FINANCIAL EXTRACTION ENGINE
   ============================================================ */

function extractFinancialsLocally(
  pdfData
) {

  const text =
    normalizeReportText(
      pdfData.text
    );


  /*
   * Locate audited statement regions first.
   */

  const profitLoss =
    findStatementSection(
      text,
      [
        "consolidated statement of profit and loss",
        "consolidated statement of profit & loss",
        "consolidated profit and loss",
        "statement of consolidated income",
        "consolidated income statement",
        "statement of profit and loss"
      ]
    );


  const balanceSheet =
    findStatementSection(
      text,
      [
        "consolidated balance sheet",
        "consolidated statement of financial position",
        "balance sheet"
      ]
    );


  const cashFlow =
    findStatementSection(
      text,
      [
        "consolidated statement of cash flows",
        "consolidated cash flow statement",
        "statement of cash flows",
        "cash flow statement"
      ]
    );


  /*
   * Prefer the unit printed around the audited
   * profit-and-loss statement.
   */

  const sourceUnit =
    detectFinancialUnit(
      profitLoss
    )
    ||
    detectFinancialUnit(
      balanceSheet
    )
    ||
    detectFinancialUnit(
      cashFlow
    );


  const factor =
    monetaryCroreFactor(
      sourceUnit
    );


  function money(
    section,
    labels
  ) {

    const raw =
      firstFinancialValue(
        section,
        labels
      );


    if (
      raw === null ||
      factor === null
    ) {

      return null;

    }


    return raw *
      factor;

  }


  /* ----------------------------------------------------------
     PROFIT & LOSS
     ---------------------------------------------------------- */

  const revenue =
    money(
      profitLoss,
      [
        "revenue from operations",
        "revenue",
        "total income"
      ]
    );


  const operatingIncome =
    money(
      profitLoss,
      [
        "profit before finance costs",
        "operating profit",
        "profit from operations",
        "ebit"
      ]
    );


  const netIncome =
    money(
      profitLoss,
      [
        "profit for the year",
        "profit for the period",
        "net profit",
        "profit after tax"
      ]
    );


  const financeCost =
    money(
      profitLoss,
      [
        "finance costs",
        "finance cost",
        "interest expense"
      ]
    );


  /* ----------------------------------------------------------
     BALANCE SHEET
     ---------------------------------------------------------- */

  const totalAssets =
    money(
      balanceSheet,
      [
        "total assets"
      ]
    );


  const currentAssets =
    money(
      balanceSheet,
      [
        "total current assets",
        "current assets"
      ]
    );


  const currentLiabilities =
    money(
      balanceSheet,
      [
        "total current liabilities",
        "current liabilities"
      ]
    );


  const totalEquity =
    money(
      balanceSheet,
      [
        "total equity",
        "total shareholders' equity",
        "equity attributable"
      ]
    );


  const cash =
    money(
      balanceSheet,
      [
        "cash and cash equivalents",
        "cash & cash equivalents"
      ]
    );


  const inventory =
    money(
      balanceSheet,
      [
        "inventories",
        "inventory"
      ]
    );


  const accountsReceivable =
    money(
      balanceSheet,
      [
        "trade receivables",
        "accounts receivable"
      ]
    );


  const accountsPayable =
    money(
      balanceSheet,
      [
        "trade payables",
        "accounts payable"
      ]
    );


  /*
   * Borrowings may appear in several lines.
   *
   * This simple deterministic extractor uses the first
   * clearly labelled total-borrowings/debt line.
   */

  const totalDebt =
    money(
      balanceSheet,
      [
        "total borrowings",
        "total debt",
        "borrowings"
      ]
    );


  /* ----------------------------------------------------------
     CASH FLOW
     ---------------------------------------------------------- */

  const operatingCashFlow =
    money(
      cashFlow,
      [
        "net cash generated from operating activities",
        "net cash from operating activities",
        "cash generated from operating activities",
        "net cash flows from operating activities"
      ]
    );


  const capex =
    money(
      cashFlow,
      [
        "purchase of property, plant and equipment",
        "purchase of property plant and equipment",
        "purchase of fixed assets",
        "capital expenditure"
      ]
    );


  /* ----------------------------------------------------------
     SHARES
     ---------------------------------------------------------- */

  const shares =
    extractSharesOutstanding(
      text
    );


  /* ----------------------------------------------------------
     FINANCIAL YEAR
     ---------------------------------------------------------- */

  const years =
    detectFinancialYears(
      [
        profitLoss,
        balanceSheet,
        cashFlow
      ].join("\n")
    );


  let year =
    null;


  const yearNumbers =
    [
      ...[
        profitLoss,
        balanceSheet,
        cashFlow
      ]
        .join("\n")
        .matchAll(
          /\b20\d{2}\b/g
        )
    ]
      .map(
        match =>
          Number(
            match[0]
          )
      )
      .filter(
        value =>
          value >= 2000 &&
          value <= 2200
      );


  if (
    yearNumbers.length
  ) {

    year =
      Math.max(
        ...yearNumbers
      );

  }


  const financialYear =
    year
      ? `FY${year - 1}-${String(year).slice(-2)}`
      : years[0] || null;


  /* ----------------------------------------------------------
     COMPANY
     ---------------------------------------------------------- */

  const companyName =
    detectCompanyName(
      text,
      pdfData.info
    );


  /* ----------------------------------------------------------
     STATEMENT BASIS
     ---------------------------------------------------------- */

  const hasConsolidated =
    /\bconsolidated\b/i.test(
      [
        profitLoss,
        balanceSheet,
        cashFlow
      ].join("\n")
    );


  const statementBasis =
    hasConsolidated
      ? "Consolidated"
      : "Standalone/Unconfirmed";


  /* ----------------------------------------------------------
     EBITDA
     ---------------------------------------------------------- */

  let ebitda =
    money(
      profitLoss,
      [
        "ebitda",
        "earnings before interest tax depreciation"
      ]
    );


  /*
   * Do not fabricate EBITDA if it cannot be
   * reliably established.
   */

  if (
    ebitda === null
  ) {

    ebitda =
      null;

  }


  /* ----------------------------------------------------------
     EXTRACTION NOTES
     ---------------------------------------------------------- */

  const notes =
    [];


  if (!sourceUnit) {

    notes.push(
      "The monetary statement unit could not be established reliably; monetary values were withheld."
    );

  }


  if (!profitLoss) {

    notes.push(
      "A profit-and-loss statement section could not be located automatically."
    );

  }


  if (!balanceSheet) {

    notes.push(
      "A balance-sheet section could not be located automatically."
    );

  }


  if (!cashFlow) {

    notes.push(
      "A cash-flow statement section could not be located automatically."
    );

  }


  if (ebitda === null) {

    notes.push(
      "EBITDA was not explicitly identified and was not fabricated."
    );

  }


  if (
    shares.value === null
  ) {

    notes.push(
      "Period-end shares outstanding could not be established reliably."
    );

  }


  const row = {

    company:
      companyName,

    financial_year:
      financialYear,

    year,

    statement_basis:
      statementBasis,

    source_unit:
      "INR crore",

    original_source_unit:
      sourceUnit,

    revenue,

    ebitda,

    cogs:
      null,

    operating_income:
      operatingIncome,

    net_income:
      netIncome,

    total_assets:
      totalAssets,

    current_assets:
      currentAssets,

    current_liabilities:
      currentLiabilities,

    total_debt:
      totalDebt,

    cash,

    total_equity:
      totalEquity,

    operating_cash_flow:
      operatingCashFlow,

    capex,

    inventory,

    accounts_receivable:
      accountsReceivable,

    accounts_payable:
      accountsPayable,

    finance_cost:
      financeCost,

    shares_outstanding:
      shares.value,

    shares_outstanding_unit:
      shares.unit,

    source_pages:
      [],

    extraction_notes:
      notes.join(" ")

  };


  /*
   * Require at least one core financial value.
   */

  const meaningfulFields = [

    revenue,
    operatingIncome,
    netIncome,
    totalAssets,
    totalEquity,
    operatingCashFlow

  ];


  const hasFinancialData =
    meaningfulFields.some(
      value =>
        value !== null &&
        Number.isFinite(value)
    );


  if (!hasFinancialData) {

    throw new Error(
      "The PDF text was extracted successfully, but FinSight could not reliably locate the audited financial-statement values."
    );

  }


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

        profitLoss &&
        balanceSheet &&
        cashFlow &&
        sourceUnit

          ? "High"

          : "Medium"

    },


    financials: [
      row
    ],


    validation: {

      consolidated_preferred:
        true,

      years_found:
        financialYear
          ? [financialYear]
          : [],

      missing_critical_fields:

        [
          ["revenue", revenue],
          ["operating_income", operatingIncome],
          ["net_income", netIncome],
          ["total_assets", totalAssets],
          ["total_equity", totalEquity],
          ["operating_cash_flow", operatingCashFlow],
          ["shares_outstanding", shares.value]
        ]

          .filter(
            ([, value]) =>
              value === null
          )

          .map(
            ([name]) =>
              name
          ),


      warnings:
        notes

    }

  };

}



/* ============================================================
   14. FINANCIAL EXTRACTION — LOCAL ONLY
   ============================================================ */

/*
 * THIS ROUTE DOES NOT CALL GEMINI.
 *
 * THIS ROUTE DOES NOT CALL OPENAI.
 *
 * Flow:
 *
 * PDF
 * ↓
 * pdf-parse
 * ↓
 * local text
 * ↓
 * deterministic financial extraction
 * ↓
 * dashboard JSON
 */


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

            ok:
              false,

            error:
              "Upload an annual-report PDF.",

            code:
              "REPORT_REQUIRED"

          });

      }


      if (
        req.file.mimetype &&
        req.file.mimetype !==
          "application/pdf"
      ) {

        return res
          .status(400)
          .json({

            ok:
              false,

            error:
              "FinSight requires an annual-report PDF.",

            code:
              "INVALID_REPORT"

          });

      }


      /* ------------------------------------------------------
         LOCAL PDF PARSING
         ------------------------------------------------------ */

      const pdfData =
        await extractPdfTextLocally(
          req.file
        );


      /* ------------------------------------------------------
         LOCAL FINANCIAL EXTRACTION
         ------------------------------------------------------ */

      const result =
        extractFinancialsLocally(
          pdfData
        );


      /* ------------------------------------------------------
         SAVE REPORT
         ------------------------------------------------------ */

      let persisted =
        null;


      if (pool) {

        try {

          const companyRow =
            await upsertCompany({

              name:
                result.company.legal_name ||
                result.company.name ||
                "Unknown company",

              ticker:
                null,

              exchange:
                null,

              listingStatus:
                "unknown",

              isin:
                null

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


          const latestYear =
            result.financials
              .map(
                row =>
                  Number(
                    row.year
                  )
              )
              .filter(
                Number.isFinite
              )
              .sort(
                (a, b) =>
                  b - a
              )[0]
            || null;


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
                  financials:
                    result.financials,

                  validation:
                    result.validation
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
              inserted.rows[0].created_at

          };

        }

        catch (databaseError) {

          console.error(
            "Could not save locally extracted report:",
            databaseError
          );


          result.validation.warnings.push(
            "Financial extraction succeeded, but the result could not be saved to research memory."
          );

        }

      }


      console.log(
        "Local financial extraction successful:",
        result.company.name
      );


      return res.json({

        ok:
          true,

        ...result,

        persisted,

        provider:
          "local",

        model:
          "pdf-parse + deterministic FinSight extractor",

        pdf: {

          pages:
            pdfData.pages,

          extractedCharacters:
            pdfData.text.length

        }

      });

    }

    catch (error) {

      console.error(
        "Local financial extraction error:",
        error
      );


      let status =
        Number(
          error?.status
        );


      if (
        !Number.isInteger(status) ||
        status < 400 ||
        status > 599
      ) {

        status =
          500;

      }


      return res
        .status(status)
        .json({

          ok:
            false,

          error:
            error?.message ||
            "FinSight could not extract the annual report locally.",

          code:

            status === 413

              ? "REPORT_TOO_LARGE"

              : status === 400

                ? "INVALID_REPORT"

                : "LOCAL_EXTRACTION_FAILED"

        });

    }

  }
);



/* ============================================================
   15. ANNUAL REPORT AI
   ============================================================ */

/*
 * Financial extraction is already local.
 *
 * This route:
 *
 * PDF
 * ↓
 * local pdf-parse
 * ↓
 * extracted TEXT
 * ↓
 * Gemini
 *
 * The PDF itself is NEVER sent to Gemini.
 */


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


      /* ------------------------------------------------------
         EXTRACT LOCALLY
         ------------------------------------------------------ */

      const pdfData =
        await extractPdfTextLocally(
          req.file
        );


      const metrics =
        safeJSON(
          req.body.metrics
        );


      /*
       * Gemini has a large context window, but sending an
       * unnecessarily enormous annual report increases latency.
       *
       * Keep a generous evidence window.
       */

      const MAX_REPORT_TEXT =
        900000;


      const reportText =
        pdfData.text.length >
          MAX_REPORT_TEXT

          ? pdfData.text.slice(
              0,
              MAX_REPORT_TEXT
            )

          : pdfData.text;


      const prompt = `

Analyze the following annual-report evidence as an
evidence-first long-term investor.

IMPORTANT:

The text below was extracted locally from the uploaded
annual-report PDF.

Use ONLY the supplied annual-report evidence and structured
FinSight financial context.

Never invent missing information.

============================================================
STRUCTURED FINANCIAL CONTEXT
============================================================

${JSON.stringify(
  metrics || {},
  null,
  2
)}

============================================================
ANNUAL REPORT TEXT
============================================================

${reportText}

============================================================
ANALYSIS
============================================================

Analyze:

BUSINESS

- business model
- revenue drivers
- products and services
- operating segments
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

- capital expenditure
- acquisitions
- disposals
- dividends
- debt
- investments

GOVERNANCE

- board observations
- related-party transactions
- promoter or parent relationships
- material governance issues

AUDITOR

- audit opinion
- qualifications
- key audit matters
- internal controls

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
OUTPUT
============================================================

Return valid JSON only:

{
  "company": "",

  "report_type": "single",

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

  "management_promise_tracker": [],

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


      /* ------------------------------------------------------
         GEMINI RECEIVES TEXT ONLY
         ------------------------------------------------------ */

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


      if (!analysis) {

        throw new Error(
          "Gemini returned an unreadable annual-report analysis."
        );

      }


      return res.json({

        analysis,

        model:
          GEMINI_MODEL,

        provider:
          "gemini",

        pdfProcessing:
          "local"

      });

    }

    catch (error) {

      console.error(
        "Annual Report AI:",
        error
      );


      const status =
        Number.isInteger(
          error?.status
        )
          ? error.status
          : 500;


      return res
        .status(status)
        .json({

          error:
            error?.message ||
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


      const aiMetadata = {};

      const text =
        await aiGenerate(
          [
            {
              text:
                prompt
            }
          ],
          {
            json:
              true,
            metadata: aiMetadata
          }
        );


      const answer =
        safeJSON(text);


      if (!answer) {

        throw new Error(
          "The AI provider returned an unreadable answer."
        );

      }


      return res.json({

        answer,

        model: aiMetadata.model,

        provider: aiMetadata.provider

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
        .status(aiErrorHttpStatus(error))
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


      const aiMetadata = {};

      const resultText = await aiGenerateWithPdf(report, prompt, {
        json: true,
        metadata: aiMetadata
      });


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
          "The AI provider returned unusable structured comparison data."
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

        model: aiMetadata.model,

        provider: aiMetadata.provider

      });

    }

    catch (
      error
    ) {

      console.error(
        "Prepare comparison report:",
        error
      );


      const status = aiErrorHttpStatus(error);


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
       * Only text/JSON goes to the AI provider router here.
       * No PDF is included.
       */

      const aiMetadata = {};

      const comparisonText =
        await aiGenerate(
          [
            {
              text:
                prompt
            }
          ],
          {
            json:
              true,
            metadata: aiMetadata
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
          "The AI provider returned an unusable company comparison."
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

        model: aiMetadata.model,

        provider: aiMetadata.provider

      });

    }

    catch (
      error
    ) {

      console.error(
        "Lightweight comparison failed:",
        error
      );


      const status = aiErrorHttpStatus(error);


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
   ONE API REQUEST PER BUTTON PRESS
   ============================================================ */

app.get(
  "/api/market/:identifier",

  async (req, res) => {

    try {

      if (!ALPHA_VANTAGE_API_KEY) {

        return res
          .status(503)
          .json({
            ok: false,
            error:
              "Alpha Vantage API key is not configured."
          });

      }


      const identifier =
        String(
          req.params.identifier || ""
        )
          .trim()
          .toUpperCase();


      const ticker =
        String(
          req.query.ticker || ""
        )
          .trim()
          .toUpperCase();


      const nseCode =
        String(
          req.query.nseCode || ""
        )
          .trim()
          .toUpperCase();


      const bseCode =
        String(
          req.query.bseCode || ""
        )
          .trim()
          .toUpperCase();


      const exchange =
        String(
          req.query.exchange || ""
        )
          .trim()
          .toUpperCase();


      const companyName =
        String(
          req.query.company || ""
        ).trim();


      /*
       * ------------------------------------------------------
       * RESOLVE ONE SYMBOL
       * ------------------------------------------------------
       *
       * IMPORTANT:
       *
       * We deliberately make ONE Alpha Vantage request.
       *
       * No SYMBOL_SEARCH.
       * No retry with several symbols.
       * No automatic second API request.
       */


      let symbol =
        null;


      let identifierSource =
        null;


      /*
       * BSE security code is preferred because
       * Alpha Vantage supports global exchange
       * suffix notation.
       */

      if (bseCode) {

        symbol =
          bseCode.endsWith(".BSE")

            ? bseCode

            : `${bseCode}.BSE`;


        identifierSource =
          "BSE security code";

      }


      /*
       * Otherwise use the verified ticker.
       */

      else if (ticker) {

        if (
          exchange === "BSE" &&
          !ticker.endsWith(".BSE")
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


      /*
       * NSE code fallback.
       *
       * We do NOT invent an exchange suffix here.
       */

      else if (nseCode) {

        symbol =
          nseCode;


        identifierSource =
          "NSE code";

      }


      /*
       * Final fallback is the route identifier
       * already supplied by the frontend.
       */

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
            ok: false,
            error:
              "No verified market identifier is available."
          });

      }


      console.log(
        "Alpha Vantage quote request:",
        {
          company:
            companyName,

          symbol,

          identifierSource
        }
      );


      /*
       * ------------------------------------------------------
       * EXACTLY ONE ALPHA VANTAGE REQUEST
       * ------------------------------------------------------
       */

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
          url
        );


      const data =
        await response.json();


      /*
       * Alpha Vantage often returns HTTP 200
       * even when its own API limit is reached.
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
            ok: false,

            error:
              providerMessage,

            provider:
              "Alpha Vantage",

            symbol,

            identifierSource
          });

      }


      if (
        data["Error Message"]
      ) {

        return res
          .status(404)
          .json({
            ok: false,

            error:
              data["Error Message"],

            provider:
              "Alpha Vantage",

            symbol,

            identifierSource
          });

      }


      const quote =
        data["Global Quote"] ||
        {};


      const price =
        Number(
          quote["05. price"]
        );


      if (
        !Number.isFinite(price) ||
        price <= 0
      ) {

        return res
          .status(404)
          .json({
            ok: false,

            error:
              `Alpha Vantage returned no usable price for ${symbol}.`,

            provider:
              "Alpha Vantage",

            symbol,

            identifierSource
          });

      }


      function numberValue(key) {

        const value =
          Number(
            quote[key]
          );


        return Number.isFinite(value)

          ? value

          : null;

      }


      /*
       * Currency inference.
       */

      let currency =
        null;


      if (
        exchange === "NSE" ||
        exchange === "BSE" ||
        symbol.endsWith(".BSE")
      ) {

        currency =
          "INR";

      }


      else if (
        [
          "NASDAQ",
          "NYSE",
          "AMEX"
        ].includes(exchange)
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
          ticker || null,

        nseCode:
          nseCode || null,

        bseCode:
          bseCode || null,

        companyName:
          companyName || null,

        exchange:
          exchange || null,

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
          ] || null,

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
          ] || null,

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
          ok: false,

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

STRICT GROUNDING RULES:

- Treat FINANCIAL HISTORY and VALUATION METRICS as authoritative structured inputs.
- Do not recalculate a supplied metric and do not substitute a different definition.
- A reported fact must come directly from FINANCIAL HISTORY or ANNUAL REPORT ANALYSIS.
- A calculated metric must come directly from VALUATION METRICS.
- Never call earnings quality strong merely because margins or earnings growth are strong.
  Earnings quality must be assessed primarily from cash conversion, operating cash flow,
  free cash flow and working-capital evidence.
- If operating cash flow or free cash flow is weak relative to profit, explicitly describe
  earnings cash conversion as weak/mixed even when accounting profit is growing.
- Do not describe a manual share price as a verified/live market quote.
- Do not infer sector norms, cyclicality, project pipelines or industry facts unless they
  are present in the supplied annual-report analysis.
- Preserve the distinction between reported EBITDA and adjusted/non-GAAP EBITDA.
- If a metric is unavailable, say it is unavailable rather than estimating it.

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


      const aiMetadata = {};

      const text =
        await aiGenerate(
          [
            {
              text:
                prompt
            }
          ],
          {
            json:
              true,
            metadata: aiMetadata
          }
        );


      const assessment =
        safeJSON(text);


      if (!assessment) {

        throw new Error(
          "The AI provider returned an unreadable valuation assessment."
        );

      }


      return res.json({

        assessment,

        model: aiMetadata.model,

        provider: aiMetadata.provider

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
        .status(aiErrorHttpStatus(error))
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


      console.log(`OpenAI fallback: ${!OPENAI_FALLBACK_ENABLED ? "DISABLED" : openai ? "READY" : "NOT CONFIGURED"}`);
      console.log(`OpenAI model: ${OPENAI_MODEL}`);
      console.log(OPENAI_FALLBACK_ENABLED
        ? "AI flow: Gemini primary once -> Gemini fallback once -> OpenAI once (text + PDF)"
        : "AI flow: Gemini primary once -> Gemini fallback once (OpenAI disabled)");
      console.log(`Gemini generation timeouts: text ${GEMINI_TEXT_TIMEOUT_MS}ms; PDF ${GEMINI_PDF_TIMEOUT_MS}ms per model`);

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
