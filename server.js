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
   13. LOCAL PDF FINANCIAL EXTRACTION
   ============================================================ */

/*
 * ARCHITECTURE
 *
 * PDF
 *  ↓
 * pdf-parse
 *  ↓
 * normalized text
 *  ↓
 * deterministic statement detection
 *  ↓
 * deterministic row/value extraction
 *  ↓
 * INR crore normalization
 *  ↓
 * validated dashboard JSON
 *
 * IMPORTANT:
 *
 * - NO Gemini for financial extraction.
 * - NO OpenAI.
 * - Missing / ambiguous values => null.
 * - Never convert missing values to zero.
 * - Prefer consolidated statements.
 * - Never silently mix consolidated and standalone statements.
 */


/* ============================================================
   13A. LOCAL PDF TEXT EXTRACTION
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

  catch (error) {

    console.error(
      "pdf-parse failed:",
      error
    );


    const localError =
      new Error(
        "The annual-report PDF could not be read locally."
      );

    localError.status = 400;

    throw localError;
  }


  const text =
    String(
      parsed?.text || ""
    )
      .replace(/\u0000/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{4,}/g, "\n\n\n")
      .trim();


  if (
    text.length < 500
  ) {

    const error =
      new Error(
        "Very little searchable text could be extracted from this PDF. It may be scanned or image-based."
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
      Number(parsed?.numpages) ||
      null,

    info:
      parsed?.info ||
      {}

  };
}


/* ============================================================
   13B. TEXT NORMALIZATION
   ============================================================ */

