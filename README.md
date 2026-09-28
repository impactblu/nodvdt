# PCS Atlas

A public, source-linked catalog of utility-scale battery storage inverters (PCS), published at **https://nodvdt.com**.
Every value links to the page of the manufacturer's datasheet it came from, and every datasheet revision is archived and downloadable.

```
 Supplier websites ──▶ Collector (Docker on the NAS) ──git push──▶ GitHub repo ──▶ Vercel ──▶ visitors
                       checks sources, archives PDFs,               data/ + datasheets/        static site
                       re-checks values
```

- **Visitors only reach Vercel.** Nothing on the NAS is exposed to the internet; the NAS only makes outgoing connections (to supplier sites and GitHub).
- **Changes go live automatically** and are labelled, with the previous value and a link to the previous datasheet kept for comparison.
- **No servers, databases or logins** to maintain. The repository history is the audit trail.

## Repository layout

| Path | What it is | Edited by |
|---|---|---|
| `site/` | The website (plain HTML, CSS, JavaScript; no build step) | people |
| `data/suppliers.json` | Suppliers, models, and the web pages/PDF links to watch | people |
| `data/fields.json` | Specification fields, units and groups | people |
| `data/specs.json` | Published values with their evidence, status and history | collector (people when reviewing) |
| `data/documents.json` | Every datasheet and all of its revisions | collector |
| `data/changes.json`, `data/status.json` | Change log and last-run report | collector |
| `datasheets/<hash>/<file>.pdf` | Archived copy of every datasheet revision | collector |
| `collector/` | The NAS collector (Python standard library + git + pdftotext) and its Docker files | people |
| `vercel.json`, `scripts/build-site.sh` | Vercel build: validates the data, then publishes only `site/`, `data/` and `datasheets/` | people |
| `.github/workflows/tests.yml` | Runs the collector tests when its code changes | people |

Setup instructions (GitHub, Vercel, NAS): **[docs/SETUP.md](docs/SETUP.md)**.

## Value statuses

| Status | Meaning |
|---|---|
| Reviewed | A reviewer checked it against the datasheet page. |
| Auto-read | Read from the datasheet table by the rules-based extractor (`collector/collector/extract.py`); not yet reviewed. |
| Auto-confirmed | The datasheet was revised and the same line was found again. |
| Auto-updated | A revised datasheet shows a different number; it went live automatically. The old value and old PDF are one click away. |
| Needs check | The line wasn't found in the revised datasheet; the old value is still shown, from the old revision. |

The automatic check only publishes a new number when the label before it and the unit after it both still match, and the
number is within 2× of the old one — anything else becomes *Needs check* rather than a guess.

## Automatic extraction (no AI at runtime)

Whenever the collector sees a datasheet version it hasn't read yet, `extract.py` reads the PDF as laid-out text and
applies field rules (labels, units, value formats) to three layouts: model-column tables with merged cells,
label/value rows, and "Label: value" lists. Each value keeps the exact datasheet text and page it came from.

- Values are only added where the catalog has none; reviewed values are never overwritten.
- Model columns are recognised with the supplier's `model_pattern` in `suppliers.json` (e.g. `\bFP\d{4}M[A-Z]{0,2}\d?\b`).
  Models not yet in the catalog are added to `data/models.json` automatically.
