import "dotenv/config";

import express from "express";
import path from "path";
import fs from "fs";
import multer from "multer";
import pg from "pg";

import { fileURLToPath } from "url";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = process.env.PORT || 3000;

// ============================================================
// BASIC CONFIGURATION
// ============================================================

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// Serve FinSight files such as CSS, JS, XLSX samples, etc.
app.use(express.static(__dirname));

// Temporary PDF uploads
const upload = multer({
  dest: path.join(__dirname, "uploads"),
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

// Make sure upload folder exists
const uploadDirectory = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDirectory)) {
  fs.mkdirSync(uploadDirectory, { recursive: true });
}


// ============================================================
// OPTIONAL BASIC PASSWORD PROTECTION
// ============================================================

const FINSIGHT_USERNAME = process.env.FINSIGHT_USERNAME;
const FINSIGHT_PASSWORD = process.env.FINSIGHT_PASSWORD;

function basicAuth(req, res, next) {
  // If username/password aren't configured,
  // allow access without authentication.
  if (!FINSIGHT_USERNAME || !FINSIGHT_PASSWORD) {
    return next();
  }

  // Keep health endpoint public for Render.
  if (req.path === "/healthz") {
    return next();
  }

  const auth = req.headers.authorization;

  if (!auth || !auth.startsWith("Basic ")) {
    res.setHeader(
      "WWW-Authenticate",
      'Basic realm="FinSight Investor Research"'
    );

    return res.status(401).send("Authentication required.");
  }

  try {
    const encoded = auth.split(" ")[1];

    const decoded = Buffer.from(encoded, "base64").toString("utf8");

    const separator = decoded.indexOf(":");

    const username = decoded.substring(0, separator);
    const password = decoded.substring(separator + 1);

    if (
      username === FINSIGHT_USERNAME &&
      password === FINSIGHT_PASSWORD
    ) {
      return next();
    }

    res.setHeader(
      "WWW-Authenticate",
      'Basic realm="FinSight Investor Research"'
    );

    return res.status(401).send("Invalid username or password.");
  } catch (error) {
    return res.status(401).send("Authentication failed.");
  }
}

app.use(basicAuth);


// ============================================================
// HOMEPAGE FIX
// ============================================================

// This fixes:
//
// Cannot GET /
//
// Visiting your Render URL now opens FinSight automatically.

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "finsight-investor.html")
  );
});


// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/healthz", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "FinSight AI",
    status: "running",
    timestamp: new Date().toISOString(),

    aiConfigured: Boolean(process.env.GEMINI_API_KEY),

    marketDataConfigured: Boolean(
      process.env.ALPHA_VANTAGE_API_KEY
    ),

    databaseConfigured: Boolean(
      process.env.DATABASE_URL
    )
  });
});


// ============================================================
// CONFIGURATION STATUS
// ============================================================

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,

    ai: {
      provider: "gemini",
      configured: Boolean(process.env.GEMINI_API_KEY),
      model:
        process.env.GEMINI_MODEL ||
        "gemini-2.5-flash-lite"
    },

    marketData: {
      provider: "alpha_vantage",
      configured: Boolean(
        process.env.ALPHA_VANTAGE_API_KEY
      ),
      type: "last-available / delayed / end-of-day"
    },

    database: {
      configured: Boolean(process.env.DATABASE_URL)
    }
  });
});


// ============================================================
// GEMINI HELPER
// ============================================================

async function callGemini({
  prompt,
  pdfBuffer = null,
  mimeType = "application/pdf"
}) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured on the server."
    );
  }

  const model =
    process.env.GEMINI_MODEL ||
    "gemini-2.5-flash-lite";

  const parts = [];

  if (pdfBuffer) {
    parts.push({
      inline_data: {
        mime_type: mimeType,
        data: pdfBuffer.toString("base64")
      }
    });
  }

  parts.push({
    text: prompt
  });

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts
          }
        ],

        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json"
        }
      })
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Gemini API error ${response.status}: ${text}`
    );
  }

  const data = JSON.parse(text);

  const output =
    data?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("") || "";

  if (!output) {
    throw new Error(
      "Gemini returned an empty response."
    );
  }

  try {
    return JSON.parse(output);
  } catch {
    return {
      raw: output
    };
  }
}


// ============================================================
// ANNUAL REPORT AI
// ============================================================

app.post(
  "/api/analyze-report",
  upload.single("report"),
  async (req, res) => {
    let uploadedPath;

    try {
      if (!req.file) {
        return res.status(400).json({
          error: "Please upload an annual-report PDF."
        });
      }

      uploadedPath = req.file.path;

      const pdfBuffer = fs.readFileSync(uploadedPath);

      const prompt = `
