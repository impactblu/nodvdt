# Setting up PCS Atlas

Four parts, in this order. The site is live after Part 2; Part 3 keeps it up to date.

1. **GitHub** — put the files in `impactblu/nodvdt` (Windows + VS Code)
2. **Vercel** — create the project and move `nodvdt.com` to it (Namecheap DNS stays as it is)
3. **NAS** — run the collector in UGOS Docker
4. **Retire the LT2 RFP Watcher**

```
Supplier sites ──▶ NAS collector ──git push──▶ impactblu/nodvdt (private) ──▶ Vercel ──▶ nodvdt.com
```

---

## Part 1 — GitHub (on your Windows PC)

**1.1 Unzip.** Right-click the downloaded zip → **Extract All…** → extract to `Downloads\pcs-atlas-v2`.
Inside you should see `README.md`, `site`, `data`, `datasheets`, `collector`, `docs`, `scripts`, `.github`, `vercel.json`.

**1.2 Git.** VS Code → terminal (**Ctrl+`**) → `git --version`. If it isn't found, install Git from git-scm.com
(defaults are fine) and restart VS Code. Then make sure your commits use the email linked to GitHub/Vercel:

```powershell
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"
```

**1.3 Clone.** **Ctrl+Shift+P** → **Git: Clone** → **Clone from GitHub** → `impactblu/nodvdt` → choose a folder
(e.g. `Documents\GitHub`) → **Open**.

**1.4 Replace the contents.** In the VS Code terminal (it opens in the repository folder):

```powershell
git pull
git branch backup-before-pcs-atlas
git push origin backup-before-pcs-atlas
git rm -r -q .
Copy-Item -Path "$HOME\Downloads\pcs-atlas-v2\*" -Destination . -Recurse -Force
git add -A
git status
```

The backup branch keeps whatever was in the repo before. If the repo was empty, `git branch`/`git rm` may complain —
that's fine, carry on. `git status` should list new files such as `site/index.html`, `vercel.json`, `data/specs.json`.

> If the bottom-left corner of VS Code shows a branch other than `main`, use that name instead of `main` below,
> and set `GIT_BRANCH` to it in Part 3.

**1.5 Commit and push.**

```powershell
git commit -m "PCS Atlas website and collector"
git push origin main
```

## Part 2 — Vercel

**2.1 Create the project.** vercel.com → **Add New… → Project** → import **impactblu/nodvdt**.
If it isn't listed, click **Adjust GitHub App Permissions** and give Vercel access to that repo.

- Framework Preset: **Other**
- Leave Build Command, Output Directory and Install Command **empty / not overridden** — `vercel.json` in the repo sets them.
- **Deploy.**

**2.2 Check it.** Open the `….vercel.app` address Vercel shows. You should see the catalog with 8 models; open
*SC5000UD-MV-US-P3*, expand a value and click **Open page 2** — the datasheet should open at that page.

If the build fails, copy the last lines of the build log to Claude.

**2.3 Move the domain.**

1. Old project **lt2-rfp-watch → Settings → Domains** → remove `nodvdt.com` and `www.nodvdt.com`.
2. New project **nodvdt → Settings → Domains** → add `nodvdt.com`, and `www.nodvdt.com` (let Vercel redirect www to the main domain, as before).
3. Vercel should show both as **Valid Configuration**, because Namecheap already points at Vercel. If it shows
   different DNS values instead, change the records in Namecheap to exactly what Vercel shows (leave MX/SPF/DKIM/DMARC alone).

Open https://nodvdt.com — it should now show PCS Atlas.

## Part 3 — NAS collector (UGOS web interface)

**3.1 Token.** github.com → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**

- Name `pcs-atlas-nas`, longest expiration allowed (set a reminder to renew)
- Repository access: **Only select repositories → impactblu/nodvdt**
- Repository permissions: **Contents → Read and write**. Nothing else.

**3.2 The .env file (on Windows).** In VS Code create a new file **outside the repository**, e.g. `Documents\pcs-atlas-nas\.env`.
Paste the contents of `collector\.env.example` and fill in:

- `GITHUB_TOKEN=` the new token
- `GIT_AUTHOR_NAME=` and `GIT_AUTHOR_EMAIL=` — the **same values as in the LT2 watcher's `.env`**
  (`Shared folder/docker/lt2-watcher/app/.env`). Vercel skips deploys from authors it doesn't recognise.

**3.3 Folders (UGOS File Manager → Shared folder → docker).**

- If a `pcs-atlas` folder already exists from the earlier attempt, first delete the old *pcs-atlas* project in
  **Docker → Project**, then rename that folder to `pcs-atlas-old`.
- Create folder **`pcs-atlas`**, and inside it an empty folder **`checkout`**.
- Upload your `.env` into `pcs-atlas`. Check the name is exactly `.env` (not `.env.txt`).

**3.4 Create the project (Docker app → Project → Create).**

- Name: `pcs-atlas`
- Storage path: **Shared folder/docker/pcs-atlas** (the folder itself)
- Compose configuration: paste the whole of `collector\compose.yaml`
- Keep *Run immediately after creation* ticked → **Deploy**

**3.5 Check the log (Docker → Container → pcs-atlas-collector → Log).** After the package install you should see:

```
===== First start: cloning repository =====
===== Starting PCS Atlas collector =====
… INFO Collector: checked 9 sources, …
… INFO Pushed to impactblu/nodvdt (main)
```

Then: GitHub shows a new commit from your name, Vercel deploys it, and the grey line under the site header changes to
**"Sources last checked …"**. *How it works → Source check status* lists each supplier source; some manufacturer sites
block downloads or need a direct PDF link — those show as problems there and are fixed by editing `data/suppliers.json`.

The collector then runs every 24 hours (`CHECK_INTERVAL_HOURS` in `.env`; restart the project after changing it).
To pick up new collector code after a push to GitHub: **Stop** and **Start** the project.

## Part 4 — Retire the LT2 RFP Watcher

1. **UGOS Docker → Project → lt2watcher → Stop**, then delete the project. Keep the `lt2-watcher` folder as an archive (don't delete files).
2. Vercel: the `lt2-rfp-watch` project can stay (it's still at lt2-rfp-watch.vercel.app) or be deleted.
3. GitHub: optionally **Settings → Archive this repository** on `impactblu/lt2-rfp-watch`, and delete the LT2 token
   once nothing uses it.

## Troubleshooting

| Where | Message | Fix |
|---|---|---|
| NAS log | `Authentication failed` / `403` during clone or push | Token expired or lacks Contents: Read and write on impactblu/nodvdt. Fix `.env`, then restart the project. |
| NAS log | `…/checkout/repo exists but is not a git clone` | A first clone was interrupted. Stop the project, empty the `checkout` folder, start again. |
| NAS log | `GIT_AUTHOR_EMAIL is not set` warning | Add the LT2 author email to `.env`, restart. |
| Vercel | Deployment "blocked" or skipped for a collector commit | Commit author isn't recognised — same fix as above. |
| Vercel | Build fails with `Data problems found` | A hand edit broke `data/*.json`; the log lists what. Fix and push. |
| Site | A source shows *No matching PDF links* | That site loads downloads with JavaScript. Add the direct PDF URL as another source in `data/suppliers.json`. |
