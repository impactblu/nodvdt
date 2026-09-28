// PCS Atlas — public, read-only catalog.
// All content comes from the JSON files in /data, which the NAS collector
// keeps up to date and pushes to GitHub. There is no server and no login.

// When previewing from the repository (…/site/index.html) data lives one level up.
const ROOT = location.pathname.includes('/site/') ? '../' : './';
const MAX_COMPARE = 4;

const STATUS = {
  'reviewed': {
    label: 'Reviewed',
    text: 'Checked against the datasheet page by a reviewer.',
  },
  'confirmed': {
    label: 'Auto-confirmed',
    text: 'The datasheet was revised and the same text was found again in the new revision.',
  },
  'updated': {
    label: 'Auto-updated',
    text: 'A new datasheet revision shows a different number. Published automatically and not yet reviewed; the previous value and datasheet stay linked for comparison.',
  },
  'needs-check': {
    label: 'Needs check',
    text: 'The datasheet was revised and this value could not be found in the new revision. The value shown comes from the previous revision.',
  },
};

const CHANGE_TYPES = {
  'import': 'Catalog created',
  'new-datasheet': 'New datasheet',
  'datasheet-revised': 'Datasheet revised',
  'value-changed': 'Value changed',
  'needs-check': 'Needs check',
};

const db = {};            // raw JSON
const idx = {};           // lookups built from it
const compareSet = new Set();

// ---------------------------------------------------------------- utilities

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const fmtDate = (iso) => iso
  ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  : '—';

const fmtDateTime = (iso) => iso
  ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—';

const fmtBytes = (n) => n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const icon = {
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M4 17v4h16v-4"/></svg>',
  page: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H5v20h14V7zM14 2v5h5M8 13h8M8 17h5"/></svg>',
  external: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7M21 3l-9 9M10 4H3v17h17v-7"/></svg>',
};

function badge(status) {
  const meta = STATUS[status] || { label: status, text: '' };
  return `<span class="badge ${esc(status)}" title="${esc(meta.text)}">${esc(meta.label)}</span>`;
}

function formatValue(spec) {
  const field = idx.fields.get(spec.field) || { unit: '' };
  const value = String(spec.value);
  const unit = field.unit && !value.endsWith(field.unit) ? ` ${field.unit}` : '';
  return `${value}${unit}`;
}

function pdfLink(revision, page) {
  return ROOT + revision.file.split('/').map(encodeURIComponent).join('/') + (page ? `#page=${page}` : '');
}

function revisionName(revision) {
  return `${fmtDate(revision.captured_at)} revision`;
}