You are FinSight AI, an evidence-first investment research analyst.

Analyze the attached company annual report.

Your job is NOT to tell the investor to buy or sell the stock.

Your job is to help the investor understand the company before making their own decision.

Return VALID JSON ONLY.

Use this structure:

{
  "company": "",
  "financial_year": "",
  "overall_view": "",

  "business_summary": {
    "what_company_does": "",
    "how_it_makes_money": "",
    "major_products_services": [],
    "major_segments": [],
    "geographic_exposure": [],
    "key_cost_drivers": []
  },

  "good": [
    {
      "title": "",
      "explanation": "",
      "evidence": ""
    }
  ],

  "bad": [
    {
      "title": "",
      "explanation": "",
      "evidence": ""
    }
  ],

  "watch": [
    {
      "title": "",
      "explanation": "",
      "evidence": ""
    }
  ],

  "red_flags": [
    {
      "severity": "low|medium|high",
      "title": "",
      "explanation": "",
      "evidence": ""
    }
  ],

  "growth_drivers": [],

  "risks": [],

  "management": {
    "strategy": "",
    "guidance": [],
    "capital_allocation": "",
    "execution_observations": []
  },

  "governance": {
    "assessment": "",
    "observations": []
  },

  "auditor": {
    "opinion": "",
    "key_audit_matters": [],
    "qualifications": [],
    "concerns": []
  },

  "segments": [],

  "capital_allocation": {
    "capex": "",
    "dividends": "",
    "debt": "",
    "acquisitions": "",
    "buybacks": ""
  },

  "contingent_liabilities": [],

  "related_party_observations": [],

  "investor_questions": [],

  "confidence": "low|medium|high"
}

RULES:

1. Do not invent financial numbers.

2. Do not invent page numbers.

3. If something cannot be found, say "Not found in supplied report".

4. Separate company/management claims from your interpretation.

5. A financial anomaly is not proof of fraud.

6. Red flags should be described as items requiring investigation.

7. Focus on information useful to a long-term investor.

8. Be especially alert to:
   - cash flow versus profit
   - receivables
   - inventory
   - leverage
   - interest cost
   - related-party transactions
   - contingent liabilities
   - auditor observations
   - promoter/governance issues
   - acquisitions
   - capex
   - segment concentration
   - management guidance

9. Return JSON only.
`;

      const analysis = await callGemini({
        prompt,
        pdfBuffer
      });

      return res.json({
        ok: true,
        fileName: req.file.originalname,
        analysis
      });

    } catch (error) {
      console.error(
        "Annual report analysis error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Annual report analysis failed."
      });

    } finally {
      if (
        uploadedPath &&
        fs.existsSync(uploadedPath)
      ) {
        try {
          fs.unlinkSync(uploadedPath);
        } catch {}
      }
    }
  }
);


// ============================================================
// ASK FINSIGHT AI
// ============================================================

app.post("/api/ask", async (req, res) => {
  try {
    const {
      question,
      company,
      financialContext,
      reportAnalysis,
      valuationContext
    } = req.body || {};

    if (!question) {
      return res.status(400).json({
        error: "Question is required."
      });
    }

    const prompt = `
You are FinSight AI, an investor research copilot.

Answer the investor's question using ONLY the supplied company context.

Do not invent missing financial information.

Do not provide an unconditional buy/sell instruction.

Clearly distinguish:
- reported fact
- calculated metric
- management claim
- AI interpretation

COMPANY:
${company || "Unknown"}

FINANCIAL CONTEXT:
${JSON.stringify(financialContext || {}, null, 2)}

