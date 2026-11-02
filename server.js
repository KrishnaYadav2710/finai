import "dotenv/config";

import express from "express";
import multer from "multer";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { fileURLToPath } from "node:url";

import {
  runDCF,
  reverseDCF
} from "./valuation.js";


/* ============================================================
   BASIC SETUP
   ============================================================ */

const { Pool } = pg;

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

const app =
  express();

const PORT =
  Number(
    process.env.PORT || 3000
  );

const GEMINI_MODEL =
  process.env.GEMINI_MODEL ||
  "gemini-2.5-flash-lite";

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || "";

const ALPHA_VANTAGE_API_KEY =
  process.env.ALPHA_VANTAGE_API_KEY || "";

const FINSIGHT_USERNAME =
  process.env.FINSIGHT_USERNAME || "";

const FINSIGHT_PASSWORD =
  process.env.FINSIGHT_PASSWORD || "";


/* ============================================================
   DATABASE
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
              .DATABASE_POOL_MAX || 5
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
      "Database is not configured. Add DATABASE_URL."
    );

  }

  return pool.query(
    text,
    params
  );

}


/* ============================================================
   DATABASE INITIALIZATION
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
      exchange TEXT DEFAULT 'NSE',
      sector TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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

      company_id BIGINT
        REFERENCES companies(id)
        ON DELETE CASCADE,

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

    await pool.query(
      statement
    );

  }


  console.log(
    "FinSight database ready."
  );

}


/* ============================================================
   COMPANY DATABASE HELPER
   ============================================================ */

async function upsertCompany({
  name,
  ticker,
  exchange = "NSE",
  sector = null
}) {

  if (!pool) {

    throw new Error(
      "Database is not configured."
    );

  }


  if (ticker) {

    const result =
      await dbQuery(
        `
        INSERT INTO companies
        (
          name,
          ticker,
          exchange,
          sector
        )

        VALUES
        (
          $1,
          $2,
          $3,
          $4
        )

        ON CONFLICT
        (
          ticker,
          exchange
        )

        DO UPDATE SET
          name = EXCLUDED.name,
          sector =
            COALESCE(
              EXCLUDED.sector,
              companies.sector
            ),
          updated_at = NOW()

        RETURNING *
        `,
        [
          name || ticker,
          ticker.toUpperCase(),
          exchange.toUpperCase(),
          sector
        ]
      );


    return result.rows[0];

  }


  const result =
    await dbQuery(
      `
      INSERT INTO companies
      (
        name,
        sector
      )

      VALUES
      (
        $1,
        $2
      )

      RETURNING *
      `,
      [
        name || "Unknown company",
        sector
      ]
    );


  return result.rows[0];

}


/* ============================================================
   FILE UPLOAD
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
   EXPRESS CONFIGURATION
   ============================================================ */

app.use(
  express.json({
    limit: "8mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "8mb"
  })
);


/* ============================================================
   BASIC AUTH
   ============================================================ */

function basicAuth(
  req,
  res,
  next
) {

  /*
   * Render health check stays public.
   */

  if (
    req.path === "/healthz"
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
    req.headers.authorization || "";


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

      /* Continue to auth challenge */

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
   STATIC WEBSITE
   ============================================================ */

app.use(
  express.static(
    __dirname
  )
);


/* ============================================================
   HOMEPAGE
   ============================================================ */

app.get(
  "/",
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        "finsight-investor.html"
      )
    );

  }
);


/* ============================================================
   RENDER HEALTH CHECK
   ============================================================ */

app.get(
  "/healthz",
  (req, res) => {

    res
      .status(200)
      .send("ok");

  }
);


/* ============================================================
   FINSIGHT HEALTH CHECK
   ============================================================ */

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
          "Database health check:",
          error.message
        );

      }

    }


    res.json({

      ok: true,

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

      historyConfigured:
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
        )

    });

  }
);


/* ============================================================
   GENERIC JSON FETCH
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


  const body =
    await response
      .json()
      .catch(
        () => ({})
      );


  if (
    !response.ok
  ) {

    throw new Error(

      body?.error

      ||

      body?.message

      ||

      `HTTP ${response.status}`

    );

  }


  return body;

}


/* ============================================================
   GEMINI SYSTEM INSTRUCTIONS
   ============================================================ */

