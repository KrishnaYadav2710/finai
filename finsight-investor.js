/* ============================================================
   FINSIGHT AI — INVESTOR ENGINE
   Report-first edition

   RULES:
   - No demo/sample company data.
   - Uploaded evidence is the source of truth.
   - Missing values remain unavailable.
   - Consolidated financials are preferred.
   - Multi-year reports are stored year-by-year.
   - Market data is fetched only for a verified listed ticker.
   ============================================================ */


/* ============================================================
   1. STATE
   ============================================================ */

let primary = null;

let selectedYear = "all";

let pdfEvidence = [];

let extractedCompany = null;

let marketData = null;

let latestAIAnalysis = null;

let valuationState = null;

let currentReportFile = null;


window.finSightPDFContext = null;

window.finSightResearchContext = null;


/* ============================================================
   2. DOM HELPERS
   ============================================================ */

const $ = selector =>
  document.querySelector(selector);


const $$ = selector =>
  [...document.querySelectorAll(selector)];


/* ============================================================
   3. FORMATTERS
   ============================================================ */

const numberFormatter =
  new Intl.NumberFormat(
    "en-IN",
    {
      maximumFractionDigits: 1
    }
  );


const compactFormatter =
  new Intl.NumberFormat(
    "en-IN",
    {
      notation: "compact",
      maximumFractionDigits: 1
    }
  );


function finite(value) {

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;

}


function safeDiv(a, b) {

  const numerator =
    finite(a);

  const denominator =
    finite(b);

  if (
    numerator == null ||
    denominator == null ||
    denominator === 0
  ) {
    return null;
  }

  return numerator / denominator;

}


function change(current, previous) {

  const a =
    finite(current);

  const b =
    finite(previous);

  if (
    a == null ||
    b == null ||
    b === 0
  ) {
    return null;
  }

  return (
    a - b
  ) / Math.abs(b);

}


function average(a, b) {

  const x =
    finite(a);

  const y =
    finite(b);

  if (
    x == null &&
    y == null
  ) {
    return null;
  }

  if (x == null) {
    return y;
  }

  if (y == null) {
    return x;
  }

  return (
    x + y
  ) / 2;

}


function formatNumber(value) {

  const number =
    finite(value);

  return number == null
    ? "N/A"
    : numberFormatter.format(number);

}


function money(value) {

  const number =
    finite(value);

  return number == null
    ? "N/A"
    : `₹${numberFormatter.format(number)} Cr`;

}


function percentage(value) {

  const number =
    finite(value);

  return number == null
    ? "N/A"
    : `${numberFormatter.format(number * 100)}%`;

}


function multiple(value) {

  const number =
    finite(value);

  return number == null
    ? "N/A"
    : `${numberFormatter.format(number)}×`;

}


function priceMoney(value) {

  const number = finite(value);

  if (number == null) {
    return "N/A";
  }

  const rawCurrency =
    marketData?.currency ||
    extractedCompany?.currency ||
    "INR";

  const symbols = {
    INR: "₹",
    USD: "$",
    GBP: "£",
    EUR: "€",
    JPY: "¥",
    "₹": "₹",
    "$": "$",
    "£": "£",
    "€": "€",
    "¥": "¥"
  };

  const prefix = symbols[rawCurrency] || `${rawCurrency} `;
  return `${prefix}${numberFormatter.format(number)}`;

}


function yearLabel(row) {

  if (row?.financial_year) {
    return String(row.financial_year);
  }

  const year =
    finite(row?.year);

  if (year == null) {
    return "Unknown FY";
  }

  return `FY${year - 1}-${String(year).slice(-2)}`;

}


function clamp(value) {

  return Math.max(
    0,
    Math.min(
      100,
      value
    )
  );

}


/* ============================================================
   4. UI STATE
   ============================================================ */

function showWorkspace() {

  $("#emptyState").hidden =
    true;

  $("#companyWorkspace").hidden =
    false;

}


function showEmptyState() {

  $("#emptyState").hidden =
    false;

  $("#companyWorkspace").hidden =
    true;

}


function showError(message) {

  const box =
    $("#error");

  if (!box) {
    return;
  }

  let readableMessage =
    "Unexpected error.";

  if (
    typeof message === "string"
  ) {

    readableMessage =
      message;

  } else if (
    message instanceof Error
  ) {

    readableMessage =
      message.message;

  } else if (
    message &&
    typeof message === "object"
  ) {

    readableMessage =
      message.error?.message ||
      message.error ||
      message.message ||
      message.details ||
      message.statusText ||
      JSON.stringify(
        message,
        null,
        2
      );

  }

  box.textContent =
    readableMessage;

  box.hidden =
    false;

}


function clearError() {

  const box =
    $("#error");

  if (box) {
    box.hidden = true;
  }

}


function setScanProgress(
  current,
  total,
  message = ""
) {

  const wrapper =
    $("#scanProgress");

  const bar =
    $("#scanBar");

  const text =
    $("#scanProgressText");

  if (
    !wrapper ||
    !bar ||
    !text
  ) {
    return;
  }

  wrapper.hidden =
    false;

  const percent =
    total > 0
      ? Math.round(
          current / total * 100
        )
      : 0;

  bar.style.width =
    `${Math.max(
      0,
      Math.min(
        100,
        percent
      )
    )}%`;

  text.textContent =
    message ||
    `${current}/${total} pages · ${percent}%`;

}


function hideScanProgress() {

  const wrapper =
    $("#scanProgress");

  if (wrapper) {
    wrapper.hidden = true;
  }

}


/* ============================================================
   5. NORMALIZE EXTRACTED FINANCIAL DATA
   ============================================================ */

function normalizeFinancialRow(row) {

  return {

    company:
      row.company ||
      extractedCompany?.name ||
      "Unknown company",

    financial_year:
      row.financial_year ||
      null,

    year:
      finite(
        row.year ||
        row.end_year
      ),

    statement_basis:
      row.statement_basis ||
      "Consolidated",

    revenue:
      finite(row.revenue),

    ebitda:
      finite(row.ebitda),

    cogs:
      finite(row.cogs),

    operating_income:
      finite(
        row.operating_income
      ),

    net_income:
      finite(row.net_income),

    total_assets:
      finite(row.total_assets),

    current_assets:
      finite(row.current_assets),

    current_liabilities:
      finite(
        row.current_liabilities
      ),

    total_debt:
      finite(row.total_debt),

    cash:
      finite(
        row.cash ||
        row.cash_and_equivalents
      ),

    total_equity:
      finite(row.total_equity),

    operating_cash_flow:
      finite(
        row.operating_cash_flow
      ),

    capex:
      finite(row.capex),

    inventory:
      finite(row.inventory),

    accounts_receivable:
      finite(
        row.accounts_receivable
      ),

    accounts_payable:
      finite(
        row.accounts_payable
      ),

    finance_cost:
      finite(row.finance_cost),

    shares_outstanding:
      finite(
        row.shares_outstanding
      ),

    source_pages:
      Array.isArray(
        row.source_pages
      )
        ? row.source_pages
        : [],

    extraction_notes:
      row.extraction_notes ||
      null

  };

}


function normalizeFinancialDataset(rows) {

  if (!Array.isArray(rows)) {
    return [];
  }

  const normalized = rows
    .map(normalizeFinancialRow)
    .filter(row => row.year != null);

  /*
   * One row per financial year. Annual reports often repeat a prior year
   * as a comparative column or include both standalone and consolidated
   * statements. Prefer consolidated rows, then the row with the most
   * usable investor fields. This prevents duplicate FY points in charts.
   */
  const completeness = row => {
    const fields = [
      "revenue", "ebitda", "operating_income", "net_income",
      "total_assets", "current_assets", "current_liabilities",
      "total_debt", "cash", "total_equity", "operating_cash_flow",
      "capex", "inventory", "accounts_receivable",
      "accounts_payable", "finance_cost", "shares_outstanding"
    ];
    return fields.reduce((n, key) => n + (row[key] != null ? 1 : 0), 0);
  };

  const quality = row => {
    const basis = String(row.statement_basis || "").toLowerCase();
    const consolidatedBonus = basis.includes("consolidated") ? 100 : 0;
    const mixedPenalty = basis.includes("mixed") ? -10 : 0;
    return consolidatedBonus + mixedPenalty + completeness(row);
  };

  const byYear = new Map();

  for (const row of normalized) {
    const key = Number(row.year);
    const existing = byYear.get(key);
    if (!existing || quality(row) > quality(existing)) {
      byYear.set(key, row);
    }
  }

  return [...byYear.values()].sort((a, b) => a.year - b.year);

}


/* ============================================================
   6. FINANCIAL CALCULATIONS
   ============================================================ */

