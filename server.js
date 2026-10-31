import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import { databaseEnabled, initDatabase, dbQuery, upsertCompany } from './db.js';
import { runDCF, reverseDCF } from './valuation.js';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 45 * 1024 * 1024 } });
const port = Number(process.env.PORT || 3000);
const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const geminiKey = process.env.GEMINI_API_KEY || '';
const marketProvider = 'alphavantage';
const alphaKey = process.env.ALPHA_VANTAGE_API_KEY || '';
const basicUser = process.env.FINSIGHT_USERNAME || '';
const basicPass = process.env.FINSIGHT_PASSWORD || '';

async function fetchJSON(url, options={}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(body?.message || body?.error || `Market provider returned HTTP ${response.status}`);
  return body;
}

async function getMarketQuote({ticker, exchange='NSE'}) {
  if (!alphaKey) throw new Error('Alpha Vantage is not configured. Add ALPHA_VANTAGE_API_KEY to .env.');
  const symbol = exchange.toUpperCase()==='BSE' ? `${ticker.toUpperCase()}.BSE` : ticker.toUpperCase();
  const url = new URL('https://www.alphavantage.co/query');
  url.searchParams.set('function','GLOBAL_QUOTE');
  url.searchParams.set('symbol',symbol);
  url.searchParams.set('apikey',alphaKey);
  const j = await fetchJSON(url);
  const q=j['Global Quote'] || {};
  const price=Number(q['05. price']);
  if (!Number.isFinite(price)) throw new Error(j.Note || j.Information || 'Alpha Vantage response did not contain a usable end-of-day quote for this symbol.');
  const latestDay=q['07. latest trading day'] || null;
  return {
    provider:'Alpha Vantage Free', ticker:ticker.toUpperCase(), exchange:exchange.toUpperCase(), price,
    open:Number(q['02. open'])||null, high:Number(q['03. high'])||null, low:Number(q['04. low'])||null,
    previousClose:Number(q['08. previous close'])||null, volume:Number(q['06. volume'])||null,
    asOf:latestDay, freshness:'end-of-day / last available trading session; not live'
  };
}

async function getMarketHistory({ticker, exchange='NSE'}) {
  if (!alphaKey) throw new Error('Historical price adapter requires ALPHA_VANTAGE_API_KEY.');
  const symbol = exchange.toUpperCase()==='BSE' ? `${ticker.toUpperCase()}.BSE` : ticker.toUpperCase();
  const url = new URL('https://www.alphavantage.co/query');
  url.searchParams.set('function','TIME_SERIES_DAILY'); url.searchParams.set('symbol',symbol); url.searchParams.set('outputsize','full'); url.searchParams.set('apikey',alphaKey);
  const j=await fetchJSON(url); const ts=j['Time Series (Daily)'];
  if(!ts) throw new Error(j.Note || j.Information || 'Historical series unavailable for this symbol.');
  return Object.entries(ts).map(([date,v])=>({date,open:Number(v['1. open']),high:Number(v['2. high']),low:Number(v['3. low']),close:Number(v['4. close']),volume:Number(v['5. volume'])})).filter(x=>Number.isFinite(x.close));
}

function extractGeminiText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || '').join('\n').trim();
}

async function geminiGenerate(parts, {json=false}={}) {
  if (!geminiKey) throw new Error('Gemini AI is not configured. Add GEMINI_API_KEY to .env.');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    system_instruction:{parts:[{text:analystInstructions}]},
    contents:[{role:'user',parts}],
    generationConfig: json ? {responseMimeType:'application/json'} : {}
  };
  const payload = await fetchJSON(url, {
    method:'POST',
    headers:{'Content-Type':'application/json','x-goog-api-key':geminiKey},
    body:JSON.stringify(body)
  });
  const text = extractGeminiText(payload);
  if (!text) throw new Error(payload?.promptFeedback?.blockReason || 'Gemini returned no usable response.');
  return text;
}

