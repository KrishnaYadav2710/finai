# FinSight Zero-Cost Edition

FinSight is an investor-research web app with deterministic financial calculations, annual-report AI, competitor comparison, DCF/reverse DCF, research memory, and explicitly delayed/end-of-day price context.

## Zero-cost stack

- **AI:** Gemini Developer API free tier (`GEMINI_API_KEY`)
- **Price/history:** Alpha Vantage free tier (`ALPHA_VANTAGE_API_KEY`)
- **Database:** optional Supabase/PostgreSQL free tier (`DATABASE_URL`)
- **Hosting:** use any free Node host while its free tier is available, or run locally on a computer. The iPad is the browser client.
- **Current price fallback:** manual input is always available and requires no API.

Free tiers and quotas can change. The app never labels Alpha Vantage free data as live.

## What changed in this edition

- Removed Groww requirement.
- Removed OpenAI SDK/API requirement.
- Gemini analyzes uploaded PDF annual reports and powers Ask FinSight / competitor / valuation explanations.
- Alpha Vantage supplies last-available/end-of-day quote context and historical daily prices.
- Price UI shows the provider/date and labels the result delayed.
- Manual current price remains available for tickers that the free source does not cover reliably.

## Required accounts / keys

### 1. Gemini API key
Create a Google AI Studio / Gemini Developer API key and set:

```env
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash-lite
```

### 2. Alpha Vantage API key
Create a free Alpha Vantage key and set:

```env
ALPHA_VANTAGE_API_KEY=...
```

The free quote used by this project is **end-of-day / last available trading session**, not a real-time NSE/BSE feed. Alpha Vantage free usage is quota-limited. If a symbol is unsupported or quota is exhausted, enter the current price manually in the Valuation Lab.

### 3. Optional database
For persistent research memory, create a free Supabase/PostgreSQL database:

```env
DATABASE_URL=postgresql://...
DATABASE_SSL=true
```

Without it, core analysis, PDF AI, DCF and valuation still work; saved research does not persist server-side.

### 4. Site password
Recommended for any public deployment:

```env
FINSIGHT_USERNAME=investor
FINSIGHT_PASSWORD=use-a-long-random-password
```

## Run locally

```bash
npm install
cp .env.example .env
# fill in your keys
npm start
```

Open `http://localhost:3000/finsight-investor.html`.

On iPad, deploy the Node app to a cloud host and open the HTTPS address in Safari. Do not place API keys in browser JavaScript.

## Diagnostics

```bash
npm run diagnose
```

This checks Gemini configuration, Alpha Vantage configuration, optional PostgreSQL connectivity, and site protection.

## Free-tier caveats

1. **No guaranteed live price.** This edition is intentionally end-of-day/last-available plus manual fallback.
2. **Alpha Vantage quota.** The free service currently advertises a limited number of requests per day; cache results and avoid refreshing repeatedly.
3. **Indian symbol coverage.** Free global data providers may not cover every NSE/BSE symbol consistently. Manual price input is the safe fallback.
4. **Gemini free-tier limits/privacy.** Free-tier model/rate limits can change, and Google states free-tier content may be used to improve products. Use only public annual reports unless your data policy allows otherwise.
5. **Large PDFs.** Gemini supports PDF document understanding, but very large reports consume more quota and can be slower.
6. **Historical valuation is not the same as historical price.** Correct historical P/E requires point-in-time EPS/fundamentals; this app does not fake those values from current EPS.

## Important

FinSight is educational research software. Its AI findings are evidence-driven investigation prompts, not personalized investment advice.