async function loadJson(name, fallback) {
  try {
    const response = await fetch(`${ROOT}data/${name}.json`, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`${name}.json: HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw error;
  }
}

// ---------------------------------------------------------------- data

async function loadData() {
  const [suppliers, fields, documents, specs, changes, status] = await Promise.all([
    loadJson('suppliers'), loadJson('fields'), loadJson('documents'), loadJson('specs'),
    loadJson('changes', []), loadJson('status', {}),
  ]);
  Object.assign(db, { suppliers, fields, documents, specs, changes, status });

  idx.fields = new Map(fields.map((f) => [f.key, f]));
  idx.suppliers = new Map(suppliers.map((s) => [s.id, s]));
  idx.products = new Map();
  for (const supplier of suppliers) {
    for (const product of supplier.products || []) {
      idx.products.set(product.id, { ...product, supplier });
    }
  }
  idx.documents = new Map(documents.map((d) => [d.id, d]));
  idx.revisions = new Map();
  for (const doc of documents) {
    doc.revisions.forEach((rev, i) => idx.revisions.set(rev.sha256, { doc, rev, number: i + 1 }));
  }
  idx.specsByProduct = groupBy(specs, (s) => s.product);
  idx.docsByProduct = groupBy(documents, (d) => d.product);
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

function specValue(productId, fieldKey) {
  return (idx.specsByProduct.get(productId) || []).find((s) => s.field === fieldKey);
}

// Headline numbers for the catalog table. Power and efficiency are labelled
// with what they are (kVA vs kW, converter vs including transformer) — never mixed.
function headline(productId) {
  const pick = (...keys) => keys.map((k) => specValue(productId, k)).find(Boolean);
  return {
    power: pick('rated_kva', 'rated_kw'),
    dcMax: pick('dc_max_v'),
    efficiency: pick('efficiency_max_pct', 'efficiency_with_mvt_pct'),
    gfm: pick('gfm'),
  };
}

// ---------------------------------------------------------------- views

function viewCatalog(params) {
  const query = (params.get('q') || '').toLowerCase();
  const supplierFilter = params.get('supplier') || '';
  const withValues = params.get('values') === '1';

  const products = [...idx.products.values()].filter((p) => {
    const text = `${p.model} ${p.supplier.name} ${p.kind || ''} ${p.market || ''}`.toLowerCase();
    if (query && !text.includes(query)) return false;
    if (supplierFilter && p.supplier.id !== supplierFilter) return false;
    if (withValues && !(idx.specsByProduct.get(p.id) || []).length) return false;
    return true;
  });

  const valueCount = db.specs.length;
  const reviewedModels = [...idx.specsByProduct.keys()].length;
  const attention = db.specs.filter((s) => s.status === 'updated' || s.status === 'needs-check').length;

  const cell = (spec, extra = '') => spec
    ? `<td class="num">${esc(formatValue(spec))}<span class="dot ${esc(spec.status)}" title="${esc(STATUS[spec.status]?.label)}"></span>${extra}</td>`
    : '<td class="muted">—</td>';

  const rows = products.map((p) => {
    const h = headline(p.id);
    const docs = idx.docsByProduct.get(p.id) || [];
    const count = (idx.specsByProduct.get(p.id) || []).length;
    const powerKind = h.power ? ` <span class="sub">${h.power.field === 'rated_kva' ? 'apparent' : 'active'}</span>` : '';
    const effKind = h.efficiency ? ` <span class="sub">${h.efficiency.field === 'efficiency_max_pct' ? 'converter' : 'incl. MV transformer'}</span>` : '';
    return `<tr>
      <td><input type="checkbox" data-compare="${esc(p.id)}" aria-label="Compare ${esc(p.model)}" ${compareSet.has(p.id) ? 'checked' : ''}></td>
      <td class="row-title"><a href="#/model/${encodeURIComponent(p.id)}">${esc(p.model)}</a><span class="sub">${esc(p.supplier.name)}${p.kind ? ` · ${esc(p.kind)}` : ''}</span></td>
      ${cell(h.power, powerKind)}
      ${cell(h.dcMax)}
      ${cell(h.efficiency, effKind)}
      <td>${count ? plural(count, 'value') : '<span class="muted">Datasheets only</span>'}</td>
      <td>${docs.length}</td>
    </tr>`;
  }).join('');

  const supplierOptions = db.suppliers.map((s) =>
    `<option value="${esc(s.id)}" ${s.id === supplierFilter ? 'selected' : ''}>${esc(s.name)}</option>`).join('');

  return {
    title: 'Catalog',
    html: `
      <div class="page-head">
        <div class="eyebrow">Utility-scale battery storage</div>
        <h1>Power conversion system catalog</h1>
        <p>Specifications of battery storage inverters (PCS), each linked to the exact page of the manufacturer's datasheet it came from.
        A collector checks the manufacturers' websites for new datasheet revisions and updates this site automatically.</p>
      </div>
      <div class="stats">
        <div class="stat"><b>${db.suppliers.length}</b><span>suppliers</span></div>
        <div class="stat"><b>${idx.products.size}</b><span>models &amp; families</span></div>
        <div class="stat"><b>${valueCount}</b><span>sourced values (${reviewedModels} models)</span></div>
        <div class="stat"><b>${db.documents.length}</b><span>archived datasheets</span></div>
        ${attention ? `<div class="stat"><b>${attention}</b><span><a href="#/changes">values to double-check</a></span></div>` : ''}
      </div>
      <form class="toolbar" id="filters" role="search">
        <input type="search" name="q" value="${esc(params.get('q') || '')}" placeholder="Search model, supplier, market…" aria-label="Search">
        <select name="supplier" aria-label="Supplier"><option value="">All suppliers</option>${supplierOptions}</select>
        <label class="check"><input type="checkbox" name="values" value="1" ${withValues ? 'checked' : ''}> With values only</label>
        <span class="spacer"></span>
        <a class="btn primary" id="compare-btn" href="#/compare/${[...compareSet].map(encodeURIComponent).join(',')}">Compare (${compareSet.size})</a>
      </form>
      <div class="table-wrap">
        <table>
          <thead><tr><th><span class="sr-only">Compare</span></th><th>Model</th><th>Rated power</th><th>Max DC voltage</th><th>Max efficiency</th><th>Values</th><th>Datasheets</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="7" class="muted">No models match these filters.</td></tr>'}</tbody>
        </table>
      </div>
      <p class="small muted mt">Dots show each value's status: ${Object.keys(STATUS).map((k) => `<span class="dot ${k}"></span> ${STATUS[k].label}`).join(' · ')}.
      Only values published from a datasheet are shown; blank means not yet captured, not "not available".</p>`,
    after() {
      const form = document.getElementById('filters');
      form.addEventListener('input', () => {
        const data = new FormData(form);
        const next = new URLSearchParams();
        for (const [k, v] of data) if (v) next.set(k, v);
        history.replaceState(null, '', `#/?${next}`);
        render({ keepFocus: true });
      });
      form.addEventListener('submit', (e) => e.preventDefault());
      document.querySelectorAll('[data-compare]').forEach((box) => box.addEventListener('change', () => {
        if (box.checked) {
          if (compareSet.size >= MAX_COMPARE) { box.checked = false; alertCompareLimit(); return; }
          compareSet.add(box.dataset.compare);
        } else {
          compareSet.delete(box.dataset.compare);
        }
        const btn = document.getElementById('compare-btn');
        btn.textContent = `Compare (${compareSet.size})`;
        btn.href = `#/compare/${[...compareSet].map(encodeURIComponent).join(',')}`;
      }));
    },
  };
}

