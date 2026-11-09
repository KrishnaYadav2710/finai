/* ============================================================
   FINSIGHT AI — FRONTEND AI CONTROLLER

   Handles:
   - Annual-report AI
   - Multi-year report context
   - Ask FinSight
   - Business/report questions
   - AI valuation interpretation
   - Two-company annual-report comparison

   IMPORTANT:
   Financial extraction itself is initiated by
   finsight-investor.js through:

   POST /api/ai/extract-financials
   ============================================================ */


/* ============================================================
   1. HELPERS
   ============================================================ */

function aiElement(id) {

  return document.getElementById(
    id
  );

}


function getResearchContext() {

  if (
    typeof window.finSightGetContext ===
    "function"
  ) {

    return window
      .finSightGetContext();

  }


  return {

    company:
      null,

    financials:
      [],

    selectedYear:
      "all",

    market:
      null,

    valuation:
      null,

    pdfContext:
      window.finSightPDFContext ||
      null,

    aiAnalysis:
      null

  };

}


function currentReport() {

  const selected =
    aiElement(
      "aiReportFile"
    )
      ?.files?.[0];


  return (

    selected

    ||

    window.finSightCurrentReportFile

    ||

    null

  );

}


function setLoading(
  element,
  message
) {

  if (!element) {
    return;
  }


  element.classList.add(
    "loading"
  );


  element.textContent =
    message;

}


function clearLoading(
  element
) {

  element
    ?.classList
    .remove(
      "loading"
    );

}


async function readJSONResponse(
  response
) {

  const text =
    await response.text();


  let payload;


  try {

    payload =
      text
        ? JSON.parse(text)
        : {};

  }

  catch {

    throw new Error(
      "Server returned an unreadable response."
    );

  }


  if (!response.ok) {

    const rawError = payload?.error ?? payload?.message;
    const readable =
      typeof rawError === "string"
        ? rawError
        : rawError?.message
        ? rawError.message
        : rawError
        ? JSON.stringify(rawError)
        : `Request failed with status ${response.status}.`;

    throw new Error(readable);

  }


  return payload;

}


/* ============================================================
   2. SAFE HTML
   ============================================================ */

function escapeHTML(value) {

  return String(
    value ?? ""
  )

    .replace(
      /&/g,
      "&amp;"
    )

    .replace(
      /</g,
      "&lt;"
    )

    .replace(
      />/g,
      "&gt;"
    )

    .replace(
      /"/g,
      "&quot;"
    )

    .replace(
      /'/g,
      "&#039;"
    );

}


/* ============================================================
   3. GENERAL RENDER HELPERS
   ============================================================ */

function renderStringList(
  title,
  values
) {

  if (
    !Array.isArray(values) ||
    !values.length
  ) {

    return "";

  }


  return `

    <div class="group-title">
      ${escapeHTML(title)}
    </div>

    ${

      values

        .map(
          value => {

            if (
              typeof value ===
              "string"
            ) {

              return `

                <div class="ai-finding">
                  ${escapeHTML(value)}
                </div>

              `;

            }


            return `

              <div class="ai-finding">

                <b>
                  ${escapeHTML(
                    value?.title ||
                    value?.promise ||
                    value?.financial_year ||
                    "Finding"
                  )}
                </b>

                ${

                  value?.explanation

                    ? `

                      <div>
                        ${escapeHTML(
                          value.explanation
                        )}
                      </div>

                    `

                    : ""

                }

                ${

                  value?.later_evidence

                    ? `

                      <small>
                        Later evidence:
                        ${escapeHTML(
                          value.later_evidence
                        )}
                      </small>

                    `

                    : ""

                }

                ${

                  value?.status

                    ? `

                      <small>
                        Status:
                        ${escapeHTML(
                          value.status
                        )}
                      </small>

                    `

                    : ""

                }

              </div>

            `;

          }
        )

        .join("")

    }

  `;

}


