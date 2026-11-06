/* ============================================================
   FINSIGHT AI — VALUATION ENGINE

   Supports:
   - DCF
   - Reverse DCF
   - Automatic assumptions
   - Bear / Base / Bull scenarios
   - Input validation

   UNIT CONVENTION

   Financial statement values:
   ₹ crore

   Shares outstanding:
   crore shares

   Per-share valuation:
   ₹ per share

   Example:
   Equity value = ₹100,000 crore
   Shares = 1,000 crore
   Value/share = ₹100
   ============================================================ */


/* ============================================================
   1. HELPERS
   ============================================================ */

function number(value) {

  const parsed =
    Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : null;

}


function requiredNumber(
  value,
  name
) {

  const parsed =
    number(value);

  if (parsed == null) {

    throw new Error(
      `${name} is required for this valuation.`
    );

  }

  return parsed;

}


function positiveNumber(
  value,
  name
) {

  const parsed =
    requiredNumber(
      value,
      name
    );

  if (parsed <= 0) {

    throw new Error(
      `${name} must be greater than zero.`
    );

  }

  return parsed;

}


function clamp(
  value,
  min,
  max
) {

  return Math.max(
    min,
    Math.min(
      max,
      value
    )
  );

}


function round(
  value,
  digits = 2
) {

  if (
    !Number.isFinite(
      value
    )
  ) {

    return null;

  }


  const factor =
    10 ** digits;


  return (
    Math.round(
      value * factor
    ) / factor
  );

}


/* ============================================================
   2. ASSUMPTION VALIDATION
   ============================================================ */

function validateWacc(
  value
) {

  const wacc =
    requiredNumber(
      value,
      "WACC"
    );


  if (
    wacc <= 0 ||
    wacc >= 0.50
  ) {

    throw new Error(
      "WACC must be between 0% and 50%."
    );

  }


  return wacc;

}


function validateTerminalGrowth(
  value,
  wacc
) {

  const growth =
    requiredNumber(
      value,
      "Terminal growth"
    );


  if (
    growth <= -0.20 ||
    growth >= 0.20
  ) {

    throw new Error(
      "Terminal growth must be between -20% and 20%."
    );

  }


  if (
    growth >= wacc
  ) {

    throw new Error(
      "Terminal growth must be lower than WACC."
    );

  }


  return growth;

}


function validateRevenueGrowth(
  value
) {

  const growth =
    requiredNumber(
      value,
      "Revenue growth"
    );


  if (
    growth <= -0.75 ||
    growth >= 1
  ) {

    throw new Error(
      "Revenue growth assumption must be between -75% and 100%."
    );

  }


  return growth;

}


function validateMargin(
  value
) {

  const margin =
    requiredNumber(
      value,
      "EBIT margin"
    );


  if (
    margin <= -0.50 ||
    margin >= 0.80
  ) {

    throw new Error(
      "EBIT margin assumption must be between -50% and 80%."
    );

  }


  return margin;

}


/* ============================================================
   3. FREE CASH FLOW ESTIMATION
   ============================================================ */

/*
 * FinSight uses a simplified unlevered cash-flow model.
 *
 * When operating cash flow and capex are available,
 * historical cash conversion is used to estimate the
 * relationship between EBIT and free cash flow.
 *
 * If that relationship cannot be established,
 * a conservative fallback conversion is used.
 *
 * The fallback is explicitly returned to the frontend.
 */

function estimateCashConversion({
  ebit,
  operatingCashFlow,
  capex
}) {

  const reportedEBIT =
    number(ebit);


  const ocf =
    number(
      operatingCashFlow
    );


  const capitalExpenditure =
    number(capex);


  if (
    reportedEBIT != null &&
    reportedEBIT !== 0 &&
    ocf != null &&
    capitalExpenditure != null
  ) {

    const historicalFCF =
      ocf -
      capitalExpenditure;


    const conversion =
      historicalFCF /
      reportedEBIT;


    /*
     * Avoid extreme one-year accounting effects
     * dominating the forecast.
     */

    return {

      rate:
        clamp(
          conversion,
          0.15,
          1.25
        ),

      source:
        "historical operating cash flow less capex relative to EBIT",

      historicalFCF:
        round(
          historicalFCF
        )

    };

  }


  return {

    rate:
      0.70,

    source:
      "FinSight conservative fallback assumption",

    historicalFCF:
      null

  };

}


