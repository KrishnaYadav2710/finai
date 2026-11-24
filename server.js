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
import OpenAI, { toFile } from "openai";

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

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY ||
  "";

const OPENAI_MODEL =
  process.env.OPENAI_MODEL ||
  "gpt-4.1-mini";

// Leave the cross-provider fallback installed; disable it explicitly while
// the OpenAI API project is unfunded. This never changes Gemini's priority.
const OPENAI_FALLBACK_ENABLED =
  String(process.env.OPENAI_FALLBACK_ENABLED ?? "true").trim().toLowerCase() !== "false";

function aiTimeoutSetting(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 15000 && value <= 300000
    ? value : fallback;
}

const GEMINI_TEXT_TIMEOUT_MS = aiTimeoutSetting("GEMINI_TEXT_TIMEOUT_MS", 60000);
const GEMINI_PDF_TIMEOUT_MS = aiTimeoutSetting("GEMINI_PDF_TIMEOUT_MS", 180000);

const openai =
  OPENAI_API_KEY
    ? new OpenAI({
        apiKey: OPENAI_API_KEY,
        timeout: 120000,
        maxRetries: 0
      })
    : null;


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
   12. GEMINI
   ============================================================ */

/*
 * FinSight AI architecture: one generation attempt per provider/model.
 * Gemini primary -> Gemini fallback -> OpenAI on temporary provider failures.
 * Text routes use aiGenerate(); PDF routes use aiGenerateWithPdf().
 * OpenAI receives its own uploaded PDF, never Gemini inlineData/fileData.
 *
 * Small PDF:
 *   PDF -> inlineData -> generateContent
 *
 * Large PDF:
 *   PDF -> Gemini Files API -> fileData -> generateContent
 *
 * FinSight itself accepts PDFs up to 45 MB.
 *
 * IMPORTANT:
 * Large PDFs must NOT be converted to base64 and embedded
 * directly inside generateContent.
 */


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


/* ============================================================
   GEMINI CONSTANTS
   ============================================================ */

/*
 * Stay comfortably below the inline request limit.
 *
 * Base64 increases payload size substantially, therefore
 * FinSight switches to Files API well before 20 MB.
 */

const GEMINI_INLINE_PDF_LIMIT =
  12 * 1024 * 1024;


/*
 * FinSight application limit.
 *
 * Must match the Multer limit.
 */

const FINSIGHT_MAX_PDF_SIZE =
  45 * 1024 * 1024;


/*
 * Files API processing timeout.
 */

const GEMINI_FILE_READY_TIMEOUT =
  120000;


/* ============================================================
   RESPONSE TEXT
   ============================================================ */

function extractGeminiText(payload) {

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
   SLEEP
   ============================================================ */

function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );

}


/* ============================================================
   GEMINI ERROR HELPERS
   ============================================================ */