const analystInstructions = `

You are FinSight AI, an evidence-first equity research copilot.

Your purpose is investor due diligence and education.

Always distinguish between:

1. Reported facts.
2. Calculated financial metrics.
3. Management claims.
4. AI interpretation.

Never invent:

- financial values
- page numbers
- citations
- market share
- management statements
- share prices
- valuation multiples

If information is unavailable, clearly say so.

Forensic signals are investigation prompts, not accusations.

Do not issue personalized buy/sell instructions.

You may assess:

- business quality
- financial quality
- management
- governance
- risks
- cash quality
- valuation

when the supplied evidence supports the assessment.

Be analytical, clear and concise.

`;


/* ============================================================
   GEMINI RESPONSE TEXT HELPER
   ============================================================ */

function extractGeminiText(
  payload
) {

  const parts =

    payload
      ?.candidates
      ?.[0]
      ?.content
      ?.parts

    || [];


  return parts

    .map(
      part =>
        part.text || ""
    )

    .join("\n")

    .trim();

}


/* ============================================================
   GEMINI REQUEST
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
      "Gemini AI is not configured. Add GEMINI_API_KEY in Render Environment."
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

            responseMimeType:
              "application/json"

          }

        : {

            temperature:
              0.2

          }

  };


  const payload =
    await fetchJSON(
      url,
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
          )

      }
    );


  const text =
    extractGeminiText(
      payload
    );


  if (
    !text
  ) {

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
   SAFE JSON
   ============================================================ */

function safeJSON(
  text
) {

  try {

    return JSON.parse(
      text
    );

  }

  catch {

    return null;

  }

}


/* ============================================================
   ANNUAL REPORT AI
   FRONTEND:
   /api/ai/analyze-report
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

      if (
        !GEMINI_API_KEY
      ) {

        return res
          .status(503)
          .json({

            error:
              "Gemini AI is not configured. Add GEMINI_API_KEY in Render."

          });

      }


      if (
        !req.file
      ) {

        return res
          .status(400)
          .json({

            error:
              "Upload an annual-report PDF."

          });

      }


      if (
        req.file.mimetype !==
          "application/pdf"

        &&

        !req.file
          .originalname
          .toLowerCase()
          .endsWith(".pdf")
      ) {

        return res
          .status(400)
          .json({

            error:
              "Annual-report AI currently accepts PDF files."

          });

      }


      const metrics =

        req.body.metrics

          ? safeJSON(
              req.body.metrics
            )

          : null;


      const prompt = `

Analyze the attached annual report as an investor due-diligence document.

Investigate:

- business model
- products/services
- segments
- geographic exposure
- revenue trajectory
- margins
- profitability
- ROE/ROCE
- operating cash flow
- cash conversion
- working capital
- receivables
- inventory
- debt
- interest coverage
- capital expenditure
- acquisitions
- management strategy
- management guidance
- auditor observations
- key audit matters
- contingent liabilities
- related-party transactions
- governance
- capital allocation
- growth drivers
- major risks

Use page references only when clearly visible and reliable.

FinSight calculated financial context:

${JSON.stringify(
  metrics || {},
  null,
  2
)}

Return ONLY valid JSON using exactly this structure:

{
  "company": "",
  "overall_view": "",
  "confidence": "High",
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

Every item inside good, bad, watch, red_flags and growth_drivers must be:

{
  "title": "",
  "explanation": "",
  "evidence": [],
  "priority": "High"
}

Priority must be High, Medium or Low.

Do not invent evidence.

`;


      const text =
        await geminiGenerate(

          [

            {
              text:
                prompt
            },

            {

              inlineData: {

                mimeType:
                  "application/pdf",

                data:
                  req.file
                    .buffer
                    .toString(
                      "base64"
                    )

              }

            }

          ],

          {
            json: true
          }

        );


      const analysis =
        safeJSON(
          text
        );


      if (
        !analysis
      ) {

        throw new Error(
          "Gemini returned an unreadable structured response."
        );

      }


      /*
       * Optional persistence
       */

      let persisted =
        null;


      if (
        pool
      ) {

        try {

          const company =
            await upsertCompany({

              name:

                analysis.company

                ||

                req.body.company

                ||

                "Unknown company",

              ticker:
                req.body.ticker ||
                null,

              exchange:
                req.body.exchange ||
                "NSE"

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


          const query =
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
                company.id,

                req.file
                  .originalname,

                req.body
                  .reportYear

                  ? Number(
                      req.body
                        .reportYear
                    )

                  : null,

                metrics || {},

                analysis,

                hash
              ]
            );


          persisted = {

            companyId:
              company.id,

            reportId:
              query.rows[0].id,

            createdAt:
              query.rows[0]
                .created_at

          };

        }

        catch (
          error
        ) {

          console.error(
            "Report persistence warning:",
            error.message
          );

        }

      }


      res.json({

        analysis,

        model:
          GEMINI_MODEL,

        persisted

      });

    }

    catch (
      error
    ) {

      console.error(
        "Annual report AI:",
        error
      );


      res
        .status(500)
        .json({

          error:

            error.message

            ||

            "AI analysis failed."

        });

    }

  }
);


