document.addEventListener("DOMContentLoaded", () => {
  const tableBody = document.querySelector("#feedTable tbody");
  const searchInput = document.getElementById("searchInput");
  const termFilter = document.getElementById("termFilter");
  const downloadBtn = document.getElementById("downloadBtn");
  const noResultsMsg = document.getElementById("noResults");
  const lastUpdatedSpan = document.getElementById("last-updated");

  // 0. Fetch Metadata (Last Updated Time)
  fetch("meta.json")
    .then(response => response.json())
    .then(data => {
      // THIS MUST MATCH THE ID IN feed.html
      if (lastUpdatedSpan) {
        lastUpdatedSpan.textContent = data.last_updated; 
      }
    })
    .catch(err => console.log("Metadata fetch failed", err));

  // ... rest of your existing code (fetch feed_history.json etc) ...

  let feedData = [];

  // 1. Fetch Data
  fetch("feed_history.json")
    .then(response => {
      if (!response.ok) throw new Error("History file not found");
      return response.json();
    })
    .then(data => {
      feedData = data;
      populateFilterDropdown(data);
      renderTable(data);
    })
    .catch(err => {
      console.error(err);
      tableBody.innerHTML = `<tr><td colspan="3" style="text-align:center">No data available or error loading feed.</td></tr>`;
    });

  // 2. Populate Dropdown with unique terms found in data
  function populateFilterDropdown(data) {
    const allTerms = new Set();
    data.forEach(item => {
      item.terms.forEach(term => allTerms.add(term));
    });
    
    const sortedTerms = Array.from(allTerms).sort();
    sortedTerms.forEach(term => {
      const option = document.createElement("option");
      option.value = term;
      option.textContent = term;
      termFilter.appendChild(option);
    });
  }

  // 3. Render Table
  function renderTable(data) {
    tableBody.innerHTML = "";
    
    if (data.length === 0) {
      noResultsMsg.style.display = "block";
      return;
    } else {
      noResultsMsg.style.display = "none";
    }

    data.forEach(item => {
      const row = document.createElement("tr");
      
      // Create Terms tags
      const termsHtml = item.terms
        .map(t => `<span class="term-tag">${t}</span>`)
        .join(" ");

      row.innerHTML = `
        <td>${item.date}</td>
        <td>
          <a href="${item.link}" target="_blank" rel="noopener">${item.title}</a>
        </td>
        <td>${termsHtml}</td>
      `;
      tableBody.appendChild(row);
    });
  }

  // 4. Filter Logic
  function filterData() {
    const searchText = searchInput.value.toLowerCase();
    const selectedTerm = termFilter.value;

    const filtered = feedData.filter(item => {
      // Check text search
      const textMatch = item.title.toLowerCase().includes(searchText) || 
                        (item.summary && item.summary.toLowerCase().includes(searchText));
      
      // Check dropdown term
      const termMatch = selectedTerm === "all" || item.terms.includes(selectedTerm);

      return textMatch && termMatch;
    });

    renderTable(filtered);
    return filtered; // Return for CSV downloader
  }

  searchInput.addEventListener("input", filterData);
  termFilter.addEventListener("change", filterData);

  // 5. Download CSV Logic
  downloadBtn.addEventListener("click", () => {
    const currentData = filterData(); // Get currently visible data
    if (currentData.length === 0) return alert("No data to download");

    const csvContent = [];
    // Header
    csvContent.push("Date,Title,Link,Terms");

    // Rows
    currentData.forEach(item => {
      // Escape quotes for CSV validity
      const title = `"${item.title.replace(/"/g, '""')}"`;
      const terms = `"${item.terms.join(", ")}"`;
      csvContent.push(`${item.date},${title},${item.link},${terms}`);
    });

    const blob = new Blob([csvContent.join("\n")], { type: "text/csv" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `security_feed_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  });
});
