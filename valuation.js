/* ============================================================
   FINSIGHT AI — VALUATION ENGINE

   Supports:
   - DCF
   - Reverse DCF
   - Automatic assumptions
   - Bear / Base / Bull scenarios
   - Input validation
   - Reverse-DCF boundary detection

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

   IMPORTANT

   This module assumes server-side financial extraction has
   already normalized:

   - monetary values -> INR crore
   - shares outstanding -> crore shares

   This module performs NO unit conversion.
   ============================================================ */


/* ============================================================
   1. HELPERS
   ============================================================ */

function number(value) {

  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }


  if (
    typeof value === "string" &&
    value.trim() === ""
  ) {
    return null;
  }


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
    !Number.isFinite(value)
  ) {
    return null;
  }


  const factor =
    10 ** digits;


  return (
    Math.round(
      (
        value +
        Number.EPSILON
      ) *
      factor
    ) /
    factor
  );

}


/* ============================================================
   2. ASSUMPTION VALIDATION
   ============================================================ */

function validateWacc(value) {

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
      "WACC must be greater than 0% and lower than 50%."
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
      "Terminal growth must be greater than -20% and lower than 20%."
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


function validateRevenueGrowth(value) {

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
      "Revenue growth assumption must be greater than -75% and lower than 100%."
    );

  }


  return growth;

}


function validateMargin(value) {

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
      "EBIT margin assumption must be greater than -50% and lower than 80%."
    );

  }


  return margin;

}


/* ============================================================
   3. CASH CONVERSION
   ============================================================ */