function calculateRow(
  row,
  previous = null
) {

  const grossProfit =

    row.revenue != null &&
    row.cogs != null

      ? row.revenue -
        row.cogs

      : null;

const capitalEmployed =

  row.total_equity != null &&
  row.total_debt != null &&
  row.cash != null

    ? row.total_equity +
      row.total_debt -
      row.cash

    : row.total_assets != null &&
      row.current_liabilities != null

    ? row.total_assets -
      row.current_liabilities

    : null;


const previousCapitalEmployed =

  previous?.total_equity != null &&
  previous?.total_debt != null &&
  previous?.cash != null

    ? previous.total_equity +
      previous.total_debt -
      previous.cash

    : previous?.total_assets != null &&
      previous?.current_liabilities != null

    ? previous.total_assets -
      previous.current_liabilities

    : null;




  const averageCapital =
    average(
      capitalEmployed,
      previousCapitalEmployed
    );


  const averageEquity =
    average(
      row.total_equity,
      previous?.total_equity
    );


  const averageAssets =
    average(
      row.total_assets,
      previous?.total_assets
    );


  const averageReceivables =
    average(
      row.accounts_receivable,
      previous?.accounts_receivable
    );


  const averageInventory =
    average(
      row.inventory,
      previous?.inventory
    );


  const averagePayables =
    average(
      row.accounts_payable,
      previous?.accounts_payable
    );


  const netDebt =

  row.total_debt != null &&
  row.cash != null

    ? row.total_debt -
      row.cash

    : null;


  return {

    ...row,

    gross_profit:
      grossProfit,

    gross_margin:
      safeDiv(
        grossProfit,
        row.revenue
      ),

    ebitda_margin:
      safeDiv(
        row.ebitda,
        row.revenue
      ),

    operating_margin:
      safeDiv(
        row.operating_income,
        row.revenue
      ),

    net_margin:
      safeDiv(
        row.net_income,
        row.revenue
      ),

    current_ratio:
      safeDiv(
        row.current_assets,
        row.current_liabilities
      ),

    quick_ratio:

      row.current_assets != null &&
      row.inventory != null

        ? safeDiv(
            row.current_assets -
              row.inventory,
            row.current_liabilities
          )

        : null,

    debt_equity:
      safeDiv(
        row.total_debt,
        row.total_equity
      ),

    net_debt:
      netDebt,

    net_debt_ebitda:
      safeDiv(
        netDebt,
        row.ebitda
      ),

    roe:
      safeDiv(
        row.net_income,
        averageEquity
      ),

    roa:
      safeDiv(
        row.net_income,
        averageAssets
      ),

    roce:
      safeDiv(
        row.operating_income,
        averageCapital
      ),

    asset_turnover:
      safeDiv(
        row.revenue,
        averageAssets
      ),

    receivable_days:

      row.revenue != null &&
      averageReceivables != null

        ? safeDiv(
            averageReceivables * 365,
            row.revenue
          )

        : null,

    inventory_days:

      row.cogs != null &&
      averageInventory != null

        ? safeDiv(
            averageInventory * 365,
            row.cogs
          )

        : null,

    payable_days:

      row.cogs != null &&
      averagePayables != null

        ? safeDiv(
            averagePayables * 365,
            row.cogs
          )

        : null,

    interest_coverage:
      safeDiv(
        row.operating_income,
        row.finance_cost
      ),

    cash_conversion:
      safeDiv(
        row.operating_cash_flow,
        row.net_income
      ),

    free_cash_flow:

      row.operating_cash_flow != null &&
      row.capex != null

        ? row.operating_cash_flow -
          row.capex

        : null,

    revenue_growth:
      change(
        row.revenue,
        previous?.revenue
      ),

    ebitda_growth:
      change(
        row.ebitda,
        previous?.ebitda
      ),

    income_growth:
      change(
        row.net_income,
        previous?.net_income
      ),

    debt_growth:
      change(
        row.total_debt,
        previous?.total_debt
      )

  };

}


function calculateDataset(
  data = primary
) {

  if (
    !Array.isArray(data) ||
    !data.length
  ) {
    return [];
  }

  const sorted =
    [...data].sort(
      (a, b) =>
        a.year - b.year
    );

  return sorted.map(
    (row, index) =>
      calculateRow(
        row,
        sorted[index - 1] ||
        null
      )
  );

}


/* ============================================================
   7. FINANCIAL HEALTH SCORE
   ============================================================ */

function buildScores(row) {

  const scores = {};

  const profitabilityInputs = [];
  if (row.operating_margin != null) {
    profitabilityInputs.push(clamp(40 + row.operating_margin * 180));
  }
  if (row.roe != null) {
    profitabilityInputs.push(clamp(40 + row.roe * 120));
  }
  if (row.roce != null) {
    profitabilityInputs.push(clamp(40 + row.roce * 120));
  }
  if (profitabilityInputs.length) {
    scores.Profitability = profitabilityInputs.reduce((a, b) => a + b, 0) / profitabilityInputs.length;
  }

  if (row.current_ratio != null) {
    scores.Liquidity = clamp(row.current_ratio >= 2 ? 100 : row.current_ratio * 50);
  }

  if (row.debt_equity != null) {
    scores.Leverage = clamp(100 - row.debt_equity * 55);
  }

  if (row.cash_conversion != null) {
    scores["CFO / net profit"] = clamp(row.cash_conversion * 75);
  }

  const efficiencyInputs = [];
  if (row.receivable_days != null) {
    efficiencyInputs.push(clamp(100 - Math.max(0, row.receivable_days - 30)));
  }
  if (row.inventory_days != null) {
    efficiencyInputs.push(clamp(100 - Math.max(0, row.inventory_days - 45) * 0.6));
  }
  if (efficiencyInputs.length) {
    scores.Efficiency = efficiencyInputs.reduce((a, b) => a + b, 0) / efficiencyInputs.length;
  }

  return scores;

}


/* ============================================================
   8. DETERMINISTIC INVESTOR SIGNALS
   ============================================================ */

function buildSignals(row) {

  const signals =
    [];


  function add(
    type,
    title,
    text
  ) {

    signals.push({
      type,
      title,
      text
    });

  }


  if (
    row.revenue_growth != null
  ) {

    add(

      row.revenue_growth > 0.10
        ? "good"
        : row.revenue_growth >= 0
        ? "watch"
        : "bad",

      "Revenue momentum",

      `Revenue ${
        row.revenue_growth >= 0
          ? "grew"
          : "declined"
      } ${formatNumber(
        Math.abs(
          row.revenue_growth
        ) * 100
      )}% year-on-year.`

    );

  }


  if (
    row.ebitda_margin != null
  ) {

    add(

      row.ebitda_margin >= 0.20
        ? "good"
        : row.ebitda_margin >= 0.10
        ? "watch"
        : "bad",

      "EBITDA margin",

      `EBITDA margin is ${percentage(
        row.ebitda_margin
      )}.`

    );

  }


  if (
    row.cash_conversion != null
  ) {

    add(

      row.cash_conversion >= 1
        ? "good"
        : row.cash_conversion >= 0.75
        ? "watch"
        : "bad",

      "Earnings cash conversion",

      `Operating cash flow is ${multiple(
        row.cash_conversion
      )} reported net income.`

    );

  }


  if (
    row.debt_equity != null
  ) {

    add(

      row.debt_equity <= 0.7
        ? "good"
        : row.debt_equity <= 1.5
        ? "watch"
        : "bad",

      "Balance-sheet leverage",

      `Debt/equity is ${multiple(
        row.debt_equity
      )}.`

    );

  }


  if (
    row.current_ratio != null
  ) {

    add(

      row.current_ratio >= 1.5
        ? "good"
        : row.current_ratio >= 1
        ? "watch"
        : "bad",

      "Liquidity",

      `Current ratio is ${multiple(
        row.current_ratio
      )}.`

    );

  }


  if (
    row.roe != null
  ) {

    add(

      row.roe >= 0.18
        ? "good"
        : row.roe >= 0.10
        ? "watch"
        : "bad",

      "Return on equity",

      `ROE is ${percentage(
        row.roe
      )}.`

    );

  }


  if (
    row.receivable_days != null
  ) {

    add(

      row.receivable_days <= 45
        ? "good"
        : row.receivable_days <= 75
        ? "watch"
        : "bad",

      "Receivables",

      `Estimated receivable days are ${formatNumber(
        row.receivable_days
      )}.`

    );

  }


  if (
    row.interest_coverage != null
  ) {

    add(

      row.interest_coverage >= 3
        ? "good"
        : row.interest_coverage >= 1.5
        ? "watch"
        : "bad",

      "Interest coverage",

      `Operating income covers finance cost ${multiple(
        row.interest_coverage
      )}.`

    );

  }


  return signals;

}


/* ============================================================
   9. YEAR SELECTION
   ============================================================ */

function getCalculatedRows() {

  return calculateDataset(
    primary
  );

}


function getSelectedRow() {

  const rows =
    getCalculatedRows();

  if (!rows.length) {
    return null;
  }

  if (
    selectedYear === "all"
  ) {
    return rows.at(-1);
  }

  return (
    rows.find(
      row =>
        String(row.year) ===
        String(selectedYear)
    ) ||
    rows.at(-1)
  );

}


function renderYearTabs() {

  const container =
    $("#yearTabs");

  if (
    !container ||
    !primary?.length
  ) {
    return;
  }


  const rows =
    getCalculatedRows();


  const buttons = [

    {
      key: "all",
      label:
        rows.length > 1
          ? `${rows.length}-Year View`
          : "Company View"
    },

    ...rows
      .slice()
      .reverse()
      .map(
        row => ({
          key:
            String(row.year),

          label:
            yearLabel(row)
        })
      )

  ];


  container.innerHTML =

    buttons

      .map(
        item => `

          <button
            type="button"
            class="year-tab ${
              String(selectedYear) ===
              String(item.key)
                ? "active"
                : ""
            }"
            data-year="${item.key}"
          >
            ${item.label}
          </button>

        `
      )

      .join("");


  container

    .querySelectorAll(
      ".year-tab"
    )

    .forEach(
      button => {

        button.addEventListener(
          "click",
          () => {

            selectedYear =
              button.dataset.year;

            renderDashboard();

          }
        );

      }
    );

}


/* ============================================================
   10. COMPANY HEADER
   ============================================================ */

function renderCompanyHeader() {

  if (
    !primary?.length
  ) {
    return;
  }


  const rows =
    getCalculatedRows();


  const latest =
    rows.at(-1);


  const first =
    rows[0];


  $("#companyName").textContent =

    extractedCompany?.name ||
    latest.company ||
    "Uploaded company";


  $("#period").textContent =

    rows.length > 1

      ? `${yearLabel(first)} → ${yearLabel(latest)}`

      : yearLabel(latest);


  $("#statementBasis").textContent =

    latest.statement_basis
      ? `${latest.statement_basis} financials`
      : "Financial statements";


  const extractionConfidence =

    extractedCompany
      ?.extraction_confidence

    ||

    "Report extracted";


  $("#confidence").textContent =
    extractionConfidence;

}


/* ============================================================
   11. SNAPSHOT METRICS
   ============================================================ */

function metricCard(
  label,
  value,
  changeValue = null
) {

  let changeMarkup =
    `<small class="neutral">Report value</small>`;


  if (
    changeValue != null
  ) {

    const positive =
      changeValue >= 0;


    changeMarkup = `

      <small class="${
        positive
          ? "up"
          : "down"
      }">

        ${
          positive
            ? "↑"
            : "↓"
        }

        ${formatNumber(
          Math.abs(
            changeValue
          ) * 100
        )}%

      </small>

    `;

  }


  return `

    <article class="metric">

      <span>
        ${label}
      </span>

      <strong>
        ${value}
      </strong>

      ${changeMarkup}

    </article>

  `;

}


