/* ============================================================
   FINSIGHT AI — SERVER
   Report-first investor research backend

   ARCHITECTURE
   - PDF financial extraction: LOCAL ONLY
   - PDF text extraction: pdf-parse
   - Financial extraction: deterministic local functions
   - Gemini: qualitative analysis / Ask FinSight / comparison
   - OpenAI: REMOVED
   - Alpha Vantage: market data
   - DCF / Reverse DCF
   - PostgreSQL / Supabase research memory
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


/*
 * Optional second Gemini model.
 *
 * Leave blank if you want only one Gemini model.
 */

const GEMINI_FALLBACK_MODEL =
  String(
    process.env.GEMINI_FALLBACK_MODEL ||
    ""
  ).trim();


const GEMINI_TEXT_TIMEOUT_MS =
  (() => {

    const value =
      Number(
        process.env.GEMINI_TEXT_TIMEOUT_MS
      );


    if (
      Number.isFinite(value) &&
      value >= 15000 &&
      value <= 300000
    ) {

      return value;

    }


    return 60000;

  })();


const ALPHA_VANTAGE_API_KEY =
  process.env.ALPHA_VANTAGE_API_KEY ||
  "";


const FINSIGHT_USERNAME =
  process.env.FINSIGHT_USERNAME ||
  "";


const FINSIGHT_PASSWORD =
  process.env.FINSIGHT_PASSWORD ||
  "";


/*
 * Maximum PDF accepted by FinSight.
 *
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
            process.env.DATABASE_POOL_MAX ||
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


  console.log(
    "FinSight database ready."
  );

}


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
        FINSIGHT_MAX_PDF_SIZE

    },

    fileFilter: (
      req,
      file,
      callback
    ) => {

      const mime =
        String(
          file?.mimetype || ""
        )
          .toLowerCase()
          .trim();


      if (
        mime &&
        mime !== "application/pdf"
      ) {

        const error =
          new Error(
            "FinSight accepts PDF annual reports only."
          );


        error.status =
          400;


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

      /*
       * Financial extraction does NOT depend
       * on this value.
       */

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

      aiPurpose:
        "qualitative analysis only",

      financialExtractionProvider:
        "local",

      financialExtractionEngine:
        "pdf-parse + deterministic FinSight extractor",

      financialExtractionRequiresAI:
        false,

      maxPdfSizeMB:
        45,

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
        "local"

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

    /*
     * Gemini occasionally wraps JSON in
     * ```json ... ```
     */

    try {

      const cleaned =
        String(value)
          .trim()
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

}


/* ============================================================
   12. GEMINI — TEXT ONLY
   ============================================================ */