function alertCompareLimit() {
  const btn = document.getElementById('compare-btn');
  btn.textContent = `Up to ${MAX_COMPARE} models`;
  setTimeout(() => { btn.textContent = `Compare (${compareSet.size})`; }, 1500);
}

function specDetails(spec) {
  const found = idx.revisions.get(spec.revision);
  const doc = found?.doc;
  const latest = doc ? doc.revisions[doc.revisions.length - 1] : null;
  const isOld = found && latest && latest.sha256 !== found.rev.sha256;
  const history = spec.history || [];
  const previous = history[0];
  const changed = previous && String(previous.value) !== String(spec.value);

  const source = found ? `
    Page ${esc(spec.page)} of <strong>${esc(doc.title)}</strong>, ${esc(revisionName(found.rev))}
    <div class="doc-actions">
      <a class="btn" href="${esc(pdfLink(found.rev, spec.page))}" target="_blank" rel="noopener">${icon.page}Open page ${esc(spec.page)}</a>
      <a class="btn" href="${esc(pdfLink(found.rev))}" download>${icon.download}Download PDF</a>
      <a class="btn" href="${esc(doc.url)}" target="_blank" rel="noopener noreferrer">${icon.external}Manufacturer's copy</a>
    </div>` : '<span class="muted">Source revision not found.</span>';

  const latestNote = isOld ? `
    <dt>Latest datasheet</dt>
    <dd>${esc(revisionName(latest))} — this value was not found in it.
      <div class="doc-actions"><a class="btn" href="${esc(pdfLink(latest))}" target="_blank" rel="noopener">${icon.page}Open latest revision</a></div></dd>` : '';

  const historyHtml = history.length ? `
    <div class="history">
      <h4>Earlier states</h4>
      <ol>${history.map((h) => {
        const r = idx.revisions.get(h.revision);
        const link = r ? ` · <a href="${esc(pdfLink(r.rev, h.page))}" target="_blank" rel="noopener">${esc(revisionName(r.rev))}, p. ${esc(h.page)}</a>` : '';
        return `<li><strong>${esc(formatValue({ ...spec, value: h.value }))}</strong> ${badge(h.status)}${link}
          ${h.evidence ? `<div class="quote">${esc(h.evidence)}</div>` : ''}</li>`;
      }).join('')}</ol>
    </div>` : '';

  const field = idx.fields.get(spec.field) || { label: spec.field };
  return `
    <details class="spec" id="spec-${esc(spec.field)}">
      <summary>
        <span class="spec-label">${esc(field.label)}</span>
        <span class="spec-value">${esc(formatValue(spec))}${changed ? `<span class="was">was ${esc(formatValue({ ...spec, value: previous.value }))}</span>` : ''}</span>
        ${badge(spec.status)}
      </summary>
      <div class="spec-body">
        <dl>
          <dt>Datasheet text</dt><dd><div class="quote">${esc(spec.evidence)}</div></dd>
          ${spec.conditions ? `<dt>Conditions</dt><dd>${esc(spec.conditions)}</dd>` : ''}
          <dt>Source</dt><dd>${source}</dd>
          ${latestNote}
          <dt>Status</dt><dd>${badge(spec.status)} ${esc(STATUS[spec.status]?.text || '')}</dd>
          ${spec.reviewed_by ? `<dt>Reviewed by</dt><dd>${esc(spec.reviewed_by)}, ${esc(fmtDate(spec.reviewed_at))}</dd>` : ''}
          <dt>Last checked</dt><dd>${esc(fmtDateTime(spec.checked_at))}</dd>
        </dl>
        ${historyHtml}
      </div>
    </details>`;
}