/* ============================================================
   4. ANNUAL REPORT AI RENDERER
   ============================================================ */

function renderAnnualReportAnalysis(
  analysis
) {

  if (!analysis) {

    return (
      "AI analysis returned no usable content."
    );

  }


  if (
    analysis.raw
  ) {

    return escapeHTML(
      analysis.raw
    );

  }


  const years =

    Array.isArray(
      analysis.financial_years
    )

      ? analysis
          .financial_years
          .join(", ")

      : "";


  const yearly =

    Array.isArray(
      analysis.yearly_analysis
    )

      ?

      analysis
        .yearly_analysis

        .map(
          year => `

            <div class="group-title">

              ${escapeHTML(
                year.financial_year ||
                "Financial year"
              )}

            </div>


            <div class="ai-finding">

              <b>
                Statement basis
              </b>

              <div>
                ${escapeHTML(
                  year.statement_basis ||
                  "Not specified"
                )}
              </div>

            </div>


            ${

              year.business_summary

                ? `

                  <div class="ai-finding">

                    <b>
                      Business
                    </b>

                    <div>
                      ${escapeHTML(
                        year.business_summary
                      )}
                    </div>

                  </div>

                `

                : ""

            }


            ${

              year.management

                ? `

                  <div class="ai-finding">

                    <b>
                      Management
                    </b>

                    <div>
                      ${escapeHTML(
                        year.management
                      )}
                    </div>

                  </div>

                `

                : ""

            }


            ${

              year.governance

                ? `

                  <div class="ai-finding">

                    <b>
                      Governance
                    </b>

                    <div>
                      ${escapeHTML(
                        year.governance
                      )}
                    </div>

                  </div>

                `

                : ""

            }


            ${

              year.auditor

                ? `

                  <div class="ai-finding">

                    <b>
                      Auditor
                    </b>

                    <div>
                      ${escapeHTML(
                        year.auditor
                      )}
                    </div>

                  </div>

                `

                : ""

            }

          `
        )

        .join("")

      :

      "";


  const trends =
    analysis.trend_analysis ||
    {};


  const trendHTML =

    Object.entries(
      trends
    )

      .filter(
        ([, value]) =>
          value
      )

      .map(
        ([key, value]) => `

          <div class="ai-finding">

            <b>
              ${escapeHTML(
                key
                  .replace(
                    /_/g,
                    " "
                  )
              )}
            </b>

            <div>
              ${escapeHTML(value)}
            </div>

          </div>

        `
      )

      .join("");


  const changes =
    analysis.changes ||
    {};


  return `

    <div class="group-title">
      Overall investor view
    </div>

    <div class="ai-finding">

      <b>
        ${escapeHTML(
          analysis.company ||
          "Company"
        )}
      </b>

      <div>
        ${escapeHTML(
          analysis.overall_view ||
          "No overall assessment returned."
        )}
      </div>

      <small>

        ${
          years
            ? `Reporting periods: ${escapeHTML(years)} · `
            : ""
        }

        Confidence:
        ${escapeHTML(
          analysis.confidence ||
          "Not specified"
        )}

      </small>

    </div>


    ${yearly}


    ${

      trendHTML

        ? `

          <div class="group-title">
            Cross-year trends
          </div>

          ${trendHTML}

        `

        : ""

    }


    ${renderStringList(
      "Good",
      analysis.good
    )}


    ${renderStringList(
      "Bad",
      analysis.bad
    )}


    ${renderStringList(
      "Watch",
      analysis.watch
    )}


    ${renderStringList(
      "Potential red flags",
      analysis.red_flags
    )}


    ${renderStringList(
      "Growth drivers",
      analysis.growth_drivers
    )}


    ${renderStringList(
      "Management promise tracker",
      analysis.management_promise_tracker
    )}


    ${renderStringList(
      "New risks",
      changes.new_risks
    )}


    ${renderStringList(
      "Increased risks",
      changes.increased_risks
    )}


    ${renderStringList(
      "Reduced risks",
      changes.reduced_risks
    )}


    ${renderStringList(
      "Resolved risks",
      changes.resolved_risks
    )}


    ${

      analysis.management_assessment

        ? `

          <div class="group-title">
            Management assessment
          </div>

          <div class="ai-finding">
            ${escapeHTML(
              analysis.management_assessment
            )}
          </div>

        `

        : ""

    }


    ${

      analysis.governance_assessment

        ? `

          <div class="group-title">
            Governance assessment
          </div>

          <div class="ai-finding">
            ${escapeHTML(
              analysis.governance_assessment
            )}
          </div>

        `

        : ""

    }


    ${

      analysis.auditor_assessment

        ? `

          <div class="group-title">
            Auditor assessment
          </div>

          <div class="ai-finding">
            ${escapeHTML(
              analysis.auditor_assessment
            )}
          </div>

        `

        : ""

    }


    ${

      analysis.cash_quality_assessment

        ? `

          <div class="group-title">
            Cash quality
          </div>

          <div class="ai-finding">
            ${escapeHTML(
              analysis.cash_quality_assessment
            )}
          </div>

        `

        : ""

    }


    ${renderStringList(
      "Questions investors should investigate",
      analysis.investor_questions
    )}


    ${renderStringList(
      "Missing information",
      analysis.missing_information
    )}

  `;

}