function renderSnapshot() {

  const row =
    getSelectedRow();

  if (!row) {
    return;
  }


  $("#snapshotTitle").textContent =

    selectedYear === "all"

      ? `${yearLabel(row)} latest snapshot`

      : yearLabel(row);


  const metrics = [

    [
      "Revenue",
      money(row.revenue),
      row.revenue_growth
    ],

    [
      "EBITDA",
      money(row.ebitda),
      row.ebitda_growth
    ],

    [
      "Net profit",
      money(row.net_income),
      row.income_growth
    ],

    [
      "EBITDA margin",
      percentage(
        row.ebitda_margin
      ),
      null
    ],

    [
      "ROCE",
      percentage(row.roce),
      null
    ]

  ];


  $("#metrics").innerHTML =

    metrics

      .map(
        item =>
          metricCard(...item)
      )

      .join("");

}


/* ============================================================
   12. FINANCIAL HISTORY TABLE
   ============================================================ */

function renderFinancialHistory() {

  const rows =
    getCalculatedRows();


  if (!rows.length) {
    return;
  }


  $("#financialHistoryHead")
    .innerHTML = `

      <tr>

        <th>
          Metric
        </th>

        ${

          rows

            .map(
              row => `

                <th>
                  ${yearLabel(row)}
                </th>

              `
            )

            .join("")

        }

      </tr>

    `;


  const metrics = [

    [
      "Revenue",
      row =>
        money(row.revenue)
    ],

    [
      "EBITDA",
      row =>
        money(row.ebitda)
    ],

    [
      "EBITDA margin",
      row =>
        percentage(
          row.ebitda_margin
        )
    ],

    [
      "Operating profit",
      row =>
        money(
          row.operating_income
        )
    ],

    [
      "Net profit",
      row =>
        money(row.net_income)
    ],

    [
      "Operating cash flow",
      row =>
        money(
          row.operating_cash_flow
        )
    ],

    [
      "Free cash flow",
      row =>
        money(
          row.free_cash_flow
        )
    ],

    [
      "Total debt",
      row =>
        money(row.total_debt)
    ],

    [
      "Net debt",
      row =>
        money(row.net_debt)
    ],

    [
      "Debt / equity",
      row =>
        multiple(
          row.debt_equity
        )
    ],

    [
      "ROE",
      row =>
        percentage(row.roe)
    ],

    [
      "ROCE",
      row =>
        percentage(row.roce)
    ],

    [
      "Current ratio",
      row =>
        multiple(
          row.current_ratio
        )
    ],

    [
      "Receivable days",
      row =>
        row.receivable_days == null
          ? "N/A"
          : `${formatNumber(
              row.receivable_days
            )} days`
    ]

  ];


  $("#financialHistoryBody")
    .innerHTML =

    metrics

      .map(
        (
          [
            label,
            formatter
          ]
        ) => `

          <tr>

            <td>
              ${label}
            </td>

            ${

              rows

                .map(
                  row => `

                    <td>
                      ${formatter(row)}
                    </td>

                  `
                )

                .join("")

            }

          </tr>

        `
      )

      .join("");

}


/* ============================================================
   13. MULTI-YEAR CHART
   ============================================================ */

function renderChart() {

  const rows =
    getCalculatedRows();


  const chart =
    $("#chart");


  if (
    !chart ||
    !rows.length
  ) {
    return;
  }


  const series = [

    {
      key:
        "revenue",
      label:
        "Revenue",
      stroke:
        "#2f7d68"
    },

    {
      key:
        "ebitda",
      label:
        "EBITDA",
      stroke:
        "#879c57"
    },

    {
      key:
        "net_income",
      label:
        "Net profit",
      stroke:
        "#17332d"
    }

  ];


  const availableValues =

    rows.flatMap(
      row =>
        series
          .map(
            item =>
              finite(
                row[item.key]
              )
          )
          .filter(
            value =>
              value != null
          )
    );


  if (
    !availableValues.length
  ) {

    chart.innerHTML =
      "<p>No comparable financial series was extracted.</p>";

    return;
  }


  const width =
    900;

  const height =
    330;

  const left =
    72;

  const right =
    28;

  const top =
    30;

  const bottom =
    58;


  const max =
    Math.max(
      ...availableValues
    ) * 1.12;


  const x =
    index => {

      if (
        rows.length === 1
      ) {
        return width / 2;
      }

      return (

        left

        +

        index *

        (
          (
            width -
            left -
            right
          )

          /

          (
            rows.length - 1
          )
        )

      );

    };


  const y =
    value =>

      top

      +

      (
        1 -
        value / max
      )

      *

      (
        height -
        top -
        bottom
      );


  function pathFor(key) {

    let path =
      "";

    let started =
      false;


    rows.forEach(
      (row, index) => {

        const value =
          finite(
            row[key]
          );


        if (
          value == null
        ) {
          started = false;
          return;
        }


        path +=

          `${started ? " L" : " M"}`

          +

          `${x(index)} ${y(value)}`;


        started =
          true;

      }
    );


    return path;

  }


  const horizontalGrid =

    [0, 0.25, 0.5, 0.75, 1]

      .map(
        ratio => {

          const value =
            max * ratio;

          const py =
            y(value);


          return `

            <line
              x1="${left}"
              x2="${width - right}"
              y1="${py}"
              y2="${py}"
              stroke="rgba(22,49,43,.10)"
              stroke-width="1"
            />

            <text
              x="${left - 12}"
              y="${py + 4}"
              text-anchor="end"
              fill="#76847f"
              font-size="10"
            >
              ${compactFormatter.format(
                value
              )}
            </text>

          `;

        }
      )

      .join("");


  const yearLabels =

    rows

      .map(
        (row, index) => `

          <text
            x="${x(index)}"
            y="${height - 18}"
            text-anchor="middle"
            fill="#52645f"
            font-size="11"
          >
            ${yearLabel(row)}
          </text>

        `
      )

      .join("");


  const paths =

    series

      .map(
        item => `

          <path
            d="${pathFor(
              item.key
            )}"
            fill="none"
            stroke="${item.stroke}"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />

          ${

            rows

              .map(
                (row, index) => {

                  const value =
                    finite(
                      row[item.key]
                    );


                  if (
                    value == null
                  ) {
                    return "";
                  }


                  return `

                    <circle
                      cx="${x(index)}"
                      cy="${y(value)}"
                      r="4"
                      fill="${item.stroke}"
                    >

                      <title>
                        ${item.label} · ${yearLabel(row)} · ${money(value)}
                      </title>

                    </circle>

                  `;

                }
              )

              .join("")

          }

        `
      )

      .join("");


  chart.innerHTML = `

    <svg
      viewBox="0 0 ${width} ${height}"
      role="img"
      aria-label="Multi-year revenue, EBITDA and net profit trend"
    >

      ${horizontalGrid}

      ${paths}

      ${yearLabels}

    </svg>

  `;

}


/* ============================================================
   14. SCORE
   ============================================================ */

function renderScore() {

  const row = getSelectedRow();
  if (!row) {
    return;
  }

  const scoreSet = buildScores(row);
  const validEntries = Object.entries(scoreSet)
    .filter(([, value]) => Number.isFinite(value));
  const validValues = validEntries.map(([, value]) => value);

  const total = validValues.length
    ? Math.round(validValues.reduce((sum, value) => sum + value, 0) / validValues.length)
    : null;

  $("#ring").style.setProperty("--score", total ?? 0);
  $("#score").textContent = total == null ? "N/A" : total;

  $("#scoreLabel").textContent =
    total == null
      ? "Insufficient financial data"
      : total >= 80
      ? "Strong financial profile"
      : total >= 65
      ? "Good financial profile"
      : total >= 50
      ? "Mixed financial profile"
      : "Elevated financial risk";

  $("#scoreCopy").textContent = total == null
    ? "FinSight could not calculate a reliable financial-health score from the available annual-report data."
    : `Score calculated from ${validEntries.length} available financial-health categories. Missing categories are excluded rather than scored as zero.`;

  $("#scoreBars").innerHTML = validEntries.length
    ? validEntries.map(([name, value]) => `
        <div class="score-row">
          <span>${name}</span>
          <div class="track"><i style="width:${Math.round(value)}%"></i></div>
          <b>${Math.round(value)}</b>
        </div>
      `).join("")
    : `<div class="finding">Insufficient annual-report data to calculate financial-health categories.</div>`;

}


/* ============================================================
   15. GOOD / BAD / WATCH
   ============================================================ */

function renderSignals() {

  const row =
    getSelectedRow();

  if (!row) {
    return;
  }


  const signals =
    buildSignals(row);


  for (
    const type of [
      "good",
      "bad",
      "watch"
    ]
  ) {

    const target =
      $(`#${type}List`);


    if (!target) {
      continue;
    }


    const items =

      signals.filter(
        item =>
          item.type === type
      );


    target.innerHTML =

      items.length

        ?

        items

          .map(
            item => `

              <div class="finding">

                <b>
                  ${item.title}
                </b>

                <br>

                ${item.text}

              </div>

            `
          )

          .join("")

        :

        `<div class="finding">
           No deterministic signal in this category from the currently available financial fields.
         </div>`;

  }

}


/* ============================================================
   16. DEEP RESEARCH TABS
   ============================================================ */

const researchSections = [

  "Financials",

  "Cash & earnings",

  "Working capital",

  "Debt",

  "Returns",

  "Report evidence",

  "Investor checklist"

];


function cards(items) {

  return `

    <div class="panel-grid">

      ${

        items

          .map(
            (
              [
                heading,
                value,
                copy
              ]
            ) => `

              <article class="panel-card">

                <h4>
                  ${heading}
                </h4>

                ${
                  value
                    ? `<strong>${value}</strong>`
                    : ""
                }

                <p>
                  ${copy}
                </p>

              </article>

            `
          )

          .join("")

      }

    </div>

  `;

}


function renderResearchTabs() {

  const container =
    $("#sectionTabs");


  if (!container) {
    return;
  }


  container.innerHTML =

    researchSections

      .map(
        (name, index) => `

          <button
            type="button"
            class="tab ${
              index === 0
                ? "active"
                : ""
            }"
            data-section="${name}"
          >
            ${name}
          </button>

        `
      )

      .join("");


  container

    .querySelectorAll(
      ".tab"
    )

    .forEach(
      button => {

        button.addEventListener(
          "click",
          () => {

            container

              .querySelectorAll(
                ".tab"
              )

              .forEach(
                item =>
                  item.classList.remove(
                    "active"
                  )
              );


            button
              .classList
              .add(
                "active"
              );


            renderResearchSection(
              button.dataset.section
            );

          }
        );

      }
    );


  renderResearchSection(
    researchSections[0]
  );

}


