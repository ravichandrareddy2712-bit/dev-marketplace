/* dev-marketplace public build. Vanilla JS, no framework. All data comes from
   relative data/ files shipped with this site. No outside requests.
   Rendered fields only: repo, category, subcategory, languages,
   frameworks, tags, stars, forks, license, last_updated, archived.
   Skill records render: name, category, subcategory, tags, license,
   last_updated, compatible_agents, installs, word_count, file_count.
   Community-contributed records may also carry contributed_by, a
   self-declared display name, rendered as a distinct Community badge. */
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
  var currentView = "home"; // home | categories | category | search | detail | skills | skill-category | skill-search | skill-detail | soon
  var soonType = null; // "prompts" | "agents" while on a coming-soon view
  var searchType = "repo"; // "repo" | "skill": which catalog the search box queries
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
   "about-total", "about-cats", "about-langs", "about-build-date",
   "search-form", "search-input", "search-suggest",
   "error-box", "home-sections", "picks-section", "picks",
   "cat-glance", "glance-note", "browse-all-btn", "browse-note",
   "categories-section", "categories-grid",
   "results-section", "results-title", "results-meta", "search-note", "results", "pager",
   "back-home", "filter-bar", "filter-language", "filter-license",
   "filter-min-stars", "filter-updated", "filter-subcategory",
   "filter-subcategory-wrap", "filter-category", "filter-category-wrap",
   "filter-sort", "filter-popular", "filter-hide-archived", "filter-clear",
   "filter-note", "filter-load-full", "detail-section", "detail-title",
   "detail", "detail-back", "related-heading", "related",
   "nav-home", "nav-categories", "nav-contribute",
   "contribute-section", "contrib-form", "contrib-username", "contrib-name", "contrib-category", "contrib-why",
   "contrib-tags", "contrib-error", "contrib-result", "contrib-output",
   "contrib-copy", "contrib-status",
   "nav-skills", "nav-prompts", "nav-agents",
   "type-tabs", "tab-count-repos", "tab-count-skills", "tab-count-prompts", "tab-count-agents",
   "skills-section", "skills-grid", "skills-note",
   "soon-section", "soon-title", "soon-body", "soon-back",
   "filter-language-label", "filter-min-stars-label",
   "search-label", "search-hint"].forEach(function (id) {
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

  /* type: "repo" (idx-*.json) or "skill" (skills-idx-*.json). The shard
     cache is keyed by type + shard so the two catalogs never mix. */
  function loadShard(shard, type) {
    var key = (type || "repo") + ":" + shard;
    if (shardCache[key]) return Promise.resolve(shardCache[key]);
    var file = type === "skill" ? "skills-idx-" + shard + ".json" : "idx-" + shard + ".json";
    return fetchJson("data/" + file).then(function (entries) {
      shardCache[key] = entries;
      return entries;
    });
  }

  function loadAllShards(type) {
    return Promise.all(SHARDS.map(function (s) { return loadShard(s, type); })).then(function (lists) {
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

  function skillsCategoryBySlug(slug) {
    var found = null;
    if (manifest && manifest.skills) {
      manifest.skills.categories.forEach(function (c) { if (c.slug === slug) found = c; });
    }
    return found;
  }

  function skillsCategoryName(slug) {
    var c = skillsCategoryBySlug(slug);
    return c ? c.name : slug;
  }

  /* Record accessors that work for both types: repo records carry repo /
     stars; skill records carry name / installs (null until published). */
  function recName(r) { return r.repo || r.name; }
  function recScore(r) { return r.stars != null ? r.stars : (r.installs || 0); }
  function recIsSkill(r) { return r && r.item_type === "skill"; }

  function loadCategory(slug, type) {
    var key = (type || "repo") + ":" + slug;
    if (categoryCache[key]) return Promise.resolve(categoryCache[key]);
    var cat = type === "skill" ? skillsCategoryBySlug(slug) : categoryBySlug(slug);
    if (!cat) return Promise.reject(new Error("Unknown category: " + slug));
    return Promise.all(cat.files.map(function (f) { return fetchJson("data/" + f); }))
      .then(function (parts) {
        var records = [];
        parts.forEach(function (p) { records = records.concat(p); });
        categoryCache[key] = records;
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
      if (recName(records[i]) === name) {
        if (stars != null && recScore(records[i]) === stars) return records[i];
        if (!fallback) fallback = records[i];
      }
    }
    return fallback;
  }

  /* ---------- list state, filters, sorting ---------- */

  function defaultFilters() {
    return { language: "", agent: "", license: "", minStars: 0, updatedDays: 0,
             subcategory: "", category: "", hideArchived: false,
             popular: false, sort: "stars" };
  }

  function filtersActive(f) {
    return !!(f.language || f.agent || f.license || f.minStars > 0 || f.updatedDays > 0 ||
              f.subcategory || f.category || f.hideArchived || f.popular);
  }

  function needsFullRecords(f) {
    return !!(f.language || f.agent || f.license || f.updatedDays > 0 || f.hideArchived ||
              f.sort === "forks" || f.sort === "updated");
  }

  function newListState(kind, key, type) {
    var state = { kind: kind, key: key, type: type || "repo", items: [], view: [], page: 1,
                  baseCount: 0, filters: defaultFilters(),
                  resolved: kind === "category", resolvePromise: null,
                  contextRecords: null };
    /* Skills have no installs data, so their lists start alphabetical. */
    if (state.type === "skill") state.filters.sort = "name";
    var saved = savedStates[key];
    if (saved) {
      state.page = saved.page || 1;
      var f = defaultFilters();
      Object.keys(f).forEach(function (k) {
        if (saved.filters && saved.filters[k] !== undefined) f[k] = saved.filters[k];
      });
      state.filters = f;
    }
    /* A saved "forks" sort cannot apply to skills (no forks field). */
    if (state.type === "skill" && state.filters.sort === "forks") state.filters.sort = "name";
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
    return { n: recName(r), s: recScore(r), c: slug, f: null, r: r, t: r.item_type || "repo" };
  }
  function itemFromEntry(e) {
    return { n: e.n, s: e.s || 0, c: e.c, f: e.f, r: null, t: e.t || "repo" };
  }

  function itemPasses(item, f, cutoff) {
    if (f.category && item.c !== f.category) return false;
    if (item.s < f.minStars) return false;
    if (f.popular && item.s < POPULAR_MIN) return false;
    var r = item.r;
    if (!r) return true;
    if (f.subcategory && (r.subcategory || "") !== f.subcategory) return false;
    if (f.language && (r.languages || []).indexOf(f.language) === -1) return false;
    if (f.agent && (r.compatible_agents || []).indexOf(f.agent) === -1) return false;
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
    if (list.type === "skill" && f.sort === "stars") sortLabel = "installs (highest first)";
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
          var key = recName(r) + "|" + recScore(r);
          if (!byKey[key]) byKey[key] = r;
          if (!byName[recName(r)]) byName[recName(r)] = r;
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
    var skill = list.type === "skill";
    var withRecords = list.items.filter(function (it) { return !!it.r; });
    /* For skills the "language" select lists compatible agents instead. */
    var langPairs = skill
      ? distinctValues(withRecords, function (it) { return it.r.compatible_agents; })
        .map(function (v) { return { value: v, label: v }; })
      : distinctValues(withRecords, function (it) { return it.r.languages; })
        .map(function (v) { return { value: v, label: v }; });
    var licPairs = distinctValues(withRecords, function (it) { return it.r.license; })
      .map(function (v) { return { value: v, label: v }; });
    fillSelect(els["filter-language"], langPairs, skill ? "All agents" : "All languages",
      skill ? f.agent : f.language);
    fillSelect(els["filter-license"], licPairs, "All licenses", f.license);
    els["filter-language-label"].textContent = skill ? "Compatible agent" : "Language";
    els["filter-min-stars-label"].textContent = skill ? "Min installs" : "Min stars";

    /* Min-stars thresholds mean installs for skills; relabel the options
       (rebuilt for both types, so switching catalogs never leaves the
       other type's wording behind). */
    var minSel = els["filter-min-stars"];
    var minOpts = skill
      ? [["0", "Any installs"], ["100", "100+ installs"], ["500", "500+ installs"],
         ["1000", "1,000+ installs"], ["5000", "5,000+ installs"],
         ["10000", "10,000+ installs"], ["50000", "50,000+ installs"]]
      : [["0", "Any stars"], ["100", "100+ stars"], ["500", "500+ stars"],
         ["1000", "1,000+ stars"], ["5000", "5,000+ stars"],
         ["10000", "10,000+ stars"], ["50000", "50,000+ stars"]];
    minSel.innerHTML = "";
    minOpts.forEach(function (o) {
      var mopt = document.createElement("option");
      mopt.value = o[0];
      mopt.textContent = o[1];
      minSel.appendChild(mopt);
    });

    /* Sort options: skills have no forks; "stars" means installs there. */
    var sortSel = els["filter-sort"];
    var sortOpts = skill
      ? [["stars", "Installs: high to low (no installs data yet)"],
         ["updated", "Recently updated"], ["name", "Name: A–Z"]]
      : [["stars", "Stars: high to low"], ["forks", "Forks: high to low"],
         ["updated", "Recently updated"], ["name", "Name: A–Z"]];
    sortSel.innerHTML = "";
    sortOpts.forEach(function (o) {
      var opt = document.createElement("option");
      opt.value = o[0];
      opt.textContent = o[1];
      sortSel.appendChild(opt);
    });

    if (list.kind === "category") {
      /* Skills have no subcategories, and a skills category page is one
         category already, so both wraps stay hidden for skills. */
      els["filter-subcategory-wrap"].hidden = skill;
      els["filter-category-wrap"].hidden = true;
      if (!skill) {
        var subPairs = distinctValues(withRecords, function (it) { return it.r.subcategory; })
          .map(function (v) { return { value: v, label: v }; });
        fillSelect(els["filter-subcategory"], subPairs, "All subcategories", f.subcategory);
      }
    } else {
      els["filter-subcategory-wrap"].hidden = true;
      els["filter-category-wrap"].hidden = false;
      var catSeen = {}, catPairs = [];
      var catLabel = skill ? skillsCategoryName : categoryName;
      list.items.forEach(function (it) {
        if (!catSeen[it.c]) { catSeen[it.c] = true; catPairs.push({ value: it.c, label: catLabel(it.c) }); }
      });
      catPairs.sort(function (a, b) { return a.label < b.label ? -1 : a.label > b.label ? 1 : 0; });
      fillSelect(els["filter-category"], catPairs, "All categories", f.category);
    }

    /* Popular (1,000+ installs) and Hide archived have no meaning for
       skills: no installs data is published and skills are never archived. */
    els["filter-popular"].hidden = skill;
    els["filter-hide-archived"].closest("label").hidden = skill;
    if (!skill) {
      var popularCount = 0;
      list.items.forEach(function (it) { if (it.s >= POPULAR_MIN) popularCount++; });
      els["filter-popular"].textContent = "★ Popular (1,000+) · " + fmt(popularCount);
      els["filter-popular"].setAttribute("aria-pressed", f.popular ? "true" : "false");
    }

    var showLoadFull = list.kind === "search" && !list.resolved;
    els["filter-load-full"].hidden = !showLoadFull;
    els["filter-note"].hidden = !showLoadFull;
    if (showLoadFull) {
      els["filter-note"].textContent = skill
        ? "Compatible agent, license and updated filters need full record details."
        : "Language, license, updated and archived filters need full record details.";
    }
    els["filter-language"].disabled = showLoadFull;
    els["filter-license"].disabled = showLoadFull;

    syncFilterControlValues();
    updateFilterControls();
  }

  function syncFilterControlValues() {
    var f = list.filters;
    els["filter-language"].value = list.type === "skill" ? f.agent : f.language;
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
    if (list.type === "skill") { f.agent = els["filter-language"].value; f.language = ""; }
    else { f.language = els["filter-language"].value; f.agent = ""; }
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

  /* A community-contributed record carries contributed_by: the display
     name its contributor declared. No catalog record has one yet; the
     rendering below is ready for when contributed repos are added. */
  function contributorOf(r) {
    if (!r || typeof r.contributed_by !== "string") return "";
    return r.contributed_by.trim();
  }

  function communityBadgeHtml(r) {
    if (!contributorOf(r)) return "";
    return '<span class="community-badge">Community</span>';
  }

  function metaLine(r) {
    if (recIsSkill(r)) {
      var sbits = [];
      if (r.category) sbits.push(esc(r.category));
      if (r.compatible_agents && r.compatible_agents.length) {
        sbits.push("Works with: " + esc(r.compatible_agents.join(", ")));
      }
      if (r.word_count != null) sbits.push(fmt(r.word_count) + " words");
      if (r.license) sbits.push("License: " + esc(r.license));
      if (r.last_updated) sbits.push("Updated: " + esc(r.last_updated));
      return sbits.join(" · ");
    }
    var bits = [];
    if (r.category) bits.push(esc(r.category));
    var who = contributorOf(r);
    if (who) bits.push("Contributed by " + esc(who));
    bits.push(fmt(r.forks) + " forks");
    if (r.languages && r.languages.length) bits.push("Languages: " + esc(r.languages.join(", ")));
    if (r.license) bits.push("License: " + esc(r.license));
    if (r.last_updated) bits.push("Updated: " + esc(r.last_updated));
    return bits.join(" · ");
  }

  function rowHtml(item) {
    var r = item.r;
    var archived = r && r.archived ? '<span class="archived-badge">Archived</span>' : "";
    var community = r ? communityBadgeHtml(r) : "";
    var meta = r ? metaLine(r)
      : esc(item.t === "skill" ? skillsCategoryName(item.c) : categoryName(item.c));
    /* Skills have no installs data yet: show no score chip at all instead
       of a misleading zero. */
    var score = item.t === "skill"
      ? (item.s > 0 ? '<span class="row-stars">' + fmt(item.s) + " installs</span>" : "")
      : '<span class="row-stars">★ ' + fmt(item.s) + "</span>";
    return '<div class="row-top"><span class="row-name">' + esc(item.n) + archived + community +
      "</span>" + score + "</div>" +
      '<div class="row-meta">' + meta + "</div>";
  }

  function renderRows(container, items) {
    container.innerHTML = "";
    if (!items.length) {
      if (list && list.kind === "search" && list.baseCount === 0) {
        renderEmptySearch(container);
      } else {
        container.innerHTML = '<p class="muted">No results match the current filters.</p>';
      }
      return;
    }
    items.forEach(function (item) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "row";
      btn.innerHTML = rowHtml(item);
      btn.addEventListener("click", function () {
        goDetail(item.c, item.n, item.s, item.f,
          item.r && list && list.kind === "category" ? list.contextRecords : null,
          item.t);
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
    var skills = currentView === "skills" || currentView === "skill-category" ||
                 currentView === "skill-search" || currentView === "skill-detail";
    var prompts = currentView === "soon" && soonType === "prompts";
    var agents = currentView === "soon" && soonType === "agents";
    els["nav-home"].classList.toggle("nav-active", home);
    els["nav-categories"].classList.toggle("nav-active", cats);
    els["nav-skills"].classList.toggle("nav-active", skills);
    els["nav-prompts"].classList.toggle("nav-active", prompts);
    els["nav-agents"].classList.toggle("nav-active", agents);
    if (home) { els["nav-home"].setAttribute("aria-current", "page"); }
    else { els["nav-home"].removeAttribute("aria-current"); }
    if (cats) { els["nav-categories"].setAttribute("aria-current", "page"); }
    else { els["nav-categories"].removeAttribute("aria-current"); }
    if (skills) { els["nav-skills"].setAttribute("aria-current", "page"); }
    else { els["nav-skills"].removeAttribute("aria-current"); }
    if (prompts) { els["nav-prompts"].setAttribute("aria-current", "page"); }
    else { els["nav-prompts"].removeAttribute("aria-current"); }
    if (agents) { els["nav-agents"].setAttribute("aria-current", "page"); }
    else { els["nav-agents"].removeAttribute("aria-current"); }
    var tab = skills ? "tab-skills" : prompts ? "tab-prompts" : agents ? "tab-agents" : "tab-repos";
    ["tab-repos", "tab-skills", "tab-prompts", "tab-agents"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.toggle("type-active", id === tab);
    });
  }

  /* The search box queries one catalog at a time; its label follows. */
  function setSearchType(t) {
    searchType = t;
    var skill = t === "skill";
    els["search-label"].textContent = skill ? "Search skill names" : "Search repo names";
    els["search-input"].placeholder = skill ? "Search skill names…" : "Search repo names…";
    els["search-hint"].textContent = skill
      ? "Type to see suggestions, alphabetical. Search matches any part of a skill name. Use ↑ ↓ to move through suggestions, Enter to open one."
      : "Type to see suggestions, best-starred first. Search matches any part of a repo name. Use ↑ ↓ to move through suggestions, Enter to open one.";
  }

  function showHome() {
    currentView = "home";
    list = null;
    setSearchType("repo");
    els.hero.hidden = false;
    els["home-sections"].hidden = false;
    els["categories-section"].hidden = true;
    els["results-section"].hidden = true;
    els["detail-section"].hidden = true;
    els["skills-section"].hidden = true;
    els["soon-section"].hidden = true;
    updateNav();
  }

  function showCategories() {
    currentView = "categories";
    list = null;
    setSearchType("repo");
    els.hero.hidden = true;
    els["home-sections"].hidden = true;
    els["categories-section"].hidden = false;
    els["results-section"].hidden = true;
    els["detail-section"].hidden = true;
    els["skills-section"].hidden = true;
    els["soon-section"].hidden = true;
    updateNav();
    window.scrollTo(0, 0);
  }

  function showResults(title, meta) {
    els.hero.hidden = true;
    els["home-sections"].hidden = true;
    els["categories-section"].hidden = true;
    els["detail-section"].hidden = true;
    els["skills-section"].hidden = true;
    els["soon-section"].hidden = true;
    els["results-section"].hidden = false;
    els["results-title"].textContent = title;
    els["results-meta"].textContent = meta;
    els["search-note"].hidden = true;
    els["search-note"].textContent = "";
    updateNav();
  }

  function showSkills() {
    currentView = "skills";
    list = null;
    setSearchType("skill");
    els.hero.hidden = true;
    els["home-sections"].hidden = true;
    els["categories-section"].hidden = true;
    els["results-section"].hidden = true;
    els["detail-section"].hidden = true;
    els["soon-section"].hidden = true;
    els["skills-section"].hidden = false;
    updateNav();
    window.scrollTo(0, 0);
  }

  /* Honest placeholders: prompts wait on the D3 prompt-text decision,
     agents wait on the licence checks. Counts are 0, never promised. */
  var SOON_COPY = {
    prompts: {
      title: "Prompts — coming soon",
      body: "Prompts are not published yet. The collection has been measured (about 1.37 million verified image prompts, mostly CC0), but the prompt-text decision is still open: whether the prompt text itself is shown on the site. Nothing is published until that call is made. 0 prompts shipped in this build."
    },
    agents: {
      title: "Agents — coming soon",
      body: "Agents are not published yet. The registry sample showed only 22% of servers have a resolvable licence, so the licence checks (including the npm/pypi metadata sample) come first. 0 agents shipped in this build."
    }
  };

  function showSoon(type) {
    currentView = "soon";
    soonType = type;
    list = null;
    setSearchType("repo");
    var copy = SOON_COPY[type] || SOON_COPY.prompts;
    els["soon-title"].textContent = copy.title;
    els["soon-body"].textContent = copy.body;
    els.hero.hidden = true;
    els["home-sections"].hidden = true;
    els["categories-section"].hidden = true;
    els["results-section"].hidden = true;
    els["detail-section"].hidden = true;
    els["skills-section"].hidden = true;
    els["soon-section"].hidden = false;
    updateNav();
    window.scrollTo(0, 0);
  }

  function openSkillCategory(slug) {
    hideError();
    var cat = skillsCategoryBySlug(slug);
    if (!cat) { showError("Skill category not found: " + slug); return; }
    currentView = "skill-category";
    setSearchType("skill");
    list = newListState("category", "skillcat:" + slug, "skill");
    list.slug = slug;
    var token = viewToken;
    showResults(cat.name, "Loading…");
    els["filter-bar"].hidden = true;
    els.results.innerHTML = '<p class="muted">Loading skills…</p>';
    els.pager.innerHTML = "";
    loadCategory(slug, "skill").then(function (records) {
      if (token !== viewToken) return;
      list.items = records.map(function (r) { return itemFromRecord(r, slug); });
      list.baseCount = records.length;
      list.contextRecords = records;
      populateFilterOptions();
      els["filter-bar"].hidden = false;
      renderList();
    }).catch(function (err) {
      if (token !== viewToken) return;
      showError("Could not load this skill category. Check the connection and try again. (" + err.message + ")");
      els.results.innerHTML = "";
      els["results-meta"].textContent = "";
    });
  }

  function openCategory(slug) {
    hideError();
    var cat = categoryBySlug(slug);
    if (!cat) { showError("Category not found: " + slug); return; }
    currentView = "category";
    list = newListState("category", "cat:" + slug, "repo");
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

  /* ---------- name search: plain keyword matching, no model ---------- */

  /* Words that carry no meaning when someone types a question. Only used
     for multi-word queries; single-word searches keep the exact old
     behavior. Content-bearing words (open, source, free, new, app) are
     deliberately NOT on this list. */
  var STOP_WORDS = {};
  ["a", "an", "the",
   "i", "me", "my", "mine", "we", "us", "our", "ours", "you", "your", "yours",
   "he", "him", "his", "she", "her", "hers", "it", "its", "they", "them", "their", "theirs",
   "this", "that", "these", "those", "there", "here",
   "am", "is", "are", "was", "were", "be", "been", "being",
   "do", "does", "did", "doing", "done",
   "have", "has", "had", "having",
   "can", "could", "will", "would", "shall", "should", "may", "might", "must",
   "need", "needs", "needed", "needing", "want", "wants", "wanted", "wanting",
   "wish", "wishes", "like", "likes",
   "repo", "repos", "repository", "repositories",
   "help", "helps", "helping", "helped",
   "please", "find", "finds", "finding", "found",
   "show", "shows", "showing", "shown", "give", "gives", "giving", "given",
   "get", "gets", "getting", "got", "make", "makes", "making", "made",
   "build", "builds", "building", "built", "create", "creates", "creating", "created",
   "use", "uses", "using", "used", "work", "works", "working", "worked",
   "run", "runs", "running",
   "to", "for", "with", "of", "in", "on", "at", "by", "from", "about",
   "into", "over", "under", "after", "before", "between", "through", "without", "within",
   "and", "or", "but", "if", "then", "than", "so", "as", "because",
   "what", "which", "who", "whom", "whose", "when", "where", "why", "how",
   "any", "some", "all", "every", "each", "no", "not", "only", "just",
   "very", "really", "much", "many", "more", "most",
   "one", "something", "anything", "everything", "nothing", "thing", "things", "way", "able",
   "don", "isn", "aren", "wasn", "weren", "doesn", "didn", "won", "wouldn",
   "shouldn", "haven", "hasn", "hadn", "ain", "couldn", "mustn", "needn"
  ].forEach(function (w) { STOP_WORDS[w] = true; });

  function searchWords(q) {
    return q.toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w.length > 0; });
  }

  function isQuestionLike(q, words) {
    if (q.indexOf("?") !== -1) return true;
    if (words.length >= 3) return true;
    var qw = { what: 1, how: 1, which: 1, who: 1, whom: 1, whose: 1, when: 1,
               where: 1, why: 1, need: 1, needs: 1, want: 1, wants: 1 };
    for (var i = 0; i < words.length; i++) if (qw[words[i]]) return true;
    return false;
  }

  /* Plain keyword matching over repo names. Single-word queries keep the
     exact old behavior (whole-string substring match). Multi-word queries
     match the key words: names containing ALL key words, falling back to
     names containing ANY key word when no name has them all. */
  function matchSearchEntries(entries, q) {
    var words = searchWords(q);
    var needle = q.toLowerCase();
    function wholeString(e) { return e.n.toLowerCase().indexOf(needle) !== -1; }
    if (words.length <= 1) {
      return { matches: entries.filter(wholeString), mode: "exact", terms: null };
    }
    var seen = {}, terms = [];
    words.forEach(function (w) {
      if (w.length < 2 || STOP_WORDS[w] || seen[w]) return;
      seen[w] = true;
      terms.push(w);
    });
    if (!terms.length) {
      return { matches: entries.filter(wholeString), mode: "exact", terms: null };
    }
    var all = entries.filter(function (e) {
      var n = e.n.toLowerCase();
      for (var i = 0; i < terms.length; i++) if (n.indexOf(terms[i]) === -1) return false;
      return true;
    });
    if (all.length) return { matches: all, mode: "all", terms: terms };
    var any = entries.filter(function (e) {
      var n = e.n.toLowerCase();
      for (var i = 0; i < terms.length; i++) if (n.indexOf(terms[i]) !== -1) return true;
      return false;
    });
    return { matches: any, mode: "any", terms: terms };
  }

  function searchLoadingHtml(status) {
    return '<div class="search-loading" role="status" aria-live="polite">' +
      '<span class="spinner" aria-hidden="true"></span>' +
      '<span class="search-loading-text">' + esc(status) + "</span></div>";
  }

  function setSearchStatus(status) {
    var el = els.results.querySelector(".search-loading-text");
    if (el) el.textContent = status;
  }

  /* Honest note for question-like queries: no LLM or Laya runs in this
     site yet, and the note says so. */
  function showQuestionHint(terms, mode, type) {
    var note = els["search-note"];
    var kind = type === "skill" ? "skill" : "repo";
    var text = "Question understanding with LLM + Laya is coming soon — it is not running in this search yet. " +
      "Right now search matches " + kind + " names only, so these are the closest name matches";
    if (terms && terms.length) {
      text += " for the key words in your question: " +
        terms.map(function (t) { return "“" + t + "”"; }).join(", ");
    }
    text += ".";
    if (mode === "any") {
      text += " No " + kind + " name contains all of those words, so these match at least one of them.";
    }
    note.textContent = text;
    note.hidden = false;
  }

  /* Zero-match search: say why, in plain words, and offer a way forward.
     Only used when the search itself matched nothing; filter-narrowed
     empty lists keep the existing "current filters" message. */
  function renderEmptySearch(container) {
    var q = list.query || "";
    var terms = list.searchTerms;
    var mode = list.matchMode;
    var kind = list.type === "skill" ? "skill" : "repo";
    var why;
    if (terms && terms.length) {
      var quoted = terms.map(function (t) { return "“" + t + "”"; });
      why = mode === "any"
        ? "No " + kind + " name contains any of " + quoted.join(", ") + "."
        : "No " + kind + " name contains all of " + quoted.join(", ") + ".";
    } else {
      why = "No " + kind + " name contains “" + q + "”.";
    }
    var box = document.createElement("div");
    box.className = "empty-search";
    var head = document.createElement("p");
    head.innerHTML = "<b>" + esc(why) + "</b>";
    var body = document.createElement("p");
    body.textContent = list.type === "skill"
      ? "Search matches skill names only. Try fewer words, a skill name such as “frontend-design”, or browse the skills categories instead."
      : "Search matches repo names only. Try fewer words, a repo name such as “fastapi”, or browse the categories instead.";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cta-button";
    if (list.type === "skill") {
      btn.textContent = "Browse all skills categories →";
      btn.addEventListener("click", function () { navigate("#/skills"); });
    } else {
      btn.textContent = "Browse all categories →";
      btn.addEventListener("click", function () { navigate("#/categories"); });
    }
    box.appendChild(head);
    box.appendChild(body);
    box.appendChild(btn);
    container.appendChild(box);
  }

  function openSearch(query, type) {
    hideError();
    var q = (query || "").trim();
    if (!q) {
      showError("Type something to search.");
      return;
    }
    type = type || "repo";
    currentView = type === "skill" ? "skill-search" : "search";
    setSearchType(type);
    list = newListState("search", "search:" + type + ":" + q, type);
    list.query = q;
    var questionLike = isQuestionLike(q, searchWords(q));
    var token = viewToken;
    showResults('Search: "' + q + '"', "Searching…");
    els["filter-bar"].hidden = true;
    els.results.innerHTML = searchLoadingHtml("Loading the name index…");
    els.pager.innerHTML = "";
    loadAllShards(type).then(function (entries) {
      if (token !== viewToken) return null;
      /* Yield so the staged status paints before the synchronous match. */
      setSearchStatus("Matching names…");
      return new Promise(function (resolve) {
        setTimeout(function () { resolve(entries); }, 0);
      });
    }).then(function (entries) {
      if (!entries || token !== viewToken) return;
      var found = matchSearchEntries(entries, q);
      list.items = found.matches.map(itemFromEntry);
      list.baseCount = found.matches.length;
      list.searchTerms = found.terms;
      list.matchMode = found.mode;
      if (questionLike) showQuestionHint(found.terms, found.mode, type);
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

  function goDetail(slug, name, stars, file, context, type) {
    if (currentView !== "detail" && currentView !== "skill-detail") {
      detailReturnHash = location.hash || "#/";
    }
    detailHints = { slug: slug, name: name, stars: stars, file: file,
                    context: context, type: type || "repo" };
    var base = (type === "skill") ? "#/skill-detail/" : "#/detail/";
    navigate(base + slug + "/" + encodeURIComponent(name));
  }

  function showDetailLoading(name, type) {
    currentView = type === "skill" ? "skill-detail" : "detail";
    list = null;
    setSearchType(type === "skill" ? "skill" : "repo");
    updateNav();
    els.hero.hidden = true;
    els["home-sections"].hidden = true;
    els["categories-section"].hidden = true;
    els["results-section"].hidden = true;
    els["skills-section"].hidden = true;
    els["soon-section"].hidden = true;
    els["detail-section"].hidden = false;
    els["detail-title"].textContent = name || "Record details";
    els.detail.innerHTML = '<p class="muted">Loading record…</p>';
    els["related-heading"].hidden = true;
    els.related.innerHTML = "";
    window.scrollTo(0, 0);
  }

  function openDetailByRoute(slug, name, type) {
    hideError();
    type = type || "repo";
    var hints = detailHints;
    detailHints = null;
    if (hints && hints.slug === slug && hints.name === name && hints.context) {
      var rec = findInRecords(hints.context, name, hints.stars);
      if (rec) { renderDetail(rec, hints.context, slug, type); return; }
    }
    showDetailLoading(name, type);
    var token = viewToken;
    function fromCategory() {
      loadCategory(slug, type).then(function (records) {
        if (token !== viewToken) return;
        var found = findInRecords(records, name, hints ? hints.stars : null);
        if (!found) {
          els.detail.innerHTML = '<p class="muted">Record not found in its data file.</p>';
          return;
        }
        renderDetail(found, records, slug, type);
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
        if (found) { renderDetail(found, records, slug, type); return; }
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
    if (recIsSkill(r)) {
      var srows = [];
      srows.push("<dt>Category</dt><dd>" + esc(r.category || "—") + "</dd>");
      srows.push("<dt>Subcategory</dt><dd>" + esc(r.subcategory || "—") + "</dd>");
      srows.push("<dt>Compatible agents</dt><dd>" + esc((r.compatible_agents || []).join(", ") || "—") + "</dd>");
      srows.push("<dt>Installs</dt><dd>" + (r.installs != null ? fmt(r.installs) : "Not published") + "</dd>");
      srows.push("<dt>Word count</dt><dd>" + (r.word_count != null ? fmt(r.word_count) : "—") + "</dd>");
      srows.push("<dt>Files</dt><dd>" + (r.file_count != null ? fmt(r.file_count) : "—") + "</dd>");
      srows.push("<dt>License</dt><dd>" + esc(r.license || "—") + "</dd>");
      srows.push("<dt>Last updated</dt><dd>" + esc(r.last_updated || "—") + "</dd>");
      var stags = (r.tags || []).map(function (t) {
        return '<span class="tag-chip">' + esc(t) + "</span>";
      }).join("");
      srows.push("<dt>Tags</dt><dd>" + (stags || "—") + "</dd>");
      return '<p class="detail-name">' + esc(r.name) + "</p>" +
        '<p class="detail-stats">' + esc(r.category || "") + "</p>" +
        "<dl>" + srows.join("") + "</dl>";
    }
    var rows = [];
    rows.push("<dt>Category</dt><dd>" + esc(r.category || "—") + "</dd>");
    var who = contributorOf(r);
    if (who) rows.push("<dt>Contributed by</dt><dd>" + esc(who) + "</dd>");
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
    return '<p class="detail-name">' + esc(r.repo) + communityBadgeHtml(r) + "</p>" +
      '<p class="detail-stats">★ ' + fmt(r.stars) + " · " + fmt(r.forks) + " forks</p>" +
      "<dl>" + rows.join("") + "</dl>";
  }

  function renderDetail(r, context, slug, type) {
    var skill = type === "skill" || recIsSkill(r);
    currentView = skill ? "skill-detail" : "detail";
    list = null;
    updateNav();
    els.hero.hidden = true;
    els["home-sections"].hidden = true;
    els["categories-section"].hidden = true;
    els["results-section"].hidden = true;
    els["skills-section"].hidden = true;
    els["soon-section"].hidden = true;
    els["detail-section"].hidden = false;
    els["detail-title"].textContent = recName(r);
    els.detail.innerHTML = detailHtml(r);
    var catBtn = document.createElement("button");
    catBtn.type = "button";
    catBtn.className = "link-button";
    catBtn.textContent = "See all in " + (r.category || (skill ? skillsCategoryName(slug) : categoryName(slug))) + " →";
    catBtn.addEventListener("click", function () {
      navigate((skill ? "#/skill-category/" : "#/category/") + slug);
    });
    var wrap = document.createElement("p");
    wrap.appendChild(catBtn);
    els.detail.appendChild(wrap);

    /* Skills have no subcategories: related = same category, alphabetical.
       Repos keep the existing subcategory + stars behaviour. */
    var related;
    if (skill) {
      related = (context || []).filter(function (o) { return o !== r; })
        .sort(function (a, b) { return nameCmp(itemFromRecord(a, slug), itemFromRecord(b, slug)); })
        .slice(0, RELATED_LIMIT);
    } else {
      related = (context || []).filter(function (o) {
        return o.subcategory && o.subcategory === r.subcategory &&
          !(o.repo === r.repo && o.stars === r.stars);
      }).sort(function (a, b) { return (b.stars - a.stars); }).slice(0, RELATED_LIMIT);
    }
    els.related.innerHTML = "";
    if (related.length) {
      els["related-heading"].hidden = false;
      els["related-heading"].textContent = skill
        ? "Related skills — " + (r.category || skillsCategoryName(slug))
        : "Related repos — " + r.subcategory;
      related.forEach(function (o) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "row";
        btn.innerHTML = rowHtml(itemFromRecord(o, slug));
        btn.addEventListener("click", function () {
          goDetail(slug, recName(o), recScore(o), null, context, skill ? "skill" : "repo");
        });
        els.related.appendChild(btn);
      });
    } else {
      els["related-heading"].hidden = true;
      els.related.innerHTML = skill
        ? '<p class="muted">No other skills in this category.</p>'
        : '<p class="muted">No other repos in this subcategory.</p>';
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
        var pickWho = contributorOf(p);
        b.innerHTML = '<span class="badge">Trending · #' + (i + 1) + "</span>" +
          communityBadgeHtml(p) +
          '<span class="pick-name">' + esc(p.repo) + "</span>" +
          '<span class="pick-meta"><span class="stars">★ ' + fmt(p.stars) + "</span> · " + esc(p.category) +
          (pickWho ? " · Contributed by " + esc(pickWho) : "") + "</span>";
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

    /* About-the-catalog counts, from the manifest — never hardcoded. */
    els["about-total"].textContent = fmt(manifest.total);
    els["about-cats"].textContent = fmt(manifest.categories.length);
    els["about-langs"].textContent = manifest.languages_count != null ? fmt(manifest.languages_count) : "—";
    els["about-build-date"].textContent = manifest.generated_at || "—";

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

    /* Type tabs: live counts from the manifest, never hardcoded. */
    els["tab-count-repos"].textContent = fmt(manifest.total);
    els["tab-count-skills"].textContent = manifest.skills ? fmt(manifest.skills.total) : "—";
    els["tab-count-prompts"].textContent = manifest.types && manifest.types.prompts
      ? fmt(manifest.types.prompts.total) + " · coming soon" : "0 · coming soon";
    els["tab-count-agents"].textContent = manifest.types && manifest.types.agents
      ? fmt(manifest.types.agents.total) + " · coming soon" : "0 · coming soon";

    /* Skills category grid for the #/skills view (rendered once at boot,
       like the repo grid above). */
    var scats = manifest.skills
      ? manifest.skills.categories.slice().sort(function (a, b) { return b.count - a.count; })
      : [];
    els["skills-grid"].innerHTML = "";
    scats.forEach(function (c) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "category-card";
      b.innerHTML = '<span class="cat-name">' + esc(c.name) + "</span>" +
        '<span class="cat-count">' + fmt(c.count) + " skills</span>";
      b.addEventListener("click", function () {
        navigate("#/skill-category/" + c.slug);
      });
      els["skills-grid"].appendChild(b);
    });
    els["skills-note"].textContent = scats.length
      ? fmt(scats.length) + " skill categories, " + fmt(manifest.skills.total) +
        " skills. Listings are alphabetical — no installs data is published yet, so nothing here is ranked by popularity."
      : "No skills in this build.";

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
    goDetail(e.c, e.n, e.s, e.f, null, searchType);
  }

  function runSuggest() {
    var q = els["search-input"].value.trim();
    if (!q) { hideSuggest(); return; }
    var token = ++suggestToken;
    var needle = q.toLowerCase();
    loadShard(shardFor(q), searchType).then(function (entries) {
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
        var sLabel = searchType === "skill"
          ? esc(skillsCategoryName(e.c)) + (e.s > 0 ? " · " + fmt(e.s) + " installs" : "")
          : esc(categoryName(e.c)) + " · ★ " + fmt(e.s);
        b.innerHTML = "<span>" + esc(e.n) + "</span>" +
          '<span class="suggest-cat">' + sLabel + "</span>";
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

  function scrollToContribute() {
    var section = els["contribute-section"];
    if (!section) return;
    section.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(function () {
      if (els["contrib-username"]) els["contrib-username"].focus({ preventScroll: true });
    }, 450);
  }

  function route() {
    viewToken++;
    var hash = location.hash || "";
    var catMatch = hash.match(/^#\/category\/([a-z0-9-]+)\/?$/);
    var categoriesMatch = hash.match(/^#\/categories\/?$/);
    var contributeMatch = hash.match(/^#\/contribute\/?$/);
    var searchMatch = hash.match(/^#\/search\/(.+)$/);
    var detailMatch = hash.match(/^#\/detail\/([a-z0-9-]+)\/(.+)$/);
    var skillsMatch = hash.match(/^#\/skills\/?$/);
    var skillCatMatch = hash.match(/^#\/skill-category\/([a-z0-9-]+)\/?$/);
    var skillSearchMatch = hash.match(/^#\/skills\/search\/(.+)$/);
    var skillDetailMatch = hash.match(/^#\/skill-detail\/([a-z0-9-]+)\/(.+)$/);
    var promptsMatch = hash.match(/^#\/prompts\/?$/);
    var agentsMatch = hash.match(/^#\/agents\/?$/);
    if (catMatch) {
      openCategory(catMatch[1]);
    } else if (categoriesMatch) {
      showCategories();
    } else if (contributeMatch) {
      showHome();
      scrollToContribute();
    } else if (searchMatch) {
      var q = "";
      try { q = decodeURIComponent(searchMatch[1]); } catch (e) { q = searchMatch[1]; }
      els["search-input"].value = q;
      openSearch(q, "repo");
    } else if (detailMatch) {
      var name = "";
      try { name = decodeURIComponent(detailMatch[2]); } catch (e) { name = detailMatch[2]; }
      openDetailByRoute(detailMatch[1], name, "repo");
    } else if (skillsMatch) {
      showSkills();
    } else if (skillCatMatch) {
      openSkillCategory(skillCatMatch[1]);
    } else if (skillSearchMatch) {
      var sq = "";
      try { sq = decodeURIComponent(skillSearchMatch[1]); } catch (e) { sq = skillSearchMatch[1]; }
      els["search-input"].value = sq;
      openSearch(sq, "skill");
    } else if (skillDetailMatch) {
      var sname = "";
      try { sname = decodeURIComponent(skillDetailMatch[2]); } catch (e) { sname = skillDetailMatch[2]; }
      openDetailByRoute(skillDetailMatch[1], sname, "skill");
    } else if (promptsMatch) {
      showSoon("prompts");
    } else if (agentsMatch) {
      showSoon("agents");
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
    navigate((searchType === "skill" ? "#/skills/search/" : "#/search/") + encodeURIComponent(q));
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
    if (list.type === "skill") list.filters.sort = "name";
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
  els["soon-back"].addEventListener("click", function () {
    navigate("#/");
  });
  els["nav-contribute"].addEventListener("click", function () {
    navigate("#/contribute");
  });
  window.addEventListener("hashchange", route);

  /* ---------- contribute form: build + copy only, nothing is sent ---------- */

  function contribEntry(name, catName, why, tags, username) {
    var lines = [];
    lines.push("Suggested repo: " + name);
    lines.push("Category: " + catName);
    lines.push("Contributed by: " + username);
    lines.push("Why it is useful: " + (why || "—"));
    lines.push("Tags: " + (tags || "—"));
    lines.push("Suggested via the dev-marketplace contribute form.");
    return lines.join("\n");
  }

  els["contrib-form"].addEventListener("submit", function (ev) {
    ev.preventDefault();
    var username = els["contrib-username"].value.trim();
    var name = els["contrib-name"].value.trim();
    var slug = els["contrib-category"].value;
    var why = els["contrib-why"].value.trim();
    var tags = els["contrib-tags"].value.trim().replace(/\s*,\s*/g, ", ");
    var err = els["contrib-error"];
    if (!username) {
      err.textContent = "Enter your name or username.";
      err.hidden = false;
      els["contrib-username"].focus();
      return;
    }
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
    els["contrib-output"].textContent = contribEntry(name, categoryName(slug), why, tags, username);
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
    els["skills-grid"].innerHTML = "";
    els["cat-glance"].innerHTML = "";
    showError("Could not load the catalog data files. Serve this folder with a local static file server and reload. (" + err.message + ")");
  });
})();
