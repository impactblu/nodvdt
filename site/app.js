// PCS Atlas — public, read-only catalog.
// Everything shown comes from /data (kept current by the NAS collector) and
// /datasheets (every datasheet version it has seen). No server, no login.

const ROOT = location.pathname.includes('/site/') ? '../' : './';
const MAX_COMPARE = 4;
const COMPARE_KEY = 'pcs-atlas-compare';

// Public wording for the four value statuses. "ok" statuses stay quiet in the UI.
const STATUS = {
  'reviewed':    { tone: 'ok',      label: 'Reviewed',     text: 'Checked by a reviewer against the datasheet page.' },
  'extracted':   { tone: 'auto',    label: 'Auto-extracted', text: 'Read from the datasheet table by the rules-based extractor. Not yet reviewed by a person — open the page link to check it.' },
  'confirmed':   { tone: 'ok',      label: 'Verified',     text: 'Found unchanged in the newest version of the datasheet.' },
  'updated':     { tone: 'updated', label: 'Updated',      text: 'The manufacturer published a new datasheet with a different number. Updated automatically; the previous value and datasheet are kept below.' },
  'needs-check': { tone: 'review',  label: 'Under review', text: 'The newest datasheet no longer states this the same way. Showing the last confirmed value until it is reviewed.' },
};

const KPI_FIELDS = [
  { label: 'Rated power', keys: ['rated_kva', 'rated_kw'], note: (s) => (s.field === 'rated_kva' ? 'apparent power' : 'active power') },
  { label: 'Max DC voltage', keys: ['dc_max_v'] },
  { label: 'Peak efficiency', keys: ['efficiency_max_pct', 'efficiency_with_mvt_pct'], note: (s) => (s.field === 'efficiency_max_pct' ? 'converter only' : 'incl. MV transformer') },
  { label: 'Grid forming', keys: ['gfm'] },
];

const db = {};
const idx = {};
const compareSet = new Set(loadCompare());

