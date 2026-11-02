 /* ============================================================
   FINSIGHT AI — CORE INVESTOR ENGINE

   Financial analysis
   Financial scoring
   Good / Bad / Watch
   Excel + CSV parsing
   Large PDF scanning — up to 1,000 pages
   Multi-annual-report detection
   Competitor analysis
   Valuation
   ============================================================ */


/* ============================================================
   1. DEMO DATA
   ============================================================ */

const demo = [
  {
    company: "Apex Industries Ltd.",
    year: 2022,
    revenue: 820,
    cogs: 535,
    operating_income: 116,
    net_income: 72,
    total_assets: 760,
    current_assets: 310,
    current_liabilities: 180,
    total_debt: 210,
    total_equity: 360,
    operating_cash_flow: 81,
    inventory: 92,
    accounts_receivable: 105,
    accounts_payable: 88,
    finance_cost: 18
  },

  {
    company: "Apex Industries Ltd.",
    year: 2023,
    revenue: 940,
    cogs: 603,
    operating_income: 141,
    net_income: 88,
    total_assets: 830,
    current_assets: 338,
    current_liabilities: 195,
    total_debt: 225,
    total_equity: 395,
    operating_cash_flow: 97,
    inventory: 101,
    accounts_receivable: 116,
    accounts_payable: 96,
    finance_cost: 19
  },

  {
    company: "Apex Industries Ltd.",
    year: 2024,
    revenue: 1095,
    cogs: 694,
    operating_income: 175,
    net_income: 111,
    total_assets: 940,
    current_assets: 386,
    current_liabilities: 218,
    total_debt: 242,
    total_equity: 452,
    operating_cash_flow: 126,
    inventory: 112,
    accounts_receivable: 132,
    accounts_payable: 108,
    finance_cost: 20
  },

  {
    company: "Apex Industries Ltd.",
    year: 2025,
    revenue: 1260,
    cogs: 790,
    operating_income: 214,
    net_income: 139,
    total_assets: 1065,
    current_assets: 448,
    current_liabilities: 246,
    total_debt: 260,
    total_equity: 521,
    operating_cash_flow: 151,
    inventory: 125,
    accounts_receivable: 146,
    accounts_payable: 121,
    finance_cost: 21
  }
];


const competitorDemo =
  demo.map(
    (row, index) => ({
      ...row,

      company:
        "Beacon Consumer Ltd.",

      revenue:
        row.revenue *
        (0.91 + index * 0.015),

      operating_income:
        row.operating_income *
        (1.03 - index * 0.01),

      net_income:
        row.net_income *
        (0.96 + index * 0.005),

      total_debt:
        row.total_debt * 1.22,

      total_equity:
        row.total_equity * 1.04,

      operating_cash_flow:
        row.operating_cash_flow * 1.08,

      current_assets:
        row.current_assets * 0.96,

      current_liabilities:
        row.current_liabilities * 1.02,

      inventory:
        row.inventory * 1.08,

      accounts_receivable:
        row.accounts_receivable * 0.90,

      accounts_payable:
        row.accounts_payable * 1.03,

      finance_cost:
        row.finance_cost * 1.25
    })
  );


/* ============================================================
   2. STATE
   ============================================================ */

const required = [
  "year",
  "revenue",
  "cogs",
  "operating_income",
  "net_income",
  "total_assets",
  "current_assets",
  "current_liabilities",
  "total_debt",
  "total_equity",
  "operating_cash_flow",
  "inventory",
  "accounts_receivable"
];


let primary =
  demo;


let competitor =
  null;


let pdfEvidence =
  [];


/*
 * Shared PDF context.
 *
 * finsight-ai.js reads this and sends it to server.js.
 */

window.finSightPDFContext =
  null;


/* ============================================================
   3. HELPERS
   ============================================================ */

const $ =
  selector =>
    document.querySelector(
      selector
    );


const fmt =
  new Intl.NumberFormat(
    "en-IN",
    {
      maximumFractionDigits: 1
    }
  );


const money =
  value =>
    `₹${fmt.format(value)} Cr`;


const pct =
  value =>
    `${fmt.format(value * 100)}%`;


const div =
  (a, b) =>
    Number(b)
      ? Number(a) /
        Number(b)
      : 0;


const chg =
  (a, b) =>
    b
      ? (a - b) /
        Math.abs(b)
      : 0;


const clamp =
  number =>
    Math.max(
      0,
      Math.min(
        100,
        number
      )
    );


/* ============================================================
   4. FINANCIAL CALCULATION ENGINE
   ============================================================ */

function calc(data) {

  const rows =
    [...data].sort(
      (a, b) =>
        a.year - b.year
    );


  const latest =
    rows.at(-1);


  const prior =
    rows.at(-2) ||
    latest;


  const average =
    key =>
      (
        Number(latest[key]) +
        Number(prior[key])
      ) / 2;


  const ratios = {

    gross:
      div(
        latest.revenue -
          latest.cogs,

        latest.revenue
      ),


    op:
      div(
        latest.operating_income,
        latest.revenue
      ),


    net:
      div(
        latest.net_income,
        latest.revenue
      ),


    current:
      div(
        latest.current_assets,
        latest.current_liabilities
      ),


    quick:
      div(
        latest.current_assets -
          latest.inventory,

        latest.current_liabilities
      ),


    de:
      div(
        latest.total_debt,
        latest.total_equity
      ),


    roa:
      div(
        latest.net_income,
        latest.total_assets
      ),


    roe:
      div(
        latest.net_income,
        latest.total_equity
      ),


    roce:
      div(
        latest.operating_income,

        average(
          "total_assets"
        ) -

        average(
          "current_liabilities"
        )
      ),


    asset:
      div(
        latest.revenue,
        latest.total_assets
      ),


    recv:
      div(
        average(
          "accounts_receivable"
        ) * 365,

        latest.revenue
      ),


    inv:
      div(
        average(
          "inventory"
        ) * 365,

        latest.cogs
      ),


    pay:
      latest.accounts_payable

        ? div(
            average(
              "accounts_payable"
            ) * 365,

            latest.cogs
          )

        : null,


    coverage:
      latest.finance_cost

        ? div(
            latest.operating_income,
            latest.finance_cost
          )

        : null,


    cash:
      div(
        latest.operating_cash_flow,
        latest.net_income
      ),


    revGrowth:
      chg(
        latest.revenue,
        prior.revenue
      ),


    incomeGrowth:
      chg(
        latest.net_income,
        prior.net_income
      ),


    debtGrowth:
      chg(
        latest.total_debt,
        prior.total_debt
      ),


    marginShift:

      div(
        latest.operating_income,
        latest.revenue
      )

      -

      div(
        prior.operating_income,
        prior.revenue
      )

  };


  return {
    rows,
    l: latest,
    p: prior,
    r: ratios
  };

}