function renderResearchSection(name) {

  const row =
    getSelectedRow();


  if (!row) {
    return;
  }


  let items =
    [];


  if (
    name === "Financials"
  ) {

    items = [

      [
        "Revenue",
        money(row.revenue),
        row.revenue_growth == null
          ? "Reported financial value."
          : `${percentage(
              row.revenue_growth
            )} year-on-year change.`
      ],

      [
        "EBITDA",
        money(row.ebitda),
        row.ebitda_margin == null
          ? "EBITDA margin unavailable."
          : `${percentage(
              row.ebitda_margin
            )} EBITDA margin.`
      ],

      [
        "Operating profit",
        money(
          row.operating_income
        ),
        row.operating_margin == null
          ? "Operating margin unavailable."
          : `${percentage(
              row.operating_margin
            )} operating margin.`
      ],

      [
        "Net profit",
        money(row.net_income),
        row.net_margin == null
          ? "Net margin unavailable."
          : `${percentage(
              row.net_margin
            )} net margin.`
      ],

      [
        "Total assets",
        money(row.total_assets),
        "Reported balance-sheet assets."
      ],

      [
        "Total equity",
        money(row.total_equity),
        "Reported shareholder equity."
      ]

    ];

  }


  if (
    name ===
    "Cash & earnings"
  ) {

    items = [

      [
        "Operating cash flow",
        money(
          row.operating_cash_flow
        ),
        "Cash generated from operations."
      ],

      [
        "CFO / profit",
        multiple(
          row.cash_conversion
        ),
        row.cash_conversion == null
          ? "Cannot calculate without both operating cash flow and profit."
          : "Operating cash flow relative to reported net profit."
      ],

      [
        "Capital expenditure",
        money(row.capex),
        row.capex == null
          ? "Not reliably extracted from the supplied report."
          : "Reported or extracted capital expenditure."
      ],

      [
        "Free cash flow",
        money(
          row.free_cash_flow
        ),
        row.free_cash_flow == null
          ? "Requires both operating cash flow and capex."
          : "Operating cash flow less extracted capex."
      ]

    ];

  }


  if (
    name ===
    "Working capital"
  ) {

    items = [

      [
        "Receivables",
        money(
          row.accounts_receivable
        ),
        row.receivable_days == null
          ? "Receivable days unavailable."
          : `${formatNumber(
              row.receivable_days
            )} estimated days.`
      ],

      [
        "Inventory",
        money(row.inventory),
        row.inventory_days == null
          ? "Inventory days unavailable."
          : `${formatNumber(
              row.inventory_days
            )} estimated days.`
      ],

      [
        "Payables",
        money(
          row.accounts_payable
        ),
        row.payable_days == null
          ? "Payable days unavailable."
          : `${formatNumber(
              row.payable_days
            )} estimated days.`
      ],

      [
        "Current ratio",
        multiple(
          row.current_ratio
        ),
        "Current assets relative to current liabilities."
      ],

      [
        "Quick ratio",
        multiple(
          row.quick_ratio
        ),
        "Liquidity excluding inventory."
      ]

    ];

  }


  if (
    name === "Debt"
  ) {

    items = [

      [
        "Total debt",
        money(row.total_debt),
        row.debt_growth == null
          ? "Reported debt."
          : `${percentage(
              row.debt_growth
            )} year-on-year change.`
      ],

      [
        "Net debt",
        money(row.net_debt),
        "Debt less extracted cash and cash equivalents."
      ],

      [
        "Debt / equity",
        multiple(
          row.debt_equity
        ),
        "Reported debt relative to equity."
      ],

      [
        "Net debt / EBITDA",
        multiple(
          row.net_debt_ebitda
        ),
        "Leverage relative to EBITDA."
      ],

      [
        "Finance cost",
        money(row.finance_cost),
        "Reported finance cost where available."
      ],

      [
        "Interest coverage",
        multiple(
          row.interest_coverage
        ),
        "Operating profit relative to finance cost."
      ]

    ];

  }


  if (
    name === "Returns"
  ) {

    items = [

      [
        "ROE",
        percentage(row.roe),
        "Net profit relative to average equity where data permits."
      ],

      [
        "ROCE",
        percentage(row.roce),
        "Operating return on average capital employed where data permits."
      ],

      [
        "ROA",
        percentage(row.roa),
        "Net profit relative to average assets."
      ],

      [
        "Asset turnover",
        multiple(
          row.asset_turnover
        ),
        "Revenue relative to average assets."
      ]

    ];

  }


  if (
    name ===
    "Report evidence"
  ) {

    const relevantEvidence =

      pdfEvidence.filter(
        item => {

          if (
            selectedYear === "all"
          ) {
            return true;
          }

          return (
            String(
              item.financialYear
            ) ===
            String(
              selectedYear
            )
          );

        }
      );


    items =

      relevantEvidence.length

        ?

        relevantEvidence

          .slice(
            0,
            18
          )

          .map(
            item => [

              item.title,

              item.label,

              item.text

            ]
          )

        :

        [

          [
            "Report evidence",
            "N/A",
            "No local disclosure snippet is available for this section."
          ]

        ];

  }


  if (
    name ===
    "Investor checklist"
  ) {

    items = [

      [
        "Business model",
        "Understand",
        "How does this company make money and what drives demand?"
      ],

      [
        "Growth quality",
        "Investigate",
        "Is growth organic, acquisition-led, price-led or capital intensive?"
      ],

      [
        "Cash quality",
        "Verify",
        "Are reported profits supported by operating cash flow?"
      ],

      [
        "Balance sheet",
        "Verify",
        "Can the company fund obligations and growth without excessive leverage?"
      ],

      [
        "Management",
        "Track",
        "Has management delivered on commitments made in earlier reports?"
      ],

      [
        "Valuation",
        "Separate decision",
        "A high-quality business can still be unattractive at an excessive market price."
      ]

    ];

  }


  $("#sectionPanel")
    .innerHTML =
    cards(items);

}


/* ============================================================
   17. INVESTOR BRIEF
   ============================================================ */

function renderInvestorBrief() {

  const row =
    getSelectedRow();

  if (!row) {
    return;
  }


  const signals =
    buildSignals(row);


  const bad =
    signals.filter(
      item =>
        item.type === "bad"
    );


  const watch =
    signals.filter(
      item =>
        item.type === "watch"
    );


  $("#briefTitle").textContent =

    bad.length

      ? `${row.company}: key financial issues require investigation`

      : `${row.company}: financial profile from available report data`;


  const pieces =
    [];


  if (
    row.revenue_growth != null
  ) {

    pieces.push(
      `Revenue growth was ${percentage(
        row.revenue_growth
      )}.`
    );

  }


  if (
    row.ebitda_margin != null
  ) {

    pieces.push(
      `EBITDA margin was ${percentage(
        row.ebitda_margin
      )}.`
    );

  }


  if (
    row.roce != null
  ) {

    pieces.push(
      `Calculated ROCE was ${percentage(
        row.roce
      )}.`
    );

  }


  if (
    row.debt_equity != null
  ) {

    pieces.push(
      `Debt/equity was ${multiple(
        row.debt_equity
      )}.`
    );

  }


  if (
    row.cash_conversion != null
  ) {

    pieces.push(
      `Operating cash flow covered reported profit ${multiple(
        row.cash_conversion
      )}.`
    );

  }


  if (bad.length) {

    pieces.push(

      `Current deterministic concerns include ${bad
        .map(
          item =>
            item.title.toLowerCase()
        )
        .join(", ")}.`

    );

  }

  else if (
    watch.length
  ) {

    pieces.push(

      `Items requiring monitoring include ${watch
        .map(
          item =>
            item.title.toLowerCase()
        )
        .join(", ")}.`

    );

  }


  pieces.push(
    "Use the annual-report AI and Ask FinSight sections for qualitative business, management, governance and auditor analysis."
  );


  $("#brief").textContent =
    pieces.join(" ");


  const questions =
    [];


  if (
    row.cash_conversion != null &&
    row.cash_conversion < 1
  ) {

    questions.push(
      "Why is operating cash flow below reported profit?"
    );

  }


  if (
    row.receivable_days != null &&
    row.receivable_days > 45
  ) {

    questions.push(
      "What is driving the receivable collection period?"
    );

  }


  if (
    row.debt_growth != null &&
    row.debt_growth > 0.15
  ) {

    questions.push(
      "Why did borrowing increase and what return is expected from the additional capital?"
    );

  }


  questions.push(

    "What are the largest risks disclosed by management?",

    "What did the statutory auditor identify as important?",

    "What related-party transactions should an investor understand?",

    "What management promises should be tracked in the next annual report?"

  );


  $("#questions").innerHTML =

    questions

      .map(
        question => `

          <div class="question">
            ${question}
          </div>

        `
      )

      .join("");

}


/* ============================================================
   18. PDF MULTI-REPORT SCANNER — 1,000 PAGES
   ============================================================ */

