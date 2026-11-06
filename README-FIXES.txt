FinSight AI - corrected replacement bundle

Replace the matching files in the GitHub repository with the files in this ZIP.

Main fixes:
1. Financial-health score excludes unavailable categories instead of treating missing data as 0/neutral.
2. Score number and /100 are centered in the ring.
3. Duplicate financial years are deduplicated; consolidated/more-complete rows are preferred.
4. Alpha Vantage uses SYMBOL_SEARCH before GLOBAL_QUOTE and receives company name + exchange.
5. INR/USD/etc. currency codes display with normal symbols.
6. Research thesis table self-heals before save/load.
7. Research memory can load by company name when ticker is unavailable.
8. Two-report comparison analyzes PDFs separately, then compares structured JSON to reduce 502 failures.
9. API error objects are rendered as readable messages.
10. No sample-company fallback was added.

Database repair:
The server now creates research_theses when needed. If your Supabase permissions prevent server-side CREATE TABLE, run finsight-db-repair.sql once in Supabase SQL Editor.

After deploying test:
- /api/health
- upload one annual report and confirm one chart point per FY
- verify health score has no fake 0 category for missing data
- verify automatic market price for a verified listed company
- save thesis, then load research memory
- compare two PDFs

Important: Alpha Vantage free data is last-available/end-of-day, not live. A quote can still be unavailable if Alpha Vantage does not cover the security/symbol or the free API limit is reached.