ANNUAL REPORT ANALYSIS:
${JSON.stringify(reportAnalysis || {}, null, 2)}

VALUATION CONTEXT:
${JSON.stringify(valuationContext || {}, null, 2)}

INVESTOR QUESTION:
${question}

Return valid JSON:

{
  "answer": "",
  "key_points": [],
  "risks": [],
  "evidence": [],
  "what_to_investigate_next": []
}
`;

    const answer = await callGemini({
      prompt
    });

    return res.json({
      ok: true,
      answer
    });

  } catch (error) {
    console.error("Ask FinSight error:", error);

    return res.status(500).json({
      ok: false,
      error:
        error.message ||
        "FinSight AI could not answer the question."
    });
  }
});


// ============================================================
// COMPARE TWO ANNUAL REPORTS
// ============================================================

app.post(
  "/api/compare-reports",
  upload.fields([
    {
      name: "reportA",
      maxCount: 1
    },
    {
      name: "reportB",
      maxCount: 1
    }
  ]),
  async (req, res) => {
    const temporaryFiles = [];

    try {
      const reportA =
        req.files?.reportA?.[0];

      const reportB =
        req.files?.reportB?.[0];

      if (!reportA || !reportB) {
        return res.status(400).json({
          error:
            "Please upload both company annual reports."
        });
      }

      temporaryFiles.push(
        reportA.path,
        reportB.path
      );

      const bufferA =
        fs.readFileSync(reportA.path);

      const bufferB =
        fs.readFileSync(reportB.path);

      const apiKey =
        process.env.GEMINI_API_KEY;

      if (!apiKey) {
        throw new Error(
          "GEMINI_API_KEY is not configured."
        );
      }

      const model =
        process.env.GEMINI_MODEL ||
        "gemini-2.5-flash-lite";

      const prompt = `
You are FinSight AI.

Compare the two supplied annual reports from an investor's perspective.

Do NOT simply declare one company the winner.

Explain trade-offs.

Compare:

- business model
- revenue growth
- profitability
- margins
- cash generation
- earnings quality
- leverage
- liquidity
- ROE / ROCE where available
- working capital
- management
- capital allocation
- governance
- auditor observations
- risks
- red flags
- growth opportunities

Do not invent missing figures.

Return valid JSON:

{
  "company_a": "",
  "company_b": "",

  "summary": "",

  "business_quality": {
    "company_a": "",
    "company_b": "",
    "edge": ""
  },

  "growth": {
    "company_a": "",
    "company_b": "",
    "edge": ""
  },

  "profitability": {
    "company_a": "",
    "company_b": "",
    "edge": ""
  },

  "cash_generation": {
    "company_a": "",
    "company_b": "",
    "edge": ""
  },

  "balance_sheet": {
    "company_a": "",
    "company_b": "",
    "edge": ""
  },

  "management": {
    "company_a": "",
    "company_b": "",
    "edge": ""
  },

  "governance": {
    "company_a": "",
    "company_b": "",
    "edge": ""
  },

  "risk": {
    "company_a": "",
    "company_b": "",
    "edge": ""
  },

  "company_a_strengths": [],
  "company_a_weaknesses": [],

  "company_b_strengths": [],
  "company_b_weaknesses": [],

  "important_tradeoffs": [],

  "questions_before_choosing_a": [],
  "questions_before_choosing_b": []
}
`;

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          model
        )}:generateContent?key=${encodeURIComponent(
          apiKey
        )}`,
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json"
          },

          body: JSON.stringify({
            contents: [
              {
                role: "user",

                parts: [
                  {
                    text:
                      "REPORT A: " +
                      reportA.originalname
                  },

                  {
                    inline_data: {
                      mime_type:
                        "application/pdf",

                      data:
                        bufferA.toString(
                          "base64"
                        )
                    }
                  },

                  {
                    text:
                      "REPORT B: " +
                      reportB.originalname
                  },

                  {
                    inline_data: {
                      mime_type:
                        "application/pdf",

                      data:
                        bufferB.toString(
                          "base64"
                        )
                    }
                  },

                  {
                    text: prompt
                  }
                ]
              }
            ],

            generationConfig: {
              temperature: 0.2,
              responseMimeType:
                "application/json"
            }
          })
        }
      );

      const responseText =
        await response.text();

      if (!response.ok) {
        throw new Error(
          `Gemini comparison failed: ${responseText}`
        );
      }

      const data =
        JSON.parse(responseText);

      const output =
        data?.candidates?.[0]?.content
          ?.parts?.map(
            part => part.text || ""
          )
          .join("") || "";

      let comparison;

      try {
        comparison =
          JSON.parse(output);
      } catch {
        comparison = {
          raw: output
        };
      }

      return res.json({
        ok: true,
        comparison
      });

    } catch (error) {
      console.error(
        "Comparison error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Company comparison failed."
      });

    } finally {
      for (
        const filePath of temporaryFiles
      ) {
        if (
          filePath &&
          fs.existsSync(filePath)
        ) {
          try {
            fs.unlinkSync(filePath);
          } catch {}
        }
      }
    }
  }
);


