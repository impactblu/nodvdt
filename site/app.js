// PCS Atlas: public, read-only catalog.
// Everything shown comes from /data (kept current by the NAS collector) and
// /datasheets (every datasheet version it has seen, plus page images). No server, no login.

import { ICONS } from './icons.js';

const ROOT = location.pathname.includes('/site/') ? '../' : './';
const MAX_COMPARE = 4;
const COMPARE_KEY = 'pcs-atlas-compare';

const STATUS = {
  'reviewed':    { tone: 'rev',  label: 'Reviewed',     text: 'Checked by a reviewer against the datasheet page.' },
  'confirmed':   { tone: 'rev',  label: 'Reviewed',     text: 'Reviewed, and found unchanged in the newest version of the datasheet.' },
  'updated':     { tone: 'rev',  label: 'Updated',      text: 'The manufacturer published a new datasheet with a different number. It was updated automatically and the previous value is kept.' },
  'extracted':   { tone: 'auto', label: 'Auto-read',    text: 'Read from the datasheet table by the rules-based extractor. Not reviewed by a person yet, so check the highlighted line.' },
  'needs-check': { tone: 'warn', label: 'Under review', text: 'The newest datasheet no longer states this the same way. The last confirmed value is shown until it is reviewed.' },
};

const KPI_FIELDS = [
  { label: 'Rated power', keys: ['rated_kva', 'rated_kw'], note: (s) => [s.field === 'rated_kva' ? 'apparent power' : 'active power', condOf(s)].filter(Boolean).join(' at ') },
  { label: 'DC range', keys: ['dc_voltage_range', 'full_power_dc_range', 'dc_max_v'], note: (s) => (s.field === 'dc_max_v' ? 'maximum voltage' : 'operating window') },
  { label: 'Peak efficiency', keys: ['efficiency_max_pct', 'efficiency_with_mvt_pct'], note: (s) => (s.field === 'efficiency_max_pct' ? 'converter only' : 'including MV transformer') },
  { label: 'Grid', keys: ['mv_voltage_kv', 'ac_voltage_v'], note: (s) => { const f = specOf(s.product, 'frequency_hz'); return f ? formatValue(f) : ''; } },
];

const db = {};
const idx = {};
const compareSet = new Set(loadCompare());

// ------------------------------------------------------------------ helpers

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const fmtBytes = (n) => (n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'unknown');
const fmtShort = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const dayKey = (iso) => new Date(iso).toLocaleDateString('en-CA');
const byModel = (a, b) => a.model.localeCompare(b.model, undefined, { numeric: true });

function icon(name, cls = '') {
  const paths = ICONS[name] || [];
  return `<svg class="ico ${cls}" viewBox="0 0 256 256" aria-hidden="true">${paths.map((d) => `<path d="${d}"/>`).join('')}</svg>`;
}

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

// "14000" to "14,000"; ranges written with dashes become "934-1,500".
const groupDigits = (text) => String(text)
  .replace(/(\d)\s*[–—]\s*(\d)/g, '$1-$2')
  .replace(/(^|[^\d.,])(\d{4,})(?![\d.,]*\d)/g, (m, pre, digits) => pre + Number(digits).toLocaleString('en-US'));

function formatValue(spec, value = spec.value) {
  const field = idx.fields.get(spec.field) || { unit: '' };
  const text = groupDigits(value);
  const unit = field.unit && !String(value).trim().endsWith(field.unit) ? ` ${field.unit}` : '';
  return `${text}${unit}`;
}

// "at 40 °C" when the datasheet row names a temperature (ratings depend on it).
function condOf(spec) {
  const m = String(spec.evidence || '').match(/@\s*(\d{2})\s*°?\s*[C℃]/);
  return m ? `${m[1]} °C` : '';
}

const initials = (name) => { const caps = name.match(/[A-Z0-9]/g) || []; return (caps.length > 1 ? caps.join('') : name).slice(0, 2).toUpperCase(); };
const pdfHref = (rev, page) => ROOT + rev.file.split('/').map(encodeURIComponent).join('/') + (page ? `#page=${page}` : '');
const modelHref = (id, field) => `#/model/${encodeURIComponent(id)}${field ? `?f=${encodeURIComponent(field)}` : ''}`;

function statusPill(status, { short = false } = {}) {
  const m = STATUS[status];
  if (!m) return '';
  const ico = m.tone === 'warn' ? icon('warning') : m.tone === 'auto' ? icon('sparkle') : icon('check');
  return `<span class="pill ${m.tone}" title="${esc(m.text)}">${ico}${short ? '' : esc(m.label)}</span>`;
}
const isAttention = (status) => status === 'needs-check' || status === 'updated';