/* Safe provider errors deliberately omit SDK request objects and headers. */
function redactProviderText(value) {
  let text = String(value ?? "");
  for (const secret of [
    GEMINI_API_KEY, OPENAI_API_KEY, ALPHA_VANTAGE_API_KEY,
    FINSIGHT_PASSWORD, process.env.DATABASE_URL
  ]) {
    if (secret) text = text.split(secret).join("[REDACTED]");
  }
  return text
    .replace(/\b(?:sk-|AIza)[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/(authorization["']?\s*[:=]\s*["']?)(?:Bearer|Basic)\s+[^\s"',}]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|key|password|token)\s*["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi, "$1[REDACTED]")
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[REDACTED DATABASE URL]")
    .slice(0, 2000);
}

function isAIBillingError(error) {
  const code = String(error?.providerStatus || error?.code || "").trim().toLowerCase();
  return [
    "credit_balance_exhausted", "insufficient_quota",
    "billing_hard_limit_reached", "billing_not_active"
  ].includes(code);
}

function safeAIError(error, provider) {
  const safe = new Error(redactProviderText(error?.message || `${provider} request failed.`));
  const status = Number(error?.status);
  if (Number.isInteger(status) && status >= 400 && status < 600) safe.status = status;
  safe.provider = provider;
  safe.providerStatus = redactProviderText(error?.providerStatus || error?.code || "") || null;
  const transportCodes = new Set([
    "ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"
  ]);
  const transportCode = error?.cause?.code || error?.cause?.cause?.code || error?.code;
  const isTimeout = ["TimeoutError", "AbortError", "APIConnectionTimeoutError"].includes(error?.name)
    || /TIMEOUT|ETIMEDOUT/.test(String(transportCode || ""));
  const isNetworkFailure = transportCodes.has(transportCode)
    || error?.name === "APIConnectionError"
    || (error?.name === "TypeError" && /^fetch failed$/i.test(error?.message || ""));
  if (!safe.status && (isTimeout || isNetworkFailure)) {
    safe.status = isTimeout ? 504 : 502;
    safe.providerStatus = isTimeout ? "PROVIDER_TIMEOUT" : "NETWORK_ERROR";
  }
  if (provider === "openai" && isAIBillingError(safe)) {
    safe.message = "OpenAI API credits are exhausted or the API billing quota has been reached. The service owner must check OpenAI API billing before retrying.";
  }
  // Preserve useful structured diagnostics, but never carry raw SDK objects.
  if (error?.providerDetails) {
    safe.providerDetails = redactProviderText(JSON.stringify(error.providerDetails));
  }
  return safe;
}

function isGeminiRetryableError(error) {
  const status = Number(error?.status);
  // HTTP request/auth/model errors take priority over any provider status text.
  if (status >= 400 && status < 500 && status !== 429) return false;
  const providerStatus = String(error?.providerStatus || "").trim().toUpperCase();
  return [429, 500, 502, 503, 504].includes(status)
    || ["UNAVAILABLE", "RESOURCE_EXHAUSTED", "INTERNAL"].includes(providerStatus);
}

function aiErrorHttpStatus(error) {
  const status = Number(error?.status);
  if (Number.isInteger(status) && status >= 400 && status < 600) return status;
  if (error?.message === "Gemini AI is not configured.") return 503;
  if (isGeminiRetryableError(error)) {
    return error?.providerStatus === "RESOURCE_EXHAUSTED" ? 429 : 503;
  }
  return 500;
}

/* Text only: Gemini inlineData/fileData must never reach OpenAI. */
function validateTextParts(parts) {
  if (!Array.isArray(parts) || !parts.length || parts.some(part =>
    !part || typeof part !== "object" || Array.isArray(part)
    || typeof part.text !== "string"
    || Object.keys(part).some(key => key !== "text")
  )) {
    const error = new Error("Text generation accepts text parts only; PDF/file inputs require aiGenerateWithPdf().");
    error.status = 400;
    throw error;
  }
}

async function openaiGenerate(parts, options = {}) {
  validateTextParts(parts);
  return openaiGenerateContent(
    parts.map(part => ({ type: "input_text", text: part.text })), options
  );
}

// Internal helper: callers construct only supported Responses API content.
async function openaiGenerateContent(content, { json = false, metadata } = {}) {
  if (!openai) {
    const error = new Error("OpenAI fallback is not configured.");
    error.status = 503;
    error.providerStatus = "NOT_CONFIGURED";
    throw error;
  }

  console.log(`OpenAI ${OPENAI_MODEL}: request`);
  try {
    // Responses API JSON mode uses text.format, rather than Chat Completions'
    // response_format. Existing route prompts already define the JSON shape.
    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      instructions: analystInstructions,
      input: [{
        role: "user",
        content
      }],
      ...(json ? { text: { format: { type: "json_object" } } } : {}),
      store: false
    });

    if (response.error || (response.status && response.status !== "completed")) {
      const error = new Error(response.error?.message || "OpenAI did not complete the response.");
      error.status = 502;
      error.providerStatus = response.error?.code || "INCOMPLETE_RESPONSE";
      throw error;
    }
    const text = typeof response.output_text === "string" ? response.output_text.trim() : "";
    if (!text) {
      const error = new Error("OpenAI returned no usable response.");
      error.status = 502;
      error.providerStatus = "EMPTY_RESPONSE";
      throw error;
    }
    if (metadata) Object.assign(metadata, { provider: "openai", model: response.model || OPENAI_MODEL });
    console.log(`OpenAI generation successful using ${response.model || OPENAI_MODEL}.`);
    return text;
  } catch (error) {
    const safe = safeAIError(error, "openai");
    // SDK connection/timeouts have no HTTP response; represent them as gateway failures.
    if (!safe.status && ["APIConnectionError", "APIConnectionTimeoutError"].includes(error?.name)) {
      safe.status = error.name === "APIConnectionTimeoutError" ? 504 : 502;
    }
    console.error("OpenAI generation failed:", {
      status: safe.status, providerStatus: safe.providerStatus, message: safe.message
    });
    throw safe;
  }
}

function validatePdfUpload(file) {
  if (!Buffer.isBuffer(file?.buffer) || !file.buffer.length) {
    const error = new Error("Annual-report PDF upload buffer is unavailable or empty.");
    error.status = 400;
    throw error;
  }
  // Responses PDF inputs support files below 50 MB, with 50 MB total per
  // request. One FinSight PDF of at most 45 MiB fits within both limits.
  const limit = Math.min(FINSIGHT_MAX_PDF_SIZE, 50 * 1000 * 1000);
  if (file.buffer.length > limit) {
    const error = new Error("The annual-report PDF exceeds FinSight's 45 MB upload limit.");
    error.status = 413;
    throw error;
  }
}