/* ============================================================
   5. FINSIGHT SCORE
   ============================================================ */

function scores(r) {

  return {

    Profitability:
      clamp(
        45 +
        r.op * 180 +
        r.roe * 90
      ),


    Liquidity:
      clamp(
        25 +
        r.current * 35
      ),


    Leverage:
      clamp(
        100 -
        r.de * 55
      ),


    "Cash quality":
      clamp(
        r.cash * 75
      ),


    Efficiency:
      clamp(

        85

        -

        Math.max(
          0,
          r.recv - 45
        ) * 0.8

        -

        Math.max(
          0,
          r.inv - 60
        ) * 0.35

      )

  };

}


/* ============================================================
   6. GOOD / BAD / WATCH
   ============================================================ */

function signals(
  analysis
) {

  const r =
    analysis.r;


  const out =
    [];


  const add =
    (
      type,
      title,
      text
    ) => {

      out.push({
        type,
        title,
        text
      });

    };


  add(

    r.revGrowth > 0.10

      ? "good"

      : r.revGrowth >= 0

      ? "watch"

      : "bad",

    "Revenue momentum",

    `Revenue ${
      r.revGrowth >= 0
        ? "grew"
        : "declined"
    } ${fmt.format(
      Math.abs(
        r.revGrowth
      ) * 100
    )}% YoY to ${money(
      analysis.l.revenue
    )}.`

  );


  add(

    r.marginShift >= 0

      ? "good"

      : r.marginShift > -0.02

      ? "watch"

      : "bad",

    "Operating margin",

    `Operating margin ${
      r.marginShift >= 0
        ? "expanded"
        : "contracted"
    } ${fmt.format(
      Math.abs(
        r.marginShift
      ) * 100
    )} percentage points.`

  );


  add(

    r.cash >= 1

      ? "good"

      : r.cash >= 0.75

      ? "watch"

      : "bad",

    "Earnings quality",

    `Operating cash flow is ${
      fmt.format(
        r.cash
      )
    }× net income.`

  );


  add(

    r.de <= 0.7

      ? "good"

      : r.de <= 1.5

      ? "watch"

      : "bad",

    "Balance-sheet leverage",

    `Debt/equity is ${
      fmt.format(
        r.de
      )
    }×; debt changed ${
      fmt.format(
        Math.abs(
          r.debtGrowth
        ) * 100
      )
    }% YoY.`

  );


  add(

    r.current >= 1.5

      ? "good"

      : r.current >= 1

      ? "watch"

      : "bad",

    "Liquidity",

    `Current ratio is ${
      fmt.format(
        r.current
      )
    }×.`

  );


  add(

    r.roe >= 0.18

      ? "good"

      : r.roe >= 0.10

      ? "watch"

      : "bad",

    "Shareholder returns",

    `ROE is ${
      pct(
        r.roe
      )
    } and ROCE is ${
      pct(
        r.roce
      )
    }.`

  );


  add(

    r.recv <= 45

      ? "good"

      : r.recv <= 75

      ? "watch"

      : "bad",

    "Receivables",

    `Estimated collection period is ${
      fmt.format(
        r.recv
      )
    } days.`

  );


  if (
    r.coverage != null
  ) {

    add(

      r.coverage >= 3

        ? "good"

        : r.coverage >= 1.5

        ? "watch"

        : "bad",

      "Interest coverage",

      `Operating income covers finance cost ${
        fmt.format(
          r.coverage
        )
      }×.`

    );

  }


  return out;

}


/* ============================================================
   7. MAIN DASHBOARD
   ============================================================ */

function render(
  data = primary
) {

  const analysis =
    calc(data);


  const scoreSet =
    scores(
      analysis.r
    );


  const total =
    Math.round(

      Object.values(
        scoreSet
      ).reduce(
        (a, b) =>
          a + b,
        0
      )

      /

      Object.keys(
        scoreSet
      ).length

    );


  $("#companyName").textContent =
    analysis.l.company ||
    "Uploaded Company";


  $("#period").textContent =
    `FY${analysis.rows[0].year}–FY${analysis.l.year}`;


  $("#metrics").innerHTML = [

    [
      "REVENUE",
      money(
        analysis.l.revenue
      ),
      analysis.r.revGrowth
    ],

    [
      "NET INCOME",
      money(
        analysis.l.net_income
      ),
      analysis.r.incomeGrowth
    ],

    [
      "OPERATING MARGIN",
      pct(
        analysis.r.op
      ),
      analysis.r.marginShift
    ],

    [
      "ROCE",
      pct(
        analysis.r.roce
      ),
      analysis.r.roce
    ],

    [
      "DEBT / EQUITY",
      `${fmt.format(
        analysis.r.de
      )}×`,
      -analysis.r.debtGrowth
    ]

  ]

    .map(
      (
        [
          label,
          value,
          direction
        ]
      ) => `

        <article class="metric">

          <span>
            ${label}
          </span>

          <strong>
            ${value}
          </strong>

          <small
            class="${
              direction >= 0
                ? "up"
                : "down"
            }"
          >

            ${
              direction >= 0
                ? "↑"
                : "↓"
            }

            ${fmt.format(
              Math.abs(
                direction
              ) * 100
            )}%

          </small>

        </article>

      `
    )

    .join("");


  renderChart(
    analysis.rows
  );


  $("#ring")
    .style
    .setProperty(
      "--score",
      total
    );


  $("#score").textContent =
    total;


  $("#scoreLabel").textContent =

    total >= 75

      ? "Strong financial profile"

      : total >= 55

      ? "Mixed financial profile"

      : "Elevated financial risk";


  $("#scoreCopy").textContent =
    "Composite of profitability, liquidity, leverage, cash quality and efficiency signals.";


  $("#scoreBars").innerHTML =

    Object.entries(
      scoreSet
    )

      .map(
        ([name, value]) => `

          <div class="score-row">

            <span>
              ${name}
            </span>

            <div class="track">

              <i
                style="width:${value}%"
              ></i>

            </div>

            <b>
              ${Math.round(value)}
            </b>

          </div>

        `
      )

      .join("");


  renderSections(
    analysis
  );


  renderAnalyst(
    analysis
  );


  if (competitor) {
    renderCompare();
  }

}


