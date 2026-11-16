/* REPOVERSE public build. Vanilla JS, no framework. All data comes from
   relative data/ files shipped with this site. No outside requests. */
(function () {
  "use strict";

  var PAGE_SIZE = 50;
  var SUGGEST_LIMIT = 8;
  var SEARCH_LIMIT = 50;
  var SHARDS = [];
  for (var ci = 97; ci <= 122; ci++) SHARDS.push(String.fromCharCode(ci));
  SHARDS.push("other");

  var manifest = null;
  var categoryCache = {};   // slug -> records array
  var shardCache = {};      // shard -> entries array
  var chunkCache = {};      // filename -> records array
  var currentCategory = null;
  var currentPage = 1;
  var currentSearch = null; // {query, results}
  var debounceTimer = null;

  var els = {};
  ["hero-total", "hero-categories", "hero-build", "search-form",
   "search-input", "search-suggest", "error-box", "picks-section", "picks",
   "home-section", "category-grid", "results-section", "results-title",
   "results-meta", "results", "pager", "back-home", "detail-section",
   "detail", "detail-close"].forEach(function (id) {
    els[id] = document.getElementById(id);
  });

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function fmt(n) {
    return Number(n || 0).toLocaleString("en-US");
  }

  function showError(message) {
    els["error-box"].textContent = message;
    els["error-box"].hidden = false;
  }

  function hideError() {
    els["error-box"].hidden = true;
    els["error-box"].textContent = "";
  }

  function fetchJson(path) {
    return fetch(path).then(function (resp) {
      if (!resp.ok) throw new Error("Request failed for " + path + " (" + resp.status + ")");
      return resp.json();
    });
  }

  function shardFor(text) {
    var c = (text || "").charAt(0).toLowerCase();
    return (c >= "a" && c <= "z") ? c : "other";
  }

  function loadShard(shard) {
    if (shardCache[shard]) return Promise.resolve(shardCache[shard]);
    return fetchJson("data/idx-" + shard + ".json").then(function (entries) {
      shardCache[shard] = entries;
      return entries;
    });
  }

  function loadAllShards() {
    return Promise.all(SHARDS.map(loadShard)).then(function (lists) {
      var all = [];
      lists.forEach(function (l) { all = all.concat(l); });
      return all;
    });
  }

  function loadCategory(slug) {
    if (categoryCache[slug]) return Promise.resolve(categoryCache[slug]);
    var cat = null;
    manifest.categories.forEach(function (c) { if (c.slug === slug) cat = c; });
    if (!cat) return Promise.reject(new Error("Unknown category: " + slug));
    return Promise.all(cat.files.map(function (f) { return fetchJson("data/" + f); }))
      .then(function (parts) {
        var records = [];
        parts.forEach(function (p) { records = records.concat(p); });
        categoryCache[slug] = records;
        return records;
      });
  }

  function loadChunk(filename) {
    if (chunkCache[filename]) return Promise.resolve(chunkCache[filename]);
    return fetchJson("data/" + filename).then(function (records) {
      chunkCache[filename] = records;
      return records;
    });
  }

  function metaLine(r) {
    var bits = [];
    if (r.category) bits.push(esc(r.category));
    bits.push(fmt(r.forks) + " forks");
    if (r.languages && r.languages.length) bits.push("Languages: " + esc(r.languages.join(", ")));
    if (r.license) bits.push("License: " + esc(r.license));
    if (r.last_updated) bits.push("Updated: " + esc(r.last_updated));
    return bits.join(" · ");
  }

  function detailPanelHtml(r) {
    var rows = [];
    rows.push("<dt>Subcategory</dt><dd>" + esc(r.subcategory || "—") + "</dd>");
    rows.push("<dt>Languages</dt><dd>" + esc((r.languages || []).join(", ") || "—") + "</dd>");
    rows.push("<dt>Frameworks</dt><dd>" + esc((r.frameworks || []).join(", ") || "—") + "</dd>");
    rows.push("<dt>License</dt><dd>" + esc(r.license || "—") + "</dd>");
    rows.push("<dt>Last updated</dt><dd>" + esc(r.last_updated || "—") + "</dd>");
    rows.push("<dt>Archived</dt><dd>" + (r.archived ? "Yes" : "No") + "</dd>");
    var tags = (r.tags || []).map(function (t) {
      return '<span class="tag-chip">' + esc(t) + "</span>";
    }).join("");
    rows.push("<dt>Tags</dt><dd>" + (tags || "—") + "</dd>");
    return '<div class="row-panel"><dl>' + rows.join("") + "</dl></div>";
  }

  function rowHtml(r) {
    var archived = r.archived ? '<span class="archived-badge">Archived</span>' : "";
    return '<div class="row-top"><span class="row-name">' + esc(r.repo) + archived +
      '</span><span class="row-stars">★ ' + fmt(r.stars) + "</span></div>" +
      '<div class="row-meta">' + metaLine(r) + "</div>";
  }

  function renderRows(container, records, startIndex) {
    container.innerHTML = "";
    if (!records.length) {
      container.innerHTML = '<p class="muted">No results.</p>';
      return;
    }
    records.forEach(function (r) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "row";
      btn.setAttribute("aria-expanded", "false");
      btn.innerHTML = rowHtml(r);
      btn.addEventListener("click", function () {
        var panel = btn.querySelector(".row-panel");
        if (panel) {
          panel.remove();
          btn.setAttribute("aria-expanded", "false");
        } else {
          btn.insertAdjacentHTML("beforeend", detailPanelHtml(r));
          btn.setAttribute("aria-expanded", "true");
        }
      });
      container.appendChild(btn);
    });
    void startIndex;
  }

  function renderPager(totalItems, onPage) {
    var totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
    els.pager.innerHTML = "";
    if (totalItems <= PAGE_SIZE) return;
    function pageButton(label, page, opts) {
      opts = opts || {};
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      if (opts.current) b.setAttribute("aria-current", "page");
      if (opts.disabled) b.disabled = true;
      b.addEventListener("click", function () { onPage(page); });
      return b;
    }
    els.pager.appendChild(pageButton("← Prev", currentPage - 1, { disabled: currentPage <= 1 }));
    var start = Math.max(1, Math.min(currentPage - 2, totalPages - 4));
    var end = Math.min(totalPages, start + 4);
    for (var p = start; p <= end; p++) {
      els.pager.appendChild(pageButton(String(p), p, { current: p === currentPage }));
    }
    els.pager.appendChild(pageButton("Next →", currentPage + 1, { disabled: currentPage >= totalPages }));
    var info = document.createElement("span");
    info.className = "pager-info";
    info.textContent = "Page " + currentPage + " of " + totalPages + " · " + fmt(totalItems) + " records";
    els.pager.appendChild(info);
  }

  function showHome() {
    currentCategory = null;
    currentSearch = null;
    els["results-section"].hidden = true;
    els["detail-section"].hidden = true;
    els["picks-section"].hidden = false;
    els["home-section"].hidden = false;
  }

  function showResults(title, meta) {
    els["picks-section"].hidden = true;
    els["home-section"].hidden = true;
    els["detail-section"].hidden = true;
    els["results-section"].hidden = false;
    els["results-title"].textContent = title;
    els["results-meta"].textContent = meta;
  }

  function openCategory(slug, page) {
    hideError();
    currentSearch = null;
    currentCategory = slug;
    currentPage = page || 1;
    var cat = null;
    manifest.categories.forEach(function (c) { if (c.slug === slug) cat = c; });
    if (!cat) { showError("Category not found: " + slug); return; }
    showResults(cat.name, "Loading…");
    els.results.innerHTML = '<p class="muted">Loading records…</p>';
    els.pager.innerHTML = "";
    loadCategory(slug).then(function (records) {
      renderCategoryPage(cat, records);
    }).catch(function (err) {
      showError("Could not load this category. Check the connection and try again. (" + err.message + ")");
      els.results.innerHTML = "";
      els["results-meta"].textContent = "";
    });
  }

  function renderCategoryPage(cat, records) {
    var totalPages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    var start = (currentPage - 1) * PAGE_SIZE;
    var pageRecords = records.slice(start, start + PAGE_SIZE);
    showResults(cat.name, fmt(records.length) + " records, sorted by stars (highest first). Select a row for details.");
    renderRows(els.results, pageRecords, start);
    renderPager(records.length, function (p) {
      currentPage = p;
      renderCategoryPage(cat, records);
      window.scrollTo(0, 0);
    });
  }

  function openSearch(query) {
    hideError();
    var q = (query || "").trim();
    if (q.length < 2) {
      showError("Type at least 2 characters to search.");
      return;
    }
    currentCategory = null;
    currentSearch = { query: q, results: [] };
    showResults('Search: "' + q + '"', "Searching…");
    els.results.innerHTML = '<p class="muted">Searching all names…</p>';
    els.pager.innerHTML = "";
    loadAllShards().then(function (entries) {
      var needle = q.toLowerCase();
      var matches = entries.filter(function (e) {
        return e.n.toLowerCase().indexOf(needle) !== -1;
      });
      matches.sort(function (a, b) { return (b.s - a.s) || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0); });
      var top = matches.slice(0, SEARCH_LIMIT);
      currentSearch.results = top;
      els["results-meta"].textContent = fmt(matches.length) + " matches, showing top " + top.length +
        " by stars. Select a result to load its record details.";
      renderSearchResults(top, q);
    }).catch(function (err) {
      showError("Search could not load the name index. Check the connection and try again. (" + err.message + ")");
      els.results.innerHTML = "";
      els["results-meta"].textContent = "";
    });
  }

  function renderSearchResults(entries, query) {
    els.results.innerHTML = "";
    if (!entries.length) {
      els.results.innerHTML = '<p class="muted">No repo names match "' + esc(query) + '".</p>';
      return;
    }
    var catName = {};
    manifest.categories.forEach(function (c) { catName[c.slug] = c.name; });
    entries.forEach(function (e) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "row";
      btn.innerHTML = '<div class="row-top"><span class="row-name">' + esc(e.n) +
        '</span><span class="row-stars">★ ' + fmt(e.s) + "</span></div>" +
        '<div class="row-meta">' + esc(catName[e.c] || e.c) + "</div>";
      btn.addEventListener("click", function () { openSearchDetail(e); });
      els.results.appendChild(btn);
    });
  }

  function openSearchDetail(entry) {
    hideError();
    els.detail.innerHTML = '<p class="muted">Loading record…</p>';
    els["detail-section"].hidden = false;
    loadChunk(entry.f).then(function (records) {
      var found = null;
      for (var i = 0; i < records.length; i++) {
        if (records[i].repo === entry.n && records[i].stars === entry.s) { found = records[i]; break; }
      }
      if (!found) {
        for (var j = 0; j < records.length; j++) {
          if (records[j].repo === entry.n) { found = records[j]; break; }
        }
      }
      if (!found) {
        els.detail.innerHTML = '<p class="muted">Record not found in its data file.</p>';
        return;
      }
      var rows = [];
      rows.push("<dt>Name</dt><dd>" + esc(found.repo) + "</dd>");
      rows.push("<dt>Category</dt><dd>" + esc(found.category) + "</dd>");
      rows.push("<dt>Subcategory</dt><dd>" + esc(found.subcategory || "—") + "</dd>");
      rows.push("<dt>Stars</dt><dd>" + fmt(found.stars) + "</dd>");
      rows.push("<dt>Forks</dt><dd>" + fmt(found.forks) + "</dd>");
      rows.push("<dt>Languages</dt><dd>" + esc((found.languages || []).join(", ") || "—") + "</dd>");
      rows.push("<dt>Frameworks</dt><dd>" + esc((found.frameworks || []).join(", ") || "—") + "</dd>");
      rows.push("<dt>License</dt><dd>" + esc(found.license || "—") + "</dd>");
      rows.push("<dt>Last updated</dt><dd>" + esc(found.last_updated || "—") + "</dd>");
      rows.push("<dt>Archived</dt><dd>" + (found.archived ? "Yes" : "No") + "</dd>");
      var tags = (found.tags || []).map(function (t) {
        return '<span class="tag-chip">' + esc(t) + "</span>";
      }).join("");
      rows.push("<dt>Tags</dt><dd>" + (tags || "—") + "</dd>");
      els.detail.innerHTML = "<dl>" + rows.join("") + "</dl>";
      els["detail-section"].scrollIntoView();
    }).catch(function (err) {
      showError("Could not load that record. (" + err.message + ")");
    });
  }

  function renderHome() {
    els["hero-total"].textContent = fmt(manifest.total);
    els["hero-categories"].textContent = fmt(manifest.categories.length);
    els["hero-build"].textContent = "public build · " + manifest.generated_at;

    // Top picks first, in manifest order.
    els.picks.innerHTML = "";
    if (!manifest.top_picks || !manifest.top_picks.length) {
      els.picks.innerHTML = '<p class="muted">No top picks in this build.</p>';
    } else {
      manifest.top_picks.forEach(function (p) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "pick";
        b.innerHTML = '<span class="badge">Trending</span>' +
          '<span class="pick-name">' + esc(p.repo) + "</span>" +
          '<span class="pick-meta">★ ' + fmt(p.stars) + " · " + esc(p.category) + "</span>";
        b.addEventListener("click", function () {
          location.hash = "#/category/" + p.slug;
        });
        els.picks.appendChild(b);
      });
    }

    // Category grid, sorted by count desc for browsing.
    els["category-grid"].innerHTML = "";
    var cats = manifest.categories.slice().sort(function (a, b) { return b.count - a.count; });
    cats.forEach(function (c) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "category-card";
      b.innerHTML = '<span class="cat-name">' + esc(c.name) + "</span>" +
        '<span class="cat-count">' + fmt(c.count) + " repos</span>";
      b.addEventListener("click", function () {
        location.hash = "#/category/" + c.slug;
      });
      els["category-grid"].appendChild(b);
    });
  }

  function hideSuggest() {
    els["search-suggest"].hidden = true;
    els["search-suggest"].innerHTML = "";
    els["search-input"].setAttribute("aria-expanded", "false");
  }

  function runSuggest() {
    var q = els["search-input"].value.trim();
    if (q.length < 2) { hideSuggest(); return; }
    var needle = q.toLowerCase();
    loadShard(shardFor(q)).then(function (entries) {
      // The shard holds names starting with the query's first letter.
      // Filter by substring within the shard for suggestions.
      var matches = entries.filter(function (e) {
        return e.n.toLowerCase().indexOf(needle) !== -1;
      }).slice(0, SUGGEST_LIMIT);
      if (!matches.length) { hideSuggest(); return; }
      var catName = {};
      manifest.categories.forEach(function (c) { catName[c.slug] = c.name; });
      els["search-suggest"].innerHTML = "";
      matches.forEach(function (e) {
        var b = document.createElement("button");
        b.type = "button";
        b.setAttribute("role", "option");
        b.innerHTML = "<span>" + esc(e.n) + "</span>" +
          '<span class="suggest-cat">' + esc(catName[e.c] || e.c) + " · ★ " + fmt(e.s) + "</span>";
        b.addEventListener("click", function () {
          els["search-input"].value = e.n;
          hideSuggest();
          location.hash = "#/search/" + encodeURIComponent(e.n);
        });
        els["search-suggest"].appendChild(b);
      });
      els["search-suggest"].hidden = false;
      els["search-input"].setAttribute("aria-expanded", "true");
    }).catch(function () {
      hideSuggest();
    });
  }

  function route() {
    var hash = location.hash || "";
    var catMatch = hash.match(/^#\/category\/([a-z0-9-]+)\/?$/);
    var searchMatch = hash.match(/^#\/search\/(.+)$/);
    if (catMatch) {
      openCategory(catMatch[1], 1);
    } else if (searchMatch) {
      var q = "";
      try { q = decodeURIComponent(searchMatch[1]); } catch (e) { q = searchMatch[1]; }
      els["search-input"].value = q;
      openSearch(q);
    } else {
      showHome();
    }
  }

  // Wire up controls.
  els["search-form"].addEventListener("submit", function (ev) {
    ev.preventDefault();
    hideSuggest();
    var q = els["search-input"].value.trim();
    if (q.length < 2) { showError("Type at least 2 characters to search."); return; }
    location.hash = "#/search/" + encodeURIComponent(q);
    if (location.hash === "#/search/" + encodeURIComponent(q)) route();
  });
  els["search-input"].addEventListener("input", function () {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSuggest, 200);
  });
  els["search-input"].addEventListener("blur", function () {
    setTimeout(hideSuggest, 150);
  });
  els["search-input"].addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") hideSuggest();
  });
  els["back-home"].addEventListener("click", function () {
    location.hash = "#/";
    showHome();
  });
  els["detail-close"].addEventListener("click", function () {
    els["detail-section"].hidden = true;
  });
  window.addEventListener("hashchange", route);

  // Boot: manifest first. Any failure shows a visible message, never blank.
  fetchJson("data/manifest.json").then(function (m) {
    manifest = m;
    renderHome();
    route();
  }).catch(function (err) {
    els["hero-total"].textContent = "Could not load";
    els["hero-categories"].textContent = "—";
    els.picks.innerHTML = "";
    els["category-grid"].innerHTML = "";
    showError("Could not load the catalog data files. Serve this folder with a local static file server and reload. (" + err.message + ")");
  });
})();