/*
 * FinSight uses a simplified unlevered cash-flow proxy.
 *
 * Historical FCF proxy:
 *
 * operating cash flow - capex
 *
 * Cash conversion:
 *
 * historical FCF / EBIT
 *
 * IMPORTANT:
 *
 * This is NOT a full FCFF model because operating cash flow
 * is normally after interest and tax effects.
 *
 * The model therefore describes itself as a simplified
 * cash-conversion DCF rather than claiming to calculate
 * textbook FCFF.
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
    reportedEBIT > 0 &&
    ocf != null &&
    capitalExpenditure != null
  ) {

    const historicalFCF =
      ocf -
      capitalExpenditure;


    const rawConversion =
      historicalFCF /
      reportedEBIT;


    /*
     * Negative historical FCF should not silently become
     * a positive conversion assumption.
     *
     * But a single abnormal year should also not produce
     * an unlimited negative DCF.
     *
     * Bound the simplified conversion rate.
     */

    const boundedConversion =
      clamp(
        rawConversion,
        -0.25,
        1.25
      );


    return {

      rate:
        boundedConversion,

      rawRate:
        rawConversion,

      source:
        "historical operating cash flow less capex relative to EBIT",

      historicalFCF,

      capped:
        boundedConversion !==
        rawConversion

    };

  }


  /*
   * Fallback only when historical conversion
   * cannot be calculated.
   */

  return {

    rate:
      0.70,

    rawRate:
      null,

    source:
      "FinSight fallback cash-conversion assumption",

    historicalFCF:
      null,

    capped:
      false

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
    requiredNumber(
      netDebt,
      "Net debt"
    );


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


  const rawYears =
    number(
      forecastYears
    );


  const years =
    Math.round(
      clamp(
        rawYears == null
          ? 5
          : rawYears,
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


  /*
   * Keep the unrounded final FCF separately.
   *
   * Terminal value must NOT be calculated from
   * the rounded display value stored in forecasts.
   */

  let finalProjectedFCF =
    null;


  for (
    let year = 1;
    year <= years;
    year++
  ) {

    projectedRevenue =
      projectedRevenue *
      (
        1 +
        growth
      );


    const projectedEBIT =
      projectedRevenue *
      margin;


    const projectedFCF =
      projectedEBIT *
      cashConversion.rate;


    finalProjectedFCF =
      projectedFCF;


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
          6
        ),

      presentValue:
        round(
          presentValue
        )

    });

  }


  if (
    finalProjectedFCF == null
  ) {

    throw new Error(
      "DCF forecast could not generate free cash flow."
    );

  }


  /*
   * Gordon Growth terminal value.
   *
   * TV at end of forecast:
   *
   * FCF(n) × (1 + g)
   * -----------------
   *      WACC - g
   */

  const terminalFCF =
    finalProjectedFCF *
    (
      1 +
      terminalRate
    );


  const terminalValue =
    terminalFCF /
    (
      discountRate -
      terminalRate
    );


  const terminalDiscountFactor =
    1 /
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


  /*
   * Equity value:
   *
   * EV - net debt
   *
   * Net debt may be negative when the company
   * has net cash. In that case subtracting negative
   * net debt correctly increases equity value.
   */

  const rawEquityValue =
    enterpriseValue -
    debt;


  const rawValuePerShare =
    rawEquityValue /
    shares;


  /*
   * A negative equity value is economically possible
   * in the mathematical model.
   *
   * Keep the raw value for transparency, but expose
   * zero as the floor for estimated equity/share value.
   *
   * A shareholder cannot have a conventional negative
   * quoted share price.
   */

  const equityExhausted =
    rawEquityValue <= 0;


  const equityValue =
    Math.max(
      0,
      rawEquityValue
    );


  const valuePerShare =
    Math.max(
      0,
      rawValuePerShare
    );


  /*
   * Terminal-value concentration is useful because
   * a DCF dominated by terminal value is especially
   * sensitive to WACC and terminal growth.
   */

  const terminalValueShare =
    enterpriseValue !== 0

      ? presentValueTerminal /
        enterpriseValue

      : null;


  const warnings =
    [];


  if (
    cashConversion.capped
  ) {

    warnings.push(
      "Historical cash conversion was outside FinSight's permitted range and was capped for the simplified forecast."
    );

  }


  if (
    cashConversion.rawRate == null
  ) {

    warnings.push(
      "Historical cash conversion could not be established, so FinSight used its fallback cash-conversion assumption."
    );

  }


  if (
    equityExhausted
  ) {

    warnings.push(
      "Modeled enterprise value is at or below net debt. Raw modeled equity value is non-positive, so displayed equity value per share is floored at zero."
    );

  }


  if (
    terminalValueShare != null &&
    terminalValueShare > 0.75
  ) {

    warnings.push(
      "More than 75% of modeled enterprise value comes from the terminal value, making the DCF highly sensitive to WACC and terminal-growth assumptions."
    );

  }


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
          6
        ),

      ebitMargin:
        round(
          margin,
          6
        ),

      wacc:
        round(
          discountRate,
          6
        ),

      terminalGrowth:
        round(
          terminalRate,
          6
        ),

      netDebt:
        round(
          debt
        ),

      sharesOutstanding:
        round(
          shares,
          6
        ),

      cashConversionRate:
        round(
          cashConversion.rate,
          6
        ),

      rawCashConversionRate:
        cashConversion.rawRate == null
          ? null
          : round(
              cashConversion.rawRate,
              6
            ),

      cashConversionSource:
        cashConversion.source,

      cashConversionCapped:
        cashConversion.capped,

      historicalFCF:
        cashConversion.historicalFCF == null
          ? null
          : round(
              cashConversion.historicalFCF
            )

    },

    forecasts,

    presentValueForecast:
      round(
        presentValueForecast
      ),

    terminalFCF:
      round(
        terminalFCF
      ),

    terminalValue:
      round(
        terminalValue
      ),

    presentValueTerminal:
      round(
        presentValueTerminal
      ),

    terminalValueShare:
      terminalValueShare == null
        ? null
        : round(
            terminalValueShare,
            4
          ),

    enterpriseValue:
      round(
        enterpriseValue
      ),

    rawEquityValue:
      round(
        rawEquityValue
      ),

    equityValue:
      round(
        equityValue
      ),

    rawValuePerShare:
      round(
        rawValuePerShare
      ),

    valuePerShare:
      round(
        valuePerShare
      ),

    equityExhausted,

    warnings

  };

}


