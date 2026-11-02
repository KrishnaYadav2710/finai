/* ============================================================
   FINSIGHT AI
   Gemini AI · Alpha Vantage · Valuation · DCF · Research Memory
   ============================================================ */


/* ============================================================
   1. STATE
   ============================================================ */

let selectedAIReport = null;

let latestAIAnalysis = null;

let latestMarketData = null;

let latestValuationData = null;


/* ============================================================
   2. HELPERS
   ============================================================ */

const aiEl = id =>
  document.getElementById(id);


function escapeHtml(value) {

  return String(value ?? "")
    .replace(
      /[&<>"']/g,
      character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[character]
    );

}


function formatNumber(
  value,
  digits = 2
) {

  const number =
    Number(value);


  if (
    !Number.isFinite(number)
  ) {

    return "N/A";

  }


  return number.toLocaleString(
    "en-IN",
    {
      maximumFractionDigits:
        digits
    }
  );

}


function currentContext() {

  try {

    const analysis =
      calc(primary);


    return {

      company:
        analysis.l.company,

      latestYear:
        analysis.l.year,

      latest:
        analysis.l,

      ratios:
        analysis.r,

      deterministicSignals:
        signals(analysis),

      pdfEvidence

    };

  }

  catch {

    return {};

  }

}


function tickerIdentity() {

  return {

    ticker:

      (
        aiEl("tickerInput")
          ?.value || ""
      )

      .trim()

      .toUpperCase(),


    exchange:

      aiEl("exchangeInput")
        ?.value || "NSE"

  };

}


/* ============================================================
   3. AI ANALYSIS RENDERER
   ============================================================ */

function renderAIAnalysis(
  analysis
) {

  const group = (
    title,
    items
  ) => {

    const content =

      (items || [])

      .map(
        item => `

          <div class="ai-finding">

            <b>
              ${escapeHtml(
                item.title
              )}
            </b>

            ${
              item.priority

                ? ` · ${escapeHtml(
                    item.priority
                  )}`

                : ""
            }

            <br>

            ${escapeHtml(
              item.explanation
            )}

            <small>

              ${
                escapeHtml(

                  (
                    item.evidence ||
                    []
                  )

                  .join(" · ")

                  ||

                  "Evidence not specified"

                )
              }

            </small>

          </div>

        `
      )

      .join("");


    return `

      <div class="group-title">

        ${title}

      </div>

      ${

        content

        ||

        `<div class="ai-finding">
           No supported finding.
         </div>`

      }

    `;

  };


  return `

    <b>
      ${escapeHtml(
        analysis.company ||
        "Company"
      )}
    </b>

    <br>

    ${escapeHtml(
      analysis.overall_view ||
      "No overall assessment returned."
    )}

    <br>

    <small>
      Confidence:
      ${escapeHtml(
        analysis.confidence ||
        "Not specified"
      )}
    </small>


    ${group(
      "GOOD",
      analysis.good
    )}


    ${group(
      "BAD",
      analysis.bad
    )}


    ${group(
      "WATCH",
      analysis.watch
    )}


    ${group(
      "RED FLAGS / INVESTIGATE",
      analysis.red_flags
    )}


    ${group(
      "GROWTH DRIVERS",
      analysis.growth_drivers
    )}


    <div class="group-title">
      MANAGEMENT
    </div>

    ${escapeHtml(
      analysis.management_assessment ||
      "No supported management assessment."
    )}


    <div class="group-title">
      GOVERNANCE
    </div>

    ${escapeHtml(
      analysis.governance_assessment ||
      "No supported governance assessment."
    )}


    <div class="group-title">
      AUDITOR
    </div>

    ${escapeHtml(
      analysis.auditor_assessment ||
      "No supported auditor assessment."
    )}


    <div class="group-title">
      CASH QUALITY
    </div>

    ${escapeHtml(
      analysis.cash_quality_assessment ||
      "No supported cash-quality assessment."
    )}


    <div class="group-title">
      QUESTIONS BEFORE INVESTING
    </div>

    ${
      (
        analysis
          .investor_questions ||
        []
      )

      .map(
        question =>

          `• ${escapeHtml(
            question
          )}`
      )

      .join("<br>")

      ||

      "No additional questions returned."
    }


    <div class="group-title">
      MISSING / NEEDS VERIFICATION
    </div>

    ${
      (
        analysis
          .missing_information ||
        []
      )

      .map(
        item =>

          `• ${escapeHtml(
            item
          )}`
      )

      .join("<br>")

      ||

      "No missing information identified."
    }

  `;

}


/* ============================================================
   4. BACKEND HEALTH CHECK
   ============================================================ */

async function health() {

  const status =
    aiEl("aiStatus");


  if (
    !status
  ) {

    return;

  }


  try {

    const response =
      await fetch(
        "/api/health"
      );


    const data =
      await response.json();


    if (
      !response.ok
    ) {

      throw new Error(
        data.error ||
        "Health check failed."
      );

    }


    const pieces = [];


    /* Gemini */

    if (
      data.aiConfigured
    ) {

      pieces.push(
        `AI connected · ${data.model}`
      );

    }

    else {

      pieces.push(
        "Gemini key missing"
      );

    }


    /* Market */

    if (
      data.marketConfigured
    ) {

      pieces.push(
        "Alpha Vantage connected"
      );

    }

    else {

      pieces.push(
        "market key missing"
      );

    }


    /* Database */

    if (
      data.databaseReady
    ) {

      pieces.push(
        "research memory connected"
      );

    }

    else if (
      data.databaseConfigured
    ) {

      pieces.push(
        "database configured but unavailable"
      );

    }


    status.textContent =
      pieces.join(" · ");

  }

  catch (
    error
  ) {

    status.textContent =
      "FinSight backend not reachable";

    console.error(
      "Health check:",
      error
    );

  }

}


/* ============================================================
   5. ANNUAL REPORT FILE SELECTION
   ============================================================ */

const aiReportFile =
  aiEl("aiReportFile");


if (
  aiReportFile
) {

  aiReportFile.onchange =
    event => {

      selectedAIReport =

        event.target
          .files?.[0]

        || null;


      const box =
        aiEl(
          "aiReportResult"
        );


      if (
        !box
      ) {

        return;

      }


      box.textContent =

        selectedAIReport

          ?

          `${selectedAIReport.name} selected. Tap Run AI analysis.`

          :

          "No file selected.";

    };

}


/* ============================================================
   6. ANNUAL REPORT AI
   ============================================================ */

const runAIReport =
  aiEl(
    "runAIReport"
  );


if (
  runAIReport
) {

  runAIReport.onclick =
    async () => {

      const box =
        aiEl(
          "aiReportResult"
        );


      if (
        !selectedAIReport
      ) {

        box.textContent =
          "Choose an annual-report PDF first.";

        return;

      }


      box.textContent =
        "FinSight AI is reading the annual report and cross-checking it against the financial analysis…";


      box.classList.add(
        "loading"
      );


      try {

        const formData =
          new FormData();


        formData.append(
          "report",
          selectedAIReport
        );


        formData.append(

          "metrics",

          JSON.stringify(
             currentContext()
          )
        );
         /*
 * MULTI-REPORT CONTEXT
 *
 * If finsight-investor.js detected several annual reports
 * inside one PDF, send their year/page boundaries and
 * local disclosure evidence to the secure backend.
 */

if (
  window.finSightPDFContext
) {

  formData.append(

    "pdfContext",

    JSON.stringify(
      window.finSightPDFContext
    )

  );

}
            


        const identity =
          tickerIdentity();


        if (
          identity.ticker
        ) {

          formData.append(
            "ticker",
            identity.ticker
          );


          formData.append(
            "exchange",
            identity.exchange
          );

        }


        const response =
          await fetch(

            "/api/ai/analyze-report",

            {
              method: "POST",
              body: formData
            }

          );


        const data =
          await response.json();


        if (
          !response.ok
        ) {

          throw new Error(

            data.error ||
            "AI annual-report analysis failed."

          );

        }


        latestAIAnalysis =
          data.analysis;


        box.innerHTML =

          renderAIAnalysis(
            data.analysis
          );

      }

      catch (
        error
      ) {

        box.textContent =
          error.message;


        console.error(
          "Annual report AI:",
          error
        );

      }

      finally {

        box.classList.remove(
          "loading"
        );

      }

    };

}


/* ============================================================
   7. ASK FINSIGHT
   ============================================================ */

const askAI =
  aiEl(
    "askAI"
  );


if (
  askAI
) {

  askAI.onclick =
    async () => {

      const questionBox =
        aiEl(
          "aiQuestion"
        );


      const answerBox =
        aiEl(
          "aiAnswer"
        );


      const question =

        questionBox
          .value
          .trim();


      if (
        !question
      ) {

        answerBox.textContent =
          "Enter a question first.";

        questionBox.focus();

        return;

      }


      answerBox.textContent =
        "FinSight AI is reasoning from the available company evidence…";


      answerBox.classList.add(
        "loading"
      );


      try {

        const response =
          await fetch(

            "/api/ai/ask",

            {

              method:
                "POST",

              headers: {

                "Content-Type":
                  "application/json"

              },

              body:
                JSON.stringify({

                  question,

                  context:
                    currentContext(),

                  priorAnalysis:
                    latestAIAnalysis

                })

            }

          );


        const data =
          await response.json();


        if (
          !response.ok
        ) {

          throw new Error(

            data.error ||
            "AI question failed."

          );

        }


        answerBox.textContent =
          data.answer;

      }

      catch (
        error
      ) {

        answerBox.textContent =
          error.message;


        console.error(
          "Ask FinSight:",
          error
        );

      }

      finally {

        answerBox
          .classList
          .remove(
            "loading"
          );

      }

    };

}


/*
 * Pressing Enter inside Ask FinSight
 * submits the question.
 */

const aiQuestion =
  aiEl(
    "aiQuestion"
  );


if (
  aiQuestion
) {

  aiQuestion.addEventListener(

    "keydown",

    event => {

      if (
        event.key === "Enter" &&
        !event.shiftKey
      ) {

        event.preventDefault();

        askAI?.click();

      }

    }

  );

}


/* ============================================================
   8. AI COMPETITOR COMPARISON
   ============================================================ */

const runAICompare =
  aiEl(
    "runAICompare"
  );


if (
  runAICompare
) {

  runAICompare.onclick =
    async () => {

      const reportA =

        aiEl(
          "aiCompareA"
        )
        ?.files?.[0];


      const reportB =

        aiEl(
          "aiCompareB"
        )
        ?.files?.[0];


      const box =
        aiEl(
          "aiCompareResult"
        );


      if (
        !reportA ||
        !reportB
      ) {

        box.textContent =
          "Choose both annual-report PDFs first.";

        return;

      }


      box.textContent =
        "FinSight AI is comparing both annual reports…";


      box.classList.add(
        "loading"
      );


      try {

        const formData =
          new FormData();


        formData.append(
          "companyA",
          reportA
        );


        formData.append(
          "companyB",
          reportB
        );


        const response =
          await fetch(

            "/api/ai/compare",

            {
              method: "POST",
              body: formData
            }

          );


        const data =
          await response.json();


        if (
          !response.ok
        ) {

          throw new Error(

            data.error ||
            "AI comparison failed."

          );

        }


        box.textContent =
          data.comparison;

      }

      catch (
        error
      ) {

        box.textContent =
          error.message;


        console.error(
          "AI comparison:",
          error
        );

      }

      finally {

        box
          .classList
          .remove(
            "loading"
          );

      }

    };

}


/* ============================================================
   9. ALPHA VANTAGE MARKET DATA
   ============================================================ */

const marketFetch =
  aiEl(
    "fetchMarket"
  );


if (
  marketFetch
) {

  marketFetch.onclick =
    async () => {

      const identity =
        tickerIdentity();


      const display =
        aiEl(
          "priceDisplay"
        );


      const priceInput =
        aiEl(
          "priceInput"
        );


      if (
        !identity.ticker
      ) {

        display.textContent =
          "Set a ticker first";

        /*
         * Open market-data modal automatically.
         */

        if (
          aiEl(
            "marketModal"
          )
        ) {

          aiEl(
            "marketModal"
          ).hidden =
            false;

        }

        return;

      }


      display.textContent =
        `Fetching ${identity.ticker} last available price…`;


      marketFetch.disabled =
        true;


      try {

        const response =
          await fetch(

            `/api/market/${encodeURIComponent(
              identity.ticker
            )}?exchange=${encodeURIComponent(
              identity.exchange
            )}`

          );


        const data =
          await response.json();


        if (
          !response.ok
        ) {

          throw new Error(

            data.error ||
            "Price lookup failed."

          );

        }


        latestMarketData =
          data;


        priceInput.value =
          data.price;


        let change = null;


        if (
          Number.isFinite(
            Number(
              data.previousClose
            )
          )

          &&

          Number(
            data.previousClose
          ) !== 0
        ) {

          change =

            (
              (
                Number(
                  data.price
                )

                -

                Number(
                  data.previousClose
                )
              )

              /

              Number(
                data.previousClose
              )
            )

            *

            100;

        }


        const priceText =

          `₹${formatNumber(
            data.price,
            2
          )}`;


        const changeText =

          change === null

            ? ""

            : ` · ${
                change >= 0
                  ? "+"
                  : ""
              }${change.toFixed(
                2
              )}%`;


        const providerText =

          data.provider

            ? ` · ${data.provider}`

            : " · Alpha Vantage";


        /*
         * IMPORTANT:
         * Display Alpha Vantage's actual trading date.
         */

        const dateText =

          data.asOf

            ? ` · ${data.asOf}`

            : "";


        display.textContent =

          priceText

          +

          changeText

          +

          providerText

          +

          dateText;


        /*
         * Add useful tooltip for iPad/desktop.
         */

        display.title =

          `${identity.ticker} · ${identity.exchange}\n`

          +

          `${
            data.freshness ||
            "End-of-day / last available; not live"
          }`;


        /*
         * Don't call it live.
         */

        const marketNote =
          document.querySelector(
            ".market-note"
          );


        if (
          marketNote
        ) {

          marketNote.textContent =

            `Price source: ${
              data.provider ||
              "Alpha Vantage"
            }. `

            +

            `${
              data.asOf
                ? `Trading date: ${data.asOf}. `
                : ""
            }`

            +

            "Free mode is end-of-day / last available and is not a live trading quote.";

        }

      }

      catch (
        error
      ) {

        latestMarketData =
          null;


        display.textContent =
          `Price unavailable · ${error.message}`;


        display.title =
          "You can still enter the current share price manually.";


        console.error(
          "Alpha Vantage:",
          error
        );

      }

      finally {

        marketFetch.disabled =
          false;

      }

    };

}


/* ============================================================
   10. ENHANCED VALUATION CALCULATION
   ============================================================ */

/*
 * finsight-investor.js already performs the basic
 * Bear / Base / Bull scenario.
 *
 * This listener runs afterwards and calculates:
 *
 * - EPS
 * - current P/E
 * - preferred P/E
 * - peer P/E
 * - historical P/E
 * - reference value
 * - valuation classification
 */

const originalValueBtn =
  aiEl(
    "valueBtn"
  );


if (
  originalValueBtn
) {

  originalValueBtn.addEventListener(

    "click",

    () => {

      try {

        const context =
          currentContext();


        const price =
          Number(
            aiEl(
              "priceInput"
            ).value
          );


        const shares =
          Number(
            aiEl(
              "sharesInput"
            ).value
          );


        const selectedPe =
          Number(
            aiEl(
              "peInput"
            ).value
          );


        const peerPeRaw =
          Number(
            aiEl(
              "peerPeInput"
            )?.value
          );


        const historicalPeRaw =
          Number(
            aiEl(
              "histPeInput"
            )?.value
          );


        const peerPe =

          peerPeRaw > 0

            ? peerPeRaw

            : null;


        const historicalPe =

          historicalPeRaw > 0

            ? historicalPeRaw

            : null;


        if (
          !price ||
          !shares ||
          !selectedPe ||
          !context.latest
        ) {

          latestValuationData =
            null;

          return;

        }


        const eps =

          Number(
            context.latest
              .net_income
          )

          /

          shares;


        if (
          !Number.isFinite(
            eps
          )

          ||

          eps <= 0
        ) {

          latestValuationData =
            null;

          return;

        }


        const currentPe =
          price / eps;


        const base =
          eps * selectedPe;


        const references = [

          selectedPe,

          peerPe,

          historicalPe

        ]

        .filter(
          value =>
            Number.isFinite(
              value
            )

            &&

            value > 0
        );


        const referencePe =

          references.reduce(
            (sum, value) =>
              sum + value,
            0
          )

          /

          references.length;


        const referenceValue =
          eps * referencePe;


        const premium =

          (
            price -
            referenceValue
          )

          /

          referenceValue;


        let classification;


        if (
          premium <= -0.15
        ) {

          classification =
            "Attractive";

        }

        else if (
          premium < 0.10
        ) {

          classification =
            "Fair";

        }

        else if (
          premium < 0.30
        ) {

          classification =
            "Premium";

        }

        else {

          classification =
            "Expensive";

        }


        latestValuationData = {

          price,

          shares,

          eps,

          currentPe,

          selectedPe,

          peerPe,

          historicalMedianPe:
            historicalPe,

          referencePe,

          referenceValue,

          premium,

          classification,

          bear:
            base * 0.8,

          base,

          bull:
            base * 1.2

        };


        aiEl(
          "valuationView"
        ).textContent =

          `${classification} · ${currentPe.toFixed(
            1
          )}× earnings`;

      }

      catch (
        error
      ) {

        console.error(
          "Valuation calculation:",
          error
        );

      }

    }

  );

}


/* ============================================================
   11. AI VALUATION INTERPRETATION
   ============================================================ */

const aiValueBtn =
  aiEl(
    "aiValueBtn"
  );


if (
  aiValueBtn
) {

  aiValueBtn.onclick =
    async () => {

      const box =
        aiEl(
          "aiValuation"
        );


      if (
        !latestValuationData
      ) {

        box.textContent =
          "Run Evaluate price first.";

        return;

      }


      box.textContent =
        "FinSight AI is separating business quality from price…";


      box.classList.add(
        "loading"
      );


      try {

        const context =
          currentContext();


        const response =
          await fetch(

            "/api/ai/valuation",

            {

              method:
                "POST",

              headers: {

                "Content-Type":
                  "application/json"

              },

              body:
                JSON.stringify({

                  company:
                    context.company,

                  market:

                    latestMarketData

                    ||

                    {

                      price:
                        latestValuationData.price,

                      source:
                        "manual"

                    },

                  fundamentals:
                    context,

                  valuation:
                    latestValuationData

                })

            }

          );


        const data =
          await response.json();


        if (
          !response.ok
        ) {

          throw new Error(

            data.error ||
            "Valuation interpretation failed."

          );

        }


        box.textContent =
          data.assessment;


        /*
         * Save valuation snapshot when database
         * and ticker are available.
         */

        const identity =
          tickerIdentity();


        if (
          identity.ticker
        ) {

          fetch(

            "/api/valuation/snapshot",

            {

              method:
                "POST",

              headers: {

                "Content-Type":
                  "application/json"

              },

              body:
                JSON.stringify({

                  company:
                    context.company,

                  ticker:
                    identity.ticker,

                  exchange:
                    identity.exchange,

                  market:

                    latestMarketData

                    ||

                    {

                      price:
                        latestValuationData.price,

                      source:
                        "manual"

                    },

                  fundamentals:
                    context,

                  valuation:
                    latestValuationData,

                  aiAssessment:
                    data.assessment

                })

            }

          )

          .catch(
            () => {}
          );

        }

      }

      catch (
        error
      ) {

        box.textContent =
          error.message;


        console.error(
          "AI valuation:",
          error
        );

      }

      finally {

        box
          .classList
          .remove(
            "loading"
          );

      }

    };

}


/* ============================================================
   12. DCF PAYLOAD
   ============================================================ */

function dcfPayload() {

  const context =
    currentContext();


  const shares =
    Number(
      aiEl(
        "sharesInput"
      )?.value
    );


  const price =
    Number(
      aiEl(
        "priceInput"
      )?.value
    );


  return {

    revenue:
      Number(
        context.latest
          ?.revenue
      ),

    ebitMargin:

      Number(
        aiEl(
          "dcfMargin"
        ).value
      )

      /

      100,

    taxRate:
      0.25,

    growthRate:

      Number(
        aiEl(
          "dcfGrowth"
        ).value
      )

      /

      100,

    years:
      5,

    daPctRevenue:
      0.03,

    capexPctRevenue:
      0.05,

    nwcPctRevenue:
      0.08,

    wacc:

      Number(
        aiEl(
          "dcfWacc"
        ).value
      )

      /

      100,

    terminalGrowth:

      Number(
        aiEl(
          "dcfTerminal"
        ).value
      )

      /

      100,

    netDebt:

      Number(
        aiEl(
          "dcfNetDebt"
        ).value
      )

      || 0,

    shares,

    marketPrice:
      price

  };

}


/* ============================================================
   13. RUN DCF
   ============================================================ */

const runDcf =
  aiEl(
    "runDcf"
  );


if (
  runDcf
) {

  runDcf.onclick =
    async () => {

      const box =
        aiEl(
          "dcfResult"
        );


      box.textContent =
        "Running deterministic DCF…";


      box.classList.add(
        "loading"
      );


      try {

        const payload =
          dcfPayload();


        if (
          !payload.revenue ||
          !payload.shares
        ) {

          throw new Error(
            "Load company financials and enter shares outstanding first."
          );

        }


        const response =
          await fetch(

            "/api/valuation/dcf",

            {

              method:
                "POST",

              headers: {

                "Content-Type":
                  "application/json"

              },

              body:
                JSON.stringify(
                  payload
                )

            }

          );


        const data =
          await response.json();


        if (
          !response.ok
        ) {

          throw new Error(

            data.error ||
            "DCF failed."

          );

        }


        box.textContent =

          `DCF value/share: ₹${formatNumber(
            data.valuePerShare,
            2
          )}\n`

          +

          `Enterprise value: ${formatNumber(
            data.enterpriseValue,
            1
          )}\n`

          +

          `Equity value: ${formatNumber(
            data.equityValue,
            1
          )}\n\n`

          +

          "This is an assumption-driven valuation scenario, not a guaranteed price target.";

      }

      catch (
        error
      ) {

        box.textContent =
          error.message;


        console.error(
          "DCF:",
          error
        );

      }

      finally {

        box
          .classList
          .remove(
            "loading"
          );

      }

    };

}


/* ============================================================
   14. REVERSE DCF
   ============================================================ */

const runReverseDcf =
  aiEl(
    "runReverseDcf"
  );


if (
  runReverseDcf
) {

  runReverseDcf.onclick =
    async () => {

      const box =
        aiEl(
          "dcfResult"
        );


      box.textContent =
        "Solving for the growth rate implied by the current share price…";


      box.classList.add(
        "loading"
      );


      try {

        const payload =
          dcfPayload();


        if (
          !payload.marketPrice
        ) {

          throw new Error(
            "Enter or fetch the current share price first."
          );

        }


        if (
          !payload.shares
        ) {

          throw new Error(
            "Enter shares outstanding first."
          );

        }


        const response =
          await fetch(

            "/api/valuation/reverse-dcf",

            {

              method:
                "POST",

              headers: {

                "Content-Type":
                  "application/json"

              },

              body:
                JSON.stringify(
                  payload
                )

            }

          );


        const data =
          await response.json();


        if (
          !response.ok
        ) {

          throw new Error(

            data.error ||
            "Reverse DCF failed."

          );

        }


        box.textContent =

          `Current price implies approximately ${(
            Number(
              data.impliedGrowthRate
            ) * 100
          ).toFixed(1)}% constant annual revenue growth over the forecast period.\n\n`

          +

          `Model value/share: ₹${formatNumber(
            data.modelValuePerShare,
            2
          )}\n\n`

          +

          "This result depends on the supplied margin, reinvestment, WACC and terminal-growth assumptions. Change those assumptions to stress-test market expectations.";

      }

      catch (
        error
      ) {

        box.textContent =
          error.message;


        console.error(
          "Reverse DCF:",
          error
        );

      }

      finally {

        box
          .classList
          .remove(
            "loading"
          );

      }

    };

}


/* ============================================================
   15. SAVE INVESTMENT THESIS
   ============================================================ */

const saveThesis =
  aiEl(
    "saveThesis"
  );


if (
  saveThesis
) {

  saveThesis.onclick =
    async () => {

      const box =
        aiEl(
          "memoryResult"
        );


      const identity =
        tickerIdentity();


      const context =
        currentContext();


      const thesis =

        aiEl(
          "thesisText"
        )
        .value
        .trim();


      if (
        !identity.ticker
      ) {

        box.textContent =
          "Set a ticker first using Set market data.";

        return;

      }


      if (
        !thesis
      ) {

        box.textContent =
          "Enter an investment thesis before saving.";

        return;

      }


      box.textContent =
        "Saving research thesis…";


      try {

        const response =
          await fetch(

            "/api/thesis",

            {

              method:
                "POST",

              headers: {

                "Content-Type":
                  "application/json"

              },

              body:
                JSON.stringify({

                  company:
                    context.company,

                  ticker:
                    identity.ticker,

                  exchange:
                    identity.exchange,

                  thesis,

                  bullCase:

                    aiEl(
                      "bullCase"
                    )
                    .value,

                  bearCase:

                    aiEl(
                      "bearCase"
                    )
                    .value

                })

            }

          );


        const data =
          await response.json();


        if (
          !response.ok
        ) {

          throw new Error(

            data.error ||
            "Save failed."

          );

        }


        box.textContent =

          `Saved thesis for ${data.company.ticker}. Research memory is now persistent.`;

      }

      catch (
        error
      ) {

        box.textContent =
          error.message;


        console.error(
          "Save thesis:",
          error
        );

      }

    };

}


/* ============================================================
   16. LOAD RESEARCH MEMORY
   ============================================================ */

const loadMemory =
  aiEl(
    "loadMemory"
  );


if (
  loadMemory
) {

  loadMemory.onclick =
    async () => {

      const box =
        aiEl(
          "memoryResult"
        );


      const identity =
        tickerIdentity();


      if (
        !identity.ticker
      ) {

        box.textContent =
          "Set a ticker first using Set market data.";

        return;

      }


      box.textContent =
        "Loading saved FinSight research…";


      try {

        const response =
          await fetch(

            `/api/research/${encodeURIComponent(
              identity.ticker
            )}?exchange=${encodeURIComponent(
              identity.exchange
            )}`

          );


        const data =
          await response.json();


        if (
          !response.ok
        ) {

          throw new Error(

            data.error ||
            "Load failed."

          );

        }


        const thesis =
          data.theses?.[0];


        if (
          thesis
        ) {

          aiEl(
            "thesisText"
          ).value =
            thesis.thesis || "";


          aiEl(
            "bullCase"
          ).value =
            thesis.bull_case || "";


          aiEl(
            "bearCase"
          ).value =
            thesis.bear_case || "";

        }


        box.textContent =

          `Loaded ${data.reports?.length || 0} report analyses, `

          +

          `${data.theses?.length || 0} thesis versions, `

          +

          `${data.valuations?.length || 0} valuation snapshots, `

          +

          `${data.promises?.length || 0} management promises and `

          +

          `${data.events?.length || 0} monitoring events.`;

      }

      catch (
        error
      ) {

        box.textContent =
          error.message;


        console.error(
          "Load memory:",
          error
        );

      }

    };

}


/* ============================================================
   17. INITIAL BACKEND CHECK
   ============================================================ */

health();