/* ============================================================
   ASK FINSIGHT
   ============================================================ */

app.post(
  "/api/ai/ask",

  async (
    req,
    res
  ) => {

    try {

      if (
        !GEMINI_API_KEY
      ) {

        return res
          .status(503)
          .json({

            error:
              "Gemini AI is not configured."

          });

      }


      const {

        question,

        context,

        priorAnalysis

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


      const prompt = `

Investor question:

${question}


FINANCIAL / COMPANY CONTEXT:

${JSON.stringify(
  context || {},
  null,
  2
)}


PRIOR ANNUAL-REPORT AI ANALYSIS:

${JSON.stringify(
  priorAnalysis || {},
  null,
  2
)}


Answer using only the supplied evidence.

Clearly distinguish:

- reported facts
- calculated metrics
- management claims
- AI interpretation

If the supplied evidence cannot answer part of the question, say so.

Do not invent missing information.

`;


      const answer =
        await geminiGenerate(

          [
            {
              text:
                prompt
            }
          ]

        );


      res.json({

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


      res
        .status(500)
        .json({

          error:

            error.message

            ||

            "Question failed."

        });

    }

  }
);


/* ============================================================
   AI ANNUAL REPORT COMPARISON
   ============================================================ */

app.post(
  "/api/ai/compare",

  upload.fields(
    [

      {
        name:
          "companyA",
        maxCount:
          1
      },

      {
        name:
          "companyB",
        maxCount:
          1
      }

    ]
  ),

  async (
    req,
    res
  ) => {

    try {

      if (
        !GEMINI_API_KEY
      ) {

        return res
          .status(503)
          .json({

            error:
              "Gemini AI is not configured."

          });

      }


      const reportA =
        req.files
          ?.companyA
          ?.[0];


      const reportB =
        req.files
          ?.companyB
          ?.[0];


      if (
        !reportA ||
        !reportB
      ) {

        return res
          .status(400)
          .json({

            error:
              "Upload both annual-report PDFs."

          });

      }


      const prompt = `

Compare these two annual reports from a long-term investor's perspective.

Compare:

- business model
- competitive positioning
- revenue growth
- profitability
- margins
- ROCE
- ROE
- cash generation
- cash conversion
- leverage
- working capital
- segments
- management strategy
- management execution
- governance
- auditor issues
- capital allocation
- risks
- disclosed growth opportunities
- red flags

Normalize differences in reporting terminology and periods where possible.

Clearly state where comparisons are not like-for-like.

Do not choose a stock simply because one metric is higher.

Explain the trade-offs and what the investor should investigate further.

`;


      const comparison =
        await geminiGenerate(

          [

            {
              text:
                "COMPANY A ANNUAL REPORT"
            },

            {

              inlineData: {

                mimeType:
                  "application/pdf",

                data:
                  reportA
                    .buffer
                    .toString(
                      "base64"
                    )

              }

            },

            {
              text:
                "COMPANY B ANNUAL REPORT"
            },

            {

              inlineData: {

                mimeType:
                  "application/pdf",

                data:
                  reportB
                    .buffer
                    .toString(
                      "base64"
                    )

              }

            },

            {
              text:
                prompt
            }

          ]

        );


      res.json({

        comparison,

        model:
          GEMINI_MODEL

      });

    }

    catch (
      error
    ) {

      console.error(
        "AI comparison:",
        error
      );


      res
        .status(500)
        .json({

          error:

            error.message

            ||

            "Comparison failed."

        });

    }

  }
);


/* ============================================================
   ALPHA VANTAGE QUOTE
   FRONTEND:
   /api/market/:ticker?exchange=NSE
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

            error:
              "Alpha Vantage is not configured. Add ALPHA_VANTAGE_API_KEY in Render."

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
          "NSE"
        )

        .trim()

        .toUpperCase();


      if (
        !ticker
      ) {

        return res
          .status(400)
          .json({

            error:
              "Ticker is required."

          });

      }


      /*
       * Keep symbol logic simple.
       *
       * BSE gets .BSE suffix.
       *
       * NSE support varies by Alpha Vantage symbol coverage.
       */

      const symbol =

        exchange === "BSE"

          ? `${ticker}.BSE`

          : ticker;


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
        await fetchJSON(
          url
        );


      if (
        data.Note ||
        data.Information
      ) {

        throw new Error(

          data.Note

          ||

          data.Information

        );

      }


      const quote =
        data[
          "Global Quote"
        ]

        || {};


      const price =
        Number(
          quote[
            "05. price"
          ]
        );


      if (
        !Number.isFinite(
          price
        )
      ) {

        throw new Error(
          "Alpha Vantage did not return a usable end-of-day quote for this symbol. Try another symbol or enter the price manually."
        );

      }


      const previousClose =
        Number(
          quote[
            "08. previous close"
          ]
        );


      const asOf =
        quote[
          "07. latest trading day"
        ]

        || null;


      res.json({

        provider:
          "Alpha Vantage Free",

        ticker,

        symbol,

        exchange,

        price,

        open:

          Number(
            quote[
              "02. open"
            ]
          )

          || null,

        high:

          Number(
            quote[
              "03. high"
            ]
          )

          || null,

        low:

          Number(
            quote[
              "04. low"
            ]
          )

          || null,

        previousClose:

          Number.isFinite(
            previousClose
          )

            ? previousClose

            : null,

        volume:

          Number(
            quote[
              "06. volume"
            ]
          )

          || null,

        asOf,

        freshness:
          "end-of-day / last available trading session; not live",

        live:
          false

      });

    }

    catch (
      error
    ) {

      console.error(
        "Market quote:",
        error
      );


      res
        .status(503)
        .json({

          error:
            error.message,

          ticker:
            req.params.ticker,

          provider:
            "alphavantage",

          manualPriceAllowed:
            true

        });

    }

  }
);


