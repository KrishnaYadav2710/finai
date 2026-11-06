import 'dotenv/config';
import { databaseEnabled, dbQuery } from './db.js';
const rows=[];
const add=(check,status,detail)=>rows.push({check,status,detail});
add('Gemini key', process.env.GEMINI_API_KEY?'PASS':'WARN', process.env.GEMINI_API_KEY?'Configured':'Missing GEMINI_API_KEY; AI endpoints will return 503');
add('Alpha Vantage key', process.env.ALPHA_VANTAGE_API_KEY?'PASS':'WARN', process.env.ALPHA_VANTAGE_API_KEY?'Configured for last-available/end-of-day price data':'Missing ALPHA_VANTAGE_API_KEY; use manual price input');
add('Market freshness','INFO','Free mode is end-of-day / last available, not live');
add('Database', databaseEnabled?'PASS':'SKIP', databaseEnabled?'DATABASE_URL configured':'Optional; research memory disabled');
if(databaseEnabled){try{await dbQuery('SELECT 1');add('Database connection','PASS','Connected')}catch(e){add('Database connection','FAIL',e.message)}}
add('Site protection', process.env.FINSIGHT_USERNAME&&process.env.FINSIGHT_PASSWORD?'PASS':'WARN', process.env.FINSIGHT_USERNAME&&process.env.FINSIGHT_PASSWORD?'Basic Auth configured':'Set FINSIGHT_USERNAME and FINSIGHT_PASSWORD before public deployment');
console.table(rows);