/* ============================================================
   4. CORE DCF
   ============================================================ */

function calculateDCF({

  revenue,

  ebit,

  operatingCashFlow,

  capex,

  netDebt = 0,

  sharesOutstanding,

  revenueGrowth,

  ebitMargin,

  wacc,

  terminalGrowth,

  forecastYears = 5

}) {

  const startingRevenue =
    positiveNumber(
      revenue,
      "Revenue"
    );


  const shares =
    positiveNumber(
      sharesOutstanding,
      "Shares outstanding"
    );


  const startingEBIT =
    number(ebit);


  const debt =
    number(netDebt) ??
    0;


  const growth =
    validateRevenueGrowth(
      revenueGrowth
    );


  const margin =
    validateMargin(
      ebitMargin
    );


  const discountRate =
    validateWacc(
      wacc
    );


  const terminalRate =
    validateTerminalGrowth(
      terminalGrowth,
      discountRate
    );


  const years =
    Math.round(
      clamp(
        number(
          forecastYears
        ) ?? 5,
        3,
        10
      )
    );


  const cashConversion =
    estimateCashConversion({

      ebit:
        startingEBIT,

      operatingCashFlow,

      capex

    });


  const forecasts =
    [];


  let projectedRevenue =
    startingRevenue;


  let presentValueForecast =
    0;


  for (
    let year = 1;
    year <= years;
    year++
  ) {

    projectedRevenue *=
      1 + growth;


    const projectedEBIT =
      projectedRevenue *
      margin;


    const projectedFCF =
      projectedEBIT *
      cashConversion.rate;


    const discountFactor =
      1 /
      (
        (
          1 +
          discountRate
        ) ** year
      );


    const presentValue =
      projectedFCF *
      discountFactor;


    presentValueForecast +=
      presentValue;


    forecasts.push({

      year,

      revenue:
        round(
          projectedRevenue
        ),

      ebit:
        round(
          projectedEBIT
        ),

      freeCashFlow:
        round(
          projectedFCF
        ),

      discountFactor:
        round(
          discountFactor,
          4
        ),

      presentValue:
        round(
          presentValue
        )

    });

  }


  const finalFCF =
    forecasts.at(-1)
      .freeCashFlow;


  const terminalValue =

    finalFCF

    *

    (
      1 +
      terminalRate
    )

    /

    (
      discountRate -
      terminalRate
    );


  const terminalDiscountFactor =

    1

    /

    (
      (
        1 +
        discountRate
      ) ** years
    );


  const presentValueTerminal =
    terminalValue *
    terminalDiscountFactor;


  const enterpriseValue =
    presentValueForecast +
    presentValueTerminal;


  const equityValue =
    enterpriseValue -
    debt;


  const valuePerShare =
    equityValue /
    shares;


  return {

    forecastYears:
      years,

    assumptions: {

      startingRevenue:
        round(
          startingRevenue
        ),

      startingEBIT:
        startingEBIT == null
          ? null
          : round(
              startingEBIT
            ),

      revenueGrowth:
        round(
          growth,
          4
        ),

      ebitMargin:
        round(
          margin,
          4
        ),

      wacc:
        round(
          discountRate,
          4
        ),

      terminalGrowth:
        round(
          terminalRate,
          4
        ),

      netDebt:
        round(
          debt
        ),

      sharesOutstanding:
        round(
          shares
        ),

      cashConversionRate:
        round(
          cashConversion.rate,
          4
        ),

      cashConversionSource:
        cashConversion.source,

      historicalFCF:
        cashConversion.historicalFCF

    },

    forecasts,

    presentValueForecast:
      round(
        presentValueForecast
      ),

    terminalValue:
      round(
        terminalValue
      ),

    presentValueTerminal:
      round(
        presentValueTerminal
      ),

    enterpriseValue:
      round(
        enterpriseValue
      ),

    equityValue:
      round(
        equityValue
      ),

    valuePerShare:
      round(
        valuePerShare
      )

  };

}


/* ============================================================
   5. AUTOMATIC BASE ASSUMPTIONS
   ============================================================ */