/* ============================================================
   5. ANNUAL REPORT AI REQUEST
   ============================================================ */

async function runAnnualReportAI(
  file = currentReport()
) {

  const resultBox =
    aiElement(
      "aiReportResult"
    );


  if (!file) {

    if (resultBox) {

      resultBox.textContent =
        "Upload an annual-report PDF first.";

    }

    return null;

  }


  setLoading(
    resultBox,
    "FinSight AI is analyzing the annual report, management commentary, auditor disclosures, governance and cross-year changes…"
  );


  try {

    const context =
      getResearchContext();


    const formData =
      new FormData();


    formData.append(
      "report",
      file
    );


    formData.append(

      "metrics",

      JSON.stringify({

        company:
          context.company,

        financials:
          context.financials,

        market:
          context.market,

        valuation:
          context.valuation

      })

    );


    if (
      context.pdfContext
    ) {

      formData.append(

        "pdfContext",

        JSON.stringify(
          context.pdfContext
        )

      );

    }


    const response =
      await fetch(
        "/api/ai/analyze-report",
        {
          method:
            "POST",

          body:
            formData
        }
      );


    const payload =
      await readJSONResponse(
        response
      );


    const analysis =
      payload.analysis ||
      payload;


    if (
      typeof window.finSightSetAIAnalysis ===
      "function"
    ) {

      window
        .finSightSetAIAnalysis(
          analysis
        );

    }


    if (resultBox) {

      resultBox.innerHTML =
        renderAnnualReportAnalysis(
          analysis
        );

    }


    return analysis;

  }

  catch (
    error
  ) {

    console.error(
      "Annual Report AI:",
      error
    );


    if (resultBox) {

      resultBox.textContent =
        error.message;

    }


    return null;

  }

  finally {

    clearLoading(
      resultBox
    );

  }

}


/* ============================================================
   6. ANNUAL REPORT BUTTON
   ============================================================ */

aiElement(
  "runAIReport"
)
  ?.addEventListener(
    "click",
    () => {

      runAnnualReportAI();

    }
  );


/* ============================================================
   7. AUTOMATIC AI AFTER REPORT EXTRACTION
   ============================================================ */

/*
 * When finsight-investor.js finishes extracting financials,
 * automatically run qualitative AI analysis using the same
 * uploaded annual report.
 *
 * This means the investor normally uploads the report ONCE.
 */

window.addEventListener(

  "finsight:report-ready",

  event => {

    const file =
      event.detail?.file;


    if (!file) {
      return;
    }


    runAnnualReportAI(
      file
    );

  }

);