async function parsePDF(file) {

  if (
    !window.pdfjsLib
  ) {

    throw new Error(
      "PDF reader failed to load."
    );

  }


  pdfjsLib
    .GlobalWorkerOptions
    .workerSrc =

    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";


  const pdf =

    await pdfjsLib

      .getDocument({
        data:
          await file.arrayBuffer()
      })

      .promise;


  const MAX_PDF_SCAN_PAGES =
    1000;


  const pagesToScan =
    Math.min(
      pdf.numPages,
      MAX_PDF_SCAN_PAGES
    );


  const disclosureKeys = [

    [
      "Management discussion",
      "management discussion"
    ],

    [
      "Risk factors",
      "risk"
    ],

    [
      "Auditor / key audit matters",
      "key audit matter"
    ],

    [
      "Contingent liabilities",
      "contingent liabilit"
    ],

    [
      "Related parties",
      "related party"
    ],

    [
      "Capital expenditure",
      "capital expenditure"
    ],

    [
      "Borrowings",
      "borrowings"
    ],

    [
      "Segment reporting",
      "segment"
    ],

    [
      "Corporate governance",
      "corporate governance"
    ],

    [
      "Internal financial controls",
      "internal financial control"
    ],

    [
      "Management outlook",
      "outlook"
    ],

    [
      "Acquisitions",
      "acquisition"
    ],

    [
      "Cash flow",
      "cash flow"
    ],

    [
      "Dividend",
      "dividend"
    ],

    [
      "IPO / listing",
      "initial public offer"
    ]

  ];


  const found =
    [];


  const detectedReports =
    [];


  const reportMap =
    new Map();


  function makeYearInfo(
    startYear,
    rawEnd
  ) {

    let endYear =
      Number(rawEnd);


    if (
      endYear < 100
    ) {

      endYear =

        Math.floor(
          startYear / 100
        ) * 100

        +

        endYear;


      if (
        endYear <=
        startYear
      ) {

        endYear +=
          100;

      }

    }


    return {

      startYear,

      endYear,

      label:
        `FY${startYear}-${String(
          endYear
        ).slice(-2)}`

    };

  }


  function strongYear(text) {

    const match =

      String(
        text || ""
      )

        .replace(
          /\s+/g,
          " "
        )

        .match(
          /annual\s+report\s+(20\d{2})\s*[-–—]\s*(\d{2,4})/i
        );


    if (!match) {
      return null;
    }


    return makeYearInfo(
      Number(match[1]),
      Number(match[2])
    );

  }


  function weakYear(text) {

    const normalized =

      String(
        text || ""
      )

        .replace(
          /\s+/g,
          " "
        );


    let match =

      normalized.match(
        /financial\s+year\s+(20\d{2})\s*[-–—]\s*(\d{2,4})/i
      );


    if (match) {

      return makeYearInfo(
        Number(match[1]),
        Number(match[2])
      );

    }


    match =

      normalized.match(
        /\bFY\s*(20\d{2})\s*[-–—]\s*(\d{2,4})/i
      );


    if (match) {

      return makeYearInfo(
        Number(match[1]),
        Number(match[2])
      );

    }


    return null;

  }


  let currentReport =
    null;


  setScanProgress(
    0,
    pagesToScan,
    `Preparing ${pagesToScan} PDF pages…`
  );


  for (
    let pageNumber = 1;
    pageNumber <= pagesToScan;
    pageNumber++
  ) {

    const page =
      await pdf.getPage(
        pageNumber
      );


    const content =
      await page
        .getTextContent();


    const text =

      content.items

        .map(
          item =>
            item.str
        )

        .join(" ")

        .replace(
          /\s+/g,
          " "
        )

        .trim();


    const lower =
      text.toLowerCase();


    const strong =
      strongYear(text);


    if (strong) {

      const key =
        `${strong.startYear}-${strong.endYear}`;


      if (
        !reportMap.has(key)
      ) {

        if (
          currentReport &&
          currentReport.endPage == null
        ) {

          currentReport.endPage =
            pageNumber - 1;

        }


        const report = {

          ...strong,

          startPage:
            pageNumber,

          endPage:
            null,

          disclosureCount:
            0

        };


        detectedReports.push(
          report
        );


        reportMap.set(
          key,
          report
        );


        currentReport =
          report;

      }

      else {

        currentReport =
          reportMap.get(key);

      }

    }


    if (!currentReport) {

      const weak =
        weakYear(text);


      if (weak) {

        const key =
          `${weak.startYear}-${weak.endYear}`;


        if (
          !reportMap.has(key)
        ) {

          const report = {

            ...weak,

            startPage:
              pageNumber,

            endPage:
              null,

            disclosureCount:
              0

          };


          detectedReports.push(
            report
          );


          reportMap.set(
            key,
            report
          );


          currentReport =
            report;

        }

      }

    }


    for (
      const [
        title,
        keyword
      ]
      of disclosureKeys
    ) {

      if (
        !lower.includes(
          keyword
        )
      ) {
        continue;
      }


      const reportLabel =
        currentReport?.label ||
        "Unknown FY";


      const duplicate =

        found.some(
          item =>
            item.title === title &&
            item.report ===
              reportLabel
        );


      if (duplicate) {
        continue;
      }


      const index =
        lower.indexOf(
          keyword
        );


      found.push({

        title,

        report:
          reportLabel,

        financialYear:
          currentReport?.endYear ||
          null,

        page:
          pageNumber,

        label:
          `${reportLabel} · PDF page ${pageNumber}`,

        text:

          text.slice(
            Math.max(
              0,
              index - 120
            ),
            Math.min(
              text.length,
              index + 420
            )
          )

          +

          "…"

      });


      if (currentReport) {

        currentReport
          .disclosureCount++;

      }

    }


    if (
      pageNumber === 1 ||
      pageNumber % 10 === 0 ||
      pageNumber === pagesToScan
    ) {

      setScanProgress(

        pageNumber,

        pagesToScan,

        `Scanning report · ${pageNumber}/${pagesToScan} pages`

      );

    }


    if (
      pageNumber % 15 === 0
    ) {

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            0
          )
      );

    }

  }


  if (
    currentReport &&
    currentReport.endPage == null
  ) {

    currentReport.endPage =
      pagesToScan;

  }


  detectedReports.sort(
    (a, b) =>
      a.startPage -
      b.startPage
  );


  detectedReports.forEach(
    (report, index) => {

      if (
        report.endPage == null
      ) {

        const next =
          detectedReports[
            index + 1
          ];


        report.endPage =

          next

            ? next.startPage - 1

            : pagesToScan;

      }

    }
  );


  const reportsNewestFirst =

    [...detectedReports]

      .sort(
        (a, b) =>
          b.endYear -
          a.endYear
      );


  pdfEvidence =
    found;


  window.finSightPDFContext = {

    fileName:
      file.name,

    totalPages:
      pdf.numPages,

    scannedPages:
      pagesToScan,

    scanLimit:
      MAX_PDF_SCAN_PAGES,

    truncated:
      pdf.numPages >
      MAX_PDF_SCAN_PAGES,

    multiReport:
      reportsNewestFirst.length >
      1,

    reportCount:
      reportsNewestFirst.length,

    reports:
      reportsNewestFirst,

    evidence:
      found

  };


  hideScanProgress();


  const yearList =

    reportsNewestFirst

      .map(
        report =>
          report.label
      )

      .join(", ");


  $("#uploadStatus")
    .textContent =

    reportsNewestFirst.length > 1

      ?

      `${file.name}: scanned ${pagesToScan} pages. Detected ${reportsNewestFirst.length} annual reports (${yearList}). Extracting company financials…`

      :

      `${file.name}: scanned ${pagesToScan} pages. Extracting company financials…`;


  return window
    .finSightPDFContext;

}


/* ============================================================
   19. SERVER FINANCIAL EXTRACTION
   ============================================================ */

async function extractFinancialsFromPDF(
  file
) {

  const formData =
    new FormData();


  formData.append(
    "report",
    file
  );


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


  const response =
    await fetch(
      "/api/ai/extract-financials",
      {
        method:
          "POST",

        body:
          formData
      }
    );


  const text =
    await response.text();


  let payload;


  try {

    payload =
      JSON.parse(text);

  }

  catch {

    throw new Error(
      "Financial extraction returned an unreadable response."
    );

  }


  if (!response.ok) {

  console.error(
    "FinSight extraction error:",
    payload
  );

  let serverMessage =
    `Financial extraction failed (${response.status}).`;

  if (
    typeof payload?.error === "string"
  ) {

    serverMessage =
      payload.error;

  } else if (
    payload?.error?.message
  ) {

    serverMessage =
      payload.error.message;

  } else if (
    typeof payload?.message === "string"
  ) {

    serverMessage =
      payload.message;

  } else if (
    payload &&
    typeof payload === "object"
  ) {

    serverMessage =
      JSON.stringify(
        payload,
        null,
        2
      );

  }

  throw new Error(
    serverMessage
  );

}

  const rows =
    normalizeFinancialDataset(
      payload.financials
    );


  if (!rows.length) {

    throw new Error(
      "No usable financial years were extracted from the annual report."
    );

  }


  extractedCompany = {

    name:
      payload.company?.name ||
      rows.at(-1)?.company ||
      "Uploaded company",

    legal_name:
      payload.company?.legal_name ||
      null,

    listing_status:
      payload.company?.listing_status ||
      "unknown",

    ticker:
      payload.company?.ticker ||
      null,

    exchange:
      payload.company?.exchange ||
      null,

    nse_code:
      payload.company?.nse_code ||
      null,

    bse_code:
      payload.company?.bse_code ||
      null,

    isin:
      payload.company?.isin ||
      null,

    currency:
      payload.company?.currency ||
      "₹",

    extraction_confidence:
      payload.company
        ?.extraction_confidence ||
      "AI extracted"

  };


  primary =
    rows;


  selectedYear =
    "all";


  window.finSightResearchContext = {

    company:
      extractedCompany,

    financials:
      primary,

    pdfContext:
      window.finSightPDFContext,

    market:
      null,

    valuation:
      null

  };


  return payload;

}


/* ============================================================
   20. AUTOMATIC MARKET DATA
   ============================================================ */

