// Portable offline presentation. All numbers come from report.json; external scripts are unnecessary.
import { writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { jsonOf, bytesOf } from '../evidence-store.mjs';
import { buildWindgramView } from '@windgrams/windgram/scene';
import { renderWindgramSvg } from '@windgrams/windgram/svg';
const serialized = (value) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

export async function writeReviewHtml(report, { snapshot, output }) {
  const root = resolve(snapshot),
    destination = resolve(output ?? join(root, 'report'));
  await mkdir(join(destination, 'assets'), { recursive: true });
  const charts = [];
  for (const fixed of report.fixedCases) {
    const wx = fixed.images.find((e) => e.status === 200);
    if (!wx) continue;
    await bytesOf(root, wx);
    await copyFile(join(root, wx.file), join(destination, 'assets', `${wx.sha256}.png`));
    const row =
      report.rows.find((r) => r.site === fixed.site && r.model === 'rrfs') ??
      report.rows.find((r) => r.site === fixed.site);
    const evidence = row && report.evidence.find((e) => e.sha256 === row.evidence.ours);
    let svgPath = null;
    if (evidence) {
      const p = await jsonOf(root, evidence);
      const view = buildWindgramView(p, {
        unitSystem: 'imperial',
        timeZone: p.site.timeZone,
        widthPx: 800,
        launch: { elevationM: p.soaringMeta?.launchElevationM ?? p.site.modelElevationM },
        hours: { dateKey: row.localDate, timeZone: p.site.timeZone },
      });
      svgPath = `assets/${fixed.site}-${row.model}.svg`;
      await writeFile(join(destination, svgPath), renderWindgramSvg(view, { idPrefix: fixed.site }));
    }
    charts.push({
      site: fixed.site,
      wxPath: `assets/${wx.sha256}.png`,
      svgPath,
      model: row?.model,
      referenceTime: row?.referenceTime,
      date: fixed.wxDate,
      note: 'WxToFly image versus retained issued forecast rendered by current checkout. Different model grids and initialization; these are not the latest-live same-day forecasts. Both charts label MSL heights, but altitude ranges and displayed hours differ. Our W* row uses ft/min; WxToFly uses m/s (1 m/s = 196.85 ft/min).',
    });
  }
  const data = {
    capturedAt: report.capturedAt,
    snapshotSha256: report.snapshotSha256,
    rows: report.rows,
    summary: report.summary,
    fields: report.fields,
    coverage: report.coverage,
    freshness: report.freshness,
    findings: report.findings,
    cases: report.cases,
    familyCoverage: report.familyCoverage,
    strictSameRun: report.strictSameRun,
    limitations: report.limitations,
    archive: report.archiveCoverage,
    observations: { summary: report.observations.summary, byCohort: report.observations.byCohort },
    method: report.methodAuditSummary,
    render: report.rendererAudit,
    browser: report.browserAudit,
    regional: report.regionalAudit,
    inspection: report.inspection,
    grid: report.gridMetadata,
    matches: report.siteMatches,
    charts,
    evidence: report.evidence,
    inventoryReassessment: report.inventoryReassessment,
    evidenceRoot: relative(destination, root).replaceAll('\\', '/') || '.',
  };
  await writeFile(join(destination, 'index.html'), html(data));
  return join(destination, 'index.html');
}

function html(data) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Windgrams · Scientific review</title>
<style>
:root{color-scheme:light dark;--bg:#fbfcfd;--text:#17242f;--muted:#536370;--line:#cbd3da;--accent:#165b86;--other:#a84b19;--panel:#edf3f6} @media(prefers-color-scheme:dark){:root{--bg:#141a20;--text:#e2eaf0;--muted:#a5b4c2;--line:#3f4d59;--accent:#80bde2;--other:#f4af81;--panel:#202b34}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 system-ui,sans-serif}main{max-width:1320px;margin:auto;padding:32px 24px 80px}h1{font-size:28px;margin:8px 0}h2{font-size:21px;margin:32px 0 12px}h3{font-size:17px}p{max-width:95ch}small,.muted{color:var(--muted)}.notice{padding:16px 20px;background:var(--panel);border-left:4px solid var(--accent)}.metrics{display:flex;gap:36px;flex-wrap:wrap;margin:24px 0}.metrics strong{display:block;font-size:24px}.toolbar{display:flex;flex-wrap:wrap;gap:14px;align-items:end}label{display:flex;flex-direction:column;gap:4px}select,input,button{padding:7px 10px;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:3px;font:inherit}button{cursor:pointer}.table{overflow:auto;max-height:520px;border-block:1px solid var(--line);margin:12px 0}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:top}th{position:sticky;top:0;background:var(--panel)}td.wrap{white-space:normal;min-width:220px;max-width:650px}a{color:var(--accent)}details{padding:12px 0;border-bottom:1px solid var(--line)}summary{cursor:pointer;font-weight:600}.chart{width:100%;height:auto;max-height:320px}.paired{display:grid;grid-template-columns:1fr 1fr;gap:16px}.paired img{width:100%;height:auto}.science{max-width:105ch}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}nav{display:flex;gap:18px;flex-wrap:wrap;margin:16px 0}svg text{fill:var(--muted);font:12px system-ui}footer{margin-top:40px;color:var(--muted)}@media(max-width:700px){main{padding:20px 12px}.paired{grid-template-columns:1fr}h1{font-size:24px}}
</style><main><small>FROZEN PUBLICATION REVIEW · <span id="capture"></span></small><h1>Windgrams against WxToFly</h1><p class="notice" id="notice"></p><nav><a href="#comparisons">Differences</a><a href="#cases">Cases & charts</a><a href="#coverage">Coverage</a><a href="#science">Scientific definitions</a><a href="#findings">Recommendations</a><a href="#validation">Validation</a><a href="report.json">Full JSON</a></nav><div class="metrics" id="metrics"></div>
<section id="comparisons"><h2>Exact-time numerical comparisons</h2><p>Differences are Windgrams minus WxToFly in SI units. These measure forecast disagreement, not error against observations. Vector difference is a nonnegative distance; directional differences use the shortest angular path and exclude winds ≤1 m/s.</p><div class="toolbar"><label>Field<select id="field"></select></label><label>Location<select id="site"></select></label><label>Our model<select id="model"></select></label><label>Cohort<select id="cohort"></select></label></div><p id="stats"></p><div id="plot"></div><div class="table"><table><thead><tr><th>Location</th><th>Model</th><th>Valid UTC</th><th>Our run / lead</th><th>Ours</th><th>WxToFly</th><th>Difference</th><th>Evidence</th></tr></thead><tbody id="rows"></tbody></table></div><p id="rowlimit" class="muted"></p></section>
<section id="cases"><h2>Fixed cases and largest differences</h2><p>Blanchard, Tiger and Rampart are retained alongside every field/region maximum. Expand a case for source weather, diagnostic inputs, terrain decomposition and the precise unresolved question.</p><div class="toolbar"><label>Matched charts<select id="chartsite"></select></label></div><p id="chartcaption"></p><div id="paired" class="paired"></div><div id="case-list"></div></section>
<section id="coverage"><h2>Coverage, freshness and retained history</h2><div id="freshness"></div><p id="history"></p><label>Filter product, place, status or parameter<input id="coveragefilter" type="search" placeholder="e.g. sounding, unavailable, wa-blanchard"></label><div id="coverage-table" class="table"></div><p id="coverage-count"></p><details><summary>Location identity decisions</summary><div id="matches" class="table"></div></details></section>
<section id="science"><h2>Scientific comparability</h2><details><summary>Strict same-run eligibility and exclusions</summary><pre id="strict-runs"></pre></details><div id="families" class="table"></div><details><summary>Normalized field definitions, original units and exclusions</summary><pre id="definitions"></pre></details><details><summary>Reassessment of the existing provider inventory</summary><pre id="inventory"></pre></details><details><summary>Model grids and capabilities</summary><pre id="grids"></pre></details><div id="limitations"></div></section>
<section id="findings"><h2>Ranked recommendations</h2><div id="recommendations"></div></section>
<section id="validation"><h2>Independent checks and observation limits</h2><p id="checks"></p><details><summary>Observation counts and match tiers</summary><pre id="observations"></pre></details><details><summary>Deployed browser readouts and visual inspection</summary><pre id="inspection"></pre></details><details><summary>Evidence manifest</summary><pre id="evidence"></pre></details></section><footer>Inputs are content addressed with SHA-256. The offline comparison does not change forecast values or deployments. Snapshot <code id="hash"></code>.</footer></main>
<script id="data" type="application/json">${serialized(data)}</script><script>
'use strict';const D=JSON.parse(document.getElementById('data').textContent),$=id=>document.getElementById(id),fmt=v=>typeof v==='number'?v.toLocaleString('en-US',{maximumFractionDigits:3}):v??'unknown',esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),options=(id,values)=>{const e=$(id);for(const [value,label] of values){const o=document.createElement('option');o.value=value;o.textContent=label;e.append(o);}},table=(headers,rows)=>'<table><thead><tr>'+headers.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+r.map(v=>'<td class="wrap">'+esc(v)+'</td>').join('')+'</tr>').join('')+'</tbody></table>',json=(id,v)=>$(id).textContent=JSON.stringify(v,null,2);
$('capture').textContent=D.capturedAt;$('hash').textContent=D.snapshotSha256;const latest=D.rows.filter(r=>r.cohort==='latest-live').length,days=new Set(D.rows.map(r=>r.localDate)),sites=new Set(D.rows.map(r=>r.site));$('notice').textContent=latest?latest+' latest-live pairs and '+(D.rows.length-latest)+' retained-issued pairs are separated below. Latest GDPS/GEPS overlap the end of WxToFly’s prior local day. WxToFly initialization is unknown where ForecastPd is blank.':'The latest live runs have no scored exact-time overlap with WxToFly. Numerical results below use retained issued forecasts, predominantly against the October 24 WxToFly publication. Unknown WxToFly initialization prevents equal-lead comparisons.';
$('metrics').innerHTML=[[D.matches.filter(m=>m.status==='matched').length,'verified shared launches'],[D.rows.length,'numeric field/time pairs'],[days.size,'WxToFly dates scored'],[D.method.failures,'reference-check failures']].map(([v,l])=>'<div><strong>'+fmt(v)+'</strong>'+esc(l)+'</div>').join('');
options('field',[...new Map(D.rows.map(r=>[r.field,r.label+' · '+r.unit])).entries()]);options('site',[['','All locations'],...[...new Map(D.rows.map(r=>[r.site,r.siteName])).entries()].sort((a,b)=>a[1].localeCompare(b[1]))]);options('model',[['','All models'],...[...new Set(D.rows.map(r=>r.model))].sort().map(v=>[v,v])]);options('cohort',[['','All cohorts'],...[...new Set(D.rows.map(r=>r.cohort))].map(v=>[v,v])]);
function draw(){const rows=D.rows.filter(r=>r.field===$('field').value&&(!$('site').value||r.site===$('site').value)&&(!$('model').value||r.model===$('model').value)&&(!$('cohort').value||r.cohort===$('cohort').value)),abs=rows.map(r=>Math.abs(r.difference)).sort((a,b)=>a-b),mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null,q=p=>{const x=(abs.length-1)*p,i=Math.floor(x);return abs.length?abs[i]+(abs[Math.ceil(x)]-abs[i])*(x-i):null;},unit=rows[0]?.unit??'';
$('stats').textContent=rows.length+' pairs · mean difference '+fmt(mean(rows.map(r=>r.difference)))+' '+unit+' · mean absolute '+fmt(mean(abs))+' · median absolute '+fmt(q(.5))+' · p95 absolute '+fmt(q(.95))+'. Counts include correlated forecast hours, not independent observations.';
const ev=(hash)=>{const a=D.evidence.find(e=>e.sha256===hash);return a?'<a href="'+esc(D.evidenceRoot+'/'+a.file)+'" title="'+esc(a.url)+'">'+hash.slice(0,10)+'</a>':'unavailable';};
$('rows').innerHTML=rows.slice(0,500).map(r=>'<tr><td>'+esc(r.siteName)+'</td><td>'+esc(r.model)+'</td><td>'+esc(r.validAt)+'</td><td>'+esc(r.referenceTime)+' / '+fmt(r.leadHours)+' h</td><td>'+fmt(r.ours)+'</td><td>'+fmt(r.wx)+'</td><td>'+fmt(r.difference)+'</td><td>'+ev(r.evidence.ours)+' / '+ev(r.evidence.wx)+'</td></tr>').join('');$('rowlimit').textContent=rows.length>500?'Showing first 500 rows. Full results are in report.json.':'All filtered rows shown. WxToFly initialization remains unknown unless explicitly present in the source.';
const subset=rows.filter(r=>r.site===rows[0]?.site&&r.model===rows[0]?.model&&r.referenceTime===rows[0]?.referenceTime).sort((a,b)=>a.validAt.localeCompare(b.validAt));if(!subset.length){$('plot').innerHTML='';return;}const values=subset.flatMap(r=>[r.ours,r.wx]),low=Math.min(...values),high=Math.max(...values),pad=Math.max(.01,(high-low)*.12),lo=low-pad,hi=high+pad,x=i=>60+i*800/Math.max(1,subset.length-1),y=v=>240-(v-lo)/(hi-lo)*190,line=k=>subset.map((r,i)=>x(i)+','+y(r[k])).join(' '),ticks=subset.map((r,i)=>i%Math.max(1,Math.ceil(subset.length/8))===0?'<text x="'+x(i)+'" y="262" text-anchor="middle">'+esc(r.validAt.slice(11,16))+'</text>':'').join('');
$('plot').innerHTML='<h3>'+esc(subset[0].label)+' · '+esc(subset[0].siteName)+' · '+esc(subset[0].model)+'</h3><p class="muted">X: valid time (UTC, '+esc(subset[0].localDate)+' local date). Y: '+esc(unit)+'. Legend: blue = Windgrams; orange = WxToFly. Source: frozen numeric arrays/tables. '+(subset[0].vectorComponents?'Lines show speeds; table differences are vector distances.':'')+'</p><svg class="chart" viewBox="0 0 920 280" role="img" aria-label="Matched valid-time series"><path d="M60 30V240H870" fill="none" stroke="var(--line)"/><text x="8" y="48">'+fmt(hi)+'</text><text x="8" y="240">'+fmt(lo)+'</text><polyline points="'+line('ours')+'" fill="none" stroke="var(--accent)" stroke-width="2"/><polyline points="'+line('wx')+'" fill="none" stroke="var(--other)" stroke-width="2"/>'+ticks+'</svg>';}
for(const id of ['field','site','model','cohort'])$(id).addEventListener('change',draw);if(D.rows.some(r=>r.site==='wa-blanchard'&&r.model==='rrfs'&&r.cohort==='retained-issued-archive')){$('site').value='wa-blanchard';$('model').value='rrfs';$('cohort').value='retained-issued-archive';}draw();
options('chartsite',D.charts.map(c=>[c.site,c.site]));function charts(){const c=D.charts.find(c=>c.site===$('chartsite').value);if(!c)return;$('chartcaption').textContent=c.note+' Valid local date '+c.date+'; our '+c.model+' run '+c.referenceTime+'.';$('paired').innerHTML='<figure><figcaption>Windgrams · retained forecast, current renderer</figcaption>'+(c.svgPath?'<img alt="Retained Windgrams forecast" src="'+esc(c.svgPath)+'">':'')+'</figure><figure><figcaption>WxToFly · original published image</figcaption><img alt="Frozen WxToFly windgram" src="'+esc(c.wxPath)+'"></figure>';}$('chartsite').addEventListener('change',charts);charts();
$('case-list').innerHTML=D.cases.map((c,i)=>'<details><summary>'+esc(c.row.siteName+' · '+c.row.label+' · '+c.row.model)+' · Δ '+fmt(c.row.difference)+' '+esc(c.row.unit)+'</summary><p>'+esc(c.explanation)+'</p><p>'+esc(c.unresolvedQuestion)+'</p><pre>'+esc(JSON.stringify(c,null,2))+'</pre></details>').join('');
$('freshness').innerHTML=table(['Live model','Initialization UTC','Run age (h)','Last valid UTC','Refresh status'],D.freshness.map(f=>[f.model,f.referenceTime,fmt(f.runAgeHours),f.lastValidAt,f.assessment.status]));$('history').textContent='Requested archive window: '+D.archive.from+' through '+D.archive.to+'. Retained '+D.archive.runs.length+' runs; numerical overlap covers '+days.size+' WxToFly date(s) and '+sites.size+' locations. This cannot establish recurring forecast skill.';
function coverage(){const q=$('coveragefilter').value.toLowerCase(),r=D.coverage.filter(c=>JSON.stringify(c).toLowerCase().includes(q));$('coverage-table').innerHTML=table(['Product','Location / region','Model / grid','Status','Detail'],r.slice(0,500).map(c=>[c.product,c.site??c.wxId??c.region??'',c.model??c.grid??'',c.status,c.reason??c.parameter??c.date??'']));$('coverage-count').textContent=r.length+' matching coverage records; '+Math.min(r.length,500)+' shown. Full coverage is in JSON.';}$('coveragefilter').addEventListener('input',coverage);coverage();
$('matches').innerHTML=table(['Site','Wx identity','Decision','Separation km','Reason'],D.matches.map(m=>[m.site.name,m.wxId,m.status,fmt(m.distanceKm),m.reason]));$('families').innerHTML=table(['Quantity family','Status','Meaning / evidence limit'],D.familyCoverage.map(f=>[f.family,f.status,f.reason]));json('strict-runs',D.strictSameRun);json('definitions',D.fields);json('inventory',D.inventoryReassessment);json('grids',D.grid);$('limitations').innerHTML='<ul>'+D.limitations.map(l=>'<li>'+esc(l)+'</li>').join('')+'</ul>';
$('recommendations').innerHTML=D.findings.map(f=>'<article><h3>'+esc(f.priority+' · '+f.title)+'</h3><p>'+esc(f.recommendation)+'</p><details><summary>'+esc(f.category+' · confidence '+f.confidence)+'</summary><p>Affected: '+esc(f.affectedProducts.join(', '))+'</p><p>Validation: '+esc(f.validationNeeded)+'</p><pre>'+esc(JSON.stringify(f.evidence,null,2))+'</pre></details></article>').join('');
$('checks').textContent=D.method.checks+' independent equation/bounds checks ('+D.method.failures+' failures); '+D.regional.length+' native-cell audits; '+D.render.length+' renderer configurations; '+D.browser.length+' deployed-browser numeric readouts. These are consistency checks, not validation of meteorological accuracy.';json('observations',D.observations);json('inspection',{inspection:D.inspection,browser:D.browser});json('evidence',D.evidence);
</script></html>`;
}