function basicAuth(req,res,next){
  if (!basicUser || !basicPass) return next();
  const raw = req.headers.authorization || '';
  const [kind, encoded] = raw.split(' ');
  if (kind === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    const user = i >= 0 ? decoded.slice(0,i) : decoded;
    const pass = i >= 0 ? decoded.slice(i+1) : '';
    const userOk = user.length === basicUser.length && crypto.timingSafeEqual(Buffer.from(user), Buffer.from(basicUser));
    const passOk = pass.length === basicPass.length && crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(basicPass));
    if (userOk && passOk) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="FinSight"');
  return res.status(401).send('Authentication required.');
}

app.get('/healthz',(req,res)=>res.status(200).send('ok'));

app.use(basicAuth);
app.use(express.json({ limit: '4mb' }));
app.use(express.static(__dirname));

const analystInstructions = `You are FinSight AI, an evidence-first equity research copilot for educational investor due diligence.
Separate reported facts, calculations, management claims, and your interpretations. Never invent financial values, citations, page numbers, live prices, market shares, or management statements. If evidence is missing, say so. Treat forensic signals as investigation prompts, not accusations. Do not issue personalized buy/sell instructions. You may assess business quality, risks, and valuation as Attractive/Fair/Premium/Expensive only when supplied data supports it. Be concise but analytical.`;

const analysisSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    company: {type:'string'}, overall_view:{type:'string'}, confidence:{type:'string', enum:['High','Medium','Low']},
    good:{type:'array',items:{$ref:'#/$defs/finding'}}, bad:{type:'array',items:{$ref:'#/$defs/finding'}}, watch:{type:'array',items:{$ref:'#/$defs/finding'}},
    red_flags:{type:'array',items:{$ref:'#/$defs/finding'}}, growth_drivers:{type:'array',items:{$ref:'#/$defs/finding'}},
    management_assessment:{type:'string'}, governance_assessment:{type:'string'}, auditor_assessment:{type:'string'}, cash_quality_assessment:{type:'string'},
    investor_questions:{type:'array',items:{type:'string'}}, missing_information:{type:'array',items:{type:'string'}}
  },
  required:['company','overall_view','confidence','good','bad','watch','red_flags','growth_drivers','management_assessment','governance_assessment','auditor_assessment','cash_quality_assessment','investor_questions','missing_information'],
  $defs:{finding:{type:'object',additionalProperties:false,properties:{title:{type:'string'},explanation:{type:'string'},evidence:{type:'array',items:{type:'string'}},priority:{type:'string',enum:['High','Medium','Low']}},required:['title','explanation','evidence','priority']}}
};

function requireAI(res){ if(!geminiKey){res.status(503).json({error:'AI is not configured. Copy .env.example to .env and add GEMINI_API_KEY.'}); return false;} return true; }
function safeJSON(text){ try{return JSON.parse(text)}catch{return null} }

app.get('/api/health', async (req,res)=>{
  let databaseReady=false;
  if(databaseEnabled){ try{ await dbQuery('SELECT 1'); databaseReady=true; }catch{} }
  res.json({ok:true, aiConfigured:Boolean(geminiKey), model, marketProvider, marketConfigured:Boolean(alphaKey), historyConfigured:Boolean(alphaKey), databaseConfigured:databaseEnabled, databaseReady, protected:Boolean(basicUser&&basicPass)});
});