function datasheetList(docs, { showProduct = false } = {}) {
  if (!docs.length) return '<p class="muted">No datasheets archived yet.</p>';
  return docs.map((doc) => {
    const revs = doc.revisions;
    const latest = revs[revs.length - 1];
    const product = idx.products.get(doc.product);
    const older = revs.slice(0, -1).reverse();
    return `<div class="doc">
      <div class="doc-title">${esc(doc.title)}</div>
      <div class="small muted">
        ${showProduct && product ? `<a href="#/model/${encodeURIComponent(product.id)}">${esc(product.model)}</a> · ` : ''}
        ${esc(revisionName(latest))} · ${plural(latest.pages || 0, 'page')} · ${fmtBytes(latest.bytes)} · checked ${esc(fmtDate(doc.last_checked))}
      </div>
      <div class="doc-actions">
        <a class="btn" href="${esc(pdfLink(latest))}" download>${icon.download}Download</a>
        <a class="btn" href="${esc(pdfLink(latest))}" target="_blank" rel="noopener">${icon.page}Open</a>
        <a class="btn" href="${esc(doc.url)}" target="_blank" rel="noopener noreferrer">${icon.external}Manufacturer</a>
      </div>
      ${older.length ? `<ol class="revisions" reversed>${older.map((r) => `
        <li>${esc(revisionName(r))} — <a href="${esc(pdfLink(r))}" download>download</a> <span class="mono">${esc(r.sha256.slice(0, 12))}</span></li>`).join('')}
      </ol>` : ''}
    </div>`;
  }).join('');
}

