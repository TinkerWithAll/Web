#!/usr/bin/env python3
"""
scraper.py
- Parses 130+ security RSS feeds
- Scrapes Reddit (r/netsec, r/cybersecurity, r/canada_crime, r/Canada)
- Scrapes Mastodon / InfoSec.exchange public timeline
- Scrapes Canadian Centre for Cyber Security (CCCS) advisories
- Maintains a rolling 30-day history in feed_history.json
- Generates a timestamped CSV (cleans up old ones, keeps monthly archives)
- Calls Anthropic API server-side to produce report.json
- Accepts an optional CUSTOM_PROMPT env var for on-demand analysis
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
HISTORY_FILE   = "feed_history.json"
META_FILE      = "meta.json"
REPORT_FILE    = "report.json"
HISTORY_DAYS   = 30
REPORT_HOURS   = 48     # window for the AI report
USE_CISA_CVES  = True
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
CUSTOM_PROMPT     = os.environ.get("CUSTOM_PROMPT", "").strip()
EASTERN_TZ        = ZoneInfo("America/New_York")
PACIFIC_TZ        = ZoneInfo("America/Los_Angeles")

# ── Extra source configuration ────────────────────────────────────
# Reddit — uses the free JSON API (no auth needed for public subreddits)
REDDIT_SUBREDDITS = [
    "netsec",           # top security research subreddit
    "cybersecurity",    # broader security community
    "netsecstudents",   # CVE/vuln discussions
    "malware",          # malware analysis & IoCs
    "canada",           # catches Canadian breach news
]
REDDIT_POSTS_PER_SUB = 50   # fetch top N new posts per subreddit

# Mastodon — InfoSec.exchange public timeline (no auth needed)
MASTODON_INSTANCE  = "infosec.exchange"
MASTODON_LIMIT     = 80    # posts to fetch per run

# Canadian Centre for Cyber Security
CCCS_FEEDS = [
    "https://www.cyber.gc.ca/api/gcweb/feeds/alerts/feed.xml",
    "https://www.cyber.gc.ca/api/gcweb/feeds/advisories/feed.xml",
]

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
def cleanup_csv_files(current_csv: str):
    """
    Delete old results_*.csv files.
    Rules:
      - Always keep `current_csv` (today's run).
      - For each calendar month, keep only the CSV whose date is the 1st.
        If no file exists for the 1st, keep the earliest file of that month.
      - Delete everything else.
    """
    all_csvs = sorted(glob.glob("results_*.csv"))
    if not all_csvs:
        return

    # Group by YYYYMM
    monthly: dict[str, list[str]] = {}
    for f in all_csvs:
        # filename: results_YYYYMMDD_HHMMSS.csv
        try:
            date_part = f.split("_")[1]          # YYYYMMDD
            month_key = date_part[:6]             # YYYYMM
            monthly.setdefault(month_key, []).append(f)
        except (IndexError, ValueError):
            continue

    to_keep = set()
    to_keep.add(current_csv)   # always keep current run

    for month_key, files in monthly.items():
        files_sorted = sorted(files)
        # Prefer a file from the 1st of the month
        first_of_month = [f for f in files_sorted
                          if f.split("_")[1].endswith("01")]
        if first_of_month:
            to_keep.add(first_of_month[0])
        else:
            # Fall back to earliest file of the month
            to_keep.add(files_sorted[0])

    for f in all_csvs:
        if f not in to_keep:
            try:
                os.remove(f)
                print(f"Removed old CSV: {f}", file=sys.stderr)
            except OSError as e:
                print(f"Could not remove {f}: {e}", file=sys.stderr)


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
    entries = []
    for url in feed_urls:
        print(f"Parsing {url}...", file=sys.stderr)
        d = safe_parse_feed(url)
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
                entries.append({
                    "title":        title,
                    "link":         link,
                    "date":         published_dt.strftime("%Y-%m-%d"),
                    "terms":        matched,
                    "inline_links": inline_matches,
                })
    return entries


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


def save_csv(records, filename):
    with open(filename, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Date", "Title", "Link", "Matched Terms", "Inline Links"])
        for r in records:
            inline = " | ".join([f"{x['text']}->{x['url']}" for x in r.get("inline_links", [])])
            w.writerow([r["date"], r["title"], r["link"],
                        ", ".join(r["terms"]), inline])


def save_metadata():
    now_utc     = datetime.now(timezone.utc)
    now_eastern = now_utc.astimezone(EASTERN_TZ)
    timestamp   = now_eastern.strftime("%Y-%m-%d %H:%M %Z")
    try:
        with open(META_FILE, "w", encoding="utf-8") as f:
            json.dump({"last_updated": timestamp}, f)
        print(f"Updated {META_FILE}: {timestamp}", file=sys.stderr)
    except Exception as e:
        print(f"Error saving metadata: {e}", file=sys.stderr)


# ─────────────────────────────────────────────────────────────────
# AI REPORT GENERATION
# ─────────────────────────────────────────────────────────────────
def get_48h_entries(full_history):
    """Return only entries from the last 48 hours."""
    cutoff = (datetime.now() - timedelta(hours=REPORT_HOURS)).strftime("%Y-%m-%d")
    return [e for e in full_history if e.get("date", "") >= cutoff]


def build_default_prompt(recent_entries):
    """Build the structured analysis prompt from recent feed entries."""
    if not recent_entries:
        return (
            "The security feed returned no new articles in the last 48 hours. "
            "Please write a brief report noting this and provide general security posture advice."
        )

    # Summarise entries into a compact text block for the API
    articles_text = []
    for e in recent_entries[:120]:   # cap to avoid token limits
        source = e.get("source_type", "rss").upper()
        terms = ", ".join(e.get("terms", []))
        articles_text.append(f"[{e['date']}][{source}] {e['title']} | Terms: {terms}")

    articles_block = "\n".join(articles_text)

    return f"""You are a senior cybersecurity analyst. Based on the following security news articles 
from the last 48 hours, produce a structured threat intelligence briefing.

Sources: 130+ RSS feeds, Reddit (r/netsec r/cybersecurity r/canada), Mastodon/InfoSec.exchange, CCCS advisories.
Tags: [RSS]=news [REDDIT]=community [MASTODON]=infosec community [CCCS]=official Canadian govt advisories.

ARTICLES:
{articles_block}

Respond ONLY with valid JSON (no markdown fences, no preamble) matching this exact schema:

{{
  "vulnerabilities": {{
    "count": <integer>,
    "items": [
      {{
        "id": "CVE-XXXX-XXXXX",
        "description": "brief one-line description of the vulnerability",
        "criticality": "CRITICAL|HIGH|MEDIUM|LOW",
        "software_affected": "vendor/product name and version if known",
        "cia_impact": "e.g. Confidentiality: High, Integrity: High, Availability: Low",
        "access_required": "e.g. Network / No auth required"
      }}
    ]
  }},
  "threat_actors": {{
    "items": [
      {{
        "name": "Threat Actor Name (aliases)",
        "targets": "who was breached or targeted in the last 48h",
        "ttps": "key TTPs to watch for, referenced as MITRE ATT&CK IDs where possible",
        "iocs": ["ip/domain/hash", "..."]
      }}
    ]
  }},
  "canada_landscape": {{
    "summary": "2-3 sentence overview of the Canadian cyber landscape in the last 48h, including any CCCS advisories",
    "retailers": "any Canadian retail incidents — Loblaws, Canadian Tire, SportChek, Shoppers Drug Mart, etc.; otherwise 'None identified'",
    "financial": "any Canadian financial incidents — CIBC, RBC, TD, Scotiabank, BMO, etc.; otherwise 'None identified'"
  }},
  "generated_at": "<current Eastern Time>"
}}

Only include CVEs and TAs that actually appear in the article list above.
For Canada section look for: Canada, Canadian, Ontario, Quebec, CCCS, Loblaws, Canadian Tire, CIBC, RBC, TD Bank, Scotiabank, BMO, Shoppers Drug Mart.
Pay special attention to [CCCS] items — these are official Canadian government cybersecurity advisories.
Keep each field concise and factual. generated_at must be current Eastern Time in format "YYYY-MM-DD HH:MM ET"."""


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
        print("Generating DEFAULT 48h report...", file=sys.stderr)
        recent_entries = get_48h_entries(full_history)
        print(f"  {len(recent_entries)} articles in last 48h.", file=sys.stderr)
        prompt = build_default_prompt(recent_entries)
        response_text = call_anthropic(prompt)

        if response_text is None:
            report = {
                "ai_enabled":   True,
                "generated_at": now_et,
                "error":        "Anthropic API unavailable",
            }
        else:
            # Try to parse JSON
            try:
                # Strip any accidental markdown fences
                clean = response_text.strip()
                if clean.startswith("```"):
                    clean = "\n".join(clean.split("\n")[1:])
                if clean.endswith("```"):
                    clean = "\n".join(clean.split("\n")[:-1])
                report = json.loads(clean)
                report["ai_enabled"] = True
                if "generated_at" not in report:
                    report["generated_at"] = now_et
            except json.JSONDecodeError as e:
                print(f"JSON parse error on AI response: {e}", file=sys.stderr)
                # Fall back: store raw text so frontend can display it
                report = {
                    "ai_enabled":      True,
                    "generated_at":    now_et,
                    "custom_response": response_text,
                }

    with open(REPORT_FILE, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(f"Saved {REPORT_FILE}", file=sys.stderr)


# ─────────────────────────────────────────────────────────────────
# ─────────────────────────────────────────────────────────────────
# REDDIT SCRAPER — free JSON API, no auth required
# ─────────────────────────────────────────────────────────────────
def fetch_reddit(subreddits: list, search_terms: list) -> list:
    """Fetch new posts from subreddits and match against search_terms."""
    entries = []
    headers = {
        "User-Agent": "SecurityFeedBot/1.0 (github.com/TinkerWithAll/Web)",
    }
    cutoff = datetime.utcnow() - timedelta(days=HISTORY_DAYS)

    for sub in subreddits:
        url = f"https://www.reddit.com/r/{sub}/new.json?limit={REDDIT_POSTS_PER_SUB}"
        try:
            print(f"Reddit: fetching r/{sub}...", file=sys.stderr)
            time.sleep(1)   # be polite — Reddit rate limit is 60 req/min
            resp = requests.get(url, headers=headers, timeout=15)
            if resp.status_code != 200:
                print(f"  Reddit r/{sub} returned {resp.status_code}", file=sys.stderr)
                continue
            data = resp.json()
            posts = data.get("data", {}).get("children", [])
            for post in posts:
                p = post.get("data", {})
                created_utc = p.get("created_utc", 0)
                published_dt = datetime.utcfromtimestamp(created_utc)
                if published_dt < cutoff:
                    continue

                title    = p.get("title", "")
                selftext = p.get("selftext", "")
                flair    = p.get("link_flair_text", "") or ""
                text_all = f"{title} {selftext} {flair}".lower()
                permalink = "https://www.reddit.com" + p.get("permalink", "")
                ext_url   = p.get("url", permalink)

                matched = [t for t in search_terms if t.lower() in text_all]
                if matched:
                    entries.append({
                        "title":        f"[r/{sub}] {title}",
                        "link":         ext_url,
                        "source_url":   permalink,
                        "date":         published_dt.strftime("%Y-%m-%d"),
                        "terms":        matched,
                        "inline_links": [],
                        "source_type":  "reddit",
                    })
        except Exception as e:
            print(f"  Reddit r/{sub} error: {e}", file=sys.stderr)

    print(f"Reddit: {len(entries)} matched posts across {len(subreddits)} subreddits", file=sys.stderr)
    return entries


# ─────────────────────────────────────────────────────────────────
# MASTODON SCRAPER — InfoSec.exchange public API, no auth required
# ─────────────────────────────────────────────────────────────────
def fetch_mastodon(search_terms: list) -> list:
    """Fetch public timeline from InfoSec.exchange and match search terms."""
    entries = []
    cutoff  = datetime.utcnow() - timedelta(days=HISTORY_DAYS)
    url     = f"https://{MASTODON_INSTANCE}/api/v1/timelines/public?limit={MASTODON_LIMIT}&local=true"

    try:
        print(f"Mastodon: fetching {MASTODON_INSTANCE} public timeline...", file=sys.stderr)
        resp = requests.get(url, timeout=15)
        if resp.status_code != 200:
            print(f"  Mastodon returned {resp.status_code}", file=sys.stderr)
            return entries

        posts = resp.json()
        for post in posts:
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

            # Strip HTML tags from content
            raw_content = post.get("content", "")
            soup        = BeautifulSoup(raw_content, "html.parser")
            plain_text  = soup.get_text(" ", strip=True)
            text_all    = plain_text.lower()

            matched = [t for t in search_terms if t.lower() in text_all]
            if matched:
                account  = post.get("account", {})
                username = account.get("acct", "unknown")
                post_url = post.get("url", "")
                title    = plain_text[:120] + ("…" if len(plain_text) > 120 else "")

                entries.append({
                    "title":        f"[Mastodon @{username}] {title}",
                    "link":         post_url,
                    "source_url":   post_url,
                    "date":         published_dt.strftime("%Y-%m-%d"),
                    "terms":        matched,
                    "inline_links": [],
                    "source_type":  "mastodon",
                })
    except Exception as e:
        print(f"  Mastodon error: {e}", file=sys.stderr)

    print(f"Mastodon: {len(entries)} matched posts", file=sys.stderr)
    return entries


# ─────────────────────────────────────────────────────────────────
# CCCS SCRAPER — Canadian Centre for Cyber Security RSS feeds
# ─────────────────────────────────────────────────────────────────
def fetch_cccs(search_terms: list) -> list:
    """Fetch CCCS alerts and advisories RSS feeds."""
    entries     = []
    cccs_terms  = search_terms + ["canada", "canadian", "cccs", "cse"]  # always include Canada terms
    cccs_terms  = list(set(t.lower() for t in cccs_terms))

    for feed_url in CCCS_FEEDS:
        try:
            print(f"CCCS: fetching {feed_url}...", file=sys.stderr)
            d = safe_parse_feed(feed_url)
            for e in d.entries:
                link = e.get("link", "")
                published_dt = None
                try:
                    dt_tuple = e.get("published_parsed") or e.get("updated_parsed")
                    if dt_tuple:
                        published_dt = datetime(*dt_tuple[:6])
                except Exception:
                    pass

                if not published_dt or published_dt < (datetime.utcnow() - timedelta(days=HISTORY_DAYS)):
                    continue

                title   = e.get("title", "")
                summary = e.get("summary", "")
                text_all = f"{title} {summary}".lower()

                # CCCS items are always relevant — include all, tag with matched terms
                matched = [t for t in search_terms if t.lower() in text_all]
                if not matched:
                    matched = ["cccs-advisory"]   # ensure it appears even with no term match

                entries.append({
                    "title":        f"[CCCS] {title}",
                    "link":         link,
                    "source_url":   link,
                    "date":         published_dt.strftime("%Y-%m-%d"),
                    "terms":        matched,
                    "inline_links": [],
                    "source_type":  "cccs",
                })
        except Exception as ex:
            print(f"  CCCS feed error {feed_url}: {ex}", file=sys.stderr)

    print(f"CCCS: {len(entries)} items", file=sys.stderr)
    return entries


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

    # 9. Save CSV for this run
    utc_ts   = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    csv_file = f"results_{utc_ts}.csv"
    save_csv(new_matches, csv_file)
    print(f"Saved {csv_file} ({len(new_matches)} new matches)", file=sys.stderr)

    # 10. Clean up old CSVs (keep monthly 1st-of-month archives + current)
    cleanup_csv_files(csv_file)

    # 11. Save metadata timestamp
    save_metadata()

    # 12. Generate AI report (server-side, uses ANTHROPIC_API_KEY secret)
    generate_and_save_report(full_history)

    print(f"Done. History: {len(full_history)} entries total.", file=sys.stderr)


if __name__ == "__main__":
    main()