async function openaiGenerateWithPdf(file, prompt, options = {}) {
  validatePdfUpload(file);
  if (!openai) {
    const error = new Error("OpenAI fallback is not configured.");
    error.status = 503;
    error.providerStatus = "NOT_CONFIGURED";
    throw error;
  }
  let uploadedFileId = null;
  try {
    const filename = path.basename(String(file.originalname || "annual-report.pdf"))
      .replace(/[\x00-\x1f\x7f"]/g, " ").slice(0, 180);
    console.log("OpenAI PDF: uploading annual report for fallback.");
    const uploaded = await openai.files.create({
      purpose: "user_data",
      file: await toFile(file.buffer, /\.pdf$/i.test(filename) ? filename : "annual-report.pdf", {
        type: "application/pdf"
      }),
      // Delete in finally; expiration also bounds retention if cleanup fails.
      expires_after: { anchor: "created_at", seconds: 3600 }
    });
    uploadedFileId = uploaded.id;
    if (!uploadedFileId) {
      const error = new Error("OpenAI PDF upload returned no file ID.");
      error.status = 502;
      throw error;
    }
    return await openaiGenerateContent([
      { type: "input_text", text: prompt },
      { type: "input_file", file_id: uploadedFileId }
    ], options);
  } catch (error) {
    throw safeAIError(error, "openai");
  } finally {
    if (uploadedFileId) {
      try {
        await openai.files.delete(uploadedFileId, { timeout: 10000, maxRetries: 0 });
        console.log("OpenAI temporary PDF deleted.");
      } catch (error) {
        // Cleanup must never discard a successful analysis or hide its error.
        const safe = safeAIError(error, "openai");
        console.warn("OpenAI temporary-PDF cleanup failed; file expires automatically:", {
          status: safe.status, providerStatus: safe.providerStatus, message: safe.message
        });
      }
    }
  }
}

async function aiGenerateWithPdf(file, prompt, options = {}) {
  validatePdfUpload(file);
  try {
    return await geminiGenerateWithPdf(file, prompt, options);
  } catch (error) {
    if (!isGeminiRetryableError(error) || !OPENAI_FALLBACK_ENABLED || !openai) throw safeAIError(error, "gemini");
    // Gemini's wrapper finishes temporary-file cleanup before switching.
    // A shared Gemini upload/processing outage can occur before either model
    // can run; use the original Buffer for an independent OpenAI upload.
    console.warn("Gemini PDF processing temporarily unavailable. Switching to OpenAI...", {
      status: error.status, providerStatus: error.providerStatus
    });
    return openaiGenerateWithPdf(file, prompt, options);
  }
}

async function aiGenerate(parts, options = {}) {
  validateTextParts(parts);
  try {
    return await geminiGenerate(parts, options);
  } catch (error) {
    // A missing Gemini key, invalid request, auth failure, missing model, empty
    // response or invalid output must not silently switch providers.
    if (!isGeminiRetryableError(error) || !OPENAI_FALLBACK_ENABLED || !openai) throw safeAIError(error, "gemini");
    console.warn("Gemini models temporarily unavailable. Switching to OpenAI...", {
      status: error.status, providerStatus: error.providerStatus
    });
    return openaiGenerate(parts, options);
  }
}


function isGeminiModelUnavailable(error) {

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

    status === 404

    ||

    providerStatus ===
      "NOT_FOUND"

  );

}


/* ============================================================
   MODEL URL
   ============================================================ */

function geminiModelUrl(model) {

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
   GENERATE CONTENT
   ============================================================ */

async function geminiGenerate(
  parts,
  {
    json = false,
    metadata,
    timeoutMs = GEMINI_TEXT_TIMEOUT_MS
  } = {}
) {

  if (!GEMINI_API_KEY) {

    throw new Error(
      "Gemini AI is not configured."
    );

  }


  const primaryModel =
    String(
      GEMINI_MODEL ||
      "gemini-3.5-flash-lite"
    ).trim();


  /*
   * Current fallback.
   *
   * Render:
   *
   * GEMINI_FALLBACK_MODEL=gemini-3.8-flash
   */

  const fallbackModel =
    String(
      process.env.GEMINI_FALLBACK_MODEL ||
      "gemini-3.8-flash"
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


  /* ==========================================================
     REQUEST MODEL
     ========================================================== */

  async function requestModel(model) {
    const role = model === primaryModel ? "primary" : "fallback";
    console.log(`Gemini ${role} ${model}: request 1/1`);
    try {
      return await fetchJSON(geminiModelUrl(model), {
        ...requestOptions,
        // Bound each attempt, including response-body reading. No retries.
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (upstreamError) {
      const error = safeAIError(upstreamError, "gemini");
      console.warn(`Gemini ${role} ${model} failed:`, {
        status: error.status, providerStatus: error.providerStatus, message: error.message
      });
      throw error;
    }
  }


  /* ==========================================================
     PRIMARY + FALLBACK
     ========================================================== */

  let payload;

  let modelUsed =
    primaryModel;


  try {

    payload =
      await requestModel(primaryModel);

  }

  catch (primaryError) {

    const shouldFallback =

      isGeminiModelUnavailable(
        primaryError
      )

      ||

      isGeminiRetryableError(
        primaryError
      );


    /*
     * A genuine bad request should be preserved.
     */

    if (!shouldFallback) {

      throw primaryError;

    }


    if (
      !fallbackModel ||
      fallbackModel ===
        primaryModel
    ) {

      throw primaryError;

    }


    console.warn(

      `Gemini primary ${primaryModel} failed. ` +

      `Trying ${fallbackModel}.`

    );


    try {

      payload =
        await requestModel(fallbackModel);


      modelUsed =
        fallbackModel;

    }

    catch (fallbackError) {

      console.error(
        "Gemini primary and fallback failed:",
        {
          primaryModel,

          primaryStatus:
            primaryError?.status,

          primaryProviderStatus:
            primaryError?.providerStatus,

          primaryMessage:
            primaryError?.message,

          fallbackModel,

          fallbackStatus:
            fallbackError?.status,

          fallbackProviderStatus:
            fallbackError?.providerStatus,

          fallbackMessage:
            fallbackError?.message
        }
      );


      // Preserve the final upstream error exactly enough to classify it.
      // In particular a fallback 400/401/403/404 must never trigger OpenAI,
      // even when the primary model previously failed temporarily.
      throw safeAIError(fallbackError, "gemini");

    }

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
    `Gemini generation successful using ${modelUsed}.`
  );


  if (metadata) Object.assign(metadata, { provider: "gemini", model: modelUsed });
  return text;

}


/* ============================================================
   13. PDF INPUT / GEMINI FILES API
   ============================================================ */


/* ============================================================
   INLINE PDF
   ============================================================ */

function inlinePdfPart(file) {

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
   START GEMINI RESUMABLE FILE UPLOAD
   ============================================================ */

async function startGeminiFileUpload(file) {

  if (!GEMINI_API_KEY) {

    throw new Error(
      "Gemini AI is not configured."
    );

  }


  if (!file?.buffer) {

    throw new Error(
      "PDF upload buffer is unavailable."
    );

  }


  const size =
    file.buffer.length;


  if (
    size >
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


  const displayName =
    String(
      file.originalname ||
      "annual-report.pdf"
    )
      .replace(
        /[\r\n"]/g,
        " "
      )
      .slice(
        0,
        500
      );


  /*
   * STEP 1
   *
   * Ask Gemini for a resumable upload URL.
   */

  const startResponse =
    await fetch(

      "https://generativelanguage.googleapis.com/upload/v1beta/files",

      {

        method:
          "POST",

        headers: {

          "x-goog-api-key":
            GEMINI_API_KEY,

          "X-Goog-Upload-Protocol":
            "resumable",

          "X-Goog-Upload-Command":
            "start",

          "X-Goog-Upload-Header-Content-Length":
            String(
              size
            ),

          "X-Goog-Upload-Header-Content-Type":
            "application/pdf",

          "Content-Type":
            "application/json"

        },

        body:
          JSON.stringify({

            file: {

              display_name:
                displayName

            }

          })

      }

    );


  if (!startResponse.ok) {

    const text =
      await startResponse.text();


    const error =
      new Error(
        text ||
        `Gemini file upload initialization failed (${startResponse.status}).`
      );


    error.status =
      startResponse.status;


    throw error;

  }


  const uploadUrl =
    startResponse.headers.get(
      "x-goog-upload-url"
    );


  if (!uploadUrl) {

    throw new Error(
      "Gemini did not return a resumable file-upload URL."
    );

  }


  console.log(
    `Gemini Files API upload started: ${displayName} (${(
      size /
      1024 /
      1024
    ).toFixed(1)} MB)`
  );


  /*
   * STEP 2
   *
   * Upload actual PDF bytes and finalize.
   */

  const uploadResponse =
    await fetch(
      uploadUrl,
      {

        method:
          "POST",

        headers: {

          "Content-Length":
            String(
              size
            ),

          "X-Goog-Upload-Offset":
            "0",

          "X-Goog-Upload-Command":
            "upload, finalize",

          "Content-Type":
            "application/pdf"

        },

        body:
          file.buffer

      }
    );


  const uploadText =
    await uploadResponse.text();


  let uploadPayload =
    {};


  if (uploadText) {

    try {

      uploadPayload =
        JSON.parse(
          uploadText
        );

    }

    catch {

      uploadPayload = {
        raw:
          uploadText
      };

    }

  }


  if (!uploadResponse.ok) {

    const providerMessage =

      uploadPayload
        ?.error
        ?.message

      ||

      uploadPayload
        ?.error

      ||

      uploadPayload
        ?.raw

      ||

      `Gemini file upload failed (${uploadResponse.status}).`;


    const error =
      new Error(
        String(
          providerMessage
        )
      );


    error.status =
      uploadResponse.status;


    error.providerStatus =
      uploadPayload
        ?.error
        ?.status ||
      null;


    throw error;

  }


  const uploadedFile =
    uploadPayload?.file;


  if (
    !uploadedFile?.name ||
    !uploadedFile?.uri
  ) {

    if (uploadedFile?.name) await deleteGeminiFile(uploadedFile.name);
    throw new Error(
      "Gemini uploaded the PDF but returned incomplete file metadata."
    );

  }


  return uploadedFile;

}


/* ============================================================
   GET GEMINI FILE METADATA
   ============================================================ */

async function getGeminiFile(
  fileName
) {

  const normalizedName =
    String(
      fileName ||
      ""
    )
      .replace(
        /^\/+/,
        ""
      );


  if (!normalizedName) {

    throw new Error(
      "Gemini file name is unavailable."
    );

  }


  return fetchJSON(

    `https://generativelanguage.googleapis.com/v1beta/${normalizedName}`,

    {

      method:
        "GET",

      headers: {

        "x-goog-api-key":
          GEMINI_API_KEY

      }

    }

  );

}


/* ============================================================
   WAIT FOR FILE PROCESSING
   ============================================================ */

async function waitForGeminiFile(
  uploadedFile
) {

  const started =
    Date.now();


  let file =
    uploadedFile;


  while (
    Date.now() -
    started <
    GEMINI_FILE_READY_TIMEOUT
  ) {

    const state =
      String(
        file?.state ||
        ""
      )
        .trim()
        .toUpperCase();


    /*
     * Gemini may return ACTIVE immediately.
     */

    if (
      state === "ACTIVE"
    ) {

      console.log(
        `Gemini file ready: ${file.name}`
      );


      return file;

    }


    if (
      state === "FAILED"
    ) {

      const providerMessage =

        file
          ?.error
          ?.message

        ||

        "Gemini failed to process the uploaded PDF.";


      const error =
        new Error(
          providerMessage
        );


      error.providerStatus =
        file
          ?.error
          ?.status ||
        "FAILED";


      throw error;

    }


    /*
     * Empty state can occasionally appear directly
     * after upload. Give Gemini time to process.
     */

    await sleep(
      1500
    );


    file =
      await getGeminiFile(
        uploadedFile.name
      );

  }


  const error =
    new Error(
      "Gemini PDF processing timed out. Please try the report again."
    );


  error.status =
    503;


  error.providerStatus =
    "FILE_PROCESSING_TIMEOUT";


  throw error;

}


/* ============================================================
   DELETE TEMPORARY GEMINI FILE
   ============================================================ */

async function deleteGeminiFile(
  fileName
) {

  if (!fileName) {
    return;
  }


  try {

    const normalizedName =
      String(
        fileName
      )
        .replace(
          /^\/+/,
          ""
        );


    const response =
      await fetch(

        `https://generativelanguage.googleapis.com/v1beta/${normalizedName}`,

        {

          method:
            "DELETE",

          signal: AbortSignal.timeout(10000),

          headers: {

            "x-goog-api-key":
              GEMINI_API_KEY

          }

        }

      );


    if (
      response.ok ||
      response.status === 404
    ) {

      console.log(
        `Gemini temporary file deleted: ${normalizedName}`
      );


      return;

    }


    console.warn(
      `Could not delete Gemini temporary file ${normalizedName}: ${response.status}`
    );

  }

  catch (error) {

    /*
     * Cleanup failure must never destroy a
     * successful FinSight analysis.
     */

    console.warn(
      "Gemini temporary-file cleanup failed:",
      error?.message
    );

  }

}


/* ============================================================
   CREATE PDF PART
   ============================================================ */

/*
 * This function replaces your old synchronous pdfPart().
 *
 * IMPORTANT:
 *
 * It is async because large PDFs must first be uploaded
 * through the Gemini Files API.
 *
 * Return:
 *
 * {
 *   part,
 *   uploadedFile
 * }
 */

async function prepareGeminiPdf(file) {

  if (
    !file?.buffer
  ) {

    throw new Error(
      "Annual-report PDF is unavailable."
    );

  }


  const size =
    file.buffer.length;


  if (
    size >
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


  /*
   * SMALL PDF
   *
   * Inline is faster and avoids an extra upload request.
   */

  if (
    size <=
    GEMINI_INLINE_PDF_LIMIT
  ) {

    console.log(
      `Gemini PDF mode: inline (${(
        size /
        1024 /
        1024
      ).toFixed(1)} MB)`
    );


    return {

      part:
        inlinePdfPart(
          file
        ),

      uploadedFile:
        null

    };

  }


  /*
   * LARGE PDF
   *
   * Do NOT Base64 encode inside generateContent.
   */

  console.log(
    `Gemini PDF mode: Files API (${(
      size /
      1024 /
      1024
    ).toFixed(1)} MB)`
  );


  const uploadedFile =
    await startGeminiFileUpload(
      file
    );


  let readyFile;
  try {
    readyFile = await waitForGeminiFile(uploadedFile);
  } catch (error) {
    await deleteGeminiFile(uploadedFile.name);
    throw error;
  }


  return {

    part: {

      fileData: {

        mimeType:
          "application/pdf",

        fileUri:
          readyFile.uri

      }

    },

    uploadedFile:
      readyFile

  };

}


/* ============================================================
   RUN GEMINI WITH PDF — USED BY THE CROSS-PROVIDER PDF ROUTER
   ============================================================ */

/*
 * Use this helper everywhere a route currently does:
 *
 * geminiGenerate([
 *   { text: prompt },
 *   pdfPart(req.file)
 * ])
 *
 * It automatically chooses inline or Files API.
 */

async function geminiGenerateWithPdf(
  file,
  prompt,
  {
    json = false,
    metadata,
    timeoutMs = GEMINI_PDF_TIMEOUT_MS
  } = {}
) {

  let uploadedFile =
    null;


  try {

    const prepared =
      await prepareGeminiPdf(
        file
      );


    uploadedFile =
      prepared.uploadedFile;


    return await geminiGenerate(

      [

        {
          text:
            prompt
        },

        prepared.part

      ],

      {
        json,
        metadata,
        timeoutMs
      }

    );

  }

  catch (error) {
    throw safeAIError(error, "gemini");
  }

  finally {

    /*
     * Files API documents are temporary.
     *
     * FinSight currently needs each uploaded Gemini file
     * for only one generation call, so remove it afterwards.
     */

    if (
      uploadedFile?.name
    ) {

      await deleteGeminiFile(
        uploadedFile.name
      );

    }

  }

}



/* Deterministic financial normalization. Never use Number(null/"") as zero. */
function finiteFinancialNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  let text = value.trim();
  const negative = /^\(.+\)$/.test(text);
  if (negative) text = text.slice(1, -1).trim();
  // Accept standard Western or Indian digit grouping, without stripping
  // arbitrary punctuation, currency labels, percentages or unknown suffixes.
  if (text.includes(",")) {
    if (!/^[+-]?(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d+)?$/.test(text)) return null;
    text = text.replace(/,/g, "");
  }
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  if (negative && /^[+-]/.test(text)) return null;
  const number = Number(text) * (negative ? -1 : 1);
  return Number.isFinite(number) ? number : null;
}

function normalizeFinancialUnitsToCrore(rows) {
  if (!Array.isArray(rows)) return [];
  const monetaryFields = [
    "revenue", "ebitda", "cogs", "operating_income", "net_income",
    "total_assets", "current_assets", "current_liabilities", "total_debt",
    "cash", "total_equity", "operating_cash_flow", "capex", "inventory",
    "accounts_receivable", "accounts_payable", "finance_cost"
  ];
  const monetaryDivisors = { million: 10, lakh: 100, billion: 1, crore: 1 };
  const shareDivisors = {
    shares: 10000000, "raw shares": 10000000,
    "number of shares": 10000000, "number": 10000000,
    "thousand shares": 10000, "lakh shares": 100,
    "million shares": 10, "crore shares": 1, "billion shares": 1
  };
  return rows.filter(row => row && typeof row === "object" && !Array.isArray(row)).map(row => {
    const result = { ...row };
    const notes = [];
    if (row.financial_units_normalized_to_crore !== true) {
      result.original_source_unit = row.original_source_unit ?? row.source_unit ?? null;
      const source = String(row.source_unit || "").toLowerCase().trim();
      // Require an explicit INR currency and exactly one recognized scale.
      // USD million and ambiguous/unknown units are never relabeled INR crore.
      const unit = source
        .replace(/^(?:inr|₹|rs\.?|rupees|indian rupees)\s*(?:in\s+)?/, "")
        .replace(/s$/, "").trim();
      const isINR = /^(?:inr|₹|rs\.?|rupees|indian rupees)(?:\s|$)/.test(source)
        || source.startsWith("₹");
      const divisor = isINR && Object.hasOwn(monetaryDivisors, unit)
        ? monetaryDivisors[unit] : undefined;
      for (const field of monetaryFields) {
        const value = finiteFinancialNumber(row[field]);
        result[field] = divisor === undefined || value === null
          ? null : finiteFinancialNumber(unit === "billion" ? value * 100 : value / divisor);
      }
      result.normalized_unit = divisor === undefined ? null : "₹ crore";
      result.financial_units_normalized_to_crore = divisor !== undefined;
      if (divisor === undefined) {
        notes.push("Monetary values omitted: source currency/unit was not reliably established as INR million, lakh, billion or crore.");
      }
      // source_unit remains the report's original unit for auditability.
      // normalized_unit describes all returned monetary values.
    }
    if (row.shares_normalized_to_crore !== true) {
      result.original_shares_outstanding = row.original_shares_outstanding ?? row.shares_outstanding ?? null;
      result.original_shares_outstanding_unit = row.original_shares_outstanding_unit ?? row.shares_outstanding_unit ?? null;
      const unit = String(row.shares_outstanding_unit || "").toLowerCase().trim()
        .replace(/\s+/g, " ")
        .replace(/\b(lakhs|crores|millions|billions|thousands)\b/g, word => word.slice(0, -1));
      const divisor = Object.hasOwn(shareDivisors, unit) ? shareDivisors[unit] : undefined;
      const shares = finiteFinancialNumber(row.shares_outstanding);
      result.shares_outstanding = divisor === undefined || shares === null || shares < 0
        ? null : finiteFinancialNumber(unit === "billion shares" ? shares * 100 : shares / divisor);
      result.shares_outstanding_unit = result.shares_outstanding === null ? null : "crore shares";
      result.shares_normalized_to_crore = result.shares_outstanding !== null;
      if (row.shares_outstanding != null && result.shares_outstanding === null) {
        notes.push("Shares outstanding omitted: the share count or share unit was invalid or unknown.");
      }
    }
    if (notes.length) {
      result.extraction_notes = [row.extraction_notes, ...notes].filter(Boolean).join(" ");
    }
    return result;
  });
}


/* ============================================================
   14. FINANCIAL EXTRACTION
   ============================================================ */

app.post(
  "/api/ai/extract-financials",

  upload.single("report"),

  async (req, res) => {

    try {

      /* ------------------------------------------------------
         REQUIRE PDF
         ------------------------------------------------------ */

      if (!req.file) {

        return res
          .status(400)
          .json({
            ok: false,
            error: "Upload an annual-report PDF.",
            code: "REPORT_REQUIRED"
          });

      }


      const pdfContext =
        safeJSON(
          req.body.pdfContext
        );


      /* ------------------------------------------------------
         EXTRACTION PROMPT
         ------------------------------------------------------ */

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
- NSE code where explicitly disclosed
- BSE security code where explicitly disclosed
- reporting currency

listing_status MUST be one of:

"listed"
"unlisted"
"pre-IPO"
"proposed listing"
"unknown"


IMPORTANT:

Do NOT guess ticker or exchange.

Do NOT infer that a company is listed merely because the
report discusses an IPO, proposed listing or stock exchange.

A proposed IPO does NOT mean the company is already listed.

If the report does not establish a current public ticker,
return ticker and exchange as null.

Only return nse_code or bse_code when explicitly supported
by the annual-report evidence.


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
   annual-report presentation unless there is a clear
   evidence-based reason not to.


============================================================
FINANCIAL UNITS — CRITICAL
============================================================

Read the unit printed on the audited financial statement itself.

Return every monetary number EXACTLY AS PRINTED in the audited
financial statement.

DO NOT convert million, lakh, billion or crore values yourself.

The FinSight server performs deterministic unit conversion
after extraction.


Example 1:

If the audited statement says:

"INR million"

and revenue is:

166762

return:

"source_unit": "INR million",
"revenue": 166762

DO NOT return 16676.2.


Example 2:

If the audited statement says:

"INR billion"

and revenue is:

166.762

return:

"source_unit": "INR billion",
"revenue": 166.762

DO NOT convert it to crore.


Example 3:

If the audited statement says:

"₹ crore"

and revenue is:

16676.2

return:

"source_unit": "INR crore",
"revenue": 16676.2


All monetary values within a financial-year row must correspond
to the declared source_unit.

If different audited statements use different units and the
values cannot be represented safely under one source_unit,
do not silently convert or combine them.

Explain the issue in extraction_notes and return unsupported
fields as null.

Never change the scale of a reported number silently.

If the source unit cannot be established reliably, return the
affected monetary values as null rather than guessing.


============================================================
MISSING DATA RULE
============================================================

If a financial value cannot be reliably established:

return null.

Never use zero to represent missing information.

Zero may only be returned when the audited statement actually
reports zero.


============================================================
EXTRACT EVERY AVAILABLE REPORTING YEAR
============================================================

SOURCE PRIORITY — MANDATORY:

A. First locate the audited CONSOLIDATED Balance Sheet.

B. Locate the audited CONSOLIDATED Statement of Profit and Loss.

C. Locate the audited CONSOLIDATED Cash Flow Statement.

D. Use relevant audited notes where required.

E. Extract financial-statement numbers from those audited
   statements and notes.

F. Do NOT use the following as substitutes for audited
   consolidated financial-statement values when consolidated
   statements exist:

- Year in Review
- highlights
- investor presentation KPIs
- pre-sales
- bookings
- adjusted PAT
- adjusted EBITDA
- standalone financial statements

G. Use the exact comparative prior-year column from the newest
   audited consolidated statements for the prior year.

H. EBITDA may come from an explicitly reported consolidated
   EBITDA disclosure.

If EBITDA is adjusted/non-GAAP, clearly state this in
extraction_notes.

I. Return source_unit and source_pages for auditability.


============================================================
FINANCIAL FIELDS
============================================================

For each usable financial year extract where reliably supported:

- revenue
- EBITDA
- cost of goods sold / comparable operating cost
- operating income / EBIT
- net income appropriate for consolidated group analysis
- total assets
- current assets
- current liabilities
- total borrowings / debt
- cash and cash equivalents
- total equity
- operating cash flow
- capital expenditure
- inventory
- trade/accounts receivable
- trade/accounts payable
- finance cost
- shares outstanding


For each row identify:

- financial year
- year-end year
- statement basis
- exact source unit
- source pages when reliable
- extraction notes


============================================================
EBITDA RULE
============================================================

Use reported EBITDA when explicitly disclosed.

If EBITDA is not explicitly reported but can be reliably
calculated from disclosed audited financial information,
calculate it and clearly state that calculation in
extraction_notes.

If EBITDA cannot be established reliably, return null.

Do not substitute an adjusted operating KPI for EBITDA without
identifying it as adjusted/non-GAAP.


============================================================
SHARES OUTSTANDING RULE
============================================================

Extract PERIOD-END issued/outstanding equity shares when
reliably supported by the annual report.

IMPORTANT:

Return the RAW number exactly as supported by the report.

Also return its unit separately.


Example:

125000000 shares:

"shares_outstanding": 125000000,
"shares_outstanding_unit": "shares"


1250 lakh shares:

"shares_outstanding": 1250,
"shares_outstanding_unit": "lakh shares"


12.5 crore shares:

"shares_outstanding": 12.5,
"shares_outstanding_unit": "crore shares"


Do NOT convert shares into crore shares yourself.

The FinSight server performs deterministic conversion.

Do not confuse:

- authorized shares
- issued shares
- subscribed shares
- paid-up shares
- weighted-average EPS shares
- period-end shares outstanding

For market capitalization, period-end outstanding equity shares
are required.

If only weighted-average EPS shares are available, return:

"shares_outstanding": null,
"shares_outstanding_unit": null

If the number or unit is uncertain, return null.


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

      "source_unit": "INR million|INR lakh|INR crore|INR billion|other exact statement unit",

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
      "shares_outstanding_unit": null,

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

Do not invent missing values.

`;


      /* ------------------------------------------------------
         CALL AI PDF ROUTER
         ------------------------------------------------------ */

      const aiMetadata = {};
      const text = await aiGenerateWithPdf(req.file, prompt, {
        json: true,
        metadata: aiMetadata
      });


      const result =
        safeJSON(text);


      /* ------------------------------------------------------
         VALIDATE TOP-LEVEL RESPONSE
         ------------------------------------------------------ */

      if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        !Array.isArray(result.financials)
      ) {

        throw new Error(
          "The AI provider did not return usable financial extraction."
        );

      }


      /* ------------------------------------------------------
         NORMALIZE MONETARY UNITS

         normalizeFinancialUnitsToCrore() must convert:
         million -> crore
         lakh    -> crore
         billion -> crore
         crore   -> crore
         ------------------------------------------------------ */

      result.financials =
        normalizeFinancialUnitsToCrore(
          result.financials
        );


      /* ------------------------------------------------------
         SHARES OUTSTANDING

         normalizeFinancialUnitsToCrore() already converts shares
         exactly once and preserves the original share-unit metadata.
         ------------------------------------------------------ */


      /* ------------------------------------------------------
         REMOVE MALFORMED / EMPTY FINANCIAL ROWS
         ------------------------------------------------------ */

      result.financials =
        result.financials.filter(
          row => {

            if (
              !row ||
              typeof row !== "object"
            ) {

              return false;

            }


            const year =
              Number(
                row.year
              );


            if (
              !Number.isFinite(year) ||
              year < 1900 ||
              year > 2200
            ) {

              return false;

            }


            /*
             * Require at least one meaningful
             * financial-statement value.
             */

            const financialFields = [

              "revenue",
              "ebitda",
              "operating_income",
              "net_income",

              "total_assets",
              "total_equity",

              "operating_cash_flow"

            ];


            return financialFields.some(
              field =>
                finiteFinancialNumber(
                  row[field]
                ) != null
            );

          }
        );


      if (
        !result.financials.length
      ) {

        throw new Error(
          "The annual report was read, but no reliable financial-statement rows could be extracted."
        );

      }


      /* ------------------------------------------------------
         COMPANY OBJECT
         ------------------------------------------------------ */

      result.company =
        result.company &&
        typeof result.company === "object" &&
        !Array.isArray(result.company)

          ? result.company

          : {};


      /* ------------------------------------------------------
         LISTING STATUS VALIDATION
         ------------------------------------------------------ */

      const allowedListingStatuses =
        new Set([
          "listed",
          "unlisted",
          "pre-IPO",
          "proposed listing",
          "unknown"
        ]);


      if (
        !allowedListingStatuses.has(
          result.company.listing_status
        )
      ) {

        result.company.listing_status =
          "unknown";

      }


      /*
       * Never retain public-market identifiers when the
       * extraction does not establish that the company is
       * currently listed.
       */

      if (
        result.company.listing_status !==
        "listed"
      ) {

        result.company.ticker =
          null;

        result.company.exchange =
          null;

        result.company.nse_code =
          null;

        result.company.bse_code =
          null;

      }


      /* ------------------------------------------------------
         VALIDATION OBJECT
         ------------------------------------------------------ */

      result.validation =
        result.validation &&
        typeof result.validation === "object" &&
        !Array.isArray(result.validation)

          ? result.validation

          : {};


      result.validation.years_found =
        result.financials
          .map(
            row =>
              row.financial_year ||
              row.year
          )
          .filter(Boolean);


      if (
        !Array.isArray(
          result.validation.missing_critical_fields
        )
      ) {

        result.validation.missing_critical_fields =
          [];

      }


      if (
        !Array.isArray(
          result.validation.warnings
        )
      ) {

        result.validation.warnings =
          [];

      }


      /* ------------------------------------------------------
         SAVE EXTRACTED REPORT
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
                result.company.ticker ||
                null,

              exchange:
                result.company.exchange ||
                null,

              listingStatus:
                result.company.listing_status ||
                "unknown",

              isin:
                result.company.isin ||
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
                  financials:
                    result.financials,

                  validation:
                    result.validation,

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

        catch (databaseError) {

          /*
           * Database failure must NOT destroy a successful
           * annual-report extraction.
           */

          console.error(
            "Failed to persist financial extraction:",
            databaseError
          );


          result.validation.warnings.push(
            "Financial extraction succeeded, but the result could not be saved to research memory."
          );

        }

      }


      /* ------------------------------------------------------
         SUCCESS
         ------------------------------------------------------ */

      return res.json({

        ok: true,

        ...result,

        persisted,

        model: aiMetadata.model,
        provider: aiMetadata.provider

      });

    }


    /* ========================================================
       EXTRACTION ERROR HANDLER
       ======================================================== */

    catch (error) {

      console.error(
        "Financial extraction full error:",
        error
      );


      const upstreamStatus =
        Number.isInteger(
          error?.status
        )
          ? error.status
          : null;


      let status =
        500;


      let message =
        "FinSight could not extract reliable financial statements from this annual report.";


      let code =
        "FINANCIAL_EXTRACTION_FAILED";
/* ------------------------------------------------------
   AI PROVIDER / INPUT BAD REQUEST
   ------------------------------------------------------ */

if (
  upstreamStatus === 400
) {

  status = 400;

  code = "AI_BAD_REQUEST";


  /*
   * IMPORTANT:
   *
   * HTTP 400 from an AI provider does NOT automatically mean
   * the uploaded PDF is unreadable.
   *
   * Preserve the actual provider message so we can see
   * whether the problem is:
   *
   * - PDF payload
   * - unsupported model feature
   * - request size
   * - JSON response mode
   * - malformed provider request
   * - genuinely unreadable document
   */

  const providerMessage =
    typeof error?.message === "string"
      ? error.message.trim()
      : "";


  console.error(
    "AI provider 400 financial extraction error:",
    {
      message: providerMessage,
      status: error?.status,
      providerStatus: error?.providerStatus,
      providerDetails: error?.providerDetails
    }
  );


  if (providerMessage) {

    message =
      `AI extraction request failed: ${providerMessage}`;

  }

  else {

    message =
      "The AI provider rejected the annual-report extraction request.";

  }

}


      /* ------------------------------------------------------
         FILE TOO LARGE
         ------------------------------------------------------ */

      else if (
        upstreamStatus === 413
      ) {

        status =
          413;

        code =
          "REPORT_TOO_LARGE";

        message =
          "The annual-report file is too large to process.";

      }


      /* Billing/quota failures also use HTTP 429, but waiting alone does
       * not resolve them. Preserve 429 and report the required action. */
      else if (isAIBillingError(error)) {
        status = 429;
        code = "AI_BILLING_REQUIRED";
        message = error.message;
      }

      /* ------------------------------------------------------
         PROVIDER RATE LIMIT
         ------------------------------------------------------ */

      else if (
        upstreamStatus === 429
      ) {

        status =
          429;

        code =
          "AI_RATE_LIMIT";

        message =
          "The AI extraction service is temporarily rate-limited. Please try again shortly.";

      }


      /* ------------------------------------------------------
         PROVIDER AUTHENTICATION
         ------------------------------------------------------ */

      else if (
        upstreamStatus === 401 ||
        upstreamStatus === 403
      ) {

        status =
          503;

        code =
          "AI_AUTH_ERROR";

        message =
          "The AI extraction service is temporarily unavailable because its API credentials were rejected.";

      }


      /* ------------------------------------------------------
         PROVIDER SERVER ERROR
         ------------------------------------------------------ */

      else if (
        (upstreamStatus != null && upstreamStatus >= 500) ||
        isGeminiRetryableError(error)
      ) {

        status =
          503;

        code =
          "AI_PROVIDER_UNAVAILABLE";

        message =
          "The AI extraction provider is temporarily unavailable. Please try again.";

      }


      /* ------------------------------------------------------
         GEMINI NOT CONFIGURED
         ------------------------------------------------------ */

      else if (
        error?.message ===
        "Gemini AI is not configured."
      ) {

        status =
          503;

        code =
          "AI_NOT_CONFIGURED";

        message =
          "FinSight AI extraction is not configured on the server.";

      }


      /* ------------------------------------------------------
         SAFE APPLICATION ERROR
         ------------------------------------------------------ */

      else if (
        typeof error?.message === "string" &&
        error.message.trim()
      ) {

        const safeMessage =
          error.message.trim();


        message =
          safeMessage.length <= 500

            ? safeMessage

            : "Financial extraction failed because the AI provider returned an unexpected error.";

      }


      return res
        .status(status)
        .json({

          ok: false,

          error:
            message,

          code,

          providerStatus:
            error?.providerStatus ||
            null

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



      const aiMetadata = {};
      const text = await aiGenerateWithPdf(req.file, prompt, {
        json: true,
        metadata: aiMetadata
      });


      const analysis =
        safeJSON(text);


      if (!analysis) {

        throw new Error(
          "The AI provider returned an unreadable annual-report analysis."
        );

      }


      return res.json({

        analysis,

        model: aiMetadata.model,

        provider: aiMetadata.provider

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
        .status(aiErrorHttpStatus(error))
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
