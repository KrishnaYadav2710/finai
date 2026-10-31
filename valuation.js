function finite(n, name) {
  const v = Number(n);
  if (!Number.isFinite(v)) throw new Error(`${name} must be a finite number.`);
  return v;
}
function pct(n, name) {
  const v = finite(n, name);
  if (v <= -1 || v >= 1) throw new Error(`${name} must be entered as a decimal between -1 and 1 (for example 0.12 for 12%).`);
  return v;
}

export function runDCF(input = {}) {
  const revenue0 = finite(input.revenue, 'revenue');
  const ebitMargin = pct(input.ebitMargin, 'ebitMargin');
  const taxRate = pct(input.taxRate ?? 0.25, 'taxRate');
  const daPct = pct(input.daPctRevenue ?? 0.03, 'daPctRevenue');
  const capexPct = pct(input.capexPctRevenue ?? 0.04, 'capexPctRevenue');
  const nwcPct = pct(input.nwcPctRevenue ?? 0.08, 'nwcPctRevenue');
  const wacc = pct(input.wacc ?? 0.12, 'wacc');
  const terminalGrowth = pct(input.terminalGrowth ?? 0.05, 'terminalGrowth');
  if (wacc <= terminalGrowth) throw new Error('WACC must be greater than terminal growth.');
  const years = Math.max(1, Math.min(15, Math.round(finite(input.years ?? 5, 'years'))));
  const growths = Array.isArray(input.growthRates) && input.growthRates.length
    ? input.growthRates.map((v, i) => pct(v, `growthRates[${i}]`))
    : Array(years).fill(pct(input.growthRate ?? 0.10, 'growthRate'));
  while (growths.length < years) growths.push(growths.at(-1));
  const netDebt = finite(input.netDebt ?? 0, 'netDebt');
  const shares = finite(input.shares, 'shares');
  if (shares <= 0) throw new Error('shares must be greater than zero.');

  let revenue = revenue0;
  let prevNwc = revenue0 * nwcPct;
  let pvFcff = 0;
  const rows = [];
  for (let year = 1; year <= years; year++) {
    revenue *= (1 + growths[year - 1]);
    const ebit = revenue * ebitMargin;
    const nopat = ebit * (1 - taxRate);
    const da = revenue * daPct;
    const capex = revenue * capexPct;
    const nwc = revenue * nwcPct;
    const deltaNwc = nwc - prevNwc;
    const fcff = nopat + da - capex - deltaNwc;
    const discountFactor = Math.pow(1 + wacc, year);
    const pv = fcff / discountFactor;
    pvFcff += pv;
    rows.push({ year, revenue, ebit, nopat, da, capex, deltaNwc, fcff, pv });
    prevNwc = nwc;
  }
  const lastFcff = rows.at(-1).fcff;
  const terminalValue = lastFcff * (1 + terminalGrowth) / (wacc - terminalGrowth);
  const pvTerminal = terminalValue / Math.pow(1 + wacc, years);
  const enterpriseValue = pvFcff + pvTerminal;
  const equityValue = enterpriseValue - netDebt;
  const valuePerShare = equityValue / shares;
  return { assumptions: { years, growthRates: growths, ebitMargin, taxRate, daPctRevenue: daPct, capexPctRevenue: capexPct, nwcPctRevenue: nwcPct, wacc, terminalGrowth, netDebt, shares }, rows, pvFcff, terminalValue, pvTerminal, enterpriseValue, equityValue, valuePerShare };
}

export function reverseDCF(input = {}) {
  const marketPrice = finite(input.marketPrice, 'marketPrice');
  if (marketPrice <= 0) throw new Error('marketPrice must be greater than zero.');
  let low = -0.25, high = 0.80;
  let result = null;
  for (let i = 0; i < 80; i++) {
    const mid = (low + high) / 2;
    result = runDCF({ ...input, growthRate: mid, growthRates: undefined });
    if (result.valuePerShare < marketPrice) low = mid; else high = mid;
  }
  const impliedGrowthRate = (low + high) / 2;
  result = runDCF({ ...input, growthRate: impliedGrowthRate, growthRates: undefined });
  return { marketPrice, impliedGrowthRate, modelValuePerShare: result.valuePerShare, assumptions: result.assumptions, note: 'This reverse DCF solves for a constant forecast-period revenue growth rate under the supplied margin, reinvestment, WACC and terminal-growth assumptions.' };
}
