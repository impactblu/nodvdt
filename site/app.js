'use strict';
const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths={catalog:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',documents:'M14 2H5v20h14V7z M14 2v6h5 M8 12h8 M8 16h8',search:'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',review:'M9 3H5v18h14V3h-4 M9 2h6v4H9z M8 13l3 3 5-6',sources:'M3 7h18v5H3z M3 16h18v5H3z M6 9.5h1 M6 18.5h1 M7 3h10',history:'M3 11a9 9 0 1 1 2 7 M3 4v7h7 M12 7v5l3 2',plus:'M12 5v14 M5 12h14',arrow:'M5 12h14 M13 6l6 6-6 6',back:'M19 12H5 M11 6l-6 6 6 6',download:'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5',close:'M6 6l12 12 M18 6L6 18',check:'M4 12l5 5L20 6',refresh:'M3 11a9 9 0 0 1 16-6 M21 13a9 9 0 0 1-16 6 M19 1v5h-5 M5 23v-5h5',upload:'M12 17V3 M7 8l5-5 5 5 M4 16v5h16v-5',compare:'M8 3v18 M16 3v18 M3 8h10 M11 16h10',external:'M14 3h7v7 M21 3l-9 9 M10 3H3v18h18v-7'};
const icon=n=>`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[n]||paths.documents}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const date=v=>v?new Date(v).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):'Not checked';
const datetime=v=>v?new Date(v).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'Not checked';
const bytes=v=>v<1024*1024?`${Math.round(v/1024)} KB`:`${(v/1024/1024).toFixed(1)} MB`;
const initials=v=>String(v).split(/[\s-]+/).map(w=>w[0]).join('').slice(0,2).toUpperCase();
const pill=(s,kind='')=>`<span class="pill ${kind}">${esc(s)}</span>`;
const btn=(text,action,ico='',attrs='',kind='')=>`<button class="btn ${kind}" data-action="${action}" ${attrs}>${ico?icon(ico):''}${esc(text)}</button>`;
const empty=(title,text,action='')=>`<div class="empty">${icon('documents')}<h2>${esc(title)}</h2><p>${esc(text)}</p>${action}</div>`;
const option=(value,label,selected)=>`<option value="${esc(value)}" ${String(value)===String(selected)?'selected':''}>${esc(label)}</option>`;
const field=(label,name,control,help='',full=false)=>`<div class="field ${full?'full':''}"><label for="${name}">${esc(label)}</label>${control}${help?`<span class="help">${esc(help)}</span>`:''}</div>`;
const input=(name,value='',attrs='')=>`<input id="${name}" name="${name}" value="${esc(value)}" ${attrs}>`;
const select=(name,options,attrs='')=>`<select id="${name}" name="${name}" ${attrs}>${options}</select>`;
const area=(name,value='',attrs='')=>`<textarea id="${name}" name="${name}" ${attrs}>${esc(value)}</textarea>`;
const makeState=()=>({boot:null,selected:new Set(),rows:[],sources:[],candidates:[],query:'',supplier:'',reviewed:false,minKva:'',dcMax:'',docOffset:0,reviewOffset:0,historyOffset:0,searchOffset:0,docRevision:null,docPage:1,docTab:'text',documentId:null,doc:null,specContext:null});
const state=makeState();
const client=new PCSClient.Client();
const objectUrls=new Set();
let lastServer=window.PCS_ATLAS_CONFIG?.apiBaseUrl||'';
let toastTimer,routeToken=0;
function toast(text){$('#toast').textContent=text;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),4500);}
async function api(path,options={}){
  try{return await client.json(path,options);}
  catch(error){if(error.status===401)signOut(error.message);throw error;}
}
async function apiFile(path){
  try{return await client.file(path);}
  catch(error){if(error.status===401)signOut(error.message);throw error;}
}
function clearObjectUrls(){for(const url of objectUrls)URL.revokeObjectURL(url);objectUrls.clear();}
function blobUrl(blob){const url=URL.createObjectURL(blob);objectUrls.add(url);return url;}
function fileName(disposition,fallback){
  const encoded=/filename\*=utf-8''([^;]+)/i.exec(disposition);
  let name;
  try{name=encoded?decodeURIComponent(encoded[1]):/filename="([^"]+)"/i.exec(disposition)?.[1];}catch{}
  return (name||fallback).replace(/[\\/\x00-\x1f]/g,'_');
}
async function downloadFile(path,fallback='document'){
  const result=await apiFile(path),url=blobUrl(result.blob);
  const a=document.createElement('a');a.href=url;a.download=fileName(result.disposition,fallback);
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>{URL.revokeObjectURL(url);objectUrls.delete(url);},60000);
}
function showLogin(message=''){
  $('#nav').innerHTML='';$('#breadcrumb').textContent='Workspace / Sign in';
  $('#sign-out').hidden=true;document.title='Sign in · PCS Atlas';
  $('#main').innerHTML=`<section class="panel login-panel"><div class="eyebrow">YOUR PCS WORKSPACE</div><h1>Sign in to PCS Atlas</h1><p>Search suppliers, review datasheets, and track what changed.</p><form data-form="login" class="login-form">${field('Catalog server','server',input('server',lastServer,'required type="url" placeholder="https://pcs-api.example.com" autocomplete="url" spellcheck="false"'),'The HTTPS address of your NAS catalog API.')}${field('Username','username',input('username','admin','required autocomplete="username"'))}${field('Password','password',input('password','','required type="password" autocomplete="current-password"'))}<div class="form-error" role="alert">${esc(message)}</div><button class="btn primary" type="submit">Sign in</button><p class="help">Your catalog loads directly from your NAS. Keep it online and connect to your VPN if required. Reloading this page ends the sign-in session.</p></form></section>`;
}
function signOut(message=''){
  client.signOut();routeToken++;clearObjectUrls();
  if($('#dialog').open)$('#dialog').close();$('#dialog-content').innerHTML='';
  Object.keys(state).forEach(key=>delete state[key]);Object.assign(state,makeState());
  history.replaceState(null,'',location.pathname+location.search);
  showLogin(message);
}
async function bootstrap(){state.boot=await api('/bootstrap');nav();}
function nav(){
  const page=location.hash.slice(1).split(/[/?]/)[0]||'catalog';
  const active=({product:'catalog',document:'documents'})[page]||page;
  $('#nav').innerHTML=[['catalog','Supplier catalog'],['documents','Documents'],['search','Search documents'],['review','Review queue'],['sources','Source monitor'],['history','Change history']].map(([key,label])=>`<a class="nav-link ${active===key?'active':''}" href="#${key}" ${active===key?'aria-current="page"':''}>${icon(key)}${label}${key==='review'&&state.boot?.counts.pending?`<span class="nav-count">${state.boot.counts.pending}</span>`:''}</a>`).join('');
}
function head(title,description,actions='',eyebrow=''){return `<div class="page-head"><div>${eyebrow?`<div class="eyebrow">${esc(eyebrow)}</div>`:''}<h1>${esc(title)}</h1><p>${esc(description)}</p></div><div class="head-actions">${actions}</div></div>`;}
function supplierOptions(selected='',blank='All suppliers'){return option('',blank,selected)+state.boot.suppliers.map(s=>option(s.id,s.name,selected)).join('');}
function productOptions(selected='',blank='Choose a model'){return option('',blank,selected)+state.boot.products.map(p=>option(p.id,`${p.supplier} · ${p.model} · ${p.market}`,selected)).join('');}
function pagination(offset,count,size,action){return `<div class="pagination"><span>${count?`${offset+1}–${offset+count}`:'No results'}</span>${btn('Previous',action,'',`data-offset="${Math.max(0,offset-size)}" ${offset===0?'disabled':''}`,'small-btn')}${btn('Next',action,'',`data-offset="${offset+size}" ${count<size?'disabled':''}`,'small-btn')}</div>`;}
async function route(){
  if(!client.signedIn||!state.boot){showLogin();return;}
  const token=++routeToken;
  clearObjectUrls();
  const [path,query='']=(location.hash.slice(1)||'catalog').split('?');
  const [page,id]=path.split('/');
  nav();
  $('#breadcrumb').textContent='Workspace / '+({catalog:'Supplier catalog',documents:'Documents',search:'Search documents',review:'Review queue',sources:'Source monitor',history:'Change history',product:'Model details',document:'Document history'}[page]||'Supplier catalog');
  $('#main').innerHTML='<div class="loading">Loading…</div>';
  try{
    const render={catalog:renderCatalog,documents:renderDocuments,search:renderSearch,review:renderReview,sources:renderSources,history:renderHistory,product:()=>renderProduct(Number(id)),document:()=>renderDocument(Number(id))}[page]||renderCatalog;
    const html=await render(new URLSearchParams(query));
    if(token!==routeToken)return;
    $('#main').innerHTML=html;
    document.title=($('#main h1')?.textContent||'Supplier catalog')+' · PCS Atlas';
    updateCompareBar();
  }catch(error){if(token===routeToken)$('#main').innerHTML=`<div class="error-state"><h2>Couldn’t load this view</h2><p>${esc(error.message)}</p>${btn('Try again','refresh','refresh')}</div>`;}
}
function specValue(p,key){const s=p.specs[key];return s?`<span class="value-cell" title="${esc(s.conditions||'Reviewed source value')}">${esc(s.value)}${s.unit?` <small>${esc(s.unit)}</small>`:''}</span>${s.stale?'<div class="secondary-line">New source available</div>':''}`:'<span class="muted" title="No reviewed value">—</span>';}
async function renderCatalog(){
  const params=new URLSearchParams({q:state.query,reviewed:state.reviewed});
  if(state.supplier)params.set('supplier_id',state.supplier);
  if(state.minKva)params.set('min_kva',state.minKva);
  if(state.dcMax)params.set('dc_max',state.dcMax);
  state.rows=await api('/products?'+params);
  const c=state.boot.counts;
  return head('Supplier catalog','Find the PCS, trace the specification, and compare the options.',`${btn('Export specs','export-specs','download')}${btn('Add model','add-product','plus','','primary')}`,'POWER CONVERSION SYSTEMS')+
    `<div class="metrics"><div class="metric"><span class="metric-label">Suppliers tracked</span><span class="metric-value">${c.suppliers.toString().padStart(2,'0')}</span><span class="metric-caption">Editable supplier directory</span></div><div class="metric"><span class="metric-label">Models & families</span><span class="metric-value">${c.products.toString().padStart(2,'0')}</span><span class="metric-caption">${c.reviewed_products} with reviewed specifications</span></div><div class="metric"><span class="metric-label">Source documents</span><span class="metric-value">${c.documents.toString().padStart(2,'0')}</span><span class="metric-caption">${c.revisions} captured revisions</span></div><div class="metric highlight"><span class="metric-label">Awaiting review</span><span class="metric-value">${c.pending.toString().padStart(2,'0')}</span><a class="metric-caption" href="#review">Open extraction queue →</a></div></div>`+
    (!c.documents?`<div class="note"><strong>Your sources are ready.</strong> Start collection from Source monitor, or upload a datasheet. Models begin without reviewed specifications.</div>`:'')+
    `<section class="panel"><form data-form="catalog"><div class="toolbar"><div class="searchbox">${icon('search')}${input('catalog-query',state.query,'placeholder="Search models or suppliers" aria-label="Search models or suppliers"')}</div>${select('catalog-supplier',supplierOptions(state.supplier),'aria-label="Filter by supplier"')}<button class="btn" type="submit">Search</button></div><div class="filter-strip"><label>Rated power ≥ ${input('catalog-kva',state.minKva,'type="number" min="0" step="any" placeholder="Any"')} kVA</label><label>Max. DC ≥ ${input('catalog-dc',state.dcMax,'type="number" min="0" step="any" placeholder="Any"')} V</label><label class="check-label"><input name="catalog-reviewed" type="checkbox" ${state.reviewed?'checked':''}>With reviewed specs</label></div></form>`+
    (state.rows.length?`<div class="table-wrap"><table class="catalog-table"><thead><tr><th><span class="small">Pick</span></th><th>Supplier / model</th><th>Market</th><th>Rated power</th><th>Max. DC</th><th>Peak efficiency</th><th>Review status</th><th>Files</th></tr></thead><tbody>${state.rows.map(p=>`<tr><td><input type="checkbox" data-compare="${p.id}" aria-label="Compare ${esc(p.model)}" ${state.selected.has(p.id)?'checked':''}></td><td><div class="supplier-cell"><span class="supplier-avatar" aria-hidden="true">${initials(p.supplier)}</span><div><a class="product-name" href="#product/${p.id}">${esc(p.model)}</a><div class="secondary-line">${esc(p.supplier)} · ${esc(p.kind)}</div></div></div></td><td><span class="small">${esc(p.market)}</span></td><td>${specValue(p,'rated_kva')}</td><td>${specValue(p,'dc_max_v')}</td><td>${specValue(p,'efficiency_max_pct')}</td><td>${p.stale?pill('Source changed','warning'):Object.keys(p.specs).length?pill(`${Object.keys(p.specs).length} fields reviewed`,'good'):pill(p.documents?'Needs review':'Awaiting source')}</td><td class="mono">${p.documents.toString().padStart(2,'0')}</td></tr>`).join('')}</tbody></table></div>`:empty('No models match these filters','Clear the filters or add another model. Numeric filters use current, reviewed values only.'))+
    `<div class="panel-foot"><span>${state.rows.length} models & families</span><span>— = unreviewed · Numeric filters exclude superseded source values.</span></div></section><div id="compare-bar" class="compare-bar" hidden></div>`;
}
function updateCompareBar(){const bar=$('#compare-bar');if(!bar)return;bar.hidden=!state.selected.size;bar.innerHTML=`<span><strong>${state.selected.size}</strong> models selected <span class="small">· up to 4</span></span><div class="compare-actions">${btn('Clear','clear-compare')}${btn('Compare models','compare','compare',state.selected.size<2?'disabled':'','accent')}</div>`;}
async function compare(){
  const products=await Promise.all([...state.selected].map(id=>api('/products/'+id)));
  const fields=state.boot.fields.filter(f=>products.some(p=>p.specs[f.key]));
  modal('Compare models',`<div class="dialog-body"><p>Reviewed source values. Check the model variant, rating conditions, and integration scope before choosing a supplier.</p></div><div class="table-wrap"><table class="compare-table"><thead><tr><th>Specification</th>${products.map(p=>`<th>${esc(p.supplier.name)}<br>${esc(p.model)}</th>`).join('')}</tr></thead><tbody><tr><td>Market / type</td>${products.map(p=>`<td>${esc(p.market)}<div class="secondary-line">${esc(p.kind)}</div></td>`).join('')}</tr>${fields.map(f=>`<tr><td>${esc(f.label)}</td>${products.map(p=>{const s=p.specs[f.key];return `<td>${s?`${esc(s.value)} ${esc(s.unit)}${s.stale?`<p>${pill('Newer source available','warning')}</p>`:''}<div class="spec-conditions">${esc(s.conditions)}</div><div class="spec-evidence"><a href="#document/${s.document_id}?revision=${s.revision_id}&page=${s.page_number}">${icon('external')}Rev ${s.version} · p./sec. ${s.page_number}</a></div>`:'<span class="muted">Unreviewed</span>'}</td>`;}).join('')}</tr>`).join('')}${!fields.length?`<tr><td colspan="${products.length+1}">These models have no reviewed fields yet. Review their datasheets to build a comparison.</td></tr>`:''}</tbody></table></div>`);
  $('#dialog').classList.add('wide-dialog');
}
async function renderProduct(pid){
  const p=await api('/products/'+pid);
  state.product=p;
  const specs=Object.values(p.specs);
  const shown=state.boot.fields.filter(f=>p.specs[f.key]);
  return `<a class="back-link" href="#catalog">${icon('back')}Supplier catalog</a>`+head(p.model,p.supplier.name+' · '+p.market,btn('Add reviewed spec','add-spec','plus',`data-product="${pid}"`,'primary'),p.kind.toUpperCase())+
    (specs.some(s=>s.stale)?'<div class="note warning"><strong>Newer source available.</strong> One or more reviewed fields reference an earlier revision. Review the new source before relying on those values.</div>':'')+
    `<div class="two-col"><div><section class="panel"><div class="panel-heading"><h2>Reviewed specifications</h2>${pill(`${specs.length} fields`,'good')}</div>${shown.length?`<div class="spec-grid">${shown.map(f=>{const s=p.specs[f.key];return `<div class="spec-item"><div class="spec-label">${esc(f.label)}</div><div class="spec-value">${esc(s.value)} <span class="muted">${esc(s.unit)}</span></div>${s.conditions?`<div class="spec-conditions">${esc(s.conditions)}</div>`:''}<div class="spec-evidence"><a href="#document/${s.document_id}?revision=${s.revision_id}&page=${s.page_number}">Rev ${s.version} · p./sec. ${s.page_number}</a>${s.stale?pill('New source','warning'):''}<button class="link-button" data-action="edit-spec" data-key="${f.key}" data-product="${pid}">Review</button></div></div>`;}).join('')}</div>`:empty('Build this model’s specification','Review an extraction suggestion or add a field using an exact source excerpt.',`<a class="btn" href="#review?product=${pid}">${icon('review')}Open review queue</a>`)}</section><section class="panel"><div class="panel-heading"><h2>Source documents</h2>${btn('Upload','upload','upload',`data-product="${pid}"`,'small-btn')}</div>${p.documents.length?p.documents.map(d=>`<div class="doc-card">${icon('documents')}<div><a class="product-name" href="#document/${d.id}">${esc(d.title)}</a><p>${date(d.captured_at)} · ${esc(d.origin)}</p></div>${pill('Rev '+d.version)}</div>`).join(''):empty('No documents assigned','Upload a file or assign an existing document to this model.')}</section></div><aside><section class="panel"><div class="panel-heading"><h2>Model details</h2></div><div class="panel-body"><dl class="metadata"><div><dt>Supplier</dt><dd>${esc(p.supplier.name)}</dd></div><div><dt>Market</dt><dd>${esc(p.market)}</dd></div><div><dt>Record type</dt><dd>${esc(p.kind)}</dd></div><div><dt>Manufacturer website</dt><dd>${p.supplier.website?`<a class="source-url" href="${esc(p.supplier.website)}" target="_blank" rel="noopener">${esc(new URL(p.supplier.website).hostname)} ↗</a>`:'—'}</dd></div>${p.notes?`<div><dt>Notes</dt><dd>${esc(p.notes)}</dd></div>`:''}</dl></div></section><div class="note">A manufacturer’s statement of compliance is indexed as a claim. A certification listing needs its own supporting evidence.</div></aside></div>`+
    (p.spec_history.length?`<section class="panel"><div class="panel-heading"><h2>Specification decisions</h2></div><div class="table-wrap"><table><thead><tr><th>Field</th><th>Value</th><th>Conditions</th><th>Reviewed</th></tr></thead><tbody>${p.spec_history.map(s=>`<tr><td>${esc(state.boot.fields.find(f=>f.key===s.field_key)?.label||s.field_key)}</td><td>${esc(s.value)} ${esc(s.unit)}</td><td>${esc(s.conditions||'—')}</td><td>${datetime(s.reviewed_at)}<div class="secondary-line">${esc(s.reviewer)}</div></td></tr>`).join('')}</tbody></table></div></section>`:'');
}
async function renderDocuments(){
  const rows=await api('/documents?limit=100&offset='+state.docOffset);
  return head('Documents','Original files, captured revisions, and your personal uploads.',btn('Upload document','upload','upload','','primary'))+
    `<div class="note"><strong>Folder import:</strong> files placed in your NAS inbox are imported automatically. Updating the same relative filename creates a new revision; uploaded revisions can be attached to an existing document.</div><section class="panel">`+
    (rows.length?`<div class="table-wrap"><table><thead><tr><th>Document</th><th>Supplier / model</th><th>Origin</th><th>Revision</th><th>Text status</th><th>Captured</th></tr></thead><tbody>${rows.map(d=>`<tr><td><a class="product-name" href="#document/${d.id}">${esc(d.title)}</a><div class="secondary-line">${bytes(d.byte_size)} · ${d.pending} suggestions</div></td><td>${esc(d.supplier||'Unassigned')}<div class="secondary-line">${esc(d.model||'Assign a model in document details')}</div></td><td>${pill(d.origin==='web'?'Website':d.origin==='inbox'?'NAS inbox':'Upload')}</td><td class="mono">${d.version}</td><td>${pill(d.extraction_status,d.extraction_status==='indexed'?'good':'warning')}</td><td class="small">${date(d.captured_at)}</td></tr>`).join('')}</tbody></table></div>`:empty('Bring in your first datasheet','Upload a document, drop files into the NAS inbox, or collect from a supplier source.',btn('Upload document','upload','upload','','primary')))+pagination(state.docOffset,rows.length,100,'docs-page')+'</section>';
}
async function renderDocument(did){
  const params=new URLSearchParams(location.hash.split('?')[1]||'');
  const d=await api('/documents/'+did);
  if(state.documentId!==did){state.documentId=did;state.docRevision=Number(params.get('revision'))||d.current_revision_id;state.docPage=Number(params.get('page'))||1;state.docTab='text';}
  if(!d.revisions.some(r=>r.id===state.docRevision))state.docRevision=d.current_revision_id;
  const r=await api('/revisions/'+state.docRevision);
  state.doc={d,r};
  if(!r.pages.some(p=>p.page_number===state.docPage))state.docPage=r.pages[0]?.page_number||1;
  const current=r.id===d.current_revision_id;
  let body='';
  if(state.docTab==='diff'){
    const diff=await api('/revisions/'+r.id+'/diff');
    body=(diff.truncated?'<div class="note warning">Diff limited for a long document. Download both originals to inspect the full change.</div>':'')+`<pre class="diff">${diff.diff.split('\n').map(line=>`<span class="${line.startsWith('+')&&!line.startsWith('+++')?'diff-add':line.startsWith('-')&&!line.startsWith('---')?'diff-del':''}">${esc(line)}</span>`).join('\n')}</pre>`;
  }else if(state.docTab==='original'){
    if(r.mime==='application/pdf'){
      const original=await apiFile('/revisions/'+r.id+'/file');
      body=`<iframe class="pdf-frame" title="Original ${esc(r.filename)}" src="${blobUrl(original.blob)}#page=${state.docPage}"></iframe>`;
    }else body=empty('Download the original file','This document format is available as a download. Its extracted text is searchable.',btn('Download original','download-original','download',`data-id="${r.id}"`));
  }else body=`<pre class="page-text">${esc(r.pages.find(p=>p.page_number===state.docPage)?.text||'No text extracted. Review the original; scanned pages may need OCR.')}</pre>`;
  return `<a class="back-link" href="#documents">${icon('back')}Documents</a>`+head(d.title,`${d.origin==='web'?'Supplier website':d.origin==='inbox'?'NAS folder import':'Personal upload'} · ${d.revisions.length} retained revisions`,`${btn('Edit details','edit-document')}${btn('Upload revision','upload','upload',`data-document="${did}"`,'primary')}`)+
    (!current?'<div class="note warning">You are viewing a historical revision. Reviewed fields must use the current revision when saved.</div>':'')+
    (r.extraction_note?`<div class="note ${r.extraction_status==='indexed'?'':'warning'}">${esc(r.extraction_note)}</div>`:'')+
    `<section class="panel"><div class="reader-top"><label for="doc-revision" class="small">Revision</label>${select('doc-revision',d.revisions.map(v=>option(v.id,`Rev ${v.version} · ${date(v.captured_at)}${v.id===d.current_revision_id?' · Current':''}`,r.id)).join(''),'data-control="doc-revision"')}<label for="doc-page" class="small">Page / section</label>${select('doc-page',r.pages.map(p=>option(p.page_number,p.page_number,state.docPage)).join('')||option(1,'No text',1),'data-control="doc-page"')}${btn('Original · '+bytes(r.byte_size),'download-original','download',`data-id="${r.id}"`,'small-btn')}</div><div class="tabs" role="tablist" aria-label="Document view">${[['text','Extracted text'],['original','Original file'],['diff','Changes from previous']].map(([key,label])=>`<button class="tab ${state.docTab===key?'active':''}" role="tab" aria-selected="${state.docTab===key}" data-action="doc-tab" data-tab="${key}">${label}</button>`).join('')}</div><div role="tabpanel">${body}</div><div class="panel-foot"><span>Captured ${datetime(r.captured_at)} · ${pill(r.extraction_status,r.extraction_status==='indexed'?'good':'warning')}</span><span>${current?'Current revision':'Historical revision'} · SHA-256 ${esc(r.sha256.slice(0,12))}…</span></div></section>`+
    `<section class="panel"><div class="panel-heading"><h2>Source & integrity</h2></div><div class="panel-body"><dl class="metadata"><div><dt>Source URL</dt><dd>${d.source_url?`<a class="source-url" href="${esc(d.source_url)}" target="_blank" rel="noopener">${esc(d.source_url)}</a>`:'Personal file'}</dd></div><div><dt>Original filename</dt><dd>${esc(r.filename)}</dd></div><div><dt>SHA-256</dt><dd class="mono small">${esc(r.sha256)}</dd></div><div><dt>Extraction suggestions</dt><dd>${r.candidates.filter(c=>c.status==='pending').length} pending in this revision · <a class="link-button" href="#review${d.product_id?'?product='+d.product_id:''}">Open review queue</a></dd></div></dl></div></section>`;
}
async function renderSearch(params){
  const q=params.get('q')||'';
  const history=params.get('history')==='1';
  const rows=q?await api('/search?'+new URLSearchParams({q,history,limit:60,offset:state.searchOffset})):[];
  return head('Search documents','Search inside datasheets, manuals, and personal files.')+
    `<form data-form="search"><div class="full-search"><div class="searchbox">${icon('search')}${input('document-query',q,'required maxlength="200" placeholder="Try: grid forming, UL 1741, reactive power…" aria-label="Search document text"')}</div><button class="btn primary">Search documents</button></div><label class="check-label small-note"><input name="search-history" type="checkbox" ${history?'checked':''}>Include previous revisions</label></form>`+
    (q?`<section class="panel"><div class="panel-heading"><h2>Results for “${esc(q)}”</h2>${pill(history?'All revisions':'Current revisions')}</div>${rows.length?rows.map(r=>`<article class="result-card"><h3><a class="link-button" href="#document/${r.document_id}?revision=${r.revision_id}&page=${r.page_number}">${esc(r.title)}</a></h3><div class="result-meta"><span>${esc(r.supplier||'Personal file')}</span><span>Rev ${r.version} · page / section ${r.page_number}</span><span>${date(r.captured_at)}</span>${r.is_current?'':pill('Historical','warning')}</div><p>${esc(r.excerpt)}</p></article>`).join(''):empty('No matching text','Try fewer words. Search matches all entered terms; scanned documents need a text layer before they can be searched.')}${pagination(state.searchOffset,rows.length,60,'search-page')}</section>`:empty('Look across every source','Search technical terms, standards, model names, or exact values. Current revisions are searched by default.'));
}
async function renderReview(params){
  const pid=params.get('product')||'';
  state.candidates=await api('/candidates?'+new URLSearchParams({limit:60,offset:state.reviewOffset,...(pid?{product_id:pid}:{})}));
  return head('Review queue','Confirm the model, value, units, and conditions against the original source.',btn('Refresh','refresh','refresh'))+
    `<div class="note"><strong>Suggestions need a decision.</strong> Table rows may contain several variants. An automatic match stays out of the specification catalog until you review it. You can also add fields manually from a model page.</div><section class="panel"><div class="toolbar">${select('review-model',productOptions(pid,'All models'),'data-control="review-model" aria-label="Filter review queue by model"')}<span class="muted small">${state.boot.counts.pending} pending overall</span></div>`+
    (state.candidates.length?state.candidates.map(c=>`<article class="review-card"><div class="review-top"><div><h3>${esc(state.boot.fields.find(f=>f.key===c.field_key)?.label||c.field_key)}</h3><div class="review-title">${esc(c.supplier||'Personal file')} · ${esc(c.model||'Model unassigned')}</div></div>${pill('Needs review','warning')}</div><div class="result-meta"><a href="#document/${c.document_id}?revision=${c.revision_id}&page=${c.page_number}">${esc(c.title)} ↗</a><span>Rev ${c.version} · p./sec. ${c.page_number}</span></div><blockquote class="evidence">${esc(c.evidence)}</blockquote><div class="review-actions">${btn('Dismiss','reject','','data-id="'+c.id+'"','small-btn')}${btn('Review field','review-candidate','review','data-id="'+c.id+'"','small-btn primary')}</div></article>`).join(''):empty('No pending suggestions in this view','New datasheets and revisions create suggestions here. Reviewed decisions stay in the change history.'))+pagination(state.reviewOffset,state.candidates.length,60,'review-page')+'</section>';
}
async function renderSources(){
  state.sources=await api('/sources');
  const age=state.boot.worker_age_seconds;
  const worker=age===null?'Worker has not started':age>180?'Worker heartbeat is stale':'Worker is running';
  return head('Source monitor','Collect supplier datasheets on a schedule and see what changed.',`${btn('Check all','collect','refresh')}${btn('Add source','add-source','plus','','primary')}`)+
    `<div class="note ${age===null||age>180?'warning':''}"><strong>${worker}.</strong> ${state.boot.collection_enabled?'Enabled sources are checked on their own schedules.':'Automatic collection is disabled in the server configuration.'} Files and web content stay in your own deployment.</div><section class="panel">`+
    (state.sources.length?state.sources.map(s=>`<article class="source-card"><div><div class="source-title"><h3>${esc(s.name)}</h3>${pill(!s.enabled?'Paused':['running','queued'].includes(s.job_status)?s.job_status:s.last_status,s.last_status==='OK'&&s.enabled?'good':s.last_status==='Error'?'bad':s.last_status==='Partial'?'warning':'')}</div><a class="source-url" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a><div class="source-meta"><span>${esc(s.supplier)}</span><span>${s.kind==='file'?'Direct PDF':'Discovery page'}</span><span>Every ${s.interval_hours} hours</span><span>Last check: ${datetime(s.last_checked)}</span><span>${s.last_count} files checked</span></div>${s.last_error?`<div class="source-error">${esc(s.last_error)}</div>`:''}</div><div class="source-actions">${btn('Check','run-source','refresh',`data-id="${s.id}" ${!s.enabled?'disabled':''}`,'small-btn')}${btn(s.enabled?'Pause':'Resume','toggle-source','',`data-id="${s.id}"`,'small-btn')}${btn('Edit','edit-source','',`data-id="${s.id}"`,'small-btn')}</div></article>`).join(''):empty('Add your first supplier source','Use an official product/download page or a direct PDF URL.',btn('Add source','add-source','plus','','primary')))+`</section><div class="small-note">Discovery follows static links on allowed hosts. Access restrictions, JavaScript download portals, and missing links are reported for follow-up.</div>`;
}
async function renderHistory(){
  const rows=await api('/history?limit=80&offset='+state.historyOffset);
  return head('Change history','A chronological record of documents, collection runs, and specification decisions.',btn('Refresh','refresh','refresh'))+`<section class="panel">`+
    (rows.length?rows.map(r=>`<article class="history-item"><span class="event-icon">${icon(r.type.includes('spec')?'review':r.type.includes('source')?'sources':'documents')}</span><div><h3>${r.entity_type==='document'?`<a href="#document/${r.entity_id}">${esc(r.summary)}</a>`:r.entity_type==='product'?`<a href="#product/${r.entity_id}">${esc(r.summary)}</a>`:esc(r.summary)}</h3><time>${datetime(r.created_at)}</time> <span class="small muted">· ${esc(r.type.replaceAll('_',' '))}</span>${Object.keys(r.details).length?`<details class="history-details"><summary>View recorded details</summary><pre>${esc(JSON.stringify(r.details,null,2))}</pre></details>`:''}</div></article>`).join(''):empty('History starts with your first change','Original revisions and reviewed field decisions are retained as you work.'))+pagination(state.historyOffset,rows.length,80,'history-page')+'</section>';
}
function modal(title,body){
  const d=$('#dialog');d.classList.remove('wide-dialog');
  $('#dialog-content').innerHTML=`<div class="dialog-head"><h2>${esc(title)}</h2><button class="close-btn" data-action="close" aria-label="Close dialog">${icon('close')}</button></div>${body}`;
  if(!d.open)d.showModal();
}
function formModal(title,type,body,submit='Save'){
  modal(title,`<form data-form="${type}"><div class="dialog-body">${body}<div class="form-error" role="alert"></div></div><div class="dialog-actions">${btn('Cancel','close','','type="button"')}<button class="btn primary" type="submit">${esc(submit)}</button></div></form>`);
}
function supplierModal(){formModal('Add supplier','supplier',`<div class="form-grid">${field('Supplier name','name',input('name','','required maxlength="140"'))}${field('Official website','website',input('website','','type="url" placeholder="https://"'))}${field('Notes','notes',area('notes'),'Optional context for this supplier.',true)}</div>`);}
function productModal(){formModal('Add PCS model','product',`<p>Separate regional variants and voltage options when their specifications differ.</p><div class="form-grid">${field('Supplier','supplier_id',select('supplier_id',supplierOptions('','Choose a supplier'),'required'))}${field('Model / family name','model',input('model','','required maxlength="200"'))}${field('Market','market',input('market','North America','required'))}${field('Record type','kind',select('kind',['Model','Model family','PCS with MV skid'].map(s=>option(s,s,'Model')).join('')))}${field('Notes / variant context','notes',area('notes'),'Record the exact configuration if this datasheet covers a family.',true)}</div><p class="small">Supplier missing? <button type="button" class="link-button" data-action="add-supplier">Add a supplier first</button>.</p>`);}
function uploadModal(attrs={}){
  state.uploadDocument=attrs.document?Number(attrs.document):null;
  formModal(state.uploadDocument?'Upload a new revision':'Upload document','upload',`${state.uploadDocument?'<p>The previous original will remain available. Identical bytes do not create an extra revision.</p>':''}<div class="form-grid"><div class="field full file-drop"><label for="file">Choose a file</label><input type="file" name="file" id="file" required accept=".pdf,.txt,.md,.csv,.docx,.xlsx"><p>PDF, TXT, MD, CSV, DOCX, XLSX · up to ${state.boot.max_file_mb} MB</p></div>${!state.uploadDocument?`${field('Document title','title',input('title','','maxlength="240"'),'Optional; defaults to the filename.',true)}${field('Supplier','supplier_id',select('supplier_id',supplierOptions('','Unassigned / personal')))}${field('Model','product_id',select('product_id',productOptions(attrs.product||'','Unassigned')))}`:''}</div>`,'Upload & index');
}
function sourceModal(source=null){
  state.editSource=source;
  formModal(source?'Edit source':'Add supplier source','source',`<p>Use an official product page to discover new PDFs, or a direct PDF URL to watch one document.</p><div class="form-grid">${!source?`${field('Supplier','supplier_id',select('supplier_id',supplierOptions('','Choose a supplier'),'required'))}${field('Model / family','product_id',select('product_id',productOptions('','Unassigned')))}${field('Source name','name',input('name','','required maxlength="200"'),'',true)}${field('Source URL','url',input('url','','required type="url" placeholder="https://"'),'',true)}${field('Source type','kind',select('kind',option('page','Product / download page','page')+option('file','Direct PDF','page')))}`:''}${field('Check interval (hours)','interval_hours',input('interval_hours',source?.interval_hours||24,'required type="number" min="1" max="720"'))}${field('Allowed download hosts','allowed_hosts',input('allowed_hosts',(source?.allowed_hosts||[]).join(', ')),'Exact hostnames separated by commas. Include a supplier CDN when needed.',true)}${field('Link keywords','link_pattern',input('link_pattern',source?.link_pattern||''),'Match any comma-separated keyword in the file URL or link text. Blank matches all PDFs on the page.',true)}${field('Page discovery depth','depth',select('depth',[0,1,2].map(n=>option(n,n===0?'This page only':n+' linked page level'+(n>1?'s':''),source?.depth??0)).join('')))}<div class="field"><label class="check-label"><input name="enabled" type="checkbox" ${source?.enabled===0?'':'checked'}>Enable collection</label></div></div><p class="small">Collection respects robots.txt and reports blocked or unavailable sources.</p>`);
}
function documentModal(){
  const d=state.doc.d;
  formModal('Document details','document',`<div class="form-grid">${field('Title','title',input('title',d.title,'required maxlength="240"'),'',true)}${field('Supplier','supplier_id',select('supplier_id',supplierOptions(d.supplier_id||'','Unassigned')))}${field('Model','product_id',select('product_id',productOptions(d.product_id||'','Unassigned')))}</div>`);
}
async function specModal({candidate=null,pid=null,key=null}={}){
  const product=pid?await api('/products/'+pid):null;
  const current=key?product?.specs[key]:null;
  const docs=await api('/documents?limit=1000');
  const rid=candidate?.revision_id||(current?docs.find(d=>d.id===current.document_id)?.current_revision_id:null)||product?.documents[0]?.current_revision_id||docs[0]?.current_revision_id;
  if(!rid){toast('Upload and index a source document first.');return;}
  const revision=await api('/revisions/'+rid);
  const fieldKey=candidate?.field_key||key||state.boot.fields[0].key;
  const chosenPid=pid||candidate?.product_id||'';
  state.specContext={candidate,revision,products:{},expected:null};
  if(product)state.specContext.products[product.id]=product;
  formModal('Review specification','spec',`<p>Confirm the exact variant and conditions in the original. Numeric values use the unit shown; qualified or multi-value claims can stay as text.</p><div class="form-grid">${field('Model / variant','product_id',select('product_id',productOptions(chosenPid),'required data-control="spec-product"'),'',true)}${field('Specification','field_key',select('field_key',state.boot.fields.map(f=>option(f.key,f.label,fieldKey)).join(''),'data-control="spec-field"'))}${field('Source document / current revision','revision_id',select('revision_id',docs.map(d=>option(d.current_revision_id,`${d.title} · Rev ${d.version}`,rid)).join(''),`required data-control="spec-revision" ${candidate?'disabled':''}`))}${field('Page / section','page_number',select('page_number',revision.pages.map(p=>option(p.page_number,p.page_number,candidate?.page_number||current?.page_number||1)).join(''),'required data-control="spec-page"'))}${field('Value','value',input('value',current?.value||'','required maxlength="1000"'),'The normalized value for this model. Unit: '+(state.boot.fields.find(f=>f.key===fieldKey)?.unit||'text'))}${field('Rating conditions / qualifications','conditions',area('conditions',current?.conditions||''),'Examples: ambient temperature, voltage, optional controls, per-inverter or per-skid rating.',true)}<div class="field full"><label class="check-label"><input name="numeric" type="checkbox" ${current?.numeric_value!=null?'checked':''}>Use this as a single numeric value in filters</label><span class="help">For a range, inequality, or multiple model columns, leave this unchecked.</span></div>${field('Exact source excerpt','evidence',area('evidence',candidate?.evidence||current?.evidence||'','required maxlength="3000"'),'Copy the supporting passage from the extracted text below. Preserve the qualifiers.',true)}<div class="field full"><label for="source-text">Extracted source page / section</label><textarea readonly id="source-text" rows="7"></textarea><button type="button" id="source-original" class="link-button" data-action="download-original">Download original source</button></div></div>`,'Save reviewed field');
  updateSourcePage();
  await updateSpecSelection();
}
function updateSourcePage(){
  const context=state.specContext;if(!context)return;
  const page=Number($('#page_number').value);
  $('#source-text').value=context.revision.pages.find(p=>p.page_number===page)?.text||'No extracted text. Upload a searchable copy to review this field.';
  $('#source-original').dataset.id=context.revision.id;
}
async function updateSpecSelection(){
  const context=state.specContext,pid=Number($('#product_id').value),key=$('#field_key').value;
  const f=state.boot.fields.find(f=>f.key===key);
  const help=$('#value').parentElement.querySelector('.help');help.textContent='The normalized value for this model. Unit: '+(f.unit||'text');
  const numeric=$('input[name=numeric]');numeric.disabled=f.kind!=='number';if(numeric.disabled)numeric.checked=false;
  if(pid&&!context.products[pid])context.products[pid]=await api('/products/'+pid);
  context.expected=pid?context.products[pid]?.specs[key]?.id||null:null;
}
document.addEventListener('click',async event=>{
  if(event.target.closest('dialog a[href^="#"]'))$('#dialog').close();
  const el=event.target.closest('[data-action]');if(!el)return;
  event.preventDefault();if(el.disabled)return;
  const a=el.dataset.action,d=el.dataset;
  try{
    if(a==='sign-out'){signOut();return;}
    if(a==='export-specs'){await downloadFile('/export/specs.csv','pcs-atlas-specs.csv');return;}
    if(a==='download-original'){await downloadFile('/revisions/'+Number(d.id)+'/file?download=true');return;}
    if(a==='close')$('#dialog').close();
    else if(a==='refresh'){await bootstrap();await route();}
    else if(a==='add-product')productModal();
    else if(a==='add-supplier')supplierModal();
    else if(a==='upload')uploadModal(d);
    else if(a==='add-source')sourceModal();
    else if(a==='edit-source')sourceModal(state.sources.find(s=>s.id===Number(d.id)));
    else if(a==='edit-document')documentModal();
    else if(a==='add-spec'||a==='edit-spec')await specModal({pid:Number(d.product),key:d.key});
    else if(a==='review-candidate')await specModal({candidate:state.candidates.find(c=>c.id===Number(d.id))});
    else if(a==='reject'){await api('/candidates/'+d.id+'/reject',{method:'POST'});toast('Suggestion dismissed. Decision saved to history.');await bootstrap();await route();}
    else if(a==='collect'){await api('/collect',{method:'POST'});toast('Source checks queued. The worker will process them in order.');await bootstrap();await route();}
    else if(a==='run-source'){await api('/sources/'+d.id+'/run',{method:'POST'});toast('Source check queued.');await route();}
    else if(a==='toggle-source'){const s=state.sources.find(s=>s.id===Number(d.id));await api('/sources/'+d.id,{method:'PATCH',body:{enabled:!s.enabled}});toast(s.enabled?'Source paused. An active request may finish.':'Source resumed.');await route();}
    else if(a==='clear-compare'){state.selected.clear();document.querySelectorAll('[data-compare]').forEach(c=>c.checked=false);updateCompareBar();}
    else if(a==='compare')await compare();
    else if(a==='doc-tab'){state.docTab=d.tab;await route();}
    else if(a.endsWith('-page')){const key={'docs-page':'docOffset','review-page':'reviewOffset','history-page':'historyOffset','search-page':'searchOffset'}[a];state[key]=Number(d.offset);await route();}
  }catch(error){toast(error.message);}
});
document.addEventListener('change',async event=>{
  const el=event.target;
  try{
    if(el.matches('[data-compare]')){const id=Number(el.dataset.compare);if(el.checked){if(state.selected.size>=4){el.checked=false;toast('Compare up to four models at a time.');return;}state.selected.add(id);}else state.selected.delete(id);updateCompareBar();}
    const action=el.dataset.control;
    if(action==='doc-revision'){state.docRevision=Number(el.value);state.docPage=1;await route();}
    if(action==='doc-page'){state.docPage=Number(el.value);await route();}
    if(action==='review-model'){state.reviewOffset=0;location.hash='review'+(el.value?'?product='+el.value:'');}
    if(action==='spec-page')updateSourcePage();
    if(action==='spec-field'||action==='spec-product')await updateSpecSelection();
    if(action==='spec-revision'){
      state.specContext.revision=await api('/revisions/'+el.value);
      $('#page_number').innerHTML=state.specContext.revision.pages.map(p=>option(p.page_number,p.page_number,1)).join('');
      $('#evidence').value='';updateSourcePage();
    }
  }catch(error){toast(error.message);}
});
document.addEventListener('submit',async event=>{
  const form=event.target;if(!form.dataset.form)return;event.preventDefault();
  const type=form.dataset.form,data=new FormData(form),v=Object.fromEntries(data);
  const submit=form.querySelector('button[type=submit]')||form.querySelector('button:not([type])');
  const err=form.querySelector('.form-error');if(err)err.textContent='';
  if(submit)submit.disabled=true;
  try{
    if(type==='login'){
      lastServer=v.server.trim();
      state.boot=await client.signIn(lastServer,v.username,v.password);
      form.reset();$('#sign-out').hidden=false;nav();await route();return;
    }
    if(type==='catalog'){state.query=v['catalog-query'];state.supplier=v['catalog-supplier'];state.minKva=v['catalog-kva'];state.dcMax=v['catalog-dc'];state.reviewed=data.has('catalog-reviewed');await route();return;}
    if(type==='search'){state.searchOffset=0;const hash='search?'+new URLSearchParams({q:v['document-query'],history:data.has('search-history')?'1':'0'});if(location.hash.slice(1)===hash)await route();else location.hash=hash;return;}
    if(type==='supplier')await api('/suppliers',{method:'POST',body:v});
    if(type==='product')await api('/products',{method:'POST',body:{...v,supplier_id:Number(v.supplier_id)}});
    if(type==='upload'){
      const file=data.get('file');if(file.size>state.boot.max_file_mb*1024*1024)throw new Error(`File exceeds ${state.boot.max_file_mb} MB.`);
      ['supplier_id','product_id'].forEach(k=>{if(!data.get(k))data.delete(k);});
      if(state.uploadDocument)data.set('document_id',state.uploadDocument);
      const result=await api('/upload',{method:'POST',body:data});
      $('#dialog').close();toast(result.changed?'Document saved and indexed. Review the extraction status.':'Identical to the current revision. No extra revision created.');await bootstrap();state.documentId=null;const hash='document/'+result.document_id;if(location.hash.slice(1)===hash)await route();else location.hash=hash;return;
    }
    if(type==='source'){
      const body={allowed_hosts:v.allowed_hosts.split(',').map(s=>s.trim()).filter(Boolean),link_pattern:v.link_pattern,depth:Number(v.depth),interval_hours:Number(v.interval_hours),enabled:data.has('enabled')};
      if(state.editSource)await api('/sources/'+state.editSource.id,{method:'PATCH',body});
      else await api('/sources',{method:'POST',body:{...body,name:v.name,url:v.url,kind:v.kind,supplier_id:Number(v.supplier_id),product_id:v.product_id?Number(v.product_id):null}});
    }
    if(type==='document')await api('/documents/'+state.doc.d.id,{method:'PATCH',body:{title:v.title,supplier_id:v.supplier_id?Number(v.supplier_id):null,product_id:v.product_id?Number(v.product_id):null}});
    if(type==='spec'){
      const context=state.specContext;
      const numeric=data.has('numeric')?Number(v.value.replaceAll(',','')):null;
      if(numeric!==null&&!Number.isFinite(numeric))throw new Error('Enter a single number for numeric filters, or uncheck the numeric option.');
      await api('/products/'+Number(v.product_id)+'/specs',{method:'POST',body:{field_key:v.field_key,value:v.value,numeric_value:numeric,conditions:v.conditions,revision_id:context.revision.id,page_number:Number(v.page_number),evidence:v.evidence,candidate_id:context.candidate?.id||null,expected_current_id:context.expected}});
    }
    $('#dialog').close();toast(type==='spec'?'Reviewed specification saved with source evidence.':'Saved.');await bootstrap();await route();
  }catch(error){if(err)err.textContent=error.message;else toast(error.message);}
  finally{if(submit)submit.disabled=false;}
});
window.addEventListener('hashchange',()=>{state.documentId=null;route();});
window.addEventListener('pagehide',()=>signOut());
showLogin();