/* ============================================================
   8. ASK FINSIGHT ANSWER RENDERER
   ============================================================ */

function renderAskAnswer(
  answer
) {

  if (
    answer == null
  ) {

    return (
      "No answer was returned."
    );

  }


  if (
    typeof answer ===
    "string"
  ) {

    return escapeHTML(
      answer
    );

  }


  if (
    answer.raw
  ) {

    return escapeHTML(
      answer.raw
    );

  }


  return `

    ${

      answer.answer

        ? `

          <div class="ai-finding">

            ${escapeHTML(
              answer.answer
            )}

          </div>

        `

        : ""

    }


    ${renderStringList(
      "Reported facts",
      answer.reported_facts
    )}


    ${renderStringList(
      "Calculated metrics",
      answer.calculated_metrics
    )}


    ${renderStringList(
      "Management claims",
      answer.management_claims
    )}


    ${renderStringList(
      "AI interpretation",
      answer.ai_interpretation
    )}


    ${renderStringList(
      "Evidence",
      answer.evidence
    )}


    ${renderStringList(
      "Risks / limitations",
      answer.risks
    )}


    ${renderStringList(
      "What to investigate next",
      answer.what_to_investigate_next
    )}

  `;

}


/* ============================================================
   9. ASK FINSIGHT
   ============================================================ */

async function askFinSight() {

  const questionInput =
    aiElement(
      "aiQuestion"
    );


  const answerBox =
    aiElement(
      "aiAnswer"
    );


  const question =
    questionInput
      ?.value
      ?.trim();


  if (!question) {

    if (answerBox) {

      answerBox.textContent =
        "Enter a question about the company or annual report.";

    }

    return;

  }


  const context =
    getResearchContext();


  if (
    !context.company
  ) {

    if (answerBox) {

      answerBox.textContent =
        "Upload an annual report first so FinSight has company evidence to answer from.";

    }

    return;

  }


  setLoading(
    answerBox,
    "Searching the loaded company evidence and preparing an answer…"
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

              company:
                context.company,

              financials:
                context.financials,

              market:
                context.market,

              valuation:
                context.valuation,

              reportAnalysis:
                context.aiAnalysis,

              pdfContext:
                context.pdfContext

            })
        }
      );


    const payload =
      await readJSONResponse(
        response
      );


    const answer =
      payload.answer ||
      payload;


    if (answerBox) {

      answerBox.innerHTML =
        renderAskAnswer(
          answer
        );

    }

  }

  catch (
    error
  ) {

    console.error(
      "Ask FinSight:",
      error
    );


    if (answerBox) {

      answerBox.textContent =
        error.message;

    }

  }

  finally {

    clearLoading(
      answerBox
    );

  }

}


/* ============================================================
   10. ASK EVENTS
   ============================================================ */

aiElement(
  "askAI"
)
  ?.addEventListener(
    "click",
    askFinSight
  );


aiElement(
  "aiQuestion"
)
  ?.addEventListener(
    "keydown",
    event => {

      if (
        event.key ===
        "Enter"

        &&

        !event.shiftKey
      ) {

        event.preventDefault();

        askFinSight();

      }

    }
  );


/* ============================================================
   11. AI VALUATION
   ============================================================ */