app.post('/api/ai/analyze-report', upload.single('report'), async (req,res)=>{
  try {
    if(!requireAI(res)) return;
    if(!req.file) return res.status(400).json({error:'Upload an annual-report PDF.'});
    if(req.file.mimetype !== 'application/pdf' && !req.file.originalname.toLowerCase().endsWith('.pdf')) return res.status(400).json({error:'Annual-report AI currently accepts PDF files.'});
    const metrics = req.body.metrics ? safeJSON(req.body.metrics) : null;
    const prompt = `Analyze the attached annual report as an investor due-diligence document. Find business model, segments, financial trajectory, cash quality, debt, working capital, management strategy/guidance, risks, auditor/key audit matters, contingent liabilities, related parties, governance, capital allocation and growth plans. Use page references only when visible/reliable. Here are deterministic FinSight metrics if available; treat them as CALCULATED evidence, not report quotes:\n${JSON.stringify(metrics || {}, null, 2)}`;
    const text = await geminiGenerate([{text: prompt + `\n\nReturn ONLY valid JSON with these top-level keys: company, overall_view, confidence, good, bad, watch, red_flags, growth_drivers, management_assessment, governance_assessment, auditor_assessment, cash_quality_assessment, investor_questions, missing_information. Each finding in good/bad/watch/red_flags/growth_drivers must contain title, explanation, evidence (array), priority (High/Medium/Low).`}, {inlineData:{mimeType:'application/pdf',data:req.file.buffer.toString('base64')}}], {json:true});
    const parsed = safeJSON(text);
    if(!parsed) throw new Error('The AI returned an unreadable structured response.');
    let persisted = null;
    if (databaseEnabled) {
      try {
        const company = await upsertCompany({name:parsed.company || req.body.company || 'Unknown company',ticker:req.body.ticker || null,exchange:req.body.exchange || 'NSE'});
        const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
        const q = await dbQuery(`INSERT INTO reports(company_id,filename,report_year,metrics,analysis,source_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,created_at`, [company.id,req.file.originalname,req.body.reportYear ? Number(req.body.reportYear) : null,metrics || {},parsed,hash]);
        persisted = {companyId:company.id,reportId:q.rows[0].id,createdAt:q.rows[0].created_at};
      } catch (e) { console.error('Persistence warning:', e.message); }
    }
    res.json({analysis:parsed, model, persisted});
  } catch(err){ console.error(err); res.status(500).json({error:err.message || 'AI analysis failed.'}); }
});

app.post('/api/ai/compare', upload.fields([{name:'companyA',maxCount:1},{name:'companyB',maxCount:1}]), async (req,res)=>{
  try {
    if(!requireAI(res)) return;
    const a=req.files?.companyA?.[0], b=req.files?.companyB?.[0];
    if(!a||!b) return res.status(400).json({error:'Upload both company annual reports.'});
    const prompt=`Compare these two annual reports for an investor. Normalize differences in reporting terminology and periods where possible. Compare business model, growth, profitability, ROCE/ROE, cash conversion, leverage, working capital, segments, management execution, governance, auditor issues, capital allocation, risks and disclosed competitive strengths. Explicitly state when a comparison is not like-for-like. Do not choose a stock solely from the reports; explain trade-offs and what an investor must investigate.`;
    const text=await geminiGenerate([{text:prompt},{inlineData:{mimeType:'application/pdf',data:a.buffer.toString('base64')}},{inlineData:{mimeType:'application/pdf',data:b.buffer.toString('base64')}}]);
    res.json({comparison:text,model});
  } catch(err){console.error(err);res.status(500).json({error:err.message||'Comparison failed.'})}
});

app.post('/api/ai/ask', async (req,res)=>{
  try {
    if(!requireAI(res)) return;
    const {question, context, priorAnalysis} = req.body || {};
    if(!question?.trim()) return res.status(400).json({error:'Question is required.'});
    const text=await geminiGenerate([{text:`Investor question: ${question}\n\nFinSight calculated/context data:\n${JSON.stringify(context||{},null,2)}\n\nPrior annual-report AI analysis:\n${JSON.stringify(priorAnalysis||{},null,2)}\n\nAnswer only from supplied evidence. Clearly say when the uploaded evidence cannot answer the question.`}]);
    res.json({answer:text,model});
  } catch(err){console.error(err);res.status(500).json({error:err.message||'Question failed.'})}
});

app.get('/api/market/:ticker', async (req,res)=>{
  try { res.json(await getMarketQuote({ticker:req.params.ticker,exchange:req.query.exchange||'NSE'})); }
  catch(err){ res.status(503).json({error:err.message,ticker:req.params.ticker,provider:marketProvider}); }
});