function loadCompare() {
  try { return JSON.parse(localStorage.getItem(COMPARE_KEY) || '[]').slice(0, MAX_COMPARE); } catch { return []; }
}
function saveCompare() {
  try { localStorage.setItem(COMPARE_KEY, JSON.stringify([...compareSet])); } catch { /* private mode: keep in memory */ }
  renderTray();
  document.querySelectorAll('[data-compare-count]').forEach((el) => {
    el.textContent = `Compare selected (${compareSet.size})`;
    el.setAttribute('aria-disabled', String(!compareSet.size));
  });
  document.querySelectorAll('input[data-compare]').forEach((c) => { c.checked = compareSet.has(c.dataset.compare); });
  document.querySelectorAll('button[data-compare]').forEach((b) => setCompareButton(b));
}
function toggleCompare(id) {
  if (compareSet.has(id)) compareSet.delete(id);
  else if (compareSet.size < MAX_COMPARE) compareSet.add(id);
  else return false;
  saveCompare();
  return true;
}
function setCompareButton(btn) {
  const on = compareSet.has(btn.dataset.compare);
  btn.setAttribute('aria-pressed', String(on));
  btn.innerHTML = on ? `${icon('check')} Comparing` : `${icon('plus')} Compare`;
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
  idx.familyMembers = groupBy([...idx.products.values()].filter((p) => p.family && idx.products.has(p.family)), (p) => p.family);
  for (const list of idx.familyMembers.values()) list.sort(byModel);
  // A family container is a product with member models and no values of its own (e.g. "PCSM / Multi PCSM").
  // A product that has its own values stays a model; models found beside it are listed as related.
  idx.containers = new Set([...idx.familyMembers.keys()].filter((id) => !specsOf(id).length));
  idx.leaves = [...idx.products.values()].filter((p) => !idx.containers.has(p.id));
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
const revisionCount = () => db.documents.reduce((n, d) => n + d.revisions.length, 0);

function kindOf(p) {
  const members = idx.containers.has(p.id) && idx.familyMembers.get(p.id);
  if (members) {
    const kinds = new Set(members.map(kindOf));
    return kinds.has('reviewed') ? 'reviewed' : kinds.has('auto') ? 'auto' : 'none';
  }
  const specs = specsOf(p.id);
  if (!specs.length) return 'none';
  return specs.some((s) => s.status !== 'extracted') ? 'reviewed' : 'auto';
}

// ------------------------------------------------------------------ datasheet page viewer

// A cropped view of the rendered datasheet page, zoomed to the value's row.
function sheetHtml(spec, { pageLabel = true } = {}) {
  const hl = spec?.highlight;
  const found = spec && idx.revisions.get(spec.revision);
  if (!hl?.image || hl.revision !== spec.revision) {
    return `<div class="sheet sheet-none">${icon('file-text')}<span>Page preview is being prepared.<br>Open the PDF to see page ${esc(spec?.page ?? '')}.</span></div>`;
  }
  const pages = found?.rev.pages;
  return `<div class="sheet" data-sheet="${esc(spec.id)}">
    <img src="${esc(ROOT + hl.image)}" alt="Page ${esc(hl.page)} of ${esc(found?.doc.title || 'the datasheet')}${hl.row ? ', with the source line highlighted' : ''}" decoding="async">
    ${hl.row ? `<div class="hl row${hl.cell ? '' : ' solo'}"></div>` : ''}
    ${hl.cell ? '<div class="hl cell"></div>' : ''}
    ${pageLabel ? `<span class="pageno">p. ${esc(hl.page)}${pages ? ` / ${esc(pages)}` : ''}</span>` : ''}
  </div>`;
}

const sheetObserver = 'ResizeObserver' in window ? new ResizeObserver((entries) => entries.forEach((e) => layoutSheet(e.target))) : null;

function mountSheets(scope = document) {
  scope.querySelectorAll('.sheet[data-sheet]').forEach((el) => {
    const img = el.querySelector('img');
    const go = () => layoutSheet(el);
    if (img.complete && img.naturalWidth) go(); else img.addEventListener('load', go, { once: true });
    sheetObserver?.observe(el);
  });
}

function layoutSheet(el) {
  const img = el.querySelector('img');
  if (!img || !img.naturalWidth || !el.isConnected) return;
  const spec = db.specById.get(el.dataset.sheet);
  const hl = spec?.highlight || {};
  const aspect = img.naturalHeight / img.naturalWidth;
  const cw = el.clientWidth;
  const row = hl.row || [0.05, 0.4, 0.95, 0.45];
  let s; let left; let top; let ch;
  if (el.classList.contains('full')) {
    s = cw; left = 0; top = 0;
    ch = Math.round(s * aspect);
    el.style.height = `${ch}px`;
  } else {
    el.style.height = '';
    ch = el.clientHeight;
    const focusW = Math.max(row[2] - row[0], 0.3) + 0.05;
    s = Math.min(Math.max(cw / focusW, cw * 1.3), cw * 2.4);
    // Keep the value's cell in view when the row is wider than the crop.
    const cell = hl.cell || row;
    const want = -(row[0] - 0.025) * s;
    const cellFit = cw - (cell[2] + 0.025) * s;
    left = Math.min(0, Math.max(cw - s, Math.min(want, cellFit)));
    const imgH = s * aspect;
    top = Math.min(0, Math.max(ch - imgH, ch / 2 - ((row[1] + row[3]) / 2) * imgH));
  }
  const h = s * aspect;
  Object.assign(img.style, { width: `${s}px`, left: `${left}px`, top: `${top}px` });
  const place = (box, node) => {
    if (!box || !node) return;
    Object.assign(node.style, {
      left: `${box[0] * s + left}px`, top: `${box[1] * h + top}px`,
      width: `${(box[2] - box[0]) * s}px`, height: `${(box[3] - box[1]) * h}px`,
    });
  };
  place(hl.row, el.querySelector('.hl.row'));
  place(hl.cell, el.querySelector('.hl.cell'));
  el.classList.add('ready');
}

// The quote, with the extractor's "Label — MODEL: cell" shown as label plus column.
function quoteHtml(spec) {
  const ev = String(spec.evidence || '');
  const parts = ev.split(' — ');
  if (parts.length === 2) {
    const [label, rest] = parts;
    const m = rest.match(/^([^:]+):\s*(.*)$/);
    if (m) return `<mark>${esc(label)}</mark><br><span class="muted">${esc(m[1])} column:</span> <mark>${esc(m[2])}</mark>`;
  }
  return `<mark>${esc(ev)}</mark>`;
}

// ------------------------------------------------------------------ home

function viewHome(params) {
  const leaves = idx.leaves;
  const example = pickExample();
  const exProduct = example && idx.products.get(example.product);
  const exRev = example && idx.revisions.get(example.revision);
  const interval = Number(db.status?.interval_hours) || 24;
  const counts = { all: leaves.length, reviewed: 0, auto: 0, none: 0 };
  leaves.forEach((p) => { counts[kindOf(p)] += 1; });

  const valueParts = example ? formatValue(example).match(/^([\d.,\-\s]+)\s*(.*)$/) : null;
  const citation = example && exProduct ? `
    <figure class="cite">
      <div class="cite-top">
        <div>
          <div class="label"><a href="${modelHref(exProduct.id, example.field)}">${esc(exProduct.supplier.name)} ${esc(exProduct.model)}</a>, ${esc((idx.fields.get(example.field)?.label || '').toLowerCase())}</div>
          <div class="value">${valueParts ? `${esc(valueParts[1].trim())}<small>${esc(valueParts[2])}${condOf(example) ? ` at ${esc(condOf(example))}` : ''}</small>` : esc(formatValue(example))}</div>
        </div>
        ${statusPill(example.status)}
      </div>
      <div class="connector" aria-hidden="true"></div>
      ${sheetHtml(example, { pageLabel: false })}
      <figcaption class="cite-foot"><span>Datasheet page ${esc(example.page)}, version of ${esc(fmtDate(exRev?.rev.captured_at))}</span>
        ${exRev ? `<a href="${esc(pdfHref(exRev.rev, example.page))}" target="_blank" rel="noopener">Open PDF ${icon('arrow-up-right')}</a>` : ''}</figcaption>
    </figure>` : '';

  const events = buildEvents().slice(0, 3);

  return {
    title: 'Battery storage inverter specs',
    html: `
      <section class="hero"><div class="wrap">
        <div>
          <span class="eyebrow">Utility-scale battery storage</span>
          <h1>Every inverter spec, <mark>traced to its datasheet.</mark></h1>
          <p class="lead">Compare storage inverters side by side. Every number links to the datasheet line it came from.</p>
          <div class="cta">
            <a class="btn dark" href="#/" data-scroll-to="models">Browse ${esc(leaves.length)} models ${icon('arrow-right')}</a>
            <a class="btn" href="#/about">How it stays current</a>
          </div>
        </div>
        ${citation}
      </div></section>

      <section class="facts-band" aria-label="Catalog in numbers"><div class="wrap facts">
        <div><b>${esc(db.specs.length.toLocaleString())}</b><span>values, each with a quoted source line</span></div>
        <div><b>${esc(revisionCount())}</b><span>datasheet versions kept, never overwritten</span></div>
        <div><b>${esc(leaves.length)}</b><span>models from ${esc(plural(db.suppliers.length, 'manufacturer'))}</span></div>
        <div><b>${interval === 24 ? 'Daily' : `${esc(interval)} h`}</b><span>checks for new datasheet versions</span></div>
      </div></section>

      <section class="sec" id="models" aria-labelledby="models-h"><div class="wrap">
        <div class="sec-head">
          <div><h2 id="models-h">Models</h2><p>Reviewed models first. Numbers link to their source.</p></div>
          <a class="btn sm" href="#/compare" data-compare-count aria-disabled="${!compareSet.size}">Compare selected (${compareSet.size})</a>
        </div>
        <div class="tools" id="catalog-tools">
          <div class="seg" role="group" aria-label="Show">
            <button type="button" data-show="all">All<em>${counts.all}</em></button>
            <button type="button" data-show="reviewed">Reviewed<em>${counts.reviewed}</em></button>
            <button type="button" data-show="auto">Auto-read<em>${counts.auto}</em></button>
            <button type="button" data-show="none">Datasheet only<em>${counts.none}</em></button>
          </div>
          <select class="select" id="f-supplier" aria-label="Manufacturer">
            <option value="">All manufacturers</option>
            ${db.suppliers.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}
          </select>
          <select class="select" id="f-sort" aria-label="Sort by">
            <option value="featured">Sort: most reviewed</option>
            <option value="name">Sort: name</option>
            <option value="power">Sort: rated power</option>
            <option value="efficiency">Sort: efficiency</option>
          </select>
          <span class="count" id="result-count" aria-live="polite"></span>
        </div>
        <div class="tbl"><table>
          <thead><tr><th class="cb"><span class="sr-only">Compare</span></th><th class="mc">Model</th><th class="r">Rated power</th><th class="r">DC max</th><th class="r">Peak efficiency</th><th class="r">Grid</th><th>Source</th><th><span class="sr-only">Open</span></th></tr></thead>
          <tbody id="model-rows"></tbody>
        </table></div>
      </div></section>

      ${events.length ? `<section class="sec tight" aria-labelledby="upd-h"><div class="wrap narrow">
        <div class="sec-head"><div><h2 id="upd-h">Latest from the manufacturers</h2><p>Found by the collector and published automatically.</p></div><a class="btn sm" href="#/updates">All updates</a></div>
        <ol class="timeline">${events.map((e) => eventHtml(e)).join('')}</ol>
      </div></section>` : ''}`,
    after() {
      mountSheets();
      const tools = document.getElementById('catalog-tools');
      const state = {
        q: params.get('q') || '',
        show: params.get('show') || 'all',
        supplier: params.get('supplier') || '',
        sort: params.get('sort') || 'featured',
        open: new Set(),
      };
      tools.querySelector('#f-supplier').value = state.supplier;
      tools.querySelector('#f-sort').value = state.sort;
      const update = () => {
        const next = new URLSearchParams();
        for (const k of ['q', 'show', 'supplier', 'sort']) {
          const v = state[k];
          if (v && !(k === 'show' && v === 'all') && !(k === 'sort' && v === 'featured')) next.set(k, v);
        }
        history.replaceState(null, '', next.toString() ? `#/?${next}` : '#/');
        currentHash = location.hash;
        renderRows(state);
      };
      tools.querySelectorAll('[data-show]').forEach((b) => b.addEventListener('click', () => { state.show = b.dataset.show; update(); }));
      tools.querySelector('#f-supplier').addEventListener('change', (e) => { state.supplier = e.target.value; update(); });
      tools.querySelector('#f-sort').addEventListener('change', (e) => { state.sort = e.target.value; update(); });
      document.getElementById('model-rows').addEventListener('click', (e) => {
        const fam = e.target.closest('tr.family');
        if (!fam || e.target.closest('a, input, button:not(.fam-toggle)')) return;
        const id = fam.dataset.family;
        if (state.open.has(id)) state.open.delete(id); else state.open.add(id);
        renderRows(state);
      });
      headerSearchHandler = (q) => { state.q = q; update(); };
      renderRows(state);
      if (state.q || params.get('supplier') || params.get('show')) document.getElementById('models').scrollIntoView();
    },
  };
}

function pickExample() {
  const withRow = db.specs.filter((s) => s.highlight?.row && s.highlight.revision === s.revision);
  return withRow.find((s) => s.field === 'rated_kva' && s.status !== 'extracted')
    || withRow.find((s) => s.status !== 'extracted')
    || withRow.find((s) => s.field === 'rated_kva') || withRow[0];
}

const SORTS = {
  featured: (a, b) => reviewedCount(b.id) - reviewedCount(a.id) || Number(!!a.auto) - Number(!!b.auto)
    || specsOf(b.id).length - specsOf(a.id).length || byModel(a, b),
  name: byModel,
  power: (a, b) => numOf(b, ['rated_kva', 'rated_kw']) - numOf(a, ['rated_kva', 'rated_kw']),
  efficiency: (a, b) => numOf(b, ['efficiency_max_pct', 'efficiency_with_mvt_pct']) - numOf(a, ['efficiency_max_pct', 'efficiency_with_mvt_pct']),
};
function numOf(p, keys) {
  const members = idx.containers.has(p.id) && idx.familyMembers.get(p.id);
  if (members) return Math.max(-Infinity, ...members.map((m) => numOf(m, keys)));
  return pick(p.id, keys)?.numeric ?? -Infinity;
}

function renderRows(state) {
  const q = state.q.trim().toLowerCase();
  const matches = (p) => {
    const text = `${p.model} ${p.supplier.name} ${p.kind || ''} ${p.market || ''} ${p.summary || ''}`.toLowerCase();
    return (!q || q.split(/\s+/).every((w) => text.includes(w)))
      && (!state.supplier || p.supplier.id === state.supplier)
      && (state.show === 'all' || kindOf(p) === state.show);
  };
  const narrowed = Boolean(q || state.show !== 'all');
  const sorter = SORTS[state.sort] || SORTS.featured;

  // Top-level entries: products that are not members of a family; families carry their matching members.
  const entries = [];
  for (const p of idx.products.values()) {
    if (idx.containers.has(p.family)) continue;
    const members = idx.containers.has(p.id) && idx.familyMembers.get(p.id);
    if (members) {
      const hit = members.filter(matches);
      const selfHit = !narrowed && (!state.supplier || p.supplier.id === state.supplier) && (!q || matches(p));
      if (hit.length || selfHit) entries.push({ p, members: [...hit].sort(sorter), all: members });
    } else if (matches(p)) {
      entries.push({ p });
    }
  }
  const shown = entries.reduce((n, e) => n + (e.members ? e.members.length : 1), 0);

  const collecting = (e) => kindOf(e.p) === 'none';
  const groups = new Map();
  for (const e of entries) {
    const key = collecting(e) && state.show !== 'none' ? '_collecting' : e.p.supplier.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const rank = (list) => list.reduce((n, e) => n + (e.members || [e.p]).reduce((m, p) => m + reviewedCount(p.id) * 1000 + specsOf(p.id).length, 0), 0);
  const ordered = [...groups].sort(([ka, a], [kb, b]) => (ka === '_collecting') - (kb === '_collecting') || rank(b) - rank(a));

  const rows = ordered.map(([key, list]) => {
    list.sort((a, b) => sorter(a.p, b.p));
    let head;
    if (key === '_collecting') {
      const names = [...new Set(list.map((e) => e.p.supplier.name))];
      head = `<div class="grp-name"><span class="avatar">+${names.length}</span>${esc(names.join(', '))} <span>datasheets being collected</span></div>`;
    } else {
      const s = idx.suppliers.get(key);
      const n = list.reduce((m, e) => m + (e.members ? e.all.length : 1), 0);
      head = `<div class="grp-name"><span class="avatar">${esc(initials(s.name))}</span>${esc(s.name)} <span>${esc(plural(n, 'model'))}</span></div>`;
    }
    return `<tr class="grp"><td colspan="8">${head}</td></tr>${list.map((e) => {
      if (!e.members) return itemRow(e.p);
      const open = narrowed || state.open.has(e.p.id);
      return familyRow(e.p, e.all, open) + (open ? e.members.map((m) => itemRow(m, { member: true })).join('') : '');
    }).join('')}`;
  }).join('');

  document.querySelectorAll('[data-show]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.show === state.show)));
  document.getElementById('result-count').textContent = `Showing ${shown} of ${idx.leaves.length}`;
  document.getElementById('model-rows').innerHTML = rows || `<tr><td colspan="8"><div class="empty"><h3>No models match</h3><p>Try a different search, filter or manufacturer.</p></div></td></tr>`;
}

function cells(ids) {
  // Values for a product (one id) or a family range (several ids).
  const range = (keys) => {
    const specs = ids.map((id) => pick(id, keys)).filter(Boolean);
    if (!specs.length) return null;
    const nums = specs.map((s) => s.numeric).filter((n) => typeof n === 'number');
    if (ids.length > 1 && nums.length) {
      const lo = Math.min(...nums); const hi = Math.max(...nums);
      const unit = idx.fields.get(specs[0].field)?.unit || '';
      const f = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
      return { text: `${lo === hi ? f(lo) : `${f(lo)}-${f(hi)}`}${unit ? ` ${unit}` : ''}`, spec: specs[0] };
    }
    return { text: formatValue(specs[0]), spec: specs[0] };
  };
  const na = '<span class="na">n/a</span>';
  const power = range(['rated_kva', 'rated_kw']);
  const eff = range(['efficiency_max_pct', 'efficiency_with_mvt_pct']);
  const mv = range(['mv_voltage_kv']) || range(['ac_voltage_v']);
  const hz = range(['frequency_hz']);
  const cond = power && ids.length === 1 ? condOf(power.spec) : '';
  return {
    power: power ? `${esc(power.text)}${cond ? `<span class="q">@${esc(cond.replace(' ', ''))}</span>` : ''}` : na,
    dc: (() => { const d = range(['dc_max_v']); return d ? esc(d.text) : na; })(),
    eff: eff ? `${esc(eff.text)}<span class="q">${eff.spec.field === 'efficiency_max_pct' ? 'conv.' : 'w/ MVT'}</span>` : na,
    grid: mv || hz ? esc([mv?.text, hz?.text].filter(Boolean).join(', ')) : na,
  };
}

function productPill(p) {
  const ids = idx.containers.has(p.id) ? idx.familyMembers.get(p.id).map((m) => m.id) : [p.id];
  const attention = ids.reduce((n, id) => n + specsOf(id).filter((s) => isAttention(s.status) && s.status === 'needs-check').length, 0);
  if (attention) return `<span class="pill warn">${icon('warning')}${attention} under review</span>`;
  const kind = kindOf(p);
  if (kind === 'reviewed') return `<span class="pill rev">${icon('check')}Reviewed</span>`;
  if (kind === 'auto') return `<span class="pill auto">${icon('sparkle')}Auto-read</span>`;
  return `<span class="pill plain">Datasheet only</span>`;
}

function subline(p) {
  if (p.auto) return [p.market, 'found in a datasheet table'].filter(Boolean).join(', ');
  const docs = docsOf(p.id);
  if (!specsOf(p.id).length && !idx.containers.has(p.id)) return `${p.kind || 'Model'}, ${docs.length ? plural(docs.length, 'datasheet') + ' on file' : 'datasheet coming soon'}`;
  return [p.kind, p.market].filter(Boolean).join(', ');
}

function itemRow(p, { member = false } = {}) {
  const c = cells([p.id]);
  const canCompare = specsOf(p.id).length > 0;
  return `<tr class="item${member ? ' member' : ''}" data-href="${modelHref(p.id)}">
    <td class="cb">${canCompare ? `<input type="checkbox" class="check" data-compare="${esc(p.id)}" aria-label="Compare ${esc(p.model)}" ${compareSet.has(p.id) ? 'checked' : ''}>` : ''}</td>
    <td class="model"><a href="${modelHref(p.id)}"><b>${esc(p.model)}</b></a><small>${esc(subline(p))}</small></td>
    <td class="p r num">${c.power}</td><td class="d r num">${c.dc}</td><td class="e r num">${c.eff}</td><td class="gv r num">${c.grid}</td>
    <td class="st">${productPill(p)}</td>
    <td class="chev">${icon('arrow-right')}</td>
  </tr>`;
}

function familyRow(p, members, open) {
  const c = cells(members.map((m) => m.id));
  return `<tr class="item family" data-family="${esc(p.id)}" aria-expanded="${open}">
    <td class="cb"></td>
    <td class="model"><a href="${modelHref(p.id)}"><b>${esc(p.model)}</b></a><span class="count-tag">${esc(plural(members.length, 'model'))}</span><small>${esc(p.summary || [p.kind, p.market].filter(Boolean).join(', '))}</small></td>
    <td class="p r num">${c.power}</td><td class="d r num">${c.dc}</td><td class="e r num">${c.eff}</td><td class="gv r num">${c.grid}</td>
    <td class="st">${productPill(p)}</td>
    <td class="chev"><button type="button" class="btn ghost sm fam-toggle" aria-label="${open ? 'Hide' : 'Show'} ${esc(plural(members.length, 'model'))} in ${esc(p.model)}">${open ? 'Hide' : 'Show'} ${icon('caret-down')}</button></td>
  </tr>`;
}

// ------------------------------------------------------------------ updates (shared by home and the updates page)

function buildEvents() {
  const events = [];
  const supplierOf = (c) => idx.documents.get(c.document)?.supplier || idx.products.get(c.product)?.supplier.id || '';
  const days = groupBy([...db.changes].sort((a, b) => String(b.at).localeCompare(String(a.at))), (c) => dayKey(c.at));
  for (const [, entries] of days) {
    const at = entries[0].at;
    const bucket = (type) => groupBy(entries.filter((c) => c.type === type), supplierOf);
    for (const c of entries.filter((x) => x.type === 'needs-check')) {
      const p = idx.products.get(c.product); const f = idx.fields.get(c.field);
      events.push({ at, warn: true, pill: `<span class="pill warn">Under review</span>`,
        title: `${esc(f?.label || c.field)} is under review for <a href="${modelHref(c.product, c.field)}">${esc(p?.model || c.product)}</a>`,
        sub: 'The new datasheet words this differently. The last confirmed value stays visible until it is reviewed.' });
    }
    for (const c of entries.filter((x) => x.type === 'value-changed')) {
      const p = idx.products.get(c.product); const f = idx.fields.get(c.field); const spec = { field: c.field };
      events.push({ at, pill: `<span class="pill rev">Updated</span>`,
        title: `${esc(f?.label || c.field)} changed for <a href="${modelHref(c.product, c.field)}">${esc(p?.model || c.product)}</a>`,
        sub: `<span class="diff"><s>${esc(formatValue(spec, c.previous_value))}</s>${icon('arrow-right')}<b>${esc(formatValue(spec, c.value))}</b></span>` });
    }
    for (const [sid, list] of bucket('datasheet-revised')) {
      const s = idx.suppliers.get(sid);
      events.push({ at, pill: `<span class="pill plain">${esc(plural(list.length, 'file'))}</span>`,
        title: `${esc(s?.name || 'A manufacturer')} revised ${list.length === 1 ? 'a datasheet' : `${list.length} datasheets`}`,
        sub: 'Every earlier version stays downloadable, and the values that depend on them were checked again.',
        items: list.map((c) => {
          const d = idx.documents.get(c.document); const newer = idx.revisions.get(c.revision); const older = idx.revisions.get(c.previous_revision);
          return `${esc(d?.title || c.document)}: ${newer ? `<a href="${esc(pdfHref(newer.rev))}" target="_blank" rel="noopener">new</a>` : ''}${older ? `, <a href="${esc(pdfHref(older.rev))}" target="_blank" rel="noopener">previous</a>` : ''}`;
        }), noun: 'file' });
    }
    for (const [sid, list] of bucket('new-datasheet')) {
      const s = idx.suppliers.get(sid);
      events.push({ at, pill: `<span class="pill plain">${esc(plural(list.length, 'file'))}</span>`,
        title: `${esc(plural(list.length, 'new datasheet'))} from ${esc(s?.name || 'a manufacturer')}`, sub: 'Archived and added to the library.',
        items: list.map((c) => { const d = idx.documents.get(c.document); const p = idx.products.get(c.product); return `${esc(d?.title || c.document)}${p ? `, for <a href="${modelHref(p.id)}">${esc(p.model)}</a>` : ''}`; }), noun: 'file' });
    }
    for (const [sid, list] of bucket('new-model')) {
      const s = idx.suppliers.get(sid);
      events.push({ at, pill: `<span class="pill auto">${icon('sparkle')}Auto-read</span>`,
        title: `${esc(plural(list.length, 'model'))} from ${esc(s?.name || 'a manufacturer')} found in datasheet tables`,
        sub: 'Added automatically from the model columns of their datasheets.',
        items: list.map((c) => `<a href="${modelHref(c.product)}">${esc(idx.products.get(c.product)?.model || c.product)}</a>`), noun: 'model' });
    }
    for (const [sid, list] of bucket('values-extracted')) {
      const s = idx.suppliers.get(sid);
      const total = list.reduce((n, c) => n + (c.count || 0), 0);
      events.push({ at, pill: `<span class="pill auto">${icon('sparkle')}Auto-read</span>`,
        title: `${esc(total.toLocaleString())} values read from ${esc(s?.name || 'a manufacturer')} datasheets`,
        sub: 'Read by rules, each one linked to the line it came from.',
        items: list.map((c) => `${esc(idx.documents.get(c.document)?.title || c.document)}: ${esc(c.count)} values`), noun: 'datasheet' });
    }
    for (const c of entries.filter((x) => x.type === 'import')) {
      events.push({ at, pill: `<span class="pill rev">${icon('check')}Reviewed</span>`, title: 'Catalog launched', sub: esc(String(c.summary || '').replace(/^Initial catalog:\s*/, '')) });
    }
  }
  return events;
}

function eventHtml(e) {
  return `<li class="${e.warn ? 'warn-row' : ''}"><time datetime="${esc(e.at)}">${esc(fmtShort(e.at))}</time>
    <div><h3>${e.title}</h3>${e.sub ? `<p>${e.sub}</p>` : ''}
      ${e.items?.length ? `<details><summary>${icon('caret-right')}Show ${esc(plural(e.items.length, e.noun))}</summary><ul>${e.items.map((i) => `<li>${i}</li>`).join('')}</ul></details>` : ''}</div>
    ${e.pill || ''}</li>`;
}

function viewUpdates() {
  const events = buildEvents();
  const days = groupBy(events, (e) => dayKey(e.at));
  return {
    title: 'Updates',
    html: `<div class="wrap page"><div class="narrow">
      <div class="page-head"><span class="eyebrow">Updates</span><h1>What changed at the manufacturers</h1><p>As the collector found it, newest first. Nothing here was entered by hand.</p></div>
      ${events.length ? [...days].map(([, list]) => `<h2 class="day-label">${esc(fmtDay(list[0].at))}</h2><ol class="timeline">${list.map(eventHtml).join('')}</ol>`).join('')
        : '<div class="empty"><h3>No updates yet</h3><p>The collector reports here after its first run.</p></div>'}
    </div></div>`,
  };
}

// ------------------------------------------------------------------ model page

function viewModel(id, params) {
  const p = idx.products.get(id);
  if (!p) return viewNotFound();
  const specs = specsOf(id);
  const docs = docsOf(id);
  const mainDoc = docs[0];
  const members = idx.containers.has(id) ? idx.familyMembers.get(id) : [];
  const related = !idx.containers.has(id) ? idx.familyMembers.get(id) || [] : [];
  const family = p.family && idx.products.get(p.family);
  const siblings = family ? (idx.familyMembers.get(family.id) || []).concat(idx.containers.has(family.id) ? [] : [family]) : [];
  const reviewed = specs.filter((s) => s.status !== 'extracted').length;
  const auto = specs.length - reviewed;
  const review = specs.filter((s) => s.status === 'needs-check');

  const ordered = [];
  const groups = new Map();
  for (const field of db.fields) {
    const s = specs.find((x) => x.field === field.key);
    if (!s) continue;
    ordered.push(s);
    if (!groups.has(field.group)) groups.set(field.group, []);
    groups.get(field.group).push(s);
  }

  const kpis = KPI_FIELDS.map((k) => ({ k, s: pick(id, k.keys) })).filter((x) => x.s);
  const kpiHtml = kpis.length >= 2 ? `<div class="kpis">${kpis.map(({ k, s }) => `
    <button type="button" class="kpi" data-field="${esc(s.field)}" aria-label="${esc(k.label)}: ${esc(formatValue(s))}. Show source">
      <span>${esc(k.label)}</span><b>${esc(formatValue(s))}</b><small>${esc(k.note ? k.note(s) : '') || '&nbsp;'}</small>
    </button>`).join('')}</div>` : '';

  const notice = review.length ? `<div class="notice" role="note">${icon('warning')}<div><strong>The manufacturer published a new datasheet.</strong>
      ${review.map((s) => `<a href="${modelHref(id, s.field)}" data-field="${esc(s.field)}">${esc(idx.fields.get(s.field)?.label || s.field)}</a>`).join(', ')}
      ${review.length === 1 ? 'is' : 'are'} being reviewed. The last confirmed value and its datasheet stay visible until then.</div></div>` : '';
  const autoNote = auto && !reviewed ? `<div class="notice info" role="note">${icon('sparkle')}<div>These values were read automatically from the datasheet table and have not been reviewed by a person yet. Select any value to see the exact line it came from.</div></div>` : '';

  const selected = (params.get('f') && specOf(id, params.get('f'))) || kpis[0]?.s || ordered[0];

  const sheet = specs.length ? `
    <div class="layout">
      <div>
        <div class="specs" id="spec-list" aria-label="Specifications">
          ${[...groups].map(([g, list]) => `<div class="g" role="group" aria-label="${esc(g)}"><h2>${esc(g)}</h2>${list.map((s) => specRow(s)).join('')}</div>`).join('')}
        </div>
        <p class="hint">Select any value to see its datasheet line.</p>
      </div>
      <aside class="src" id="source-panel" aria-live="polite" aria-label="Source of the selected value"></aside>
    </div>` : members.length ? '' : `
    <div class="empty"><h3>Specifications are not extracted yet</h3>
      <p>This model's datasheets are archived and watched for new versions. Values appear here once they have been read and checked.${docs.length ? ' The datasheets are available to download below.' : ''}</p></div>`;

  const memberTable = (list, title, note) => `
    <h2 class="sub-head">${title}</h2><p class="sub-note">${note}</p>
    <div class="tbl"><table>
      <thead><tr><th class="cb"><span class="sr-only">Compare</span></th><th class="mc">Model</th><th class="r">Rated power</th><th class="r">DC max</th><th class="r">Peak efficiency</th><th class="r">Grid</th><th>Source</th><th><span class="sr-only">Open</span></th></tr></thead>
      <tbody>${list.map((m) => itemRow(m)).join('')}</tbody></table></div>`;

  return {
    title: p.model,
    html: `<div class="wrap page">
      <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Models</a> / <a href="#/?supplier=${esc(p.supplier.id)}">${esc(p.supplier.name)}</a>${family ? ` / <a href="${modelHref(family.id)}">${esc(family.model)}</a>` : ''} / <b>${esc(p.model)}</b></nav>
      <div class="head">
        <div>
          <div class="maker"><span class="avatar">${esc(initials(p.supplier.name))}</span>${esc(p.supplier.name)}</div>
          <h1>${esc(p.model)}</h1>
          ${p.summary ? `<p class="sub">${esc(p.summary)}</p>` : ''}
          <div class="tags">
            ${[p.kind, p.market].filter(Boolean).map((c) => `<span class="pill plain">${esc(c)}</span>`).join('')}
            ${members.length ? `<span class="pill plain">${esc(plural(members.length, 'model'))}</span>` : ''}
            ${reviewed ? `<span class="pill rev">${icon('check')}${reviewed} reviewed</span>` : ''}
            ${auto ? `<span class="pill auto">${icon('sparkle')}${auto} auto-read</span>` : ''}
            ${review.length ? `<span class="pill warn">${icon('warning')}${review.length} under review</span>` : ''}
          </div>
        </div>
        <div class="actions">
          ${specs.length ? `<button class="btn" type="button" data-compare="${esc(id)}" aria-pressed="false"></button>` : ''}
          ${mainDoc ? `<a class="btn dark" href="${esc(pdfHref(latestRev(mainDoc)))}" download>${icon('download-simple')} Datasheet</a>` : ''}
        </div>
      </div>
      ${kpiHtml}${notice}${autoNote}
      ${sheet}
      ${members.length ? memberTable(members, 'Models in this family', `${esc(plural(members.length, 'model'))} found in this family's datasheets. Select one to see its values and sources.`) : ''}
      ${related.length ? memberTable(related, 'Also in this datasheet', `${esc(plural(related.length, 'related model'))} listed in the same datasheet table.`) : ''}
      ${siblings.length > 1 ? `<details class="sib"><summary>${icon('caret-right')}Other models in ${esc(family.model)} (${siblings.length - 1})</summary>
        ${memberTable(siblings.filter((m) => m.id !== id), `${esc(family.model)}`, 'Found in the same datasheets.')}</details>` : ''}
      <h2 class="sub-head">${docs.length === 1 ? 'Datasheet' : 'Datasheets'}</h2>
      <p class="sub-note">Every version the collector has seen is kept, so the file a value came from stays available.</p>
      ${docs.length ? `<div class="docs">${docs.slice(0, 4).map((d) => docRow(d)).join('')}</div>
        ${docs.length > 4 ? `<details class="more-docs"><summary>${icon('caret-right')}Show ${esc(plural(docs.length - 4, 'more datasheet'))}</summary><div class="docs">${docs.slice(4).map((d) => docRow(d)).join('')}</div></details>` : ''}`
        : '<div class="empty"><p>No datasheet collected yet.</p></div>'}
    </div>`,
    after() {
      document.querySelectorAll('.actions button[data-compare]').forEach(setCompareButton);
      if (!selected) return false;
      const list = document.getElementById('spec-list');
      const panel = document.getElementById('source-panel');
      const select = (field, { focus = false, scroll = false } = {}) => {
        const spec = specOf(id, field);
        const row = document.getElementById(`spec-${field}`);
        if (!spec || !row) return;
        list.querySelectorAll('.row').forEach((r) => r.setAttribute('aria-current', String(r === row)));
        panel.innerHTML = panelHtml(spec);
        if (mobile.matches) row.after(panel); else if (panel.parentElement !== list.parentElement.parentElement) list.parentElement.after(panel);
        mountSheets(panel);
        panel.querySelector('.sheet[data-sheet]')?.addEventListener('click', (e) => { e.currentTarget.classList.toggle('full'); layoutSheet(e.currentTarget); });
        history.replaceState(null, '', modelHref(id, field));
        currentHash = location.hash;
        if (focus) row.focus();
        if (scroll) row.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
      };
      list.addEventListener('click', (e) => { const row = e.target.closest('.row'); if (row) select(row.dataset.field); });
      list.addEventListener('keydown', (e) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
        const rows = [...list.querySelectorAll('.row')];
        const i = rows.indexOf(document.activeElement);
        if (i < 0) return;
        e.preventDefault();
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)));
        select(rows[next].dataset.field, { focus: true });
      });
      document.querySelectorAll('.kpi[data-field], .notice a[data-field]').forEach((b) => b.addEventListener('click', (e) => {
        e.preventDefault();
        select(b.dataset.field, { scroll: true });
      }));
      const mobile = window.matchMedia('(max-width: 900px)');
      mobile.addEventListener('change', () => { const cur = list.querySelector('.row[aria-current="true"]'); if (cur) select(cur.dataset.field); }, { signal: viewAbort.signal });
      select(selected.field);
      if (params.get('f')) {
        const row = document.getElementById(`spec-${params.get('f')}`);
        row?.scrollIntoView({ block: 'center' });
        return true;
      }
      return false;
    },
  };
}

function specRow(spec) {
  const field = idx.fields.get(spec.field) || { label: spec.field };
  const prev = (spec.history || [])[0];
  const changed = prev && String(prev.value) !== String(spec.value) && spec.status === 'updated';
  const cond = ['rated_kva', 'rated_kw'].includes(spec.field) ? condOf(spec) : '';
  const tone = STATUS[spec.status]?.tone;
  const mark = tone === 'warn' ? icon('warning', 'warn') : tone === 'auto' ? icon('sparkle', 'auto') : icon('check');
  return `<button type="button" class="row" id="spec-${esc(spec.field)}" data-field="${esc(spec.field)}" aria-current="false">
    <span class="l">${esc(field.label)}</span>
    <span class="v">${esc(formatValue(spec))}${cond ? `<em>at ${esc(cond)}</em>` : ''}${changed ? `<s>${esc(formatValue(spec, prev.value))}</s>` : ''}</span>
    <span class="s"><span title="${esc(STATUS[spec.status]?.label || '')}">${mark}<span class="sr-only">${esc(STATUS[spec.status]?.label || '')}</span></span><span class="pill plain">p. ${esc(spec.page)}</span></span>
  </button>`;
}

function panelHtml(spec) {
  const field = idx.fields.get(spec.field) || { label: spec.field };
  const found = idx.revisions.get(spec.revision);
  const doc = found?.doc;
  const latest = doc ? latestRev(doc) : null;
  const olderSource = found && latest && latest.sha256 !== found.rev.sha256;
  const history = spec.history || [];
  const statusText = spec.reviewed_by
    ? `${esc(spec.reviewed_by)}, ${esc(fmtDate(spec.reviewed_at))}.${spec.status === 'confirmed' ? ' Still matches the current file.' : ''}`
    : esc(STATUS[spec.status]?.text || '');
  return `<div class="src-body">
    <div class="src-head"><div><span class="k">Source</span><b>${esc(field.label)}</b></div>${statusPill(spec.status)}</div>
    ${sheetHtml(spec)}
    <div class="quote">${quoteHtml(spec)}</div>
    <dl class="meta">
      <dt>Value</dt><dd class="num">${esc(formatValue(spec))}</dd>
      ${spec.conditions ? `<dt>Conditions</dt><dd>${esc(spec.conditions)}</dd>` : ''}
      <dt>Datasheet</dt><dd>${found ? `${esc(doc.title)}, page ${esc(spec.page)}, version of ${esc(fmtDate(found.rev.captured_at))}` : 'unknown'}</dd>
      <dt>${spec.reviewed_by ? 'Reviewed' : 'Status'}</dt><dd class="${spec.status === 'needs-check' ? 'warn' : ''}">${statusText}</dd>
      ${olderSource ? `<dt>Newest file</dt><dd>Published ${esc(fmtDate(latest.captured_at))}. <a href="${esc(pdfHref(latest))}" target="_blank" rel="noopener">Open the newest version</a></dd>` : ''}
      <dt>Checked</dt><dd>${esc(fmtDate(spec.checked_at))}</dd>
    </dl>
    ${history.length ? `<div class="history"><details><summary>${icon('caret-right')}Earlier values (${history.length})</summary><ol>${history.map((h) => {
      const r = idx.revisions.get(h.revision);
      return `<li><b>${esc(formatValue(spec, h.value))}</b>${r ? `from the ${esc(fmtDate(r.rev.captured_at))} datasheet, <a href="${esc(pdfHref(r.rev, h.page))}" target="_blank" rel="noopener">page ${esc(h.page)}</a>` : ''}</li>`;
    }).join('')}</ol></details></div>` : ''}
    ${found ? `<div class="src-actions">
      <a class="btn dark" href="${esc(pdfHref(found.rev, spec.page))}" target="_blank" rel="noopener">Open PDF at p. ${esc(spec.page)} ${icon('arrow-up-right')}</a>
      <a class="btn" href="${esc(pdfHref(found.rev))}" download>${icon('download-simple')} Download</a>
    </div>` : ''}
  </div>`;
}

function docRow(d, { showModel = false } = {}) {
  const rev = latestRev(d);
  const older = d.revisions.slice(0, -1).reverse();
  const product = idx.products.get(d.product);
  return `<div class="doc">
    ${icon('file-pdf')}
    <div><div class="t">${esc(d.title)}</div>
      <div class="m">${showModel && product ? `<a href="${modelHref(product.id)}">${esc(product.model)}</a>, ` : ''}version of ${esc(fmtDate(rev.captured_at))}, ${esc(plural(rev.pages || 0, 'page'))}, ${esc(fmtBytes(rev.bytes))}</div></div>
    <div class="acts">
      <a class="btn sm" href="${esc(pdfHref(rev))}" download>${icon('download-simple')} PDF</a>
      <a class="btn sm ghost" href="${esc(pdfHref(rev))}" target="_blank" rel="noopener" aria-label="Open ${esc(d.title)}">${icon('arrow-up-right')}</a>
      <a class="btn sm ghost" href="${esc(d.url)}" target="_blank" rel="noopener noreferrer" title="The manufacturer's own copy">Source</a>
    </div>
    ${older.length ? `<details><summary>${icon('caret-right')}${esc(plural(older.length, 'earlier version'))}</summary>
      <ol>${older.map((r) => `<li><span>${esc(fmtDate(r.captured_at))}, ${esc(fmtBytes(r.bytes))}</span><a href="${esc(pdfHref(r))}" download>Download</a></li>`).join('')}</ol></details>` : ''}
  </div>`;
}

// ------------------------------------------------------------------ compare

function viewCompare(ids, params) {
  ids.forEach((id) => { if (idx.products.has(id) && compareSet.size < MAX_COMPARE) compareSet.add(id); });
  if (ids.length) saveCompare();
  const chosen = [...compareSet].filter((id) => idx.products.has(id));
  const candidates = [...idx.products.values()].filter((p) => specsOf(p.id).length && !compareSet.has(p.id)).sort(byModel);
  const onlyDiff = params.get('diff') === '1';
  const addControl = chosen.length < MAX_COMPARE && candidates.length ? `
    <select class="select" id="add-model" aria-label="Add a model"><option value="">Add a model</option>
      ${db.suppliers.map((s) => {
        const list = candidates.filter((p) => p.supplier.id === s.id);
        return list.length ? `<optgroup label="${esc(s.name)}">${list.map((p) => `<option value="${esc(p.id)}">${esc(p.model)}</option>`).join('')}</optgroup>` : '';
      }).join('')}
    </select>` : '';
  const head = `<div class="page-head"><span class="eyebrow">Compare</span><h1>Side by side</h1><p>Up to ${MAX_COMPARE} models. Ratings are only comparable at the same conditions, so select a value to check its source line.</p></div>`;

  if (!chosen.length) {
    return {
      title: 'Compare',
      html: `<div class="wrap page">${head}
        <div class="empty"><h3>Nothing selected yet</h3><p>Tick the box next to any model in the catalog, or add one here.</p><div class="tools">${addControl}</div></div></div>`,
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
      body += `<tr class="gr"><th colspan="${products.length + 1}">${esc(field.group)}</th></tr>`;
      lastGroup = field.group;
    }
    shown += 1;
    body += `<tr class="${differs ? 'differs' : ''}"><th scope="row">${esc(field.label)}</th>${specs.map((s, i) => (s
      ? `<td><a href="${modelHref(chosen[i], field.key)}">${esc(formatValue(s))}</a>${s.status === 'needs-check' ? ` ${statusPill(s.status, { short: true })}` : ''}</td>`
      : '<td class="na">n/a</td>')).join('')}</tr>`;
  }

  return {
    title: 'Compare',
    html: `<div class="wrap page">${head}
      <div class="tools">
        ${addControl}
        <label class="toggle"><input type="checkbox" class="check" id="only-diff" ${onlyDiff ? 'checked' : ''}> Only rows that differ</label>
        <span class="count"><button class="btn sm ghost" type="button" id="clear-compare">Clear all</button></span>
      </div>
      <div class="cmp-wrap"><table class="cmp">
        <thead><tr><th><span class="sr-only">Field</span></th>${products.map((p) => `
          <th><div class="th-in"><div><small>${esc(p.supplier.name)}</small><a href="${modelHref(p.id)}">${esc(p.model)}</a></div>
            <button class="btn sm ghost" type="button" data-remove="${esc(p.id)}" aria-label="Remove ${esc(p.model)}">${icon('x')}</button></div></th>`).join('')}</tr></thead>
        <tbody>${shown ? body : `<tr><td colspan="${products.length + 1}" class="na">${onlyDiff ? 'No differences among the published values.' : 'No published values yet.'}</td></tr>`}</tbody>
      </table></div>
      ${products.length > 1 ? '<p class="hint">Shaded rows differ between the models.</p>' : ''}
    </div>`,
    after() {
      bindAddModel();
      document.getElementById('only-diff').addEventListener('change', (e) => {
        history.replaceState(null, '', `#/compare${e.target.checked ? '?diff=1' : ''}`);
        render({ keepFocus: true });
      });
      document.getElementById('clear-compare').addEventListener('click', () => { compareSet.clear(); saveCompare(); render(); });
      document.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => {
        compareSet.delete(b.dataset.remove); saveCompare(); render({ keepFocus: true });
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

  return {
    title: 'Datasheets',
    html: `<div class="wrap page">
      <div class="page-head"><span class="eyebrow">Library</span><h1>Datasheets</h1>
        <p>${esc(plural(db.documents.length, 'datasheet'))} in ${esc(plural(revisionCount(), 'version'))}. Every version is kept, so the exact file a value came from stays available after the manufacturer replaces it.</p></div>
      <div class="tools"><input type="search" class="field" id="ds-search" placeholder="Filter by title or model" value="${esc(params.get('q') || '')}" aria-label="Filter datasheets"></div>
      ${shown.length ? shown.map(({ s, docs }) => `
        <section class="lib-group">
          <h2><span class="avatar">${esc(initials(s.name))}</span>${esc(s.name)} <span class="c">${docs.length}</span></h2>
          <div class="docs">${docs.map((d) => docRow(d, { showModel: true })).join('')}</div>
        </section>`).join('') : '<div class="empty"><h3>No datasheets match</h3></div>'}
      ${waiting.length && !q ? `<p class="sub-note">Also tracking ${esc(waiting.join(', '))}. Their datasheets appear here once collected.</p>` : ''}
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

// ------------------------------------------------------------------ about

function viewAbout() {
  const st = db.status || {};
  const sources = st.sources || [];
  return {
    title: 'How it works',
    html: `<div class="wrap page">
      <div class="page-head"><span class="eyebrow">How it works</span>
        <h1>A catalog that keeps itself current</h1>
        <p>PCS Atlas shows what a small team can build and run with AI tools: an equipment database where every number is traceable to a manufacturer's document, and that updates itself with no servers to maintain.</p></div>

      <ol class="steps">
        <li><b>Watch</b><p>A collector on a small home server visits each manufacturer's product page every day, politely and within their robots rules.</p></li>
        <li><b>Archive</b><p>Each datasheet is fingerprinted. A changed file is saved as a new version. Old versions are never deleted.</p></li>
        <li><b>Read</b><p>A rules-based extractor reads the datasheet tables, ties each number to its model column and keeps the exact line and page.</p></li>
        <li><b>Re-check</b><p>Every published value is looked up again in each new version. It is confirmed, updated, or flagged for review.</p></li>
        <li><b>Publish</b><p>Changes are pushed to GitHub and the site rebuilds by itself. Nobody has to press a button.</p></li>
      </ol>

      <section class="sec tight" aria-labelledby="labels-h"><h2 class="sub-head" id="labels-h">What the labels mean</h2>
        <dl class="legend">${['reviewed', 'extracted', 'updated', 'needs-check'].map((k) => `<dt>${statusPill(k)}</dt><dd>${esc(STATUS[k].text)}</dd>`).join('')}
          <dt><span class="pill src">p. 2</span></dt><dd>The datasheet page the value was read from. Select a value to see that page with the line highlighted.</dd></dl>
      </section>

      <section class="sec tight" aria-labelledby="ai-h"><h2 class="sub-head" id="ai-h">Built with AI tools</h2>
        <div class="prose">
          <p>The site, the collector and its checks were written with AI coding assistants. The first values were read from the datasheets with an AI-assisted review and are labelled that way. Each one quotes the datasheet line it came from, so anyone can verify it in seconds.</p>
          <p>New datasheets are read by rules that run on the collector. No AI service is called at runtime. Values read that way are labelled auto-read until a person reviews them, and the extractor was checked against the hand-reviewed values before it went live.</p>
          <p>The automatic re-check is deliberately cautious. It only publishes a new number when the label before it and the unit after it still match and the change is plausible. Anything else is marked under review rather than guessed.</p>
        </div>
      </section>

      <section class="sec tight" aria-labelledby="status-h"><h2 class="sub-head" id="status-h">Source status</h2>
        <p class="sub-note">Last run ${esc(timeAgo(st.last_run_finished))}${st.last_run_finished ? `, ${esc(fmtDate(st.last_run_finished))}` : ''}.</p>
        ${sources.length ? `<div class="cmp-wrap"><table class="cmp">
          <thead><tr><th>Source</th><th>Result</th><th>Notes</th></tr></thead>
          <tbody>${sources.map((s) => `<tr><th scope="row">${esc(s.name)}</th>
            <td class="nowrap">${s.ok ? `<span class="dot ok"></span>${esc(plural(s.files, 'file'))}` : '<span class="dot bad"></span>Needs attention'}</td>
            <td class="muted">${esc(s.ok ? '' : friendlyError(s.error))}</td></tr>`).join('')}</tbody>
        </table></div>` : '<p class="muted">The collector has not reported a run yet.</p>'}
      </section>

      <section class="sec tight" aria-labelledby="limits-h"><h2 class="sub-head" id="limits-h">Limits worth knowing</h2>
        <ul class="limits">
          <li>Values come from public datasheets. They are not manufacturer-approved and do not replace project-specific documentation.</li>
          <li>Ratings depend on conditions such as temperature, voltage and altitude. Apparent power (kVA) and active power (kW), and converter versus transformer-inclusive efficiency, are kept separate and never mixed.</li>
          <li>Some manufacturer sites only offer datasheets through scripts or forms. Those are added by hand.</li>
          <li>Datasheets belong to their manufacturers and are archived only so values can be checked. Manufacturers can ask for a document to be removed.</li>
        </ul>
      </section>
    </div>`,
  };
}

function friendlyError(error) {
  const e = String(error || '');
  if (/No matching PDF links/.test(e)) return 'The page lists its downloads with scripts, so a direct link is needed.';
  if (/HTTP 403/.test(e)) return 'The site refused the automated download.';
  if (/robots/.test(e)) return 'The site asks automated tools not to download this.';
  if (/Could not reach|resolve/.test(e)) return 'The site could not be reached.';
  return e.slice(0, 160);
}

function viewNotFound() {
  return { title: 'Not found', html: '<div class="wrap page"><div class="empty"><h3>Page not found</h3><p><a href="#/">Back to the models</a></p></div></div>' };
}

// ------------------------------------------------------------------ shell

let headerSearchHandler = null;
let viewAbort = new AbortController();

function renderTray() {
  const tray = document.getElementById('compare-tray');
  if (!compareSet.size || parseRoute().name === 'compare') { tray.hidden = true; return; }
  const names = [...compareSet].map((id) => idx.products.get(id)?.model).filter(Boolean);
  tray.hidden = false;
  tray.innerHTML = `<span class="names"><b>${compareSet.size}</b> selected: ${esc(names.join(', '))}</span>
    <a class="btn light" href="#/compare">Compare ${icon('arrow-right')}</a>
    <button class="btn x" type="button" id="tray-clear" aria-label="Clear the comparison">${icon('x')}</button>`;
  tray.querySelector('#tray-clear').addEventListener('click', () => { compareSet.clear(); saveCompare(); });
}

function renderLive() {
  const el = document.getElementById('live');
  const last = lastChecked();
  const interval = (Number(db.status?.interval_hours) || 24) * 3600e3;
  const stale = !last || Date.now() - new Date(last) > interval * 2;
  el.className = `live${stale ? ' stale' : ''}`;
  el.innerHTML = `<b></b>Checked ${esc(timeAgo(last))}`;
  el.title = last ? `Last collector run: ${new Date(last).toLocaleString()}` : '';
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
  viewAbort.abort();
  viewAbort = new AbortController();
  sheetObserver?.disconnect();
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
  document.title = `${view.title} - PCS Atlas`;
  const navRoute = route.name === 'model' ? 'catalog' : route.name;
  document.querySelectorAll('#site-nav a').forEach((a) => {
    if (a.dataset.route === navRoute) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.getElementById('site-nav').classList.remove('open');
  document.getElementById('menu-button').setAttribute('aria-expanded', 'false');
  const search = document.querySelector('#header-search input');
  if (route.name === 'catalog') search.value = route.params.get('q') || '';
  else if (document.activeElement !== search) search.value = '';

  const handledFocus = view.after?.();
  renderTray();
  if (handledFocus) return;
  if (keepFocus && activeId) {
    const el = document.getElementById(activeId);
    if (el) { el.focus(); if (el.setSelectionRange && el.type !== 'checkbox') el.setSelectionRange(el.value.length, el.value.length); return; }
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
  input.placeholder = `Search ${idx.leaves.length} models`;
  input.addEventListener('input', () => {
    if (headerSearchHandler) { headerSearchHandler(input.value); return; }
    navigatedByLink = true;
    location.hash = input.value ? `#/?q=${encodeURIComponent(input.value)}` : '#/';
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (headerSearchHandler) { scrollToSection('models'); return; }
    location.hash = input.value ? `#/?q=${encodeURIComponent(input.value)}` : '#/';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (input.value) { input.value = ''; input.dispatchEvent(new Event('input')); } else input.blur();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    e.preventDefault();
    input.focus();
    input.select();
  });
  window.addEventListener('hashchange', () => render());
  history.scrollRestoration = 'manual';

  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href^="#"]');
    if (link) {
      if (link.dataset.scrollTo) { e.preventDefault(); scrollToSection(link.dataset.scrollTo); return; }
      navigatedByLink = true;
      return;
    }
    const compareBtn = e.target.closest('button[data-compare]');
    if (compareBtn) {
      if (!toggleCompare(compareBtn.dataset.compare)) compareBtn.textContent = `Max ${MAX_COMPARE} models`;
      return;
    }
    // Whole table rows open their model, except where a control was clicked.
    const row = e.target.closest('tr.item[data-href]');
    if (row && !e.target.closest('input, button, label, a') && !window.getSelection()?.toString()) {
      navigatedByLink = true;
      location.hash = row.dataset.href;
    }
  });
  document.addEventListener('change', (e) => {
    const box = e.target.closest('input[data-compare]');
    if (!box) return;
    if (!toggleCompare(box.dataset.compare)) {
      box.checked = false;
      box.title = `You can compare up to ${MAX_COMPARE} models`;
    }
  });
}

async function start() {
  try {
    await loadData();
  } catch (err) {
    document.getElementById('main').innerHTML = `<div class="wrap page"><div class="empty"><h3>The catalog could not load</h3><p>${esc(err.message)}. Please try again in a moment.</p></div></div>`;
    return;
  }
  db.specById = new Map(db.specs.map((s) => [s.id, s]));
  bindShell();
  renderLive();
  setInterval(renderLive, 60e3);
  render({ keepFocus: true });
}

start();
