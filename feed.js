/**
 * feed.js — Security Feed Dashboard
 * Changes: removed custom prompt, added executive summary, collapsible sections,
 *          source links on cards, 48h/2w window toggle.
 */

const GITHUB_OWNER  = 'TinkerWithAll';
const GITHUB_REPO   = 'Web';
const WORKFLOW_FILE = 'daily_scrape.yml';
const RATE_LIMIT_MS  = 2 * 60 * 60 * 1000;
const RATE_LIMIT_KEY = 'feed_last_trigger';
const TOKEN_KEY      = 'gh_dispatch_token_cache';

function getToken() {
  const live = (window.GH_DISPATCH_TOKEN || '').trim();
  if (live && live !== 'undefined') {
    try { localStorage.setItem(TOKEN_KEY, live); } catch {}
    return live;
  }
  try { return (localStorage.getItem(TOKEN_KEY) || '').trim(); } catch {}
  return '';
}
function promptForToken() {
  const t = window.prompt(
    'GH_DISPATCH_TOKEN not found.\n\nPaste your Fine-Grained PAT (Actions: Read & Write on TinkerWithAll/Web).\nIt will be saved locally.'
  );
  const token = (t || '').trim();
  if (token) { try { localStorage.setItem(TOKEN_KEY, token); } catch {} }
  return token;
}
function clearTokenCache() { try { localStorage.removeItem(TOKEN_KEY); } catch {} }