app.get('/api/market/:ticker/history', async (req,res)=>{
  try { const rows=await getMarketHistory({ticker:req.params.ticker,exchange:req.query.exchange||'NSE'}); res.json({ticker:req.params.ticker.toUpperCase(),exchange:(req.query.exchange||'NSE').toUpperCase(),provider:'Alpha Vantage',rows}); }
  catch(err){ res.status(503).json({error:err.message}); }
});

app.post('/api/ai/valuation', async (req,res)=>{
  try {
    if(!requireAI(res)) return;
    const {company, market, fundamentals, valuation} = req.body || {};
    const text=await geminiGenerate([{text:`Assess valuation for educational investor research. Do not invent missing values. Distinguish company quality from valuation. Use labels Attractive, Fair, Premium, or Expensive only if supplied evidence supports them. Explain what assumptions could make the conclusion wrong.\nCompany: ${company||'Unknown'}\nMarket data: ${JSON.stringify(market||{},null,2)}\nFundamentals: ${JSON.stringify(fundamentals||{},null,2)}\nCalculated valuation scenarios/peer or historical inputs: ${JSON.stringify(valuation||{},null,2)}`}]);
    res.json({assessment:text,model});
  } catch(err){console.error(err);res.status(500).json({error:err.message||'Valuation analysis failed.'})}
});


app.post('/api/valuation/dcf', (req,res)=>{
  try { res.json(runDCF(req.body || {})); }
  catch(err){ res.status(400).json({error:err.message}); }
});

app.post('/api/valuation/reverse-dcf', (req,res)=>{
  try { res.json(reverseDCF(req.body || {})); }
  catch(err){ res.status(400).json({error:err.message}); }
});

app.post('/api/research/save', async (req,res)=>{
  try {
    if(!databaseEnabled) return res.status(503).json({error:'Database is not configured. Add DATABASE_URL.'});
    const {company,ticker,exchange='NSE',sector,filename='manual research',reportYear,metrics={},analysis={}}=req.body||{};
    const c=await upsertCompany({name:company||ticker||'Unknown company',ticker,exchange,sector});
    const q=await dbQuery(`INSERT INTO reports(company_id,filename,report_year,metrics,analysis) VALUES($1,$2,$3,$4,$5) RETURNING *`,[c.id,filename,reportYear||null,metrics,analysis]);
    res.json({company:c,report:q.rows[0]});
  }catch(err){res.status(500).json({error:err.message});}
});

app.get('/api/research/:ticker', async (req,res)=>{
  try {
    if(!databaseEnabled) return res.status(503).json({error:'Database is not configured.'});
    const exchange=(req.query.exchange||'NSE').toUpperCase();
    const cq=await dbQuery(`SELECT * FROM companies WHERE ticker=$1 AND exchange=$2 LIMIT 1`,[req.params.ticker.toUpperCase(),exchange]);
    if(!cq.rows[0]) return res.status(404).json({error:'Company not found in FinSight research memory.'});
    const c=cq.rows[0];
    const [reports,theses,valuations,promises,events]=await Promise.all([
      dbQuery(`SELECT * FROM reports WHERE company_id=$1 ORDER BY created_at DESC LIMIT 20`,[c.id]),
      dbQuery(`SELECT * FROM research_theses WHERE company_id=$1 ORDER BY updated_at DESC LIMIT 10`,[c.id]),
      dbQuery(`SELECT * FROM valuation_snapshots WHERE company_id=$1 ORDER BY created_at DESC LIMIT 20`,[c.id]),
      dbQuery(`SELECT * FROM management_promises WHERE company_id=$1 ORDER BY updated_at DESC LIMIT 50`,[c.id]),
      dbQuery(`SELECT * FROM monitoring_events WHERE company_id=$1 ORDER BY created_at DESC LIMIT 100`,[c.id])
    ]);
    res.json({company:c,reports:reports.rows,theses:theses.rows,valuations:valuations.rows,promises:promises.rows,events:events.rows});
  }catch(err){res.status(500).json({error:err.message});}
});

