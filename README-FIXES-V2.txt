FinSight AI - Repair V2

Replace these GitHub files with the files in this ZIP:
- server.js
- finsight-investor.js
- finsight-investor.css
- finsight-investor.html
- finsight-ai.js
- db.js
- valuation.js
- diagnostics.js

Then run finsight-db-repair.sql ONCE in Supabase SQL Editor.
NOTE: it drops/recreates research_theses because the existing failed schema uses an incompatible company_id type. If you somehow already have thesis data you need, export it first. Your screenshots show saves are currently failing, so this table is expected to be empty/unusable.

Main fixes:
1. Financial extraction must use audited consolidated statements, not Year-in-Review KPIs.
2. Explicit unit conversion to INR crore: million / 10; billion * 100; crore unchanged.
3. Extract NSE code and BSE code separately.
4. Alpha Vantage tries verified BSE code first (e.g. 543287.BSE for Lodha when extracted from report).
5. Thesis table uses TEXT company_id to work with existing Supabase company IDs regardless of integer/UUID legacy schema.
6. Company comparison analyzes reports separately/in parallel and Gemini requests retry transient 429/5xx errors.
7. Duplicate financial years are deduplicated, preferring consolidated/completer rows.
8. Financial health excludes unavailable categories rather than scoring missing data as zero.

Lodha FY2026 validation target from the uploaded audited consolidated statements (source unit: INR million):
- FY26 Revenue from Operations: 166,762 million = 16,676.2 crore
- FY25 Revenue from Operations: 137,795 million = 13,779.5 crore
- FY26 Profit for year: 34,307 million = 3,430.7 crore
- FY25 Profit for year: 27,666 million = 2,766.6 crore
- FY26 Total Assets: 589,366 million = 58,936.6 crore
- FY25 Total Assets: 498,406 million = 49,840.6 crore
- FY26 Total Equity: 234,292 million = 23,429.2 crore
- FY25 Total Equity: 202,448 million = 20,244.8 crore
- FY26 Operating Cash Flow: 9,593 million = 959.3 crore
- FY25 Operating Cash Flow: 15,656 million = 1,565.6 crore

After deploy test:
/api/health
/api/database/status
Then upload Lodha report and verify the above figures.