async function fetchAutomaticMarketData() {

  marketData = null;

  const company =
    extractedCompany;


  if (!company) {
    return null;
  }


  const status =
    String(
      company.listing_status || ""
    ).toLowerCase();


  /*
   * Do not attempt public pricing for companies
   * that the annual report does not establish
   * as currently listed.
   */

  if (
    status.includes("unlisted") ||
    status.includes("pre-ipo") ||
    status.includes("pre ipo") ||
    status.includes("proposed")
  ) {

    $("#priceDisplay").textContent =
      "Public share price unavailable";


    $("#marketNote").textContent =
      "The uploaded annual report does not establish a currently listed public company.";


    $("#valuationStatus").textContent =
      "Public-market valuation is unavailable. Fundamental annual-report analysis remains available.";


    const valuationView =
      $("#valuationView");


    if (valuationView) {

      valuationView.textContent =
        "Unlisted / pre-IPO";

    }


    return null;

  }


  /*
   * IDENTIFIER-FIRST PRICING
   *
   * FinSight can proceed if ANY verified market
   * identifier was extracted from the report:
   *
   * BSE security code
   * NSE code
   * ticker + exchange
   *
   * We no longer require ticker + exchange before
   * attempting market lookup.
   */

  const ticker =
    String(
      company.ticker || ""
    ).trim();


  const nseCode =
    String(
      company.nse_code || ""
    ).trim();


  const bseCode =
    String(
      company.bse_code || ""
    ).trim();


  const exchange =
    String(
      company.exchange || ""
    ).trim();


  const isin =
    String(
      company.isin || ""
    ).trim();


  if (
    !ticker &&
    !nseCode &&
    !bseCode
  ) {

    $("#priceDisplay").textContent =
      "Market identifier unavailable";


    $("#marketNote").textContent =
      "The annual report did not provide a verified BSE code, NSE code or public ticker. FinSight will not guess one.";


    $("#valuationStatus").textContent =
      "Automatic valuation requires a verified public-market identifier and market price.";


    return null;

  }


  $("#priceDisplay").textContent =
    "Fetching market price…";


  /*
   * Express route still requires a path parameter.
   *
   * This identifier is only used to reach the endpoint.
   * The SERVER decides the actual lookup priority:
   *
   * BSE code
   * ↓
   * NSE code
   * ↓
   * ticker
   */

  const routeIdentifier =

    ticker

    ||

    nseCode

    ||

    bseCode;


  try {

    const params =
      new URLSearchParams();


    if (exchange) {

      params.set(
        "exchange",
        exchange
      );

    }


    if (company.name) {

      params.set(
        "company",
        company.name
      );

    }
     if (ticker) {
        params.set(
           "ticker",
           ticker
       );

    }


    if (bseCode) {

      params.set(
        "bseCode",
        bseCode
      );

    }


    if (nseCode) {

      params.set(
        "nseCode",
        nseCode
      );

    }


    if (isin) {

      params.set(
        "isin",
        isin
      );

    }


    const url =

      `/api/market/${encodeURIComponent(
        routeIdentifier
      )}?${params.toString()}`;


    console.log(
      "FinSight market lookup:",
      {
        company:
          company.name,

        ticker,

        exchange,

        bseCode,

        nseCode,

        isin
      }
    );


    const response =
      await fetch(
        url,
        {
          method:
            "GET",

          headers: {
            Accept:
              "application/json"
          }
        }
      );


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
        "Market-data server returned an unreadable response."
      );

    }


    if (!response.ok) {

      /*
       * Give a useful message for Alpha Vantage
       * request limits.
       */

      if (
  response.status === 429
) {

  throw new Error(
    "Market data limit reached. Please try again later."
  );

}


      throw new Error(
        payload?.error ||
        `Market-price request failed (${response.status}).`
      );

    }


    const price =
      finite(
        payload.price
      );


    if (
      price == null ||
      price <= 0
    ) {

      throw new Error(
        "The market provider returned no usable share price."
      );

    }


    marketData =
      payload;


    /*
     * Use server-confirmed currency.
     */

    if (
      payload.currency
    ) {

      extractedCompany.currency =
        payload.currency;

    }


    /*
     * Display the ACTUAL identifier that produced
     * the quote rather than always displaying the
     * originally extracted ticker.
     */

    const resolvedIdentifier =

      payload.symbol

      ||

      ticker

      ||

      nseCode

      ||

      bseCode;


    $("#priceDisplay").textContent =

      `${priceMoney(
        price
      )} · ${resolvedIdentifier}`;


    /*
     * Show how the price was resolved.
     *
     * Example:
     *
     * Alpha Vantage · BSE security code ·
     * 543287.BSE · 2026-11-06
     */

    const noteParts =
      [];


    noteParts.push(
      payload.provider ||
      "Market provider"
    );


    if (
      payload.identifierSource
    ) {

      noteParts.push(
        payload.identifierSource
      );

    }


    if (
      payload.symbol
    ) {

      noteParts.push(
        payload.symbol
      );

    }


    if (
      payload.asOf
    ) {

      noteParts.push(
        payload.asOf
      );

    }


    noteParts.push(

      payload.live

        ? "live"

        : "last available / end-of-day"

    );


    if (
      payload.cached
    ) {

      noteParts.push(
        "cached"
      );

    }


    $("#marketNote").textContent =
      noteParts.join(
        " · "
      );


    /*
     * Make market data available to valuation
     * and Ask FinSight.
     */

    if (
      window.finSightResearchContext
    ) {

      window
        .finSightResearchContext
        .market =
        marketData;

    }


    console.log(
      "FinSight market quote resolved:",
      marketData
    );


    return marketData;

  }

  catch (
    error
  ) {

    console.error(
      "Automatic market data:",
      error
    );


    marketData =
      null;


    $("#priceDisplay").textContent =
      "Market price unavailable";


    $("#marketNote").textContent =
      error?.message ||
      "Automatic market-price lookup failed.";


    $("#valuationStatus").textContent =
      "Automatic valuation could not run because a verified market price was not returned.";


    if (
      window.finSightResearchContext
    ) {

      window
        .finSightResearchContext
        .market =
        null;

    }


    return null;

  }

}
/* ============================================================
   MANUAL MARKET PRICE BUTTON
   ============================================================ */

$("#fetchMarketPrice")
  ?.addEventListener(
    "click",
    async () => {

      const button =
        $("#fetchMarketPrice");


      if (!extractedCompany) {

        $("#marketNote").textContent =
          "Upload an annual report first.";

        return;

      }


      button.disabled =
        true;


      button.textContent =
        "Fetching price…";


      $("#priceDisplay").textContent =
        "Fetching market price…";


      $("#marketNote").textContent =
        "Contacting market data provider…";


      try {

        const result =
          await fetchAutomaticMarketData();


        if (!result) {

          button.disabled =
            false;


         button.textContent =
            "Fetch price & calculate valuation";


          return;

        }


        /*
         * Price successfully received.
         * Now calculate valuation.
         */

        renderAutomaticValuation();


        button.disabled =
          false;


        button.textContent =
          "Refresh price & valuation";


        /*
         * Notify AI valuation that market
         * information is now available.
         */

        window.dispatchEvent(

          new CustomEvent(
            "finsight:market-ready",
            {
              detail: {

                market:
                  marketData,

                valuation:
                  valuationState

              }
            }
          )

        );

      }

      catch (
        error
      ) {

        console.error(
          "Manual market price:",
          error
        );


        $("#priceDisplay").textContent =
          "Market price unavailable";


        $("#marketNote").textContent =
          error?.message ||
          "Could not retrieve market price.";


        button.disabled =
          false;

      button.textContent =
         "Fetch price & calculate valuation";


            }

    }
  );

   /* ============================================================
   21. AUTOMATIC VALUATION
   ============================================================ */


/*
 * Calculate valuation multiples only when:
 *
 * 1. Annual-report financials are available.
 * 2. A verified market price has been fetched manually.
 *
 * Expected units:
 *
 * Financial statement values = ₹ crore
 * Shares outstanding = crore shares
 * Share price = ₹ per share
 *
 * Therefore:
 *
 * price × crore shares = ₹ crore market cap
 */

function calculateAutomaticMultiples() {

  const row =
    getCalculatedRows()
      .at(-1);


  if (
    !row ||
    !marketData
  ) {

    return null;

  }


  const price =
    finite(
      marketData.price
    );


  if (
    price == null ||
    price <= 0
  ) {

    return null;

  }


  /*
   * Shares outstanding must come from the
   * uploaded annual report.
   *
   * Expected unit:
   * crore shares.
   */

  const shares =
    finite(
      row.shares_outstanding
    );


  const validShares =

    shares != null &&
    shares > 0

      ? shares

      : null;


  /*
   * MARKET CAPITALIZATION
   *
   * ₹ per share × crore shares
   * =
   * ₹ crore
   */

  const marketCap =

    validShares != null

      ? price *
        validShares

      : null;


  /*
   * EPS
   *
   * ₹ crore profit /
   * crore shares
   * =
   * ₹ per share
   */

  const eps =

    validShares != null &&
    row.net_income != null

      ? safeDiv(
          row.net_income,
          validShares
        )

      : null;


  /*
   * BOOK VALUE PER SHARE
   */

  const bookValuePerShare =

    validShares != null &&
    row.total_equity != null

      ? safeDiv(
          row.total_equity,
          validShares
        )

      : null;


  /*
   * P/E
   *
   * Do not calculate negative P/E.
   */

  const pe =

    eps != null &&
    eps > 0

      ? safeDiv(
          price,
          eps
        )

      : null;


  /*
   * PRICE / BOOK
   *
   * Do not calculate against
   * negative book value.
   */

  const priceToBook =

    bookValuePerShare != null &&
    bookValuePerShare > 0

      ? safeDiv(
          price,
          bookValuePerShare
        )

      : null;


  /*
   * NET DEBT
   *
   * Use the calculated annual-report
   * value only.
   */

  const netDebt =
    finite(
      row.net_debt
    );


  /*
   * ENTERPRISE VALUE
   *
   * Market cap + net debt.
   *
   * If net debt is unavailable,
   * EV is unavailable.
   */

  const enterpriseValue =

    marketCap != null &&
    netDebt != null

      ? marketCap +
        netDebt

      : null;


  /*
   * EV / EBITDA
   */

  const evEbitda =

    enterpriseValue != null &&
    row.ebitda != null &&
    row.ebitda > 0

      ? safeDiv(
          enterpriseValue,
          row.ebitda
        )

      : null;


  /*
   * EV / SALES
   */

  const evSales =

    enterpriseValue != null &&
    row.revenue != null &&
    row.revenue > 0

      ? safeDiv(
          enterpriseValue,
          row.revenue
        )

      : null;


  /*
   * EARNINGS YIELD
   */

  const earningsYield =

    marketCap != null &&
    marketCap > 0 &&
    row.net_income != null

      ? safeDiv(
          row.net_income,
          marketCap
        )

      : null;


  /*
   * FREE-CASH-FLOW YIELD
   */

  const fcfYield =

    marketCap != null &&
    marketCap > 0 &&
    row.free_cash_flow != null

      ? safeDiv(
          row.free_cash_flow,
          marketCap
        )

      : null;


  return {

    price,

    shares:
      validShares,

    marketCap,

    eps,

    bookValuePerShare,

    pe,

    priceToBook,

    netDebt,

    enterpriseValue,

    ev:
      enterpriseValue,

    evEbitda,

    evSales,

    earningsYield,

    fcfYield

  };

}


/* ============================================================
   RENDER AUTOMATIC VALUATION
   ============================================================ */