/*
 * IMPORTANT
 *
 * Gemini does NOT receive the annual-report PDF for
 * financial extraction.
 *
 * Local extraction:
 *
 * PDF
 *  ↓
 * pdf-parse
 *  ↓
 * deterministic extraction
 *
 *
 * Gemini is retained only for:
 *
 * - qualitative annual-report analysis
 * - Ask FinSight
 * - company comparison interpretation
 * - valuation interpretation
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

  if (
    !GEMINI_API_KEY
  ) {

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
   * SECURITY / ARCHITECTURE:
   *
   * Only text is allowed here.
   *
   * No inlineData.
   * No fileData.
   * No PDF.
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

      /*
       * AbortSignal.timeout() can produce an
       * exception without HTTP status.
       */

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
    GEMINI_MODEL;


  try {

    payload =
      await requestModel(
        GEMINI_MODEL
      );

  }

  catch (primaryError) {

    /*
     * Only use another Gemini model when:
     *
     * - fallback is configured
     * - fallback differs from primary
     * - failure is temporary
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

      `Gemini primary ${GEMINI_MODEL} unavailable. ` +

      `Trying ${GEMINI_FALLBACK_MODEL}.`

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
   13. LOCAL PDF EXTRACTION — STRICT / DETERMINISTIC
   ============================================================ */

/*
 * PURPOSE
 * -------
 * Annual-report financial extraction without Gemini/OpenAI.
 *
 * PDF
 *   -> pdf-parse
 *   -> normalized text
 *   -> locate audited financial statements
 *   -> detect statement years
 *   -> extract rows
 *   -> validate values
 *   -> normalize monetary values to INR crore
 *   -> return dashboard-compatible financial history
 *
 * SAFETY RULES
 * ------------
 * 1. Never invent a missing value.
 * 2. Never convert null into zero.
 * 3. Never use a note number as a financial amount.
 * 4. Prefer consolidated statements.
 * 5. Do not mix standalone and consolidated statement blocks.
 * 6. Calculations are performed only when required inputs exist.
 * 7. Implausible/ambiguous extraction is rejected as null.
 */


/* ============================================================
   13A. LOCAL PDF TEXT EXTRACTION
   ============================================================ */

async function extractPdfTextLocally(file) {

  if (
    !file ||
    !Buffer.isBuffer(file.buffer) ||
    file.buffer.length === 0
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

    error.status = 400;

    throw error;
  }


  let text =
    String(
      parsed?.text || ""
    );


  text =
    text
      .replace(/\u0000/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/[‐-‒–—]/g, "-")
      .replace(/\n{4,}/g, "\n\n\n")
      .trim();


  if (
    text.length <
    500
  ) {

    const error =
      new Error(
        "Very little text could be extracted from the PDF. It may be scanned or image-based."
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
      ) || null,

    info:
      parsed?.info || {}

  };
}


/* ============================================================
   13B. GENERAL HELPERS
   ============================================================ */

function normalizeReportText(value) {

  return String(
    value || ""
  )
    .replace(/\u0000/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[‐-‒–—]/g, "-")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}


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


  /*
   * Accounting dash.
   */

  if (
    text === "-" ||
    text === "–" ||
    text === "—"
  ) {

    return 0;
  }


  /*
   * Remove footnote markers around a number.
   */

  text =
    text
      .replace(/^[*#]+/, "")
      .replace(/[*#]+$/, "")
      .trim();


  let negative =
    false;


  /*
   * Accounting negative:
   *
   * (1,234)
   */

  if (
    /^\([^()]+\)$/.test(text)
  ) {

    negative = true;

    text =
      text.slice(
        1,
        -1
      ).trim();
  }


  text =
    text
      .replace(/₹/g, "")
      .replace(/\bINR\b/gi, "")
      .replace(/\bRs\.?\b/gi, "")
      .replace(/,/g, "")
      .trim();


  if (
    !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(
      text
    )
  ) {

    return null;
  }


  const number =
    Number(text);


  if (
    !Number.isFinite(number)
  ) {

    return null;
  }


  if (
    negative
  ) {

    return -Math.abs(number);
  }


  return number;
}


function roundFinancial(value) {

  if (
    value === null ||
    !Number.isFinite(value)
  ) {

    return null;
  }


  return Math.round(
    value * 100
  ) / 100;
}


/* ============================================================
   13C. ACCOUNTING NUMBER TOKENIZER
   ============================================================ */

/*
 * Handles:
 *
 * 123
 * 1,234
 * 1,234.50
 * (1,234)
 * -1,234
 *
 * It deliberately does NOT treat arbitrary punctuation
 * as a financial number.
 */

function extractAccountingNumberTokens(line) {

  const source =
    String(
      line || ""
    );


  const regex =
    /\(?-?\d{1,3}(?:,\d{2,3})*(?:\.\d+)?\)?|\(?-?\d+(?:\.\d+)?\)?/g;


  const matches =
    source.match(regex) || [];


  return matches
    .map(raw => ({

      raw,

      value:
        finiteFinancialNumber(raw)

    }))
    .filter(
      item =>
        item.value !== null
    );
}


function extractAccountingNumbers(line) {

  return extractAccountingNumberTokens(
    line
  ).map(
    item =>
      item.value
  );
}


/* ============================================================
   13D. YEAR DETECTION
   ============================================================ */

function normalizeYear(value) {

  const year =
    Number(value);


  if (
    !Number.isInteger(year) ||
    year < 2000 ||
    year > 2200
  ) {

    return null;
  }


  return year;
}


function detectYearsFromText(text) {

  const source =
    String(
      text || ""
    );


  const counts =
    new Map();


  const matches =
    source.matchAll(
      /\b(20\d{2})\b/g
    );


  for (
    const match
    of matches
  ) {

    const year =
      normalizeYear(
        match[1]
      );


    if (!year) {
      continue;
    }


    counts.set(
      year,
      (counts.get(year) || 0) + 1
    );
  }


  return [
    ...counts.entries()
  ]
    .sort(
      (a, b) => {

        if (
          b[1] !== a[1]
        ) {

          return b[1] - a[1];
        }


        return b[0] - a[0];
      }
    )
    .map(
      entry =>
        entry[0]
    );
}

function detectStatementYears(section) {

  if (!section) {
    return [];
  }

  /*
   * Only inspect the beginning of the actual statement.
   * Statement column years should occur very close to
   * the statement heading.
   *
   * Do NOT scan 15,000 characters because that reaches
   * notes, accounting standards and unrelated historical
   * dates such as 2013 / 2019.
   */

  const header =
    String(section)
      .slice(0, 5000);

  const currentYear =
    new Date().getFullYear();

  const candidates =
    new Map();

  const matches =
    header.matchAll(
      /\b(20\d{2})\b/g
    );

  for (const match of matches) {

    const year =
      Number(match[1]);

    if (
      !Number.isInteger(year) ||
      year < 2000 ||
      year > currentYear + 2
    ) {
      continue;
    }

    /*
     * Earlier occurrences are much more likely to be
     * actual statement-column headers.
     */

    const position =
      match.index || 0;

    const positionScore =
      Math.max(
        0,
        5000 - position
      );

    const existing =
      candidates.get(year) || {
        count: 0,
        score: 0
      };

    existing.count += 1;
    existing.score += positionScore;

    candidates.set(
      year,
      existing
    );
  }


  const ranked =
    [...candidates.entries()]
      .sort((a, b) => {

        /*
         * Prefer repeated years and years appearing
         * nearest the statement heading.
         */

        const scoreA =
          a[1].count * 10000 +
          a[1].score;

        const scoreB =
          b[1].count * 10000 +
          b[1].score;

        if (scoreB !== scoreA) {
          return scoreB - scoreA;
        }

        return b[0] - a[0];
      })
      .map(entry => entry[0]);


  if (!ranked.length) {
    return [];
  }


  /*
   * Financial statements normally contain current year
   * and previous year.
   *
   * Once the latest year is established, ONLY accept
   * consecutive comparative years.
   *
   * This prevents:
   *
   * 2026, 2025, 2019, 2013
   *
   * becoming four financial columns.
   */

  const latest =
    Math.max(...ranked);

  const result = [];

  if (
    candidates.has(latest)
  ) {
    result.push(latest);
  }

  if (
    candidates.has(latest - 1)
  ) {
    result.push(latest - 1);
  }


  /*
   * In unusual cases only one year may be detected.
   */

  if (!result.length) {
    result.push(latest);
  }


  return result;
}



function financialYearLabel(year) {

  if (
    !Number.isInteger(year)
  ) {

    return null;
  }


  return `FY${year - 1}-${String(year).slice(-2)}`;
}


/* ============================================================
   13E. COMPANY NAME
   ============================================================ */

function cleanCompanyCandidate(value) {

  return String(
    value || ""
  )
    .replace(/\s+/g, " ")
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
      info?.Title ||
      info?.title ||
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

    /*
     * Only trust metadata if it looks company-like.
     */

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
      text || ""
    )
      .split("\n")
      .map(
        line =>
          cleanCompanyCandidate(line)
      )
      .filter(Boolean)
      .slice(0, 300);


  const companyPatterns = [

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
      of companyPatterns
    ) {

      const match =
        line.match(pattern);


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
   13F. STATEMENT HEADING DEFINITIONS
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
   13G. STATEMENT CANDIDATE SEARCH
   ============================================================ */

function findAllHeadingPositions(
  text,
  headings
) {

  const source =
    String(
      text || ""
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
      heading.toLowerCase();


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
        index === -1
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
    (a, b) =>
      a.index - b.index
  );
}


/* ============================================================
   13H. SCORE STATEMENT CANDIDATE
   ============================================================ */

function scoreStatementCandidate(
  text,
  candidate,
  type
) {

  const window =
    text.slice(
      candidate.index,
      candidate.index + 45000
    );


  const lower =
    window.toLowerCase();


  let score =
    0;


  /*
   * Strongly prefer consolidated.
   */

  if (
    candidate.heading
      .toLowerCase()
      .includes("consolidated")
  ) {

    score += 15;
  }


  if (
    /\bconsolidated\b/i.test(
      window.slice(0, 1000)
    )
  ) {

    score += 8;
  }


  /*
   * Reject obvious table-of-contents entries.
   */

  const first500 =
    window.slice(
      0,
      500
    );


  if (
    /table of contents|contents/i.test(
      first500
    )
  ) {

    score -= 20;
  }


  /*
   * Actual statements contain lots of amounts.
   */

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


  /*
   * Actual statements normally contain years.
   */

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


  /*
   * Statement-specific evidence.
   */

  if (
    type === "profit"
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
    type === "balance"
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
    type === "cash"
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
   * Early report references are often contents.
   */

  const documentFraction =
    candidate.index /
    Math.max(
      text.length,
      1
    );


  if (
    documentFraction <
    0.05
  ) {

    score -= 8;
  }


  return score;
}


/* ============================================================
   13I. FIND BEST STATEMENT
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
      score > best.score
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
        best.index + maxLength
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
   13J. FINANCIAL UNIT DETECTION
   ============================================================ */

function detectFinancialUnitCandidates(
  text
) {

  const source =
    String(
      text || ""
    );


  const candidates =
    [];


  const patterns = [

    {
      unit:
        "INR crore",

      regexes: [

        /\b(?:₹|rs\.?|inr)\s*(?:in\s*)?crores?\b/gi,

        /\bamounts?\s+(?:are\s+)?(?:in\s+)?(?:₹|rs\.?|inr)?\s*crores?\b/gi,

        /\bfigures?\s+(?:are\s+)?(?:in\s+)?(?:₹|rs\.?|inr)?\s*crores?\b/gi,

        /\b₹\s*crores?\b/gi,

        /\brs\.?\s+crores?\b/gi

      ]
    },


    {
      unit:
        "INR million",

      regexes: [

        /\b(?:₹|rs\.?|inr)\s*(?:in\s*)?millions?\b/gi,

        /\bamounts?\s+(?:are\s+)?(?:in\s+)?(?:₹|rs\.?|inr)?\s*millions?\b/gi,

        /\bfigures?\s+(?:are\s+)?(?:in\s+)?(?:₹|rs\.?|inr)?\s*millions?\b/gi,

        /\bindian rupees?\s+in\s+millions?\b/gi

      ]
    },


    {
      unit:
        "INR lakh",

      regexes: [

        /\b(?:₹|rs\.?|inr)\s*(?:in\s*)?lakhs?\b/gi,

        /\bamounts?\s+(?:are\s+)?(?:in\s+)?(?:₹|rs\.?|inr)?\s*lakhs?\b/gi,

        /\bfigures?\s+(?:are\s+)?(?:in\s+)?(?:₹|rs\.?|inr)?\s*lakhs?\b/gi

      ]
    },


    {
      unit:
        "INR billion",

      regexes: [

        /\b(?:₹|rs\.?|inr)\s*(?:in\s*)?billions?\b/gi,

        /\bamounts?\s+(?:are\s+)?(?:in\s+)?(?:₹|rs\.?|inr)?\s*billions?\b/gi,

        /\bfigures?\s+(?:are\s+)?(?:in\s+)?(?:₹|rs\.?|inr)?\s*billions?\b/gi

      ]
    }

  ];


  for (
    const definition
    of patterns
  ) {

    for (
      const regex
      of definition.regexes
    ) {

      regex.lastIndex = 0;


      let match;


      while (
        (
          match =
            regex.exec(source)
        )
      ) {

        candidates.push({

          unit:
            definition.unit,

          index:
            match.index,

          text:
            match[0]

        });


        if (
          regex.lastIndex ===
          match.index
        ) {

          regex.lastIndex++;
        }

      }

    }

  }


  return candidates.sort(
    (a, b) =>
      a.index - b.index
  );
}


function detectFinancialUnit(
  statementText,
  fallbackText = ""
) {

  function detect(source) {

    const text =
      String(source || "")
        .slice(0, 50000)
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .toLowerCase();


    /*
     * CRORE
     *
     * Handles examples such as:
     *
     * ₹ in crore
     * ₹ in crores
     * Rs. in crore
     * INR crore
     * amounts in crore
     * figures in crore
     * rupees in crore
     */

    if (
      /(?:₹|rs\.?|inr|rupees?|amounts?|figures?)[^.!?\n]{0,120}\bcrores?\b/i.test(
        text
      ) ||
      /\bcrores?\b[^.!?\n]{0,80}(?:₹|rs\.?|inr|rupees?)/i.test(
        text
      )
    ) {

      return "INR crore";
    }


    /*
     * MILLION
     */

    if (
      /(?:₹|rs\.?|inr|rupees?|amounts?|figures?)[^.!?\n]{0,120}\bmillions?\b/i.test(
        text
      ) ||
      /\bmillions?\b[^.!?\n]{0,80}(?:₹|rs\.?|inr|rupees?)/i.test(
        text
      )
    ) {

      return "INR million";
    }


    /*
     * LAKH
     */

    if (
      /(?:₹|rs\.?|inr|rupees?|amounts?|figures?)[^.!?\n]{0,120}\blakhs?\b/i.test(
        text
      ) ||
      /\blakhs?\b[^.!?\n]{0,80}(?:₹|rs\.?|inr|rupees?)/i.test(
        text
      )
    ) {

      return "INR lakh";
    }


    /*
     * BILLION
     */

    if (
      /(?:₹|rs\.?|inr|rupees?|amounts?|figures?)[^.!?\n]{0,120}\bbillions?\b/i.test(
        text
      ) ||
      /\bbillions?\b[^.!?\n]{0,80}(?:₹|rs\.?|inr|rupees?)/i.test(
        text
      )
    ) {

      return "INR billion";
    }


    return null;
  }


  /*
   * 1. Statement itself.
   */

  const statementUnit =
    detect(
      statementText
    );


  if (statementUnit) {

    return statementUnit;
  }


  /*
   * 2. Wider report fallback.
   *
   * IMPORTANT:
   * We do not blindly assume crore merely because the
   * report is Indian.
   */

  const reportUnit =
    detect(
      fallbackText
    );


  if (reportUnit) {

    return reportUnit;
  }


  return null;
}

function monetaryCroreFactor(
  sourceUnit
) {

  const unit =
    String(
      sourceUnit || ""
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
   13K. STATEMENT LINE NORMALIZATION
   ============================================================ */

function statementLines(
  section
) {

  return String(
    section || ""
  )
    .split("\n")
    .map(
      line =>
        line
          .replace(/\s+/g, " ")
          .trim()
    )
    .filter(Boolean);
}


/* ============================================================
   13L. LABEL MATCHING
   ============================================================ */

function normalizedLabelText(
  value
) {

  return String(
    value || ""
  )
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
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


      /*
       * Exact beginning or complete phrase is preferred.
       */

      return (
        normalized === target ||
        normalized.startsWith(
          `${target} `
        ) ||
        normalized.includes(
          ` ${target} `
        ) ||
        normalized.endsWith(
          ` ${target}`
        )
      );

    }
  );
}


/* ============================================================
   13M. FIND METRIC ROW
   ============================================================ */

function findMetricRow(
  section,
  labels,
  {
    exclude = [],
    searchLimit = 5000
  } = {}
) {

  const lines =
    statementLines(
      section
    )
      .slice(
        0,
        searchLimit
      );


  let best =
    null;


  for (
    let i = 0;
    i < lines.length;
    i++
  ) {

    const line =
      lines[i];


    if (
      !lineMatchesLabel(
        line,
        labels
      )
    ) {

      continue;
    }


    const normalized =
      normalizedLabelText(
        line
      );


    const excluded =
      exclude.some(
        phrase =>
          normalized.includes(
            normalizedLabelText(
              phrase
            )
          )
      );


    if (excluded) {

      continue;
    }


    /*
     * Some PDFs put amounts on following lines.
     *
     * Combine at most 3 lines. Going farther increases
     * the chance of stealing values from another metric.
     */

    const combined =
      [
        line,
        lines[i + 1] || "",
        lines[i + 2] || ""
      ].join(" ");


    const numbers =
      extractAccountingNumbers(
        combined
      );


    if (
      !numbers.length
    ) {

      continue;
    }


    /*
     * Prefer rows containing multiple financial values.
     */

    let score =
      1;


    if (
      numbers.length >= 2
    ) {

      score += 3;
    }


    if (
      numbers.length >= 3
    ) {

      score += 1;
    }


    /*
     * Prefer amount on same line.
     */

    if (
      extractAccountingNumbers(
        line
      ).length
    ) {

      score += 2;
    }


    /*
     * Prefer earlier statement rows over notes far below.
     */

    score -=
      i /
      Math.max(
        lines.length,
        1
      );


    if (
      !best ||
      score > best.score
    ) {

      best = {

        line,

        combined,

        numbers,

        lineIndex:
          i,

        score

      };
    }

  }


  return best;
}


/* ============================================================
   13N. REMOVE NOTE NUMBER
   ============================================================ */

/*
 * Typical statement:
 *
 * Revenue from operations    27    128,218    117,456
 *
 * 27 = note reference
 *
 * We must never interpret 27 as revenue.
 */

function stripLikelyNoteReference(
  values,
  expectedColumns
) {

  const result =
    [
      ...values
    ];


  if (
    result.length <=
    expectedColumns
  ) {

    return result;
  }


  /*
   * If exactly one extra value exists and the first is
   * a small integer, it is very likely a note number.
   */

  if (
    result.length ===
      expectedColumns + 1

    &&

    Number.isInteger(
      result[0]
    )

    &&

    result[0] >= 1

    &&

    result[0] <= 500
  ) {

    result.shift();

    return result;
  }


  /*
   * When there are many values, inspect first token.
   */

  if (
    result.length >
      expectedColumns

    &&

    Number.isInteger(
      result[0]
    )

    &&

    result[0] >= 1

    &&

    result[0] <= 300
  ) {

    result.shift();
  }


  return result;
}


/* ============================================================
   13O. MAP ROW TO YEARS
   ============================================================ */

function metricValuesByYear(
  section,
  labels,
  years,
  options = {}
) {

  if (
    !section ||
    !Array.isArray(years) ||
    !years.length
  ) {

    return {};
  }


  const row =
    findMetricRow(
      section,
      labels,
      options
    );


  if (!row) {

    return {};
  }


  let values =
    stripLikelyNoteReference(
      row.numbers,
      years.length
    );


  /*
   * A statement may contain more numbers because nearby
   * text was joined. We use only the number of expected
   * statement columns.
   */

  if (
    values.length >
    years.length
  ) {

    values =
      values.slice(
        0,
        years.length
      );
  }


  /*
   * If there are fewer values than years, do NOT guess
   * which missing year belongs where.
   *
   * Exception: one current-year value can safely map to
   * the first/current year.
   */

  const result =
    {};


  if (
    values.length === 1
  ) {

    result[
      years[0]
    ] =
      values[0];

    return result;
  }


  if (
    values.length !==
    years.length
  ) {

    return {};
  }


  for (
    let i = 0;
    i < years.length;
    i++
  ) {

    result[
      years[i]
    ] =
      values[i];
  }


  return result;
}


/* ============================================================
   13P. CONVERT YEAR MAP TO CRORE
   ============================================================ */

function convertYearMapToCrore(
  values,
  factor
) {

  const result =
    {};


  if (
    factor === null
  ) {

    return result;
  }


  for (
    const [
      year,
      value
    ]
    of Object.entries(
      values || {}
    )
  ) {

    if (
      value === null ||
      !Number.isFinite(value)
    ) {

      continue;
    }


    result[
      year
    ] =
      roundFinancial(
        value *
        factor
      );
  }


  return result;
}


/* ============================================================
   13Q. MERGE YEAR MAPS
   ============================================================ */

function mergeYearMaps(
  ...maps
) {

  const result =
    {};


  for (
    const map
    of maps
  ) {

    if (
      !map ||
      typeof map !== "object"
    ) {

      continue;
    }


    for (
      const [
        year,
        value
      ]
      of Object.entries(
        map
      )
    ) {

      if (
        result[year] === undefined &&
        value !== null &&
        Number.isFinite(value)
      ) {

        result[year] =
          value;
      }

    }

  }


  return result;
}


/* ============================================================
   13R. EXTRACT MONETARY METRIC
   ============================================================ */

function extractMoneyMetric(
  section,
  labels,
  years,
  factor,
  options = {}
) {

  const raw =
    metricValuesByYear(
      section,
      labels,
      years,
      options
    );


  return convertYearMapToCrore(
    raw,
    factor
  );
}


/* ============================================================
   13S. SHARES OUTSTANDING
   ============================================================ */

function extractSharesOutstanding(
  fullText,
  years
) {

  const result =
    {};


  const source =
    String(
      fullText || ""
    );


  /*
   * Search areas around share-capital terminology.
   */

  const lower =
    source.toLowerCase();


  const needles = [

    "issued, subscribed and paid-up",

    "issued subscribed and paid-up",

    "issued and paid-up",

    "issued and paid up",

    "equity share capital",

    "share capital"

  ];


  const windows =
    [];


  for (
    const needle
    of needles
  ) {

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
        index === -1
      ) {

        break;
      }


      windows.push(
        source.slice(
          Math.max(
            0,
            index - 3000
          ),
          index + 12000
        )
      );


      position =
        index +
        needle.length;
    }

  }


  /*
   * Avoid scanning arbitrary report numbers.
   */

  for (
    const window
    of windows
  ) {

    const lines =
      statementLines(
        window
      );


    for (
      const line
      of lines
    ) {

      if (
        !/\bequity shares?\b/i.test(
          line
        )
      ) {

        continue;
      }


      /*
       * Reject authorized-share lines.
       */

      if (
        /\bauthori[sz]ed\b/i.test(
          line
        )
      ) {

        continue;
      }


      /*
       * Absolute share count:
       *
       * 6,767,958,812 equity shares
       */

      const absoluteMatches =
        [
          ...line.matchAll(
            /(\d[\d,]{6,})\s+(?:fully\s+paid[- ]?up\s+)?equity shares?/gi
          )
        ];


      if (
        absoluteMatches.length
      ) {

        const values =
          absoluteMatches
            .map(
              match =>
                finiteFinancialNumber(
                  match[1]
                )
            )
            .filter(
              value =>
                value !== null &&
                value > 0
            );


        if (
          values.length
        ) {

          /*
           * Convert absolute shares -> crore shares.
           */

          const converted =
            values.map(
              value =>
                roundFinancial(
                  value /
                  10000000
                )
            );


          for (
            let i = 0;
            i <
              Math.min(
                years.length,
                converted.length
              );
            i++
          ) {

            if (
              result[
                years[i]
              ] === undefined
            ) {

              result[
                years[i]
              ] =
                converted[i];
            }

          }

        }

      }


      /*
       * Explicit crore shares.
       */

      const croreMatches =
        [
          ...line.matchAll(
            /(\d[\d,]*(?:\.\d+)?)\s+crores?\s+(?:equity\s+)?shares?/gi
          )
        ];


      if (
        croreMatches.length
      ) {

        const values =
          croreMatches
            .map(
              match =>
                finiteFinancialNumber(
                  match[1]
                )
            )
            .filter(
              value =>
                value !== null &&
                value > 0
            );


        for (
          let i = 0;
          i <
            Math.min(
              years.length,
              values.length
            );
          i++
        ) {

          if (
            result[
              years[i]
            ] === undefined
          ) {

            result[
              years[i]
            ] =
              roundFinancial(
                values[i]
              );
          }

        }

      }


      /*
       * Explicit million shares.
       */

      const millionMatches =
        [
          ...line.matchAll(
            /(\d[\d,]*(?:\.\d+)?)\s+millions?\s+(?:equity\s+)?shares?/gi
          )
        ];


      if (
        millionMatches.length
      ) {

        const values =
          millionMatches
            .map(
              match =>
                finiteFinancialNumber(
                  match[1]
                )
            )
            .filter(
              value =>
                value !== null &&
                value > 0
            );


        for (
          let i = 0;
          i <
            Math.min(
              years.length,
              values.length
            );
          i++
        ) {

          if (
            result[
              years[i]
            ] === undefined
          ) {

            result[
              years[i]
            ] =
              roundFinancial(
                values[i] /
                10
              );
          }

        }

      }

    }

  }


  return result;
}


/* ============================================================
   13T. VALIDATION HELPERS
   ============================================================ */

function safePositiveOrZero(
  value
) {

  if (
    value === null ||
    !Number.isFinite(value)
  ) {

    return null;
  }


  if (
    value < 0
  ) {

    return null;
  }


  return value;
}


function safeRatio(
  numerator,
  denominator,
  multiplier = 1
) {

  if (
    numerator === null ||
    denominator === null ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  ) {

    return null;
  }


  const result =
    numerator /
    denominator *
    multiplier;


  if (
    !Number.isFinite(result)
  ) {

    return null;
  }


  return roundFinancial(
    result
  );
}


function safeDifference(
  a,
  b
) {

  if (
    a === null ||
    b === null ||
    !Number.isFinite(a) ||
    !Number.isFinite(b)
  ) {

    return null;
  }


  return roundFinancial(
    a - b
  );
}


/* ============================================================
   13U. TOTAL DEBT
   ============================================================ */

/*
 * Debt is particularly dangerous because a row called
 * "borrowings" can occur separately under current and
 * non-current liabilities.
 *
 * We extract:
 *
 * non-current borrowings
 * +
 * current borrowings
 *
 * only when both can be located.
 *
 * Otherwise an explicit "total borrowings" / "total debt"
 * row is preferred.
 */

function extractDebtByYear(
  balanceSheet,
  years,
  factor
) {

  const explicit =
    extractMoneyMetric(
      balanceSheet,
      [
        "total borrowings",
        "total debt"
      ],
      years,
      factor
    );


  if (
    Object.keys(
      explicit
    ).length
  ) {

    return explicit;
  }


  /*
   * Do NOT use a generic single "borrowings" row as total debt.
   * That caused incorrect debt values in previous versions.
   */

  return {};
}


/* ============================================================
   13V. EBITDA
   ============================================================ */

function extractEbitdaByYear(
  profitLoss,
  fullText,
  years,
  factor
) {

  /*
   * First: audited statement if explicitly reported.
   */

  const direct =
    extractMoneyMetric(
      profitLoss,
      [
        "ebitda",
        "earnings before interest tax depreciation and amortisation",
        "earnings before interest taxes depreciation and amortisation",
        "earnings before interest tax depreciation and amortization",
        "earnings before interest taxes depreciation and amortization"
      ],
      years,
      factor
    );


  if (
    Object.keys(
      direct
    ).length
  ) {

    return direct;
  }


  /*
   * Search broader report for explicit EBITDA disclosure.
   *
   * We still require a row containing EBITDA.
   */

  const broader =
    extractMoneyMetric(
      fullText,
      [
        "ebitda"
      ],
      years,
      factor,
      {
        exclude: [
          "margin",
          "growth",
          "adjusted ebitda margin"
        ],
        searchLimit:
          25000
      }
    );


  return broader;
}


/* ============================================================
   13W. LOCAL FINANCIAL EXTRACTION ENGINE
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

    error.status = 422;

    throw error;
  }


  const companyName =
    detectCompanyName(
      text,
      pdfData?.info || {}
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


  const statementCombined =
    [
      profitStatement.text,
      balanceStatement.text,
      cashStatement.text
    ]
      .filter(Boolean)
      .join("\n");


  const consolidatedDetected =
    /\bconsolidated\b/i.test(
      [
        profitStatement.heading,
        balanceStatement.heading,
        cashStatement.heading
      ]
        .filter(Boolean)
        .join(" ")
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


  /*
   * Build candidate year set.
   */

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
          Number.isInteger(year)
      )
      .sort(
        (a, b) =>
          b - a
      )
      .slice(
        0,
        5
      );


  if (
    !allYears.length
  ) {

    const error =
      new Error(
        "FinSight located financial statements but could not reliably identify their reporting years."
      );

    error.status = 422;

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
     DETECT UNITS PER STATEMENT
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

   /* ----------------------------------------------------------
   TEMPORARY STATEMENT DEBUG
   ---------------------------------------------------------- */

console.log(
  "\n========== PROFIT STATEMENT DEBUG ==========\n",
  profitStatement.text
    ? profitStatement.text.slice(0, 12000)
    : "NOT FOUND",
  "\n========== END PROFIT STATEMENT DEBUG ==========\n"
);

console.log(
  "\n========== BALANCE SHEET DEBUG ==========\n",
  balanceStatement.text
    ? balanceStatement.text.slice(0, 12000)
    : "NOT FOUND",
  "\n========== END BALANCE SHEET DEBUG ==========\n"
);

console.log(
  "\n========== CASH FLOW DEBUG ==========\n",
  cashStatement.text
    ? cashStatement.text.slice(0, 12000)
    : "NOT FOUND",
  "\n========== END CASH FLOW DEBUG ==========\n"
);


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
          "margin",
          "attributable"
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


  const depreciation =
    extractMoneyMetric(
      profitStatement.text,
      [
        "depreciation and amortisation expense",
        "depreciation and amortization expense",
        "depreciation amortisation and impairment",
        "depreciation and amortisation"
      ],
      profitYears,
      profitFactor
    );


  const ebitda =
    extractEbitdaByYear(
      profitStatement.text,
      text,
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
        "total current assets"
      ],
      balanceYears,
      balanceFactor
    );


  const currentLiabilities =
    extractMoneyMetric(
      balanceStatement.text,
      [
        "total current liabilities"
      ],
      balanceYears,
      balanceFactor
    );


  const totalEquity =
    extractMoneyMetric(
      balanceStatement.text,
      [
        "total equity",
        "total shareholders equity",
        "total shareholders' equity",
        "equity attributable to owners of the company",
        "equity attributable to owners"
      ],
      balanceYears,
      balanceFactor,
      {
        exclude: [
          "equity share capital"
        ]
      }
    );


  const cash =
    extractMoneyMetric(
      balanceStatement.text,
      [
        "cash and cash equivalents",
        "cash & cash equivalents"
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


  const receivables =
    extractMoneyMetric(
      balanceStatement.text,
      [
        "trade receivables",
        "accounts receivable"
      ],
      balanceYears,
      balanceFactor
    );


  const payables =
    extractMoneyMetric(
      balanceStatement.text,
      [
        "trade payables",
        "accounts payable"
      ],
      balanceYears,
      balanceFactor
    );


  const totalDebt =
    extractDebtByYear(
      balanceStatement.text,
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
        "net cash flow from operating activities",
        "net cash flows from operating activities",
        "net cash from operating activities"
      ],
      cashYears,
      cashFactor
    );


  let capex =
    extractMoneyMetric(
      cashStatement.text,
      [
        "purchase of property plant and equipment",
        "purchase of property, plant and equipment",
        "payments for property plant and equipment",
        "payments for property, plant and equipment",
        "purchase of fixed assets"
      ],
      cashYears,
      cashFactor
    );


  /*
   * Capex is displayed as positive investment amount.
   */

  capex =
    Object.fromEntries(
      Object.entries(
        capex
      ).map(
        (
          [
            year,
            value
          ]
        ) => [

          year,

          Number.isFinite(value)
            ? Math.abs(value)
            : null

        ]
      )
    );


  /* ----------------------------------------------------------
     SHARES
     ---------------------------------------------------------- */

  const shares =
    extractSharesOutstanding(
      text,
      allYears
    );


  /* ----------------------------------------------------------
     BUILD YEAR ROWS
     ---------------------------------------------------------- */

  const rows =
    [];


  for (
    const year
    of allYears
  ) {

    const revenueValue =
      revenue[year] ??
      null;


    const otherIncomeValue =
      otherIncome[year] ??
      null;


    const totalIncomeValue =
      totalIncome[year] ??
      null;


    let operatingIncomeValue =
      operatingIncome[year] ??
      null;


    const pbtValue =
      profitBeforeTax[year] ??
      null;


    const financeCostValue =
      financeCost[year] ??
      null;


    const depreciationValue =
      depreciation[year] ??
      null;


    let ebitdaValue =
      ebitda[year] ??
      null;


    const netIncomeValue =
      netIncome[year] ??
      null;


    const totalAssetsValue =
      safePositiveOrZero(
        totalAssets[year] ??
        null
      );


    const currentAssetsValue =
      safePositiveOrZero(
        currentAssets[year] ??
        null
      );


    const currentLiabilitiesValue =
      safePositiveOrZero(
        currentLiabilities[year] ??
        null
      );


    const totalEquityValue =
      totalEquity[year] ??
      null;


    const cashValue =
      safePositiveOrZero(
        cash[year] ??
        null
      );


    const inventoryValue =
      safePositiveOrZero(
        inventory[year] ??
        null
      );


    const receivableValue =
      safePositiveOrZero(
        receivables[year] ??
        null
      );


    const payableValue =
      safePositiveOrZero(
        payables[year] ??
        null
      );


    const debtValue =
      safePositiveOrZero(
        totalDebt[year] ??
        null
      );


    const ocfValue =
      operatingCashFlow[year] ??
      null;


    const capexValue =
      safePositiveOrZero(
        capex[year] ??
        null
      );


    /*
     * EBIT can be calculated from:
     *
     * PBT + finance cost
     *
     * only when both are available.
     */

    if (
      operatingIncomeValue === null &&
      pbtValue !== null &&
      financeCostValue !== null
    ) {

      operatingIncomeValue =
        roundFinancial(
          pbtValue +
          financeCostValue
        );
    }


    /*
     * EBITDA may be calculated from:
     *
     * EBIT + depreciation/amortisation
     *
     * only when both are available.
     */

    if (
      ebitdaValue === null &&
      operatingIncomeValue !== null &&
      depreciationValue !== null
    ) {

      ebitdaValue =
        roundFinancial(
          operatingIncomeValue +
          Math.abs(
            depreciationValue
          )
        );
    }


    /*
     * Defensive sanity checks.
     *
     * Equity can legitimately be negative.
     * Assets cannot.
     *
     * Do not allow tiny note-reference values to produce
     * absurd ROE / debt-equity ratios.
     */

    let validatedEquity =
      totalEquityValue;


    if (
      validatedEquity !== null &&
      totalAssetsValue !== null
    ) {

      /*
       * Equity many orders of magnitude below assets is
       * suspicious in local PDF extraction.
       *
       * We do NOT guess a replacement.
       */

      if (
        Math.abs(
          validatedEquity
        ) <
        Math.abs(
          totalAssetsValue
        ) *
        0.00001
      ) {

        console.warn(
          `Rejected suspicious equity extraction for ${year}:`,
          validatedEquity,
          "vs assets",
          totalAssetsValue
        );


        validatedEquity =
          null;
      }

    }


    /*
     * Likewise debt cannot be negative.
     */

    const validatedDebt =
      debtValue !== null &&
      debtValue >= 0

        ? debtValue

        : null;


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

        profit_and_loss:
          profitUnit,

        balance_sheet:
          balanceUnit,

        cash_flow:
          cashUnit

      },

      revenue:
        revenueValue,

      other_income:
        otherIncomeValue,

      total_income:
        totalIncomeValue,

      ebitda:
        ebitdaValue,

      cogs:
        null,

      operating_income:
        operatingIncomeValue,

      profit_before_tax:
        pbtValue,

      net_income:
        netIncomeValue,

      total_assets:
        totalAssetsValue,

      current_assets:
        currentAssetsValue,

      current_liabilities:
        currentLiabilitiesValue,

      total_debt:
        validatedDebt,

      cash:
        cashValue,

      total_equity:
        validatedEquity,

      operating_cash_flow:
        ocfValue,

      capex:
        capexValue,

      inventory:
        inventoryValue,

      accounts_receivable:
        receivableValue,

      accounts_payable:
        payableValue,

      finance_cost:
        financeCostValue,

      depreciation_amortisation:
        depreciationValue,

      shares_outstanding:
        shares[year] ??
        null,

      shares_outstanding_unit:
        shares[year] !== undefined
          ? "crore shares"
          : null,

      /*
       * Derived dashboard values.
       *
       * These are deterministic calculations,
       * not extracted facts.
       */

      ebitda_margin:
        safeRatio(
          ebitdaValue,
          revenueValue,
          100
        ),

      operating_margin:
        safeRatio(
          operatingIncomeValue,
          revenueValue,
          100
        ),

      net_margin:
        safeRatio(
          netIncomeValue,
          revenueValue,
          100
        ),

      current_ratio:
        safeRatio(
          currentAssetsValue,
          currentLiabilitiesValue
        ),

      debt_equity:
        safeRatio(
          validatedDebt,
          validatedEquity
        ),

      net_debt:
        safeDifference(
          validatedDebt,
          cashValue
        ),

      cash_conversion:
        safeRatio(
          ocfValue,
          netIncomeValue
        ),

      simplified_fcf:
        safeDifference(
          ocfValue,
          capexValue
        ),

      interest_coverage:
        safeRatio(
          operatingIncomeValue,
          financeCostValue
        ),

      /*
       * ROE / ROA / ROCE are intentionally calculated later
       * using average balance-sheet values where possible.
       */

      roe:
        null,

      roa:
        null,

      roce:
        null,

      asset_turnover:
        null,

      receivable_days:
        null,

      inventory_days:
        null,

      payable_days:
        null,

      source_pages:
        [],

      extraction_notes:
        ""

    };


    rows.push(
      row
    );

  }


  /* ==========================================================
     13X. AVERAGE-BALANCE RETURN CALCULATIONS
     ========================================================== */

  /*
   * Rows are newest -> oldest.
   *
   * For FY2024-25:
   *
   * average equity =
   * (FY2024-25 closing equity + FY2023-24 closing equity) / 2
   */

  for (
    let i = 0;
    i < rows.length;
    i++
  ) {

    const current =
      rows[i];


    const previous =
      rows[i + 1] ||
      null;


    if (
      previous
    ) {

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


        /*
         * Avoid meaningless ratios when average equity is
         * effectively zero.
         */

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
          Math.abs(
            averageAssets
          ) >
          0.01
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

    }


    /*
     * ROCE:
     *
     * EBIT /
     * average capital employed
     *
     * capital employed =
     * total assets - current liabilities
     *
     * Requires balance-sheet evidence.
     */

    if (
      previous &&
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


    /*
     * Receivable days.
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

  }


  /* ==========================================================
     13Y. REMOVE EMPTY / UNSAFE ROWS
     ========================================================== */

  const dashboardFields = [

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


  const usableRows =
    rows.filter(
      row => {

        const count =
          dashboardFields.filter(
            field =>
              row[field] !== null &&
              Number.isFinite(
                row[field]
              )
          ).length;


        /*
         * At least two independent fields are required.
         *
         * This prevents one accidental row match from
         * creating a fake financial year.
         */

        return count >= 2;

      }
    );


  if (
    !usableRows.length
  ) {

    const error =
      new Error(
        "Financial-statement rows were detected, but there was not enough reliable audited data to populate the dashboard safely."
      );

    error.status = 422;

    throw error;
  }


  /* ==========================================================
     13Z. EXTRACTION NOTES
     ========================================================== */

  for (
    const row
    of usableRows
  ) {

    const notes =
      [];


    if (
      row.revenue === null
    ) {

      notes.push(
        "Revenue was not reliably extracted."
      );
    }


    if (
      row.ebitda === null
    ) {

      notes.push(
        "EBITDA was not reliably established."
      );
    }


    if (
      row.total_assets === null
    ) {

      notes.push(
        "Total assets were not reliably extracted."
      );
    }


    if (
      row.total_equity === null
    ) {

      notes.push(
        "Total equity was not reliably extracted."
      );
    }


    if (
      row.total_debt === null
    ) {

      notes.push(
        "Total debt was not reliably established; FinSight did not substitute a single borrowings line for total debt."
      );
    }


    if (
      row.shares_outstanding === null
    ) {

      notes.push(
        "Period-end shares outstanding were not reliably established."
      );
    }


    row.extraction_notes =
      notes.join(" ");

  }


  /* ==========================================================
     VALIDATION
     ========================================================== */

  const latest =
    usableRows[0];


  const missingCriticalFields =
    dashboardFields
      .filter(
        field =>
          latest[field] === null
      );


  const warnings =
    [];


  if (
    !consolidatedDetected
  ) {

    warnings.push(
      "FinSight could not conclusively verify that all selected statement sections were consolidated."
    );
  }


  if (
    profitFactor === null
  ) {

    warnings.push(
      "Profit-and-loss monetary unit was not reliably established."
    );
  }


  if (
    balanceFactor === null
  ) {

    warnings.push(
      "Balance-sheet monetary unit was not reliably established."
    );
  }


  if (
    cashFactor === null
  ) {

    warnings.push(
      "Cash-flow monetary unit was not reliably established."
    );
  }


  if (
    latest.revenue === null
  ) {

    warnings.push(
      "Revenue is unavailable because no sufficiently reliable audited revenue row was matched."
    );
  }


  if (
    latest.ebitda === null
  ) {

    warnings.push(
      "EBITDA is unavailable because it could not be explicitly identified or safely calculated."
    );
  }


  /* ==========================================================
     DEBUG LOG
     ========================================================== */

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

      confidence:
        consolidatedDetected &&
        profitFactor !== null &&
        balanceFactor !== null &&
        cashFactor !== null

          ? "High"

          : "Medium",

      pages:
        pdfData?.pages || null

    }
  );


  /* ==========================================================
     RETURN DASHBOARD STRUCTURE
     ========================================================== */

  return {

    company: {

      name:
        companyName,

      legal_name:
        companyName,

      /*
       * Local financial statements alone are not enough
       * to safely infer current listing status.
       */

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

        consolidatedDetected &&
        profitFactor !== null &&
        balanceFactor !== null &&
        cashFactor !== null

          ? "High"

          : "Medium"

    },


    financials:
      usableRows,


    validation: {

      consolidated_preferred:
        true,

      consolidated_detected:
        consolidatedDetected,

      years_found:
        usableRows.map(
          row =>
            row.financial_year
        ),

      missing_critical_fields:
        missingCriticalFields,

      warnings,

      statement_detection: {

        profit_and_loss: {

          found:
            Boolean(
              profitStatement.text
            ),

          heading:
            profitStatement.heading,

          unit:
            profitUnit

        },


        balance_sheet: {

          found:
            Boolean(
              balanceStatement.text
            ),

          heading:
            balanceStatement.heading,

          unit:
            balanceUnit

        },


        cash_flow: {

          found:
            Boolean(
              cashStatement.text
            ),

          heading:
            cashStatement.heading,

          unit:
            cashUnit

        }

      }

    }

  };
}


/* ============================================================
   END SECTION 13
   ============================================================ */


/* ============================================================
   14. FINANCIAL EXTRACTION ROUTE — LOCAL ONLY
   ============================================================ */

/*
 * This endpoint intentionally keeps the old URL:
 *
 * POST /api/ai/extract-financials
 *
 * so your frontend does NOT need to change.
 *
 * Despite the historical /api/ai/ path, this endpoint
 * does NOT call AI.
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

      /* ------------------------------------------------------
         REQUIRE REPORT
         ------------------------------------------------------ */

      if (
        !req.file
      ) {

        return res
          .status(400)
          .json({

            ok:
              false,

            error:
              "Upload an annual-report PDF.",

            code:
              "REPORT_REQUIRED",

            provider:
              "local"

          });
      }


      /* ------------------------------------------------------
         VERIFY PDF SIGNATURE
         ------------------------------------------------------ */

      const signature =
        req.file.buffer
          .subarray(
            0,
            5
          )
          .toString(
            "ascii"
          );


      if (
        signature !== "%PDF-"
      ) {

        return res
          .status(400)
          .json({

            ok:
              false,

            error:
              "The uploaded file is not a valid PDF.",

            code:
              "INVALID_PDF",

            provider:
              "local"

          });
      }


      /* ------------------------------------------------------
         EXTRACT PDF TEXT LOCALLY
         ------------------------------------------------------ */

      const pdfData =
        await extractPdfTextLocally(
          req.file
        );


      /* ------------------------------------------------------
         EXTRACT FINANCIALS LOCALLY
         ------------------------------------------------------ */

      const result =
        extractFinancialsLocally(
          pdfData
        );


      /* ------------------------------------------------------
         DEFENSIVE VALIDATION
         ------------------------------------------------------ */

      if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result)
      ) {

        const error =
          new Error(
            "Local financial extraction returned an invalid result."
          );

        error.status = 500;

        throw error;
      }


      if (
        !Array.isArray(
          result.financials
        ) ||
        !result.financials.length
      ) {

        const error =
          new Error(
            "No reliable financial-statement rows were found."
          );

        error.status = 422;

        throw error;
      }


      /*
       * Never allow malformed numbers into dashboard.
       */

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


      result.financials =
        result.financials.map(
          row => {

            const clean = {
              ...row
            };


            for (
              const field
              of monetaryFields
            ) {

              const value =
                row[field];


              clean[field] =

                value === null ||
                value === undefined

                  ? null

                  : Number.isFinite(
                      Number(value)
                    )

                    ? Number(value)

                    : null;
            }


            clean.year =

              Number.isInteger(
                Number(row.year)
              )

                ? Number(
                    row.year
                  )

                : null;


            clean.shares_outstanding =

              row.shares_outstanding ===
                null

              ||

              row.shares_outstanding ===
                undefined

                ? null

                : Number.isFinite(
                    Number(
                      row.shares_outstanding
                    )
                  )

                  ? Number(
                      row.shares_outstanding
                    )

                  : null;


            clean.source_pages =
              Array.isArray(
                row.source_pages
              )
                ? row.source_pages
                : [];


            return clean;
          }
        );


      /* ------------------------------------------------------
         DATABASE PERSISTENCE
         ------------------------------------------------------ */

      let persisted =
        null;


      if (
        pool
      ) {

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


          const validYears =
            result.financials
              .map(
                row =>
                  Number(
                    row.year
                  )
              )
              .filter(
                year =>
                  Number.isInteger(year) &&
                  year >= 1900 &&
                  year <= 2200
              );


          const latestYear =
            validYears.length
              ? Math.max(
                  ...validYears
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
                  financials:
                    result.financials,

                  validation:
                    result.validation,

                  extraction: {
                    provider:
                      "local",

                    engine:
                      "pdf-parse + deterministic FinSight extractor",

                    pages:
                      pdfData.pages,

                    extractedCharacters:
                      pdfData.text.length
                  }
                },

                {},

                hash

              ]
            );


          persisted = {

            companyId:
              companyRow.id,

            reportId:
              inserted.rows[0]
                .id,

            createdAt:
              inserted.rows[0]
                .created_at

          };

        }

        catch (
          databaseError
        ) {

          console.error(
            "Local extraction persistence warning:",
            databaseError
          );


          if (
            !Array.isArray(
              result.validation?.warnings
            )
          ) {

            result.validation.warnings =
              [];
          }


          result
            .validation
            .warnings
            .push(
              "Financial extraction succeeded, but the result could not be saved to research memory."
            );

        }

      }


      /* ------------------------------------------------------
         SUCCESS
         ------------------------------------------------------ */

      console.log(
        "Local financial extraction successful:",
        {
          company:
            result.company?.name,

          rows:
            result.financials.length,

          years:
            result.validation?.years_found,

          confidence:
            result.company?.extraction_confidence,

          pages:
            pdfData.pages
        }
      );


      return res.json({

        ok:
          true,

        ...result,

        persisted,

        provider:
          "local",

        model:
          null,

        extractionEngine:
          "pdf-parse + deterministic FinSight extractor",

        pdfProcessing:
          "local",

        pdf: {

          pages:
            pdfData.pages,

          extractedCharacters:
            pdfData.text.length,

          sizeBytes:
            req.file.buffer.length

        }

      });

    }


    /* ========================================================
       LOCAL EXTRACTION ERROR HANDLER
       ======================================================== */

    catch (
      error
    ) {

      console.error(
        "Local financial extraction error:",
        error
      );


      const upstreamStatus =
        Number(
          error?.status
        );


      let status =
        500;


      let code =
        "LOCAL_EXTRACTION_FAILED";


      let message =
        error?.message ||
        "FinSight could not extract financial statements from this annual report.";


      /* ------------------------------------------------------
         INVALID PDF
         ------------------------------------------------------ */

      if (
        upstreamStatus === 400
      ) {

        status =
          400;

        code =
          "INVALID_REPORT";
      }


      /* ------------------------------------------------------
         TOO LARGE
         ------------------------------------------------------ */

      else if (
        upstreamStatus === 413
      ) {

        status =
          413;

        code =
          "REPORT_TOO_LARGE";

        message =
          "The annual-report PDF exceeds FinSight's 45 MB upload limit.";
      }


      /* ------------------------------------------------------
         PDF READABLE, STATEMENTS NOT RELIABLY LOCATED
         ------------------------------------------------------ */

      else if (
        upstreamStatus === 422
      ) {

        status =
          422;

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
            message,

          code,

          provider:
            "local",

          model:
            null

        });

    }

  }
);