// ============================================================
// ALPHA VANTAGE - DELAYED / LAST AVAILABLE PRICE
// ============================================================

app.get("/api/market/quote", async (req, res) => {
  try {
    const symbol =
      String(req.query.symbol || "")
        .trim()
        .toUpperCase();

    if (!symbol) {
      return res.status(400).json({
        error: "Ticker symbol is required."
      });
    }

    const apiKey =
      process.env.ALPHA_VANTAGE_API_KEY;

    if (!apiKey) {
      return res.status(503).json({
        ok: false,
        error:
          "ALPHA_VANTAGE_API_KEY is not configured.",
        manualPriceAllowed: true
      });
    }

    const url =
      "https://www.alphavantage.co/query" +
      "?function=GLOBAL_QUOTE" +
      `&symbol=${encodeURIComponent(symbol)}` +
      `&apikey=${encodeURIComponent(apiKey)}`;

    const response =
      await fetch(url);

    const data =
      await response.json();

    if (data.Note || data.Information) {
      return res.status(429).json({
        ok: false,
        error:
          data.Note ||
          data.Information,
        manualPriceAllowed: true
      });
    }

    const quote =
      data["Global Quote"];

    if (
      !quote ||
      !quote["05. price"]
    ) {
      return res.status(404).json({
        ok: false,
        error:
          "No quote was returned for this ticker. Try another symbol or enter the share price manually.",
        manualPriceAllowed: true
      });
    }

    const price =
      Number(quote["05. price"]);

    const previousClose =
      Number(
        quote["08. previous close"]
      );

    const change =
      Number(quote["09. change"]);

    const changePercent =
      quote["10. change percent"];

    const latestTradingDay =
      quote["07. latest trading day"];

    return res.json({
      ok: true,

      symbol,

      price,

      previousClose,

      change,

      changePercent,

      latestTradingDay,

      source: "Alpha Vantage",

      freshness:
        "last-available / delayed / end-of-day",

      live: false
    });

  } catch (error) {
    console.error(
      "Market quote error:",
      error
    );

    return res.status(500).json({
      ok: false,

      error:
        error.message ||
        "Market quote failed.",

      manualPriceAllowed: true
    });
  }
});


// ============================================================
// ALPHA VANTAGE HISTORICAL PRICES
// ============================================================