/* ============================================================
   5. AUTOMATIC BASE ASSUMPTIONS
   ============================================================ */

function automaticAssumptions(
  input = {}
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
   * EBIT margin:
   *
   * 1. Explicit user assumption
   * 2. Current EBIT / revenue
   * 3. Conservative fallback
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
   * Revenue growth:
   *
   * The current frontend normally supplies this.
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


  const validatedWacc =
    validateWacc(
      wacc
    );


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
      validatedWacc,

    terminalGrowth:
      validateTerminalGrowth(
        terminalGrowth,
        validatedWacc
      )

  };

}


/* ============================================================
   6. SCENARIO ASSUMPTIONS
   ============================================================ */

function buildScenarioAssumptions(
  base
) {

  /*
   * Bear:
   *
   * -3 percentage points revenue growth
   * -2 percentage points EBIT margin
   * +1.5 percentage points WACC
   * -0.5 percentage points terminal growth
   */

  const bearGrowth =
    clamp(
      base.revenueGrowth -
      0.03,
      -0.50,
      0.75
    );


  const bearMargin =
    clamp(
      base.ebitMargin -
      0.02,
      -0.40,
      0.70
    );


  const bearWacc =
    clamp(
      base.wacc +
      0.015,
      0.01,
      0.45
    );


  const bearTerminal =
    clamp(
      Math.min(
        base.terminalGrowth -
        0.005,
        bearWacc -
        0.01
      ),
      -0.19,
      0.19
    );


  /*
   * Bull:
   *
   * +3 percentage points revenue growth
   * +2 percentage points EBIT margin
   * -1 percentage point WACC
   * +0.5 percentage points terminal growth
   *
   * Keep at least a 1 percentage point spread
   * between WACC and terminal growth.
   */

  const bullGrowth =
    clamp(
      base.revenueGrowth +
      0.03,
      -0.50,
      0.75
    );


  const bullMargin =
    clamp(
      base.ebitMargin +
      0.02,
      -0.40,
      0.70
    );


  const bullWacc =
    clamp(
      base.wacc -
      0.01,
      0.01,
      0.45
    );


  const bullTerminal =
    clamp(
      Math.min(
        base.terminalGrowth +
        0.005,
        bullWacc -
        0.01
      ),
      -0.19,
      0.19
    );


  return {

    bear: {

      revenueGrowth:
        bearGrowth,

      ebitMargin:
        bearMargin,

      wacc:
        bearWacc,

      terminalGrowth:
        bearTerminal

    },

    bull: {

      revenueGrowth:
        bullGrowth,

      ebitMargin:
        bullMargin,

      wacc:
        bullWacc,

      terminalGrowth:
        bullTerminal

    }

  };

}


/* ============================================================
   7. PUBLIC DCF
   ============================================================ */