/* ============================================================
   END SECTION 14
   SECTION 15 CONTINUES BELOW
   ============================================================ */


/* ============================================================
   15. ANNUAL REPORT AI
   ============================================================ */

/*
 * Architecture:
 *
 * PDF
 * ↓
 * local pdf-parse
 * ↓
 * extracted text
 * ↓
 * Gemini text analysis
 *
 * IMPORTANT:
 *
 * The PDF itself is NEVER sent to Gemini.
 *
 * Financial extraction has already been performed locally
 * by /api/ai/extract-financials.
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

            ok:
              false,

            error:
              "Upload an annual-report PDF."

          });

      }


      /* ------------------------------------------------------
         LOCAL PDF TEXT EXTRACTION
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
       * Do not send unlimited report text to Gemini.
       *
       * Financial extraction itself remains completely local.
       *
       * Gemini receives text only for qualitative analysis.
       */

      const MAX_REPORT_TEXT =
        700000;


      let reportText =
        pdfData.text;


      if (
        reportText.length >
        MAX_REPORT_TEXT
      ) {

        /*
         * Preserve both the beginning and end of a long report.
         *
         * The beginning often contains:
         * - company/business information
         * - management commentary
         *
         * The latter portion often contains:
         * - financial statements
         * - auditor report
         * - notes
         */

        const firstPart =
          reportText.slice(
            0,
            350000
          );


        const lastPart =
          reportText.slice(
            -350000
          );


        reportText =
          `${firstPart}

============================================================
[LONG REPORT MIDDLE SECTION OMITTED FROM AI CONTEXT]
============================================================

${lastPart}`;

      }


      const prompt = `

Analyze the following annual-report evidence as an
evidence-first long-term investor.

IMPORTANT:

The annual-report PDF was processed locally by FinSight.

You are receiving extracted TEXT only.

Use ONLY:

1. the supplied annual-report text,
2. the structured FinSight financial extraction,
3. the supplied local PDF context.

Never invent missing information.

Do not replace missing annual-report evidence with general
knowledge about the company or industry.


============================================================
STRUCTURED FINANCIAL CONTEXT
============================================================

${JSON.stringify(
  metrics || {},
  null,
  2
)}


============================================================
LOCAL PDF CONTEXT
============================================================

${JSON.stringify(
  pdfContext || {},
  null,
  2
)}


============================================================
ANNUAL REPORT TEXT
============================================================

${reportText}


============================================================
BUSINESS ANALYSIS
============================================================

Analyze:

- business model
- major products and services
- operating segments
- revenue drivers
- geographic exposure
- competitive position
- customer concentration where disclosed
- growth drivers
- material business changes


============================================================
FINANCIAL QUALITY
============================================================

Use the structured financial context where available.

Analyze:

- revenue trend
- EBITDA
- EBITDA margin
- operating profitability
- net profit
- profit margins
- operating cash flow
- cash conversion
- working capital
- receivables
- inventory
- payables
- debt
- finance cost
- liquidity
- balance-sheet strength
- capital expenditure
- return characteristics

Do not invent a financial number that is absent from the
structured financial context or annual-report evidence.


============================================================
MANAGEMENT
============================================================

Analyze:

- management strategy
- stated priorities
- guidance
- targets
- commitments
- execution
- capital allocation
- acquisitions
- disposals
- dividends
- debt decisions
- major investments


============================================================
GOVERNANCE
============================================================

Analyze where disclosed:

- board observations
- promoter relationships
- parent relationships
- related-party transactions
- governance concerns
- conflicts of interest
- material governance changes


============================================================
AUDITOR
============================================================

Analyze:

- audit opinion
- qualifications
- emphasis of matter
- key audit matters
- internal-control observations
- material auditor concerns

Do not describe a normal audit disclosure as a red flag
without evidence.


============================================================
RISKS
============================================================

Identify material disclosed risks involving:

- regulation
- competition
- technology
- leverage
- liquidity
- litigation
- contingent liabilities
- customer concentration
- supplier concentration
- cybersecurity
- execution
- foreign exchange
- commodity exposure
- working capital
- governance


============================================================
MANAGEMENT PROMISE TRACKER
============================================================

Where earlier commitments and later evidence are available,
classify each promise using ONLY:

"Achieved"
"Partially achieved"
"Pending"
"Changed"
"Not verifiable"


============================================================
EVIDENCE DISCIPLINE
============================================================

Distinguish:

REPORTED FACT

CALCULATED METRIC

MANAGEMENT CLAIM

AI INTERPRETATION

A financial anomaly is an investigation prompt,
not proof of misconduct.

If evidence is insufficient, say so.

Do not invent page references.

Do not issue personalized buy/sell instructions.


============================================================
OUTPUT
============================================================

Return VALID JSON ONLY.

Use this structure:

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
}


For:

- good
- bad
- watch
- red_flags
- growth_drivers

use objects shaped like:

{
  "title": "",
  "explanation": "",
  "evidence": [],
  "priority": "High|Medium|Low"
}

Do not invent evidence.

`;


      /* ------------------------------------------------------
         GEMINI TEXT-ONLY ANALYSIS
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

      analysis.financial_years =
        Array.isArray(
          analysis.financial_years
        )
          ? analysis.financial_years
          : [];


      analysis.yearly_analysis =
        Array.isArray(
          analysis.yearly_analysis
        )
          ? analysis.yearly_analysis
          : [];


      analysis.management_promise_tracker =
        Array.isArray(
          analysis.management_promise_tracker
        )
          ? analysis.management_promise_tracker
          : [];


      analysis.good =
        Array.isArray(
          analysis.good
        )
          ? analysis.good
          : [];


      analysis.bad =
        Array.isArray(
          analysis.bad
        )
          ? analysis.bad
          : [];


      analysis.watch =
        Array.isArray(
          analysis.watch
        )
          ? analysis.watch
          : [];


      analysis.red_flags =
        Array.isArray(
          analysis.red_flags
        )
          ? analysis.red_flags
          : [];


      analysis.growth_drivers =
        Array.isArray(
          analysis.growth_drivers
        )
          ? analysis.growth_drivers
          : [];


      analysis.investor_questions =
        Array.isArray(
          analysis.investor_questions
        )
          ? analysis.investor_questions
          : [];


      analysis.missing_information =
        Array.isArray(
          analysis.missing_information
        )
          ? analysis.missing_information
          : [];


      analysis.trend_analysis =
        analysis.trend_analysis &&
        typeof analysis.trend_analysis === "object"

          ? analysis.trend_analysis

          : {};


      analysis.changes =
        analysis.changes &&
        typeof analysis.changes === "object"

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
        .status(status)
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
 * Ask FinSight does NOT receive the PDF.
 *
 * It works from:
 *
 * - local financial extraction
 * - annual-report analysis
 * - market data
 * - valuation
 * - local PDF context supplied by frontend
 *
 * This keeps questions fast and avoids repeatedly
 * processing the annual report.
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
        req.body || {};


      if (
        !question ||
        !String(
          question
        ).trim()
      ) {

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
        typeof company !== "object"
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


      const prompt = `

Answer the investor's question about the loaded company.

Use ONLY the supplied FinSight evidence.

Do not use unsourced general knowledge to fill missing
annual-report information.


============================================================
QUESTION
============================================================

${String(
  question
).trim()}


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
ANNUAL-REPORT ANALYSIS
============================================================

${JSON.stringify(
  reportAnalysis || null,
  null,
  2
)}


============================================================
LOCAL PDF CONTEXT
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

You may answer questions concerning:

- business model
- how the company makes money
- products
- services
- operating segments
- strategy
- competitive position
- revenue
- profitability
- EBITDA
- margins
- cash flow
- debt
- working capital
- receivables
- inventory
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
- annual-report disclosures
- multi-year changes


If the supplied evidence cannot support an answer, state:

"Not established from the loaded annual-report evidence."


Do NOT fill missing evidence using generic knowledge.

Do NOT invent:

- numbers
- page references
- management statements
- market prices
- ticker symbols
- valuation multiples
- auditor findings


Separate the evidence where relevant into:

REPORTED FACT

CALCULATED METRIC

MANAGEMENT CLAIM

AI INTERPRETATION


Do not issue personalized buy/sell instructions.


============================================================
OUTPUT
============================================================

Return VALID JSON ONLY:

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
        safeJSON(
          text
        );


      if (
        !answer ||
        typeof answer !== "object" ||
        Array.isArray(
          answer
        )
      ) {

        throw new Error(
          "Gemini returned an unreadable answer."
        );

      }


      answer.reported_facts =
        Array.isArray(
          answer.reported_facts
        )
          ? answer.reported_facts
          : [];


      answer.calculated_metrics =
        Array.isArray(
          answer.calculated_metrics
        )
          ? answer.calculated_metrics
          : [];


      answer.management_claims =
        Array.isArray(
          answer.management_claims
        )
          ? answer.management_claims
          : [];


      answer.ai_interpretation =
        Array.isArray(
          answer.ai_interpretation
        )
          ? answer.ai_interpretation
          : [];


      answer.evidence =
        Array.isArray(
          answer.evidence
        )
          ? answer.evidence
          : [];


      answer.risks =
        Array.isArray(
          answer.risks
        )
          ? answer.risks
          : [];


      answer.what_to_investigate_next =
        Array.isArray(
          answer.what_to_investigate_next
        )
          ? answer.what_to_investigate_next
          : [];


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
        .status(status)
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
   17. COMPETITOR ANNUAL-REPORT COMPARISON
   ============================================================ */