async function runAIValuation() {

  const output =
    aiElement(
      "aiValuation"
    );


  const context =
    getResearchContext();


  if (
    !context.company
  ) {

    if (output) {

      output.textContent =
        "Upload an annual report first.";

    }

    return;

  }


  if (
    !context.market
  ) {

    if (output) {

      const listing =
        context.company
          ?.listing_status ||
        "unknown";


      output.textContent =

        `Public-market valuation is unavailable. Listing status: ${listing}. FinSight will not invent a market price or ticker.`;

    }

    return;

  }


  setLoading(
    output,
    "FinSight AI is interpreting the company's valuation…"
  );


  try {

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
                context.market,

              fundamentals:
                context.financials,

              valuation:
                context.valuation,

              reportAnalysis:
                context.aiAnalysis

            })
        }
      );


    const payload =
      await readJSONResponse(
        response
      );


    const assessment =
      payload.assessment ||
      payload;


    if (output) {

      output.innerHTML =

        typeof assessment ===
        "string"

          ?

          escapeHTML(
            assessment
          )

          :

          renderAskAnswer(
            assessment
          );

    }

  }

  catch (
    error
  ) {

    console.error(
      "AI valuation:",
      error
    );


    if (output) {

      output.textContent =
        error.message;

    }

  }

  finally {

    clearLoading(
      output
    );

  }

}


/* ============================================================
   12. AUTOMATIC VALUATION EVENT
   ============================================================ */

/*
 * The investor engine updates the shared research context
 * after fetching market data.
 *
 * Run valuation interpretation shortly after report readiness.
 * If market data is still being fetched, one retry is allowed.
 */

window.addEventListener(

  "finsight:report-ready",

  () => {

    window.setTimeout(

      async () => {

        const context =
          getResearchContext();


        if (
          context.market
        ) {

          await runAIValuation();
          return;

        }


        /*
         * One delayed retry.
         */

        window.setTimeout(

          () => {

            const retryContext =
              getResearchContext();


            if (
              retryContext.market
            ) {

              runAIValuation();

            }

            else {

              const output =
                aiElement(
                  "aiValuation"
                );


              if (
                output &&
                retryContext.company
              ) {

                const status =
                  retryContext.company
                    .listing_status ||
                  "unknown";


                output.textContent =

                  `Automatic market valuation was not run because a verified public market price is unavailable. Listing status: ${status}.`;

              }

            }

          },

          3500

        );

      },

      1800

    );

  }

);


/* ============================================================
   MARKET-READY VALUATION EVENT
   ============================================================ */

window.addEventListener(
  "finsight:market-ready",
  () => {
    const context = getResearchContext();
    if (context.company && context.market && context.valuation) {
      runAIValuation();
    }
  }
);


/* ============================================================
   13. COMPETITOR COMPARISON RENDERER
   ============================================================ */