function viewModel(id) {
  const product = idx.products.get(id);
  if (!product) return viewNotFound();
  const specs = idx.specsByProduct.get(id) || [];
  const docs = idx.docsByProduct.get(id) || [];

  const groups = new Map();
  for (const field of db.fields) {
    const spec = specs.find((s) => s.field === field.key);
    if (!spec) continue;
    if (!groups.has(field.group)) groups.set(field.group, []);
    groups.get(field.group).push(specDetails(spec));
  }
  const specHtml = specs.length
    ? [...groups].map(([group, items]) => `<div class="spec-group"><h3>${esc(group)}</h3>${items.join('')}</div>`).join('')
    : `<p class="muted">No values have been published for this model yet. Its datasheets are archived on the right and are checked for updates automatically.</p>`;

  const counts = Object.keys(STATUS).map((k) => [k, specs.filter((s) => s.status === k).length]).filter(([, n]) => n);

  return {
    title: product.model,
    html: `
      <p class="small"><a href="#/">← Catalog</a></p>
      <div class="page-head">
        <div class="eyebrow">${esc(product.supplier.name)}${product.kind ? ` · ${esc(product.kind)}` : ''}${product.market ? ` · ${esc(product.market)}` : ''}</div>
        <h1>${esc(product.model)}</h1>
        ${product.notes ? `<p>${esc(product.notes)}</p>` : ''}
        ${counts.length ? `<p>${counts.map(([k, n]) => `${badge(k)} ${n}`).join(' &nbsp; ')}</p>` : ''}
        <div class="doc-actions">
          <button class="btn" type="button" id="add-compare">${compareSet.has(id) ? 'Added to compare' : 'Add to compare'}</button>
          ${specs.length ? '<button class="btn" type="button" id="expand-all">Show all sources</button>' : ''}
        </div>
      </div>
      <div class="grid-2">
        <section class="card" aria-labelledby="specs-h">
          <h2 id="specs-h">Specifications</h2>
          <p class="small muted">Open a row to see the datasheet text, the page it's on, and any earlier values.</p>
          ${specHtml}
        </section>
        <aside class="card" aria-labelledby="docs-h">
          <h2 id="docs-h">Datasheets</h2>
          ${datasheetList(docs)}
          ${product.supplier.website ? `<p class="small mt"><a href="${esc(product.supplier.website)}" target="_blank" rel="noopener noreferrer">${esc(product.supplier.name)} website</a></p>` : ''}
        </aside>
      </div>`,
    after() {
      document.getElementById('add-compare')?.addEventListener('click', (e) => {
        if (!compareSet.has(id) && compareSet.size >= MAX_COMPARE) { e.target.textContent = `Up to ${MAX_COMPARE} models`; return; }
        compareSet.add(id);
        e.target.textContent = 'Added to compare';
      });
      document.getElementById('expand-all')?.addEventListener('click', (e) => {
        const all = [...document.querySelectorAll('details.spec')];
        const open = !all.every((d) => d.open);
        all.forEach((d) => { d.open = open; });
        e.target.textContent = open ? 'Hide sources' : 'Show all sources';
      });
    },
  };
}