/*
 * NEW ARCHITECTURE
 *
 * Company A PDF
 *      ↓
 * LOCAL pdf-parse
 *      ↓
 * LOCAL financial extraction
 *      ↓
 * Gemini receives TEXT + local financial JSON
 *      ↓
 * compact Company A profile
 *
 *
 * Company B PDF
 *      ↓
 * LOCAL pdf-parse
 *      ↓
 * LOCAL financial extraction
 *      ↓
 * Gemini receives TEXT + local financial JSON
 *      ↓
 * compact Company B profile
 *
 *
 * Profile A + Profile B
 *      ↓
 * Gemini text comparison
 *
 *
 * PDFs are NEVER sent to Gemini.
 */


/* ============================================================
   17A. PREPARE ONE COMPANY REPORT
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


      /* ------------------------------------------------------
         LOCAL PDF EXTRACTION
         ------------------------------------------------------ */

      console.log(
        `Preparing local comparison research for ${label}:`,
        report.originalname,
        `(${(
          report.buffer.length /
          1024 /
          1024
        ).toFixed(1)} MB)`
      );


      const pdfData =
        await extractPdfTextLocally(
          report
        );


      /*
       * Try deterministic financial extraction.
       *
       * Comparison should still be able to proceed with
       * qualitative report evidence if some structured
       * financial fields cannot be located.
       */

      let localFinancials =
        null;


      try {

        localFinancials =
          extractFinancialsLocally(
            pdfData
          );

      }

      catch (
        extractionError
      ) {

        console.warn(
          `Local comparison financial extraction incomplete for ${label}:`,
          extractionError?.message
        );

      }


      /* ------------------------------------------------------
         REPORT TEXT WINDOW
         ------------------------------------------------------ */

      const MAX_COMPARISON_TEXT =
        500000;


      let reportText =
        pdfData.text;


      if (
        reportText.length >
        MAX_COMPARISON_TEXT
      ) {

        reportText =

          reportText.slice(
            0,
            250000
          )

          +

          `

============================================================
[LONG REPORT MIDDLE SECTION OMITTED FROM AI CONTEXT]
============================================================

`

          +

          reportText.slice(
            -250000
          );

      }


      const prompt = `

You are FinSight AI.

Create a COMPACT evidence-first investor profile for:

${label}

The annual-report PDF was processed LOCALLY.

You are receiving:

1. locally extracted annual-report text
2. deterministic FinSight financial extraction where available

The PDF itself has NOT been sent to you.


============================================================
LOCAL FINANCIAL EXTRACTION
============================================================

${JSON.stringify(
  localFinancials || null,
  null,
  2
)}


============================================================
ANNUAL REPORT TEXT
============================================================

${reportText}


============================================================
SOURCE RULES
============================================================

1. The supplied annual-report evidence is the source of truth.

2. Prefer consolidated evidence for group-level analysis.

3. Do not mix standalone and consolidated figures.

4. Do not invent missing information.

5. Do not guess ticker symbols or exchanges.

6. Do not invent market prices.

7. Do not treat missing information as zero.

8. Do not issue personalized buy/sell advice.

9. Use the locally extracted financial values as authoritative
   where they are supplied.

10. If a financial value is unavailable, return null.


============================================================
FINANCIAL ANALYSIS
============================================================

Analyze where supported:

- revenue
- revenue growth
- EBITDA
- EBITDA margin
- operating profit
- net profit
- net margin
- operating cash flow
- cash conversion
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


============================================================
BUSINESS
============================================================

Analyze:

- business model
- major operating segments
- revenue drivers
- competitive strengths
- growth drivers


============================================================
CASH QUALITY
============================================================

Analyze:

- operating cash generation
- profit-to-cash conversion
- working-capital effects
- important cash-flow concerns


============================================================
BALANCE SHEET
============================================================

Analyze:

- leverage
- liquidity
- debt
- cash
- financial flexibility


============================================================
MANAGEMENT
============================================================

Analyze:

- strategy
- execution
- capital allocation


============================================================
GOVERNANCE
============================================================

Analyze:

- governance observations
- related-party issues
- material concerns


============================================================
AUDITOR
============================================================

Analyze:

- audit opinion
- qualifications
- key audit matters


============================================================
RISKS
============================================================

Identify material supported risks.

Do not invent risks simply to fill the array.


============================================================
OUTPUT
============================================================

Return VALID JSON ONLY:

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


      /* ------------------------------------------------------
         GEMINI GETS TEXT ONLY
         ------------------------------------------------------ */

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
        typeof research !== "object" ||
        Array.isArray(
          research
        )
      ) {

        throw new Error(
          "Gemini returned unusable structured comparison data."
        );

      }


      /* ------------------------------------------------------
         DEFENSIVE STRUCTURE
         ------------------------------------------------------ */

      research.company =
        research.company &&
        typeof research.company === "object"

          ? research.company

          : {};


      research.financials =
        research.financials &&
        typeof research.financials === "object"

          ? research.financials

          : {};


      research.business =
        research.business &&
        typeof research.business === "object"

          ? research.business

          : {};


      research.management =
        research.management &&
        typeof research.management === "object"

          ? research.management

          : {};


      research.governance =
        research.governance &&
        typeof research.governance === "object"

          ? research.governance

          : {};


      research.auditor =
        research.auditor &&
        typeof research.auditor === "object"

          ? research.auditor

          : {};


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


      /*
       * If Gemini omitted the company name but local extraction
       * found it, preserve the locally extracted identity.
       */

      if (
        !research.company.name &&
        localFinancials?.company?.name
      ) {

        research.company.name =
          localFinancials.company.name;

      }


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
            pdfData.text.length

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
        .status(status)
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
   17B. COMPARE PREPARED COMPANY PROFILES
   ============================================================ */

/*
 * This endpoint receives JSON only.
 *
 * No PDF.
 * No pdf-parse.
 *
 * Therefore the final comparison request is lightweight.
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
        typeof companyA !== "object" ||
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
        typeof companyB !== "object" ||
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


      const MAX_PROFILE_SIZE =
        250000;


      if (
        serializedA.length >
          MAX_PROFILE_SIZE

        ||

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


      const prompt = `