app.post('/api/thesis', async (req,res)=>{
  try {
    if(!databaseEnabled) return res.status(503).json({error:'Database is not configured.'});
    const {company,ticker,exchange='NSE',thesis,bullCase,bearCase,thesisBreakers=[]}=req.body||{};
    if(!thesis?.trim()) return res.status(400).json({error:'thesis is required.'});
    const c=await upsertCompany({name:company||ticker||'Unknown company',ticker,exchange});
    const q=await dbQuery(`INSERT INTO research_theses(company_id,thesis,bull_case,bear_case,thesis_breakers) VALUES($1,$2,$3,$4,$5) RETURNING *`,[c.id,thesis,bullCase||null,bearCase||null,thesisBreakers]);
    res.json({company:c,thesis:q.rows[0]});
  }catch(err){res.status(500).json({error:err.message});}
});

app.post('/api/management-promises', async (req,res)=>{
  try {
    if(!databaseEnabled) return res.status(503).json({error:'Database is not configured.'});
    const {company,ticker,exchange='NSE',promise,targetDate,status='open',evidence=[]}=req.body||{};
    if(!promise?.trim()) return res.status(400).json({error:'promise is required.'});
    const c=await upsertCompany({name:company||ticker||'Unknown company',ticker,exchange});
    const q=await dbQuery(`INSERT INTO management_promises(company_id,promise,target_date,status,evidence) VALUES($1,$2,$3,$4,$5) RETURNING *`,[c.id,promise,targetDate||null,status,evidence]);
    res.json({company:c,promise:q.rows[0]});
  }catch(err){res.status(500).json({error:err.message});}
});

app.post('/api/valuation/snapshot', async (req,res)=>{
  try {
    if(!databaseEnabled) return res.status(503).json({error:'Database is not configured.'});
    const {company,ticker,exchange='NSE',market={},fundamentals={},valuation={},aiAssessment=null}=req.body||{};
    const c=await upsertCompany({name:company||ticker||'Unknown company',ticker,exchange});
    const q=await dbQuery(`INSERT INTO valuation_snapshots(company_id,market,fundamentals,valuation,ai_assessment) VALUES($1,$2,$3,$4,$5) RETURNING *`,[c.id,market,fundamentals,valuation,aiAssessment]);
    res.json({company:c,snapshot:q.rows[0]});
  }catch(err){res.status(500).json({error:err.message});}
});

function compareRule(actual,operator,target){
  if(!Number.isFinite(Number(actual))||!Number.isFinite(Number(target))) return false;
  const a=Number(actual),t=Number(target);
  return operator==='<'?a<t:operator==='<='?a<=t:operator==='>'?a>t:operator==='>='?a>=t:operator==='=='?a===t:false;
}
app.post('/api/monitor/evaluate', async (req,res)=>{
  try {
    const {company,ticker,exchange='NSE',metrics={},rules=[]}=req.body||{};
    const breaches=[];
    for(const rule of rules){
      if(compareRule(metrics[rule.metric],rule.operator,rule.value)) breaches.push({...rule,actual:metrics[rule.metric]});
    }
    if(databaseEnabled && breaches.length){
      const c=await upsertCompany({name:company||ticker||'Unknown company',ticker,exchange});
      for(const b of breaches) await dbQuery(`INSERT INTO monitoring_events(company_id,event_type,title,severity,payload) VALUES($1,'thesis_breaker',$2,$3,$4)`,[c.id,b.title||`${b.metric} ${b.operator} ${b.value}`,b.severity||'warning',b]);
    }
    res.json({breaches,count:breaches.length,persisted:databaseEnabled});
  }catch(err){res.status(500).json({error:err.message});}
});

async function boot(){
  try{ if(databaseEnabled) await initDatabase(); }catch(err){ console.error('Database initialization failed:',err.message); }
  app.listen(port,'0.0.0.0',()=>console.log(`FinSight AI running on port ${port}`));
}
boot();