function renderAutomaticValuation() {

  const valuationStatus =
    $("#valuationStatus");


  const valuationView =
    $("#valuationView");


  const metricsContainer =
    $("#autoValuationMetrics");


  const resultsContainer =
    $("#valuationResults");


  /*
   * STATE 1
   *
   * No company/report loaded.
   */

  if (!extractedCompany) {

    valuationState =
      null;


    if (valuationStatus) {

      valuationStatus.textContent =
        "Waiting for company data.";

    }


    if (valuationView) {

      valuationView.textContent =
        "Waiting for company data";

    }


    if (metricsContainer) {

      metricsContainer.innerHTML =
        "";

    }


    if (resultsContainer) {

      resultsContainer.innerHTML =
        "";

    }


    return;

  }


  /*
   * STATE 2
   *
   * Company report is loaded,
   * but user has NOT requested
   * market data.
   */

  if (
    !marketData ||
    finite(
      marketData.price
    ) == null
  ) {

    valuationState =
      null;


    if (valuationStatus) {

      valuationStatus.textContent =
        "Market valuation has not been requested yet.";

    }


    if (valuationView) {

      valuationView.textContent =
        "Price required";

    }


    if (metricsContainer) {

      metricsContainer.innerHTML =
        "";

    }


    if (resultsContainer) {

      resultsContainer.innerHTML = `

        <div class="scenario">

          <b>
            Market valuation not calculated
          </b>

          <small>
            Press “Fetch price & calculate valuation”
            when you want FinSight to retrieve the
            market price and calculate valuation.
          </small>

        </div>

      `;

    }


    return;

  }


  /*
   * STATE 3
   *
   * Market price exists.
   * Calculate valuation.
   */

  const valuation =
    calculateAutomaticMultiples();


  valuationState =
    valuation;


  if (!valuation) {

    if (valuationStatus) {

      valuationStatus.textContent =
        "Valuation could not be calculated from the available data.";

    }


    if (valuationView) {

      valuationView.textContent =
        "Valuation unavailable";

    }


    return;

  }


  /*
   * MAIN VALUATION CARDS
   */

  const valuationCards = [

    [
      "Share price",

      priceMoney(
        valuation.price
      ),

      marketData.asOf
        ? `Market quote · ${marketData.asOf}`
        : "Verified market quote"
    ],


    [
      "Market cap",

      valuation.marketCap == null

        ? "N/A"

        : money(
            valuation.marketCap
          ),

      valuation.shares == null

        ? "Shares outstanding unavailable"

        : "Share price × shares outstanding"
    ],


    [
      "P/E",

      multiple(
        valuation.pe
      ),

      valuation.pe == null

        ? "Requires positive earnings and reliable shares"

        : "Market price / earnings per share"
    ],


    [
      "P/B",

      multiple(
        valuation.priceToBook
      ),

      valuation.priceToBook == null

        ? "Requires positive book value and reliable shares"

        : "Market price / book value per share"
    ],


    [
      "EV / EBITDA",

      multiple(
        valuation.evEbitda
      ),

      valuation.evEbitda == null

        ? "Requires market cap, net debt and positive EBITDA"

        : "Enterprise value / EBITDA"
    ]

  ];


  if (metricsContainer) {

    metricsContainer.innerHTML =

      valuationCards

        .map(
          (
            [
              label,
              value,
              copy
            ]
          ) => `

            <article class="metric">

              <span>
                ${label}
              </span>

              <strong>
                ${value}
              </strong>

              <small class="neutral">
                ${copy}
              </small>

            </article>

          `
        )

        .join("");

  }


  /*
   * SECONDARY VALUATION METRICS
   */

  const secondaryMetrics = [

    [
      "EPS",

      valuation.eps == null

        ? "N/A"

        : priceMoney(
            valuation.eps
          ),

      "Net profit / shares outstanding"
    ],


    [
      "Book value / share",

      valuation.bookValuePerShare == null

        ? "N/A"

        : priceMoney(
            valuation.bookValuePerShare
          ),

      "Shareholder equity / shares outstanding"
    ],


    [
      "Enterprise value",

      valuation.enterpriseValue == null

        ? "N/A"

        : money(
            valuation.enterpriseValue
          ),

      "Market capitalization + net debt"
    ],


    [
      "EV / Sales",

      multiple(
        valuation.evSales
      ),

      "Enterprise value / revenue"
    ],


    [
      "Earnings yield",

      valuation.earningsYield == null

        ? "N/A"

        : percentage(
            valuation.earningsYield
          ),

      "Net profit / market capitalization"
    ],


    [
      "FCF yield",

      valuation.fcfYield == null

        ? "N/A"

        : percentage(
            valuation.fcfYield
          ),

      "Free cash flow / market capitalization"
    ],


    [
      "Net debt / EBITDA",

      multiple(
        getCalculatedRows()
          .at(-1)
          ?.net_debt_ebitda
      ),

      "Balance-sheet leverage"
    ]

  ];


  if (resultsContainer) {

    resultsContainer.innerHTML =

      secondaryMetrics

        .map(
          (
            [
              title,
              value,
              copy
            ]
          ) => `

            <div class="scenario">

              <b>
                ${title}
              </b>

              <strong>
                ${value}
              </strong>

              <small>
                ${copy}
              </small>

            </div>

          `
        )

        .join("");

  }


  /*
   * IDENTIFIER USED FOR MARKET PRICE
   */

  const identifier =

    marketData.symbol

    ||

    extractedCompany?.bse_code

    ||

    extractedCompany?.nse_code

    ||

    extractedCompany?.ticker

    ||

    "verified market identifier";


  const identifierSource =

    marketData.identifierSource

    ||

    "verified company identifier";


  /*
   * STATE 4
   *
   * Price exists but shares outstanding
   * could not be reliably extracted.
   */

  if (
    valuation.marketCap == null
  ) {

    if (valuationView) {

      valuationView.textContent =
        "Partial valuation";

    }


    if (valuationStatus) {

      valuationStatus.textContent =

        `${priceMoney(
          valuation.price
        )} was fetched using ${identifier} (${identifierSource}), but reliable period-end shares outstanding were not available from the annual report. Market-cap-based valuation multiples are therefore unavailable.`;

    }


    /*
     * Still expose the partial valuation
     * to Ask FinSight.
     */

    if (
      window.finSightResearchContext
    ) {

      window
        .finSightResearchContext
        .market =
        marketData;


      window
        .finSightResearchContext
        .valuation =
        valuation;

    }


    return;

  }


  /*
   * STATE 5
   *
   * Complete market valuation.
   */

  if (valuationView) {

    valuationView.textContent =
      "Market valuation ready";

  }


  if (valuationStatus) {

    valuationStatus.textContent =

      `Valuation calculated using ${identifier} (${identifierSource}) at ${priceMoney(
        valuation.price
      )}, as of ${marketData.asOf || "the last available trading session"}, together with the latest extracted annual-report financials.`;

  }


  /*
   * Share final valuation with
   * Ask FinSight / AI valuation.
   */

  if (
    window.finSightResearchContext
  ) {

    window
      .finSightResearchContext
      .market =
      marketData;


    window
      .finSightResearchContext
      .valuation =
      valuation;

  }

}      


/* ============================================================
   22. DASHBOARD RENDER
   ============================================================ */

function renderDashboard() {

  if (
    !primary?.length
  ) {

    showEmptyState();
    return;

  }


  showWorkspace();

  renderCompanyHeader();

  renderYearTabs();

  renderSnapshot();

  renderFinancialHistory();

  renderChart();

  renderScore();

  renderSignals();

  renderResearchTabs();

  renderInvestorBrief();

  renderAutomaticValuation();

}


/* ============================================================
   23. REPORT UPLOAD
   ============================================================ */

async function handleReportUpload(file) {

  clearError();


  currentReportFile =
    file;


  latestAIAnalysis =
    null;


  marketData =
    null;


  valuationState =
    null;


  primary =
    null;


  extractedCompany =
    null;


  selectedYear =
    "all";


  pdfEvidence =
    [];


  window.finSightPDFContext =
    null;


  window.finSightResearchContext =
    null;


  showEmptyState();


  $("#uploadStatus")
    .textContent =
    `Loading ${file.name}…`;


  try {

    const filename =
      file.name
        .toLowerCase();


    if (
      !filename.endsWith(
        ".pdf"
      )
    ) {

      throw new Error(
        "This report-first version currently requires an annual-report PDF for automatic company extraction."
      );

    }


    await parsePDF(file);


    $("#uploadStatus")
      .textContent =
      "PDF scan complete. Extracting consolidated financial statements…";


    const extraction =
      await extractFinancialsFromPDF(
        file
      );


    renderDashboard();


    $("#uploadStatus")
      .textContent =

      `${extractedCompany.name}: extracted ${primary.length} reporting year${primary.length === 1 ? "" : "s"}. Checking listing status and market data…`;


  marketData = null;

valuationState = null;


const fetchMarketButton =
  $("#fetchMarketPrice");


if (fetchMarketButton) {

  fetchMarketButton.hidden =
    false;

  fetchMarketButton.disabled =
    false;

  fetchMarketButton.textContent =
    "Fetch price & calculate valuation";

}


if ($("#priceDisplay")) {

  $("#priceDisplay").textContent =
    "Price not fetched";

}


if ($("#marketNote")) {

  $("#marketNote").textContent =
    "Press the button below when you want to fetch the latest available market price.";

}


if ($("#valuationStatus")) {

  $("#valuationStatus").textContent =
    "Market valuation has not been requested yet.";

}


    $("#uploadStatus")
      .textContent =

      `${extractedCompany.name}: research workspace ready from uploaded annual-report evidence.`;


    /*
     * Make the same report available to AI section.
     */

    const aiInput =
      $("#aiReportFile");


    if (aiInput) {

      /*
       * Browser security does not allow programmatically
       * assigning FileList to a file input.
       *
       * finsight-ai.js therefore uses currentReportFile
       * as fallback.
       */

      window.finSightCurrentReportFile =
        file;

    }


    window.finSightFinancialExtraction =
      extraction;


    /*
     * AI JS can optionally trigger automatic
     * qualitative analysis after extraction.
     */

    window.dispatchEvent(

      new CustomEvent(
        "finsight:report-ready",
        {
          detail: {
            file,
            extraction
          }
        }
      )

    );

  }

  catch (
    error
  ) {

    console.error(
      error
    );


    hideScanProgress();


    showError(
      error.message ||
      "Annual-report processing failed."
    );


    $("#uploadStatus")
      .textContent =
      "Report processing failed. No sample data has been substituted.";


    primary =
      null;


    showEmptyState();

  }

}


/* ============================================================
   24. FILE EVENT
   ============================================================ */

$("#companyFile")
  ?.addEventListener(
    "change",
    event => {

      const file =
        event.target
          .files?.[0];


      if (file) {

        handleReportUpload(
          file
        );

      }

    }
  );