app.get(
  "/api/market/history",
  async (req, res) => {
    try {
      const symbol =
        String(req.query.symbol || "")
          .trim()
          .toUpperCase();

      if (!symbol) {
        return res.status(400).json({
          error:
            "Ticker symbol is required."
        });
      }

      const apiKey =
        process.env
          .ALPHA_VANTAGE_API_KEY;

      if (!apiKey) {
        return res.status(503).json({
          error:
            "ALPHA_VANTAGE_API_KEY is not configured."
        });
      }

      const url =
        "https://www.alphavantage.co/query" +
        "?function=TIME_SERIES_DAILY" +
        `&symbol=${encodeURIComponent(symbol)}` +
        "&outputsize=compact" +
        `&apikey=${encodeURIComponent(apiKey)}`;

      const response =
        await fetch(url);

      const data =
        await response.json();

      if (
        data.Note ||
        data.Information
      ) {
        return res.status(429).json({
          error:
            data.Note ||
            data.Information
        });
      }

      const series =
        data[
          "Time Series (Daily)"
        ];

      if (!series) {
        return res.status(404).json({
          error:
            "Historical price data was not returned."
        });
      }

      const history =
        Object.entries(series)
          .map(([date, values]) => ({
            date,

            open:
              Number(
                values["1. open"]
              ),

            high:
              Number(
                values["2. high"]
              ),

            low:
              Number(
                values["3. low"]
              ),

            close:
              Number(
                values["4. close"]
              ),

            volume:
              Number(
                values["5. volume"]
              )
          }))
          .sort(
            (a, b) =>
              a.date.localeCompare(
                b.date
              )
          );

      return res.json({
        ok: true,

        symbol,

        source: "Alpha Vantage",

        live: false,

        history
      });

    } catch (error) {
      console.error(
        "Historical price error:",
        error
      );

      return res.status(500).json({
        ok: false,

        error:
          error.message ||
          "Historical prices failed."
      });
    }
  }
);


// ============================================================
// OPTIONAL DATABASE SUPPORT
// ============================================================

let pool = null;

if (
  Pool &&
  process.env.DATABASE_URL
) {
  pool = new Pool({
    connectionString:
      process.env.DATABASE_URL,

    ssl:
      process.env.DATABASE_SSL ===
      "false"
        ? false
        : {
            rejectUnauthorized: false
          },

    max:
      Number(
        process.env
          .DATABASE_POOL_MAX || 5
      )
  });

  pool.on("error", error => {
    console.error(
      "PostgreSQL pool error:",
      error
    );
  });
}


// ============================================================
// DATABASE STATUS
// ============================================================

app.get(
  "/api/database/status",
  async (req, res) => {
    if (!pool) {
      return res.json({
        ok: true,
        configured: false,
        message:
          "Database-backed memory is inactive until DATABASE_URL is configured."
      });
    }

    try {
      const result =
        await pool.query(
          "select now() as server_time"
        );

      return res.json({
        ok: true,
        configured: true,
        connected: true,
        serverTime:
          result.rows[0]
            .server_time
      });

    } catch (error) {
      return res.status(500).json({
        ok: false,
        configured: true,
        connected: false,
        error: error.message
      });
    }
  }
);


// ============================================================
// COMPANY HELPER
// ============================================================

async function getOrCreateCompany({
  name,
  ticker = null,
  exchange = null
}) {
  if (!pool) {
    throw new Error(
      "DATABASE_URL is not configured."
    );
  }

  if (ticker) {
    const existing =
      await pool.query(
        `
        select *
        from companies
        where ticker = $1
        and coalesce(exchange, '') =
            coalesce($2, '')
        limit 1
        `,
        [ticker, exchange]
      );

    if (existing.rows[0]) {
      return existing.rows[0];
    }
  }

  const byName =
    await pool.query(
      `
      select *
      from companies
      where lower(name) =
            lower($1)
      limit 1
      `,
      [name]
    );

  if (byName.rows[0]) {
    return byName.rows[0];
  }

  const created =
    await pool.query(
      `
      insert into companies
      (
        name,
        ticker,
        exchange
      )
      values ($1, $2, $3)
      returning *
      `,
      [
        name,
        ticker,
        exchange
      ]
    );

  return created.rows[0];
}


// ============================================================
// SAVE INVESTMENT THESIS
// ============================================================