// ------------------------------------------------------------------ helpers

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fmtBytes = (n) => (n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const dayKey = (iso) => new Date(iso).toLocaleDateString('en-CA');

function timeAgo(iso) {
  if (!iso) return 'not yet';
  const seconds = (new Date(iso) - Date.now()) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

// "14000" → "14,000"; leaves decimals, ranges and text intact.
const groupDigits = (text) => String(text).replace(/(^|[^\d.,])(\d{4,})(?![\d.,]*\d)/g, (m, pre, digits) => pre + Number(digits).toLocaleString('en-US'));

function formatValue(spec, value = spec.value) {
  const field = idx.fields.get(spec.field) || { unit: '' };
  const text = groupDigits(value);
  const unit = field.unit && !String(value).trim().endsWith(field.unit) ? ` ${field.unit}` : '';
  return `${text}${unit}`;
}

const initials = (name) => name.split(/[\s-]+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const pdfHref = (rev, page) => ROOT + rev.file.split('/').map(encodeURIComponent).join('/') + (page ? `#page=${page}` : '');
const modelHref = (id, field) => `#/model/${encodeURIComponent(id)}${field ? `?f=${encodeURIComponent(field)}` : ''}`;

const ICON = {
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  alert: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5M12 16.5v.01M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M10 5H5v14h14v-5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  doc: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6v18h12V7zM14 3v4h4M9 12h6M9 16h6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/></svg>',
};

const fileIcon = '<svg class="file-icon" viewBox="0 0 34 40" aria-hidden="true"><path d="M4 2h18l8 8v26a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><text x="8" y="29">PDF</text></svg>';

function statusMark(status) {
  const meta = STATUS[status];
  if (!meta) return '';
  if (meta.tone === 'ok') {
    return `<span class="status status-ok" title="${esc(meta.label)}: ${esc(meta.text)}">${ICON.check}<span class="sr-only">${esc(meta.label)}</span></span>`;
  }
  if (meta.tone === 'auto') {
    return `<span class="status status-auto" title="${esc(meta.label)}: ${esc(meta.text)}">${ICON.sparkle}<span class="sr-only">${esc(meta.label)}</span></span>`;
  }
  return `<span class="status status-${meta.tone}" title="${esc(meta.text)}">${ICON.alert}${esc(meta.label)}</span>`;
}

const isAttention = (status) => ['updated', 'review'].includes(STATUS[status]?.tone);

function loadCompare() {
  try { return JSON.parse(localStorage.getItem(COMPARE_KEY) || '[]').slice(0, MAX_COMPARE); } catch { return []; }
}
function saveCompare() {
  try { localStorage.setItem(COMPARE_KEY, JSON.stringify([...compareSet])); } catch { /* private mode: keep in memory */ }
  renderTray();
}
function toggleCompare(id) {
  if (compareSet.has(id)) compareSet.delete(id);
  else if (compareSet.size < MAX_COMPARE) compareSet.add(id);
  else return false;
  saveCompare();
  return true;
}

// ------------------------------------------------------------------ data

async function loadJson(name, fallback) {
  try {
    const res = await fetch(`${ROOT}data/${name}.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${name}.json: HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

async function loadData() {
  const [suppliers, fields, documents, specs, changes, status, models] = await Promise.all([
    loadJson('suppliers'), loadJson('fields'), loadJson('documents'), loadJson('specs'),
    loadJson('changes', []), loadJson('status', {}), loadJson('models', []),
  ]);
  Object.assign(db, { suppliers, fields, documents, specs, changes, status, models });

  // Keep each group's fields together, in the order the groups first appear.
  const groupOrder = [...new Set(fields.map((f) => f.group))];
  db.fields = [...fields].sort((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group));
  idx.fields = new Map(fields.map((f) => [f.key, f]));
  idx.suppliers = new Map(suppliers.map((s) => [s.id, s]));
  idx.products = new Map();
  for (const s of suppliers) for (const p of s.products || []) idx.products.set(p.id, { ...p, supplier: s });
  for (const m of models) {
    const s = idx.suppliers.get(m.supplier);
    if (s && !idx.products.has(m.id)) idx.products.set(m.id, { ...m, supplier: s });
  }
  idx.documents = new Map(documents.map((d) => [d.id, d]));
  idx.revisions = new Map();
  for (const d of documents) d.revisions.forEach((rev, i) => idx.revisions.set(rev.sha256, { doc: d, rev, number: i + 1 }));
  idx.specsByProduct = groupBy(specs, (s) => s.product);
  idx.docsByProduct = new Map();
  for (const d of documents) {
    for (const pid of new Set([d.product, ...(d.models || [])])) {
      if (!idx.docsByProduct.has(pid)) idx.docsByProduct.set(pid, []);
      idx.docsByProduct.get(pid).push(d);
    }
  }
  idx.familyMembers = groupBy([...idx.products.values()].filter((p) => p.family), (p) => p.family);
  for (const id of [...compareSet]) if (!idx.products.has(id)) compareSet.delete(id);
}

function groupBy(items, key) {
  const map = new Map();
  for (const item of items) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

const specsOf = (id) => idx.specsByProduct.get(id) || [];
const reviewedCount = (id) => specsOf(id).filter((s) => s.status !== 'extracted').length;
const docsOf = (id) => idx.docsByProduct.get(id) || [];
const specOf = (id, key) => specsOf(id).find((s) => s.field === key);
const pick = (id, keys) => keys.map((k) => specOf(id, k)).find(Boolean);
const latestRev = (doc) => doc.revisions[doc.revisions.length - 1];
const lastChecked = () => db.status?.last_run_finished || db.documents.map((d) => d.last_checked).sort().pop();

// ------------------------------------------------------------------ home + catalog

function viewHome(params) {
  const withSpecs = [...idx.products.keys()].filter((id) => specsOf(id).length);
  const revisions = db.documents.reduce((n, d) => n + d.revisions.length, 0);
  const example = db.specs.find((s) => s.field === 'rated_kva') || db.specs[0];
  const exampleProduct = example && idx.products.get(example.product);

  return {
    title: 'Battery storage inverter specs',
    html: `
      <section class="hero">
        <div class="container hero-grid">
          <div>
            <p class="live">Checked for new datasheets ${esc(timeAgo(lastChecked()))}</p>
            <h1>Battery storage inverter specs, <em>traced to the datasheet</em>.</h1>
            <p class="hero-lead">Compare power conversion systems (PCS) for utility-scale battery storage.
              Every number links to the exact page of the manufacturer's datasheet — and when a manufacturer publishes a new version, the catalog notices.</p>
            <div class="hero-actions">
              <a class="btn btn-primary" href="#/" data-scroll-to="models">Browse models ${ICON.arrow}</a>
              <a class="btn" href="#/about">How it stays current</a>
            </div>
          </div>
          <div class="card hero-panel">
            <div class="hero-stats">
              <div class="hero-stat"><b>${idx.products.size}</b><span>models &amp; families</span></div>
              <div class="hero-stat"><b>${db.suppliers.length}</b><span>manufacturers</span></div>
              <div class="hero-stat"><b>${db.specs.length.toLocaleString()}</b><span>values with a source</span></div>
              <div class="hero-stat"><b>${revisions}</b><span>datasheet versions archived</span></div>
            </div>
            ${example && exampleProduct ? `
              <div class="hero-trace">
                <strong>${esc(exampleProduct.model)}</strong> · ${esc(idx.fields.get(example.field)?.label || '')}: <strong>${esc(formatValue(example))}</strong>
                <div class="quote">“${esc(example.evidence)}”</div>
                              </div>` : ''}
          </div>
        </div>
      </section>

      <section class="container section" id="models" aria-labelledby="models-h">
        <div class="section-head">
          <div>
            <h2 id="models-h">Models</h2>
            <p>${plural(withSpecs.length, 'model')} with detailed specifications · ${plural(idx.products.size - withSpecs.length, 'more model')} with datasheets on file</p>
          </div>
        </div>
        <div class="toolbar" id="catalog-tools">
          <div class="segmented" role="group" aria-label="Show">
            <button type="button" data-show="all">All models</button>
            <button type="button" data-show="specs">With specs</button>
          </div>
          <select id="f-supplier" aria-label="Manufacturer">
            <option value="">All manufacturers</option>
            ${db.suppliers.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}
          </select>
          <select id="f-sort" aria-label="Sort by">
            <option value="featured">Sort: most detail first</option>
            <option value="name">Sort: name</option>
            <option value="power">Sort: rated power</option>
            <option value="efficiency">Sort: efficiency</option>
          </select>
          <span class="result-count" id="result-count" aria-live="polite"></span>
        </div>
        <div class="model-grid" id="model-grid"></div>
      </section>

      <section class="container section" aria-labelledby="how-h">
        <div class="section-head">
          <div><h2 id="how-h">How it stays current</h2><p>A small pipeline, built with AI tools, runs every day with no servers to maintain.</p></div>
          <a class="btn btn-ghost" href="#/about">Learn more ${ICON.arrow}</a>
        </div>
        ${stepsHtml()}
      </section>`,
    after() {
      const tools = document.getElementById('catalog-tools');
      const state = {
        q: params.get('q') || '',
        show: params.get('show') || 'all',
        supplier: params.get('supplier') || '',
        sort: params.get('sort') || 'featured',
      };
      tools.querySelector('#f-supplier').value = state.supplier;
      tools.querySelector('#f-sort').value = state.sort;
      const update = () => {
        const next = new URLSearchParams();
        for (const [k, v] of Object.entries(state)) if (v && !(k === 'show' && v === 'all') && !(k === 'sort' && v === 'featured')) next.set(k, v);
        history.replaceState(null, '', next.toString() ? `#/?${next}` : '#/');
        renderCatalogResults(state);
      };
      tools.querySelectorAll('[data-show]').forEach((b) => b.addEventListener('click', () => { state.show = b.dataset.show; update(); }));
      tools.querySelector('#f-supplier').addEventListener('change', (e) => { state.supplier = e.target.value; update(); });
      tools.querySelector('#f-sort').addEventListener('change', (e) => { state.sort = e.target.value; update(); });
      headerSearchHandler = (q) => { state.q = q; update(); };
      renderCatalogResults(state);
      if (state.q || params.get('supplier') || params.get('show')) document.getElementById('models').scrollIntoView();
    },
  };
}

function renderCatalogResults(state) {
  const q = state.q.trim().toLowerCase();
  let products = [...idx.products.values()].filter((p) => {
    const text = `${p.model} ${p.supplier.name} ${p.kind || ''} ${p.market || ''} ${p.summary || ''}`.toLowerCase();
    return (!q || text.includes(q))
      && (!state.supplier || p.supplier.id === state.supplier)
      && (state.show !== 'specs' || specsOf(p.id).length);
  });
  const num = (p, keys) => pick(p.id, keys)?.numeric ?? -Infinity;
  const sorters = {
    featured: (a, b) => reviewedCount(b.id) - reviewedCount(a.id) || Number(!!a.auto) - Number(!!b.auto)
      || specsOf(b.id).length - specsOf(a.id).length || a.model.localeCompare(b.model, undefined, { numeric: true }),
    name: (a, b) => a.model.localeCompare(b.model, undefined, { numeric: true }),
    power: (a, b) => num(b, ['rated_kva', 'rated_kw']) - num(a, ['rated_kva', 'rated_kw']),
    efficiency: (a, b) => num(b, ['efficiency_max_pct', 'efficiency_with_mvt_pct']) - num(a, ['efficiency_max_pct', 'efficiency_with_mvt_pct']),
  };
  products.sort(sorters[state.sort] || sorters.featured);

  document.querySelectorAll('[data-show]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.show === state.show)));
  document.getElementById('result-count').textContent = plural(products.length, 'model');
  const grid = document.getElementById('model-grid');
  const limit = state.all || q || state.supplier ? Infinity : 12;
  const more = products.length > limit ? `<div class="full-row more-row"><button type="button" class="btn" id="show-all">Show all ${products.length} models</button></div>` : '';
  grid.innerHTML = products.length ? products.slice(0, limit).map(modelCard).join('') + more : `
    <div class="card empty full-row"><h3>No models match</h3><p>Try a different search or manufacturer.</p></div>`;
  grid.querySelector('#show-all')?.addEventListener('click', () => { state.all = true; renderCatalogResults(state); });
  grid.querySelectorAll('[data-compare]').forEach((btn) => btn.addEventListener('click', () => {
    if (!toggleCompare(btn.dataset.compare)) { btn.textContent = `Max ${MAX_COMPARE}`; return; }
    setCompareButton(btn, compareSet.has(btn.dataset.compare));
  }));
}

function modelCard(p) {
  const specs = specsOf(p.id);
  const docs = docsOf(p.id);
  const figure = (label, keys, note) => {
    const s = pick(p.id, keys);
    return `<div class="figure"><span>${label}</span><b>${s ? esc(formatValue(s)) : '—'}</b><small>${s && note ? esc(note(s)) : '&nbsp;'}</small></div>`;
  };
  const attention = specs.filter((s) => isAttention(s.status)).length;
  const body = specs.length ? `
    <div class="figures">
      ${figure('Power', ['rated_kva', 'rated_kw'], (s) => (s.field === 'rated_kva' ? 'apparent' : 'active'))}
      ${figure('DC max', ['dc_max_v'])}
      ${figure('Efficiency', ['efficiency_max_pct', 'efficiency_with_mvt_pct'], (s) => (s.field === 'efficiency_max_pct' ? 'converter' : 'incl. MVT'))}
    </div>` : `
    <div class="pending">${ICON.doc}<span>Specs not extracted yet — ${docs.length ? plural(docs.length, 'datasheet') + ' on file' : 'datasheet coming soon'}</span></div>`;
  const on = compareSet.has(p.id);
  return `
    <article class="card model-card">
      <div class="supplier"><span class="avatar">${esc(initials(p.supplier.name))}</span>${esc(p.supplier.name)}</div>
      <h3><a href="${modelHref(p.id)}">${esc(p.model)}</a></h3>
      <div class="chips">${[p.kind, p.market].filter(Boolean).map((c) => `<span class="chip">${esc(c)}</span>`).join('')}${p.auto ? `<span class="chip chip-auto" title="Found in a datasheet table and added automatically">${ICON.sparkle} Auto-added</span>` : ''}</div>
      ${body}
      <div class="card-foot">
        <span class="meta">${specs.length ? `${plural(specs.length, 'value')}${attention ? ` · ${attention} under review` : reviewedCount(p.id) ? ' · reviewed' : ' · auto-extracted'}` : '&nbsp;'}</span>
        <span class="foot-actions">
          ${specs.length ? `<button type="button" class="btn btn-sm ${on ? 'is-on' : ''}" data-compare="${esc(p.id)}" aria-pressed="${on}">${on ? `${ICON.check} Comparing` : `${ICON.plus} Compare`}</button>` : ''}
          <a class="btn btn-sm btn-ghost" href="${modelHref(p.id)}" aria-label="View ${esc(p.model)}">View ${ICON.arrow}</a>
        </span>
      </div>
    </article>`;
}

function setCompareButton(btn, on) {
  btn.classList.toggle('is-on', on);
  btn.setAttribute('aria-pressed', String(on));
  btn.innerHTML = on ? `${ICON.check} Comparing` : `${ICON.plus} Compare`;
}

function stepsHtml() {
  return `<div class="steps">
    <div class="card step"><h3>Watch</h3><p>A collector on a small home server visits each manufacturer's product page every day, politely and within their robots rules.</p></div>
    <div class="card step"><h3>Archive</h3><p>Each datasheet is fingerprinted. A changed file is saved as a new version; old versions are never deleted.</p></div>
    <div class="card step"><h3>Re-check</h3><p>Every published value is looked up again in the new version: confirmed, updated, or flagged for review.</p></div>
    <div class="card step"><h3>Publish</h3><p>Changes are pushed to GitHub and the site rebuilds on its own. Nobody has to press a button.</p></div>
  </div>`;
}

// ------------------------------------------------------------------ model page

function viewModel(id, params) {
  const p = idx.products.get(id);
  if (!p) return viewNotFound();
  const specs = specsOf(id);
  const docs = docsOf(id);
  const mainDoc = docs[0];
  const attention = specs.filter((s) => isAttention(s.status));

  const kpis = KPI_FIELDS.map((k) => ({ k, s: pick(id, k.keys) })).filter((x) => x.s);
  const kpiHtml = kpis.length ? `<div class="kpis">${kpis.map(({ k, s }) => `
    <div class="card kpi">
      <span>${esc(k.label)}</span>
      <b>${esc(formatValue(s))}</b>
      <small>${k.note ? esc(k.note(s)) + ' · ' : ''}<a href="${modelHref(id, s.field)}">source</a></small>
    </div>`).join('')}</div>` : '';

  const notice = attention.length ? `
    <div class="notice" role="note">${ICON.alert}
      <div><strong>The manufacturer published a new datasheet.</strong>
      ${attention.map((s) => `<a href="${modelHref(id, s.field)}">${esc(idx.fields.get(s.field)?.label || s.field)}</a>`).join(', ')}
      ${attention.length === 1 ? 'is' : 'are'} ${attention.some((s) => s.status === 'needs-check') ? 'being reviewed' : 'newly updated'} — the previous value and datasheet are kept for comparison.</div>
    </div>` : '';

  const autoCount = specs.filter((s) => s.status === 'extracted').length;
  const autoNote = autoCount ? `
    <div class="notice notice-info" role="note">${ICON.sparkle}
      <div>${autoCount === specs.length ? 'These values were' : `${plural(autoCount, 'value')} marked ${ICON.sparkle} ${autoCount === 1 ? 'was' : 'were'}`} read automatically from the datasheet table and haven't been reviewed by a person yet.
      Every one links to the page it came from, so it takes seconds to check.</div>
    </div>` : '';

  const members = (idx.familyMembers.get(id) || []).sort((a, b) => a.model.localeCompare(b.model, undefined, { numeric: true }));
  const familyHtml = members.length ? `
    <section class="section" aria-labelledby="family-h">
      <div class="section-head"><div><h2 id="family-h">Models in this family</h2><p>${plural(members.length, 'model')} found in these datasheets.</p></div></div>
      <div class="compare-wrap">
        <table class="compare-table family-table">
          <thead><tr><th>Model</th><th>Variant</th><th>Rated power</th><th>Grid voltage</th><th>Frequency</th><th>Peak efficiency</th></tr></thead>
          <tbody>${members.map((m) => {
            const cell = (keys) => { const v = pick(m.id, keys); return v ? esc(formatValue(v)) : '<span class="muted">—</span>'; };
            return `<tr><th scope="row"><a href="${modelHref(m.id)}">${esc(m.model)}</a></th><td>${esc(m.market || '')}</td>
              <td>${cell(['rated_kva', 'rated_kw'])}</td><td>${cell(['mv_voltage_kv'])}</td><td>${cell(['frequency_hz'])}</td>
              <td>${cell(['efficiency_max_pct', 'efficiency_with_mvt_pct'])}</td></tr>`;
          }).join('')}</tbody>
        </table>
      </div>
    </section>` : '';

  const groups = new Map();
  for (const field of db.fields) {
    const s = specs.find((x) => x.field === field.key);
    if (!s) continue;
    if (!groups.has(field.group)) groups.set(field.group, []);
    groups.get(field.group).push(specRow(s, field));
  }
  const sheet = specs.length ? `
    <section class="card spec-sheet" aria-label="Specifications">
      ${[...groups].map(([g, rows]) => `<div class="spec-group"><h2>${esc(g)}</h2>${rows.join('')}</div>`).join('')}
    </section>` : `
    ${members.length ? `<section class="card empty"><h3>A product family</h3><p>This family's datasheets list ${plural(members.length, 'model')}. Their values are shown per model below.</p></section>` : `<section class="card empty">
      <h3>Specifications not extracted yet</h3>
      <p>This model's datasheets are archived and watched for new versions. Their values will appear here once they've been extracted and checked.${docs.length ? ' The datasheets are available to download now.' : ''}</p>
    </section>`}`;

  const on = compareSet.has(id);
  return {
    title: p.model,
    html: `
      <div class="container page">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Models</a> / ${esc(p.supplier.name)}</nav>
        <div class="model-head">
          <div>
            <div class="supplier-line"><span class="avatar">${esc(initials(p.supplier.name))}</span>${esc(p.supplier.name)}</div>
            <h1>${esc(p.model)}</h1>
            ${p.summary ? `<p class="lead">${esc(p.summary)}</p>` : ''}
            <div class="chips">${[p.kind, p.market].filter(Boolean).map((c) => `<span class="chip">${esc(c)}</span>`).join('')}${p.auto ? `<span class="chip chip-auto">${ICON.sparkle} Auto-added</span>` : ''}${p.family && idx.products.get(p.family) ? `<a class="chip" href="${modelHref(p.family)}">Family: ${esc(idx.products.get(p.family).model)}</a>` : ''}</div>
          </div>
          <div class="model-actions">
            ${specs.length ? `<button class="btn ${on ? 'is-on' : ''}" type="button" id="compare-toggle" data-compare="${esc(id)}" aria-pressed="${on}">${on ? `${ICON.check} Comparing` : `${ICON.plus} Compare`}</button>` : ''}
            ${mainDoc ? `<a class="btn btn-primary" href="${esc(pdfHref(latestRev(mainDoc)))}" download>${ICON.download} Datasheet</a>` : ''}
          </div>
        </div>
        ${kpiHtml}
        ${notice}
        ${autoNote}
        <div class="model-layout">
          <div>${sheet}</div>
          <aside class="sidebar">
            ${docBox(docs)}
            <div class="card doc-box">
              <h2>About these values</h2>
              <p class="muted small">Each value is quoted from the datasheet page shown next to it — open a row to see the exact text and conditions.
              Ratings depend on conditions such as temperature, so compare like with like. <a href="#/about">How values are checked</a></p>
              ${p.supplier.website ? `<p class="small spaced"><a href="${esc(p.supplier.website)}" target="_blank" rel="noopener noreferrer">${esc(p.supplier.name)} website ↗</a></p>` : ''}
            </div>
          </aside>
        </div>
        ${familyHtml}
      </div>`,
    after() {
      document.querySelectorAll('.model-grid [data-compare]').forEach((b) => b.addEventListener('click', () => {
        if (!toggleCompare(b.dataset.compare)) { b.textContent = `Max ${MAX_COMPARE}`; return; }
        setCompareButton(b, compareSet.has(b.dataset.compare));
      }));
      const btn = document.getElementById('compare-toggle');
      btn?.addEventListener('click', () => {
        if (!toggleCompare(id)) { btn.textContent = `Max ${MAX_COMPARE} models`; return; }
        setCompareButton(btn, compareSet.has(id));
      });
      const field = params.get('f');
      const row = field && document.getElementById(`spec-${field}`);
      if (row) { row.open = true; row.scrollIntoView({ block: 'center' }); row.querySelector('summary').focus(); return true; }
      return false;
    },
  };
}

function specRow(spec, field) {
  const found = idx.revisions.get(spec.revision);
  const doc = found?.doc;
  const latest = doc ? latestRev(doc) : null;
  const olderSource = found && latest && latest.sha256 !== found.rev.sha256;
  const history = spec.history || [];
  const prev = history[0];
  const changed = prev && String(prev.value) !== String(spec.value);
  const meta = STATUS[spec.status] || {};

  const pageLink = found
    ? `<a class="page-link" href="${esc(pdfHref(found.rev, spec.page))}" target="_blank" rel="noopener" title="Open ${esc(doc.title)} at page ${esc(spec.page)}">p.&nbsp;${esc(spec.page)}</a>`
    : '';

  const historyHtml = history.length ? `
    <div class="history">
      <h3>Earlier versions of this value</h3>
      <ol>${history.map((h) => {
        const r = idx.revisions.get(h.revision);
        return `<li>
          <div class="line"><strong class="num">${esc(formatValue(spec, h.value))}</strong>
            ${r ? `<span class="muted">from the ${esc(fmtDate(r.rev.captured_at))} datasheet, p. ${esc(h.page)}</span>
            <a href="${esc(pdfHref(r.rev, h.page))}" target="_blank" rel="noopener">open ↗</a>` : ''}</div>
          ${h.evidence ? `<div class="quote">“${esc(h.evidence)}”</div>` : ''}
        </li>`;
      }).join('')}</ol>
    </div>` : '';

  return `
    <details class="spec-row" id="spec-${esc(spec.field)}">
      <summary>
        <span class="spec-label">${esc(field.label)}</span>
        <span class="spec-value">${esc(formatValue(spec))}${changed ? `<span class="was">${esc(formatValue(spec, prev.value))}</span>` : ''}${isAttention(spec.status) ? statusMark(spec.status) : ''}</span>
        <span class="spec-src">${isAttention(spec.status) ? '' : statusMark(spec.status)}${pageLink}${ICON.chev}</span>
      </summary>
      <div class="spec-detail">
        <div class="quote">“${esc(spec.evidence)}”</div>
        <dl>
          ${spec.conditions ? `<dt>Conditions</dt><dd>${esc(spec.conditions)}</dd>` : ''}
          <dt>Source</dt><dd>${found ? `${esc(doc.title)} · page ${esc(spec.page)} · version of ${esc(fmtDate(found.rev.captured_at))}` : '—'}</dd>
          ${olderSource ? `<dt>Newest datasheet</dt><dd>Published ${esc(fmtDate(latest.captured_at))} — this value isn't stated the same way there. <a href="${esc(pdfHref(latest))}" target="_blank" rel="noopener">Open newest version ↗</a></dd>` : ''}
          <dt>Status</dt><dd>${esc(meta.label || spec.status)} — ${esc(meta.text || '')}</dd>
          ${spec.reviewed_by ? `<dt>Reviewed by</dt><dd>${esc(spec.reviewed_by)}, ${esc(fmtDate(spec.reviewed_at))}</dd>` : ''}
          <dt>Last checked</dt><dd>${esc(fmtDate(spec.checked_at))}</dd>
        </dl>
        ${historyHtml}
      </div>
    </details>`;
}

function docBox(docs) {
  if (!docs.length) return `<div class="card doc-box"><h2>Datasheets</h2><p class="muted small">Not collected yet.</p></div>`;
  return `<div class="card doc-box">
    <h2>${docs.length === 1 ? 'Datasheet' : `Datasheets (${docs.length})`}</h2>
    ${docs.slice(0, 3).map((d) => docItem(d)).join('')}
    ${docs.length > 3 ? `<details class="versions doc-more"><summary>Show ${plural(docs.length - 3, 'more datasheet')}</summary>
      ${docs.slice(3).map((d) => docItem(d)).join('')}</details>` : ''}
  </div>`;
}

function docItem(d, { showModel = false } = {}) {
  const rev = latestRev(d);
  const older = d.revisions.slice(0, -1).reverse();
  const product = idx.products.get(d.product);
  return `<div class="doc-item">
    <div class="doc-title">${fileIcon}<div>${esc(d.title)}
      <div class="doc-meta">${showModel && product ? `<a href="${modelHref(product.id)}">${esc(product.model)}</a> · ` : ''}Version of ${esc(fmtDate(rev.captured_at))} · ${plural(rev.pages || 0, 'page')} · ${fmtBytes(rev.bytes)}</div></div></div>
    <div class="doc-actions">
      <a class="btn btn-sm" href="${esc(pdfHref(rev))}" download>${ICON.download} Download</a>
      <a class="btn btn-sm btn-ghost" href="${esc(pdfHref(rev))}" target="_blank" rel="noopener">${ICON.open} Open</a>
      <a class="btn btn-sm btn-ghost" href="${esc(d.url)}" target="_blank" rel="noopener noreferrer" title="The manufacturer's own copy">Manufacturer ↗</a>
    </div>
    ${older.length ? versionsList(older) : ''}
  </div>`;
}

function versionsList(older) {
  return `<details class="versions"><summary>${plural(older.length, 'earlier version')}</summary>
    <ol>${older.map((r) => `<li><span>${esc(fmtDate(r.captured_at))} · ${fmtBytes(r.bytes)}</span><a href="${esc(pdfHref(r))}" download>Download</a></li>`).join('')}</ol>
  </details>`;
}

// ------------------------------------------------------------------ compare

function viewCompare(ids, params) {
  ids.forEach((id) => { if (idx.products.has(id) && compareSet.size < MAX_COMPARE) compareSet.add(id); });
  if (ids.length) saveCompare();
  const chosen = [...compareSet].filter((id) => idx.products.has(id));
  const candidates = [...idx.products.values()].filter((p) => specsOf(p.id).length && !compareSet.has(p.id));
  const onlyDiff = params.get('diff') === '1';

  const addControl = chosen.length < MAX_COMPARE && candidates.length ? `
    <select id="add-model" aria-label="Add a model"><option value="">+ Add a model…</option>
      ${candidates.map((p) => `<option value="${esc(p.id)}">${esc(p.model)} — ${esc(p.supplier.name)}</option>`).join('')}
    </select>` : '';

  if (!chosen.length) {
    return {
      title: 'Compare',
      html: `<div class="container page">
        <div class="page-head"><h1>Compare models</h1><p>Pick up to ${MAX_COMPARE} models to see their specifications side by side.</p></div>
        <div class="card empty"><h3>Nothing selected yet</h3><p>Use <strong>Compare</strong> on any model, or add one here.</p>
          <div class="toolbar toolbar-center">${addControl}</div></div>
      </div>`,
      after: bindAddModel,
    };
  }

  const products = chosen.map((id) => idx.products.get(id));
  let body = '';
  let lastGroup = null;
  let shown = 0;
  for (const field of db.fields) {
    const specs = chosen.map((id) => specOf(id, field.key));
    if (specs.every((s) => !s)) continue;
    const present = specs.filter(Boolean).map((s) => String(s.numeric ?? s.value));
    const differs = present.length > 1 && new Set(present).size > 1;
    if (onlyDiff && !differs) continue;
    if (field.group !== lastGroup) {
      body += `<tr class="group-row"><th colspan="${products.length + 1}">${esc(field.group)}</th></tr>`;
      lastGroup = field.group;
    }
    shown += 1;
    body += `<tr class="${differs ? 'differs' : ''}"><th scope="row">${esc(field.label)}</th>${specs.map((s, i) => s
      ? `<td><a href="${modelHref(chosen[i], field.key)}" class="inherit">${esc(formatValue(s))}</a> ${isAttention(s.status) ? statusMark(s.status) : ''}</td>`
      : '<td class="none">—</td>').join('')}</tr>`;
  }

  return {
    title: 'Compare',
    html: `<div class="container page">
      <div class="page-head"><h1>Compare models</h1>
        <p>Rows marked with a bar differ between models. Ratings are only comparable at the same conditions — open a value to check.</p></div>
      <div class="toolbar">
        ${addControl}
        <label class="chip chip-toggle"><input type="checkbox" id="only-diff" ${onlyDiff ? 'checked' : ''}> Only differences</label>
        <span class="result-count"><button class="btn btn-sm btn-ghost" type="button" id="clear-compare">Clear all</button></span>
      </div>
      <div class="compare-wrap">
        <table class="compare-table">
          <thead><tr><th><span class="sr-only">Field</span></th>${products.map((p) => `
            <th><small>${esc(p.supplier.name)}</small><a href="${modelHref(p.id)}">${esc(p.model)}</a>
              <button class="btn btn-sm btn-ghost remove-btn" type="button" data-remove="${esc(p.id)}" aria-label="Remove ${esc(p.model)}">${ICON.close}</button></th>`).join('')}</tr></thead>
          <tbody>${shown ? body : `<tr><td colspan="${products.length + 1}" class="none">${onlyDiff ? 'No differences among the published values.' : 'No published values yet.'}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`,
    after() {
      bindAddModel();
      document.getElementById('only-diff').addEventListener('change', (e) => {
        location.hash = `#/compare${e.target.checked ? '?diff=1' : ''}`;
      });
      document.getElementById('clear-compare').addEventListener('click', () => { compareSet.clear(); saveCompare(); render(); });
      document.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => {
        compareSet.delete(b.dataset.remove); saveCompare(); render();
      }));
    },
  };
}

function bindAddModel() {
  document.getElementById('add-model')?.addEventListener('change', (e) => {
    if (e.target.value) { compareSet.add(e.target.value); saveCompare(); render(); }
  });
}

// ------------------------------------------------------------------ datasheets

function viewDatasheets(params) {
  const q = (params.get('q') || '').toLowerCase();
  const groups = db.suppliers.map((s) => ({
    s,
    docs: db.documents.filter((d) => d.supplier === s.id && (!q || `${d.title} ${idx.products.get(d.product)?.model || ''}`.toLowerCase().includes(q))),
  }));
  const shown = groups.filter((g) => g.docs.length);
  const waiting = groups.filter((g) => !db.documents.some((d) => d.supplier === g.s.id)).map((g) => g.s.name);
  const versions = db.documents.reduce((n, d) => n + d.revisions.length, 0);

  return {
    title: 'Datasheets',
    html: `<div class="container page">
      <div class="page-head"><h1>Datasheet library</h1>
        <p>${plural(db.documents.length, 'datasheet')} and ${plural(versions, 'version')} in total. Every version is kept, so you can always open the exact file a value came from — even after the manufacturer replaces it.</p></div>
      <div class="toolbar"><input type="search" id="ds-search" placeholder="Filter datasheets" value="${esc(params.get('q') || '')}" aria-label="Filter datasheets"></div>
      ${shown.length ? shown.map(({ s, docs }) => `
        <section class="lib-group">
          <h2><span class="avatar">${esc(initials(s.name))}</span>${esc(s.name)} <span class="count">${docs.length}</span></h2>
          <ul class="card lib-list">${docs.map(libRow).join('')}</ul>
        </section>`).join('') : '<div class="card empty"><h3>No datasheets match</h3></div>'}
      ${waiting.length && !q ? `<p class="muted small">Also tracking ${esc(waiting.join(', '))}. Their datasheets will appear here once collected.</p>` : ''}
    </div>`,
    after() {
      const input = document.getElementById('ds-search');
      input.addEventListener('input', () => {
        history.replaceState(null, '', input.value ? `#/datasheets?q=${encodeURIComponent(input.value)}` : '#/datasheets');
        render({ keepFocus: true });
      });
    },
  };
}

function libRow(d) {
  const rev = latestRev(d);
  const product = idx.products.get(d.product);
  const older = d.revisions.slice(0, -1).reverse();
  return `<li class="lib-row">
    ${fileIcon}
    <div>
      <div class="title">${esc(d.title)}</div>
      <div class="sub">${product ? `<a href="${modelHref(product.id)}">${esc(product.model)}</a> · ` : ''}Version of ${esc(fmtDate(rev.captured_at))} · ${plural(rev.pages || 0, 'page')} · ${fmtBytes(rev.bytes)}</div>
    </div>
    <div class="doc-actions flush">
      <a class="btn btn-sm" href="${esc(pdfHref(rev))}" download>${ICON.download}<span class="sr-only">Download </span>PDF</a>
      <a class="btn btn-sm btn-ghost" href="${esc(pdfHref(rev))}" target="_blank" rel="noopener" aria-label="Open ${esc(d.title)}">${ICON.open}</a>
    </div>
    ${older.length ? `<div class="versions-wrap">${versionsList(older)}</div>` : ''}
  </li>`;
}

// ------------------------------------------------------------------ updates

function viewUpdates() {
  const days = groupBy(db.changes, (c) => dayKey(c.at));
  const html = [...days].map(([, entries]) => {
    const events = [];
    const supplierOf = (c) => idx.documents.get(c.document)?.supplier || idx.products.get(c.product)?.supplier.id || '';
    const bucket = (type) => groupBy(entries.filter((c) => c.type === type), supplierOf);

    for (const [sid, list] of bucket('datasheet-revised')) {
      const s = idx.suppliers.get(sid);
      events.push(eventHtml('refresh', '',
        `${esc(s?.name || 'A manufacturer')} published ${list.length === 1 ? 'a new version of a datasheet' : `new versions of ${list.length} datasheets`}`,
        'Old versions are kept; values that depend on them were re-checked.',
        list.map((c) => {
          const d = idx.documents.get(c.document);
          const newer = idx.revisions.get(c.revision);
          const older = idx.revisions.get(c.previous_revision);
          return `<li>${esc(d?.title || c.document)} — ${newer ? `<a href="${esc(pdfHref(newer.rev))}" target="_blank" rel="noopener">new</a>` : ''}${older ? ` · <a href="${esc(pdfHref(older.rev))}" target="_blank" rel="noopener">previous</a>` : ''}</li>`;
        })));
    }
    for (const [sid, list] of bucket('new-datasheet')) {
      const s = idx.suppliers.get(sid);
      events.push(eventHtml('doc', '', `${plural(list.length, 'new datasheet')} from ${esc(s?.name || 'a manufacturer')}`, '',
        list.map((c) => {
          const d = idx.documents.get(c.document);
          const p = idx.products.get(c.product);
          return `<li>${esc(d?.title || c.document)}${p ? ` — <a href="${modelHref(p.id)}">${esc(p.model)}</a>` : ''}</li>`;
        })));
    }
    for (const c of entries.filter((x) => x.type === 'value-changed')) {
      const p = idx.products.get(c.product);
      const f = idx.fields.get(c.field);
      const spec = { field: c.field };
      events.push(eventHtml('refresh', '', `${esc(f?.label || c.field)} changed for <a href="${modelHref(c.product, c.field)}">${esc(p?.model || c.product)}</a>`,
        `<span class="diff"><span class="old">${esc(formatValue(spec, c.previous_value))}</span>→<strong>${esc(formatValue(spec, c.value))}</strong></span>`));
    }
    for (const c of entries.filter((x) => x.type === 'needs-check')) {
      const p = idx.products.get(c.product);
      const f = idx.fields.get(c.field);
      events.push(eventHtml('alert', 'warn', `${esc(f?.label || c.field)} is under review for <a href="${modelHref(c.product, c.field)}">${esc(p?.model || c.product)}</a>`,
        'The new datasheet words this differently. The last confirmed value stays visible until it is reviewed.'));
    }
    for (const [sid, list] of bucket('new-model')) {
      const s = idx.suppliers.get(sid);
      events.push(eventHtml('sparkle', '', `${plural(list.length, 'model')} from ${esc(s?.name || 'a manufacturer')} added from datasheet tables`,
        'Found automatically in the model columns of their datasheets.',
        list.map((c) => { const p = idx.products.get(c.product); return `<li><a href="${modelHref(c.product)}">${esc(p?.model || c.product)}</a></li>`; }), 'model'));
    }
    for (const [sid, list] of bucket('values-extracted')) {
      const s = idx.suppliers.get(sid);
      const total = list.reduce((n, c) => n + (c.count || 0), 0);
      events.push(eventHtml('sparkle', '', `${total.toLocaleString()} values read from ${plural(list.length, 'datasheet')} by ${esc(s?.name || 'a manufacturer')}`,
        'Read by the rules-based extractor; each value links to its datasheet page.',
        list.map((c) => { const d = idx.documents.get(c.document); return `<li>${esc(d?.title || c.document)} — ${esc(c.count)} values</li>`; })));
    }
    for (const c of entries.filter((x) => x.type === 'import')) {
      events.push(eventHtml('sparkle', '', 'Catalog launched', esc(c.summary.replace(/^Initial catalog:\s*/, ''))));
    }
    return `<li class="day"><time datetime="${esc(entries[0].at)}">${esc(fmtDay(entries[0].at))}</time><div class="events">${events.join('')}</div></li>`;
  }).join('');

  return {
    title: 'Updates',
    html: `<div class="container page">
      <div class="page-head"><h1>Updates</h1><p>What changed at the manufacturers, as the collector found it. Newest first.</p></div>
      ${html ? `<ol class="timeline">${html}</ol>` : '<div class="card empty"><h3>No updates yet</h3></div>'}
    </div>`,
  };
}

function eventHtml(icon, tone, title, sub, items = [], noun = 'file') {
  return `<div class="card event">
    <div class="event-head">
      <span class="event-icon ${tone}">${ICON[icon] || ICON.doc}</span>
      <div><div class="event-title">${title}</div>${sub ? `<div class="event-sub">${sub}</div>` : ''}</div>
    </div>
    ${items.length ? `<details><summary>Show ${plural(items.length, noun)}</summary><ul>${items.join('')}</ul></details>` : ''}
  </div>`;
}

// ------------------------------------------------------------------ about

function viewAbout() {
  const st = db.status || {};
  const sources = st.sources || [];
  return {
    title: 'How it works',
    html: `<div class="container page">
      <div class="page-head">
        <div class="eyebrow">About PCS Atlas</div>
        <h1>A catalog that keeps itself current</h1>
        <p>PCS Atlas shows what a small team can build and run with AI tools: an equipment database where every number is traceable to a manufacturer's document,
        and that updates itself without servers to maintain.</p>
      </div>
      ${stepsHtml()}

      <section class="section">
        <div class="section-head"><h2>What the value labels mean</h2></div>
        <div class="card legend">
          ${Object.entries(STATUS).map(([k, m]) => `<div>${m.tone === 'ok' ? `<span class="status status-ok">${ICON.check} ${esc(m.label)}</span>` : m.tone === 'auto' ? `<span class="status status-auto">${ICON.sparkle} ${esc(m.label)}</span>` : statusMark(k)}<span>${esc(m.text)}</span></div>`).join('')}
        </div>
      </section>

      <section class="section">
        <div class="section-head"><h2>Built with AI tools</h2></div>
        <div class="prose">
          <p>The site, the collector and the checks were written with AI coding assistants. The first values were read from the datasheets with an AI-assisted review
          and are labelled that way; each one quotes the datasheet line it came from so anyone can verify it in seconds.</p>
          <p>New datasheets are read by a rules-based extractor that runs on the collector — no AI service is called at runtime.
          It understands the common datasheet table layouts, ties each number to the model column it sits in, and keeps the exact text and page.
          Values it reads are labelled <em>auto-extracted</em> until a person reviews them. It was checked against the hand-reviewed values before going live.</p>
          <p>The automatic check is deliberately cautious: it only publishes a new number when the label before it and the unit after it still match,
          and the change is plausible. Anything else is marked <em>under review</em> rather than guessed.</p>
        </div>
      </section>

      <section class="section">
        <div class="section-head"><div><h2>Source status</h2><p>Last run ${esc(timeAgo(st.last_run_finished))}${st.last_run_finished ? ` (${esc(fmtDate(st.last_run_finished))})` : ''}.</p></div></div>
        ${sources.length ? `<div class="compare-wrap"><table class="health">
          <thead><tr><th>Source</th><th>Result</th><th>Notes</th></tr></thead>
          <tbody>${sources.map((s) => `<tr>
            <td>${esc(s.name)}</td>
            <td class="nowrap">${s.ok ? `<span class="dot ok"></span>${plural(s.files, 'file')}` : '<span class="dot bad"></span>Needs attention'}</td>
            <td class="muted">${esc(s.ok ? '' : friendlyError(s.error))}</td></tr>`).join('')}</tbody>
        </table></div>` : '<p class="muted">The collector has not reported a run yet.</p>'}
      </section>

      <section class="section">
        <div class="section-head"><h2>Limits worth knowing</h2></div>
        <ul class="limits">
          <li>Values come from public datasheets. They are not manufacturer-approved and don't replace project-specific documentation.</li>
          <li>Ratings depend on conditions (temperature, voltage, altitude). Apparent power (kVA) and active power (kW), and converter vs. transformer-inclusive efficiency, are kept separate and never mixed.</li>
          <li>Some manufacturer sites only offer datasheets through scripts or forms; those are added by hand.</li>
          <li>Datasheets are © their manufacturers and are archived only so values can be checked. Manufacturers can ask for a document to be removed.</li>
        </ul>
      </section>
    </div>`,
  };
}

function friendlyError(error) {
  const e = String(error || '');
  if (/No matching PDF links/.test(e)) return 'The page lists its downloads with scripts; a direct link is needed.';
  if (/HTTP 403/.test(e)) return 'The site refused the automated download.';
  if (/robots/.test(e)) return 'The site asks automated tools not to download this.';
  if (/Could not reach|resolve/.test(e)) return 'The site could not be reached.';
  return e.slice(0, 160);
}

function viewNotFound() {
  return { title: 'Not found', html: '<div class="container page"><div class="card empty"><h3>Page not found</h3><p><a href="#/">Back to the models</a></p></div></div>' };
}

// ------------------------------------------------------------------ shell

let headerSearchHandler = null;

function renderTray() {
  const tray = document.getElementById('compare-tray');
  const route = parseRoute().name;
  if (!compareSet.size || route === 'compare') { tray.hidden = true; return; }
  const names = [...compareSet].map((id) => idx.products.get(id)?.model).filter(Boolean);
  tray.hidden = false;
  tray.innerHTML = `<span class="names"><strong>${compareSet.size}</strong> selected · ${esc(names.join(', '))}</span>
    <a class="btn btn-primary" href="#/compare">Compare ${ICON.arrow}</a>
    <button class="btn btn-ghost" type="button" id="tray-clear" aria-label="Clear comparison">${ICON.close}</button>`;
  tray.querySelector('#tray-clear').addEventListener('click', () => {
    compareSet.clear(); saveCompare();
    document.querySelectorAll('[data-compare]').forEach((b) => setCompareButton(b, false));
  });
}

function parseRoute() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = hash.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const aliases = { changes: 'updates' };
  const name = parts[0] ? (aliases[parts[0]] || parts[0]) : 'catalog';
  return { name, arg: parts[1] || '', params: new URLSearchParams(query) };
}