- When a datasheet is revised, extracted values are re-read from the same model column: unchanged, updated, or flagged.
- Anything ambiguous (two configurations in one row, pounds instead of kg, a value that can't be tied to a model column)
  is skipped rather than guessed.
- Improving a rule? Bump `EXTRACTOR_VERSION` in `extract.py`; the next run re-reads every datasheet and fills gaps.

The tests include a check that the extractor reproduces the hand-reviewed values from the real datasheets.

## Source highlights on the website

For every value, the collector also renders the datasheet page it came from as a JPEG
(`datasheets/<sha12>/page-<n>.jpg`, about 140 KB each) and stores where the value's row and cell sit on that page
(`highlight` in `data/specs.json`, as fractions of the page size). The model page shows that crop with the line
highlighted next to the value. This is `collector/collector/snapshots.py`; it uses poppler's `pdftotext -bbox-layout`
and `pdftoppm`, which the collector container already installs. If a row can't be located, the page is shown
without a box rather than with a wrong one.

## Common edits

**Watch a new supplier or model** — add it to `data/suppliers.json`:

```json
{ "id": "maker-model-x", "model": "Model X", "kind": "PCS with MV skid", "market": "United States",
  "sources": [{ "name": "Maker · Model X", "url": "https://maker.example/model-x",
                "allowed_hosts": ["maker.example", "cdn.maker.example"], "link_pattern": "datasheet, model-x" }] }
```

`summary` is the one-sentence public description shown on the site (keep internal remarks in `notes`, which the site never shows).
`url` can be a product page (PDF links on it that match `link_pattern` are collected) or a direct PDF link.
Sites that load downloads with JavaScript need the direct PDF link.

**Set a manufacturer's country** — each supplier in `data/suppliers.json` has a `company` block that drives the
country filter on the models page:

```
"company": { "hq_country": "US", "hq_city": "South Burlington, Vermont",
             "parent": { "name": "Parent Co", "country": "US", "note": "optional context" },
             "sources": [{ "title": "Where this comes from", "url": "https://..." }],
             "reviewed_by": "", "reviewed_at": "" }
```

Countries are two-letter ISO codes (`CN`, `US`, `ES`). A manufacturer counts for a country if it or its parent is
based there, so hiding China also hides a Chinese-owned maker with a head office elsewhere. Leave out `parent` for
independent companies. The site shows "Not reviewed yet" until `reviewed_by` and `reviewed_at` are filled in.
Filtered lists can be shared: `#/?hide=CN` or `#/?only=US,ES`.

**Add a table column** — every field in `data/fields.json` that has at least one value appears in the
"Columns" picker on the models page. `short` is the column heading; `label` is the full name shown in the picker.
A new field needs an extractor rule in `collector/collector/extract.py` (see `dc_inputs`) and an `EXTRACTOR_VERSION`
bump so existing datasheets are read again. Column choices are remembered per browser and kept in the URL
(`#/?cols=power,dc_max_v,dc_inputs`), so a table layout can be shared.

**Publish a value** — add an entry to `data/specs.json` (copy an existing one). Required: `product`, `field`,
`value`, `evidence` (the datasheet line, exactly as printed), `document`, `revision` (the sha256 from `documents.json`),
`page`, `status: "reviewed"`, `reviewed_by`, `reviewed_at`. If the evidence combines several table cells, also add
`anchor`: a shorter piece of text that appears in the PDF exactly, so the automatic check can find it.

**Review an auto-updated value** — open it on the site, compare both PDFs, then in `specs.json` set
`"status": "reviewed"` and add `reviewed_by` / `reviewed_at`.

Every Vercel deploy runs `python3 -m collector validate` first, so a typo in the JSON stops the deploy instead of breaking the site.

## Local preview and tests

```bash
python3 -m http.server 8000          # from the repository root, then open http://localhost:8000/site/
cd collector && python3 -m unittest discover -s tests -t tests   # needs poppler-utils for pdftotext
python3 -m collector run --once --no-git --root ..               # one collection pass on your local copy
```

## Notes

- Datasheets are © their manufacturers. They're archived so every value can be checked against its exact source; the
  manufacturer's link is always shown. Remove a document on request by deleting it from `documents.json`/`datasheets/`.
- Initial values (September 2026) came from an AI-assisted review of 13 datasheets and are labelled that way.
- An earlier design (FastAPI + SQLite on the NAS behind a login) was retired in favour of this static setup.
- This repository replaced the LT2 RFP Watcher at nodvdt.com (the watcher's code stays in `impactblu/lt2-rfp-watch`).