/* ============================================================
   8. PERFORMANCE CHART
   ============================================================ */

function renderChart(
  rows
) {

  const width =
    720;

  const height =
    250;

  const padding =
    38;


  const max =
    Math.max(
      ...rows.map(
        row =>
          row.revenue
      )
    ) * 1.12;


  const x =
    index =>

      padding

      +

      index *

      (
        (
          width -
          padding * 2
        )

        /

        Math.max(
          rows.length - 1,
          1
        )
      );


  const y =
    value =>

      height

      -

      padding

      -

      (
        value /
        max
      )

      *

      (
        height -
        padding * 1.45
      );


  const line =
    key =>

      rows

        .map(
          (row, index) =>

            `${
              index
                ? "L"
                : "M"
            }${x(index)},${y(
              row[key]
            )}`
        )

        .join(" ");


  const labels =

    rows

      .map(
        (row, index) => `

          <text
            x="${x(index)}"
            y="${height - 8}"
            text-anchor="middle"
            fill="#63716c"
            font-size="11"
          >
            FY${String(
              row.year
            ).slice(-2)}
          </text>

        `
      )

      .join("");


  $("#chart").innerHTML = `

    <svg
      viewBox="0 0 ${width} ${height}"
      role="img"
      aria-label="Revenue and net income trend"
    >

      <path
        d="${line("revenue")}"
        fill="none"
        stroke="#2f7d68"
        stroke-width="3"
      />

      <path
        d="${line("net_income")}"
        fill="none"
        stroke="#b7df75"
        stroke-width="3"
      />


      ${

        rows

          .map(
            (row, index) => `

              <circle
                cx="${x(index)}"
                cy="${y(
                  row.revenue
                )}"
                r="4"
                fill="#2f7d68"
              >
                <title>
                  Revenue FY${row.year}: ${money(
                    row.revenue
                  )}
                </title>
              </circle>


              <circle
                cx="${x(index)}"
                cy="${y(
                  row.net_income
                )}"
                r="4"
                fill="#b7df75"
              >
                <title>
                  Net income FY${row.year}: ${money(
                    row.net_income
                  )}
                </title>
              </circle>

            `
          )

          .join("")

      }


      ${labels}

    </svg>

  `;

}


/* ============================================================
   9. RESEARCH SECTIONS
   ============================================================ */

const sections = [

  "Financials",

  "Cash & earnings",

  "Working capital",

  "Debt",

  "Returns",

  "Forensic flags",

  "Management & report",

  "Investor checklist"

];


function renderSections(
  analysis
) {

  $("#sectionTabs").innerHTML =

    sections

      .map(
        (section, index) => `

          <button

            class="tab ${
              index
                ? ""
                : "active"
            }"

            data-section="${section}"

          >

            ${section}

          </button>

        `
      )

      .join("");


  document

    .querySelectorAll(
      ".tab"
    )

    .forEach(
      button => {

        button.onclick =
          () => {

            document

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


            sectionContent(
              button.dataset.section,
              analysis
            );

          };

      }
    );


  sectionContent(
    sections[0],
    analysis
  );

}


/* ============================================================
   10. CARD BUILDER
   ============================================================ */