You are FinSight AI.

Compare two companies using ONLY the structured annual-report
research supplied below.

The underlying PDFs were processed locally by FinSight.

Do not invent missing information.

Do not supplement the supplied evidence with unsourced
general knowledge.

Do not automatically declare one company the winner.

Do not provide personalized buy/sell advice.

Your job is to explain investor trade-offs.


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

Compare:

1. Business model
2. Business quality
3. Growth
4. Revenue durability
5. Profitability
6. EBITDA and operating margins
7. Operating cash generation
8. Earnings quality
9. Working capital
10. Balance-sheet strength
11. Debt and leverage
12. Liquidity
13. ROE / ROCE where supported
14. Capital allocation
15. Management strategy
16. Management execution
17. Governance
18. Auditor observations
19. Key audit matters
20. Major risks
21. Growth opportunities


============================================================
EDGE RULE
============================================================

For every comparison category, edge MUST be one of:

"Company A"

"Company B"

"Mixed"

"Similar"

"Insufficient evidence"


Do not award an edge merely because one company has
more disclosure.

Missing information is NOT a negative financial result.

Never treat null as zero.


============================================================
VALUATION
============================================================

These profiles are primarily annual-report based.

If sufficient public-market valuation evidence is not
present, use:

"Insufficient evidence"

