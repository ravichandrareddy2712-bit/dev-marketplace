/* dev-marketplace public build. Vanilla JS, no framework. All data comes from
   relative data/ files shipped with this site. No outside requests.
   Rendered fields only: repo, category, subcategory, languages,
   frameworks, tags, stars, forks, license, last_updated, archived. */
(function () {
  "use strict";

  var PAGE_SIZE = 50;
  var SUGGEST_LIMIT = 8;
  var RELATED_LIMIT = 8;
  var POPULAR_MIN = 1000;
  var SHARDS = [];
  for (var ci = 97; ci <= 122; ci++) SHARDS.push(String.fromCharCode(ci));
  SHARDS.push("other");

  var manifest = null;
  var categoryCache = {};   // slug -> records array
  var shardCache = {};      // shard -> entries array
  var chunkCache = {};      // filename -> records array
  var savedStates = {};     // route key -> {page, filters}
  var detailHints = null;   // {slug, name, stars, file, context}
  var detailReturnHash = "#/";
  var currentView = "home"; // home | categories | category | search | detail
  var viewToken = 0;        // guards stale async loads after navigation
  var list = null;          // active category/search list state

  var suggestToken = 0;
  var suggestEntries = [];
  var suggestActive = -1;
  var suggestHandled = false;
  var debounceTimer = null;

  var els = {};
  ["hero", "hero-total", "hero-categories", "hero-languages", "hero-popular",
   "hero-build", "hero-total-inline", "hero-cats-inline",
   "search-form", "search-input", "search-suggest",
   "error-box", "home-sections", "picks-section", "picks",
   "cat-glance", "glance-note", "browse-all-btn", "browse-note",
   "categories-section", "categories-grid",
   "results-section", "results-title", "results-meta", "results", "pager",
   "back-home", "filter-bar", "filter-language", "filter-license",
   "filter-min-stars", "filter-updated", "filter-subcategory",
   "filter-subcategory-wrap", "filter-category", "filter-category-wrap",
   "filter-sort", "filter-popular", "filter-hide-archived", "filter-clear",
   "filter-note", "filter-load-full", "detail-section", "detail-title",
   "detail", "detail-back", "related-heading", "related",
   "nav-home", "nav-categories",
   "contrib-form", "contrib-name", "contrib-category", "contrib-why",
   "contrib-tags", "contrib-error", "contrib-result", "contrib-output",
   "contrib-copy", "contrib-status"].forEach(function (id) {
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

  function categoryBySlug(slug) {
    var found = null;
    manifest.categories.forEach(function (c) { if (c.slug === slug) found = c; });
    return found;
  }

  function categoryName(slug) {
    var c = categoryBySlug(slug);
    return c ? c.name : slug;
  }

  function loadCategory(slug) {
    if (categoryCache[slug]) return Promise.resolve(categoryCache[slug]);
    var cat = categoryBySlug(slug);
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

  /* The updated filter is relative to the build date in the manifest, so it
     stays stable for this static snapshot instead of drifting with today. */
  function updatedCutoff(days) {
    var base = null;
    if (manifest && manifest.generated_at) {
      var parts = String(manifest.generated_at).split("-");
      if (parts.length === 3) base = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]));
    }
    if (!base || isNaN(base.getTime())) base = new Date();
    return new Date(base.getTime() - days * 86400000).toISOString().slice(0, 10);
  }

  function findInRecords(records, name, stars) {
    var fallback = null;
    for (var i = 0; i < records.length; i++) {
      if (records[i].repo === name) {
        if (stars != null && records[i].stars === stars) return records[i];
        if (!fallback) fallback = records[i];
      }
    }
    return fallback;
  }

  /* ---------- list state, filters, sorting ---------- */

  function defaultFilters() {
    return { language: "", license: "", minStars: 0, updatedDays: 0,
             subcategory: "", category: "", hideArchived: false,
             popular: false, sort: "stars" };
  }

  function filtersActive(f) {
    return !!(f.language || f.license || f.minStars > 0 || f.updatedDays > 0 ||
              f.subcategory || f.category || f.hideArchived || f.popular);
  }

  function needsFullRecords(f) {
    return !!(f.language || f.license || f.updatedDays > 0 || f.hideArchived ||
              f.sort === "forks" || f.sort === "updated");
  }

  function newListState(kind, key) {
    var state = { kind: kind, key: key, items: [], view: [], page: 1,
                  baseCount: 0, filters: defaultFilters(),
                  resolved: kind === "category", resolvePromise: null,
                  contextRecords: null };
    var saved = savedStates[key];
    if (saved) {
      state.page = saved.page || 1;
      var f = defaultFilters();
      Object.keys(f).forEach(function (k) {
        if (saved.filters && saved.filters[k] !== undefined) f[k] = saved.filters[k];
      });
      state.filters = f;
    }
    return state;
  }

  function saveListState() {
    if (!list) return;
    savedStates[list.key] = { page: list.page, filters: list.filters };
  }

  /* Unified list item: {n: name, s: stars, c: category slug, f: chunk file,
     r: full record or null}. Category items always carry the record; search
     items carry only the index entry until full records are resolved. */
  function itemFromRecord(r, slug) {
    return { n: r.repo, s: r.stars || 0, c: slug, f: null, r: r };
  }
  function itemFromEntry(e) {
    return { n: e.n, s: e.s || 0, c: e.c, f: e.f, r: null };
  }

  function itemPasses(item, f, cutoff) {
    if (f.category && item.c !== f.category) return false;
    if (item.s < f.minStars) return false;
    if (f.popular && item.s < POPULAR_MIN) return false;
    var r = item.r;
    if (!r) return true;
    if (f.subcategory && (r.subcategory || "") !== f.subcategory) return false;
    if (f.language && (r.languages || []).indexOf(f.language) === -1) return false;
    if (f.license && (r.license || "") !== f.license) return false;
    if (f.hideArchived && r.archived) return false;
    if (cutoff && (!r.last_updated || r.last_updated < cutoff)) return false;
    return true;
  }

  function nameCmp(a, b) {
    var an = a.n.toLowerCase(), bn = b.n.toLowerCase();
    if (an < bn) return -1;
    if (an > bn) return 1;
    return b.s - a.s;
  }

  function sortItems(items, sort) {
    var arr = items.slice();
    if (sort === "name") {
      arr.sort(nameCmp);
    } else if (sort === "forks") {
      arr.sort(function (a, b) {
        var af = a.r ? (a.r.forks || 0) : 0;
        var bf = b.r ? (b.r.forks || 0) : 0;
        return (bf - af) || (b.s - a.s) || nameCmp(a, b);
      });
    } else if (sort === "updated") {
      arr.sort(function (a, b) {
        var au = a.r ? (a.r.last_updated || "") : "";
        var bu = b.r ? (b.r.last_updated || "") : "";
        if (au < bu) return 1;
        if (au > bu) return -1;
        return (b.s - a.s) || nameCmp(a, b);
      });
    } else {
      arr.sort(function (a, b) { return (b.s - a.s) || nameCmp(a, b); });
    }
    return arr;
  }

  /* Returns the filtered + sorted view, or null while full-record
     resolution is running (it re-renders when done). */
  function applyList() {
    var f = list.filters;
    if (list.kind === "search" && !list.resolved && needsFullRecords(f)) {
      resolveSearch();
      return null;
    }
    var cutoff = f.updatedDays > 0 ? updatedCutoff(f.updatedDays) : null;
    var kept = list.items.filter(function (it) { return itemPasses(it, f, cutoff); });
    return sortItems(kept, f.sort);
  }

  function renderList() {
    var view = applyList();
    if (view === null) return;
    list.view = view;
    renderListPage();
  }

  function renderListPage() {
    var totalPages = Math.max(1, Math.ceil(list.view.length / PAGE_SIZE));
    if (list.page > totalPages) list.page = totalPages;
    if (list.page < 1) list.page = 1;
    var start = (list.page - 1) * PAGE_SIZE;
    renderRows(els.results, list.view.slice(start, start + PAGE_SIZE));
    renderPager(list.view.length);
    updateMeta();
    updateFilterControls();
  }

  function updateMeta() {
    var f = list.filters;
    var sortLabel = { stars: "stars (highest first)", forks: "forks (highest first)",
                      updated: "recently updated", name: "name (A–Z)" }[f.sort] || "stars";
    var text = fmt(list.view.length) + " of " + fmt(list.baseCount) +
      " records, sorted by " + sortLabel + ".";
    if (filtersActive(f)) text += " Filters on.";
    text += " Select a row for details.";
    els["results-meta"].textContent = text;
  }

  /* ---------- search full-record resolution ---------- */

  function setFilterControlsDisabled(disabled) {
    ["filter-language", "filter-license", "filter-min-stars", "filter-updated",
     "filter-subcategory", "filter-category", "filter-sort", "filter-popular",
     "filter-hide-archived", "filter-clear", "filter-load-full"].forEach(function (id) {
      els[id].disabled = disabled;
    });
  }

  function resolveSearch() {
    if (list.resolvePromise) return list.resolvePromise;
    els["results-meta"].textContent = "Loading full record details to apply filters…";
    setFilterControlsDisabled(true);
    var files = {};
    list.items.forEach(function (it) { files[it.f] = true; });
    var names = Object.keys(files);
    var token = viewToken;
    list.resolvePromise = Promise.all(names.map(loadChunk)).then(function (chunks) {
      if (token !== viewToken) return 0; // user navigated away; keep cache, drop work
      var maps = {};
      names.forEach(function (fname, idx) {
        var byKey = {}, byName = {};
        chunks[idx].forEach(function (r) {
          var key = r.repo + "|" + (r.stars || 0);
          if (!byKey[key]) byKey[key] = r;
          if (!byName[r.repo]) byName[r.repo] = r;
        });
        maps[fname] = { byKey: byKey, byName: byName };
      });
      var resolved = 0;
      list.items.forEach(function (it) {
        var m = maps[it.f];
        if (!m) return;
        var rec = m.byKey[it.n + "|" + it.s] || m.byName[it.n] || null;
        if (rec) { it.r = rec; resolved++; }
      });
      list.resolved = true;
      list.resolvePromise = null;
      setFilterControlsDisabled(false);
      populateFilterOptions();
      renderList();
      return resolved;
    }).catch(function (err) {
      list.resolvePromise = null;
      setFilterControlsDisabled(false);
      if (token !== viewToken) return;
      list.filters.language = "";
      list.filters.license = "";
      list.filters.updatedDays = 0;
      list.filters.hideArchived = false;
      if (list.filters.sort === "forks" || list.filters.sort === "updated") {
        list.filters.sort = "stars";
      }
      syncFilterControlValues();
      showError("Full record details could not be loaded, so language, license, updated and archived filters are unavailable for this search. (" + err.message + ")");
      renderList();
    });
    return list.resolvePromise;
  }

  /* ---------- filter bar ---------- */

  function distinctValues(items, get) {
    var seen = {}, out = [];
    items.forEach(function (it) {
      var vals = get(it);
      if (vals == null) return;
      (Array.isArray(vals) ? vals : [vals]).forEach(function (v) {
        if (v == null || v === "") return;
        if (!seen[v]) { seen[v] = true; out.push(v); }
      });
    });
    out.sort(function (a, b) {
      var al = String(a).toLowerCase(), bl = String(b).toLowerCase();
      return al < bl ? -1 : al > bl ? 1 : 0;
    });
    return out;
  }

  function fillSelect(select, pairs, allLabel, current) {
    select.innerHTML = "";
    var all = document.createElement("option");
    all.value = "";
    all.textContent = allLabel;
    select.appendChild(all);
    pairs.forEach(function (p) {
      var opt = document.createElement("option");
      opt.value = p.value;
      opt.textContent = p.label;
      select.appendChild(opt);
    });
    select.value = current || "";
  }

  function populateFilterOptions() {
    var f = list.filters;
    var withRecords = list.items.filter(function (it) { return !!it.r; });
    var langPairs = distinctValues(withRecords, function (it) { return it.r.languages; })
      .map(function (v) { return { value: v, label: v }; });
    var licPairs = distinctValues(withRecords, function (it) { return it.r.license; })
      .map(function (v) { return { value: v, label: v }; });
    fillSelect(els["filter-language"], langPairs, "All languages", f.language);
    fillSelect(els["filter-license"], licPairs, "All licenses", f.license);

    if (list.kind === "category") {
      els["filter-subcategory-wrap"].hidden = false;
      els["filter-category-wrap"].hidden = true;
      var subPairs = distinctValues(withRecords, function (it) { return it.r.subcategory; })
        .map(function (v) { return { value: v, label: v }; });
      fillSelect(els["filter-subcategory"], subPairs, "All subcategories", f.subcategory);
    } else {
      els["filter-subcategory-wrap"].hidden = true;
      els["filter-category-wrap"].hidden = false;
      var catSeen = {}, catPairs = [];
      list.items.forEach(function (it) {
        if (!catSeen[it.c]) { catSeen[it.c] = true; catPairs.push({ value: it.c, label: categoryName(it.c) }); }
      });
      catPairs.sort(function (a, b) { return a.label < b.label ? -1 : a.label > b.label ? 1 : 0; });
      fillSelect(els["filter-category"], catPairs, "All categories", f.category);
    }

    var popularCount = 0;
    list.items.forEach(function (it) { if (it.s >= POPULAR_MIN) popularCount++; });
    els["filter-popular"].textContent = "★ Popular (1,000+) · " + fmt(popularCount);
    els["filter-popular"].setAttribute("aria-pressed", f.popular ? "true" : "false");

    var showLoadFull = list.kind === "search" && !list.resolved;
    els["filter-load-full"].hidden = !showLoadFull;
    els["filter-note"].hidden = !showLoadFull;
    if (showLoadFull) {
      els["filter-note"].textContent = "Language, license, updated and archived filters need full record details.";
    }
    els["filter-language"].disabled = showLoadFull;
    els["filter-license"].disabled = showLoadFull;

    syncFilterControlValues();
    updateFilterControls();
  }

  function syncFilterControlValues() {
    var f = list.filters;
    els["filter-language"].value = f.language;
    els["filter-license"].value = f.license;
    els["filter-min-stars"].value = String(f.minStars);
    els["filter-updated"].value = String(f.updatedDays);
    els["filter-subcategory"].value = f.subcategory;
    els["filter-category"].value = f.category;
    els["filter-sort"].value = f.sort;
    els["filter-hide-archived"].checked = f.hideArchived;
    els["filter-popular"].setAttribute("aria-pressed", f.popular ? "true" : "false");
  }

  function updateFilterControls() {
    if (!list) return;
    els["filter-clear"].hidden = !filtersActive(list.filters);
  }

  function readFilterControls() {
    var f = list.filters;
    f.language = els["filter-language"].value;
    f.license = els["filter-license"].value;
    f.minStars = parseInt(els["filter-min-stars"].value, 10) || 0;
    f.updatedDays = parseInt(els["filter-updated"].value, 10) || 0;
    f.subcategory = els["filter-subcategory"].value;
    f.category = els["filter-category"].value;
    f.sort = els["filter-sort"].value;
    f.hideArchived = els["filter-hide-archived"].checked;
  }

  function onFilterChanged() {
    if (!list) return;
    readFilterControls();
    list.page = 1;
    saveListState();
    renderList();
  }

  /* ---------- rows, pager, views ---------- */

  function metaLine(r) {
    var bits = [];
    if (r.category) bits.push(esc(r.category));
    bits.push(fmt(r.forks) + " forks");
    if (r.languages && r.languages.length) bits.push("Languages: " + esc(r.languages.join(", ")));
    if (r.license) bits.push("License: " + esc(r.license));
    if (r.last_updated) bits.push("Updated: " + esc(r.last_updated));
    return bits.join(" · ");
  }

  function rowHtml(item) {
    var r = item.r;
    var archived = r && r.archived ? '<span class="archived-badge">Archived</span>' : "";
    var meta = r ? metaLine(r) : esc(categoryName(item.c));
    return '<div class="row-top"><span class="row-name">' + esc(item.n) + archived +
      '</span><span class="row-stars">★ ' + fmt(item.s) + "</span></div>" +
      '<div class="row-meta">' + meta + "</div>";
  }

  function renderRows(container, items) {
    container.innerHTML = "";
    if (!items.length) {
      container.innerHTML = '<p class="muted">No results match the current filters.</p>';
      return;
    }
    items.forEach(function (item) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "row";
      btn.innerHTML = rowHtml(item);
      btn.addEventListener("click", function () {
        goDetail(item.c, item.n, item.s, item.f,
          item.r && list && list.kind === "category" ? list.contextRecords : null);
      });
      container.appendChild(btn);
    });
  }

  function renderPager(totalItems) {
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
      b.addEventListener("click", function () {
        list.page = page;
        saveListState();
        renderListPage();
        window.scrollTo(0, 0);
      });
      return b;
    }
    els.pager.appendChild(pageButton("← Prev", list.page - 1, { disabled: list.page <= 1 }));
    var start = Math.max(1, Math.min(list.page - 2, totalPages - 4));
    var end = Math.min(totalPages, start + 4);
    for (var p = start; p <= end; p++) {
      els.pager.appendChild(pageButton(String(p), p, { current: p === list.page }));
    }
    els.pager.appendChild(pageButton("Next →", list.page + 1, { disabled: list.page >= totalPages }));
    var info = document.createElement("span");
    info.className = "pager-info";
    info.textContent = "Page " + list.page + " of " + totalPages + " · " + fmt(totalItems) + " records";
    els.pager.appendChild(info);
  }

  function updateNav() {
    var home = currentView === "home";
    var cats = currentView === "categories" || currentView === "category";
    els["nav-home"].classList.toggle("nav-active", home);
    els["nav-categories"].classList.toggle("nav-active", cats);
    if (home) { els["nav-home"].setAttribute("aria-current", "page"); }
    else { els["nav-home"].removeAttribute("aria-current"); }
    if (cats) { els["nav-categories"].setAttribute("aria-current", "page"); }
    else { els["nav-categories"].removeAttribute("aria-current"); }
  }

  function showHome() {
    currentView = "home";
    list = null;
    els.hero.hidden = false;
    els["home-sections"].hidden = false;
    els["categories-section"].hidden = true;
    els["results-section"].hidden = true;
    els["detail-section"].hidden = true;
    updateNav();
  }

  function showCategories() {
    currentView = "categories";
    list = null;
    els.hero.hidden = true;
    els["home-sections"].hidden = true;
    els["categories-section"].hidden = false;
    els["results-section"].hidden = true;
    els["detail-section"].hidden = true;
    updateNav();
    window.scrollTo(0, 0);
  }

  function showResults(title, meta) {
    els.hero.hidden = true;
    els["home-sections"].hidden = true;
    els["categories-section"].hidden = true;
    els["detail-section"].hidden = true;
    els["results-section"].hidden = false;
    els["results-title"].textContent = title;
    els["results-meta"].textContent = meta;
    updateNav();
  }

  function openCategory(slug) {
    hideError();
    var cat = categoryBySlug(slug);
    if (!cat) { showError("Category not found: " + slug); return; }
    currentView = "category";
    list = newListState("category", "cat:" + slug);
    list.slug = slug;
    var token = viewToken;
    showResults(cat.name, "Loading…");
    els["filter-bar"].hidden = true;
    els.results.innerHTML = '<p class="muted">Loading records…</p>';
    els.pager.innerHTML = "";
    loadCategory(slug).then(function (records) {
      if (token !== viewToken) return;
      list.items = records.map(function (r) { return itemFromRecord(r, slug); });
      list.baseCount = records.length;
      list.contextRecords = records;
      populateFilterOptions();
      els["filter-bar"].hidden = false;
      renderList();
    }).catch(function (err) {
      if (token !== viewToken) return;
      showError("Could not load this category. Check the connection and try again. (" + err.message + ")");
      els.results.innerHTML = "";
      els["results-meta"].textContent = "";
    });
  }

  function openSearch(query) {
    hideError();
    var q = (query || "").trim();
    if (!q) {
      showError("Type something to search.");
      return;
    }
    currentView = "search";
    list = newListState("search", "search:" + q);
    list.query = q;
    var token = viewToken;
    showResults('Search: "' + q + '"', "Searching…");
    els["filter-bar"].hidden = true;
    els.results.innerHTML = '<p class="muted">Searching all names…</p>';
    els.pager.innerHTML = "";
    loadAllShards().then(function (entries) {
      if (token !== viewToken) return;
      var needle = q.toLowerCase();
      var matches = entries.filter(function (e) {
        return e.n.toLowerCase().indexOf(needle) !== -1;
      });
      list.items = matches.map(itemFromEntry);
      list.baseCount = matches.length;
      populateFilterOptions();
      els["filter-bar"].hidden = false;
      renderList();
    }).catch(function (err) {
      if (token !== viewToken) return;
      showError("Search could not load the name index. Check the connection and try again. (" + err.message + ")");
      els.results.innerHTML = "";
      els["results-meta"].textContent = "";
    });
  }

  /* ---------- detail view ---------- */

  function navigate(hash) {
    if (location.hash === hash) {
      route();
    } else {
      location.hash = hash;
    }
  }

  function goDetail(slug, name, stars, file, context) {
    if (currentView !== "detail") detailReturnHash = location.hash || "#/";
    detailHints = { slug: slug, name: name, stars: stars, file: file, context: context };
    navigate("#/detail/" + slug + "/" + encodeURIComponent(name));
  }

  function showDetailLoading(name) {
    currentView = "detail";
    list = null;
    updateNav();
    els.hero.hidden = true;
    els["home-sections"].hidden = true;
    els["categories-section"].hidden = true;
    els["results-section"].hidden = true;
    els["detail-section"].hidden = false;
    els["detail-title"].textContent = name || "Record details";
    els.detail.innerHTML = '<p class="muted">Loading record…</p>';
    els["related-heading"].hidden = true;
    els.related.innerHTML = "";
    window.scrollTo(0, 0);
  }

  function openDetailByRoute(slug, name) {
    hideError();
    var hints = detailHints;
    detailHints = null;
    if (hints && hints.slug === slug && hints.name === name && hints.context) {
      var rec = findInRecords(hints.context, name, hints.stars);
      if (rec) { renderDetail(rec, hints.context, slug); return; }
    }
    showDetailLoading(name);
    var token = viewToken;
    function fromCategory() {
      loadCategory(slug).then(function (records) {
        if (token !== viewToken) return;
        var found = findInRecords(records, name, hints ? hints.stars : null);
        if (!found) {
          els.detail.innerHTML = '<p class="muted">Record not found in its data file.</p>';
          return;
        }
        renderDetail(found, records, slug);
      }).catch(function (err) {
        if (token !== viewToken) return;
        showError("Could not load that record. (" + err.message + ")");
        els.detail.innerHTML = "";
      });
    }
    if (hints && hints.slug === slug && hints.name === name && hints.file) {
      loadChunk(hints.file).then(function (records) {
        if (token !== viewToken) return;
        var found = findInRecords(records, name, hints.stars);
        if (found) { renderDetail(found, records, slug); return; }
        fromCategory();
      }).catch(function () {
        if (token !== viewToken) return;
        fromCategory();
      });
    } else {
      fromCategory();
    }
  }

  function detailHtml(r) {
    var rows = [];
    rows.push("<dt>Category</dt><dd>" + esc(r.category || "—") + "</dd>");
    rows.push("<dt>Subcategory</dt><dd>" + esc(r.subcategory || "—") + "</dd>");
    rows.push("<dt>Stars</dt><dd>" + fmt(r.stars) + "</dd>");
    rows.push("<dt>Forks</dt><dd>" + fmt(r.forks) + "</dd>");
    rows.push("<dt>Languages</dt><dd>" + esc((r.languages || []).join(", ") || "—") + "</dd>");
    rows.push("<dt>Frameworks</dt><dd>" + esc((r.frameworks || []).join(", ") || "—") + "</dd>");
    rows.push("<dt>License</dt><dd>" + esc(r.license || "—") + "</dd>");
    rows.push("<dt>Last updated</dt><dd>" + esc(r.last_updated || "—") + "</dd>");
    rows.push("<dt>Archived</dt><dd>" + (r.archived ? "Yes" : "No") + "</dd>");
    var tags = (r.tags || []).map(function (t) {
      return '<span class="tag-chip">' + esc(t) + "</span>";
    }).join("");
    rows.push("<dt>Tags</dt><dd>" + (tags || "—") + "</dd>");
    return '<p class="detail-name">' + esc(r.repo) + "</p>" +
      '<p class="detail-stats">★ ' + fmt(r.stars) + " · " + fmt(r.forks) + " forks</p>" +
      "<dl>" + rows.join("") + "</dl>";
  }

  function renderDetail(r, context, slug) {
    currentView = "detail";
    list = null;
    updateNav();
    els.hero.hidden = true;
    els["home-sections"].hidden = true;
    els["categories-section"].hidden = true;
    els["results-section"].hidden = true;
    els["detail-section"].hidden = false;
    els["detail-title"].textContent = r.repo;
    els.detail.innerHTML = detailHtml(r);
    var catBtn = document.createElement("button");
    catBtn.type = "button";
    catBtn.className = "link-button";
    catBtn.textContent = "See all in " + (r.category || categoryName(slug)) + " →";
    catBtn.addEventListener("click", function () {
      navigate("#/category/" + slug);
    });
    var wrap = document.createElement("p");
    wrap.appendChild(catBtn);
    els.detail.appendChild(wrap);

    var related = (context || []).filter(function (o) {
      return o.subcategory && o.subcategory === r.subcategory &&
        !(o.repo === r.repo && o.stars === r.stars);
    }).sort(function (a, b) { return (b.stars - a.stars); }).slice(0, RELATED_LIMIT);
    els.related.innerHTML = "";
    if (related.length) {
      els["related-heading"].hidden = false;
      els["related-heading"].textContent = "Related repos — " + r.subcategory;
      related.forEach(function (o) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "row";
        btn.innerHTML = rowHtml(itemFromRecord(o, slug));
        btn.addEventListener("click", function () {
          goDetail(slug, o.repo, o.stars, null, context);
        });
        els.related.appendChild(btn);
      });
    } else {
      els["related-heading"].hidden = true;
      els.related.innerHTML = '<p class="muted">No other repos in this subcategory.</p>';
    }
    window.scrollTo(0, 0);
  }

  /* ---------- home ---------- */

  function renderHome() {
    els["hero-total"].textContent = fmt(manifest.total);
    els["hero-categories"].textContent = fmt(manifest.categories.length);
    els["hero-languages"].textContent = manifest.languages_count != null ? fmt(manifest.languages_count) : "—";
    els["hero-popular"].textContent = manifest.popular_count != null ? fmt(manifest.popular_count) : "—";
    els["hero-build"].textContent = "public build · " + manifest.generated_at;

    els.picks.innerHTML = "";
    if (!manifest.top_picks || !manifest.top_picks.length) {
      els.picks.innerHTML = '<p class="muted">No top picks in this build.</p>';
    } else {
      /* Best recommendations: top picks ranked by stars, highest first. */
      var ranked = manifest.top_picks.slice().sort(function (a, b) {
        return (b.stars - a.stars) || (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0);
      });
      ranked.forEach(function (p, i) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "pick";
        b.innerHTML = '<span class="badge">Trending · #' + (i + 1) + "</span>" +
          '<span class="pick-name">' + esc(p.repo) + "</span>" +
          '<span class="pick-meta"><span class="stars">★ ' + fmt(p.stars) + "</span> · " + esc(p.category) + "</span>";
        b.addEventListener("click", function () {
          var cat = categoryBySlug(p.slug);
          var file = cat && cat.files && cat.files.length === 1 ? cat.files[0] : null;
          goDetail(p.slug, p.repo, p.stars, file, null);
        });
        els.picks.appendChild(b);
      });
    }

    /* Inline hero counts, so the intro text stays truthful. */
    els["hero-total-inline"].textContent = fmt(manifest.total);
    els["hero-cats-inline"].textContent = fmt(manifest.categories.length);

    var cats = manifest.categories.slice().sort(function (a, b) { return b.count - a.count; });

    /* Categories at a glance: top 8 by count. The full grid lives on #/categories. */
    els["cat-glance"].innerHTML = "";
    cats.slice(0, 8).forEach(function (c) {
      var g = document.createElement("button");
      g.type = "button";
      g.className = "glance-chip";
      g.innerHTML = '<span class="glance-name">' + esc(c.name) + "</span>" +
        '<span class="glance-count">' + fmt(c.count) + "</span>";
      g.addEventListener("click", function () {
        navigate("#/category/" + c.slug);
      });
      els["cat-glance"].appendChild(g);
    });
    els["glance-note"].textContent = "Top 8 of " + fmt(manifest.categories.length) +
      " categories by size. The full list opens when you browse categories.";

    /* Full category grid for the #/categories view. */
    els["categories-grid"].innerHTML = "";
    cats.forEach(function (c) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "category-card";
      b.innerHTML = '<span class="cat-name">' + esc(c.name) + "</span>" +
        '<span class="cat-count">' + fmt(c.count) + " repos</span>";
      b.addEventListener("click", function () {
        navigate("#/category/" + c.slug);
      });
      els["categories-grid"].appendChild(b);
    });

    /* Browse-all button + note, with the live category count. */
    els["browse-all-btn"].textContent = "Browse all " + fmt(manifest.categories.length) + " categories →";
    els["browse-note"].textContent = "All " + fmt(manifest.categories.length) +
      " categories, every listing sorted by stars.";

    /* Contribute form: category dropdown from the manifest. */
    var sel = els["contrib-category"];
    sel.innerHTML = "";
    var none = document.createElement("option");
    none.value = "";
    none.textContent = "Choose a category…";
    sel.appendChild(none);
    manifest.categories.slice().sort(function (a, b) {
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    }).forEach(function (c) {
      var opt = document.createElement("option");
      opt.value = c.slug;
      opt.textContent = c.name;
      sel.appendChild(opt);
    });
  }

  /* ---------- autocomplete ---------- */

  function hideSuggest() {
    els["search-suggest"].hidden = true;
    els["search-suggest"].innerHTML = "";
    els["search-input"].setAttribute("aria-expanded", "false");
    els["search-input"].removeAttribute("aria-activedescendant");
    suggestEntries = [];
    suggestActive = -1;
  }

  function setSuggestActive(index) {
    suggestActive = index;
    var btns = els["search-suggest"].querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      var on = i === index;
      btns[i].classList.toggle("suggest-active", on);
      if (on) {
        btns[i].setAttribute("aria-selected", "true");
        els["search-input"].setAttribute("aria-activedescendant", btns[i].id);
      } else {
        btns[i].removeAttribute("aria-selected");
      }
    }
    if (index < 0) els["search-input"].removeAttribute("aria-activedescendant");
  }

  function activateSuggestion(index) {
    var e = suggestEntries[index];
    if (!e || suggestHandled) return;
    suggestHandled = true;
    var name = e.n;
    hideSuggest();
    els["search-input"].value = name;
    goDetail(e.c, e.n, e.s, e.f, null);
  }

  function runSuggest() {
    var q = els["search-input"].value.trim();
    if (!q) { hideSuggest(); return; }
    var token = ++suggestToken;
    var needle = q.toLowerCase();
    loadShard(shardFor(q)).then(function (entries) {
      if (token !== suggestToken) return;
      if (els["search-input"].value.trim() !== q) return;
      var matches = entries.filter(function (e) {
        return e.n.toLowerCase().indexOf(needle) !== -1;
      }).slice(0, SUGGEST_LIMIT);
      if (!matches.length) { hideSuggest(); return; }
      suggestEntries = matches;
      suggestActive = -1;
      suggestHandled = false;
      var box = els["search-suggest"];
      box.innerHTML = "";
      matches.forEach(function (e, i) {
        var b = document.createElement("button");
        b.type = "button";
        b.id = "suggest-opt-" + i;
        b.setAttribute("role", "option");
        b.setAttribute("tabindex", "-1");
        b.innerHTML = "<span>" + esc(e.n) + "</span>" +
          '<span class="suggest-cat">' + esc(categoryName(e.c)) + " · ★ " + fmt(e.s) + "</span>";
        /* mousedown + preventDefault keeps focus in the input, so the
           blur handler cannot hide the list under the user's tap. The
           click handler is a fallback; the guard prevents a double open. */
        b.addEventListener("mousedown", function (ev) {
          ev.preventDefault();
          activateSuggestion(i);
        });
        b.addEventListener("click", function (ev) {
          ev.preventDefault();
          activateSuggestion(i);
        });
        box.appendChild(b);
      });
      box.hidden = false;
      els["search-input"].setAttribute("aria-expanded", "true");
    }).catch(function () {
      if (token === suggestToken) hideSuggest();
    });
  }

  /* ---------- routing ---------- */

  function route() {
    viewToken++;
    var hash = location.hash || "";
    var catMatch = hash.match(/^#\/category\/([a-z0-9-]+)\/?$/);
    var categoriesMatch = hash.match(/^#\/categories\/?$/);
    var searchMatch = hash.match(/^#\/search\/(.+)$/);
    var detailMatch = hash.match(/^#\/detail\/([a-z0-9-]+)\/(.+)$/);
    if (catMatch) {
      openCategory(catMatch[1]);
    } else if (categoriesMatch) {
      showCategories();
    } else if (searchMatch) {
      var q = "";
      try { q = decodeURIComponent(searchMatch[1]); } catch (e) { q = searchMatch[1]; }
      els["search-input"].value = q;
      openSearch(q);
    } else if (detailMatch) {
      var name = "";
      try { name = decodeURIComponent(detailMatch[2]); } catch (e) { name = detailMatch[2]; }
      openDetailByRoute(detailMatch[1], name);
    } else {
      showHome();
    }
  }

  /* ---------- wire up controls ---------- */

  els["search-form"].addEventListener("submit", function (ev) {
    ev.preventDefault();
    hideSuggest();
    var q = els["search-input"].value.trim();
    if (!q) { showError("Type something to search."); return; }
    navigate("#/search/" + encodeURIComponent(q));
  });
  els["search-input"].addEventListener("input", function () {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSuggest, 150);
  });
  els["search-input"].addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") { hideSuggest(); return; }
    if (els["search-suggest"].hidden || !suggestEntries.length) return;
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setSuggestActive((suggestActive + 1) % suggestEntries.length);
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setSuggestActive((suggestActive - 1 + suggestEntries.length) % suggestEntries.length);
    } else if (ev.key === "Enter" && suggestActive >= 0) {
      ev.preventDefault();
      activateSuggestion(suggestActive);
    }
  });
  els["search-input"].addEventListener("blur", function (ev) {
    var next = ev.relatedTarget;
    if (next && els["search-suggest"].contains(next)) return;
    hideSuggest();
  });
  document.addEventListener("click", function (ev) {
    if (!ev.target.closest || !ev.target.closest(".search-block")) hideSuggest();
  });

  ["filter-language", "filter-license", "filter-min-stars", "filter-updated",
   "filter-subcategory", "filter-category", "filter-sort"].forEach(function (id) {
    els[id].addEventListener("change", onFilterChanged);
  });
  els["filter-hide-archived"].addEventListener("change", onFilterChanged);
  els["filter-popular"].addEventListener("click", function () {
    if (!list) return;
    list.filters.popular = !list.filters.popular;
    els["filter-popular"].setAttribute("aria-pressed", list.filters.popular ? "true" : "false");
    list.page = 1;
    saveListState();
    renderList();
  });
  els["filter-clear"].addEventListener("click", function () {
    if (!list) return;
    list.filters = defaultFilters();
    list.page = 1;
    saveListState();
    syncFilterControlValues();
    renderList();
  });
  els["filter-load-full"].addEventListener("click", function () {
    if (!list || list.kind !== "search" || list.resolved) return;
    resolveSearch();
  });

  els["back-home"].addEventListener("click", function () {
    navigate("#/");
  });
  els["detail-back"].addEventListener("click", function () {
    navigate(detailReturnHash);
  });
  els["browse-all-btn"].addEventListener("click", function () {
    navigate("#/categories");
  });
  window.addEventListener("hashchange", route);

  /* ---------- contribute form: build + copy only, nothing is sent ---------- */

  function contribEntry(name, catName, why, tags) {
    var lines = [];
    lines.push("Suggested repo: " + name);
    lines.push("Category: " + catName);
    lines.push("Why it is useful: " + (why || "—"));
    lines.push("Tags: " + (tags || "—"));
    lines.push("Suggested via the dev-marketplace contribute form.");
    return lines.join("\n");
  }

  els["contrib-form"].addEventListener("submit", function (ev) {
    ev.preventDefault();
    var name = els["contrib-name"].value.trim();
    var slug = els["contrib-category"].value;
    var why = els["contrib-why"].value.trim();
    var tags = els["contrib-tags"].value.trim().replace(/\s*,\s*/g, ", ");
    var err = els["contrib-error"];
    if (!name) {
      err.textContent = "Enter the repo name.";
      err.hidden = false;
      els["contrib-name"].focus();
      return;
    }
    if (!slug) {
      err.textContent = "Choose a category.";
      err.hidden = false;
      els["contrib-category"].focus();
      return;
    }
    err.hidden = true;
    err.textContent = "";
    els["contrib-output"].textContent = contribEntry(name, categoryName(slug), why, tags);
    els["contrib-result"].hidden = false;
    els["contrib-status"].textContent = "";
    els["contrib-output"].focus();
  });

  els["contrib-copy"].addEventListener("click", function () {
    var text = els["contrib-output"].textContent;
    var done = function (ok) {
      els["contrib-status"].textContent = ok
        ? "Copied — paste it as an issue on the dev-marketplace repo."
        : "Copy did not work in this browser — select the text above and copy it by hand.";
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else {
      var range = document.createRange();
      range.selectNodeContents(els["contrib-output"]);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      try { done(document.execCommand("copy")); }
      catch (e) { done(false); }
      sel.removeAllRanges();
    }
  });

  /* Boot: manifest first. Any failure shows a visible message, never blank. */
  fetchJson("data/manifest.json").then(function (m) {
    manifest = m;
    renderHome();
    route();
  }).catch(function (err) {
    els["hero-total"].textContent = "Could not load";
    els["hero-categories"].textContent = "—";
    els["hero-languages"].textContent = "—";
    els["hero-popular"].textContent = "—";
    els.picks.innerHTML = "";
    els["categories-grid"].innerHTML = "";
    els["cat-glance"].innerHTML = "";
    showError("Could not load the catalog data files. Serve this folder with a local static file server and reload. (" + err.message + ")");
  });
})();
