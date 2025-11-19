document.addEventListener("DOMContentLoaded", () => {
  const tableBody = document.querySelector("#feedTable tbody");
  const searchInput = document.getElementById("searchInput");
  // RENAMED: We use termInput instead of termFilter
  const termInput = document.getElementById("termInput"); 
  
  const downloadBtn = document.getElementById("downloadBtn");
  const noResultsMsg = document.getElementById("noResults");
  const lastUpdatedSpan = document.getElementById("last-updated");
  
  // NEW: Selectors for the new download buttons
  const downloadTermsBtn = document.getElementById("downloadTermsBtn");
  const downloadFeedsBtn = document.getElementById("downloadFeedsBtn");

  let feedData = [];

  // --- Utility Function for Downloading .txt files ---
  function downloadTextFile(filename) {
    fetch(filename)
        .then(response => {
            if (!response.ok) throw new Error(`Could not find ${filename}`);
            return response.text();
        })
        .then(text => {
            const blob = new Blob([text], { type: 'text/plain' });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            window.URL.revokeObjectURL(url);
            alert(`Downloading ${filename} started.`);
        })
        .catch(err => {
            console.error(err);
            alert(`Error: ${filename} could not be downloaded. Check if the file exists.`);
        });
  }

  // --- 0. Fetch Metadata (Last Updated Time) ---
  fetch("meta.json")
    .then(response => response.json())
    .then(data => {
      if (lastUpdatedSpan) {
        lastUpdatedSpan.textContent = data.last_updated;
      }
    })
    .catch(err => console.log("Metadata fetch failed", err));


  // --- 1. Fetch Data ---
  fetch("feed_history.json")
    .then(response => {
      if (!response.ok) throw new Error("History file not found");
      return response.json();
    })
    .then(data => {
      feedData = data;
      // Removed call to populateFilterDropdown
      renderTable(data);
    })
    .catch(err => {
      console.error(err);
      tableBody.innerHTML = `<tr><td colspan="3" style="text-align:center">No data available or error loading feed.</td></tr>`;
    });


  // --- 3. Render Table (No change) ---
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

  // --- 4. Filter Logic (Updated) ---
  function filterData() {
    const searchText = searchInput.value.toLowerCase();
    
    // NEW LOGIC: Parse comma-separated terms from input field
    const termSearchList = termInput.value
      .toLowerCase()
      .split(',')
      .map(term => term.trim())
      .filter(term => term.length > 0);

    const filtered = feedData.filter(item => {
      // 1. Check article title/summary search
      const textMatch = item.title.toLowerCase().includes(searchText) || 
                        (item.summary && item.summary.toLowerCase().includes(searchText));
      
      // 2. Check comma-separated terms
      let termMatch = true;
      if (termSearchList.length > 0) {
        // Must match AT LEAST ONE term in the comma-separated list
        // Note: item.terms holds the terms that matched in the original scrape
        termMatch = termSearchList.some(searchTerm => 
          item.terms.some(articleTerm => articleTerm.toLowerCase().includes(searchTerm))
        );
      }
      
      return textMatch && termMatch;
    });

    renderTable(filtered);
    return filtered;
  }

  // --- Event Listeners ---
  searchInput.addEventListener("input", filterData);
  // Using 'input' listener for immediate feedback on typing
  termInput.addEventListener("input", filterData); 

  // --- 5. Download CSV Logic (No change) ---
  downloadBtn.addEventListener("click", () => {
    const currentData = filterData(); 
    if (currentData.length === 0) return alert("No data to download");

    const csvContent = [];
    csvContent.push("Date,Title,Link,Terms");

    currentData.forEach(item => {
      const title = `"${item.title.replace(/"/g, '""')}"`;
      const terms = `"${item.terms.join(", ")}"`;
      csvContent.push(`${item.date},${title},${item.link},${terms}`);
    });

    const blob = new Blob([csvContent.join("\n")], { type: "text/csv" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `security_feed_filtered_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  });
  
  // --- NEW: Download TXT Listeners ---
  downloadTermsBtn.addEventListener("click", () => downloadTextFile("terms.txt"));
  downloadFeedsBtn.addEventListener("click", () => downloadTextFile("feeds.txt"));
});