function renderComparison(
  comparison
) {

  if (!comparison) {

    return (
      "No comparison was returned."
    );

  }


  if (
    typeof comparison ===
    "string"
  ) {

    return escapeHTML(
      comparison
    );

  }


  if (
    comparison.raw
  ) {

    return escapeHTML(
      comparison.raw
    );

  }


  const sections =
    [];


  if (
    comparison.summary
  ) {

    sections.push(`

      <div class="group-title">
        Investor comparison
      </div>

      <div class="ai-finding">
        ${escapeHTML(
          comparison.summary
        )}
      </div>

    `);

  }


  const comparisonKeys = [

  [
    "business_quality",
    "Business quality"
  ],

  [
    "growth",
    "Growth"
  ],

  [
    "profitability",
    "Profitability"
  ],

  [
    "cash_generation",
    "Cash generation"
  ],

  [
    "balance_sheet",
    "Balance sheet"
  ],

  [
    "capital_allocation",
    "Capital allocation"
  ],

  [
    "management",
    "Management"
  ],

  [
    "governance",
    "Governance"
  ],

  [
    "auditor",
    "Auditor"
  ],

  [
    "risk",
    "Risk"
  ],

  [
    "valuation",
    "Valuation"
  ]

];


  for (
    const [
      key,
      label
    ]
    of comparisonKeys
  ) {

    const value =
      comparison[key];


    if (!value) {
      continue;
    }


    if (
      typeof value ===
      "string"
    ) {

      sections.push(`

        <div class="group-title">
          ${escapeHTML(label)}
        </div>

        <div class="ai-finding">
          ${escapeHTML(value)}
        </div>

      `);

      continue;

    }


    sections.push(`

      <div class="group-title">
        ${escapeHTML(label)}
      </div>

      <div class="ai-finding">

        ${

          value.company_a

            ? `

              <b>
                Company A
              </b>

              <div>
                ${escapeHTML(
                  value.company_a
                )}
              </div>

            `

            : ""

        }


        ${

          value.company_b

            ? `

              <br>

              <b>
                Company B
              </b>

              <div>
                ${escapeHTML(
                  value.company_b
                )}
              </div>

            `

            : ""

        }


        ${

          value.edge

            ? `

              <small>
                Investor trade-off:
                ${escapeHTML(
                  value.edge
                )}
              </small>

            `

            : ""

        }

      </div>

    `);

  }


  sections.push(

    renderStringList(
      "Company A strengths",
      comparison.company_a_strengths
    ),

    renderStringList(
      "Company A weaknesses",
      comparison.company_a_weaknesses
    ),

    renderStringList(
      "Company B strengths",
      comparison.company_b_strengths
    ),

    renderStringList(
      "Company B weaknesses",
      comparison.company_b_weaknesses
    ),

    renderStringList(
      "Important trade-offs",
      comparison.important_tradeoffs
    ),

    renderStringList(
      "Questions before choosing Company A",
      comparison.questions_before_choosing_a
    ),

    renderStringList(
      "Questions before choosing Company B",
      comparison.questions_before_choosing_b
    )

  );
   if (
  comparison.overall_interpretation
) {

  sections.push(`

    <div class="group-title">
      Overall interpretation
    </div>

    <div class="ai-finding">
      ${escapeHTML(
        comparison.overall_interpretation
      )}
    </div>

  `);

}
 


  return sections.join("");

}

/* ============================================================
   14. LIGHTWEIGHT COMPETITOR COMPARISON
   ============================================================ */

/*
 * New comparison architecture:
 *
 * Company A PDF
 *      ↓
 * prepare-comparison-report
 *      ↓
 * JSON A
 *
 * Company B PDF
 *      ↓
 * prepare-comparison-report
 *      ↓
 * JSON B
 *
 * JSON A + JSON B
 *      ↓
 * compare
 */


let comparisonCompanyA =
  null;

let comparisonCompanyB =
  null;

let comparisonFileA =
  null;

let comparisonFileB =
  null;


/* ============================================================
   15. PREPARE ONE COMPANY
   ============================================================ */

async function prepareComparisonReport(
  file,
  label
) {

  if (!file) {

    throw new Error(
      `${label} annual report is required.`
    );

  }


  const formData =
    new FormData();


  formData.append(
    "report",
    file
  );


  formData.append(
    "label",
    label
  );


  const response =
    await fetch(
      "/api/ai/prepare-comparison-report",
      {
        method:
          "POST",

        body:
          formData
      }
    );


  const payload =
    await readJSONResponse(
      response
    );


  const research =
    payload.research;


  if (
    !research ||
    typeof research !==
      "object"
  ) {

    throw new Error(
      `${label} returned no usable comparison research.`
    );

  }


  return research;

}


/* ============================================================
   16. COMPANY A
   ============================================================ */

aiElement(
  "aiCompareA"
)
  ?.addEventListener(
    "change",
    async event => {

      const file =
        event.target
          .files?.[0];


      if (!file) {
        return;
      }


      comparisonFileA =
        file;

      comparisonCompanyA =
        null;


      const output =
        aiElement(
          "aiCompareResult"
        );


      setLoading(
        output,
        `Analyzing Company A · ${file.name}…`
      );


      try {

        comparisonCompanyA =
          await prepareComparisonReport(
            file,
            "Company A"
          );


        const companyName =

          comparisonCompanyA
            ?.company
            ?.name

          ||

          "Company A";


        if (output) {

          if (
            comparisonCompanyB
          ) {

            output.textContent =
              `${companyName} is ready. Both companies are ready — tap Compare with AI.`;

          }

          else {

            output.textContent =
              `${companyName} is ready. Select Company B annual report.`;

          }

        }

      }

      catch (
        error
      ) {

        console.error(
          "Company A preparation:",
          error
        );


        comparisonCompanyA =
          null;


        if (output) {

          output.textContent =
            `Company A failed: ${error.message}`;

        }

      }

      finally {

        clearLoading(
          output
        );

      }

    }
  );