app.post(
  "/api/research/thesis",
  async (req, res) => {
    try {
      if (!pool) {
        return res.status(503).json({
          ok: false,
          error:
            "Database-backed memory is inactive until DATABASE_URL is configured."
        });
      }

      const {
        company,
        ticker,
        exchange,
        thesis,
        bullCase,
        bearCase
      } = req.body || {};

      if (!company) {
        return res.status(400).json({
          error:
            "Company name is required."
        });
      }

      const companyRow =
        await getOrCreateCompany({
          name: company,
          ticker,
          exchange
        });

      const existing =
        await pool.query(
          `
          select id
          from investment_theses
          where company_id = $1
          and status = 'active'
          order by updated_at desc
          limit 1
          `,
          [companyRow.id]
        );

      let saved;

      if (existing.rows[0]) {
        saved =
          await pool.query(
            `
            update investment_theses
            set
              thesis = $1,
              bull_case = $2,
              bear_case = $3,
              updated_at = now()
            where id = $4
            returning *
            `,
            [
              thesis || "",
              bullCase || "",
              bearCase || "",
              existing.rows[0].id
            ]
          );
      } else {
        saved =
          await pool.query(
            `
            insert into investment_theses
            (
              company_id,
              thesis,
              bull_case,
              bear_case
            )
            values ($1, $2, $3, $4)
            returning *
            `,
            [
              companyRow.id,
              thesis || "",
              bullCase || "",
              bearCase || ""
            ]
          );
      }

      return res.json({
        ok: true,
        company: companyRow,
        thesis: saved.rows[0]
      });

    } catch (error) {
      console.error(
        "Save thesis error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: error.message
      });
    }
  }
);


// ============================================================
// LOAD RESEARCH MEMORY
// ============================================================

app.get(
  "/api/research/memory",
  async (req, res) => {
    try {
      if (!pool) {
        return res.status(503).json({
          ok: false,
          error:
            "Database-backed memory is inactive until DATABASE_URL is configured."
        });
      }

      const company =
        String(
          req.query.company || ""
        ).trim();

      const ticker =
        String(
          req.query.ticker || ""
        ).trim();

      if (!company && !ticker) {
        return res.status(400).json({
          error:
            "Company name or ticker is required."
        });
      }

      let companyResult;

      if (ticker) {
        companyResult =
          await pool.query(
            `
            select *
            from companies
            where ticker = $1
            order by updated_at desc
            limit 1
            `,
            [ticker]
          );
      } else {
        companyResult =
          await pool.query(
            `
            select *
            from companies
            where lower(name) =
                  lower($1)
            order by updated_at desc
            limit 1
            `,
            [company]
          );
      }

      const companyRow =
        companyResult.rows[0];

      if (!companyRow) {
        return res.json({
          ok: true,
          found: false,
          message:
            "No saved research was found for this company."
        });
      }

      const thesisResult =
        await pool.query(
          `
          select *
          from investment_theses
          where company_id = $1
          order by updated_at desc
          limit 1
          `,
          [companyRow.id]
        );

      const promises =
        await pool.query(
          `
          select *
          from management_promises
          where company_id = $1
          order by created_at desc
          `,
          [companyRow.id]
        );

      const valuations =
        await pool.query(
          `
          select *
          from valuation_snapshots
          where company_id = $1
          order by created_at desc
          limit 10
          `,
          [companyRow.id]
        );

      const events =
        await pool.query(
          `
          select *
          from monitoring_events
          where company_id = $1
          order by created_at desc
          limit 20
          `,
          [companyRow.id]
        );

      return res.json({
        ok: true,
        found: true,
        company: companyRow,
        thesis:
          thesisResult.rows[0] ||
          null,
        managementPromises:
          promises.rows,
        valuationSnapshots:
          valuations.rows,
        monitoringEvents:
          events.rows
      });

    } catch (error) {
      console.error(
        "Load research error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: error.message
      });
    }
  }
);


// ============================================================
// 404 HANDLER
// ============================================================

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Route not found",
    path: req.path
  });
});


// ============================================================
// ERROR HANDLER
// ============================================================

app.use(
  (error, req, res, next) => {
    console.error(
      "Unhandled server error:",
      error
    );

    if (
      error instanceof
      multer.MulterError
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "File upload error: " +
          error.message
      });
    }

    return res.status(500).json({
      ok: false,
      error:
        error.message ||
        "Unexpected server error."
    });
  }
);


// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `FinSight AI running on port ${PORT}`
  );

  console.log(
    `Gemini configured: ${
      process.env.GEMINI_API_KEY
        ? "YES"
        : "NO"
    }`
  );

  console.log(
    `Alpha Vantage configured: ${
      process.env
        .ALPHA_VANTAGE_API_KEY
        ? "YES"
        : "NO"
    }`
  );

  console.log(
    `Database configured: ${
      process.env.DATABASE_URL
        ? "YES"
        : "NO"
    }`
  );
});