export function runDCF(
  input = {}
) {

  const assumptions =
    automaticAssumptions(
      input
    );


  const scenarios =
    buildScenarioAssumptions(
      assumptions
    );


  const base =
    calculateDCF({

      ...input,

      ...assumptions

    });


  const bear =
    calculateDCF({

      ...input,

      ...scenarios.bear

    });


  const bull =
    calculateDCF({

      ...input,

      ...scenarios.bull

    });


  return {

    ok:
      true,

    model:
      "FinSight simplified cash-conversion DCF",

    unitConvention: {

      financialStatements:
        "INR crore",

      shares:
        "crore shares",

      perShareValue:
        "INR per share"

    },

    scenarios: {

      bear: {

        valuePerShare:
          bear.valuePerShare,

        rawValuePerShare:
          bear.rawValuePerShare,

        enterpriseValue:
          bear.enterpriseValue,

        equityValue:
          bear.equityValue,

        rawEquityValue:
          bear.rawEquityValue,

        equityExhausted:
          bear.equityExhausted,

        terminalValueShare:
          bear.terminalValueShare,

        assumptions:
          bear.assumptions,

        warnings:
          bear.warnings

      },


      base: {

        valuePerShare:
          base.valuePerShare,

        rawValuePerShare:
          base.rawValuePerShare,

        enterpriseValue:
          base.enterpriseValue,

        equityValue:
          base.equityValue,

        rawEquityValue:
          base.rawEquityValue,

        equityExhausted:
          base.equityExhausted,

        terminalValueShare:
          base.terminalValueShare,

        assumptions:
          base.assumptions,

        warnings:
          base.warnings

      },


      bull: {

        valuePerShare:
          bull.valuePerShare,

        rawValuePerShare:
          bull.rawValuePerShare,

        enterpriseValue:
          bull.enterpriseValue,

        equityValue:
          bull.equityValue,

        rawEquityValue:
          bull.rawEquityValue,

        equityExhausted:
          bull.equityExhausted,

        terminalValueShare:
          bull.terminalValueShare,

        assumptions:
          bull.assumptions,

        warnings:
          bull.warnings

      }

    },

    baseForecast:
      base.forecasts,

    warnings: [

      "DCF values are highly sensitive to revenue growth, EBIT margin, cash conversion, WACC and terminal-growth assumptions.",

      "FinSight uses a simplified cash-conversion DCF rather than a full analyst FCFF model.",

      "Operating cash flow less capex is used as a historical cash-conversion proxy when those inputs are available.",

      "A negative raw modeled equity value is displayed as ₹0 per share rather than as a negative share price.",

      "Missing annual-report inputs are not fabricated."

    ]

  };

}


/* ============================================================
   8. REVERSE DCF HELPERS
   ============================================================ */

function reverseDCFValueAtGrowth(
  input,
  assumptions,
  growth
) {

  return calculateDCF({

    ...input,

    revenueGrowth:
      growth,

    ebitMargin:
      assumptions.ebitMargin,

    wacc:
      assumptions.wacc,

    terminalGrowth:
      assumptions.terminalGrowth

  });

}