function automaticAssumptions(
  input
) {

  const revenue =
    positiveNumber(
      input.revenue,
      "Revenue"
    );


  const ebit =
    number(
      input.ebit
    );


  /*
   * If no explicit margin is supplied,
   * use current EBIT margin when available.
   */

  let margin =
    number(
      input.ebitMargin
    );


  if (
    margin == null &&
    ebit != null
  ) {

    margin =
      ebit /
      revenue;

  }


  if (
    margin == null
  ) {

    margin =
      0.15;

  }


  /*
   * If no explicit growth assumption exists,
   * use a conservative default.
   *
   * The frontend currently supplies one, but this
   * keeps the API robust.
   */

  let growth =
    number(
      input.revenueGrowth
    );


  if (
    growth == null
  ) {

    growth =
      0.08;

  }


  let wacc =
    number(
      input.wacc
    );


  if (
    wacc == null
  ) {

    wacc =
      0.10;

  }


  let terminalGrowth =
    number(
      input.terminalGrowth
    );


  if (
    terminalGrowth == null
  ) {

    terminalGrowth =
      0.04;

  }


  return {

    revenueGrowth:
      validateRevenueGrowth(
        growth
      ),

    ebitMargin:
      validateMargin(
        margin
      ),

    wacc:
      validateWacc(
        wacc
      ),

    terminalGrowth:
      validateTerminalGrowth(
        terminalGrowth,
        wacc
      )

  };

}


/* ============================================================
   6. PUBLIC DCF
   ============================================================ */

export function runDCF(
  input = {}
) {

  const assumptions =
    automaticAssumptions(
      input
    );


  const base =
    calculateDCF({

      ...input,

      ...assumptions

    });


  /*
   * Scenario framework.
   *
   * Bear:
   * lower growth,
   * lower margin,
   * higher discount rate.
   *
   * Bull:
   * higher growth,
   * higher margin,
   * slightly lower discount rate.
   */


  const bearGrowth =
    clamp(
      assumptions.revenueGrowth -
      0.03,
      -0.50,
      0.75
    );


  const bearMargin =
    clamp(
      assumptions.ebitMargin -
      0.02,
      -0.40,
      0.70
    );


  const bearWacc =
    clamp(
      assumptions.wacc +
      0.015,
      0.01,
      0.45
    );


  const bearTerminal =
    Math.min(
      assumptions.terminalGrowth -
      0.005,
      bearWacc -
      0.01
    );


  const bullGrowth =
    clamp(
      assumptions.revenueGrowth +
      0.03,
      -0.50,
      0.75
    );


  const bullMargin =
    clamp(
      assumptions.ebitMargin +
      0.02,
      -0.40,
      0.70
    );


  const bullWacc =
    clamp(
      assumptions.wacc -
      0.01,
      0.01,
      0.45
    );


  const bullTerminal =
    Math.min(
      assumptions.terminalGrowth +
      0.005,
      bullWacc -
      0.01
    );


  const bear =
    calculateDCF({

      ...input,

      revenueGrowth:
        bearGrowth,

      ebitMargin:
        bearMargin,

      wacc:
        bearWacc,

      terminalGrowth:
        bearTerminal

    });


  const bull =
    calculateDCF({

      ...input,

      revenueGrowth:
        bullGrowth,

      ebitMargin:
        bullMargin,

      wacc:
        bullWacc,

      terminalGrowth:
        bullTerminal

    });


  return {

    ok:
      true,

    model:
      "FinSight simplified unlevered DCF",

    unitConvention: {

      financialStatements:
        "crore",

      shares:
        "crore shares",

      perShareValue:
        "currency units per share"

    },

    scenarios: {

      bear: {

        valuePerShare:
          bear.valuePerShare,

        enterpriseValue:
          bear.enterpriseValue,

        equityValue:
          bear.equityValue,

        assumptions:
          bear.assumptions

      },

      base: {

        valuePerShare:
          base.valuePerShare,

        enterpriseValue:
          base.enterpriseValue,

        equityValue:
          base.equityValue,

        assumptions:
          base.assumptions

      },

      bull: {

        valuePerShare:
          bull.valuePerShare,

        enterpriseValue:
          bull.enterpriseValue,

        equityValue:
          bull.equityValue,

        assumptions:
          bull.assumptions

      }

    },

    baseForecast:
      base.forecasts,

    warnings: [

      "DCF values depend heavily on growth, margin, discount-rate and terminal-growth assumptions.",

      "FinSight uses a simplified cash-conversion framework and should not be treated as a substitute for a full analyst cash-flow model.",

      "Missing annual-report inputs are not fabricated."

    ]

  };

}


/* ============================================================
   7. REVERSE DCF
   ============================================================ */