/* ============================================================
   17. COMPANY B
   ============================================================ */

aiElement(
  "aiCompareB"
)
  ?.addEventListener(
    "change",
    async event => {

      const file =
        event.target
          .files?.[0];


      if (!file) {
        return;
      }


      comparisonFileB =
        file;

      comparisonCompanyB =
        null;


      const output =
        aiElement(
          "aiCompareResult"
        );


      setLoading(
        output,
        `Analyzing Company B · ${file.name}…`
      );


      try {

        comparisonCompanyB =
          await prepareComparisonReport(
            file,
            "Company B"
          );


        const companyName =

          comparisonCompanyB
            ?.company
            ?.name

          ||

          "Company B";


        if (output) {

          if (
            comparisonCompanyA
          ) {

            output.textContent =
              `${companyName} is ready. Both companies are ready — tap Compare with AI.`;

          }

          else {

            output.textContent =
              `${companyName} is ready. Select Company A annual report.`;

          }

        }

      }

      catch (
        error
      ) {

        console.error(
          "Company B preparation:",
          error
        );


        comparisonCompanyB =
          null;


        if (output) {

          output.textContent =
            `Company B failed: ${error.message}`;

        }

      }

      finally {

        clearLoading(
          output
        );

      }

    }
  );


/* ============================================================
   18. FINAL JSON-ONLY COMPARISON
   ============================================================ */

async function compareReports() {

  const output =
    aiElement(
      "aiCompareResult"
    );


  if (
    !comparisonFileA ||
    !comparisonFileB
  ) {

    if (output) {

      output.textContent =
        "Select both company annual-report PDFs first.";

    }

    return;

  }


  if (
    !comparisonCompanyA ||
    !comparisonCompanyB
  ) {

    if (output) {

      output.textContent =
        "Wait until both annual reports finish processing.";

    }

    return;

  }


  setLoading(
    output,
    "FinSight AI is comparing the prepared company research…"
  );


  try {

    /*
     * IMPORTANT:
     *
     * No PDFs are sent here.
     * Only the compact JSON profiles.
     */

    const response =
      await fetch(
        "/api/ai/compare",
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({

              companyA:
                comparisonCompanyA,

              companyB:
                comparisonCompanyB

            })
        }
      );


    const payload =
      await readJSONResponse(
        response
      );


    const comparison =
      payload.comparison;


    if (!comparison) {

      throw new Error(
        "FinSight returned no usable company comparison."
      );

    }


    if (output) {

      output.innerHTML =
        renderComparison(
          comparison
        );

    }

  }

  catch (
    error
  ) {

    console.error(
      "AI comparison:",
      error
    );


    if (output) {

      output.textContent =
        error.message;

    }

  }

  finally {

    clearLoading(
      output
    );

  }

}


/* ============================================================
   19. COMPARISON BUTTON
   ============================================================ */

aiElement(
  "runAICompare"
)
  ?.addEventListener(
    "click",
    compareReports
  );


/* ============================================================
   20. ANNUAL REPORT FILE LABEL
   ============================================================ */

aiElement(
  "aiReportFile"
)
  ?.addEventListener(
    "change",
    event => {

      const file =
        event.target
          .files?.[0];


      if (!file) {
        return;
      }


      const output =
        aiElement(
          "aiReportResult"
        );


      if (output) {

        output.textContent =
          `${file.name} selected. Tap Run AI analysis.`;

      }

    }
  );