/* ============================================================
   ALPHA VANTAGE HISTORY
   IMPORTANT: must come after quote behavior is distinguishable.
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
          "Alpha Vantage API key is not configured."
        );

      }


      const ticker =

        String(
          req.params.ticker
        )

        .toUpperCase();


      const exchange =

        String(
          req.query.exchange ||
          "NSE"
        )

        .toUpperCase();


      const symbol =

        exchange === "BSE"

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
        await fetchJSON(
          url
        );


      const series =
        data[
          "Time Series (Daily)"
        ];


      if (
        !series
      ) {

        throw new Error(

          data.Note

          ||

          data.Information

          ||

          "Historical series unavailable for this symbol."

        );

      }


      const rows =

        Object.entries(
          series
        )

        .map(
          ([date, values]) => ({

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
        );


      res.json({

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

      res
        .status(503)
        .json({

          error:
            error.message

        });

    }

  }
);


/* ============================================================
   AI VALUATION INTERPRETATION
   ============================================================ */

app.post(
  "/api/ai/valuation",

  async (
    req,
    res
  ) => {

    try {

      if (
        !GEMINI_API_KEY
      ) {

        return res
          .status(503)
          .json({

            error:
              "Gemini AI is not configured."

          });

      }


      const {

        company,

        market,

        fundamentals,

        valuation

      } =
        req.body || {};


      const prompt = `

Assess this company's valuation for educational investor research.

Do NOT invent missing values.

Separate:

1. Business quality.
2. Financial quality.
3. Market valuation.
4. Assumptions.
5. Risks to the valuation conclusion.

You may describe valuation as:

- Attractive
- Fair
- Premium
- Expensive

only when the supplied evidence supports it.

Do not issue a personalized buy/sell instruction.

COMPANY:

${company || "Unknown"}


MARKET DATA:

${JSON.stringify(
  market || {},
  null,
  2
)}


FUNDAMENTALS:

${JSON.stringify(
  fundamentals || {},
  null,
  2
)}


VALUATION CALCULATIONS:

${JSON.stringify(
  valuation || {},
  null,
  2
)}

Explain what assumptions could make the conclusion wrong.

`;


      const assessment =
        await geminiGenerate(

          [
            {
              text:
                prompt
            }
          ]

        );


      res.json({

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


      res
        .status(500)
        .json({

          error:

            error.message

            ||

            "Valuation analysis failed."

        });

    }

  }
);


/* ============================================================
   DCF
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


      res.json(
        result
      );

    }

    catch (
      error
    ) {

      res
        .status(400)
        .json({

          error:
            error.message

        });

    }

  }
);


/* ============================================================
   REVERSE DCF
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


      res.json(
        result
      );

    }

    catch (
      error
    ) {

      res
        .status(400)
        .json({

          error:
            error.message

        });

    }

  }
);


/* ============================================================
   SAVE THESIS
   ============================================================ */

app.post(
  "/api/thesis",

  async (
    req,
    res
  ) => {

    try {

      if (
        !pool
      ) {

        return res
          .status(503)
          .json({

            error:
              "Database is not configured. Add DATABASE_URL."

          });

      }


      const {

        company,

        ticker,

        exchange = "NSE",

        thesis,

        bullCase,

        bearCase,

        thesisBreakers = []

      } =
        req.body || {};


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

            company

            ||

            ticker

            ||

            "Unknown company",

          ticker,

          exchange

        });


      const query =
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
            companyRow.id,
            thesis,
            bullCase || null,
            bearCase || null,
            thesisBreakers
          ]
        );


      res.json({

        company:
          companyRow,

        thesis:
          query.rows[0]

      });

    }

    catch (
      error
    ) {

      console.error(
        "Save thesis:",
        error
      );


      res
        .status(500)
        .json({

          error:
            error.message

        });

    }

  }
);