function normalizeReportText(text) {

  return String(
    text || ""
  )
    .replace(/\u0000/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}


/* ============================================================
   13C. SAFE FINANCIAL NUMBER PARSER
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


  /*
   * Standalone accounting dash.
   *
   * Only an actual dash is interpreted as reported zero.
   */

  if (
    text === "-" ||
    text === "–" ||
    text === "—"
  ) {

    return 0;
  }


  let negative =
    false;


  /*
   * Accounting negative:
   *
   * (1,234.50)
   */

  if (
    text.startsWith("(") &&
    text.endsWith(")")
  ) {

    negative = true;

    text =
      text
        .slice(1, -1)
        .trim();
  }


  /*
   * Remove currency symbols and standard separators only.
   */

  text =
    text
      .replace(/₹/g, "")
      .replace(/\bINR\b/gi, "")
      .replace(/\bRs\.?\b/gi, "")
      .replace(/,/g, "")
      .trim();


  if (
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(
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
    ? -Math.abs(parsed)
    : parsed;
}


/* ============================================================
   13D. ACCOUNTING NUMBERS FROM A LINE
   ============================================================ */

function extractAccountingNumbers(text) {

  /*
   * Supports:
   *
   * 1,234
   * 1,234.50
   * 1234
   * 1234.50
   * (1,234)
   * (1,234.50)
   * -1234
   *
   * This deliberately avoids the malformed regex that caused:
   *
   * SyntaxError: Invalid regular expression
   */

  const source =
    String(
      text || ""
    );


  const regex =
    /\(?-?(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d+)?\)?/g;


  const matches =
    source.match(regex) ||
    [];


  return matches
    .map(
      raw => ({
        raw,
        value:
          finiteFinancialNumber(raw)
      })
    )
    .filter(
      item =>
        item.value !== null
    );
}


/* ============================================================
   13E. HEADING OCCURRENCES
   ============================================================ */

function findHeadingOccurrences(
  text,
  headings
) {

  const source =
    String(
      text || ""
    );


  const lower =
    source.toLowerCase();


  const matches =
    [];


  for (
    const heading
    of headings
  ) {

    const needle =
      String(
        heading || ""
      )
        .toLowerCase()
        .trim();


    if (!needle) {
      continue;
    }


    let position = 0;


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


      matches.push({

        index,

        heading:
          needle

      });


      position =
        index +
        needle.length;
    }

  }


  return matches.sort(
    (a, b) =>
      a.index -
      b.index
  );
}


/* ============================================================
   13F. SCORE STATEMENT CANDIDATE
   ============================================================ */

function scoreStatementCandidate(
  sample,
  index,
  totalLength,
  type
) {

  let score = 0;


  const lower =
    sample.toLowerCase();


  /*
   * Actual financial statements contain lots
   * of financial numbers.
   */

  const numericCount =
    (
      sample.match(
        /\d[\d,]*(?:\.\d+)?/g
      ) ||
      []
    ).length;


  if (
    numericCount >= 20
  ) {

    score += 4;

  }

  else if (
    numericCount >= 10
  ) {

    score += 2;

  }


  /*
   * Financial-year evidence.
   */

  if (
    /\b20\d{2}\b/.test(
      sample
    )
  ) {

    score += 2;
  }


  /*
   * Note column evidence.
   */

  if (
    /\bnotes?\b/i.test(
      sample
    )
  ) {

    score += 1;
  }


  /*
   * Statement-specific vocabulary.
   */

  if (
    type === "profit"
  ) {

    if (
      /\brevenue\b/.test(lower)
    ) {

      score += 2;
    }


    if (
      /\bprofit\b/.test(lower)
    ) {

      score += 2;
    }


    if (
      /\bfinance costs?\b/.test(lower)
    ) {

      score += 1;
    }

  }


  if (
    type === "balance"
  ) {

    if (
      /\bassets\b/.test(lower)
    ) {

      score += 2;
    }


    if (
      /\bliabilities\b/.test(lower)
    ) {

      score += 2;
    }


    if (
      /\bequity\b/.test(lower)
    ) {

      score += 1;
    }

  }


  if (
    type === "cashflow"
  ) {

    if (
      /\boperating activities\b/.test(lower)
    ) {

      score += 2;
    }


    if (
      /\binvesting activities\b/.test(lower)
    ) {

      score += 2;
    }


    if (
      /\bfinancing activities\b/.test(lower)
    ) {

      score += 2;
    }

  }


  /*
   * Table of contents normally occurs very early.
   *
   * Later occurrences receive a modest bonus.
   */

  const relative =
    totalLength > 0
      ? index / totalLength
      : 0;


  score +=
    Math.min(
      relative * 2,
      2
    );


  /*
   * Obvious TOC penalty.
   */

  if (
    /\bcontents\b/.test(lower) &&
    numericCount < 10
  ) {

    score -= 5;
  }


  return score;
}


/* ============================================================
   13G. FIND BEST STATEMENT SECTION
   ============================================================ */

function findStatementSection(
  text,
  headings,
  {
    type = "generic",
    maxLength = 90000
  } = {}
) {

  const source =
    normalizeReportText(
      text
    );


  const occurrences =
    findHeadingOccurrences(
      source,
      headings
    );


  if (
    !occurrences.length
  ) {

    return {
      found: false,
      heading: null,
      index: -1,
      text: ""
    };
  }


  let best =
    null;


  for (
    const occurrence
    of occurrences
  ) {

    const sample =
      source.slice(
        occurrence.index,
        Math.min(
          source.length,
          occurrence.index +
          maxLength
        )
      );


    const score =
      scoreStatementCandidate(
        sample.slice(
          0,
          30000
        ),
        occurrence.index,
        source.length,
        type
      );


    if (
      !best ||
      score >
      best.score
    ) {

      best = {

        ...occurrence,

        score,

        text:
          sample

      };

    }

  }


  if (!best) {

    return {
      found: false,
      heading: null,
      index: -1,
      text: ""
    };
  }


  return {

    found:
      true,

    heading:
      best.heading,

    index:
      best.index,

    score:
      best.score,

    text:
      best.text

  };
}


/* ============================================================
   13H. DETECT CONSOLIDATED / STANDALONE
   ============================================================ */

function detectStatementBasis(
  ...sections
) {

  const combined =
    sections
      .map(
        section =>
          typeof section === "string"
            ? section
            : section?.text || ""
      )
      .join("\n")
      .slice(
        0,
        30000
      )
      .toLowerCase();


  if (
    /\bconsolidated\b/.test(
      combined
    )
  ) {

    return "Consolidated";
  }


  if (
    /\bstandalone\b/.test(
      combined
    )
  ) {

    return "Standalone";
  }


  return "Unknown";
}


/* ============================================================
   13I. FINANCIAL UNIT DETECTION
   ============================================================ */
function detectFinancialUnit(section) {

  const text =
    typeof section === "string"
      ? section
      : section?.text || "";


  if (!text) {
    return null;
  }


  /*
   * Unit declarations normally occur around the statement
   * heading/header. Search a generous window but do not infer
   * a unit merely because words such as "million" occur in
   * narrative text elsewhere in the annual report.
   */

  const sample =
    String(text)
      .slice(0, 50000)
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ");


  const patterns = [

    /* ======================================================
       CRORE
       ====================================================== */

    /\b(?:inr|rs\.?|rupees?|indian rupees?)\s*(?:in\s+)?crores?\b/i,

    /₹\s*(?:in\s+)?crores?\b/i,

    /\b(?:amounts?|figures?|values?)\s+(?:are\s+)?(?:stated\s+|presented\s+|expressed\s+)?(?:in\s+)?(?:inr|rs\.?|₹)?\s*crores?\b/i,

    /\(\s*(?:inr|rs\.?|₹)?\s*(?:in\s+)?crores?\s*\)/i,


    /* ======================================================
       MILLION
       ====================================================== */

    /\b(?:inr|rs\.?|rupees?|indian rupees?)\s*(?:in\s+)?millions?\b/i,

    /₹\s*(?:in\s+)?millions?\b/i,

    /\b(?:amounts?|figures?|values?)\s+(?:are\s+)?(?:stated\s+|presented\s+|expressed\s+)?(?:in\s+)?(?:inr|rs\.?|₹)?\s*millions?\b/i,

    /\(\s*(?:inr|rs\.?|₹)?\s*(?:in\s+)?millions?\s*\)/i,

    /\b(?:inr|rs\.?|₹)\s*(?:mn|mio)\b/i,


    /* ======================================================
       LAKH
       ====================================================== */

    /\b(?:inr|rs\.?|rupees?|indian rupees?)\s*(?:in\s+)?(?:lakhs?|lacs?)\b/i,

    /₹\s*(?:in\s+)?(?:lakhs?|lacs?)\b/i,

    /\b(?:amounts?|figures?|values?)\s+(?:are\s+)?(?:stated\s+|presented\s+|expressed\s+)?(?:in\s+)?(?:inr|rs\.?|₹)?\s*(?:lakhs?|lacs?)\b/i,

    /\(\s*(?:inr|rs\.?|₹)?\s*(?:in\s+)?(?:lakhs?|lacs?)\s*\)/i,


    /* ======================================================
       BILLION
       ====================================================== */

    /\b(?:inr|rs\.?|rupees?|indian rupees?)\s*(?:in\s+)?billions?\b/i,

    /₹\s*(?:in\s+)?billions?\b/i,

    /\b(?:amounts?|figures?|values?)\s+(?:are\s+)?(?:stated\s+|presented\s+|expressed\s+)?(?:in\s+)?(?:inr|rs\.?|₹)?\s*billions?\b/i,

    /\(\s*(?:inr|rs\.?|₹)?\s*(?:in\s+)?billions?\s*\)/i,

    /\b(?:inr|rs\.?|₹)\s*bn\b/i

  ];


  /*
   * Keep the return value explicitly tied to each group.
   */

  for (let i = 0; i < patterns.length; i++) {

    if (!patterns[i].test(sample)) {
      continue;
    }


    if (i <= 3) {
      return "INR crore";
    }


    if (i <= 8) {
      return "INR million";
    }


    if (i <= 12) {
      return "INR lakh";
    }


    return "INR billion";
  }


  /* ========================================================
     SECOND PASS — LINE-BASED UNIT DECLARATIONS
     ========================================================

     Handles pdf-parse output such as:

     ₹
     in million

     or:

     INR
     Million

     without treating arbitrary narrative mentions of
     "million" as the statement unit.
     ======================================================== */

  const lines =
    sample
      .split("\n")
      .map(line =>
        line
          .replace(/\s+/g, " ")
          .trim()
      )
      .filter(Boolean);


  for (
    let i = 0;
    i < lines.length;
    i++
  ) {

    const current =
      lines[i];


    const next =
      lines[i + 1] || "";


    const combined =
      `${current} ${next}`
        .replace(/\s+/g, " ")
        .trim();


    /*
     * Require currency/unit-style context.
     */

    const hasCurrency =
      /(?:₹|\binr\b|\brs\.?\b|\brupees?\b)/i.test(
        combined
      );


    const looksLikeUnitHeader =
      hasCurrency

      ||

      /\b(?:amounts?|figures?|values?)\b/i.test(
        combined
      );


    if (!looksLikeUnitHeader) {
      continue;
    }


    if (
      /\bcrores?\b/i.test(
        combined
      )
    ) {

      return "INR crore";
    }


    if (
      /\b(?:millions?|mn|mio)\b/i.test(
        combined
      )
    ) {

      return "INR million";
    }


    if (
      /\b(?:lakhs?|lacs?)\b/i.test(
        combined
      )
    ) {

      return "INR lakh";
    }


    if (
      /\b(?:billions?|bn)\b/i.test(
        combined
      )
    ) {

      return "INR billion";
    }

  }


  /*
   * IMPORTANT:
   *
   * Never default to crore.
   *
   * An unknown unit must remain null because interpreting
   * INR million as INR crore would create a 10× error.
   */

  return null;
}


/* ============================================================
   13J. CONVERSION TO INR CRORE
   ============================================================ */

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
   13K. LABEL NORMALIZATION
   ============================================================ */

function normalizeLabelText(
  value
) {

  return String(
    value || ""
  )
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


/* ============================================================
   13L. MATCH FINANCIAL LABEL
   ============================================================ */

function lineMatchesLabel(
  line,
  labels
) {

  const normalizedLine =
    normalizeLabelText(
      line
    );


  return labels.some(
    label => {

      const normalizedLabel =
        normalizeLabelText(
          label
        );


      if (!normalizedLabel) {

        return false;
      }


      return (
        normalizedLine ===
          normalizedLabel

        ||

        normalizedLine.startsWith(
          `${normalizedLabel} `
        )

        ||

        normalizedLine.includes(
          ` ${normalizedLabel} `
        )

        ||

        normalizedLine.endsWith(
          ` ${normalizedLabel}`
        )
      );

    }
  );
}


/* ============================================================
   13M. FIND STATEMENT ROW
   ============================================================ */

function findStatementRow(
  section,
  labels
) {

  const text =
    typeof section === "string"
      ? section
      : section?.text || "";


  if (!text) {

    return null;
  }


  const lines =
    text
      .split("\n")
      .map(
        line =>
          line
            .replace(
              /\s+/g,
              " "
            )
            .trim()
      )
      .filter(Boolean);


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


    /*
     * Current line.
     */

    let numbers =
      extractAccountingNumbers(
        line
      );


    /*
     * Some PDFs separate label and values.
     *
     * Inspect up to the next two lines, but only
     * if the matched line contains no useful amount.
     */

    if (
      !numbers.length
    ) {

      for (
        let offset = 1;
        offset <= 2;
        offset++
      ) {

        if (
          index + offset >=
          lines.length
        ) {

          break;
        }


        const next =
          lines[
            index + offset
          ];


        const nextNumbers =
          extractAccountingNumbers(
            next
          );


        if (
          nextNumbers.length
        ) {

          numbers =
            nextNumbers;

          break;
        }

      }

    }


    if (
      numbers.length
    ) {

      return {

        line,

        numbers:
          numbers.map(
            item =>
              item.value
          ),

        rawNumbers:
          numbers.map(
            item =>
              item.raw
          ),

        lineIndex:
          index

      };
    }

  }


  return null;
}


/* ============================================================
   13N. REMOVE LIKELY NOTE NUMBER
   ============================================================ */

function removeLikelyNoteNumber(
  values
) {

  if (
    !Array.isArray(values)
  ) {

    return [];
  }


  const clean =
    values.filter(
      Number.isFinite
    );


  if (
    clean.length >= 3
  ) {

    const first =
      clean[0];


    /*
     * Statement format commonly:
     *
     * Revenue    25    12345    10987
     *
     * 25 = note reference.
     */

    if (
      Number.isInteger(first) &&
      first >= 1 &&
      first <= 500
    ) {

      return clean.slice(1);
    }

  }


  return clean;
}


/* ============================================================
   13O. CURRENT + COMPARATIVE VALUES
   ============================================================ */

function extractCurrentAndPrevious(
  section,
  labels
) {

  const row =
    findStatementRow(
      section,
      labels
    );


  if (!row) {

    return {

      current:
        null,

      previous:
        null,

      evidence:
        null

    };
  }


  const values =
    removeLikelyNoteNumber(
      row.numbers
    );


  if (
    !values.length
  ) {

    return {

      current:
        null,

      previous:
        null,

      evidence:
        row.line

    };
  }


  return {

    current:
      values[0] ??
      null,

    previous:
      values[1] ??
      null,

    evidence:
      row.line

  };
}


/* ============================================================
   13P. DETECT STATEMENT YEARS
   ============================================================ */

function detectStatementYears(
  ...sections
) {

  const text =
    sections
      .map(
        section =>
          typeof section === "string"
            ? section
            : section?.text || ""
      )
      .join("\n")
      .slice(
        0,
        60000
      );


  const years =
    [];


  /*
   * Plain statement column years:
   *
   * 2025 2024
   */

  for (
    const match
    of text.matchAll(
      /\b(20\d{2})\b/g
    )
  ) {

    const year =
      Number(
        match[1]
      );


    if (
      year >= 2000 &&
      year <= 2200 &&
      !years.includes(year)
    ) {

      years.push(
        year
      );
    }

  }


  /*
   * Do NOT simply use Math.max over the whole report.
   *
   * Statement sections can contain note references
   * mentioning future years.
   */

  return years.slice(
    0,
    10
  );
}


/* ============================================================
   13Q. BEST CURRENT/PREVIOUS YEAR PAIR
   ============================================================ */

function chooseStatementYearPair(
  profitLoss,
  balanceSheet,
  cashFlow
) {

  const sections = [
    profitLoss,
    balanceSheet,
    cashFlow
  ];


  const yearCounts =
    new Map();


  for (
    const section
    of sections
  ) {

    const text =
      typeof section === "string"
        ? section
        : section?.text || "";


    /*
     * Focus strongly on the beginning of each
     * statement where column headers occur.
     */

    const header =
      text.slice(
        0,
        10000
      );


    for (
      const match
      of header.matchAll(
        /\b(20\d{2})\b/g
      )
    ) {

      const year =
        Number(
          match[1]
        );


      if (
        year < 2000 ||
        year > 2200
      ) {

        continue;
      }


      yearCounts.set(
        year,
        (
          yearCounts.get(year) ||
          0
        ) +
        1
      );

    }

  }


  const ranked =
    [
      ...yearCounts.entries()
    ]
      .sort(
        (
          [yearA, countA],
          [yearB, countB]
        ) => {

          if (
            countA !== countB
          ) {

            return countB -
              countA;
          }


          return yearB -
            yearA;

        }
      )
      .map(
        ([year]) =>
          year
      );


  /*
   * Prefer consecutive years.
   */

  for (
    const year
    of ranked
  ) {

    if (
      ranked.includes(
        year - 1
      )
    ) {

      return {

        currentYear:
          year,

        previousYear:
          year - 1

      };
    }

  }


  if (
    ranked.length >= 2
  ) {

    const sorted =
      [
        ...ranked
      ].sort(
        (a, b) =>
          b - a
      );


    return {

      currentYear:
        sorted[0],

      previousYear:
        sorted[1]

    };
  }


  if (
    ranked.length === 1
  ) {

    return {

      currentYear:
        ranked[0],

      previousYear:
        null

    };
  }


  return {

    currentYear:
      null,

    previousYear:
      null

  };
}


/* ============================================================
   13R. COMPANY NAME
   ============================================================ */

function detectCompanyName(
  text,
  info = {}
) {

  const metadataCandidates = [

    info?.Title,

    info?.title,

    info?.Subject,

    info?.subject

  ];


  for (
    const candidate
    of metadataCandidates
  ) {

    const value =
      String(
        candidate || ""
      )
        .replace(
          /\s+/g,
          " "
        )
        .trim();


    if (
      value &&
      value.length >= 3 &&
      value.length <= 180 &&
      !/^(annual report|annual-report|report|document|untitled)$/i.test(
        value
      )
    ) {

      return value;
    }

  }


  const lines =
    String(
      text || ""
    )
      .split("\n")
      .map(
        line =>
          line
            .replace(
              /\s+/g,
              " "
            )
            .trim()
      )
      .filter(Boolean)
      .slice(
        0,
        250
      );


  /*
   * Strong legal-name candidates.
   */

  const companyPatterns = [

    /\b[A-Z][A-Za-z0-9&.,'() -]{2,120}\s+Limited\b/,

    /\b[A-Z][A-Za-z0-9&.,'() -]{2,120}\s+Ltd\.?\b/,

    /\b[A-Z][A-Za-z0-9&.,'() -]{2,120}\s+Private Limited\b/,

    /\b[A-Z][A-Za-z0-9&.,'() -]{2,120}\s+Corporation\b/

  ];


  for (
    const line
    of lines
  ) {

    for (
      const pattern
      of companyPatterns
    ) {

      const match =
        line.match(
          pattern
        );


      if (
        match?.[0]
      ) {

        return match[0]
          .replace(
            /\s+/g,
            " "
          )
          .trim();
      }

    }

  }


  return "Unknown company";
}


/* ============================================================
   13S. LISTING IDENTITY — ONLY EXPLICIT EVIDENCE
   ============================================================ */

function detectListingIdentity(
  text
) {

  const source =
    String(
      text || ""
    );


  let listingStatus =
    "unknown";


  /*
   * Explicit stock-exchange / listed-equity language only.
   */

  if (
    /\bshares?\s+(?:are\s+)?listed\s+on\b/i.test(
      source
    )

    ||

    /\blisted\s+(?:on|at)\s+(?:the\s+)?(?:national stock exchange|nse|bse|bombay stock exchange)\b/i.test(
      source
    )
  ) {

    listingStatus =
      "listed";
  }


  else if (
    /\bproposed\s+(?:initial public offering|ipo|listing)\b/i.test(
      source
    )
  ) {

    listingStatus =
      "proposed listing";
  }


  /*
   * ISIN can be safely extracted when explicitly printed.
   */

  const isinMatch =
    source.match(
      /\bISIN\s*[:\-]?\s*([A-Z]{2}[A-Z0-9]{9}[0-9])\b/i
    );


  const isin =
    isinMatch?.[1]
      ? isinMatch[1].toUpperCase()
      : null;


  let nseCode =
    null;


  let bseCode =
    null;


  /*
   * Only explicit labelled codes.
   */

  const nseMatch =
    source.match(
      /\b(?:NSE\s*(?:symbol|code)|NSE)\s*[:\-]\s*([A-Z0-9._-]{1,30})\b/i
    );


  if (
    nseMatch?.[1]
  ) {

    nseCode =
      nseMatch[1]
        .toUpperCase();
  }


  const bseMatch =
    source.match(
      /\b(?:BSE\s*(?:scrip|security)?\s*(?:code)?|BSE\s+code)\s*[:\-]\s*(\d{4,10})\b/i
    );


  if (
    bseMatch?.[1]
  ) {

    bseCode =
      bseMatch[1];
  }


  /*
   * Do not infer ticker/exchange from ISIN alone.
   */

  let ticker =
    null;


  let exchange =
    null;


  if (
    listingStatus ===
      "listed"
  ) {

    if (
      nseCode
    ) {

      ticker =
        nseCode;

      exchange =
        "NSE";
    }

    else if (
      bseCode
    ) {

      ticker =
        bseCode;

      exchange =
        "BSE";
    }

  }


  return {

    listing_status:
      listingStatus,

    ticker,

    exchange,

    isin,

    nse_code:
      nseCode,

    bse_code:
      bseCode

  };
}


/* ============================================================
   13T. SHARES OUTSTANDING
   ============================================================ */

function extractSharesOutstanding(
  text
) {

  const source =
    normalizeReportText(
      text
    );


  const shareSection =
    findStatementSection(
      source,
      [
        "share capital",
        "equity share capital",
        "issued subscribed and paid",
        "issued, subscribed and paid",
        "issued and paid up",
        "issued and paid-up"
      ],
      {
        type:
          "generic",

        maxLength:
          70000
      }
    );


  const section =
    shareSection.found
      ? shareSection.text
      : source;


  const lines =
    section
      .split("\n")
      .map(
        line =>
          line
            .replace(
              /\s+/g,
              " "
            )
            .trim()
      )
      .filter(Boolean);


  for (
    const line
    of lines
  ) {

    const lower =
      line.toLowerCase();


    /*
     * Reject obvious authorized-capital lines.
     */

    if (
      /\bauthori[sz]ed\b/.test(
        lower
      )
    ) {

      continue;
    }


    /*
     * Prefer issued/subscribed/paid-up/outstanding.
     */

    if (
      !(
        /\bissued\b/.test(lower) ||
        /\bsubscribed\b/.test(lower) ||
        /\bpaid[- ]?up\b/.test(lower) ||
        /\boutstanding\b/.test(lower)
      )
    ) {

      continue;
    }


    /*
     * Crore shares.
     */

    let match =
      line.match(
        /(\d[\d,]*(?:\.\d+)?)\s+crores?\s+(?:equity\s+)?shares?\b/i
      );


    if (
      match
    ) {

      const value =
        finiteFinancialNumber(
          match[1]
        );


      if (
        value !== null &&
        value > 0
      ) {

        return {

          value,

          unit:
            "crore shares",

          evidence:
            line

        };
      }

    }


    /*
     * Lakh shares.
     */

    match =
      line.match(
        /(\d[\d,]*(?:\.\d+)?)\s+lakhs?\s+(?:equity\s+)?shares?\b/i
      );


    if (
      match
    ) {

      const value =
        finiteFinancialNumber(
          match[1]
        );


      if (
        value !== null &&
        value > 0
      ) {

        return {

          value:
            value /
            100,

          unit:
            "crore shares",

          evidence:
            line

        };
      }

    }


    /*
     * Million shares.
     */

    match =
      line.match(
        /(\d[\d,]*(?:\.\d+)?)\s+millions?\s+(?:equity\s+)?shares?\b/i
      );


    if (
      match
    ) {

      const value =
        finiteFinancialNumber(
          match[1]
        );


      if (
        value !== null &&
        value > 0
      ) {

        return {

          value:
            value /
            10,

          unit:
            "crore shares",

          evidence:
            line

        };
      }

    }


    /*
     * Billion shares.
     */

    match =
      line.match(
        /(\d[\d,]*(?:\.\d+)?)\s+billions?\s+(?:equity\s+)?shares?\b/i
      );


    if (
      match
    ) {

      const value =
        finiteFinancialNumber(
          match[1]
        );


      if (
        value !== null &&
        value > 0
      ) {

        return {

          value:
            value *
            100,

          unit:
            "crore shares",

          evidence:
            line

        };
      }

    }


    /*
     * Absolute share count.
     *
     * Require at least 6 digits after comma removal
     * to avoid confusing face value or note numbers
     * with shares outstanding.
     */

    const absoluteMatches =
      [
        ...line.matchAll(
          /(\d[\d,]{5,})\s+(?:equity\s+)?shares?\b/gi
        )
      ];


    for (
      const absoluteMatch
      of absoluteMatches
    ) {

      const value =
        finiteFinancialNumber(
          absoluteMatch[1]
        );


      if (
        value !== null &&
        value >= 100000
      ) {

        return {

          value:
            value /
            10000000,

          unit:
            "crore shares",

          evidence:
            line

        };
      }

    }

  }


  return {

    value:
      null,

    unit:
      null,

    evidence:
      null

  };
}


/* ============================================================
   13U. MONEY VALUE HELPER
   ============================================================ */

function normalizeMoneyValue(
  raw,
  factor
) {

  if (
    raw === null ||
    factor === null
  ) {

    return null;
  }


  const result =
    raw *
    factor;


  return Number.isFinite(
    result
  )
    ? result
    : null;
}


/* ============================================================
   13V. EXTRACT METRIC PAIR
   ============================================================ */

function extractMetricPair(
  section,
  labels,
  factor
) {

  const values =
    extractCurrentAndPrevious(
      section,
      labels
    );


  return {

    current:
      normalizeMoneyValue(
        values.current,
        factor
      ),

    previous:
      normalizeMoneyValue(
        values.previous,
        factor
      ),

    evidence:
      values.evidence

  };
}


/* ============================================================
   13W. MAIN LOCAL FINANCIAL EXTRACTOR
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
        "No searchable annual-report text is available."
      );

    error.status = 422;

    throw error;
  }


  /* ----------------------------------------------------------
     FIND PROFIT AND LOSS
     ---------------------------------------------------------- */

  const profitLoss =
    findStatementSection(
      text,
      [
        "consolidated statement of profit and loss",
        "consolidated statement of profit & loss",
        "consolidated profit and loss account",
        "consolidated statement of income",
        "consolidated income statement",
        "statement of consolidated income",
        "statement of profit and loss",
        "statement of profit & loss"
      ],
      {
        type:
          "profit",

        maxLength:
          90000
      }
    );


  /* ----------------------------------------------------------
     FIND BALANCE SHEET
     ---------------------------------------------------------- */

  const balanceSheet =
    findStatementSection(
      text,
      [
        "consolidated balance sheet",
        "consolidated statement of financial position",
        "statement of consolidated financial position",
        "balance sheet",
        "statement of financial position"
      ],
      {
        type:
          "balance",

        maxLength:
          90000
      }
    );


  /* ----------------------------------------------------------
     FIND CASH FLOW
     ---------------------------------------------------------- */

  const cashFlow =
    findStatementSection(
      text,
      [
        "consolidated statement of cash flows",
        "consolidated statement of cash flow",
        "consolidated cash flow statement",
        "statement of cash flows",
        "statement of cash flow",
        "cash flow statement"
      ],
      {
        type:
          "cashflow",

        maxLength:
          100000
      }
    );


  console.log(
    "Local statement detection:",
    {
      profitLoss:
        profitLoss.found,

      balanceSheet:
        balanceSheet.found,

      cashFlow:
        cashFlow.found,

      profitHeading:
        profitLoss.heading,

      balanceHeading:
        balanceSheet.heading,

      cashHeading:
        cashFlow.heading
    }
  );


  /* ----------------------------------------------------------
     STATEMENT BASIS
     ---------------------------------------------------------- */

  const statementBasis =
    detectStatementBasis(
      profitLoss,
      balanceSheet,
      cashFlow
    );


  /* ----------------------------------------------------------
     UNIT
     ---------------------------------------------------------- */

  const unitCandidates = [

    detectFinancialUnit(
      profitLoss
    ),

    detectFinancialUnit(
      balanceSheet
    ),

    detectFinancialUnit(
      cashFlow
    )

  ].filter(Boolean);


  /*
   * Require a consistent unit when several
   * statements explicitly disclose units.
   */

  const uniqueUnits =
    [
      ...new Set(
        unitCandidates
      )
    ];


  let sourceUnit =
    null;


  if (
    uniqueUnits.length === 1
  ) {

    sourceUnit =
      uniqueUnits[0];
  }


  else if (
    uniqueUnits.length === 0
  ) {

    /*
     * Last-resort global unit detection.
     *
     * This is accepted only when the document provides
     * an explicit recognizable INR scale.
     */

    sourceUnit =
      detectFinancialUnit(
        text
      );
  }


  const factor =
    monetaryCroreFactor(
      sourceUnit
    );


  console.log(
    "Local financial unit:",
    {
      unitCandidates,
      sourceUnit,
      factor
    }
  );


  /* ----------------------------------------------------------
     YEARS
     ---------------------------------------------------------- */

  const yearPair =
    chooseStatementYearPair(
      profitLoss,
      balanceSheet,
      cashFlow
    );


  const currentYear =
    yearPair.currentYear;


  const previousYear =
    yearPair.previousYear;


  /* ----------------------------------------------------------
     PROFIT & LOSS METRICS
     ---------------------------------------------------------- */

  const revenue =
    extractMetricPair(
      profitLoss,
      [
        "revenue from operations",
        "revenue from operation",
        "revenue from contracts with customers",
        "total revenue",
        "revenue"
      ],
      factor
    );


  const operatingIncome =
    extractMetricPair(
      profitLoss,
      [
        "operating profit",
        "profit from operations",
        "profit before finance costs and tax",
        "profit before finance cost and tax",
        "earnings before interest and tax",
        "ebit"
      ],
      factor
    );


  const netIncome =
    extractMetricPair(
      profitLoss,
      [
        "profit for the year",
        "profit for the period",
        "profit after tax",
        "profit after taxation",
        "net profit"
      ],
      factor
    );


  const financeCost =
    extractMetricPair(
      profitLoss,
      [
        "finance costs",
        "finance cost",
        "finance expenses",
        "interest expense"
      ],
      factor
    );


  const ebitda =
    extractMetricPair(
      profitLoss,
      [
        "earnings before interest tax depreciation and amortisation",
        "earnings before interest taxes depreciation and amortization",
        "ebitda"
      ],
      factor
    );


  /* ----------------------------------------------------------
     BALANCE SHEET METRICS
     ---------------------------------------------------------- */

  const totalAssets =
    extractMetricPair(
      balanceSheet,
      [
        "total assets"
      ],
      factor
    );


  const currentAssets =
    extractMetricPair(
      balanceSheet,
      [
        "total current assets",
        "current assets"
      ],
      factor
    );


  const currentLiabilities =
    extractMetricPair(
      balanceSheet,
      [
        "total current liabilities",
        "current liabilities"
      ],
      factor
    );


  const totalEquity =
    extractMetricPair(
      balanceSheet,
      [
        "total equity",
        "total shareholders equity",
        "shareholders equity",
        "equity attributable to owners",
        "equity attributable to shareholders"
      ],
      factor
    );


  const cash =
    extractMetricPair(
      balanceSheet,
      [
        "cash and cash equivalents",
        "cash and cash equivalent",
        "cash & cash equivalents"
      ],
      factor
    );


  const inventory =
    extractMetricPair(
      balanceSheet,
      [
        "inventories",
        "inventory"
      ],
      factor
    );


  const receivables =
    extractMetricPair(
      balanceSheet,
      [
        "trade receivables",
        "trade and other receivables",
        "accounts receivable"
      ],
      factor
    );


  const payables =
    extractMetricPair(
      balanceSheet,
      [
        "trade payables",
        "trade and other payables",
        "accounts payable"
      ],
      factor
    );


  /*
   * Borrowings are difficult because current and
   * non-current borrowings can appear separately.
   *
   * Do NOT fabricate total debt by blindly selecting
   * one "borrowings" row.
   *
   * Only accept an explicitly labelled total.
   */

  const totalDebt =
    extractMetricPair(
      balanceSheet,
      [
        "total borrowings",
        "total debt",
        "total interest bearing borrowings",
        "total interest-bearing borrowings"
      ],
      factor
    );


  /* ----------------------------------------------------------
     CASH FLOW METRICS
     ---------------------------------------------------------- */

  const operatingCashFlow =
    extractMetricPair(
      cashFlow,
      [
        "net cash generated from operating activities",
        "net cash generated by operating activities",
        "net cash from operating activities",
        "net cash flows from operating activities",
        "net cash flow from operating activities"
      ],
      factor
    );


  const capexRaw =
    extractMetricPair(
      cashFlow,
      [
        "purchase of property plant and equipment",
        "purchase of property, plant and equipment",
        "payments for property plant and equipment",
        "payments for property, plant and equipment",
        "purchase of fixed assets",
        "capital expenditure"
      ],
      factor
    );


  const capex = {

    current:
      capexRaw.current === null
        ? null
        : Math.abs(
            capexRaw.current
          ),

    previous:
      capexRaw.previous === null
        ? null
        : Math.abs(
            capexRaw.previous
          ),

    evidence:
      capexRaw.evidence

  };


  /* ----------------------------------------------------------
     SHARES
     ---------------------------------------------------------- */

  const shares =
    extractSharesOutstanding(
      text
    );


  /* ----------------------------------------------------------
     COMPANY IDENTITY
     ---------------------------------------------------------- */

  const companyName =
    detectCompanyName(
      text,
      pdfData?.info ||
      {}
    );


  const listing =
    detectListingIdentity(
      text
    );


  /* ----------------------------------------------------------
     BUILD ROW
     ---------------------------------------------------------- */

  function buildRow(
    which,
    year
  ) {

    if (!year) {

      return null;
    }


    const financialYear =
      `FY${year - 1}-${String(year).slice(-2)}`;


    return {

      company:
        companyName,

      financial_year:
        financialYear,

      year,

      statement_basis:
        statementBasis,

      /*
       * Dashboard values are normalized.
       */

      source_unit:
        factor === null
          ? null
          : "INR crore",

      original_source_unit:
        sourceUnit,

      revenue:
        revenue[which],

      ebitda:
        ebitda[which],

      cogs:
        null,

      operating_income:
        operatingIncome[which],

      net_income:
        netIncome[which],

      total_assets:
        totalAssets[which],

      current_assets:
        currentAssets[which],

      current_liabilities:
        currentLiabilities[which],

      total_debt:
        totalDebt[which],

      cash:
        cash[which],

      total_equity:
        totalEquity[which],

      operating_cash_flow:
        operatingCashFlow[which],

      capex:
        capex[which],

      inventory:
        inventory[which],

      accounts_receivable:
        receivables[which],

      accounts_payable:
        payables[which],

      finance_cost:
        financeCost[which],

      /*
       * Share extraction currently represents
       * period-end/current report evidence.
       *
       * Do not copy it into the comparative year.
       */

      shares_outstanding:
        which === "current"
          ? shares.value
          : null,

      shares_outstanding_unit:
        which === "current"
          ? shares.unit
          : null,

      source_pages:
        [],

      extraction_notes:
        ""

    };
  }


  const rows =
    [];


  const currentRow =
    buildRow(
      "current",
      currentYear
    );


  if (
    currentRow
  ) {

    rows.push(
      currentRow
    );
  }


  const previousRow =
    buildRow(
      "previous",
      previousYear
    );


  if (
    previousRow
  ) {

    rows.push(
      previousRow
    );
  }


  /* ----------------------------------------------------------
     REMOVE EMPTY ROWS
     ---------------------------------------------------------- */

  const meaningfulFields = [

    "revenue",
    "ebitda",
    "operating_income",
    "net_income",
    "total_assets",
    "current_assets",
    "current_liabilities",
    "total_equity",
    "operating_cash_flow",
    "cash"

  ];


  const usableRows =
    rows.filter(
      row =>
        meaningfulFields.some(
          field =>
            Number.isFinite(
              row[field]
            )
        )
    );


  /* ----------------------------------------------------------
     EXTRACTION NOTES / WARNINGS
     ---------------------------------------------------------- */

  const warnings =
    [];


  if (
    !profitLoss.found
  ) {

    warnings.push(
      "Consolidated profit-and-loss statement could not be located reliably."
    );
  }


  if (
    !balanceSheet.found
  ) {

    warnings.push(
      "Consolidated balance sheet could not be located reliably."
    );
  }


  if (
    !cashFlow.found
  ) {

    warnings.push(
      "Consolidated cash-flow statement could not be located reliably."
    );
  }


  if (
    factor === null
  ) {

    warnings.push(
      "The audited monetary unit could not be established consistently. Monetary values were not guessed."
    );
  }


  if (
    ebitda.current === null
  ) {

    warnings.push(
      "EBITDA was not explicitly identified and was left null."
    );
  }


  if (
    totalDebt.current === null
  ) {

    warnings.push(
      "Total debt was not explicitly identified. FinSight did not treat a single current/non-current borrowing line as total debt."
    );
  }


  if (
    shares.value === null
  ) {

    warnings.push(
      "Period-end shares outstanding could not be established reliably and were left null."
    );
  }


  if (
    statementBasis !==
      "Consolidated"
  ) {

    warnings.push(
      "Consolidated statement basis could not be confirmed automatically."
    );
  }


  for (
    const row
    of usableRows
  ) {

    row.extraction_notes =
      warnings.join(" ");
  }


  /* ----------------------------------------------------------
     REQUIRE RELIABLE DATA
     ---------------------------------------------------------- */

  if (
    !usableRows.length
  ) {

    const error =
      new Error(
        "The PDF text was extracted successfully, but FinSight could not reliably identify financial-statement values without guessing."
      );

    error.status = 422;

    throw error;
  }


  /* ----------------------------------------------------------
     MISSING CRITICAL FIELDS
     ---------------------------------------------------------- */

  const latest =
    usableRows[0];


  const criticalFields = [

    "revenue",
    "net_income",
    "total_assets",
    "total_equity",
    "operating_cash_flow"

  ];


  const missingCriticalFields =
    criticalFields.filter(
      field =>
        latest[field] === null ||
        latest[field] === undefined
    );


  /* ----------------------------------------------------------
     CONFIDENCE
     ---------------------------------------------------------- */

  let confidence =
    "Low";


  if (
    statementBasis === "Consolidated" &&
    factor !== null &&
    profitLoss.found &&
    balanceSheet.found &&
    usableRows.length
  ) {

    confidence =
      cashFlow.found
        ? "High"
        : "Medium";
  }


  else if (
    usableRows.length &&
    factor !== null
  ) {

    confidence =
      "Medium";
  }


  return {

    company: {

      name:
        companyName,

      legal_name:
        companyName,

      ...listing,

      currency:
        "₹",

      extraction_confidence:
        confidence

    },


    financials:
      usableRows,


    validation: {

      consolidated_preferred:
        true,

      statement_basis:
        statementBasis,

      original_source_unit:
        sourceUnit,

      normalized_unit:
        factor === null
          ? null
          : "INR crore",

      years_found:
        usableRows.map(
          row =>
            row.financial_year
        ),

      missing_critical_fields:
        missingCriticalFields,

      warnings,

      statements_found: {

        profit_and_loss:
          profitLoss.found,

        balance_sheet:
          balanceSheet.found,

        cash_flow:
          cashFlow.found

      }

    }

  };
}


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


