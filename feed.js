/**
 * feed.js — Security Feed Dashboard
 */

const GITHUB_OWNER  = 'TinkerWithAll';
const GITHUB_REPO   = 'Web';
const WORKFLOW_FILE = 'daily_scrape.yml';
const RATE_LIMIT_MS  = 2 * 60 * 60 * 1000;
const RATE_LIMIT_KEY = 'feed_last_trigger';

// GH_DISPATCH_TOKEN is injected at build time into config.js.
// Read it lazily inside functions so it's always fresh.
function getToken() { return (window.GH_DISPATCH_TOKEN || '').trim(); }

document.addEventListener('DOMContentLoaded', () => {

  const lastUpdatedEl    = document.getElementById('last-updated');
  const articleCountEl   = document.getElementById('article-count');
  const feedCountEl      = document.getElementById('feed-count');
  const sourceBreakdown  = document.getElementById('source-breakdown');
  const feedBody         = document.getElementById('feedBody');
  const searchInput      = document.getElementById('searchInput');
  const termInput        = document.getElementById('termInput');
  const termToggleBtn    = document.getElementById('termToggleBtn');
  const sourceFilterBtns = document.querySelectorAll('.source-filter-btn');
  const downloadBtn      = document.getElementById('downloadBtn');
  const downloadTermsBtn = document.getElementById('downloadTermsBtn');
  const downloadFeedsBtn = document.getElementById('downloadFeedsBtn');
  const downloadReportBtn= document.getElementById('downloadReportBtn');
  const feedCountLabel   = document.getElementById('feedCountLabel');
  const noResults        = document.getElementById('noResults');
  const refreshBtn       = document.getElementById('refreshBtn');
  const refreshBtnLabel  = document.getElementById('refreshBtnLabel');
  const defaultReportBtn = document.getElementById('defaultReportBtn');
  const customReportBtn  = document.getElementById('customReportBtn');
  const customPrompt     = document.getElementById('customPrompt');
  const reportPlaceholder= document.getElementById('reportPlaceholder');
  const reportLoading    = document.getElementById('reportLoading');
  const reportContent    = document.getElementById('reportContent');
  const loadingMsg       = document.getElementById('loadingMsg');

  let feedData        = [];
  let activeSource    = 'all';
  let searchModeIsAND = true;
  let currentReportData = null;
  const cb = () => '?v=' + Date.now();

  const SOURCE_LABELS = {
    reddit:   { label: 'Reddit',   cls: 'src-reddit' },
    mastodon: { label: 'Mastodon', cls: 'src-mastodon' },
    cccs:     { label: 'CCCS',     cls: 'src-cccs' },
    rss:      { label: 'RSS',      cls: 'src-rss' },
  };

  // Eastern time formatter
  function toEastern(str) {
    if (!str) return '—';
    if (typeof str === 'string' && str.endsWith(' ET')) return str;
    try {
      return new Date(str).toLocaleString('en-CA', {
        timeZone: 'America/Toronto',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
      }) + ' ET';
    } catch { return str; }
  }

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  // Metadata
  fetch('meta.json' + cb())
    .then(r => r.json())
    .then(d => { if (lastUpdatedEl && d.last_updated) lastUpdatedEl.textContent = toEastern(d.last_updated); })
    .catch(() => {});

  // Exact feed count from feeds.txt
  fetch('feeds.txt' + cb())
    .then(r => r.text())
    .then(text => {
      const count = text.split('\n').filter(l => l.trim().startsWith('http')).length;
      if (feedCountEl) feedCountEl.textContent = count;
    })
    .catch(() => { if (feedCountEl) feedCountEl.textContent = '180'; });

  // AI enabled check
  fetch('report.json' + cb())
    .then(r => r.ok ? r.json() : null)
    .then(data => { if (data && data.ai_enabled === false) disableAI(data.message || 'AI analysis is currently disabled.'); })
    .catch(() => {});

  function disableAI(msg) {
    defaultReportBtn.disabled = true;
    customReportBtn.disabled  = true;
    customPrompt.disabled     = true;
    customPrompt.placeholder  = 'AI features are currently disabled.';
    reportPlaceholder.innerHTML = '<div class="ph-icon" style="color:var(--amber)"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg></div><p style="color:var(--amber)">' + escHtml(msg) + '</p><p class="ph-sub">To re-enable: set <code>AI_ENABLED = true</code> in GitHub Actions Variables.</p>';
  }

  // Feed data
  fetch('feed_history.json')
    .then(r => { if (!r.ok) throw new Error(); return r.json(); })
    .then(data => {
      feedData = data;
      if (articleCountEl) articleCountEl.textContent = data.length;
      updateSourceBreakdown(data);
      renderTable(data);
    })
    .catch(() => {
      feedBody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text-faint);padding:2rem">No data available.</td></tr>';
    });

  function updateSourceBreakdown(data) {
    if (!sourceBreakdown) return;
    const counts = { rss: 0, reddit: 0, mastodon: 0, cccs: 0 };
    data.forEach(item => {
      const t = (item.source_type || 'rss').toLowerCase();
      if (counts[t] !== undefined) counts[t]++; else counts.rss++;
    });
    sourceBreakdown.innerHTML =
      '<span class="src-pill src-rss">RSS\u00a0' + counts.rss + '</span>' +
      '<span class="src-pill src-reddit">Reddit\u00a0' + counts.reddit + '</span>' +
      '<span class="src-pill src-mastodon">Mastodon\u00a0' + counts.mastodon + '</span>' +
      '<span class="src-pill src-cccs">CCCS\u00a0' + counts.cccs + '</span>';
  }

  // Source filter buttons
  sourceFilterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      sourceFilterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeSource = btn.dataset.source;
      filterData();
    });
  });

  function renderTable(data) {
    feedBody.innerHTML = '';
    noResults.style.display = data.length === 0 ? 'block' : 'none';
    feedCountLabel.textContent = data.length + ' article' + (data.length !== 1 ? 's' : '');
    data.forEach(item => {
      const srcType = (item.source_type || 'rss').toLowerCase();
      const srcInfo = SOURCE_LABELS[srcType] || SOURCE_LABELS.rss;
      const tagsHtml = (item.terms || []).map(t => '<span class="term-tag">' + escHtml(t) + '</span>').join('');
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="mono" style="color:var(--text-dim);font-size:12px;white-space:nowrap">' +
          escHtml(item.date) + '<br>' +
          '<span class="src-badge ' + srcInfo.cls + '">' + srcInfo.label + '</span>' +
        '</td>' +
        '<td><a href="' + escHtml(item.link) + '" target="_blank" rel="noopener noreferrer">' + escHtml(item.title) + '</a></td>' +
        '<td>' + tagsHtml + '</td>';
      feedBody.appendChild(tr);
    });
  }

  function filterData() {
    const txt   = searchInput.value.toLowerCase();
    const terms = termInput.value.toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
    const filtered = feedData.filter(item => {
      if (activeSource !== 'all') {
        const srcType = (item.source_type || 'rss').toLowerCase();
        if (srcType !== activeSource) return false;
      }
      const textOk = !txt || item.title.toLowerCase().includes(txt);
      if (terms.length === 0) return textOk;
      const articleTerms = (item.terms || []).map(t => t.toLowerCase());
      const termOk = searchModeIsAND
        ? terms.every(st => articleTerms.some(at => at.includes(st)))
        : terms.some(st => articleTerms.some(at => at.includes(st)));
      return textOk && termOk;
    });
    renderTable(filtered);
    return filtered;
  }

  searchInput.addEventListener('input', filterData);
  termInput.addEventListener('input', filterData);
  termToggleBtn.addEventListener('click', () => {
    searchModeIsAND = !searchModeIsAND;
    termToggleBtn.textContent = searchModeIsAND ? 'AND' : 'OR';
    termToggleBtn.className   = searchModeIsAND ? 'toggle-and' : 'toggle-or';
    filterData();
  });

  // Export CSV
  downloadBtn.addEventListener('click', () => {
    const current = filterData();
    if (!current.length) return alert('No data to export.');
    const rows = [['Date','Source','Title','Link','Terms']];
    current.forEach(i => rows.push([i.date, i.source_type||'rss', '"'+(i.title||'').replace(/"/g,'""')+'"', i.link, '"'+(i.terms||[]).join(', ')+'"']));
    const blob = new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' });
    triggerDownload(URL.createObjectURL(blob), 'security_feed_' + iso() + '.csv');
  });

  // Download Report
  if (downloadReportBtn) {
    downloadReportBtn.addEventListener('click', () => {
      if (!currentReportData) return;
      const html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Security Report</title><style>body{font-family:Courier New,monospace;background:#0a0c0f;color:#e8f0f8;padding:2rem;max-width:900px;margin:0 auto;font-size:14px;line-height:1.7}a{color:#00e5a0}strong{color:#e8f0f8}.report-meta,.r-section-title{color:#00e5a0}.report-ts{color:#00e5a0}.cve-card,.ta-card,.canada-card,.source-item{background:#151a22;border:1px solid #1e2530;border-radius:6px;padding:1rem;margin-bottom:.75rem}.cve-card{border-left:3px solid #ff4757}.ta-card{border-left:3px solid #ffb830}.cve-id,.ta-name{color:#ffb830;font-weight:bold}.src-badge{font-size:11px;padding:1px 6px;border-radius:3px}.src-rss{background:rgba(79,163,227,.15);color:#4fa3e3}.src-reddit{background:rgba(255,100,0,.15);color:#ff6400}.src-mastodon{background:rgba(99,100,255,.15);color:#6366f1}.src-cccs{background:rgba(255,71,87,.15);color:#ff4757}.term-tag{background:rgba(0,229,160,.1);color:#00a872;border:1px solid rgba(0,229,160,.2);padding:1px 6px;border-radius:10px;font-size:11px;margin:2px;display:inline-block}</style></head><body>' + reportContent.innerHTML + '</body></html>';
      triggerDownload(URL.createObjectURL(new Blob([html], {type:'text/html'})), 'security-report-' + iso() + '.html');
    });
  }

  // Download txt
  function downloadTxt(filename) {
    fetch(filename).then(r => { if (!r.ok) throw new Error(); return r.text(); })
      .then(text => triggerDownload(URL.createObjectURL(new Blob([text],{type:'text/plain'})), filename))
      .catch(() => alert('Could not download ' + filename));
  }
  downloadTermsBtn.addEventListener('click', () => downloadTxt('terms.txt'));
  downloadFeedsBtn.addEventListener('click', () => downloadTxt('feeds.txt'));

  // Cooldown
  function getRemainingCooldown() {
    const last = parseInt(localStorage.getItem(RATE_LIMIT_KEY) || '0', 10);
    return Math.max(0, RATE_LIMIT_MS - (Date.now() - last));
  }
  function updateRefreshBtn() {
    const rem = getRemainingCooldown();
    if (rem > 0) { refreshBtn.disabled = true; refreshBtnLabel.textContent = 'Cooldown ' + Math.ceil(rem/60000) + 'm'; }
    else         { refreshBtn.disabled = false; refreshBtnLabel.textContent = 'Refresh'; }
  }
  updateRefreshBtn();
  setInterval(updateRefreshBtn, 30000);

  // Refresh button
  refreshBtn.addEventListener('click', async () => {
    if (getRemainingCooldown() > 0) return;
    const token = getToken();
    if (!token) { alert('GH_DISPATCH_TOKEN not configured. Run the workflow once from GitHub Actions to generate config.js.'); return; }
    refreshBtn.disabled = true;
    refreshBtnLabel.textContent = 'Triggering…';
    const ok = await triggerWorkflow({}, token);
    if (ok) { localStorage.setItem(RATE_LIMIT_KEY, Date.now().toString()); refreshBtnLabel.textContent = 'Triggered ✓'; }
    else    { refreshBtnLabel.textContent = 'Error'; }
    setTimeout(updateRefreshBtn, 3000);
  });

  // Default report
  defaultReportBtn.addEventListener('click', async () => {
    defaultReportBtn.disabled = true;
    customReportBtn.disabled  = true;
    showLoading('Loading cached intelligence report…');
    try {
      const r = await fetch('report.json' + cb());
      if (!r.ok) throw new Error('not found');
      renderReport(await r.json(), false);
    } catch {
      showError('report.json not found. Make sure your GitHub Action has run at least once.');
    } finally {
      defaultReportBtn.disabled = false;
      customReportBtn.disabled  = false;
    }
  });

  // Custom prompt
  customReportBtn.addEventListener('click', async () => {
    const prompt = customPrompt.value.trim();
    if (!prompt) { customPrompt.focus(); return; }
    const token = getToken();
    if (!token) {
      showError('GH_DISPATCH_TOKEN is not set. The workflow must run at least once to generate config.js with the token. Go to GitHub Actions → Run workflow manually first.');
      return;
    }
    customReportBtn.disabled  = true;
    defaultReportBtn.disabled = true;
    showLoading('Dispatching custom analysis… this takes 1–3 minutes.');
    const ok = await triggerWorkflow({ custom_prompt: prompt }, token);
    if (!ok) {
      showError('GitHub Actions dispatch failed (HTTP status was not 204). Most likely cause: GH_DISPATCH_TOKEN has expired. Create a new Fine-Grained PAT with Actions: Read & Write scope, add it to GitHub Secrets as GH_DISPATCH_TOKEN, then run the workflow once so config.js is regenerated. Check the browser console for details.');
      customReportBtn.disabled  = false;
      defaultReportBtn.disabled = false;
      return;
    }
    loadingMsg.textContent = 'Workflow triggered ✓ — polling for new report (up to 3 min)…';
    const result = await pollForReport(180);
    hideLoading();
    if (result) { renderReport(result, true, prompt); }
    else { showError('Timed out. The workflow may still be running — wait 2 min then click Default Report to load the result.'); }
    customReportBtn.disabled  = false;
    defaultReportBtn.disabled = false;
  });

  async function triggerWorkflow(inputs, token) {
    try {
      const res = await fetch(
        'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/actions/workflows/' + WORKFLOW_FILE + '/dispatches',
        {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + token,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ref: 'main', inputs }),
        }
      );
      if (res.status === 204) return true;
      console.error('GitHub dispatch HTTP ' + res.status, await res.text().catch(() => ''));
      return false;
    } catch (err) { console.error('triggerWorkflow:', err); return false; }
  }

  async function pollForReport(timeoutSecs) {
    let oldTs = null;
    try { const r = await fetch('report.json' + cb()); if (r.ok) { const d = await r.json(); oldTs = d.generated_at; } } catch {}
    const deadline = Date.now() + timeoutSecs * 1000;
    while (Date.now() < deadline) {
      await sleep(8000);
      try { const r = await fetch('report.json' + cb()); if (r.ok) { const d = await r.json(); if (d.generated_at && d.generated_at !== oldTs) return d; } } catch {}
    }
    return null;
  }

  function showLoading(msg) {
    reportPlaceholder.style.display = 'none'; reportContent.style.display = 'none';
    reportLoading.style.display = 'flex'; loadingMsg.textContent = msg || 'Generating…';
  }
  function hideLoading() { reportLoading.style.display = 'none'; }
  function showError(msg) {
    hideLoading(); reportPlaceholder.style.display = 'none'; reportContent.style.display = 'block';
    reportContent.innerHTML = '<div style="padding:2rem;color:var(--red);font-size:13px;line-height:1.8"><strong>Error:</strong> ' + escHtml(msg) + '</div>';
  }

  function renderReport(data, isCustom, prompt) {
    hideLoading();
    reportPlaceholder.style.display = 'none'; reportContent.style.display = 'block';
    currentReportData = data;
    if (downloadReportBtn) downloadReportBtn.style.display = 'flex';
    const ts    = toEastern(data.generated_at);
    const badge = isCustom ? '<span class="report-badge custom">Custom</span>' : '<span class="report-badge">48h Brief</span>';
    let html = '<div class="report-meta">' + badge + '<span>Generated: <span class="report-ts mono">' + escHtml(ts) + '</span></span>' +
      (isCustom && prompt ? '<span style="color:var(--text-dim)">Prompt: "' + escHtml(prompt.substring(0,80)) + (prompt.length>80?'…':'') + '"</span>' : '') + '</div>';
    if (data.custom_response) {
      html += '<div class="r-section"><div class="canada-card">' + markdownToHtml(data.custom_response) + '</div></div>';
    } else {
      html += renderVulnSection(data.vulnerabilities);
      html += renderTASection(data.threat_actors);
      html += renderCanadaSection(data.canada_landscape);
    }
    html += renderSourcesSection();
    reportContent.innerHTML = html;
  }

  function renderSourcesSection() {
    if (!feedData.length) return '';
    const cutoff = new Date(Date.now() - 48*60*60*1000).toISOString().slice(0,10);
    const recent = feedData.filter(i => i.date >= cutoff).slice(0, 60);
    if (!recent.length) return '';
    let html = '<div class="r-section"><div class="r-section-title">Source Articles <span class="r-section-count">' + recent.length + '</span></div><div class="sources-list">';
    recent.forEach(item => {
      const srcType = (item.source_type || 'rss').toLowerCase();
      const srcInfo = SOURCE_LABELS[srcType] || SOURCE_LABELS.rss;
      const tags = (item.terms||[]).slice(0,3).map(t => '<span class="term-tag">' + escHtml(t) + '</span>').join('');
      html += '<div class="source-item"><span class="source-date mono">' + escHtml(item.date) + '</span>' +
        '<span class="src-badge ' + srcInfo.cls + '">' + srcInfo.label + '</span>' +
        '<a href="' + escHtml(item.link) + '" target="_blank" rel="noopener noreferrer" class="source-link">' + escHtml(item.title) + '</a>' +
        '<div class="source-tags">' + tags + '</div></div>';
    });
    return html + '</div></div>';
  }

  function renderVulnSection(vulns) {
    if (!vulns) return '';
    const items = vulns.items || [];
    let html = '<div class="r-section"><div class="r-section-title">New Vulnerabilities <span class="r-section-count">' + (vulns.count ?? items.length) + ' CVEs</span></div><div class="cve-list">';
    if (!items.length) { html += '<p class="r-empty">No new CVEs matched in the last 48h.</p>'; }
    else items.forEach(cve => {
      html += '<div class="cve-card ' + critClass(cve.criticality) + '"><div class="cve-header"><span class="cve-id">' + escHtml(cve.id||'') + '</span><span class="cve-title">' + escHtml(cve.description||'') + '</span><span class="crit-badge ' + escHtml(cve.criticality||'') + '">' + escHtml(cve.criticality||'?') + '</span></div>' +
        '<div class="cve-meta"><div class="cve-meta-item"><strong>Software:</strong> ' + escHtml(cve.software_affected||'—') + '</div><div class="cve-meta-item"><strong>CIA Impact:</strong> ' + escHtml(cve.cia_impact||'—') + '</div><div class="cve-meta-item"><strong>Access Required:</strong> ' + escHtml(cve.access_required||'—') + '</div></div></div>';
    });
    return html + '</div></div>';
  }

  function renderTASection(actors) {
    if (!actors) return '';
    const items = actors.items || [];
    let html = '<div class="r-section"><div class="r-section-title">Active Threat Actors <span class="r-section-count">' + items.length + ' active</span></div><div class="ta-list">';
    if (!items.length) { html += '<p class="r-empty">No threat actor activity matched in the last 48h.</p>'; }
    else items.forEach(ta => {
      html += '<div class="ta-card"><div class="ta-name">' + escHtml(ta.name||'') + '</div><div class="ta-body">' +
        (ta.targets ? '<p><strong>Targets / Breaches:</strong> ' + escHtml(ta.targets) + '</p>' : '') +
        (ta.ttps    ? '<p><strong>TTPs:</strong> ' + escHtml(ta.ttps) + '</p>' : '') +
        (ta.iocs && ta.iocs.length ? '<p><strong>IoCs:</strong></p><div class="ioc-tags">' + ta.iocs.map(i=>'<span class="ioc-tag">'+escHtml(i)+'</span>').join('') + '</div>' : '') +
        '</div></div>';
    });
    return html + '</div></div>';
  }

  function renderCanadaSection(canada) {
    if (!canada) return '';
    let html = '<div class="r-section"><div class="r-section-title">Canadian Cyber Landscape</div><div class="canada-card">';
    if (canada.summary)   html += '<p>' + escHtml(canada.summary) + '</p>';
    if (canada.retailers) html += '<p><strong><span class="ca-flag">🇨🇦</span> Retailers:</strong> ' + escHtml(canada.retailers) + '</p>';
    if (canada.financial) html += '<p><strong><span class="ca-flag">🇨🇦</span> Financial:</strong> ' + escHtml(canada.financial) + '</p>';
    if (!canada.summary && !canada.retailers && !canada.financial) html += '<p class="r-empty">No Canadian-specific incidents matched in the last 48h.</p>';
    return html + '</div></div>';
  }

  function escHtml(s) { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function critClass(c) { return ({CRITICAL:'crit',HIGH:'high',MEDIUM:'med',LOW:'low'})[(c||'').toUpperCase()]||'med'; }
  function iso() { return new Date().toISOString().slice(0,10); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function triggerDownload(url, filename) { const a = document.createElement('a'); a.href=url; a.download=filename; a.click(); URL.revokeObjectURL(url); }
  function markdownToHtml(md) {
    return md.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/^### (.+)$/gm,'<h4 style="color:var(--green);margin:1rem 0 .4rem;font-size:.85rem">$1</h4>')
      .replace(/^## (.+)$/gm,'<h3 style="color:var(--amber);margin:1.2rem 0 .5rem">$1</h3>')
      .replace(/^# (.+)$/gm,'<h2 style="color:var(--green);margin:1.5rem 0 .5rem">$1</h2>')
      .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
      .replace(/`([^`]+)`/g,'<code style="color:var(--amber);font-size:12px">$1</code>')
      .replace(/^- (.+)$/gm,'<li style="margin-left:1.2rem;margin-bottom:.2rem">$1</li>')
      .replace(/\n\n/g,'<br><br>').replace(/\n/g,'<br>');
  }

});
