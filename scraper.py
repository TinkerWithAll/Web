#!/usr/bin/env python3
"""
scraper.py
- Parses 130+ security RSS feeds
- Scrapes Reddit, Mastodon/InfoSec.exchange, CCCS advisories
- Maintains a rolling 30-day history in feed_history.json
- ONE CSV per calendar month (results_YYYYMM.csv) — appends new rows each run
- Tracks per-feed article counts in feed_stats.json
- Calls Anthropic API server-side to produce report.json
- Accepts CUSTOM_PROMPT env var for on-demand analysis
- Updates meta.json with run timestamp

API keys are read from environment variables (GitHub Secrets).
They are NEVER committed to the repo or exposed in the browser.

Environment variables expected:
  ANTHROPIC_API_KEY   — your Anthropic API key (stored in GitHub Secrets)
  CUSTOM_PROMPT       — (optional) if set, overrides the default 48h report
  GH_DISPATCH_TOKEN   — (optional) GitHub PAT for workflow_dispatch from browser
                         This is injected into config.js at build time, not scraper.py
"""

import feedparser
from bs4 import BeautifulSoup
import csv
import sys
import io
import json
import glob
import os
import ssl
import socket
import time
import urllib.request
import urllib.error
import requests
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

# ── Encoding / SSL fixes ──────────────────────────────────────────
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
ssl._create_default_https_context = ssl._create_unverified_context
socket.setdefaulttimeout(300)

# ── Configuration ─────────────────────────────────────────────────
HISTORY_FILE      = "feed_history.json"
META_FILE         = "meta.json"
REPORT_FILE       = "report.json"
FEED_STATS_FILE   = "feed_stats.json"
ARTICLE_TREND_FILE= "article_trend.json"
HISTORY_DAYS   = 30
REPORT_HOURS   = 48     # window for the AI report
USE_CISA_CVES  = True
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
CUSTOM_PROMPT     = os.environ.get("CUSTOM_PROMPT", "").strip()
EASTERN_TZ        = ZoneInfo("America/New_York")
PACIFIC_TZ        = ZoneInfo("America/Los_Angeles")

# ── Extra source configuration ────────────────────────────────────
REDDIT_SUBREDDITS = [
    "netsec",        # top security research
    "cybersecurity", # broader community
    "netsecstudents",# CVE/vuln discussions
    "malware",       # malware & IoCs
    "canada",        # catches Canadian incidents like Loblaws etc.
]

MASTODON_INSTANCE = "infosec.exchange"  # hashtag search, not public timeline

MIN_PUBLISHED_DATE = datetime.today() - timedelta(days=HISTORY_DAYS)

# ── AI Toggle ─────────────────────────────────────────────────────
# TWO ways to disable AI (either is enough to turn it off):
#
#   1. Code-level:  set AI_REPORTS_ENABLED_CODE = False below
#   2. GitHub-level (no code change needed):
#        Settings → Secrets and variables → Actions → Variables tab
#        Add variable: AI_ENABLED = false   (or true to re-enable)
#        GitHub Actions Variables are not secret — a simple flag is fine here.
#
# The GitHub variable overrides the code flag, so you can pause
# API spending instantly from the GitHub UI without touching source.

AI_REPORTS_ENABLED_CODE = True   # ← flip to False to disable at code level

_env_flag = os.environ.get("AI_ENABLED", "").strip().lower()
if _env_flag == "false":
    AI_REPORTS_ENABLED = False
elif _env_flag == "true":
    AI_REPORTS_ENABLED = True
else:
    AI_REPORTS_ENABLED = AI_REPORTS_ENABLED_CODE  # fall back to code flag

print(f"AI reports: {'ENABLED' if AI_REPORTS_ENABLED else 'DISABLED'}", file=sys.stderr)


# ─────────────────────────────────────────────────────────────────
# CSV CLEANUP — keep only the first-of-month CSV archives
# plus the current run's file. Delete everything else.
# ─────────────────────────────────────────────────────────────────
# ─────────────────────────────────────────────────────────────────
# MONTHLY CSV — one file per calendar month, append-mode
# Filename: results_YYYYMM.csv  e.g. results_202603.csv
# Columns: Date, Source, Feed/Subreddit, Title, Link, Matched Terms
# ─────────────────────────────────────────────────────────────────
CSV_COLUMNS = ["Date", "Source", "Feed", "Title", "Link", "Matched Terms"]