async function triggerWorkflow(inputs, token) {
  try {
    const res = await fetch(
      'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO +
      '/actions/workflows/' + WORKFLOW_FILE + '/dispatches',
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
    if (res.status === 204) return { ok: true };
    let ghMsg = '';
    try { ghMsg = (await res.json()).message || ''; } catch {}
    const msgs = {
      401: 'Token invalid/expired.',
      403: 'Token lacks Actions: Write permission on this repo.',
      404: 'Workflow file "' + WORKFLOW_FILE + '" not found in .github/workflows/.',
      422: 'workflow_dispatch may not be enabled in the workflow file.',
    };
    return { ok: false, status: res.status, message: msgs[res.status] || 'GitHub HTTP ' + res.status + (ghMsg ? ': ' + ghMsg : '') };
  } catch (err) {
    return { ok: false, status: 0, message: 'Network error: ' + err.message };
  }
}

document.addEventListener('DOMContentLoaded', () => {

  const SOURCE_LABELS = {
    reddit:   { label: 'Reddit',   cls: 'src-reddit' },
    mastodon: { label: 'Mastodon', cls: 'src-mastodon' },
    cccs:     { label: 'CCCS',     cls: 'src-cccs' },
    rss:      { label: 'RSS',      cls: 'src-rss' },
  };

  const $ = id => document.getElementById(id);
  const lastUpdatedEl    = $('last-updated');
  const articleCountEl   = $('article-count');
  const feedCountEl      = $('feed-count');
  const sourceBreakdown  = $('source-breakdown');
  const feedBody         = $('feedBody');
  const searchInput      = $('searchInput');
  const termInput        = $('termInput');
  const termToggleBtn    = $('termToggleBtn');
  const downloadBtn      = $('downloadBtn');
  const downloadTermsBtn = $('downloadTermsBtn');
  const downloadFeedsBtn = $('downloadFeedsBtn');
  const downloadReportBtn= $('downloadReportBtn');
  const feedCountLabel   = $('feedCountLabel');
  const noResults        = $('noResults');
  const refreshBtn       = $('refreshBtn');
  const refreshBtnLabel  = $('refreshBtnLabel');
  const loadReportBtn    = $('loadReportBtn');
  const btn48h           = $('btn48h');
  const btn2w            = $('btn2w');
  const reportPlaceholder= $('reportPlaceholder');
  const reportLoading    = $('reportLoading');
  const reportContent    = $('reportContent');
  const loadingMsg       = $('loadingMsg');
  const sourceFilterBtns = document.querySelectorAll('.source-filter-btn');

  let feedData        = [];
  let activeSource    = 'all';
  let activeWindow    = '48h';   // '48h' or '2w'
  let searchModeIsAND = true;
  let currentReportData = null;
  const cb = () => '?v=' + Date.now();

  // ── Helpers ───────────────────────────────────────────────────
  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function critClass(c) {
    return ({CRITICAL:'crit',HIGH:'high',MEDIUM:'med',LOW:'low'})[(c||'').toUpperCase()]||'med';
  }
  function iso()     { return new Date().toISOString().slice(0,10); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function dl(url, name) {
    const a = document.createElement('a'); a.href=url; a.download=name; a.click(); URL.revokeObjectURL(url);
  }
  function toEastern(str) {
    if (!str) return '—';
    if (typeof str === 'string' && str.endsWith(' ET')) return str;
    try {
      return new Date(str).toLocaleString('en-CA', {
        timeZone:'America/Toronto', year:'numeric', month:'2-digit',
        day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false
      }) + ' ET';
    } catch { return str; }
  }
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

  // ── Collapsible section builder ───────────────────────────────
  let collapseCounter = 0;
  function collapsible(title, badgeText, innerHtml, startOpen = true) {
    const id = 'collapse-' + (++collapseCounter);
    return `
      <div class="r-section collapsible-section">
        <button class="r-section-toggle ${startOpen ? 'open' : ''}" data-target="${id}">
          <span class="r-section-title-text">${title}</span>
          ${badgeText ? `<span class="r-section-count">${esc(badgeText)}</span>` : ''}
          <svg class="collapse-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div class="collapsible-body ${startOpen ? 'open' : ''}" id="${id}">
          ${innerHtml}
        </div>
      </div>`;
  }

  // ── Tabs ──────────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  // ── Collapsible toggle (delegated) ────────────────────────────
  document.addEventListener('click', e => {
    const btn = e.target.closest('.r-section-toggle');
    if (!btn) return;
    const targetId = btn.dataset.target;
    const body = document.getElementById(targetId);
    if (!body) return;
    const open = body.classList.toggle('open');
    btn.classList.toggle('open', open);
  });

  // ── Window toggle ─────────────────────────────────────────────
  [btn48h, btn2w].forEach(btn => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      [btn48h, btn2w].forEach(b => b && b.classList.remove('active'));
      btn.classList.add('active');
      activeWindow = btn.dataset.window;
    });
  });

  // ── Load metadata ─────────────────────────────────────────────
  fetch('meta.json' + cb())
    .then(r => r.json())
    .then(d => { if (lastUpdatedEl && d.last_updated) lastUpdatedEl.textContent = toEastern(d.last_updated); })
    .catch(() => {});

  fetch('feeds.txt' + cb())
    .then(r => r.text())
    .then(text => {
      const n = text.split('\n').filter(l => l.trim().startsWith('http')).length;
      if (feedCountEl) feedCountEl.textContent = n;
    })
    .catch(() => { if (feedCountEl) feedCountEl.textContent = '180'; });

  // ── Load feed history ─────────────────────────────────────────
  fetch('feed_history.json')
    .then(r => { if (!r.ok) throw 0; return r.json(); })
    .then(data => {
      feedData = data;
      if (articleCountEl) articleCountEl.textContent = data.length;
      updateSourceBreakdown(data);
      renderTable(data);
    })
    .catch(() => {
      if (feedBody) feedBody.innerHTML =
        '<tr><td colspan="3" style="text-align:center;color:var(--text-faint);padding:2rem">No data available.</td></tr>';
    });

  function updateSourceBreakdown(data) {
    if (!sourceBreakdown) return;
    const c = {rss:0,reddit:0,mastodon:0,cccs:0};
    data.forEach(i => { const t=(i.source_type||'rss').toLowerCase(); if(c[t]!==undefined)c[t]++;else c.rss++; });
    sourceBreakdown.innerHTML =
      '<span class="src-pill src-rss">RSS\u00a0'+c.rss+'</span>'+
      '<span class="src-pill src-reddit">Reddit\u00a0'+c.reddit+'</span>'+
      '<span class="src-pill src-mastodon">Mastodon\u00a0'+c.mastodon+'</span>'+
      '<span class="src-pill src-cccs">CCCS\u00a0'+c.cccs+'</span>';
  }

  sourceFilterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      sourceFilterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeSource = btn.dataset.source;
      filterData();
    });
  });

  // ── Table ─────────────────────────────────────────────────────
  function renderTable(data) {
    if (!feedBody) return;
    feedBody.innerHTML = '';
    if (noResults) noResults.style.display = data.length === 0 ? 'block' : 'none';
    if (feedCountLabel) feedCountLabel.textContent = data.length + ' article' + (data.length !== 1 ? 's' : '');
    data.forEach(item => {
      const si = SOURCE_LABELS[(item.source_type||'rss').toLowerCase()] || SOURCE_LABELS.rss;
      const tags = (item.terms||[]).map(t=>'<span class="term-tag">'+esc(t)+'</span>').join('');
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="mono" style="color:var(--text-dim);font-size:12px;white-space:nowrap">'+esc(item.date)+'<br>'+
        '<span class="src-badge '+si.cls+'">'+si.label+'</span></td>'+
        '<td><a href="'+esc(item.link)+'" target="_blank" rel="noopener noreferrer">'+esc(item.title)+'</a></td>'+
        '<td>'+tags+'</td>';
      feedBody.appendChild(tr);
    });
  }

  function filterData() {
    const txt = searchInput ? searchInput.value.toLowerCase() : '';
    const terms = termInput ? termInput.value.toLowerCase().split(',').map(t=>t.trim()).filter(Boolean) : [];
    const filtered = feedData.filter(item => {
      if (activeSource !== 'all' && (item.source_type||'rss').toLowerCase() !== activeSource) return false;
      const textOk = !txt || item.title.toLowerCase().includes(txt);
      if (!terms.length) return textOk;
      const at = (item.terms||[]).map(t=>t.toLowerCase());
      const termOk = searchModeIsAND ? terms.every(st=>at.some(a=>a.includes(st))) : terms.some(st=>at.some(a=>a.includes(st)));
      return textOk && termOk;
    });
    renderTable(filtered);
    return filtered;
  }

  if (searchInput) searchInput.addEventListener('input', filterData);
  if (termInput)   termInput.addEventListener('input', filterData);
  if (termToggleBtn) termToggleBtn.addEventListener('click', () => {
    searchModeIsAND = !searchModeIsAND;
    termToggleBtn.textContent = searchModeIsAND ? 'AND' : 'OR';
    termToggleBtn.className   = searchModeIsAND ? 'toggle-and' : 'toggle-or';
    filterData();
  });

  // ── Exports ───────────────────────────────────────────────────
  if (downloadBtn) downloadBtn.addEventListener('click', () => {
    const rows = filterData();
    if (!rows.length) { alert('No data to export.'); return; }
    const lines = [['Date','Source','Title','Link','Terms'].join(',')];
    rows.forEach(i => lines.push([i.date,i.source_type||'rss','"'+(i.title||'').replace(/"/g,'""')+'"',i.link,'"'+(i.terms||[]).join(', ')+'"'].join(',')));
    dl(URL.createObjectURL(new Blob([lines.join('\n')],{type:'text/csv'})), 'security_feed_'+iso()+'.csv');
  });
  if (downloadReportBtn) downloadReportBtn.addEventListener('click', () => {
    if (!currentReportData) return;
    const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:Courier New,monospace;background:#0a0c0f;color:#e8f0f8;padding:2rem;max-width:900px;margin:0 auto}a{color:#00e5a0}strong{color:#e8f0f8}</style></head><body>' + reportContent.innerHTML + '</body></html>';
    dl(URL.createObjectURL(new Blob([html],{type:'text/html'})), 'security-report-'+iso()+'.html');
  });
  function dlTxt(n) {
    fetch(n).then(r=>{if(!r.ok)throw 0;return r.text();}).then(t=>dl(URL.createObjectURL(new Blob([t],{type:'text/plain'})),n)).catch(()=>alert('Could not download '+n));
  }
  if (downloadTermsBtn) downloadTermsBtn.addEventListener('click', () => dlTxt('terms.txt'));
  if (downloadFeedsBtn) downloadFeedsBtn.addEventListener('click', () => dlTxt('feeds.txt'));

  // ── Refresh button ────────────────────────────────────────────
  function cooldownLeft() {
    return Math.max(0, RATE_LIMIT_MS - (Date.now() - parseInt(localStorage.getItem(RATE_LIMIT_KEY)||'0',10)));
  }
  function updateRefreshBtn() {
    const rem = cooldownLeft();
    if (refreshBtn) refreshBtn.disabled = rem > 0;
    if (refreshBtnLabel) refreshBtnLabel.textContent = rem > 0 ? 'Cooldown '+Math.ceil(rem/60000)+'m' : 'Refresh';
  }
  updateRefreshBtn();
  setInterval(updateRefreshBtn, 30000);

  if (refreshBtn) refreshBtn.addEventListener('click', async () => {
    if (cooldownLeft() > 0) return;
    let tok = getToken();
    if (!tok) tok = promptForToken();
    if (!tok) return;
    refreshBtn.disabled = true;
    refreshBtnLabel.textContent = 'Triggering…';
    const res = await triggerWorkflow({}, tok);
    if (res.ok) {
      localStorage.setItem(RATE_LIMIT_KEY, Date.now().toString());
      refreshBtnLabel.textContent = 'Triggered ✓';
    } else {
      refreshBtnLabel.textContent = 'Error';
      if (res.status === 401 || res.status === 403) clearTokenCache();
      alert('Refresh failed:\n\n' + res.message);
    }
    setTimeout(updateRefreshBtn, 3000);
  });

  // ── Load / show report ────────────────────────────────────────
  function showLoading(msg) {
    if (reportPlaceholder) reportPlaceholder.style.display = 'none';
    if (reportContent)     reportContent.style.display     = 'none';
    if (reportLoading)     reportLoading.style.display     = 'flex';
    if (loadingMsg)        loadingMsg.textContent = msg || 'Loading…';
  }
  function hideLoading() { if (reportLoading) reportLoading.style.display = 'none'; }
  function showError(msg) {
    hideLoading();
    if (reportPlaceholder) reportPlaceholder.style.display = 'none';
    if (reportContent) {
      reportContent.style.display = 'block';
      reportContent.innerHTML = '<div style="padding:2rem;color:var(--red);font-size:13px;line-height:1.8"><strong>Error:</strong> ' + esc(msg) + '</div>';
    }
  }

  if (loadReportBtn) loadReportBtn.addEventListener('click', async () => {
    loadReportBtn.disabled = true;
    showLoading('Loading intelligence briefing…');
    try {
      const r = await fetch('report.json' + cb());
      if (!r.ok) throw new Error('report.json not found — run the workflow at least once.');
      const data = await r.json();
      if (data.ai_enabled === false) {
        showError(data.message || 'AI is disabled.');
        return;
      }
      // Pick 48h or 2w data
      const reportData = activeWindow === '2w' && data.report_2w ? data.report_2w : data;
      renderReport(reportData, activeWindow);
    } catch (e) {
      showError(e.message);
    } finally {
      loadReportBtn.disabled = false;
    }
  });

  // ── Render report ─────────────────────────────────────────────
  function renderReport(data, window) {
    hideLoading();
    if (reportPlaceholder) reportPlaceholder.style.display = 'none';
    if (reportContent)     reportContent.style.display     = 'block';
    currentReportData = data;
    if (downloadReportBtn) downloadReportBtn.style.display = 'flex';
    collapseCounter = 0;

    const ts    = toEastern(data.generated_at);
    const label = window === '2w' ? 'Days 3–14 (2-Week View)' : 'Last 48h';

    let html = `<div class="report-meta">
      <span class="report-badge">${esc(label)}</span>
      <span>Generated: <span class="report-ts mono">${esc(ts)}</span></span>
    </div>`;

    // Executive summary rendered after potential re-parse below
    function renderExecSummary(summary) {
      if (!summary) return '';
      return `<div class="executive-summary">
        <div class="exec-label">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          Key Findings
        </div>
        <p class="exec-text">${esc(summary)}</p>
      </div>`;
    }
    const execPlaceholder = '%%EXEC_SUMMARY%%';
    html += execPlaceholder;

    // If custom_response contains raw JSON (fallback from failed parse), re-parse it
    if (data.custom_response) {
      const raw = data.custom_response.trim();
      let parsed = null;
      try {
        // Strip markdown fences if present
        const clean = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/,'').trim();
        const start = clean.indexOf('{');
        const end   = clean.lastIndexOf('}') + 1;
        if (start >= 0 && end > start) {
          parsed = JSON.parse(clean.slice(start, end));
        }
      } catch (e) { parsed = null; }

      if (parsed && (parsed.vulnerabilities || parsed.threat_actors || parsed.executive_summary)) {
        // Successfully re-parsed — render as structured report
        if (parsed.executive_summary) data.executive_summary = parsed.executive_summary;
        html += renderVulnSection(parsed.vulnerabilities);
        html += renderTASection(parsed.threat_actors);
        html += renderCanadaSection(parsed.canada_landscape);
      } else {
        // Genuine free-text response — render as markdown
        html += '<div class="r-section"><div class="canada-card">' + markdownToHtml(raw) + '</div></div>';
      }
    } else {
      html += renderVulnSection(data.vulnerabilities);
      html += renderTASection(data.threat_actors);
      html += renderCanadaSection(data.canada_landscape);
    }
    html += renderSourcesSection();
    // Now inject exec summary — data.executive_summary may have been set during re-parse
    html = html.replace(execPlaceholder, renderExecSummary(data.executive_summary));
    reportContent.innerHTML = html;
  }

  // ── Section renderers ─────────────────────────────────────────
  function renderVulnSection(vulns) {
    if (!vulns) return '';
    const items = vulns.items || [];
    let inner = '';
    if (!items.length) {
      inner = '<p class="r-empty">No new CVEs matched in this period.</p>';
    } else {
      items.forEach(cve => {
        const flags = [];
        if (cve.actively_exploited) flags.push('<span class="flag-badge flag-exploited">⚡ Actively Exploited</span>');
        if (cve.zero_day)           flags.push('<span class="flag-badge flag-zeroday">💀 Zero-Day</span>');
        const sourceLink = cve.source_url
          ? `<a href="${esc(cve.source_url)}" target="_blank" rel="noopener noreferrer" class="card-source-link">View Source →</a>`
          : '';
        inner += `<div class="cve-card ${critClass(cve.criticality)}">
          <div class="cve-header">
            <span class="cve-id">${esc(cve.id||'')}</span>
            <span class="cve-title">${esc(cve.description||'')}</span>
            <span class="crit-badge ${esc(cve.criticality||'')}">${esc(cve.criticality||'?')}</span>
          </div>
          ${flags.length ? '<div class="flag-row">'+flags.join('')+'</div>' : ''}
          <div class="cve-meta">
            <div class="cve-meta-item"><strong>Software:</strong> ${esc(cve.software_affected||'—')}</div>
            <div class="cve-meta-item"><strong>CIA Impact:</strong> ${esc(cve.cia_impact||'—')}</div>
            <div class="cve-meta-item"><strong>Access Required:</strong> ${esc(cve.access_required||'—')}</div>
          </div>
          ${sourceLink}
        </div>`;
      });
    }
    return collapsible('New Vulnerabilities', (vulns.count ?? items.length) + ' CVEs', inner, true);
  }

  function renderTASection(actors) {
    if (!actors) return '';
    const items = actors.items || [];
    let inner = '';
    if (!items.length) {
      inner = '<p class="r-empty">No threat actor activity matched in this period.</p>';
    } else {
      items.forEach(ta => {
        const sourceLink = ta.source_url
          ? `<a href="${esc(ta.source_url)}" target="_blank" rel="noopener noreferrer" class="card-source-link">View Source →</a>`
          : '';
        inner += `<div class="ta-card">
          <div class="ta-name">${esc(ta.name||'')}</div>
          <div class="ta-body">
            ${ta.targets ? '<p><strong>Targets / Breaches:</strong> '+esc(ta.targets)+'</p>' : ''}
            ${ta.ttps    ? '<p><strong>TTPs:</strong> '+esc(ta.ttps)+'</p>' : ''}
            ${ta.iocs && ta.iocs.length ? '<p><strong>IoCs:</strong></p><div class="ioc-tags">'+ta.iocs.map(i=>'<span class="ioc-tag">'+esc(i)+'</span>').join('')+'</div>' : ''}
          </div>
          ${sourceLink}
        </div>`;
      });
    }
    return collapsible('Active Threat Actors', items.length + ' active', inner, true);
  }

  function renderCanadaSection(canada) {
    if (!canada) return '';
    const urls = canada.source_urls || [];
    const sourceLinks = urls.length
      ? '<div class="canada-sources">' + urls.map(u=>`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer" class="card-source-link">View Source →</a>`).join('') + '</div>'
      : '';
    let inner = '<div class="canada-card">';
    if (canada.summary)   inner += '<p>'+esc(canada.summary)+'</p>';
    if (canada.retailers) inner += '<p><strong><span class="ca-flag">🇨🇦</span> Retailers:</strong> '+esc(canada.retailers)+'</p>';
    if (canada.financial) inner += '<p><strong><span class="ca-flag">🇨🇦</span> Financial:</strong> '+esc(canada.financial)+'</p>';
    if (!canada.summary && !canada.retailers && !canada.financial)
      inner += '<p class="r-empty">No Canadian-specific incidents matched in this period.</p>';
    inner += sourceLinks + '</div>';
    return collapsible('Canadian Cyber Landscape', null, inner, true);
  }

  function renderSourcesSection() {
    if (!feedData.length) return '';
    const now = new Date();
    let recent;
    if (activeWindow === '2w') {
      // Days 3-14: same non-overlapping window as the scraper
      const cutoldDate = new Date(now - 14*24*60*60*1000).toISOString().slice(0,10);
      const cutnewDate = new Date(now -  2*24*60*60*1000).toISOString().slice(0,10);
      recent = feedData.filter(i => i.date >= cutoldDate && i.date < cutnewDate).slice(0, 80);
    } else {
      // Last 2 days
      const cutoff = new Date(now - 2*24*60*60*1000).toISOString().slice(0,10);
      recent = feedData.filter(i => i.date >= cutoff).slice(0, 80);
    }
    if (!recent.length) return '';
    let inner = '<div class="sources-list">';
    recent.forEach(item => {
      const si   = SOURCE_LABELS[(item.source_type||'rss').toLowerCase()] || SOURCE_LABELS.rss;
      const tags = (item.terms||[]).slice(0,3).map(t=>'<span class="term-tag">'+esc(t)+'</span>').join('');
      inner += `<div class="source-item">
        <span class="source-date mono">${esc(item.date)}</span>
        <span class="src-badge ${si.cls}">${si.label}</span>
        <a href="${esc(item.link)}" target="_blank" rel="noopener noreferrer" class="source-link">${esc(item.title)}</a>
        <div class="source-tags">${tags}</div>
      </div>`;
    });
    inner += '</div>';
    return collapsible('Source Articles', recent.length + ' articles', inner, false);
  }

});
