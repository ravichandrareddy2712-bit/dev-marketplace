# REPOVERSE public catalog build

Public, stripped, static build of the REPOVERSE catalog.
Build date: 2026-11-16. Build tag: public-stripped-v1.

Records in this public build: 323,195.
Categories: 37.

What this build shows: repo names plus category, subcategory, languages,
frameworks, tags, stars, forks, license, last updated, and archived flag.
What this build leaves out on purpose: owner names, descriptions, and
links. There are no links in this site at all.

Person-name filter: repo names that look like a first name plus a last
name were removed using a first-name list (400 names).
That filter is a heuristic. It removed 271 records. It
may remove a few ordinary repos and may miss some names. A further
752 records were removed because the repo name itself
is a hosting address (it contains a hosting domain). 1
other field values that contained a hosting domain or a link were
cleaned instead of dropping the record.

Files: index.html, app.js, style.css, and the data folder (manifest.json,
one data file per category, and name-index files). No file in the data
folder is larger than 10 MB. The site makes no requests outside its own
folder: system fonts only, no analytics, no outside services.

How to view it locally: serve this folder with a local static file
server and open the index page in a browser. Opening the index file
straight from disk may not load the data files in some browsers,
because of local-file rules, so a local server is the reliable way.