/* ============================================================
   LOAD RESEARCH MEMORY
   ============================================================ */

app.get(
  "/api/research/:ticker",

  async (
    req,
    res
  ) => {

    try {

      if (
        !pool
      ) {

        return res
          .status(503)
          .json({

            error:
              "Database is not configured."

          });

      }


      const ticker =

        String(
          req.params.ticker
        )

        .toUpperCase();


      const exchange =

        String(
          req.query.exchange ||
          "NSE"
        )

        .toUpperCase();


      const companyQuery =
        await dbQuery(
          `
          SELECT *
          FROM companies
          WHERE ticker = $1
          AND exchange = $2
          LIMIT 1
          `,
          [
            ticker,
            exchange
          ]
        );


      if (
        !companyQuery.rows[0]
      ) {

        return res
          .status(404)
          .json({

            error:
              "Company not found in FinSight research memory."

          });

      }


      const company =
        companyQuery.rows[0];


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
              LIMIT 10
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


      res.json({

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


      res
        .status(500)
        .json({

          error:
            error.message

        });

    }

  }
);


/* ============================================================
   SAVE VALUATION SNAPSHOT
   ============================================================ */

app.post(
  "/api/valuation/snapshot",

  async (
    req,
    res
  ) => {

    try {

      if (
        !pool
      ) {

        return res
          .status(503)
          .json({

            error:
              "Database is not configured."

          });

      }


      const {

        company,

        ticker,

        exchange = "NSE",

        market = {},

        fundamentals = {},

        valuation = {},

        aiAssessment = null

      } =
        req.body || {};


      const companyRow =
        await upsertCompany({

          name:

            company

            ||

            ticker

            ||

            "Unknown company",

          ticker,

          exchange

        });


      const query =
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


      res.json({

        company:
          companyRow,

        snapshot:
          query.rows[0]

      });

    }

    catch (
      error
    ) {

      res
        .status(500)
        .json({

          error:
            error.message

        });

    }

  }
);


/* ============================================================
   DATABASE STATUS
   ============================================================ */

app.get(
  "/api/database/status",

  async (
    req,
    res
  ) => {

    if (
      !pool
    ) {

      return res.json({

        ok:
          true,

        configured:
          false,

        message:
          "Database-backed memory is inactive until DATABASE_URL is configured."

      });

    }


    try {

      const result =
        await dbQuery(
          "SELECT NOW() AS server_time"
        );


      res.json({

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

      res
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
   404
   ============================================================ */

app.use(
  (
    req,
    res
  ) => {

    res
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
   ERROR HANDLER
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


    res
      .status(500)
      .json({

        error:

          error.message

          ||

          "Unexpected server error."

      });

  }
);


/* ============================================================
   START FINSIGHT
   ============================================================ */

async function boot() {

  try {

    if (
      pool
    ) {

      await initDatabase();

    }

  }

  catch (
    error
  ) {

    /*
     * Don't kill the whole website if Supabase fails.
     */

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
        `Gemini configured: ${
          GEMINI_API_KEY
            ? "YES"
            : "NO"
        }`
      );


      console.log(
        `Alpha Vantage configured: ${
          ALPHA_VANTAGE_API_KEY
            ? "YES"
            : "NO"
        }`
      );


      console.log(
        `Database configured: ${
          databaseEnabled
            ? "YES"
            : "NO"
        }`
      );

    }

  );

}


boot();
