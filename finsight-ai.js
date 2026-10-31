let selectedAIReport=null, latestAIAnalysis=null;
const aiEl=id=>document.getElementById(id);
function currentContext(){try{const a=calc(primary);return {company:a.l.company,latestYear:a.l.year,latest:a.l,ratios:a.r,deterministicSignals:signals(a),pdfEvidence}}catch{return {}}}
function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function renderAIAnalysis(a){const group=(title,arr)=>`<div class="group-title">${title}</div>${(arr||[]).map(x=>`<div class="ai-finding"><b>${escapeHtml(x.title)}</b> · ${escapeHtml(x.priority)}<br>${escapeHtml(x.explanation)}<small>${escapeHtml((x.evidence||[]).join(' · ')||'Evidence not specified')}</small></div>`).join('')||'<div class="ai-finding">No supported finding.</div>'}`;return `<b>${escapeHtml(a.company)}</b><br>${escapeHtml(a.overall_view)}<br><small>Confidence: ${escapeHtml(a.confidence)}</small>${group('GOOD',a.good)}${group('BAD',a.bad)}${group('WATCH',a.watch)}${group('RED FLAGS / INVESTIGATE',a.red_flags)}${group('GROWTH DRIVERS',a.growth_drivers)}<div class="group-title">MANAGEMENT</div>${escapeHtml(a.management_assessment)}<div class="group-title">GOVERNANCE</div>${escapeHtml(a.governance_assessment)}<div class="group-title">AUDITOR</div>${escapeHtml(a.auditor_assessment)}<div class="group-title">CASH QUALITY</div>${escapeHtml(a.cash_quality_assessment)}<div class="group-title">QUESTIONS BEFORE INVESTING</div>${(a.investor_questions||[]).map(q=>`• ${escapeHtml(q)}`).join('<br>')}<div class="group-title">MISSING / NEEDS VERIFICATION</div>${(a.missing_information||[]).map(q=>`• ${escapeHtml(q)}`).join('<br>')}`}
async function health(){try{const r=await fetch('/api/health'),j=await r.json();aiEl('aiStatus').textContent=j.aiConfigured?`AI connected · ${j.model}`:'AI backend running · add GEMINI_API_KEY in .env';}catch{aiEl('aiStatus').textContent='AI backend not reachable · start with npm start';}}
aiEl('aiReportFile').onchange=e=>{selectedAIReport=e.target.files?.[0]||null;aiEl('aiReportResult').textContent=selectedAIReport?`${selectedAIReport.name} selected. Click Run AI analysis.`:'No file selected.'};
aiEl('runAIReport').onclick=async()=>{if(!selectedAIReport){aiEl('aiReportResult').textContent='Choose an annual-report PDF first.';return}const box=aiEl('aiReportResult');box.textContent='AI is reading the annual report and cross-checking it against FinSight metrics…';box.classList.add('loading');try{const fd=new FormData();fd.append('report',selectedAIReport);fd.append('metrics',JSON.stringify(currentContext()));const id=tickerIdentity();if(id.ticker){fd.append('ticker',id.ticker);fd.append('exchange',id.exchange);}const r=await fetch('/api/ai/analyze-report',{method:'POST',body:fd}),j=await r.json();if(!r.ok)throw Error(j.error||'AI analysis failed');latestAIAnalysis=j.analysis;box.innerHTML=renderAIAnalysis(j.analysis)}catch(e){box.textContent=e.message}finally{box.classList.remove('loading')}};
aiEl('askAI').onclick=async()=>{const q=aiEl('aiQuestion').value.trim(),box=aiEl('aiAnswer');if(!q){box.textContent='Enter a question first.';return}box.textContent='FinSight AI is reasoning from the available evidence…';try{const r=await fetch('/api/ai/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:q,context:currentContext(),priorAnalysis:latestAIAnalysis})}),j=await r.json();if(!r.ok)throw Error(j.error||'AI question failed');box.textContent=j.answer}catch(e){box.textContent=e.message}};
aiEl('runAICompare').onclick=async()=>{const a=aiEl('aiCompareA').files?.[0],b=aiEl('aiCompareB').files?.[0],box=aiEl('aiCompareResult');if(!a||!b){box.textContent='Choose both annual-report PDFs first.';return}box.textContent='AI is comparing both annual reports…';try{const fd=new FormData();fd.append('companyA',a);fd.append('companyB',b);const r=await fetch('/api/ai/compare',{method:'POST',body:fd}),j=await r.json();if(!r.ok)throw Error(j.error||'Comparison failed');box.textContent=j.comparison}catch(e){box.textContent=e.message}};
health();

let latestMarketData=null, latestValuationData=null;
const marketFetch=aiEl('fetchMarket');
if(marketFetch) marketFetch.onclick=async()=>{
  const ticker=(aiEl('tickerInput')?.value||'').trim().toUpperCase();
  const exchange=aiEl('exchangeInput')?.value||'NSE';
  if(!ticker){aiEl('priceDisplay').textContent='Enter ticker in Set market data';return;}
  aiEl('priceDisplay').textContent='Fetching last available price…';
  try{
    const r=await fetch(`/api/market/${encodeURIComponent(ticker)}?exchange=${encodeURIComponent(exchange)}`),j=await r.json();
    if(!r.ok) throw Error(j.error||'Price lookup failed');
    latestMarketData=j; aiEl('priceInput').value=j.price;
    const change=Number.isFinite(j.previousClose)&&j.previousClose?((j.price-j.previousClose)/j.previousClose)*100:null;
    aiEl('priceDisplay').textContent=`₹${Number(j.price).toLocaleString('en-IN',{maximumFractionDigits:2})}${change==null?'':` · ${change>=0?'+':''}${change.toFixed(2)}%`} · ${j.provider}`;
  }catch(e){aiEl('priceDisplay').textContent=`Price unavailable · ${e.message}`;}
};

const originalValueBtn=aiEl('valueBtn');
if(originalValueBtn) originalValueBtn.addEventListener('click',()=>{
  try{
    const a=calc(primary),price=Number(aiEl('priceInput').value),shares=Number(aiEl('sharesInput').value),selectedPe=Number(aiEl('peInput').value),peerPe=Number(aiEl('peerPeInput')?.value)||null,histPe=Number(aiEl('histPeInput')?.value)||null;
    if(!price||!shares||!selectedPe)return;
    const eps=a.l.net_income/shares,currentPe=price/eps,base=eps*selectedPe;
    const refs=[selectedPe,peerPe,histPe].filter(Number.isFinite); const referencePe=refs.reduce((x,y)=>x+y,0)/refs.length;
    const referenceValue=eps*referencePe, premium=(price-referenceValue)/referenceValue;
    const classification=premium<=-.15?'Attractive':premium<.10?'Fair':premium<.30?'Premium':'Expensive';
    latestValuationData={price,shares,eps,currentPe,selectedPe,peerPe,historicalMedianPe:histPe,referencePe,referenceValue,premium,classif:classification,bear:base*.8,base,bull:base*1.2};
    aiEl('valuationView').textContent=`${classification} · ${currentPe.toFixed(1)}× earnings`;
  }catch{}
});

const aiValueBtn=aiEl('aiValueBtn');
if(aiValueBtn) aiValueBtn.onclick=async()=>{
  const box=aiEl('aiValuation'); if(!latestValuationData){box.textContent='Run Evaluate price first.';return;}
  box.textContent='AI is separating business quality from price…';
  try{
    const c=currentContext();
    const r=await fetch('/api/ai/valuation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({company:c.company,market:latestMarketData||{price:latestValuationData.price,source:'manual'},fundamentals:c,valuation:latestValuationData})}),j=await r.json();
    if(!r.ok) throw Error(j.error||'Valuation interpretation failed'); box.textContent=j.assessment; const id=tickerIdentity(); if(id.ticker){fetch('/api/valuation/snapshot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({company:c.company,ticker:id.ticker,exchange:id.exchange,market:latestMarketData||{price:latestValuationData.price,source:'manual'},fundamentals:c,valuation:latestValuationData,aiAssessment:j.assessment})}).catch(()=>{});}
  }catch(e){box.textContent=e.message;}
};

function tickerIdentity(){return {ticker:(aiEl('tickerInput')?.value||'').trim().toUpperCase(),exchange:aiEl('exchangeInput')?.value||'NSE'};}
function dcfPayload(){
  const c=currentContext(), shares=Number(aiEl('sharesInput')?.value), price=Number(aiEl('priceInput')?.value);
  return {revenue:Number(c.latest?.revenue),ebitMargin:Number(aiEl('dcfMargin').value)/100,taxRate:.25,growthRate:Number(aiEl('dcfGrowth').value)/100,years:5,daPctRevenue:.03,capexPctRevenue:.05,nwcPctRevenue:.08,wacc:Number(aiEl('dcfWacc').value)/100,terminalGrowth:Number(aiEl('dcfTerminal').value)/100,netDebt:Number(aiEl('dcfNetDebt').value)||0,shares,marketPrice:price};
}
if(aiEl('runDcf')) aiEl('runDcf').onclick=async()=>{
  const box=aiEl('dcfResult'); box.textContent='Running deterministic DCF…';
  try{const p=dcfPayload();const r=await fetch('/api/valuation/dcf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)}),j=await r.json();if(!r.ok)throw Error(j.error||'DCF failed');box.textContent=`DCF value/share: ₹${Number(j.valuePerShare).toLocaleString('en-IN',{maximumFractionDigits:2})}\nEnterprise value: ${Number(j.enterpriseValue).toLocaleString('en-IN',{maximumFractionDigits:1})}\nEquity value: ${Number(j.equityValue).toLocaleString('en-IN',{maximumFractionDigits:1})}\n\nThis is assumption-driven, not a price target.`}catch(e){box.textContent=e.message}
};
if(aiEl('runReverseDcf')) aiEl('runReverseDcf').onclick=async()=>{
  const box=aiEl('dcfResult'); box.textContent='Solving the growth rate implied by the current price…';
  try{const p=dcfPayload();const r=await fetch('/api/valuation/reverse-dcf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)}),j=await r.json();if(!r.ok)throw Error(j.error||'Reverse DCF failed');box.textContent=`Current price implies about ${(j.impliedGrowthRate*100).toFixed(1)}% constant annual revenue growth over the forecast period under your margin, WACC and reinvestment assumptions.\nModel value/share: ₹${Number(j.modelValuePerShare).toLocaleString('en-IN',{maximumFractionDigits:2})}\n\nChange the assumptions to stress-test the market expectation.`}catch(e){box.textContent=e.message}
};
if(aiEl('saveThesis')) aiEl('saveThesis').onclick=async()=>{
  const box=aiEl('memoryResult'),id=tickerIdentity(),c=currentContext();
  if(!id.ticker){box.textContent='Set a ticker first using Set market data.';return}
  try{const r=await fetch('/api/thesis',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({company:c.company,ticker:id.ticker,exchange:id.exchange,thesis:aiEl('thesisText').value,bullCase:aiEl('bullCase').value,bearCase:aiEl('bearCase').value})}),j=await r.json();if(!r.ok)throw Error(j.error||'Save failed');box.textContent=`Saved thesis for ${j.company.ticker}. Research memory is now persistent.`}catch(e){box.textContent=e.message}
};
if(aiEl('loadMemory')) aiEl('loadMemory').onclick=async()=>{
  const box=aiEl('memoryResult'),id=tickerIdentity();
  if(!id.ticker){box.textContent='Set a ticker first using Set market data.';return}
  try{const r=await fetch(`/api/research/${encodeURIComponent(id.ticker)}?exchange=${encodeURIComponent(id.exchange)}`),j=await r.json();if(!r.ok)throw Error(j.error||'Load failed');const t=j.theses?.[0];if(t){aiEl('thesisText').value=t.thesis||'';aiEl('bullCase').value=t.bull_case||'';aiEl('bearCase').value=t.bear_case||'';}box.textContent=`Loaded ${j.reports.length} report analyses, ${j.theses.length} thesis versions, ${j.valuations.length} valuation snapshots, ${j.promises.length} management promises and ${j.events.length} monitoring events.`}catch(e){box.textContent=e.message}
};
