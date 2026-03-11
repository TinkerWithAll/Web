# Security Feed Dashboard — Setup Guide

## How the AI Report Works (No Exposed API Keys)

The Anthropic API key **never touches the browser**. Here's the flow:

```
GitHub Actions (server)              Browser (client)
─────────────────────               ─────────────────
scraper.py runs at 05:00 PT         feed.html loads
  ↓ reads ANTHROPIC_API_KEY          ↓
  ↓ from GitHub Secrets              fetch("report.json")  ← just a static file
  ↓                                  ↓
  calls Anthropic API                render report
  ↓
  writes report.json
  ↓
  git commit & push
```

The "Refresh" and "Custom Prompt" buttons trigger a **GitHub Actions workflow_dispatch**
using a Fine-Grained Personal Access Token (PAT) with only `Actions: write` scope.
This PAT is stored in `GH_DISPATCH_TOKEN` Secret and injected into `config.js` at
build time. `config.js` is auto-generated and never committed to the repo source.

---

## Required GitHub Secrets

Go to: **Settings → Secrets and variables → Actions → New repository secret**

| Secret Name | Value | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Server-side AI report generation |
| `GH_DISPATCH_TOKEN` | Fine-grained PAT | Browser → trigger workflow_dispatch |

### Creating the Fine-Grained PAT for `GH_DISPATCH_TOKEN`

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. **Resource owner**: your account
3. **Repository access**: Only this repo (`TinkerWithAll/Web`)
4. **Permissions**: Actions → Read and Write
5. Copy the token → paste as `GH_DISPATCH_TOKEN` secret

---

## CSV Archive Policy

Every scraper run saves a `results_YYYYMMDD_HHMMSS.csv`. The cleanup logic:

- **Always keeps** the current run's CSV
- **For each calendar month**, keeps only the CSV from the **1st of that month**
  (or the earliest available if no 1st-of-month file exists)
- **Deletes** everything else

This means you'll have one archive CSV per month plus today's run — great for
historical analysis via the custom prompt.

---

## Schedule

The workflow runs at **05:00 Pacific Time** daily (`0 13 * * *` UTC in winter PST,
adjust to `0 12 * * *` during PDT daylight saving if needed).

To change it: edit `.github/workflows/daily_scrape.yml` → `cron:` line.

---

## Custom Prompt — How it Works

1. User types a prompt in the text box on the feed page
2. Browser calls GitHub API to trigger `daily_scrape.yml` with `custom_prompt` input
3. GitHub Actions runs `scraper.py` with `CUSTOM_PROMPT` env var set
4. `scraper.py` sends a different prompt to Anthropic (no JSON schema — free text)
5. Response is saved to `report.json` as `custom_response` field
6. Browser polls `report.json` every 8 seconds until `generated_at` changes (up to 3 min)
7. Report renders on the page

---

## Adding/Removing Terms or Feeds

- **`terms.txt`** — one keyword per line, `#` for comments
- **`feeds.txt`** — one RSS URL per line
- CISA KEV CVEs are automatically appended daily

---

## Local Testing

```bash
pip install feedparser beautifulsoup4 requests
export ANTHROPIC_API_KEY="sk-ant-..."
python scraper.py
```
