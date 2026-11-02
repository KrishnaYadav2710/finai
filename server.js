/* ============================================================
   FINSIGHT AI — SERVER
   Gemini AI
   Alpha Vantage
   Supabase / PostgreSQL
   DCF + Reverse DCF
   Multi-Annual-Report Intelligence
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
  "gemini-2.5-flash-lite";


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


/* ============================================================
   3. DATABASE QUERY HELPER
   ============================================================ */

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
   4. DATABASE INITIALIZATION
   ============================================================ */

async function initDatabase() {

  if (!pool) {
    return;
  }


  /*
   * IMPORTANT:
   *
   * These CREATE statements are deliberately defensive.
   * They do not delete existing tables.
   */

  const statements = [

    `
    CREATE TABLE IF NOT EXISTS companies (
      id BIGSERIAL PRIMARY KEY,

      name TEXT NOT NULL,

      ticker TEXT,

      exchange TEXT DEFAULT 'NSE',

      sector TEXT,

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
   5. COMPANY HELPER
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

    const normalizedTicker =
      String(ticker)
        .trim()
        .toUpperCase();


    const normalizedExchange =
      String(exchange || "NSE")
        .trim()
        .toUpperCase();


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

          name =
            EXCLUDED.name,

          sector =
            COALESCE(
              EXCLUDED.sector,
              companies.sector
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

          sector
        ]
      );


    return result.rows[0];

  }


  /*
   * Without ticker, first try company name.
   */

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

    return existing.rows[0];

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
        name ||
        "Unknown company",

        sector
      ]
    );


  return result.rows[0];

}


/* ============================================================
   6. FILE UPLOAD
   ============================================================ */

/*
 * Memory storage allows Gemini PDF upload
 * without writing temporary files.
 *
 * 45 MB remains deliberately conservative.
 *
 * Page count is handled separately by the frontend's
 * 1,000-page PDF scanner.
 */

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
   7. EXPRESS CONFIGURATION
   ============================================================ */

app.use(
  express.json({
    limit: "10mb"
  })
);


app.use(
  express.urlencoded({
    extended: true,
    limit: "10mb"
  })
);


/* ============================================================
   8. BASIC AUTH
   ============================================================ */

function basicAuth(
  req,
  res,
  next
) {

  /*
   * Render needs an unauthenticated health check.
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

      /*
       * Fall through to challenge.
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
   9. STATIC WEBSITE
   ============================================================ */

app.use(
  express.static(
    __dirname
  )
);


/* ============================================================
   10. HOMEPAGE
   ============================================================ */

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
   11. RENDER HEALTH CHECK
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


/* ============================================================
   12. FINSIGHT HEALTH
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
        ),

      multiReportAnalysis:
        true,

      maxLocalPdfPages:
        1000

    });

  }
);


/* ============================================================
   13. FETCH JSON HELPER
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


  if (
    !response.ok
  ) {

    throw new Error(

      body?.error

      ||

      body?.message

      ||

      body?.raw

      ||

      `HTTP ${response.status}`

    );

  }


  return body;

}


/* ============================================================
   14. GEMINI SYSTEM INSTRUCTIONS
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
- auditor observations

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

only when the supplied evidence supports the assessment.

When multiple annual reports are supplied in one PDF:

- treat each reporting year separately first
- do not mix years
- do not mix standalone and consolidated figures
- prefer consolidated figures for group-level analysis
- then perform longitudinal trend analysis

Be analytical, evidence-driven and concise.

`;


/* ============================================================
   15. GEMINI RESPONSE HELPER
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
        part.text ||
        ""
    )

    .join("\n")

    .trim();

}


/* ============================================================
   16. GEMINI REQUEST
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

            temperature:
              0.15,

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
   17. SAFE JSON
   ============================================================ */

function safeJSON(
  text
) {

  if (
    !text
  ) {

    return null;

  }


  if (
    typeof text ===
    "object"
  ) {

    return text;

  }


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
   18. ANNUAL REPORT AI
   MULTI-REPORT ENABLED
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


      const isPdf =

        req.file.mimetype ===
          "application/pdf"

        ||

        req.file
          .originalname
          .toLowerCase()
          .endsWith(".pdf");


      if (!isPdf) {

        return res
          .status(400)
          .json({

            error:
              "Annual Report AI currently accepts PDF files."

          });

      }


      /* ------------------------------------------------------
         FINANCIAL CONTEXT
         ------------------------------------------------------ */

      const metrics =

        req.body.metrics

          ? safeJSON(
              req.body.metrics
            )

          : null;


      /* ------------------------------------------------------
         MULTI-REPORT CONTEXT
         ------------------------------------------------------ */

      const pdfContext =

        req.body.pdfContext

          ? safeJSON(
              req.body.pdfContext
            )

          : null;


      const detectedReports =

        Array.isArray(
          pdfContext?.reports
        )

          ? pdfContext.reports

          : [];


      const isMultiReport =
        detectedReports.length >
        1;


      console.log(

        `FinSight annual-report analysis: ${

          isMultiReport

            ? `${detectedReports.length} reports detected`

            : "single report"

        }`

      );


      /* ------------------------------------------------------
         PROMPT
         ------------------------------------------------------ */

      const prompt = `

You are FinSight AI, an evidence-first equity research analyst.

You are analyzing an annual-report PDF supplied by an investor.

The PDF may contain ONE annual report or MULTIPLE annual reports
from the same company covering different financial years.


============================================================
DOCUMENT STRUCTURE DETECTED BY FINSIGHT
============================================================

${JSON.stringify(
  pdfContext || {},
  null,
  2
)}


============================================================
MULTI-REPORT INSTRUCTIONS
============================================================

${
  isMultiReport

    ?

`FinSight detected ${detectedReports.length} annual reports in this PDF.

Detected reporting periods:

${detectedReports
  .map(
    report =>
      `${report.label}: approximately PDF pages ${report.startPage}-${report.endPage}`
  )
  .join("\n")}

Treat these as SEPARATE annual reports first.

Do not mix financial figures from different financial years.

Do not mix standalone and consolidated financial figures.

Analyze each financial year independently.

After completing the individual-year analysis,
perform a longitudinal comparison across all supplied years.`

    :

`FinSight detected one annual-report period.

Analyze the supplied annual report normally.`
}


============================================================
SOURCE PRIORITY
============================================================

For group-level investor analysis:

Prefer CONSOLIDATED financial statements when consolidated
financial statements are available.

Use standalone statements when:

- consolidated data is unavailable, or
- the standalone figure itself is analytically relevant.

Always identify whether important financial figures are:

CONSOLIDATED

or

STANDALONE.


============================================================
ANALYZE EACH FINANCIAL YEAR
============================================================

For every detected financial year investigate:


BUSINESS

- business model
- how the company makes money
- major products
- major services
- business segments
- geographic exposure
- customer concentration where disclosed
- competitive advantages
- industry conditions


GROWTH

- revenue
- revenue growth
- customer/subscriber growth
- segment growth
- new businesses
- new products
- international expansion
- acquisitions


PROFITABILITY

- EBITDA
- EBITDA margin
- operating profit
- operating margin
- net income
- net margin
- ROE
- ROCE


CASH QUALITY

- operating cash flow
- profit versus operating cash flow
- cash conversion
- capital expenditure
- free-cash-flow implications when evidence permits


WORKING CAPITAL

- receivables
- receivable days where calculable
- inventory
- inventory days where calculable
- payables
- working-capital movements


BALANCE SHEET

- total assets
- equity
- borrowings
- debt changes
- net debt where calculable
- finance costs
- interest coverage
- liquidity


CAPITAL ALLOCATION

- capital expenditure
- acquisitions
- disposals
- dividends
- buybacks
- debt repayment
- investments


MANAGEMENT

- strategy
- guidance
- targets
- promises
- expansion plans
- technology plans
- capital allocation commentary


GOVERNANCE

- board changes
- related-party transactions
- promoter relationships
- parent-company relationships
- governance observations
- whistleblower disclosures where material


AUDITOR

- audit opinion
- qualifications
- reservations
- adverse remarks
- disclaimers
- key audit matters
- internal-control observations
- audit-trail observations


RISKS

- business risks
- competitive risks
- regulatory risks
- technology risks
- leverage risks
- customer concentration
- cybersecurity
- litigation
- contingent liabilities
- related-party exposure


============================================================
CROSS-YEAR ANALYSIS
============================================================

When multiple annual reports are supplied,
compare all reporting periods.

Explicitly analyze:

1. Revenue trend

2. EBITDA trend

3. Profit trend

4. Operating-margin trend

5. EBITDA-margin trend

6. Cash-flow trend

7. Cash-conversion trend

8. Borrowing/debt trend

9. Finance-cost trend

10. Working-capital trend

11. Receivable trend

12. Inventory trend

13. ROE trend

14. ROCE trend

15. Capital-expenditure trend

16. Capital-allocation changes

17. Segment changes

18. New businesses

19. Businesses exited or sold

20. Acquisition activity

21. Auditor-observation changes

22. Governance changes

23. Related-party transaction changes

24. Contingent-liability changes

25. Risk-factor changes


============================================================
MANAGEMENT PROMISE TRACKER
============================================================

Search earlier annual reports for forward-looking management:

- statements
- targets
- plans
- strategic commitments
- customer targets
- subscriber targets
- margin targets
- debt reduction
- expansion plans
- technology deployment
- product launches
- capital expenditure
- acquisitions
- international expansion

Then search later annual reports for evidence of execution.

Classify each supported promise as:

ACHIEVED

PARTIALLY ACHIEVED

PENDING

CHANGED

NOT VERIFIABLE


Do not classify a promise as achieved unless later evidence
supports the conclusion.


============================================================
CHANGE DETECTION
============================================================

Identify:

NEW RISKS

RISKS THAT INCREASED

RISKS THAT REDUCED

RISKS THAT DISAPPEARED

NEW GROWTH DRIVERS

NEW DEBT OR FINANCING PRESSURES

NEW RELATED-PARTY EXPOSURES

NEW AUDITOR CONCERNS

IMPROVED AUDITOR OR CONTROL OBSERVATIONS

MANAGEMENT STRATEGY CHANGES


============================================================
EVIDENCE RULES
============================================================

Every material conclusion should be identifiable as:

REPORTED FACT

CALCULATED METRIC

MANAGEMENT CLAIM

AI INTERPRETATION


Never invent:

- financial values
- page numbers
- management statements
- risks
- market share
- auditor findings
- valuation multiples


If information is missing say:

"Not found in supplied report."


A financial anomaly is NOT proof of fraud.

Describe anomalies as matters requiring investor investigation.

Do not issue personalized buy/sell instructions.


============================================================
FINSIGHT CALCULATED CONTEXT
============================================================

${JSON.stringify(
  metrics || {},
  null,
  2
)}


============================================================
REQUIRED JSON OUTPUT
============================================================

Return ONLY valid JSON.

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

      "statement_basis": "Consolidated|Standalone|Mixed",

      "business_summary": "",

      "financial_summary": {
        "revenue": null,
        "ebitda": null,
        "net_income": null,
        "operating_cash_flow": null,
        "total_debt": null
      },

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


Every object inside:

good,
bad,
watch,
red_flags,
growth_drivers

must use:

{
  "title": "",
  "explanation": "",
  "evidence": [],
  "priority": "High|Medium|Low"
}


Return valid JSON only.

`;


      /* ------------------------------------------------------
         GEMINI
         ------------------------------------------------------ */

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
          "Gemini returned an unreadable structured response."
        );

      }


      /* ------------------------------------------------------
         DATABASE PERSISTENCE
         ------------------------------------------------------ */

      let persisted =
        null;


      if (pool) {

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


          const newestYear =

            Array.isArray(
              analysis.financial_years
            )

              ? Math.max(

                  ...analysis
                    .financial_years
                    .map(
                      value => {

                        const match =
                          String(value)
                            .match(
                              /20\d{2}/g
                            );

                        if (!match) {
                          return 0;
                        }

                        return Math.max(
                          ...match.map(
                            Number
                          )
                        );

                      }
                    )

                )

              : null;


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

                Number.isFinite(
                  newestYear
                ) &&
                newestYear > 0

                  ? newestYear

                  : null,

                {
                  ...(metrics || {}),

                  pdfContext:
                    pdfContext || null
                },

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


          /*
           * Save management promises extracted
           * from multi-year analysis.
           */

          if (
            Array.isArray(
              analysis
                .management_promise_tracker
            )
          ) {

            for (
              const promise of
              analysis
                .management_promise_tracker
            ) {

              if (
                !promise?.promise
              ) {
                continue;
              }


              try {

                await dbQuery(
                  `
                  INSERT INTO management_promises
                  (
                    company_id,
                    report_id,
                    promise,
                    status,
                    evidence
                  )

                  VALUES
                  (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5
                  )
                  `,
                  [
                    company.id,

                    query.rows[0].id,

                    promise.promise,

                    promise.status ||
                    "open",

                    [
                      {
                        madeInYear:
                          promise
                            .made_in_year ||
                          null,

                        laterEvidence:
                          promise
                            .later_evidence ||
                          null
                      }
                    ]
                  ]
                );

              }

              catch (
                promiseError
              ) {

                console.error(
                  "Management promise persistence warning:",
                  promiseError.message
                );

              }

            }

          }

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


      /* ------------------------------------------------------
         RESPONSE
         ------------------------------------------------------ */

      res.json({

        analysis,

        model:
          GEMINI_MODEL,

        document: {

          fileName:
            req.file
              .originalname,

          size:
            req.file.size,

          multiReport:
            isMultiReport,

          detectedReports:
            detectedReports.length,

          reports:
            detectedReports

        },

        persisted

      });

    }

    catch (
      error
    ) {

      console.error(
        "Annual Report AI:",
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
   19. ASK FINSIGHT
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

If multiple annual reports are represented in the context,
compare the relevant years when useful.

Clearly distinguish:

- reported facts
- calculated metrics
- management claims
- AI interpretation

If evidence cannot answer part of the question,
say so.

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
   20. AI COMPETITOR COMPARISON
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

Compare these two annual-report documents from a
long-term investor's perspective.

Each PDF may itself contain multiple annual reports.

When multiple reporting periods exist:

1. Analyze the latest comparable year.
2. Analyze multi-year trends.
3. Do not mix reporting periods.
4. Prefer consolidated figures for group comparisons.
5. State where comparisons are not like-for-like.

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
- red flags
- growth opportunities

Do not simply declare one company the winner.

Explain trade-offs.

Do not invent missing information.

`;


      const comparison =
        await geminiGenerate(

          [

            {
              text:
                "COMPANY A ANNUAL REPORT DOCUMENT"
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
                "COMPANY B ANNUAL REPORT DOCUMENT"
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
   21. ALPHA VANTAGE MARKET QUOTE
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


      if (!ticker) {

        return res
          .status(400)
          .json({

            error:
              "Ticker is required."

          });

      }


      /*
       * Alpha Vantage symbol mapping.
       *
       * BSE symbols often use .BSE.
       *
       * NSE coverage depends on Alpha Vantage's
       * available symbol mapping.
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
   22. ALPHA VANTAGE HISTORY
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

        .trim()

        .toUpperCase();


      const exchange =

        String(
          req.query.exchange ||
          "NSE"
        )

        .trim()

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


      if (!series) {

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
   23. AI VALUATION INTERPRETATION
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

Assess this company's valuation for educational
investor research.

Do not invent missing values.

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


VALUATION:

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
   24. DCF
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
   25. REVERSE DCF
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
   26. SAVE THESIS
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
   27. LOAD RESEARCH MEMORY
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

            error:
              "Database is not configured."

          });

      }


      const ticker =

        String(
          req.params.ticker
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
   28. SAVE VALUATION SNAPSHOT
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

      console.error(
        "Save valuation snapshot:",
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
   29. DATABASE STATUS
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
   30. 404
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
   31. ERROR HANDLER
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
   32. START FINSIGHT
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

    /*
     * Database problems should not take down
     * the whole FinSight website.
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


      console.log(
        "Multi-report annual-report analysis: YES"
      );


      console.log(
        "Frontend PDF scan limit: 1000 pages"
      );

    }

  );

}


boot();