function cards(
  items
) {

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


/* ============================================================
   11. SECTION CONTENT
   ============================================================ */

function sectionContent(
  name,
  analysis
) {

  const r =
    analysis.r;


  const latest =
    analysis.l;


  let items =
    [];


  if (
    name ===
    "Financials"
  ) {

    items = [

      [
        "Revenue",
        money(
          latest.revenue
        ),
        `${pct(
          r.revGrowth
        )} YoY growth`
      ],

      [
        "Operating margin",
        pct(r.op),
        `${
          r.marginShift >= 0
            ? "Expanded"
            : "Contracted"
        } versus prior year`
      ],

      [
        "Net margin",
        pct(r.net),
        "Profit retained after all reported costs"
      ],

      [
        "Asset turnover",
        `${fmt.format(
          r.asset
        )}×`,
        "Revenue generated per unit of assets"
      ],

      [
        "Gross margin",
        pct(r.gross),
        "Revenue less mapped cost of goods sold"
      ],

      [
        "Net income",
        money(
          latest.net_income
        ),
        `${pct(
          r.incomeGrowth
        )} YoY change`
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
          latest.operating_cash_flow
        ),

        "Cash generated from operations"
      ],

      [
        "CFO / PAT",

        `${fmt.format(
          r.cash
        )}×`,

        r.cash >= 1

          ? "Strong cash backing of earnings"

          : "Investigate working-capital and non-cash movements"
      ],

      [
        "Free cash flow",

        "Needs capex disclosure",

        "Annual-report AI should verify capital expenditure before calculating free cash flow"
      ],

      [
        "Earnings quality",

        r.cash >= 1

          ? "Strong"

          : r.cash >= 0.75

          ? "Watch"

          : "Concern",

        "Cash conversion is one input; exceptional items, provisions and accounting policies also require review"
      ]

    ];

  }


  if (
    name ===
    "Working capital"
  ) {

    items = [

      [
        "Receivable days",

        `${fmt.format(
          r.recv
        )} days`,

        "Higher values can indicate slower customer collections"
      ],

      [
        "Inventory days",

        `${fmt.format(
          r.inv
        )} days`,

        "Track against sales growth and industry norms"
      ],

      [
        "Payable days",

        r.pay

          ? `${fmt.format(
              r.pay
            )} days`

          : "N/A",

        "Estimated supplier payment period"
      ],

      [
        "Current ratio",

        `${fmt.format(
          r.current
        )}×`,

        "Short-term asset coverage of liabilities"
      ],

      [
        "Quick ratio",

        `${fmt.format(
          r.quick
        )}×`,

        "Liquidity excluding inventory"
      ]

    ];

  }


  if (
    name ===
    "Debt"
  ) {

    items = [

      [
        "Total debt",

        money(
          latest.total_debt
        ),

        `${pct(
          r.debtGrowth
        )} YoY change`
      ],

      [
        "Debt / equity",

        `${fmt.format(
          r.de
        )}×`,

        "Capital structure leverage"
      ],

      [
        "Interest coverage",

        r.coverage

          ? `${fmt.format(
              r.coverage
            )}×`

          : "N/A",

        "Operating income relative to finance cost"
      ],

      [
        "Debt maturity profile",

        "Needs annual-report notes",

        "Annual-report AI should investigate maturity buckets, security and refinancing exposure"
      ]

    ];

  }


  if (
    name ===
    "Returns"
  ) {

    items = [

      [
        "ROE",
        pct(r.roe),
        "Return generated on reported equity"
      ],

      [
        "ROCE",
        pct(r.roce),
        "Operating return on average capital employed"
      ],

      [
        "ROA",
        pct(r.roa),
        "Profit relative to total assets"
      ],

      [
        "Operating margin",
        pct(r.op),
        "Core operating profitability"
      ]

    ];

  }


  if (
    name ===
    "Forensic flags"
  ) {

    const sig =

      signals(
        analysis
      )

        .filter(
          item =>
            item.type !==
            "good"
        );


    items = sig.length

      ? sig.map(
          item => [

            item.title,

            item.type ===
            "bad"

              ? "Concern"

              : "Watch",

            item.text

          ]
        )

      : [

          [
            "No major threshold flags",

            "Clear on current rules",

            "Still review auditor notes, related parties, exceptional items and accounting policies"
          ]

        ];

  }


  if (
    name ===
    "Management & report"
  ) {

    items =
      pdfEvidence.length

        ? pdfEvidence

            .slice(
              0,
              12
            )

            .map(
              evidence => [

                evidence.title,

                evidence.label,

                evidence.text

              ]
            )

        : [

            [
              "Annual-report narrative",

              "Upload a PDF",

              "PDF mode scans management, risk, auditor, related-party, capex, debt, governance and contingent-liability evidence."
            ],

            [
              "Management promise tracker",

              "AI research feature",

              "Multi-report AI compares earlier management commitments against later evidence."
            ],

            [
              "Claims vs numbers",

              "AI research feature",

              "FinSight can test qualitative management claims against quantitative financial evidence."
            ]

          ];

  }


  if (
    name ===
    "Investor checklist"
  ) {

    items = [

      [
        "Business",

        "Understand first",

        "How does the company make money and what drives demand?"
      ],

      [
        "Financial quality",

        "Check",

        "Are growth, margins and returns durable?"
      ],

      [
        "Cash",

        "Check",

        "Are reported profits supported by operating cash flow?"
      ],

      [
        "Balance sheet",

        "Check",

        "Can the company safely fund obligations and future growth?"
      ],

      [
        "Management",

        "Verify",

        "Has management historically delivered on commitments?"
      ],

      [
        "Valuation",

        "Separate question",

        "A great company can still be a poor investment at an excessive price."
      ]

    ];

  }


  $("#sectionPanel").innerHTML =
    cards(items);

}


/* ============================================================
   12. INVESTOR ANALYST
   ============================================================ */