/* ============================================================
   9. REVERSE DCF
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


  /*
   * Reverse DCF does not need a base revenue-growth
   * assumption from the user.
   *
   * automaticAssumptions() accepts one if supplied,
   * otherwise its default is harmless because the
   * search replaces revenueGrowth on every iteration.
   */

  const assumptions =
    automaticAssumptions({

      ...input,

      revenue

    });


  /*
   * Search range:
   *
   * -30% to +80% constant annual revenue growth.
   */

  const minimumGrowth =
    -0.30;


  const maximumGrowth =
    0.80;


  /*
   * First evaluate BOTH boundaries.
   *
   * This is essential.
   *
   * A binary search must not claim an implied growth
   * rate when the target market price lies outside the
   * valuation range generated by the search interval.
   */

  const lowResult =
    reverseDCFValueAtGrowth(

      {
        ...input,

        revenue,

        sharesOutstanding:
          shares
      },

      assumptions,

      minimumGrowth

    );


  const highResult =
    reverseDCFValueAtGrowth(

      {
        ...input,

        revenue,

        sharesOutstanding:
          shares
      },

      assumptions,

      maximumGrowth

    );


  const lowValue =
    number(
      lowResult.valuePerShare
    );


  const highValue =
    number(
      highResult.valuePerShare
    );


  if (
    lowValue == null ||
    highValue == null
  ) {

    throw new Error(
      "Reverse DCF could not evaluate its search boundaries."
    );

  }


  /*
   * Under this model, value should normally increase
   * with revenue growth.
   *
   * Determine actual lower/upper modeled values
   * defensively rather than blindly assuming ordering.
   */

  const minimumModeledValue =
    Math.min(
      lowValue,
      highValue
    );


  const maximumModeledValue =
    Math.max(
      lowValue,
      highValue
    );


  /*
   * ----------------------------------------------------------
   * TARGET ABOVE SEARCH RANGE
   * ----------------------------------------------------------
   */

  if (
    marketPrice >
    maximumModeledValue
  ) {

    return {

      ok:
        true,

      model:
        "FinSight reverse DCF",

      solved:
        false,

      boundary:
        "above",

      marketPrice:
        round(
          marketPrice
        ),

      impliedRevenueGrowth:
        null,

      impliedRevenueGrowthPercent:
        null,

      modeledValuePerShare:
        round(
          highValue
        ),

      pricingError:
        round(
          highValue -
          marketPrice
        ),

      pricingErrorPercent:
        round(
          (
            highValue -
            marketPrice
          ) /
          marketPrice *
          100
        ),

      searchRange: {

        minimumGrowth:
          minimumGrowth,

        minimumGrowthPercent:
          round(
            minimumGrowth *
            100,
            2
          ),

        maximumGrowth:
          maximumGrowth,

        maximumGrowthPercent:
          round(
            maximumGrowth *
            100,
            2
          ),

        valueAtMinimumGrowth:
          round(
            lowValue
          ),

        valueAtMaximumGrowth:
          round(
            highValue
          )

      },

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
            shares,
            6
          ),

        netDebt:
          round(
            requiredNumber(
              input.netDebt,
              "Net debt"
            )
          )

      },

      interpretation:
        "The current market price requires more than 80% annual revenue growth under the supplied assumptions. The implied growth rate is outside FinSight's reverse-DCF search range.",

      warnings: [

        "No exact reverse-DCF solution exists inside the configured -30% to +80% annual revenue-growth range.",

        "This does not mean the company must actually grow revenue by more than 80%. Other assumptions such as margins, cash conversion, WACC, terminal growth and capital intensity may explain the difference.",

        "Reverse DCF estimates what the current market price implies under a simplified model; it is not a forecast."

      ]

    };

  }


  /*
   * ----------------------------------------------------------
   * TARGET BELOW SEARCH RANGE
   * ----------------------------------------------------------
   */

  if (
    marketPrice <
    minimumModeledValue
  ) {

    return {

      ok:
        true,

      model:
        "FinSight reverse DCF",

      solved:
        false,

      boundary:
        "below",

      marketPrice:
        round(
          marketPrice
        ),

      impliedRevenueGrowth:
        null,

      impliedRevenueGrowthPercent:
        null,

      modeledValuePerShare:
        round(
          lowValue
        ),

      pricingError:
        round(
          lowValue -
          marketPrice
        ),

      pricingErrorPercent:
        round(
          (
            lowValue -
            marketPrice
          ) /
          marketPrice *
          100
        ),

      searchRange: {

        minimumGrowth:
          minimumGrowth,

        minimumGrowthPercent:
          round(
            minimumGrowth *
            100,
            2
          ),

        maximumGrowth:
          maximumGrowth,

        maximumGrowthPercent:
          round(
            maximumGrowth *
            100,
            2
          ),

        valueAtMinimumGrowth:
          round(
            lowValue
          ),

        valueAtMaximumGrowth:
          round(
            highValue
          )

      },

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
            shares,
            6
          ),

        netDebt:
          round(
            requiredNumber(
              input.netDebt,
              "Net debt"
            )
          )

      },

      interpretation:
        "Even the minimum -30% annual revenue-growth assumption produces a modeled value above the current market price. The implied growth rate is therefore below FinSight's reverse-DCF search range.",

      warnings: [

        "No exact reverse-DCF solution exists inside the configured -30% to +80% annual revenue-growth range.",

        "The result may indicate conservative model assumptions, a low market price relative to modeled cash flows, or assumptions that do not adequately represent the business.",

        "Reverse DCF is not a forecast."

      ]

    };

  }


  /*
   * ----------------------------------------------------------
   * BINARY SEARCH
   * ----------------------------------------------------------
   */

  let low =
    minimumGrowth;


  let high =
    maximumGrowth;


  let bestGrowth =
    null;


  let bestResult =
    null;


  let bestDifference =
    Infinity;


  const iterations =
    80;


  /*
   * Determine whether modeled value rises or falls
   * over the search interval.
   *
   * Normally it rises.
   */

  const increasing =
    highValue >=
    lowValue;


  for (
    let iteration = 0;
    iteration < iterations;
    iteration++
  ) {

    const midpoint =
      (
        low +
        high
      ) /
      2;


    const result =
      reverseDCFValueAtGrowth(

        {
          ...input,

          revenue,

          sharesOutstanding:
            shares
        },

        assumptions,

        midpoint

      );


    const value =
      number(
        result.valuePerShare
      );


    if (value == null) {

      throw new Error(
        "Reverse DCF produced an invalid modeled value."
      );

    }


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


    /*
     * Binary-search direction.
     */

    if (increasing) {

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

    else {

      if (
        value >
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

  }


  if (
    !bestResult ||
    bestGrowth == null
  ) {

    throw new Error(
      "Reverse DCF could not determine a market-implied growth rate."
    );

  }


  const impliedGrowth =
    bestGrowth;


  const impliedValue =
    bestResult.valuePerShare;


  const absoluteError =
    impliedValue -
    marketPrice;


  const percentageError =
    absoluteError /
    marketPrice;


  let interpretation;


  if (
    impliedGrowth >= 0.25
  ) {

    interpretation =
      "The current market price appears to require very strong sustained revenue growth under the supplied margin, cash-conversion and discount-rate assumptions.";

  }

  else if (
    impliedGrowth >= 0.12
  ) {

    interpretation =
      "The current market price appears to embed meaningful sustained revenue-growth expectations under the supplied assumptions.";

  }

  else if (
    impliedGrowth >= 0.04
  ) {

    interpretation =
      "The current market price appears to embed moderate sustained revenue growth under the supplied assumptions.";

  }

  else if (
    impliedGrowth >= 0
  ) {

    interpretation =
      "The current market price appears to require relatively modest positive revenue growth under the supplied assumptions.";

  }

  else {

    interpretation =
      "Under the supplied assumptions, the current market price can be supported despite declining modeled revenue. This may indicate conservative assumptions, a relatively low market price versus modeled cash flows, or limitations in the simplified DCF framework.";

  }


  return {

    ok:
      true,

    model:
      "FinSight reverse DCF",

    solved:
      true,

    boundary:
      null,

    marketPrice:
      round(
        marketPrice
      ),

    impliedRevenueGrowth:
      round(
        impliedGrowth,
        6
      ),

    impliedRevenueGrowthPercent:
      round(
        impliedGrowth *
        100,
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
      round(
        percentageError *
        100,
        4
      ),

    searchRange: {

      minimumGrowth:
        minimumGrowth,

      minimumGrowthPercent:
        round(
          minimumGrowth *
          100,
          2
        ),

      maximumGrowth:
        maximumGrowth,

      maximumGrowthPercent:
        round(
          maximumGrowth *
          100,
          2
        ),

      valueAtMinimumGrowth:
        round(
          lowValue
        ),

      valueAtMaximumGrowth:
        round(
          highValue
        )

    },

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
          shares,
          6
        ),

      netDebt:
        round(
          requiredNumber(
            input.netDebt,
            "Net debt"
          )
        ),

      cashConversionRate:
        bestResult
          ?.assumptions
          ?.cashConversionRate
        ?? null

    },

    interpretation,

    warnings: [

      "Reverse DCF does not forecast what the company will actually achieve.",

      "It estimates the constant annual revenue-growth rate required to approximately justify the current market price under the supplied assumptions.",

      "Changes in EBIT margin, WACC, terminal growth, cash conversion, capital intensity or net debt can materially change the implied growth rate.",

      "FinSight's DCF is a simplified cash-conversion model rather than a full analyst FCFF model."

    ]

  };

}