function viewCompare(ids) {
  const chosen = ids.filter((id) => idx.products.has(id)).slice(0, MAX_COMPARE);
  ids.forEach((id) => { if (idx.products.has(id)) compareSet.add(id); });
  if (!chosen.length) {
    const suggestions = [...idx.specsByProduct.keys()];
    return {
      title: 'Compare',
      html: `<div class="page-head"><h1>Compare models</h1>
        <p>Tick up to ${MAX_COMPARE} models in the <a href="#/">catalog</a>, then choose Compare.</p>
        ${suggestions.length > 1 ? `<p><a class="btn primary" href="#/compare/${suggestions.map(encodeURIComponent).join(',')}">Compare the models that have values</a></p>` : ''}</div>`,
    };
  }
  const products = chosen.map((id) => idx.products.get(id));
  const rows = db.fields.map((field) => {
    const specs = chosen.map((id) => specValue(id, field.key));
    if (specs.every((s) => !s)) return '';
    // Highlight only when at least two models have a value and they disagree.
    const present = specs.filter(Boolean).map((s) => String(s.numeric ?? s.value));
    const differs = present.length > 1 && new Set(present).size > 1;
    return `<tr><th scope="row">${esc(field.label)}</th>${specs.map((s, i) => s
      ? `<td class="num ${differs ? 'diff' : ''}"><a href="#/model/${encodeURIComponent(chosen[i])}?f=${esc(field.key)}">${esc(formatValue(s))}</a><span class="dot ${esc(s.status)}" title="${esc(STATUS[s.status]?.label)}"></span></td>`
      : '<td class="muted">—</td>').join('')}</tr>`;
  }).join('');

  return {
    title: 'Compare',
    html: `
      <div class="page-head"><h1>Compare models</h1>
        <p>Highlighted cells differ between models. Open any value to see the datasheet page it came from.
        Ratings are only comparable at the same conditions (temperature, voltage) — check each value's conditions.</p></div>
      <div class="table-wrap">
        <table class="compare">
          <thead><tr><th>Field</th>${products.map((p) => `<th><a href="#/model/${encodeURIComponent(p.id)}">${esc(p.model)}</a><span class="sub">${esc(p.supplier.name)}</span></th>`).join('')}</tr></thead>
          <tbody>${rows || `<tr><td colspan="${products.length + 1}" class="muted">None of these models have published values yet.</td></tr>`}</tbody>
        </table>
      </div>
      <p class="mt"><button class="btn" type="button" id="clear-compare">Clear selection</button></p>`,
    after() {
      document.getElementById('clear-compare').addEventListener('click', () => {
        compareSet.clear();
        location.hash = '#/compare';
      });
    },
  };
}

function viewDatasheets() {
  const sections = db.suppliers.map((supplier) => {
    const docs = db.documents.filter((d) => d.supplier === supplier.id);
    const sources = (supplier.products || []).flatMap((p) => p.sources || []);
    return `<section class="card">
      <h2>${esc(supplier.name)}</h2>
      ${docs.length ? datasheetList(docs, { showProduct: true })
        : `<p class="muted">No datasheets archived yet. ${sources.length ? `${plural(sources.length, 'source')} being watched.` : ''}</p>`}
    </section>`;
  }).join('');
  const revisions = db.documents.reduce((n, d) => n + d.revisions.length, 0);
  return {
    title: 'Datasheets',
    html: `<div class="page-head"><h1>Datasheet archive</h1>
      <p>${plural(db.documents.length, 'datasheet')}, ${plural(revisions, 'revision')}. Every revision the collector has seen is kept,
      so you can always open the exact file a value was read from — even after the manufacturer replaces it.</p></div>
      ${sections}`,
  };
}

