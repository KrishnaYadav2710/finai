/* ============================================================
   FINSIGHT AI — VALUATION ENGINE

   Supports:
   - DCF
   - Reverse DCF
   - Bear / Base / Bull scenarios
   - Input validation

   UNIT CONVENTION

   Financial statement values:
   INR crore

   Shares outstanding:
   crore shares

   Per-share valuation:
   INR / currency units per share
   ============================================================ */


/* ============================================================
   1. HELPERS
   ============================================================ */

function number(value) {

  /*
   * IMPORTANT:
   *
   * Number(null) === 0
   * Number("") === 0
   *
   * Missing financial information must NOT
   * silently become zero.
   */

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
      value * factor
    ) / factor
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
      "Revenue growth must be greater than -75% and lower than 100%."
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
      "EBIT margin must be greater than -50% and lower than 80%."
    );

  }

  return margin;

}


/* ============================================================
   3. FREE CASH FLOW ESTIMATION
   ============================================================ */

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


  /*
   * Historical conversion is used only when all
   * required values exist and EBIT is positive.
   *
   * Negative/zero EBIT makes FCF/EBIT conversion
   * economically unreliable.
   */

  if (
    reportedEBIT != null &&
    reportedEBIT > 0 &&
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
     * Prevent a single unusual year from producing
     * an extreme forecast conversion ratio.
     */

    const normalizedRate =
      clamp(
        conversion,
        0.15,
        1.25
      );


    return {

      rate:
        normalizedRate,

      source:
        "Historical operating cash flow less capex relative to EBIT",

      historicalFCF:
        round(
          historicalFCF
        ),

      rawHistoricalRate:
        round(
          conversion,
          4
        ),

      constrained:
        normalizedRate !==
        conversion

    };

  }


  /*
   * Fallback is explicitly disclosed.
   */

  return {

    rate:
      0.70,

    source:
      "FinSight fallback cash-conversion assumption",

    historicalFCF:
      null,

    rawHistoricalRate:
      null,

    constrained:
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

  netDebt,

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


  /*
   * Net debt is required.
   *
   * Missing debt/cash information must not
   * silently become zero.
   */

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


  /*
   * Keep the unrounded final FCF separately.
   *
   * Terminal value should never be calculated
   * from a display-rounded number.
   */

  let finalProjectedFCF =
    null;


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
          4
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
      "DCF forecast could not be generated."
    );

  }


  /*
   * Gordon Growth terminal value.
   */

  const terminalValue =

    finalProjectedFCF

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


  /*
   * EV = equity value + net debt
   *
   * Therefore:
   *
   * equity value = EV - net debt
   *
   * Negative net debt (net cash) correctly
   * increases equity value.
   */

  const equityValue =
    enterpriseValue -
    debt;


  const valuePerShare =
    equityValue /
    shares;


  if (
    !Number.isFinite(
      valuePerShare
    )
  ) {

    throw new Error(
      "DCF produced an invalid per-share value."
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

      rawHistoricalCashConversionRate:
        cashConversion.rawHistoricalRate,

      cashConversionWasConstrained:
        cashConversion.constrained,

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
   5. BASE ASSUMPTIONS
   ============================================================ */

function automaticAssumptions(input) {

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
   * Explicit assumption first.
   * Otherwise use reported EBIT/revenue.
   * Final fallback = 15%.
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
   * Revenue growth fallback = 8%.
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


  /*
   * WACC fallback = 10%.
   */

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


  /*
   * Terminal growth fallback = 4%.
   */

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
   6. PUBLIC DCF
   ============================================================ */

export function runDCF(
  input = {}
) {

  /*
   * Prevent missing net debt from silently
   * becoming zero.
   */

  if (
    number(
      input.netDebt
    ) == null
  ) {

    throw new Error(
      "Net debt is required for DCF. Use annual-report net debt or enter a verified value."
    );

  }


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
   * BEAR CASE
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


  /*
   * BULL CASE
   */

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


  /*
   * IMPORTANT:
   *
   * Return base values at TOP LEVEL as well.
   *
   * Your finsight-investor.js renderer reads:
   *
   * result.enterpriseValue
   * result.equityValue
   * result.valuePerShare
   * result.terminalValue
   *
   * Previously those values only existed inside
   * scenarios.base, causing N/A cards.
   */

  return {

    ok:
      true,

    model:
      "FinSight simplified unlevered DCF",

    unitConvention: {

      financialStatements:
        "INR crore",

      shares:
        "crore shares",

      perShareValue:
        "currency units per share"

    },


    /* FRONTEND-COMPATIBLE BASE VALUES */

    valuePerShare:
      base.valuePerShare,

    enterpriseValue:
      base.enterpriseValue,

    equityValue:
      base.equityValue,

    terminalValue:
      base.terminalValue,

    presentValueForecast:
      base.presentValueForecast,

    presentValueTerminal:
      base.presentValueTerminal,

    assumptions:
      base.assumptions,


    scenarios: {

      bear: {

        valuePerShare:
          bear.valuePerShare,

        enterpriseValue:
          bear.enterpriseValue,

        equityValue:
          bear.equityValue,

        terminalValue:
          bear.terminalValue,

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

        terminalValue:
          base.terminalValue,

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

        terminalValue:
          bull.terminalValue,

        assumptions:
          bull.assumptions

      }

    },

    baseForecast:
      base.forecasts,

    warnings: [

      "DCF values are highly sensitive to revenue growth, EBIT margin, WACC, terminal growth and cash conversion.",

      "FinSight uses a simplified cash-conversion framework rather than a full FCFF model with explicit tax, depreciation and working-capital forecasts.",

      base.assumptions
        .cashConversionWasConstrained
        ? "Historical FCF-to-EBIT conversion was outside the permitted range and was constrained for forecasting."
        : null,

      "Missing annual-report inputs are not fabricated."

    ].filter(Boolean)

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


  if (
    number(
      input.netDebt
    ) == null
  ) {

    throw new Error(
      "Net debt is required for reverse DCF. Use annual-report net debt or enter a verified value."
    );

  }


  const assumptions =
    automaticAssumptions(
      input
    );


  /*
   * Search range:
   *
   * -30% to +80% constant annual revenue growth.
   */

  let low =
    -0.30;


  let high =
    0.80;


  /*
   * Before binary search, determine whether
   * the requested market price is even reachable
   * inside the search range.
   */

  const lowResult =
    calculateDCF({

      ...input,

      revenue,

      sharesOutstanding:
        shares,

      revenueGrowth:
        low,

      ebitMargin:
        assumptions.ebitMargin,

      wacc:
        assumptions.wacc,

      terminalGrowth:
        assumptions.terminalGrowth

    });


  const highResult =
    calculateDCF({

      ...input,

      revenue,

      sharesOutstanding:
        shares,

      revenueGrowth:
        high,

      ebitMargin:
        assumptions.ebitMargin,

      wacc:
        assumptions.wacc,

      terminalGrowth:
        assumptions.terminalGrowth

    });


  const lowValue =
    lowResult.valuePerShare;


  const highValue =
    highResult.valuePerShare;


  if (
    !Number.isFinite(lowValue) ||
    !Number.isFinite(highValue)
  ) {

    throw new Error(
      "Reverse DCF could not establish a valid valuation search range."
    );

  }


  /*
   * With fixed margins and conversion,
   * DCF value should rise with growth.
   *
   * Detect an unexpected model state rather
   * than returning a misleading answer.
   */

  if (
    highValue <= lowValue
  ) {

    throw new Error(
      "Reverse DCF could not establish a monotonic growth-to-value relationship."
    );

  }


  if (
    marketPrice < lowValue
  ) {

    throw new Error(
      `The current market price is below the model value even at -30% annual revenue growth. The implied growth rate is outside FinSight's reverse-DCF search range.`
    );

  }


  if (
    marketPrice > highValue
  ) {

    throw new Error(
      `The current market price requires more than 80% annual revenue growth under the supplied assumptions. The implied growth rate is outside FinSight's reverse-DCF search range.`
    );

  }


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


    const result =
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
      "The current market price requires very strong sustained revenue growth under the supplied margin, cash-conversion and discount-rate assumptions.";

  }

  else if (
    impliedGrowth >= 0.12
  ) {

    interpretation =
      "The current market price embeds meaningful sustained revenue-growth expectations under the supplied assumptions.";

  }

  else if (
    impliedGrowth >= 0.04
  ) {

    interpretation =
      "The current market price embeds moderate sustained revenue growth under the supplied assumptions.";

  }

  else if (
    impliedGrowth >= 0
  ) {

    interpretation =
      "The current market price requires relatively modest positive revenue growth under the supplied assumptions.";

  }

  else {

    interpretation =
      "The model can support the current market price even with declining revenue under the supplied assumptions. Review margins, cash conversion, net debt, WACC and terminal growth before interpreting this as undervaluation.";

  }


  /*
   * Return both canonical names and the aliases
   * expected by the current frontend.
   */

  return {

    ok:
      true,

    model:
      "FinSight reverse DCF",

    marketPrice:
      round(
        marketPrice
      ),


    /* CANONICAL */

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


    /* FRONTEND COMPATIBILITY */

    impliedGrowth:
      round(
        impliedGrowth,
        4
      ),

    impliedValuePerShare:
      round(
        impliedValue
      ),

    valuePerShare:
      round(
        impliedValue
      ),


    pricingError:
      round(
        absoluteError
      ),

    pricingErrorPercent:
      round(
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
          )
        ),

      cashConversionRate:
        bestResult
          .assumptions
          .cashConversionRate,

      cashConversionSource:
        bestResult
          .assumptions
          .cashConversionSource

    },

    interpretation,

    warnings: [

      "Reverse DCF does not forecast the growth the company will actually achieve.",

      "It estimates the constant revenue-growth rate required to approximately justify the entered market price.",

      "Changes in EBIT margin, WACC, terminal growth, cash conversion, net debt or capital intensity can materially change the implied growth rate."

    ]

  };

}
