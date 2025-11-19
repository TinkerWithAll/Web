#!/usr/bin/env python3
"""
scraper.py
Parses security news, maintains a rolling 30-day history in JSON,
generates CSV reports, and updates a metadata timestamp.
"""

import feedparser
from bs4 import BeautifulSoup
import csv
import sys
import io
import json
from datetime import datetime, timedelta
import socket
import requests
import os
import ssl
import glob

# Fix for encoding and SSL
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
ssl._create_default_https_context = ssl._create_unverified_context
socket.setdefaulttimeout(300)

# Configuration
HISTORY_FILE = "feed_history.json"
META_FILE = "meta.json"  # New metadata file
MIN_PUBLISHED_DATE = datetime.today() - timedelta(days=30)
USE_CISA_CVES = True

def load_list_from_file(filename):
    items = []
    try:
        with open(filename, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip() and not line.strip().startswith("#"):
                    items.append(line.strip())
    except FileNotFoundError:
        pass
    return items

def update_terms_with_cisa_cves(terms_file="terms.txt"):
    try:
        r = requests.get("https://www.cisa.gov/sites/default/files/csv/known_exploited_vulnerabilities.csv", timeout=15)
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
        print(f"Error updating CVEs: {e}", file=sys.stderr)

def safe_parse_feed(url):
    try:
        return feedparser.parse(url)
    except:
        return feedparser.FeedParserDict(entries=[])

def extract_links(html):
    links = []
    if not html: return links
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
                if dt_tuple: published_dt = datetime(*dt_tuple[:6])
            except: pass
            
            if not published_dt or published_dt < MIN_PUBLISHED_DATE:
                continue

            title = e.get("title", "")
            summary = e.get("summary", "")
            content = e.get("content", [{"value": ""}])[0]["value"]
            text_all = f"{title} {summary} {content}".lower()
            
            matched = [t for t in search_terms if t.lower() in text_all]
            
            inline_matches = []
            for href, txt in extract_links(content + summary):
                for term in search_terms:
                    if term.lower() in txt.lower():
                        inline_matches.append({"term": term, "text": txt, "url": href})
                        if term.lower() not in matched: matched.append(term.lower())

            if matched:
                entries.append({
                    "title": title,
                    "link": link,
                    "date": published_dt.strftime("%Y-%m-%d"),
                    "terms": matched,
                    "inline_links": inline_matches
                })
    return entries

def update_history_file(new_entries):
    history = []
    if os.path.exists(HISTORY_FILE):
        try:
            with open(HISTORY_FILE, "r", encoding="utf-8") as f:
                history = json.load(f)
        except: pass

    history_dict = {item['link']: item for item in history}
    for entry in new_entries:
        history_dict[entry['link']] = entry

    full_list = sorted(history_dict.values(), key=lambda x: x['date'], reverse=True)
    cutoff = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")
    clean_list = [x for x in full_list if x['date'] >= cutoff]

    with open(HISTORY_FILE, "w", encoding="utf-8") as f:
        json.dump(clean_list, f, indent=2)
    
    return clean_list

def save_csv(records, filename):
    with open(filename, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Date", "Title", "Link", "Matched Terms", "Inline Links"])
        for r in records:
            inline = " | ".join([f"{x['text']}->{x['url']}" for x in r['inline_links']])
            w.writerow([r['date'], r['title'], r['link'], ", ".join(r['terms']), inline])

def save_metadata():
    """Saves the current timestamp to a separate JSON file."""
    timestamp = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    try:
        with open(META_FILE, "w", encoding="utf-8") as f:
            json.dump({"last_updated": timestamp}, f)
        print(f"Updated {META_FILE} with timestamp: {timestamp}", file=sys.stderr)
    except Exception as e:
        print(f"Error saving metadata: {e}", file=sys.stderr)

def main():
    if USE_CISA_CVES: update_terms_with_cisa_cves()
    
    terms = load_list_from_file("terms.txt")
    if not USE_CISA_CVES: terms = [t for t in terms if not t.upper().startswith("CVE-")]
    feeds = load_list_from_file("feeds.txt")

    print("Scanning feeds...", file=sys.stderr)
    new_matches = parse_feeds(feeds, terms)
    
    full_history = update_history_file(new_matches)
    
    timestamp = datetime.utcnow().strftime('%Y%m%d_%H%M%S')
    save_csv(new_matches, f"results_{timestamp}.csv")
    
    # NEW: Save the update time
    save_metadata()
    
    print(f"Done. History updated with {len(full_history)} total entries.")

if __name__ == "__main__":
    main()