/* ============================================================
   25. ADVANCED DCF EVENTS
   ============================================================ */

async function runDCFRequest() {

  const row =
    getCalculatedRows().at(-1);


  if (!row) {

    $("#dcfResult")
      .textContent =
      "Upload an annual report first.";

    return;

  }


  const shares =
    finite(
      row.shares_outstanding
    );


  if (
    shares == null
  ) {

    $("#dcfResult")
      .textContent =
      "DCF per-share value requires reliably extracted shares outstanding.";

    return;

  }


  const payload = {

    revenue:
      row.revenue,

    ebit:
      row.operating_income,

    operatingCashFlow:
      row.operating_cash_flow,

    capex:
      row.capex,

    netDebt:
      finite(
        $("#dcfNetDebt")
          ?.value
      ) ??
      row.net_debt ??
      0,

    sharesOutstanding:
      shares,

    revenueGrowth:
      (
        finite(
          $("#dcfGrowth")
            ?.value
        ) || 0
      ) / 100,

    ebitMargin:
      (
        finite(
          $("#dcfMargin")
            ?.value
        ) || 0
      ) / 100,

    wacc:
      (
        finite(
          $("#dcfWacc")
            ?.value
        ) || 0
      ) / 100,

    terminalGrowth:
      (
        finite(
          $("#dcfTerminal")
            ?.value
        ) || 0
      ) / 100

  };


  $("#dcfResult")
    .textContent =
    "Calculating DCF…";


  try {

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


    const result =
      await response.json();


    if (!response.ok) {

      throw new Error(
        result?.error ||
        "DCF failed."
      );

    }


    $("#dcfResult")
      .textContent =
      JSON.stringify(
        result,
        null,
        2
      );

  }

  catch (
    error
  ) {

    $("#dcfResult")
      .textContent =
      error.message;

  }

}


async function runReverseDCFRequest() {

  const row =
    getCalculatedRows().at(-1);


  if (
    !row ||
    !marketData
  ) {

    $("#dcfResult")
      .textContent =
      "Reverse DCF requires a verified market price and extracted financial data.";

    return;

  }


  const shares =
    finite(
      row.shares_outstanding
    );


  if (
    shares == null
  ) {

    $("#dcfResult")
      .textContent =
      "Reverse DCF requires reliably extracted shares outstanding.";

    return;

  }


  const payload = {

    marketPrice:
      marketData.price,

    revenue:
      row.revenue,

    ebit:
      row.operating_income,

    operatingCashFlow:
      row.operating_cash_flow,

    capex:
      row.capex,

    netDebt:
      finite(
        $("#dcfNetDebt")
          ?.value
      ) ??
      row.net_debt ??
      0,

    sharesOutstanding:
      shares,

    ebitMargin:
      (
        finite(
          $("#dcfMargin")
            ?.value
        ) || 0
      ) / 100,

    wacc:
      (
        finite(
          $("#dcfWacc")
            ?.value
        ) || 0
      ) / 100,

    terminalGrowth:
      (
        finite(
          $("#dcfTerminal")
            ?.value
        ) || 0
      ) / 100

  };


  $("#dcfResult")
    .textContent =
    "Calculating market-implied growth…";


  try {

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


    const result =
      await response.json();


    if (!response.ok) {

      throw new Error(
        result?.error ||
        "Reverse DCF failed."
      );

    }


    $("#dcfResult")
      .textContent =
      JSON.stringify(
        result,
        null,
        2
      );

  }

  catch (
    error
  ) {

    $("#dcfResult")
      .textContent =
      error.message;

  }

}


$("#runDcf")
  ?.addEventListener(
    "click",
    runDCFRequest
  );


$("#runReverseDcf")
  ?.addEventListener(
    "click",
    runReverseDCFRequest
  );


/* ============================================================
   26. RESEARCH MEMORY
   ============================================================ */

$("#saveThesis")
  ?.addEventListener(
    "click",
    async () => {

      if (
        !extractedCompany
      ) {

        $("#memoryResult")
          .textContent =
          "Upload and identify a company first.";

        return;

      }


      const thesis =
        $("#thesisText")
          ?.value
          .trim();


      if (!thesis) {

        $("#memoryResult")
          .textContent =
          "Enter an investment thesis first.";

        return;

      }


      $("#memoryResult")
        .textContent =
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
                    extractedCompany.name,

                  ticker:
                    extractedCompany.ticker,

                  exchange:
                    extractedCompany.exchange,

                  thesis,

                  bullCase:
                    $("#bullCase")
                      ?.value ||
                    "",

                  bearCase:
                    $("#bearCase")
                      ?.value ||
                    ""

                })
            }
          );


        const result =
          await response.json();


        if (!response.ok) {

          throw new Error(
            result?.error ||
            "Could not save thesis."
          );

        }


        $("#memoryResult")
          .textContent =
          "Investment thesis saved.";

      }

      catch (
        error
      ) {

        $("#memoryResult")
          .textContent =
          error.message;

      }

    }
  );


$("#loadMemory")
  ?.addEventListener(
    "click",
    async () => {

      const resultBox =
        $("#memoryResult");


      /*
       * A company must first be identified from
       * the uploaded annual report.
       */

      if (
        !extractedCompany?.name &&
        !extractedCompany?.ticker
      ) {

        resultBox.textContent =
          "Load a company report before loading research memory.";

        return;

      }


      resultBox.textContent =
        "Loading research memory…";


      try {

        /*
         * Use the SAME working backend route
         * that currently returns the JSON shown
         * in your screenshot.
         */

        const params =
          new URLSearchParams();


        if (
          extractedCompany.name
        ) {

          params.set(
            "company",
            extractedCompany.name
          );

        }


        if (
          extractedCompany.ticker
        ) {

          params.set(
            "ticker",
            extractedCompany.ticker
          );

        }


        if (
          extractedCompany.exchange
        ) {

          params.set(
            "exchange",
            extractedCompany.exchange
          );

        }


        const response =
          await fetch(
            `/api/research?${params.toString()}`,
            {
              method:
                "GET",

              headers: {
                Accept:
                  "application/json"
              }
            }
          );


        const text =
          await response.text();


        let result;


        try {

          result =
            text
              ? JSON.parse(text)
              : {};

        }

        catch {

          throw new Error(
            "Research memory returned an unreadable response."
          );

        }


        if (!response.ok) {

          throw new Error(
            typeof result?.error === "string"
              ? result.error
              : `Research memory request failed (${response.status}).`
          );

        }


        /*
         * Your current backend returns:
         *
         * {
         *   company: {...},
         *   reports: [],
         *   theses: [...],
         *   valuations: [],
         *   promises: [],
         *   events: []
         * }
         */

        const theses =
          Array.isArray(
            result.theses
          )
            ? result.theses
            : [];


        /*
         * Find the newest active thesis.
         *
         * If no active thesis exists, use the
         * newest available thesis.
         */

        const savedThesis =

          theses.find(
            item =>
              String(
                item.status || ""
              ).toLowerCase() ===
              "active"
          )

          ||

          theses[0]

          ||

          null;


        if (!savedThesis) {

          $("#thesisText").value =
            "";

          $("#bullCase").value =
            "";

          $("#bearCase").value =
            "";


          resultBox.textContent =
            `No saved investment thesis was found for ${
              result.company?.name ||
              extractedCompany.name ||
              extractedCompany.ticker ||
              "this company"
            }.`;

          return;

        }


        /*
         * LOAD SAVED VALUES INTO EXISTING BOXES
         */

        $("#thesisText").value =
          savedThesis.thesis ||
          "";


        $("#bullCase").value =
          savedThesis.bull_case ||
          savedThesis.bullCase ||
          "";


        $("#bearCase").value =
          savedThesis.bear_case ||
          savedThesis.bearCase ||
          "";


        /*
         * Friendly confirmation.
         * Do NOT dump JSON into the page.
         */

        const companyName =

          result.company?.name

          ||

          extractedCompany.name

          ||

          extractedCompany.ticker

          ||

          "company";


        let savedDate =
          "";


        const dateValue =

          savedThesis.updated_at

          ||

          savedThesis.created_at;


        if (dateValue) {

          const parsedDate =
            new Date(
              dateValue
            );


          if (
            !Number.isNaN(
              parsedDate.getTime()
            )
          ) {

            savedDate =
              ` · saved ${parsedDate.toLocaleDateString(
                "en-IN"
              )}`;

          }

        }


        resultBox.textContent =
          `Research memory loaded for ${companyName}${savedDate}.`;

      }

      catch (
        error
      ) {

        console.error(
          "Load research memory error:",
          error
        );


        resultBox.textContent =
          error?.message ||
          "Could not load research memory.";

      }

    }
  );


/* ============================================================
   27. INITIAL HEALTH CHECK
   ============================================================ */

async function checkHealth() {

  const target =
    $("#aiStatus");


  if (!target) {
    return;
  }


  try {

    const response =
      await fetch(
        "/api/health"
      );


    const result =
      await response.json();


    if (!response.ok) {

      throw new Error(
        result?.error ||
        "Backend unavailable."
      );

    }


    const pieces = [

      result.aiConfigured
        ? "AI ready"
        : "AI not configured",

      result.marketConfigured
        ? "Market data ready"
        : "Market data unavailable",

      result.databaseReady
        ? "Research memory ready"
        : "Research memory unavailable",

      result.multiReportAnalysis
        ? "Multi-report ready"
        : null

    ].filter(Boolean);


    target.textContent =
      pieces.join(" · ");

  }

  catch (
    error
  ) {

    target.textContent =
      `Backend check failed · ${error.message}`;

  }

}


/* ============================================================
   28. PUBLIC CONTEXT HELPER FOR AI JS
   ============================================================ */

window.finSightGetContext =
  function () {

    return {

      company:
        extractedCompany,

      financials:
        getCalculatedRows(),

      selectedYear,

      market:
        marketData,

      valuation:
        valuationState,

      pdfContext:
        window.finSightPDFContext,

      aiAnalysis:
        latestAIAnalysis

    };

  };


window.finSightSetAIAnalysis =
  function (analysis) {

    latestAIAnalysis =
      analysis;


    if (
      window.finSightResearchContext
    ) {

      window
        .finSightResearchContext
        .aiAnalysis =
        analysis;

    }

  };


/* ============================================================
   29. STARTUP
   ============================================================ */

showEmptyState();

checkHealth();