function viewChanges(params) {
  const type = params.get('type') || '';
  const entries = db.changes.filter((c) => !type || c.type === type);
  const options = Object.entries(CHANGE_TYPES).map(([k, v]) =>
    `<option value="${k}" ${k === type ? 'selected' : ''}>${esc(v)}</option>`).join('');

  const revLink = (sha, label) => {
    const r = idx.revisions.get(sha);
    return r ? `<a href="${esc(pdfLink(r.rev))}" target="_blank" rel="noopener">${esc(label)} (${esc(fmtDate(r.rev.captured_at))})</a>` : '';
  };

  const items = entries.map((c) => {
    const product = idx.products.get(c.product);
    const links = [
      product ? `<a href="#/model/${encodeURIComponent(product.id)}">${esc(product.model)}</a>` : '',
      c.revision ? revLink(c.revision, 'new datasheet') : '',
      c.previous_revision ? revLink(c.previous_revision, 'previous datasheet') : '',
    ].filter(Boolean).join(' · ');
    return `<li><time datetime="${esc(c.at)}">${esc(fmtDateTime(c.at))}</time>
      <div><span class="badge plain">${esc(CHANGE_TYPES[c.type] || c.type)}</span> ${esc(c.summary)}
      ${links ? `<div class="small">${links}</div>` : ''}</div></li>`;
  }).join('');

  const attention = db.specs.filter((s) => s.status === 'updated' || s.status === 'needs-check');
  const attentionHtml = attention.length ? `<section class="card"><h2>Values to double-check</h2>
    <p class="small muted">These were changed or flagged by the automatic check and haven't been reviewed since.</p>
    <ul>${attention.map((s) => {
      const p = idx.products.get(s.product);
      const f = idx.fields.get(s.field);
      return `<li>${badge(s.status)} <a href="#/model/${encodeURIComponent(s.product)}?f=${esc(s.field)}">${esc(p?.model)} — ${esc(f?.label || s.field)}: ${esc(formatValue(s))}</a></li>`;
    }).join('')}</ul></section>` : '';

  return {
    title: 'Changes',
    html: `<div class="page-head"><h1>What changed</h1>
      <p>Everything the collector found, newest first. The full record is also in the repository's commit history.</p></div>
      ${attentionHtml}
      <form class="toolbar" id="change-filter"><select name="type" aria-label="Type of change"><option value="">All changes</option>${options}</select></form>
      <section class="card">${items ? `<ol class="timeline">${items}</ol>` : '<p class="muted">Nothing recorded yet.</p>'}</section>`,
    after() {
      const form = document.getElementById('change-filter');
      form.addEventListener('change', () => {
        const value = new FormData(form).get('type');
        history.replaceState(null, '', value ? `#/changes?type=${encodeURIComponent(value)}` : '#/changes');
        render({ keepFocus: true });
      });
    },
  };
}

function viewAbout() {
  const status = db.status || {};
  const sources = status.sources || [];
  const sourceRows = sources.map((s) => {
    const product = idx.products.get(s.product);
    return `<tr><td>${esc(s.name)}<span class="sub">${esc(product?.model || '')}</span></td>
      <td>${s.ok ? '<span class="badge reviewed">OK</span>' : '<span class="badge needs-check">Problem</span>'}</td>
      <td class="num">${esc(s.files)}</td><td class="small">${esc(s.error || '')}</td></tr>`;
  }).join('');

  return {
    title: 'How it works',
    html: `<div class="page-head"><h1>How this catalog works</h1>
      <p>PCS Atlas is a demonstration of what a small team can build and run with AI tools: a source-linked equipment database that keeps itself up to date,
      with no servers to maintain and every number traceable to a manufacturer's document.</p></div>

      <section class="card"><h2>The pipeline</h2>
        <div class="pipeline">
          <div><strong>Watch</strong>A collector in a Docker container on a NAS visits each manufacturer's product page ${esc(status.interval_hours ? `every ${status.interval_hours} hours` : 'on a schedule')}, politely and within robots.txt rules.</div>
          <div><strong>Archive</strong>Every datasheet is fingerprinted (SHA-256). A changed file is saved as a new revision; old revisions are never deleted.</div>
          <div><strong>Re-check</strong>For each published value, the collector looks for the same datasheet line in the new revision and updates or flags the value.</div>
          <div><strong>Publish</strong>The collector pushes the data and files to GitHub, and the static site is rebuilt and served by Vercel. Visitors never connect to the NAS.</div>
        </div>
      </section>

      <section class="card"><h2>What the value labels mean</h2>
        <div class="legend">${Object.keys(STATUS).map((k) => `<div>${badge(k)}<span>${esc(STATUS[k].text)}</span></div>`).join('')}</div>
        <p class="small muted mt">Changes go live immediately. That's why every value keeps its previous state and a link to the previous datasheet revision:
        if an automatic update looks wrong, open both PDFs and compare.</p>
      </section>

      <section class="card"><h2>Source check status</h2>
        ${sources.length ? `<p class="small muted">Last run ${esc(fmtDateTime(status.last_run_finished))}.</p>
          <div class="table-wrap"><table><thead><tr><th>Source</th><th>Result</th><th>Files</th><th>Details</th></tr></thead><tbody>${sourceRows}</tbody></table></div>`
          : '<p class="muted">The collector has not reported a run yet. Datasheets shown were captured when the catalog was created.</p>'}
      </section>

      <section class="card"><h2>Limits worth knowing</h2>
        <ul>
          <li>Values are read from public datasheets. They are not manufacturer-approved and don't replace a vendor's project-specific documentation.</li>
          <li>Ratings depend on conditions (temperature, voltage, altitude). Apparent power (kVA) and active power (kW), and converter vs. transformer-inclusive efficiency, are kept as separate fields and never mixed.</li>
          <li>Some manufacturer sites only offer datasheets behind forms or scripts; those need a direct link added by hand.</li>
          <li>Datasheets are © their manufacturers. Copies are archived only so each value can be checked against its source; the manufacturer's own link is always shown. Manufacturers can ask for a document to be removed.</li>
        </ul>
      </section>`,
  };
}