export function reverseDCF(
  input = {}
) {

  const marketPrice =
    positiveNumber(
      input.marketPrice,
      "Market price"
    );


  const shares =
    positiveNumber(
      input.sharesOutstanding,
      "Shares outstanding"
    );


  const revenue =
    positiveNumber(
      input.revenue,
      "Revenue"
    );


  const assumptions =
    automaticAssumptions(
      input
    );


  /*
   * Search for the constant revenue growth rate
   * that makes DCF value/share approximately equal
   * to the current market price.
   *
   * Range:
   * -30% to +80%
   */

  let low =
    -0.30;


  let high =
    0.80;


  let bestGrowth =
    null;


  let bestResult =
    null;


  let bestDifference =
    Infinity;


  const iterations =
    70;


  for (
    let iteration = 0;
    iteration < iterations;
    iteration++
  ) {

    const midpoint =
      (
        low +
        high
      ) / 2;


    let result;


    try {

      result =
        calculateDCF({

          ...input,

          revenue,

          sharesOutstanding:
            shares,

          revenueGrowth:
            midpoint,

          ebitMargin:
            assumptions.ebitMargin,

          wacc:
            assumptions.wacc,

          terminalGrowth:
            assumptions.terminalGrowth

        });

    }

    catch (
      error
    ) {

      throw new Error(
        `Reverse DCF failed: ${error.message}`
      );

    }


    const value =
      result.valuePerShare;


    const difference =
      Math.abs(
        value -
        marketPrice
      );


    if (
      difference <
      bestDifference
    ) {

      bestDifference =
        difference;

      bestGrowth =
        midpoint;

      bestResult =
        result;

    }


    if (
      value <
      marketPrice
    ) {

      low =
        midpoint;

    }

    else {

      high =
        midpoint;

    }

  }


  if (
    !bestResult
  ) {

    throw new Error(
      "Reverse DCF could not determine a market-implied growth rate."
    );

  }


  const impliedGrowth =
    bestGrowth;


  const impliedValue =
    bestResult
      .valuePerShare;


  const absoluteError =
    impliedValue -
    marketPrice;


  const percentageError =
    marketPrice !== 0

      ? absoluteError /
        marketPrice

      : null;


  let interpretation;


  if (
    impliedGrowth >= 0.25
  ) {

    interpretation =
      "The current market price appears to require very strong sustained revenue growth under the supplied margin and discount-rate assumptions.";

  }

  else if (
    impliedGrowth >= 0.12
  ) {

    interpretation =
      "The current market price appears to embed meaningful sustained growth expectations.";

  }

  else if (
    impliedGrowth >= 0.04
  ) {

    interpretation =
      "The current market price appears to embed moderate sustained growth under the supplied assumptions.";

  }

  else if (
    impliedGrowth >= 0
  ) {

    interpretation =
      "The current market price appears to require relatively modest positive growth under the supplied assumptions.";

  }

  else {

    interpretation =
      "Under the supplied assumptions, the current market price can be supported even with declining revenue, indicating that the model assumptions may be conservative or that the market price is low relative to the modeled cash flows.";

  }


  return {

    ok:
      true,

    model:
      "FinSight reverse DCF",

    marketPrice:
      round(
        marketPrice
      ),

    impliedRevenueGrowth:
      round(
        impliedGrowth,
        4
      ),

    impliedRevenueGrowthPercent:
      round(
        impliedGrowth * 100,
        2
      ),

    modeledValuePerShare:
      round(
        impliedValue
      ),

    pricingError:
      round(
        absoluteError
      ),

    pricingErrorPercent:
      percentageError == null

        ? null

        : round(
            percentageError * 100,
            2
          ),

    assumptions: {

      ebitMargin:
        round(
          assumptions.ebitMargin,
          4
        ),

      wacc:
        round(
          assumptions.wacc,
          4
        ),

      terminalGrowth:
        round(
          assumptions.terminalGrowth,
          4
        ),

      sharesOutstanding:
        round(
          shares
        ),

      netDebt:
        round(
          number(
            input.netDebt
          ) ?? 0
        )

    },

    interpretation,

    warnings: [

      "Reverse DCF does not forecast what the company will actually achieve.",

      "It estimates the constant revenue-growth rate required to approximately justify the current market price under the supplied assumptions.",

      "Changes in margins, WACC, terminal growth, cash conversion or capital intensity can materially change the implied growth rate."

    ]

  };

}