Do not invent:

- market prices
- market capitalization
- P/E
- EV/EBITDA
- P/B
- valuation multiples


============================================================
OUTPUT
============================================================

Return VALID JSON ONLY:

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
        typeof comparison !== "object" ||
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
        .status(status)
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

  }
);


/* ============================================================
   BLOCK 2 ENDS HERE

   NEXT:
   SECTION 18 — ALPHA VANTAGE
   THROUGH
   SECTION 29 — START
   ============================================================ */
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


      /* ------------------------------------------------------
         RESOLVE MARKET SYMBOL
         ------------------------------------------------------ */

      let symbol =
        null;


      let identifierSource =
        null;


      /*
       * BSE security code is preferred where available.
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
       * Otherwise use verified ticker.
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
       */

      else if (nseCode) {

        symbol =
          nseCode;


        identifierSource =
          "NSE code";

      }


      /*
       * Final fallback to frontend identifier.
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

            ok:
              false,

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


      /* ------------------------------------------------------
         ONE ALPHA VANTAGE REQUEST
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
          url
        );


      if (!response.ok) {

        throw new Error(
          `Alpha Vantage HTTP ${response.status}`
        );

      }


      const data =
        await response.json();


      /*
       * Alpha Vantage commonly returns HTTP 200
       * even when provider limits are reached.
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
        data["Error Message"]
      ) {

        return res
          .status(404)
          .json({

            ok:
              false,

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


      function numberValue(key) {

        const raw =
          quote[key];


        if (
          raw === null ||
          raw === undefined ||
          raw === ""
        ) {

          return null;

        }


        const value =
          Number(
            raw
          );


        return Number.isFinite(
          value
        )
          ? value
          : null;

      }


      /* ------------------------------------------------------
         CURRENCY
         ------------------------------------------------------ */

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
        !ticker.endsWith(".BSE")

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
          url
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
        data["Error Message"]
      ) {

        return res
          .status(404)
          .json({

            ok:
              false,

            error:
              data["Error Message"],

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
 * No PDF is used here.
 *
 * Gemini receives only:
 *
 * - locally extracted financial history
 * - market data
 * - deterministic valuation metrics
 * - annual-report analysis
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


      if (
        !market?.price
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


      const prompt = `

Interpret the following company valuation for an investor.

Use ONLY the supplied FinSight evidence.

Do not invent missing values.


============================================================
COMPANY
============================================================

${JSON.stringify(
  company || {},
  null,
  2
)}


============================================================
MARKET
============================================================

${JSON.stringify(
  market || {},
  null,
  2
)}


============================================================
FINANCIAL HISTORY
============================================================

${JSON.stringify(
  fundamentals || [],
  null,
  2
)}


============================================================
VALUATION METRICS
============================================================

${JSON.stringify(
  valuation || {},
  null,
  2
)}


============================================================
ANNUAL REPORT ANALYSIS
============================================================

${JSON.stringify(
  reportAnalysis || null,
  null,
  2
)}


============================================================
STRICT GROUNDING RULES
============================================================

Treat FINANCIAL HISTORY and VALUATION METRICS as
authoritative structured inputs.

Do not recalculate a supplied metric and substitute a
different definition.

A reported fact must come directly from:

- FINANCIAL HISTORY
- ANNUAL REPORT ANALYSIS

A calculated metric must come directly from:

- VALUATION METRICS

Never call earnings quality strong merely because
margins or accounting earnings are strong.

Earnings quality must primarily consider:

- operating cash flow
- free cash flow
- cash conversion
- working capital

If operating cash flow or free cash flow is weak
relative to profit, explicitly describe earnings
cash conversion as weak or mixed.

Do not describe a manually entered share price as a
live market quote.

Do not infer:

- sector norms
- industry cyclicality
- project pipelines
- market-share claims
- industry growth rates

unless supported by supplied annual-report evidence.

Preserve the distinction between reported EBITDA and
adjusted/non-GAAP EBITDA.

If a metric is unavailable, state that it is unavailable.

Do not estimate missing values.


============================================================
ASSESS
============================================================

Assess:

- business quality
- earnings quality
- balance-sheet quality
- valuation multiples
- earnings yield
- free-cash-flow yield where available
- leverage
- expectations implied by valuation
- assumptions that could invalidate the valuation conclusion


You may use:

"Attractive"
"Fair"
"Premium"
"Expensive"

only as evidence-supported valuation descriptions.

Do not issue personalized buy/sell advice.


============================================================
OUTPUT
============================================================

Return VALID JSON ONLY:

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
        safeJSON(
          text
        );


      if (
        !assessment ||
        typeof assessment !== "object" ||
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


      if (!company) {

        return res
          .status(400)
          .json({

            ok:
              false,

            error:
              "Company is required."

          });

      }


      if (
        !thesis ||
        !String(
          thesis
        ).trim()
      ) {

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

            String(
              companyRow.id
            ),

            String(
              thesis
            ).trim(),

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
   24. LOAD RESEARCH MEMORY
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


      return res.json({

        ok:
          true,

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


      return res.json({

        ok:
          true,

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
     * Database failure should not stop the complete FinSight
     * application from starting.
     *
     * PDF extraction and investor analysis can still operate.
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
        "Financial extraction provider: LOCAL PDF PARSER"
      );


      console.log(
        "Annual-report PDF sent to Gemini: NO"
      );


      console.log(
        "OpenAI fallback: REMOVED"
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
        "Annual-report financial extraction: LOCAL"
      );


      console.log(
        "Annual-report qualitative analysis: GEMINI TEXT"
      );


      console.log(
        "Report-grounded Q&A: GEMINI TEXT"
      );


      console.log(
        "Competitor report extraction: LOCAL + GEMINI TEXT"
      );


      console.log(
        "Competitor comparison: GEMINI TEXT"
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