function viewNotFound() {
  return { title: 'Not found', html: '<div class="page-head"><h1>Not found</h1><p><a href="#/">Back to the catalog</a></p></div>' };
}

// ---------------------------------------------------------------- shell

function renderFreshness() {
  const el = document.getElementById('freshness');
  const status = db.status || {};
  if (status.last_run_finished) {
    const problems = status.summary?.errors || 0;
    el.innerHTML = `Sources last checked <strong>${esc(fmtDateTime(status.last_run_finished))}</strong>
      · ${plural(status.summary?.sources_checked || 0, 'source')}
      ${problems ? ` · <a href="#/about">${plural(problems, 'source problem')}</a>` : ''}`;
  } else {
    const newest = db.documents.map((d) => d.last_checked).sort().pop();
    el.innerHTML = `Datasheets captured <strong>${esc(fmtDate(newest))}</strong> · automatic checking not reporting yet`;
  }
}

function parseRoute() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = hash.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || 'catalog', arg: parts[1] || '', params: new URLSearchParams(query) };
}

function render({ keepFocus = false } = {}) {
  const route = parseRoute();
  let view;
  switch (route.name) {
    case 'catalog': view = viewCatalog(route.params); break;
    case 'model': view = viewModel(route.arg); break;
    case 'compare': view = viewCompare(route.arg ? route.arg.split(',') : [...compareSet]); break;
    case 'datasheets': view = viewDatasheets(); break;
    case 'changes': view = viewChanges(route.params); break;
    case 'about': view = viewAbout(); break;
    default: view = viewNotFound();
  }

  const active = document.activeElement;
  const activeName = active?.name;
  const main = document.getElementById('main');
  main.innerHTML = view.html;
  document.title = `${view.title} · PCS Atlas`;
  document.querySelectorAll('#nav a').forEach((a) => {
    if (a.dataset.route === (route.name === 'model' ? 'catalog' : route.name)) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  view.after?.();

  // Deep link to one value: #/model/<id>?f=<field>
  const field = route.params.get('f');
  if (field) {
    const target = document.getElementById(`spec-${field}`);
    if (target) { target.open = true; target.scrollIntoView({ block: 'center' }); target.querySelector('summary').focus(); return; }
  }

  if (keepFocus && activeName) {
    const again = main.querySelector(`[name="${CSS.escape(activeName)}"]`);
    if (again) {
      again.focus();
      if (again.setSelectionRange && typeof again.value === 'string') again.setSelectionRange(again.value.length, again.value.length);
      return;
    }
  }
  if (!keepFocus) { main.focus(); window.scrollTo(0, 0); }
}

async function start() {
  try {
    await loadData();
  } catch (error) {
    document.getElementById('main').innerHTML =
      `<p class="notice">The catalog data could not be loaded (${esc(error.message)}). Please try again later.</p>`;
    return;
  }
  renderFreshness();
  window.addEventListener('hashchange', () => render());
  render({ keepFocus: true });
}

start();