def get_monthly_csv_path(dt: datetime = None) -> str:
    """Return the CSV path for the given month (default: current month ET)."""
    if dt is None:
        dt = datetime.now(timezone.utc).astimezone(EASTERN_TZ)
    return f"results_{dt.strftime('%Y%m')}.csv"


def load_existing_links_from_csv(csv_path: str) -> set:
    """Load all links already in the monthly CSV to avoid duplicates."""
    links = set()
    if not os.path.exists(csv_path):
        return links
    try:
        with open(csv_path, "r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                if row.get("Link"):
                    links.add(row["Link"])
    except Exception as e:
        print(f"  Could not read existing CSV {csv_path}: {e}", file=sys.stderr)
    return links


def append_to_monthly_csv(records: list, csv_path: str) -> int:
    """
    Append new records to the monthly CSV.
    Creates the file with headers if it doesn't exist.
    Skips records whose link is already in the file.
    Returns count of rows actually written.
    """
    existing_links = load_existing_links_from_csv(csv_path)
    new_records = [r for r in records if r.get("link", "") not in existing_links]

    if not new_records:
        print(f"  Monthly CSV: no new rows to append (all {len(records)} already present)", file=sys.stderr)
        return 0

    file_exists = os.path.exists(csv_path)
    with open(csv_path, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS, extrasaction="ignore")
        if not file_exists:
            writer.writeheader()
        for r in new_records:
            source_type = r.get("source_type", "rss").upper()
            # Feed = URL for RSS, subreddit for reddit, hashtag/instance for mastodon, url for cccs
            feed_id = r.get("feed_url", r.get("source_url", r.get("link", "")))
            writer.writerow({
                "Date":          r.get("date", ""),
                "Source":        source_type,
                "Feed":          feed_id,
                "Title":         r.get("title", ""),
                "Link":          r.get("link", ""),
                "Matched Terms": ", ".join(r.get("terms", [])),
            })

    print(f"  Monthly CSV {csv_path}: appended {len(new_records)} new rows", file=sys.stderr)
    return len(new_records)


def cleanup_csv_files():
    """Remove any old per-run CSVs (results_YYYYMMDD_HHMMSS.csv format).
    Monthly CSVs (results_YYYYMM.csv — 6 digit month) are kept forever."""
    removed = 0
    for f in glob.glob("results_*.csv"):
        # Old format has underscore after 8-digit date: results_20260311_065557.csv
        parts = f.replace(".csv", "").split("_")
        if len(parts) >= 3 and len(parts[1]) == 8:
            try:
                os.remove(f)
                print(f"  Removed old per-run CSV: {f}", file=sys.stderr)
                removed += 1
            except OSError:
                pass
    if removed:
        print(f"  Cleaned up {removed} old per-run CSV files", file=sys.stderr)


# ─────────────────────────────────────────────────────────────────
# FEED HELPERS
# ─────────────────────────────────────────────────────────────────
def load_list_from_file(filename):
    items = []
    try:
        with open(filename, "r", encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if s and not s.startswith("#"):
                    items.append(s)
    except FileNotFoundError:
        pass
    return items


def update_terms_with_cisa_cves(terms_file="terms.txt"):
    try:
        r = requests.get(
            "https://www.cisa.gov/sites/default/files/csv/known_exploited_vulnerabilities.csv",
            timeout=15
        )
        content = r.content.decode("utf-8", errors="ignore")
        cve_ids = set()
        reader = csv.DictReader(io.StringIO(content))
        for row in reader:
            if row.get("cveID", "").startswith("CVE-"):
                cve_ids.add(row["cveID"])
        existing = set(load_list_from_file(terms_file))
        new_cves = sorted(cve_ids - existing)
        if new_cves:
            with open(terms_file, "a", encoding="utf-8") as f:
                for cve in new_cves:
                    f.write(cve + "\n")
    except Exception as e:
        print(f"Error updating CVEs from CISA: {e}", file=sys.stderr)


def safe_parse_feed(url):
    try:
        return feedparser.parse(url)
    except Exception:
        return feedparser.FeedParserDict(entries=[])


def extract_links(html):
    links = []
    if not html:
        return links
    soup = BeautifulSoup(html, "html.parser")
    for a in soup.find_all("a", href=True):
        links.append((a["href"].strip(), a.get_text().strip()))
    return links


def parse_feeds(feed_urls, search_terms):
    """Parse RSS feeds and return matched entries. Tracks per-feed article counts."""
    entries    = []
    feed_stats = {}   # url -> {"total": N, "matched": N}

    for url in feed_urls:
        print(f"Parsing {url}...", file=sys.stderr)
        d     = safe_parse_feed(url)
        total = 0
        matched_count = 0

        for e in d.entries:
            link = e.get("link", "")
            published_dt = None
            try:
                dt_tuple = e.get("published_parsed") or e.get("updated_parsed")
                if dt_tuple:
                    published_dt = datetime(*dt_tuple[:6])
            except Exception:
                pass

            if not published_dt or published_dt < MIN_PUBLISHED_DATE:
                continue

            total += 1
            title   = e.get("title", "")
            summary = e.get("summary", "")
            content = e.get("content", [{"value": ""}])[0]["value"]
            text_all = f"{title} {summary} {content}".lower()

            matched = [t for t in search_terms if t.lower() in text_all]

            inline_matches = []
            for href, txt in extract_links(content + summary):
                for term in search_terms:
                    if term.lower() in txt.lower():
                        inline_matches.append({"term": term, "text": txt, "url": href})
                        if term.lower() not in matched:
                            matched.append(term.lower())

            if matched:
                matched_count += 1
                entries.append({
                    "title":        title,
                    "link":         link,
                    "feed_url":     url,
                    "date":         published_dt.strftime("%Y-%m-%d"),
                    "terms":        matched,
                    "inline_links": inline_matches,
                    "source_type":  "rss",
                })

        feed_stats[url] = {"total": total, "matched": matched_count}

    # Persist per-feed stats
    update_feed_stats(feed_stats)
    return entries


def update_feed_stats(new_counts: dict):
    """Merge new per-feed counts into feed_stats.json (cumulative totals)."""
    stats = {}
    if os.path.exists(FEED_STATS_FILE):
        try:
            with open(FEED_STATS_FILE, "r", encoding="utf-8") as f:
                stats = json.load(f)
        except Exception:
            pass

    run_date = datetime.now(timezone.utc).astimezone(EASTERN_TZ).strftime("%Y-%m-%d")
    for url, counts in new_counts.items():
        if url not in stats:
            stats[url] = {"total_all_time": 0, "matched_all_time": 0, "runs": []}
        stats[url]["total_all_time"]   += counts["total"]
        stats[url]["matched_all_time"] += counts["matched"]
        stats[url]["last_run_date"]     = run_date
        stats[url]["last_run_total"]    = counts["total"]
        stats[url]["last_run_matched"]  = counts["matched"]
        # Keep last 90 daily snapshots for trend charting
        stats[url]["runs"].append({
            "date": run_date,
            "total": counts["total"],
            "matched": counts["matched"],
        })
        stats[url]["runs"] = stats[url]["runs"][-90:]

    try:
        with open(FEED_STATS_FILE, "w", encoding="utf-8") as f:
            json.dump(stats, f, indent=2)
    except Exception as e:
        print(f"  Could not save feed_stats: {e}", file=sys.stderr)


def update_history_file(new_entries):
    history = []
    if os.path.exists(HISTORY_FILE):
        try:
            with open(HISTORY_FILE, "r", encoding="utf-8") as f:
                history = json.load(f)
        except Exception:
            pass

    history_dict = {item["link"]: item for item in history}
    for entry in new_entries:
        history_dict[entry["link"]] = entry

    full_list = sorted(history_dict.values(), key=lambda x: x["date"], reverse=True)
    cutoff = (datetime.now() - timedelta(days=HISTORY_DAYS)).strftime("%Y-%m-%d")
    clean_list = [x for x in full_list if x["date"] >= cutoff]

    with open(HISTORY_FILE, "w", encoding="utf-8") as f:
        json.dump(clean_list, f, indent=2)

    return clean_list


# save_csv kept for backward compat but monthly CSV is now used instead
def save_csv(records, filename):
    """Legacy: write a one-off CSV. Monthly append is now preferred."""
    with open(filename, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=CSV_COLUMNS, extrasaction="ignore")
        w.writeheader()
        for r in records:
            source_type = r.get("source_type", "rss").upper()
            feed_id = r.get("feed_url", r.get("source_url", r.get("link", "")))
            w.writerow({
                "Date": r.get("date",""), "Source": source_type,
                "Feed": feed_id, "Title": r.get("title",""),
                "Link": r.get("link",""),
                "Matched Terms": ", ".join(r.get("terms",[])),
            })


def save_metadata(source_counts: dict = None):
    now_utc     = datetime.now(timezone.utc)
    now_eastern = now_utc.astimezone(EASTERN_TZ)
    timestamp   = now_eastern.strftime("%Y-%m-%d %H:%M %Z")
    try:
        with open(META_FILE, "w", encoding="utf-8") as f:
            json.dump({"last_updated": timestamp}, f)
        print(f"Updated {META_FILE}: {timestamp}", file=sys.stderr)
    except Exception as e:
        print(f"Error saving metadata: {e}", file=sys.stderr)

    # Update article count trend (one entry per day)
    if source_counts:
        try:
            trend = []
            if os.path.exists(ARTICLE_TREND_FILE):
                with open(ARTICLE_TREND_FILE, "r", encoding="utf-8") as f:
                    trend = json.load(f)
            today = now_eastern.strftime("%Y-%m-%d")
            # Replace today's entry if it exists, otherwise append
            trend = [t for t in trend if t.get("date") != today]
            trend.append({"date": today, **source_counts})
            trend = sorted(trend, key=lambda x: x["date"])[-365:]  # keep 1 year
            with open(ARTICLE_TREND_FILE, "w", encoding="utf-8") as f:
                json.dump(trend, f, indent=2)
        except Exception as e:
            print(f"Error saving article trend: {e}", file=sys.stderr)


# ─────────────────────────────────────────────────────────────────
# AI REPORT GENERATION
# ─────────────────────────────────────────────────────────────────
def get_48h_entries(full_history):
    """Return only entries from the last 48 hours."""
    cutoff = (datetime.now() - timedelta(hours=48)).strftime("%Y-%m-%d")
    return [e for e in full_history if e.get("date", "") >= cutoff]

def get_2week_entries(full_history):
    """Return entries from the last 14 days."""
    cutoff = (datetime.now() - timedelta(days=14)).strftime("%Y-%m-%d")
    return [e for e in full_history if e.get("date", "") >= cutoff]


def build_default_prompt(recent_entries, window_label="48h"):
    """Build the structured analysis prompt from recent feed entries."""
    if not recent_entries:
        return (
            f"The security feed returned no new articles in the last {window_label}. "
            "Please write a brief report noting this and provide general security posture advice."
        )

    # Include link so AI can pass it through to source_url in output
    articles_text = []
    for e in recent_entries[:150]:
        source = e.get("source_type", "rss").upper()
        terms  = ", ".join(e.get("terms", []))
        link   = e.get("link", "")
        articles_text.append(f"[{e['date']}][{source}] {e['title']} | URL: {link} | Terms: {terms}")

    articles_block = "\n".join(articles_text)

    return f"""You are a senior cybersecurity analyst. Based on the following security news articles from the last {window_label}, produce a structured threat intelligence briefing.

Sources: 130+ RSS feeds, Reddit (r/netsec r/cybersecurity r/canada), Mastodon/InfoSec.exchange, CCCS advisories.
Tags: [RSS]=news [REDDIT]=community [MASTODON]=infosec community [CCCS]=official Canadian govt advisories.

ARTICLES:
{articles_block}

Respond ONLY with valid JSON (no markdown fences, no preamble) matching this exact schema:

{{
  "executive_summary": "3-5 sentences written in plain English for a non-technical reader. Lead with the single most urgent finding. Call out anything actively exploited, zero-day, or involving a major breach by name. Make it punchy and specific — not generic.",
  "vulnerabilities": {{
    "count": <integer>,
    "items": [
      {{
        "id": "CVE-XXXX-XXXXX",
        "description": "brief one-line description of the vulnerability",
        "criticality": "CRITICAL|HIGH|MEDIUM|LOW",
        "actively_exploited": true or false,
        "zero_day": true or false,
        "software_affected": "vendor/product name and version if known",
        "cia_impact": "e.g. Confidentiality: High, Integrity: High, Availability: Low",
        "access_required": "e.g. Network / No auth required",
        "source_url": "the URL from the article that reported this CVE"
      }}
    ]
  }},
  "threat_actors": {{
    "items": [
      {{
        "name": "Threat Actor Name (aliases)",
        "targets": "who was breached or targeted",
        "ttps": "key TTPs, referenced as MITRE ATT&CK IDs where possible",
        "iocs": ["ip/domain/hash"],
        "source_url": "the URL from the article that reported this actor"
      }}
    ]
  }},
  "canada_landscape": {{
    "summary": "2-3 sentence overview of the Canadian cyber landscape, including any CCCS advisories",
    "retailers": "any Canadian retail incidents — Loblaws, Canadian Tire, SportChek, Shoppers Drug Mart, etc.; otherwise 'None identified'",
    "financial": "any Canadian financial incidents — CIBC, RBC, TD, Scotiabank, BMO, etc.; otherwise 'None identified'",
    "source_urls": ["URLs of any Canada-related articles"]
  }},
  "generated_at": "<current Eastern Time>"
}}

Rules:
- Only include CVEs and TAs that actually appear in the article list above.
- Set actively_exploited=true if the article mentions "actively exploited", "in the wild", "0-day", "zero-day", or "PoC available".
- Set zero_day=true if the article mentions "zero-day", "0-day", or "no patch available".
- source_url must be copied exactly from the URL field of the matching article.
- For Canada section look for: Canada, Canadian, Ontario, Quebec, CCCS, Loblaws, Canadian Tire, CIBC, RBC, TD, Scotiabank, BMO.
- Pay special attention to [CCCS] items — these are official Canadian government cybersecurity advisories.
- executive_summary must be plain English, no jargon acronyms without explanation, written as if briefing a VP.
- generated_at must be current Eastern Time in format "YYYY-MM-DD HH:MM ET"."""


def build_custom_prompt(user_prompt, full_history):
    """Build a prompt that gives the model context + the user's question."""
    recent = get_48h_entries(full_history)
    all_recent = full_history[:200]   # broader context for custom queries

    articles_text = []
    for e in all_recent:
        terms = ", ".join(e.get("terms", []))
        articles_text.append(f"[{e['date']}] {e['title']} | Terms: {terms}")
    articles_block = "\n".join(articles_text)

    return f"""You are a senior cybersecurity analyst. You have access to the following security 
news articles scraped from 130+ feeds over the last 30 days:

{articles_block}

The user has asked the following question or requested the following analysis:
"{user_prompt}"

Respond with a clear, well-structured analysis in plain text (you may use markdown headings 
and bullet points). Be specific and cite article titles or dates where relevant.
Do NOT use JSON — just write a readable intelligence report."""


def call_anthropic(prompt: str) -> dict | None:
    """Call Anthropic claude-sonnet and return parsed JSON or a text response."""
    if not ANTHROPIC_API_KEY:
        print("ANTHROPIC_API_KEY not set — skipping AI report.", file=sys.stderr)
        return None

    import urllib.request

    headers = {
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type":      "application/json",
    }
    body = json.dumps({
        "model":      "claude-sonnet-4-5",
        "max_tokens": 4096,
        "messages":   [{"role": "user", "content": prompt}],
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            text = data["content"][0]["text"].strip()
            return text
    except Exception as e:
        print(f"Anthropic API error: {e}", file=sys.stderr)
        return None


def generate_and_save_report(full_history: list):
    """Generate the AI report and save it to report.json."""
    now_et = datetime.now(timezone.utc).astimezone(EASTERN_TZ).strftime("%Y-%m-%d %H:%M ET")

    # If AI is disabled, write a minimal report.json so the frontend
    # knows to show a "disabled" state rather than an error.
    if not AI_REPORTS_ENABLED:
        report = {
            "ai_enabled":    False,
            "generated_at":  now_et,
            "message":       "AI analysis is currently disabled by the site administrator.",
        }
        with open(REPORT_FILE, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)
        print(f"AI disabled — wrote placeholder {REPORT_FILE}", file=sys.stderr)
        return

    if CUSTOM_PROMPT:
        print(f"Generating CUSTOM report: '{CUSTOM_PROMPT[:80]}'", file=sys.stderr)
        prompt = build_custom_prompt(CUSTOM_PROMPT, full_history)
        response_text = call_anthropic(prompt)

        if response_text is None:
            report = {
                "ai_enabled":      True,
                "generated_at":    now_et,
                "error":           "Anthropic API unavailable",
                "custom_response": "Error: Could not reach Anthropic API.",
            }
        else:
            report = {
                "ai_enabled":      True,
                "generated_at":    now_et,
                "custom_response": response_text,
            }

    else:
        def parse_ai_response(response_text, now_et):
            if response_text is None:
                return {"ai_enabled": True, "generated_at": now_et, "error": "Anthropic API unavailable"}
            try:
                clean = response_text.strip()
                if clean.startswith("```"):
                    clean = "\n".join(clean.split("\n")[1:])
                if clean.endswith("```"):
                    clean = "\n".join(clean.split("\n")[:-1])
                r = json.loads(clean)
                r["ai_enabled"] = True
                if "generated_at" not in r:
                    r["generated_at"] = now_et
                return r
            except json.JSONDecodeError as e:
                print(f"JSON parse error: {e}", file=sys.stderr)
                return {"ai_enabled": True, "generated_at": now_et, "custom_response": response_text}

        # 48h report
        print("Generating 48h report...", file=sys.stderr)
        entries_48h = get_48h_entries(full_history)
        print(f"  {len(entries_48h)} articles in last 48h.", file=sys.stderr)
        report = parse_ai_response(call_anthropic(build_default_prompt(entries_48h, "48h")), now_et)
        report["window"] = "48h"

        # 2-week report
        print("Generating 2-week report...", file=sys.stderr)
        entries_2w = get_2week_entries(full_history)
        print(f"  {len(entries_2w)} articles in last 2 weeks.", file=sys.stderr)
        report_2w = parse_ai_response(call_anthropic(build_default_prompt(entries_2w, "2 weeks")), now_et)
        report_2w["window"] = "2w"
        report["report_2w"] = report_2w

    with open(REPORT_FILE, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(f"Saved {REPORT_FILE}", file=sys.stderr)


# ─────────────────────────────────────────────────────────────────
# ─────────────────────────────────────────────────────────────────
# ─────────────────────────────────────────────────────────────────
# REDDIT SCRAPER
# Uses RSS feeds (reddit.com/r/sub/.rss) — much more reliable than
# the JSON API which blocks GitHub Actions IPs aggressively.
# Also tries the old.reddit.com JSON endpoint as fallback.
# ─────────────────────────────────────────────────────────────────
def fetch_reddit(subreddits: list, search_terms: list) -> list:
    """Fetch posts from subreddits via RSS (most reliable from CI environments)."""
    entries = []
    cutoff  = datetime.utcnow() - timedelta(days=HISTORY_DAYS)

    # Build a set of lowercase terms for fast matching
    terms_lower = [t.lower() for t in search_terms]

    for sub in subreddits:
        # Try RSS first — GitHub Actions IPs are rarely blocked for RSS
        rss_url = f"https://www.reddit.com/r/{sub}/new/.rss?limit=100"
        print(f"Reddit: fetching r/{sub} via RSS...", file=sys.stderr)
        time.sleep(1.5)  # polite delay

        try:
            d = feedparser.parse(rss_url)
            count_before = len(entries)
            for e in d.entries:
                link = e.get("link", "")
                published_dt = None
                try:
                    dt_tuple = e.get("published_parsed") or e.get("updated_parsed")
                    if dt_tuple:
                        published_dt = datetime(*dt_tuple[:6])
                except Exception:
                    pass

                if not published_dt or published_dt < cutoff:
                    continue

                title   = e.get("title", "")
                summary = e.get("summary", "")
                soup    = BeautifulSoup(summary, "html.parser")
                plain   = soup.get_text(" ", strip=True)
                text_all = f"{title} {plain}".lower()

                matched = [t for t in search_terms if t.lower() in text_all]
                if matched:
                    entries.append({
                        "title":        f"[r/{sub}] {title}",
                        "link":         link,
                        "source_url":   link,
                        "date":         published_dt.strftime("%Y-%m-%d"),
                        "terms":        matched,
                        "inline_links": [],
                        "source_type":  "reddit",
                    })
            got = len(entries) - count_before
            print(f"  r/{sub}: {got} matched from RSS", file=sys.stderr)

        except Exception as e:
            print(f"  Reddit r/{sub} RSS error: {e}", file=sys.stderr)

    print(f"Reddit total: {len(entries)} matched posts", file=sys.stderr)
    return entries


# ─────────────────────────────────────────────────────────────────
# MASTODON SCRAPER
# Searches security-relevant hashtags instead of the public timeline.
# Hashtag search returns posts from federated instances too, not just
# local accounts — dramatically more relevant content.
# ─────────────────────────────────────────────────────────────────
MASTODON_HASHTAGS = [
    "cybersecurity", "infosec", "cve", "ransomware", "databreach",
    "threatintel", "malware", "vulnerability", "canada", "canadian",
    "phishing", "apt", "ics", "scada", "zeroday",
]
MASTODON_PER_TAG = 40  # posts per hashtag

def fetch_mastodon(search_terms: list) -> list:
    """Search security hashtags on InfoSec.exchange."""
    entries    = {}   # keyed by post URL to deduplicate
    cutoff     = datetime.utcnow() - timedelta(days=HISTORY_DAYS)
    terms_lower = [t.lower() for t in search_terms]

    for tag in MASTODON_HASHTAGS:
        url = f"https://{MASTODON_INSTANCE}/api/v1/timelines/tag/{tag}?limit={MASTODON_PER_TAG}"
        try:
            print(f"Mastodon: #{tag}...", file=sys.stderr)
            time.sleep(0.5)
            resp = requests.get(url, timeout=15)
            if resp.status_code != 200:
                print(f"  Mastodon #{tag} → {resp.status_code}", file=sys.stderr)
                continue

            for post in resp.json():
                post_url = post.get("url", "")
                if not post_url or post_url in entries:
                    continue

                created_str = post.get("created_at", "")
                try:
                    published_dt = datetime.strptime(created_str, "%Y-%m-%dT%H:%M:%S.%fZ")
                except Exception:
                    try:
                        published_dt = datetime.strptime(created_str, "%Y-%m-%dT%H:%M:%SZ")
                    except Exception:
                        continue

                if published_dt < cutoff:
                    continue

                raw_content = post.get("content", "")
                soup        = BeautifulSoup(raw_content, "html.parser")
                plain_text  = soup.get_text(" ", strip=True)
                text_all    = plain_text.lower()

                # Always include CCCS-tagged or Canada posts; otherwise match terms
                hashtags_in_post = [t.get("name","").lower() for t in post.get("tags", [])]
                canada_post = any(h in ("canada","canadian","cccs") for h in hashtags_in_post)
                matched = [t for t in search_terms if t.lower() in text_all]

                if matched or canada_post:
                    if not matched:
                        matched = ["infosec"]
                    account  = post.get("account", {})
                    username = account.get("acct", "unknown")
                    title    = plain_text[:140] + ("…" if len(plain_text) > 140 else "")
                    entries[post_url] = {
                        "title":        f"[Mastodon @{username}] {title}",
                        "link":         post_url,
                        "source_url":   post_url,
                        "date":         published_dt.strftime("%Y-%m-%d"),
                        "terms":        matched,
                        "inline_links": [],
                        "source_type":  "mastodon",
                    }

        except Exception as e:
            print(f"  Mastodon #{tag} error: {e}", file=sys.stderr)

    result = list(entries.values())
    print(f"Mastodon total: {len(result)} unique matched posts", file=sys.stderr)
    return result


# ─────────────────────────────────────────────────────────────────
# CCCS SCRAPER — Canadian Centre for Cyber Security
# Uses multiple known working feed URLs + HTML scrape fallback.
# ─────────────────────────────────────────────────────────────────
CCCS_FEEDS = [
    # Primary RSS feeds — try all, some may 404 depending on CMS version
    "https://www.cyber.gc.ca/en/alerts-advisories/feed",
    "https://cyber.gc.ca/en/alerts-advisories/feed",
    "https://www.cyber.gc.ca/api/v1/rss/alerts",
    "https://www.cyber.gc.ca/api/v1/rss/advisories",
    # Fallback — CCCS content also syndicated through Public Safety Canada
    "https://www.publicsafety.gc.ca/cnt/ntnl-scrt/cbr-scrt/rssfeed-en.aspx",
]

def fetch_cccs(search_terms: list) -> list:
    """Fetch CCCS alerts and advisories — try multiple feed URLs."""
    entries = {}
    cutoff  = datetime.utcnow() - timedelta(days=HISTORY_DAYS)
    found_working = False

    for feed_url in CCCS_FEEDS:
        try:
            print(f"CCCS: trying {feed_url}...", file=sys.stderr)
            d = feedparser.parse(feed_url)
            if not d.entries:
                print(f"  No entries from {feed_url}", file=sys.stderr)
                continue

            found_working = True
            count_before  = len(entries)
            for e in d.entries:
                link = e.get("link", "")
                if not link or link in entries:
                    continue
                published_dt = None
                try:
                    dt_tuple = e.get("published_parsed") or e.get("updated_parsed")
                    if dt_tuple:
                        published_dt = datetime(*dt_tuple[:6])
                except Exception:
                    pass

                if not published_dt:
                    published_dt = datetime.utcnow()  # fallback: treat as today

                if published_dt < cutoff:
                    continue

                title   = e.get("title", "Untitled CCCS Advisory")
                summary = e.get("summary", "")
                text_all = f"{title} {summary}".lower()

                # Match against user terms; CCCS items always included regardless
                matched = [t for t in search_terms if t.lower() in text_all]
                if not matched:
                    matched = ["cccs-advisory"]

                entries[link] = {
                    "title":        f"[CCCS] {title}",
                    "link":         link,
                    "source_url":   link,
                    "date":         published_dt.strftime("%Y-%m-%d"),
                    "terms":        matched,
                    "inline_links": [],
                    "source_type":  "cccs",
                }

            got = len(entries) - count_before
            print(f"  CCCS {feed_url}: {got} items", file=sys.stderr)

        except Exception as ex:
            print(f"  CCCS feed error {feed_url}: {ex}", file=sys.stderr)

    if not found_working:
        print("  CCCS: all feeds returned empty — URLs may need updating", file=sys.stderr)

    result = list(entries.values())
    print(f"CCCS total: {len(result)} items", file=sys.stderr)
    return result


# MAIN
# ─────────────────────────────────────────────────────────────────
def main():
    # 1. Update CISA CVE list
    if USE_CISA_CVES:
        update_terms_with_cisa_cves()

    # 2. Load config
    terms = load_list_from_file("terms.txt")
    if not USE_CISA_CVES:
        terms = [t for t in terms if not t.upper().startswith("CVE-")]
    feeds = load_list_from_file("feeds.txt")

    # 3. Scrape RSS feeds
    print("Scanning RSS feeds...", file=sys.stderr)
    rss_matches = parse_feeds(feeds, terms)

    # 4. Scrape Reddit
    print("Scanning Reddit...", file=sys.stderr)
    reddit_matches = fetch_reddit(REDDIT_SUBREDDITS, terms)

    # 5. Scrape Mastodon / InfoSec.exchange
    print("Scanning Mastodon...", file=sys.stderr)
    mastodon_matches = fetch_mastodon(terms)

    # 6. Scrape CCCS
    print("Scanning CCCS...", file=sys.stderr)
    cccs_matches = fetch_cccs(terms)

    # 7. Merge all sources — deduplicate by link
    all_matches_dict = {}
    for entry in rss_matches + cccs_matches + reddit_matches + mastodon_matches:
        link = entry.get("link", "")
        if link and link not in all_matches_dict:
            all_matches_dict[link] = entry
    new_matches = list(all_matches_dict.values())

    source_summary = (
        f"RSS:{len(rss_matches)} Reddit:{len(reddit_matches)} "
        f"Mastodon:{len(mastodon_matches)} CCCS:{len(cccs_matches)} "
        f"Total:{len(new_matches)}"
    )
    print(f"Sources — {source_summary}", file=sys.stderr)

    # 8. Update 30-day rolling history
    full_history = update_history_file(new_matches)

    # 9. Append to monthly CSV (one file per calendar month, all sources)
    monthly_csv = get_monthly_csv_path()
    rows_added  = append_to_monthly_csv(new_matches, monthly_csv)
    print(f"Monthly CSV {monthly_csv}: {rows_added} rows added this run", file=sys.stderr)

    # 10. Clean up any old per-run CSVs left over from previous scraper version
    cleanup_csv_files()

    # 11. Source counts for trend tracking
    source_counts = {
        "rss":      len(rss_matches),
        "reddit":   len(reddit_matches),
        "mastodon": len(mastodon_matches),
        "cccs":     len(cccs_matches),
        "total":    len(new_matches),
    }

    # 12. Save metadata timestamp + article trend
    save_metadata(source_counts)

    # 13. Generate AI report (server-side, uses ANTHROPIC_API_KEY secret)
    generate_and_save_report(full_history)

    print(f"Done. History: {len(full_history)} entries total.", file=sys.stderr)


if __name__ == "__main__":
    main()