const scrollPositions = new Map();
let navigatedByLink = false;
let currentHash = null;
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function scrollToSection(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
}

function render({ keepFocus = false } = {}) {
  // Old-style in-page anchors (#models): show the catalog and scroll to the section.
  if (location.hash && !location.hash.startsWith('#/')) {
    const target = location.hash.slice(1);
    history.replaceState(null, '', '#/');
    render();
    scrollToSection(target);
    return;
  }
  if (currentHash !== null) scrollPositions.set(currentHash, window.scrollY);
  const restoreTo = !navigatedByLink && !keepFocus ? scrollPositions.get(location.hash || '#/') : undefined;
  navigatedByLink = false;
  currentHash = location.hash || '#/';
  const route = parseRoute();
  headerSearchHandler = null;
  const views = {
    catalog: () => viewHome(route.params),
    model: () => viewModel(route.arg, route.params),
    compare: () => viewCompare(route.arg ? route.arg.split(',') : [], route.params),
    datasheets: () => viewDatasheets(route.params),
    updates: () => viewUpdates(),
    about: () => viewAbout(),
  };
  const view = (views[route.name] || viewNotFound)();

  const activeId = document.activeElement?.id;
  const main = document.getElementById('main');
  main.innerHTML = view.html;
  document.title = `${view.title} · PCS Atlas`;
  const navRoute = route.name === 'model' ? 'catalog' : route.name;
  document.querySelectorAll('#site-nav a').forEach((a) => {
    if (a.dataset.route === navRoute) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.getElementById('site-nav').classList.remove('open');
  document.getElementById('menu-button').setAttribute('aria-expanded', 'false');
  const search = document.querySelector('#header-search input');
  if (route.name === 'catalog') search.value = route.params.get('q') || '';

  const handledFocus = view.after?.();
  renderTray();
  if (handledFocus) return;
  if (keepFocus && activeId) {
    const el = document.getElementById(activeId);
    if (el) { el.focus(); if (el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length); return; }
  }
  if (!keepFocus) {
    main.focus({ preventScroll: true });
    // Back/forward returns to where you were; following a link starts at the top.
    window.scrollTo(0, restoreTo ?? 0);
  }
}

function bindShell() {
  const menu = document.getElementById('menu-button');
  const nav = document.getElementById('site-nav');
  menu.addEventListener('click', () => {
    const open = !nav.classList.contains('open');
    nav.classList.toggle('open', open);
    menu.setAttribute('aria-expanded', String(open));
  });
  const form = document.getElementById('header-search');
  const input = form.querySelector('input');
  input.addEventListener('input', () => { if (headerSearchHandler) headerSearchHandler(input.value); });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (headerSearchHandler) { scrollToSection('models'); return; }
    location.hash = input.value ? `#/?q=${encodeURIComponent(input.value)}` : '#/';
  });
  window.addEventListener('hashchange', () => render());
  history.scrollRestoration = 'manual';
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href^="#"]');
    if (!link) return;
    if (link.dataset.scrollTo) {
      e.preventDefault();
      scrollToSection(link.dataset.scrollTo);
      return;
    }
    navigatedByLink = true;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) { input.value = ''; input.dispatchEvent(new Event('input')); }
  });
}

async function start() {
  try {
    await loadData();
  } catch (err) {
    document.getElementById('main').innerHTML = `<div class="container page"><div class="card empty"><h3>The catalog couldn't load</h3><p>${esc(err.message)}. Please try again in a moment.</p></div></div>`;
    return;
  }
  bindShell();
  render({ keepFocus: true });
}

start();