function renderAnalyst(
  analysis
) {

  const sig =
    signals(
      analysis
    );


  for (
    const type of [
      "good",
      "bad",
      "watch"
    ]
  ) {

    const findings =

      sig

        .filter(
          item =>
            item.type ===
            type
        )

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

        .join("");


    $(`#${type}List`)
      .innerHTML =

      findings

      ||

      `<div class="finding">
         No signal in this category under current thresholds.
       </div>`;

  }


  const bad =
    sig.filter(
      item =>
        item.type ===
        "bad"
    );


  const watch =
    sig.filter(
      item =>
        item.type ===
        "watch"
    );


  $("#briefTitle").textContent =

    `${analysis.l.company}: ${
      bad.length

        ? "some issues require investigation"

        : "financial signals are broadly constructive"
    }.`;


  $("#brief").textContent =

    `Revenue growth is ${pct(
      analysis.r.revGrowth
    )}, operating margin is ${pct(
      analysis.r.op
    )}, ROCE is ${pct(
      analysis.r.roce
    )}, debt/equity is ${fmt.format(
      analysis.r.de
    )}× and operating cash flow covers net income ${fmt.format(
      analysis.r.cash
    )}×. `

    +

    (

      bad.length

        ?

        `The highest-priority current concerns are ${
          bad
            .map(
              item =>
                item.title
                  .toLowerCase()
            )
            .join(", ")
        }.`

        :

        `No high-severity threshold flag was triggered, but ${
          watch.length

            ?

            "watch " +
            watch
              .map(
                item =>
                  item.title
                    .toLowerCase()
              )
              .join(", ")

            :

            "annual-report disclosures still require review"
        }.`
    );


  const questions =
    [];


  if (
    analysis.r.cash < 1
  ) {

    questions.push(
      "Why is operating cash flow lagging reported profit?"
    );

  }


  if (
    analysis.r.recv > 45
  ) {

    questions.push(
      "Why are receivable days elevated, and are customer collections deteriorating?"
    );

  }


  if (
    analysis.r.debtGrowth >
    0.15
  ) {

    questions.push(
      "What return is expected from the additional borrowing?"
    );

  }


  if (
    analysis.r.marginShift <
    0
  ) {

    questions.push(
      "What is driving operating-margin compression?"
    );

  }


  questions.push(

    "What are the largest contingent liabilities and key audit matters?",

    "What growth assumptions are already embedded in the current market price?"

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
   13. COMPETITOR COMPARISON
   ============================================================ */

function renderCompare() {

  if (!competitor) {
    return;
  }


  const companyA =
    calc(primary);


  const companyB =
    calc(competitor);


  $("#compareStatus").textContent =

    `${companyA.l.company} vs ${companyB.l.company}`;


  const rows = [

    [
      "Revenue growth",
      companyA.r.revGrowth,
      companyB.r.revGrowth,
      "pctHigh"
    ],

    [
      "Operating margin",
      companyA.r.op,
      companyB.r.op,
      "pctHigh"
    ],

    [
      "Net margin",
      companyA.r.net,
      companyB.r.net,
      "pctHigh"
    ],

    [
      "ROCE",
      companyA.r.roce,
      companyB.r.roce,
      "pctHigh"
    ],

    [
      "ROE",
      companyA.r.roe,
      companyB.r.roe,
      "pctHigh"
    ],

    [
      "CFO / PAT",
      companyA.r.cash,
      companyB.r.cash,
      "xHigh"
    ],

    [
      "Debt / equity",
      companyA.r.de,
      companyB.r.de,
      "xLow"
    ],

    [
      "Current ratio",
      companyA.r.current,
      companyB.r.current,
      "xHigh"
    ],

    [
      "Receivable days",
      companyA.r.recv,
      companyB.r.recv,
      "daysLow"
    ]

  ];


  const value =
    (
      number,
      type
    ) => {

      if (
        type.startsWith(
          "pct"
        )
      ) {

        return pct(number);

      }


      if (
        type.startsWith(
          "days"
        )
      ) {

        return `${fmt.format(
          number
        )} days`;

      }


      return `${fmt.format(
        number
      )}×`;

    };


  $("#comparePanel").className =
    "comparison-wrap";


  $("#comparePanel").innerHTML = `

    <div style="overflow-x:auto">

      <table class="comparison-table">

        <thead>

          <tr>

            <th>
              Metric
            </th>

            <th>
              ${companyA.l.company}
            </th>

            <th>
              ${companyB.l.company}
            </th>

            <th>
              Edge
            </th>

          </tr>

        </thead>


        <tbody>

          ${

            rows

              .map(
                (
                  [
                    name,
                    a,
                    b,
                    type
                  ]
                ) => {

                  const lowerBetter =
                    type.endsWith(
                      "Low"
                    );


                  const winner =

                    lowerBetter

                      ?

                      a < b
                        ? "A"
                        : b < a
                        ? "B"
                        : "Tie"

                      :

                      a > b
                        ? "A"
                        : b > a
                        ? "B"
                        : "Tie";


                  return `

                    <tr>

                      <td>
                        <b>
                          ${name}
                        </b>
                      </td>

                      <td>
                        ${value(
                          a,
                          type
                        )}
                      </td>

                      <td>
                        ${value(
                          b,
                          type
                        )}
                      </td>

                      <td class="winner">

                        ${
                          winner === "A"

                            ? companyA.l.company

                            : winner === "B"

                            ? companyB.l.company

                            : "Comparable"
                        }

                      </td>

                    </tr>

                  `;

                }
              )

              .join("")

          }

        </tbody>

      </table>

    </div>

  `;

}


/* ============================================================
   14. CSV PARSER
   ============================================================ */

function parseCSV(
  text
) {

  const lines =

    text

      .trim()

      .split(
        /\r?\n/
      )

      .filter(Boolean);


  if (
    lines.length < 3
  ) {

    throw new Error(
      "CSV needs a header and at least two reporting years."
    );

  }


  const headers =

    lines[0]

      .split(",")

      .map(
        item =>

          item

            .trim()

            .toLowerCase()

            .replace(
              /\s+/g,
              "_"
            )
      );


  const missing =

    required

      .filter(
        key =>
          !headers.includes(
            key
          )
      );


  if (
    missing.length
  ) {

    throw new Error(

      `Missing columns: ${
        missing.join(", ")
      }`

    );

  }


  return lines

    .slice(1)

    .map(
      line => {

        const cells =
          line.split(",");


        const row =
          {};


        headers.forEach(
          (
            header,
            index
          ) => {

            row[header] =

              header ===
              "company"

                ? cells[index]

                : Number(

                    String(
                      cells[index]
                    )

                      .replace(
                        /[₹$]/g,
                        ""
                      )

                  );

          }
        );


        return row;

      }
    );

}


/* ============================================================
   15. WORKBOOK HELPERS
   ============================================================ */

function norm(
  value
) {

  return String(
    value ?? ""
  )

    .toLowerCase()

    .replace(
      /[^a-z0-9]+/g,
      " "
    )

    .trim();

}


function num(
  value
) {

  if (
    typeof value ===
      "number"

    &&

    Number.isFinite(
      value
    )
  ) {

    return value;

  }


  const number =

    Number(

      String(
        value ?? ""
      )

        .replace(
          /[₹,$()\s]/g,
          ""
        )

    );


  return Number.isFinite(
    number
  )

    ? number

    : null;

}


function sheet(
  workbook,
  pattern
) {

  const name =

    workbook
      .SheetNames
      .find(
        item =>
          pattern.test(
            norm(item)
          )
      );


  return name

    ?

    XLSX.utils.sheet_to_json(

      workbook.Sheets[name],

      {
        header: 1,
        defval: null,
        raw: true
      }

    )

    :

    null;

}


function row(
  rows,
  label,
  all = false
) {

  const target =
    norm(label);


  const matches =

    rows.filter(
      item =>
        norm(
          item[0]
        ).includes(
          target
        )
    );


  return all
    ? matches
    : matches[0];

}


function years(
  rows
) {

  const map =
    new Map();


  rows

    .slice(
      0,
      10
    )

    .forEach(
      row =>

        row.forEach(
          (
            cell,
            index
          ) => {

            const match =

              String(
                cell ?? ""
              )

                .match(
                  /(?:FY\s*)?(20\d{2})/i
                );


            if (
              match &&
              !map.has(
                Number(
                  match[1]
                )
              )
            ) {

              map.set(
                Number(
                  match[1]
                ),
                index
              );

            }

          }
        )
    );


  return map;

}


/* ============================================================
   16. EXCEL WORKBOOK PARSER
   ============================================================ */

function parseWorkbook(
  buffer
) {

  if (
    typeof XLSX ===
    "undefined"
  ) {

    throw new Error(
      "Excel reader failed to load."
    );

  }


  const workbook =
    XLSX.read(
      buffer,
      {
        type: "array"
      }
    );


  const income =
    sheet(
      workbook,
      /^income statement$/
    );


  const balance =
    sheet(
      workbook,
      /^balance sheet$/
    );


  const cashFlow =
    sheet(
      workbook,
      /^cash flow statement$/
    );


  if (
    !income ||
    !balance ||
    !cashFlow
  ) {

    throw new Error(

      'Workbook needs sheets named "Income Statement", "Balance Sheet" and "Cash Flow Statement".'

    );

  }


  const incomeYears =
    years(income);


  const balanceYears =
    years(balance);


  const cashYears =
    years(cashFlow);


  const reportingYears =

    [...incomeYears.keys()]

      .filter(
        year =>
          balanceYears.has(
            year
          )

          &&

          cashYears.has(
            year
          )
      )

      .sort(
        (a, b) =>
          a - b
      );


  if (
    reportingYears.length <
    2
  ) {

    throw new Error(
      "Need at least two shared reporting years."
    );

  }


  const company =

    String(
      income[0]?.[0] ||
      "Uploaded Company"
    );


  const R = {

    revenue:
      row(
        income,
        "revenue from operations"
      ),


    materials:
      row(
        income,
        "cost of materials consumed"
      ),


    purchases:
      row(
        income,
        "purchase of stock in trade"
      ),


    inventoryChange:
      row(
        income,
        "changes in inventory"
      ),


    excise:
      row(
        income,
        "excise duty"
      ),


    pbt:

      row(
        income,
        "profit before exceptional items and tax"
      )

      ||

      row(
        income,
        "profit before tax"
      ),


    finance:
      row(
        income,
        "finance cost"
      ),


    pat:

      row(
        income,
        "profit for the year"
      )

      ||

      row(
        income,
        "profit after tax"
      ),


    currentAssets:
      row(
        balance,
        "total current assets"
      ),


    totalAssets:
      row(
        balance,
        "total assets"
      ),


    equity:

      row(
        balance,
        "total equity"
      )

      ||

      row(
        balance,
        "other equity"
      ),


    currentLiabilities:
      row(
        balance,
        "total current liabilities"
      ),


    inventory:
      row(
        balance,
        "inventories"
      ),


    receivables:
      row(
        balance,
        "trade receivables"
      ),


    payables:
      row(
        balance,
        "trade payables"
      ),


    borrowings:
      row(
        balance,
        "borrowings",
        true
      ),


    operatingCash:

      row(
        cashFlow,
        "net cash from operating activities"
      )

      ||

      row(
        cashFlow,
        "net cash generated from operating activities"
      )

  };


  const output =

    reportingYears

      .map(
        year => {

          const incomeColumn =
            incomeYears.get(
              year
            );


          const balanceColumn =
            balanceYears.get(
              year
            );


          const cashColumn =
            cashYears.get(
              year
            );


          const value =
            (
              financialRow,
              column
            ) =>

              financialRow

                ? num(
                    financialRow[column]
                  )

                : null;


          const cogs = [

            R.materials,

            R.purchases,

            R.inventoryChange,

            R.excise

          ]

            .reduce(
              (
                sum,
                item
              ) =>

                sum

                +

                (
                  value(
                    item,
                    incomeColumn
                  )

                  || 0
                ),

              0
            );


          const financeCost =

            value(
              R.finance,
              incomeColumn
            )

            || 0;


          const debt =

            R.borrowings

              .reduce(
                (
                  sum,
                  item
                ) =>

                  sum

                  +

                  (
                    value(
                      item,
                      balanceColumn
                    )

                    || 0
                  ),

                0
              );


          return {

            company,

            year,

            revenue:
              value(
                R.revenue,
                incomeColumn
              ),

            cogs,

            operating_income:

              (
                value(
                  R.pbt,
                  incomeColumn
                )

                || 0
              )

              +

              financeCost,

            net_income:
              value(
                R.pat,
                incomeColumn
              ),

            total_assets:
              value(
                R.totalAssets,
                balanceColumn
              ),

            current_assets:
              value(
                R.currentAssets,
                balanceColumn
              ),

            current_liabilities:
              value(
                R.currentLiabilities,
                balanceColumn
              ),

            total_debt:
              debt,

            total_equity:
              value(
                R.equity,
                balanceColumn
              ),

            operating_cash_flow:
              value(
                R.operatingCash,
                cashColumn
              ),

            inventory:
              value(
                R.inventory,
                balanceColumn
              ),

            accounts_receivable:
              value(
                R.receivables,
                balanceColumn
              ),

            accounts_payable:
              value(
                R.payables,
                balanceColumn
              ),

            finance_cost:
              financeCost

          };

        }
      )

      .filter(
        item =>

          required.every(
            key =>
              Number.isFinite(
                item[key]
              )
          )
      );


  if (
    output.length < 2
  ) {

    throw new Error(
      "Could not map two complete reporting years from this workbook."
    );

  }


  return output;

}


/* ============================================================
   17. LARGE PDF + MULTI-REPORT ANALYZER
   ============================================================ */

async function parsePDF(
  file
) {

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


  /* ----------------------------------------------------------
     1,000 PAGE LIMIT
     ---------------------------------------------------------- */

  const MAX_PDF_SCAN_PAGES =
    1000;


  const pagesToScan =

    Math.min(
      pdf.numPages,
      MAX_PDF_SCAN_PAGES
    );


  /* ----------------------------------------------------------
     DISCLOSURE CATEGORIES
     ---------------------------------------------------------- */

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
      "Subsidiaries",
      "subsidiar"
    ],

    [
      "Auditor qualification",
      "qualification"
    ],

    [
      "Cash flow",
      "cash flow"
    ],

    [
      "Revenue",
      "revenue"
    ],

    [
      "Profitability",
      "profit"
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


  /* ----------------------------------------------------------
     YEAR NORMALIZATION
     ---------------------------------------------------------- */

  function normalizeEndYear(
    startYear,
    rawEnd
  ) {

    let endYear =
      Number(
        rawEnd
      );


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


    return endYear;

  }


  function makeYearInfo(
    startYear,
    rawEnd
  ) {

    const endYear =
      normalizeEndYear(
        startYear,
        rawEnd
      );


    return {

      startYear,

      endYear,

      label:

        `FY${startYear}-${String(
          endYear
        ).slice(-2)}`

    };

  }


  /* ----------------------------------------------------------
     GENERAL YEAR DETECTION
     ---------------------------------------------------------- */

  function detectFinancialYear(
    text
  ) {

    const normalized =

      String(
        text || ""
      )

        .replace(
          /\s+/g,
          " "
        )

        .trim();


    let match =

      normalized.match(
        /annual\s+report\s+(20\d{2})\s*[-–—]\s*(\d{2,4})/i
      );


    if (match) {

      return makeYearInfo(
        Number(match[1]),
        Number(match[2])
      );

    }


    match =

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


    /*
     * Supporting evidence only:
     * "year ended March 31, 2026"
     */

    match =

      normalized.match(
        /year\s+ended\s+(?:31(?:st)?\s+)?march\s+31[,]?\s*(20\d{2})/i
      );


    if (match) {

      const endYear =
        Number(
          match[1]
        );


      return {

        startYear:
          endYear - 1,

        endYear,

        label:

          `FY${endYear - 1}-${String(
            endYear
          ).slice(-2)}`

      };

    }


    return null;

  }


  /* ----------------------------------------------------------
     STRONG REPORT BOUNDARY DETECTION
     ---------------------------------------------------------- */

  function detectStrongReportHeading(
    text
  ) {

    const normalized =

      String(
        text || ""
      )

        .replace(
          /\s+/g,
          " "
        );


    const match =

      normalized.match(
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


  let currentReport =
    null;


  /* ----------------------------------------------------------
     STATUS WHILE SCANNING
     ---------------------------------------------------------- */

  const uploadStatus =
    document.getElementById(
      "uploadStatus"
    );


  if (uploadStatus) {

    uploadStatus.textContent =

      `Scanning ${pagesToScan} of ${pdf.numPages} PDF pages…`;

  }


  /* ----------------------------------------------------------
     PAGE SCAN
     ---------------------------------------------------------- */

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


    /* --------------------------------------------------------
       REPORT BOUNDARY
       -------------------------------------------------------- */

    const strongYear =
      detectStrongReportHeading(
        text
      );


    if (strongYear) {

      const key =

        `${strongYear.startYear}-${strongYear.endYear}`;


      if (
        !reportMap.has(
          key
        )
      ) {

        /*
         * Close previous report.
         */

        if (
          currentReport &&
          currentReport.endPage == null
        ) {

          currentReport.endPage =
            pageNumber - 1;

        }


        const report = {

          ...strongYear,

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
          reportMap.get(
            key
          );

      }

    }


    /*
     * If a strong annual-report heading hasn't
     * appeared yet, use other year evidence.
     */

    if (
      !currentReport
    ) {

      const weakYear =
        detectFinancialYear(
          text
        );


      if (weakYear) {

        const key =

          `${weakYear.startYear}-${weakYear.endYear}`;


        if (
          !reportMap.has(
            key
          )
        ) {

          const report = {

            ...weakYear,

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


    /* --------------------------------------------------------
       DISCLOSURES
       -------------------------------------------------------- */

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

        currentReport
          ?.label

        ||

        "Unknown FY";


      /*
       * One evidence sample per category per report.
       */

      const duplicate =

        found.some(
          item =>

            item.title ===
              title

            &&

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


      const evidenceText =

        text.slice(

          Math.max(
            0,
            index - 120
          ),

          Math.min(
            text.length,
            index + 420
          )

        );


      found.push({

        title,

        report:
          reportLabel,

        financialYear:
          currentReport
            ?.endYear ||
          null,

        page:
          pageNumber,

        label:

          `${reportLabel} · PDF page ${pageNumber}`,

        text:

          evidenceText +
          "…"

      });


      if (
        currentReport
      ) {

        currentReport
          .disclosureCount++;

      }

    }


    /* --------------------------------------------------------
       PROGRESS
       -------------------------------------------------------- */

    if (
      uploadStatus &&
      (
        pageNumber === 1 ||
        pageNumber % 25 === 0 ||
        pageNumber === pagesToScan
      )
    ) {

      const percent =

        Math.round(
          (
            pageNumber /
            pagesToScan
          ) * 100
        );


      uploadStatus.textContent =

        `Scanning annual report: ${pageNumber}/${pagesToScan} pages (${percent}%)…`;

    }


    /*
     * Yield periodically.
     *
     * Important for iPad Safari on large PDFs.
     */

    if (
      pageNumber % 20 === 0
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


  /* ----------------------------------------------------------
     CLOSE LAST REPORT
     ---------------------------------------------------------- */

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


  /*
   * Repair any missing boundaries.
   */

  for (
    let index = 0;
    index < detectedReports.length;
    index++
  ) {

    const report =
      detectedReports[index];


    const next =
      detectedReports[
        index + 1
      ];


    if (
      report.endPage == null
    ) {

      report.endPage =

        next

          ? next.startPage - 1

          : pagesToScan;

    }

  }


  /*
   * AI gets newest report first.
   */

  const reportsNewestFirst =

    [...detectedReports]

      .sort(
        (a, b) =>
          b.endYear -
          a.endYear
      );


  /* ----------------------------------------------------------
     STORE SHARED CONTEXT
     ---------------------------------------------------------- */

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


  /* ----------------------------------------------------------
     CONFIDENCE
     ---------------------------------------------------------- */

  const confidence =
    document.getElementById(
      "confidence"
    );


  if (confidence) {

    if (
      reportsNewestFirst.length >
      1
    ) {

      confidence.textContent =

        `High · ${reportsNewestFirst.length} reports detected`;

    }

    else {

      confidence.textContent =
        "Medium · PDF narrative scan";

    }

  }


  /* ----------------------------------------------------------
     FINAL STATUS
     ---------------------------------------------------------- */

  if (uploadStatus) {

    const pageMessage =

      pdf.numPages >
      MAX_PDF_SCAN_PAGES

        ?

        `Scanned first ${MAX_PDF_SCAN_PAGES} of ${pdf.numPages} pages.`

        :

        `Scanned all ${pdf.numPages} pages.`;


    if (
      reportsNewestFirst.length >
      1
    ) {

      const yearList =

        reportsNewestFirst

          .map(
            report =>
              report.label
          )

          .join(", ");


      uploadStatus.textContent =

        `${file.name}: ${pageMessage} `

        +

        `Detected ${reportsNewestFirst.length} annual reports (${yearList}). `

        +

        `Found ${found.length} disclosure categories across the reports. `

        +

        `Annual Report AI can now analyze each year separately and compare them.`;

    }

    else {

      uploadStatus.textContent =

        `${file.name}: ${pageMessage} `

        +

        `Found ${found.length} disclosure categories. `

        +

        "Use Annual Report AI for deeper analysis.";

    }

  }


  /*
   * Keep existing structured-data dashboard.
   *
   * The PDF is narrative evidence; Gemini handles
   * the deeper annual-report extraction.
   */

  render(
    primary
  );


  return window
    .finSightPDFContext;

}


/* ============================================================
   18. FILE LOADER
   ============================================================ */

async function loadFile(
  file,
  target
) {

  try {

    $("#error").hidden =
      true;


    const filename =
      file.name
        .toLowerCase();


    if (
      filename.endsWith(
        ".pdf"
      )
    ) {

      /*
       * Reset previous PDF context.
       */

      pdfEvidence =
        [];


      window.finSightPDFContext =
        null;


      await parsePDF(
        file
      );


      return;

    }


    let data;


    if (
      filename.endsWith(
        ".csv"
      )
    ) {

      data =
        parseCSV(
          await file.text()
        );

    }

    else {

      data =
        parseWorkbook(
          await file.arrayBuffer()
        );

    }


    if (
      target ===
      "primary"
    ) {

      primary =
        data;


      $("#confidence").textContent =
        "High · structured data";


      $("#uploadStatus").textContent =

        `${file.name} analyzed · ${data.length} reporting years mapped.`;


      render();

    }

    else {

      competitor =
        data;


      renderCompare();


      $("#compare")
        .scrollIntoView({
          behavior:
            "smooth"
        });

    }

  }

  catch (
    error
  ) {

    console.error(
      error
    );


    $("#error").textContent =
      error.message;


    $("#error").hidden =
      false;


    $("#research")
      .scrollIntoView({
        behavior:
          "smooth"
      });

  }

}


/* ============================================================
   19. FILE EVENTS
   ============================================================ */

$("#companyFile")
  .onchange =
  event => {

    const file =
      event.target
        .files?.[0];


    if (file) {

      loadFile(
        file,
        "primary"
      );

    }

  };


$("#competitorFile")
  .onchange =
  event => {

    const file =
      event.target
        .files?.[0];


    if (file) {

      loadFile(
        file,
        "competitor"
      );

    }

  };


/* ============================================================
   20. DEMO
   ============================================================ */

$("#sampleBtn")
  .onclick =
  () => {

    primary =
      demo;


    competitor =
      competitorDemo;


    pdfEvidence =
      [];


    window.finSightPDFContext =
      null;


    $("#uploadStatus")
      .textContent =
      "Demo company and competitor loaded.";


    $("#confidence")
      .textContent =
      "High · structured demo data";


    render();


    renderCompare();

  };


/* ============================================================
   21. MARKET MODAL
   ============================================================ */

$("#marketBtn")
  .onclick =
  () => {

    $("#marketModal")
      .hidden =
      false;

  };


$("#closeMarket")
  .onclick =
  () => {

    $("#marketModal")
      .hidden =
      true;

  };


$("#marketModal")
  .onclick =
  event => {

    if (
      event.target ===
      $("#marketModal")
    ) {

      $("#marketModal")
        .hidden =
        true;

    }

  };


$("#saveMarket")
  .onclick =
  () => {

    const ticker =

      $("#tickerInput")
        .value
        .trim()
        .toUpperCase();


    const exchange =

      $("#exchangeInput")
        .value;


    $("#tickerInput")
      .value =
      ticker;


    $("#marketModal")
      .hidden =
      true;


    if (ticker) {

      $("#priceDisplay")
        .textContent =

        `${ticker} · ${exchange} · fetch price below`;

    }

    else {

      $("#priceDisplay")
        .textContent =
        "Manual quote mode";

    }


    $("#priceInput")
      .focus();

  };


/* ============================================================
   22. BASIC VALUATION
   ============================================================ */

$("#valueBtn")
  .onclick =
  () => {

    const price =
      Number(
        $("#priceInput")
          .value
      );


    const shares =
      Number(
        $("#sharesInput")
          .value
      );


    const pe =
      Number(
        $("#peInput")
          .value
      );


    const analysis =
      calc(primary);


    if (
      !price ||
      !shares ||
      !pe
    ) {

      $("#valuationResults")
        .innerHTML = `

          <p>
            Enter current price, shares outstanding and preferred P/E.
          </p>

        `;

      return;

    }


    const eps =

      analysis.l.net_income

      /

      shares;


    const base =
      eps * pe;


    const bear =
      base * 0.8;


    const bull =
      base * 1.2;


    const premium =

      (
        price -
        base
      )

      /

      base;


    const view =

      premium > 0.15

        ? "Expensive vs scenario"

        : premium < -0.15

        ? "Attractive vs scenario"

        : "Near scenario value";


    /*
     * Preserve Alpha Vantage provider/date if the
     * market API has already populated this field.
     */

    if (
      !String(
        $("#priceDisplay")
          .textContent
      )
        .includes(
          "Alpha Vantage"
        )
    ) {

      $("#priceDisplay")
        .textContent =

        `₹${fmt.format(
          price
        )} · manual`;

    }


    $("#valuationView")
      .textContent =
      view;


    $("#valuationResults")
      .innerHTML = [

        [
          "Bear scenario",
          bear,
          "80% of selected multiple"
        ],

        [
          "Base scenario",
          base,
          `${pe}× latest earnings`
        ],

        [
          "Bull scenario",
          bull,
          "120% of selected multiple"
        ],

        [
          "Current price",
          price,
          `${
            premium >= 0
              ? "+"
              : ""
          }${fmt.format(
            premium * 100
          )}% vs base scenario`
        ]

      ]

        .map(
          (
            [
              name,
              value,
              description
            ]
          ) => `

            <div class="scenario">

              <b>
                ${name}
              </b>

              <strong>
                ₹${fmt.format(
                  value
                )}
              </strong>

              <small>
                ${description}
              </small>

            </div>

          `
        )

        .join("");

  };


/* ============================================================
   23. INITIAL RENDER
   ============================================================ */

render();
