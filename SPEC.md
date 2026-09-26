# Miniatures Catalog — Implementation Spec

A read-only, single-page catalog of a TTRPG miniature collection, hosted on GitHub Pages.
The owner and a few friends use it to browse models by photo, filter by origin/kind/tags/size/location,
and collect a "shopping list" of models to pull from physical storage.

This document is the full spec. Implement exactly this; where something is unspecified, choose the
simplest option that satisfies the use cases in §2.

---

## 1. Overview & constraints

- **Two deliverables:**
  1. `tools/build.py`: a Python script that turns the spreadsheet plus a folder of photos into static site data
     (`docs/data.json`, full-size images, thumbnails).
  2. The static site in `docs/` (`index.html`, CSS, JS). GitHub Pages serves the `docs/` folder of `main`.
- **No frameworks, no bundler, no npm, no CDN, no web fonts, no external requests at runtime.**
  Plain HTML + CSS + vanilla JS (ES modules allowed, e.g. `docs/js/*.js`). The site must work when served
  by any static file server.
- **Python:** 3.10+, standard library + **Pillow** only. Add `requirements.txt` with `Pillow`.
- **Read-only site:** nothing is editable. The spreadsheet is the single source of truth; every build fully
  regenerates `data.json` from it.
- **No user-specific defaults anywhere** in code: no hard-coded sheet URLs, usernames, home paths, or photo
  directories. All such inputs come from CLI arguments. The only default path allowed is the output
  directory, `docs/`, resolved relative to the repository root (the script's parent directory).
- Scale target: ~1000 models (500 minis + 500 standees), ~1000 photos.
- **Cache-busting:** every `docs/js/*.js` file, plus the `<link>`/`<script>` tags in `index.html`, references
  the others with a `?v=N` query suffix (e.g. `./render.js?v=7`). A plain static file server sends no cache
  headers, so without this a browser can keep running an old cached module against a newly-changed
  `index.html` (or vice versa) and crash on the mismatch. **Bump `N` everywhere it appears** whenever any
  `docs/js/*.js` file or `docs/style.css` changes — grep for the old number and replace every occurrence in
  the same commit.

### Repository layout (to create)

```
docs/                 ← published site (GitHub Pages source: main /docs)
  .nojekyll           ← written by build.py
  index.html
  style.css
  js/…                ← app modules
  data.json           ← generated
  images/full/*.jpg   ← generated
  images/thumbs/*.webp← generated
  images/manifest.json← generated (source hashes, see §3.5)
tools/build.py
requirements.txt
README.md             ← short: what it is + link to HOSTING.md
HOSTING.md            ← already exists; do not rewrite, only fix if commands change
```

---

## 2. Use cases (acceptance scenarios)

1. **"I need an army":** filter Origin = Undead → browse the gallery → add several models, each with a
   chosen quantity → open the shopping list → the list is grouped by storage location to guide physical
   pickup → print it / save it as PDF.
2. **"I need a skeleton archer":** type `skeleton archer` → the matching model shows → add it to the list.
3. **"Something roughly resembling…":** type `swo` → suggestion `sword` (tag) → pick it (it becomes a chip) →
   type `hum` → pick `Humans` (origin) → the gallery narrows after each pick.
4. **"Pick a boss":** click the `boss` tag on any tile → browse all bosses → open a popup to see the photo
   large → add one to the list.
5. **Inventory:** filter Storage = `Nefra` → see everything stored there.
6. **Friend shares a list:** a friend builds a list → copies the share link → the owner opens it and loads
   the list.

---

## 3. Build script — `tools/build.py`

### 3.1 CLI

```
python3 tools/build.py (--sheet-url URL | --csv FILE) --photos DIR [--out DIR] [--force]
```

| Arg | Required | Meaning |
|---|---|---|
| `--sheet-url` | one of the two | Google Sheets URL of the **Catalogue tab** (the browser URL while that tab is open; it contains `gid=`). |
| `--csv` | one of the two | Local CSV export of the Catalogue tab (for offline use and testing). |
| `--photos` | yes | Directory containing the source photos referenced in the `Image` column. |
| `--out` | no | Output directory. Default: `<repo root>/docs`. |
| `--force` | no | Regenerate all images even if unchanged. |

**Sheet download:** parse the spreadsheet ID (`/spreadsheets/d/<ID>/`) and `gid` (from `#gid=` or `?gid=`/`&gid=`)
from the URL, then fetch `https://docs.google.com/spreadsheets/d/<ID>/export?format=csv&gid=<GID>` with `urllib`.
- If there's no `gid` in the URL: fail with a message telling the user to open the Catalogue tab and copy the URL from the address bar.
- If the response is HTML instead of CSV, or the status isn't 200: fail with "Sheet is not accessible — set
  Share → General access → Anyone with the link → Viewer".

Read CSV as UTF-8 (`utf-8-sig`, so a BOM is tolerated).

### 3.2 Sheet format

The first row holds headers; each following row is one model. Header matching is case-insensitive and trims whitespace.

| Column | Required | Content |
|---|---|---|
| `Origin` | yes | Faction/origin, e.g. `Undead`. |
| `Kind` | yes | Creature kind within the origin, e.g. `Skeletons`. |
| `Name` | no | Individual name, e.g. `Archer`. May be blank. |
| `Size` | yes | Creature size: one of `S, M, L, XL, XXL, XXXL` (this order is the sort order). |
| `Base (mm)` | yes | Integer base size in mm; expected multiple of 25. |
| `Quantity` | yes | Positive integer: number of identical copies. |
| `Location` | yes | Physical storage place, e.g. `Nefra`, `CoD: AoW`, `WIP`. The sheet column, the internal chip type (`location`) and the `data.json` field all keep this name — only the on-screen label reads **"Storage"** (facet button, popup, grouping). |
| `Tags: <Family>` | any number | Each column whose header starts with `Tags:` is one tag family; the family label is the text after `Tags:` (trimmed). Cell = comma-separated tags. The column order defines the family order and colors. Current families: `Fiction`, `Class`, `Details`. |
| `Image` | no | File name of the photo in `--photos`, e.g. `undead_skeleton_archer.jpg`. |
| `Made by` | no | Free text for humans (manufacturer / product, may contain URLs). Not searchable, not filterable. |

Any other columns are ignored (list them once as an info line). Fully empty rows are skipped.

**Normalization:**
- Trim all cells and collapse internal runs of whitespace.
- Tags: split on commas, trim, **lowercase**, drop empties, de-duplicate within a model while keeping first-seen order.
- Size: uppercase.
- Missing required columns (header absent) → fatal error that lists them.

### 3.3 Model IDs

`id = slug(origin) + "-" + slug(kind) + ("-" + slug(name) if name else "")`, where `slug` lowercases, replaces
runs of non-`[a-z0-9]` with `-` and trims `-`. Duplicates get `-2`, `-3`, … in sheet order.
IDs are used for the shopping list (localStorage and share links). Renaming a model changes its ID; that's acceptable.

### 3.4 Validation (warnings, never fatal)

Collect warnings and print them grouped by category at the end, each with the sheet row number
(1-based, header = row 1) and model label. Finish with a summary line: `N models, M miniatures, X photos,
Y placeholders, Z warnings`.

- Required value blank (Origin, Kind, Size, Base, Quantity, Location). The model is still included: blank
  Quantity → 1, blank Size/Base/Location → shown as "—" on the site.
- Size not in the allowed set (keep the value; sort it last).
- Base not an integer or not a multiple of 25.
- Quantity not a positive integer.
- `Image` looks like a URL, or the file doesn't exist in `--photos` → the model gets a placeholder.
- Photos in `--photos` that no row references ("unused photos").
- **Near-duplicates:** for Origin, Kind, Location and each tag family, normalize values (lowercase, strip
  non-alphanumerics, strip one trailing `s`). If several distinct spellings share a key, warn with every spelling and its
  count (e.g. `Location: "IM: Base" (17), "IM:base" (8)`). Also warn if the same tag appears in more than one family.

Exit code 0 unless there's a fatal error (bad args, sheet not reachable, missing headers, photos dir missing).

### 3.5 Images

For each distinct referenced photo that exists:
- **Output name:** `slug(stem)`; `.jpg` for full, `.webp` for thumbnails. Warn on slug collisions.
- **Full:** apply EXIF orientation (`ImageOps.exif_transpose`), downscale so the long edge is ≤ 1600 px (never upscale),
  convert to RGB, save JPEG quality 85, progressive, **no metadata** (no EXIF). → `docs/images/full/<slug>.jpg`
- **Thumbnail:** from the oriented image, resize to 480 px wide (keep aspect ratio), WebP quality 72, no metadata.
  → `docs/images/thumbs/<slug>.webp`. Expected ~30–40 KB each.
- **Incremental:** `docs/images/manifest.json` maps source file name → SHA-256 of the source bytes (plus the output
  slug). Regenerate a photo's outputs only if the hash changed, an output is missing, or `--force` is set.
- **Cleanup:** delete files in `images/full/` and `images/thumbs/` that no current model references, and prune
  the manifest.
- Record the thumbnail's pixel `w`/`h` in `data.json` (so the site can reserve layout space).

Also write an empty `docs/.nojekyll`.

### 3.6 `docs/data.json`

Written with `indent=1` and `ensure_ascii=False` so git diffs stay readable.

```json
{
  "generated": "2026-09-26T12:00:00Z",
  "sizes": ["S", "M", "L", "XL", "XXL", "XXXL"],
  "tagFamilies": [
    {"id": "fiction", "label": "Fiction"},
    {"id": "class",   "label": "Class"},
    {"id": "details", "label": "Details"}
  ],
  "models": [
    {
      "id": "elves-rangers-taeral",
      "origin": "Elves",
      "kind": "Rangers",
      "name": "Taeral",
      "size": "M",
      "base": 25,
      "quantity": 1,
      "location": "Nefra",
      "tags": {"fiction": ["fantasy"], "class": ["hero", "ranger"], "details": ["falcon"]},
      "image": {"thumb": "images/thumbs/hero-taeral.webp", "full": "images/full/hero-taeral.jpg", "w": 480, "h": 544},
      "madeBy": "Ludic Dragon"
    }
  ]
}
```

- `models` keeps sheet order. `image` is `null` for placeholders. `base` is `null` if blank or invalid.
- The family `id` is `slug(label)`. Every family key is present in `tags` (empty array if none).

---

## 4. Site

### 4.1 Layout

**Header (sticky):**
- Title "Miniatures Catalog" (small, left).
- **Search combobox** (§4.3) taking most of the width, with active filter chips shown *inside* the field before the text cursor.
- A row of facet buttons: **Origin ▾**, **Size ▾**, **Storage ▾** (labeled "Storage" on screen; backed by the
  `Location` sheet column and `location` chip type, see §3.2). Each opens a popover with checkboxes and per-value
  model counts. Checking a box adds or removes the same chip as the search box does (there is a single filter state).
- **Clear all** (visible when any filter is active).
- A result counter: `42 of 271 models · 130 miniatures`.

**Gallery (main area):** a responsive grid (`repeat(auto-fill, minmax(200px, 1fr))`) of tiles in sheet order,
grouped under **origin section headers** (origin name + model count). A header is hidden when its origin has no
matches. There is no separate "nothing matches" panel in the gallery area — a zero-result state is reported by
the search combobox itself (§4.3), the same place every other search affordance already lives, rather than a
one-off block that only appears in this one situation.

**Shopping list sidebar (right):** see §4.6.

**Popup:** see §4.5.

### 4.2 Tile

Top to bottom:
1. **Thumbnail**: fixed aspect ratio 3:4, `object-fit: cover`, `loading="lazy"`, `decoding="async"`, `width`/`height`
   attributes from data, and `alt` = the model's full label. Placeholder models get a CSS placeholder (§4.8).
   Overlaid in the corner: a quantity badge `×6` and the **add-to-list button** (`+`; when the model is in the list it
   shows `✓ 2`, and clicking removes it).
2. **Title**: the Name in bold; if Name is blank, use the Kind. Below it, a small line `Origin › Kind` where **Origin and
   Kind are separate clickable filters**.
3. **Meta line**: size badge `M · 25 mm` (the size part is clickable → Size filter) and the storage location (clickable → Storage filter).
4. **Tags**: all tags as colored chips (family color, §4.7), each clickable → tag filter. Tiles don't clamp tags; tag
   counts are small.

Clicking a filterable element toggles that filter (adds it; if already active, removes it) and must **not** open the popup.
Clicking anywhere else on the tile opens the popup. Tiles are keyboard-focusable (Enter opens the popup), and
filter elements are real `<button>`s.

Call `e.preventDefault()` in the tile's Enter-key handler. Without it, Chromium's default Enter-activation for
`role="button"` elements fires a synthetic click *after* the handler runs — by which point `showModal()` has
already moved focus onto the dialog's close button, so that synthetic click lands there and immediately closes
the dialog you just opened.

### 4.3 Search & filters

**State:** an ordered list of chips `{type, value}` with `type ∈ origin | kind | size | location | tag:<familyId>`,
plus the free text currently typed in the input.

**Matching:**
- Chips of the same type (origin, kind, size, location) → **OR** within the type.
- Tag chips → **AND** (each must be present, in its family).
- Across types → **AND**.
- Free text: split on whitespace; **every token** must match the **start of a word** (case-insensitive) in the
  model's searchable text (origin, kind, name, all tags). Word boundaries are whitespace and punctuation.
  Example: `orc` matches "Orcs" but not "sorcerer"; `skeleton archer` matches Undead › Skeletons › Archer.
- Kind chips match the kind value across all origins (`Mages` = mages of every origin). Combine with an
  origin chip to narrow.

**Combobox behaviour:**
- Typing filters the gallery live (free-text rule above; debounce ~100 ms) **and** opens a suggestion list.
- Suggestions come from all origins, kinds, locations, sizes and tags whose value word-prefix-matches the **last**
  typed token (or the whole text). Rank prefix-of-value matches before word-prefix matches, then by model count.
  Show up to 12. Each row shows the value styled as its chip (tag family color, etc.), a small type label
  (`Origin`, `Kind`, `Storage`, `Size`, or the tag family label), and the number of models that have it.
  Hide values that are already active chips.
- ↑/↓ moves the highlight, Enter or click picks → the chip is added, the matched token is removed from the text,
  and focus stays in the input so the user can keep typing. Esc closes the list. Enter with nothing
  highlighted just closes the list (the free text stays as a filter).
- Backspace in an empty input removes the last chip. Each chip has an `×`.
- ARIA combobox pattern (`role="combobox"`, `aria-expanded`, `aria-activedescendant`, `role="listbox"`/`option`).
- **No-results notice:** whenever the current combination of chips and/or free text matches zero models,
  the dropdown shows a single row instead of suggestions: "No results found" plus a **Clear filters** button
  (clears chips and text, same as header Clear-all). This is the *only* place a zero-result state is
  reported — no separate panel in the gallery (§4.1). It applies regardless of how the zero-result state was
  reached (typed text, chips alone, or both), real autocomplete suggestions always take priority over it when
  both would otherwise apply, and — unlike the suggestion list — it is **not** dismissed by an outside click,
  since it's reporting status rather than offering a pick; it only goes away once the result count is no
  longer zero.
- **Clear-text button:** a small `✕` inside the input itself (after the text, before the input's right edge),
  visible only when the input has text. Clicking it clears just the typed text, leaving any picked chips alone
  — distinct from the header's Clear-all, which clears both.

Filters aren't persisted across reloads (the shopping list is).

### 4.4 Sorting

Sheet order only (it's already grouped by origin). No sort controls.

### 4.5 Popup (model details)

Use a native `<dialog>` (modal). Esc, the close button, or a click on the backdrop closes it.
- **Left/top:** the full image (`image.full`) fitted to the viewport (`object-fit: contain`), shown on the thumbnail
  first as a blurred-up placeholder, then swapped in when the full image loads. Clicking the image opens the full image file in a new tab.
  Placeholder models show the large placeholder.
- **Right/bottom:** Name (or Kind), `Origin › Kind` (clickable), a definition list: Size (`M`, clickable), Base
  (`25 mm`), Quantity, Storage (clickable), then tags grouped by family with the family label, then **Made by**
  (URLs turned into links with `target="_blank" rel="noopener"`).
- **List control:** if the model isn't in the list, an "Add to list" button. If it is, a quantity stepper `− 2 / 6 +` and "Remove".
- **Prev / Next** buttons and ←/→ keys move through the *currently filtered* models.
- Clicking a filter inside the popup applies it and closes the popup.

### 4.6 Shopping list

**Storage:** `localStorage["minicat.list.v1"] = {"<modelId>": qty, ...}`. On load, drop IDs that no longer exist
in `data.json` and clamp quantities to `[1, model.quantity]`; if anything was dropped, show a dismissible note
("2 models from your list are no longer in the catalog").

**Add:** default quantity **1**.

**Sidebar:**
- Hidden while the list is empty. When it becomes non-empty it slides in from the right. On wide screens (≥ 1100 px) it's docked
  (~340 px) and the gallery reflows; a collapse button turns it into a slim vertical tab showing just an arrow
  (no count — a number there gets flipped upside down along with the arrow, since the collapsed tab is
  rendered by rotating the button 180°). Collapsing is reset (back to expanded) whenever the list becomes
  empty, so it can't reopen collapsed later with everything — including Share/Print/Clear — hidden behind a
  strip that's easy to miss.
- On narrow screens it isn't docked: a floating button "List (N)" in the bottom-right opens it as a full-height overlay drawer.
- Docked, the sidebar must be sized to exactly the viewport height *below* the sticky header
  (`calc(100vh - <header height>)`), not a flat `100vh` — the header isn't at `y=0`, so a flat `100vh` box
  starting below it always extends past the actual bottom of the screen, silently pushing whatever comes last
  (originally the buttons, now the totals footer, see below) out of view. Track the header's real height (it
  wraps to more lines at narrow widths) in a CSS custom property, e.g. `--header-h`, kept in sync with a
  `ResizeObserver`. Also give the internal scrollable entries region `min-height: 0` — flex items default to
  `min-height: auto`, which can let a `flex: 1; overflow: auto` child grow past its computed size to fit its
  content instead of scrolling, overflowing the sidebar the same way.
- **Toolbar** (directly under the "Shopping list" heading, always visible without scrolling): buttons
  **Share link**, **Print / PDF**, **Clear** (with a confirm).
- **Content:** entries **grouped by Storage** (sorted alphabetically, blank location last as "No storage"), and within a
  group in sheet order. Each entry has a thumbnail (48 px), `Origin › Kind › Name`, size, a quantity stepper
  `− n / max +` (bounded 1…max; `−` at 1 is disabled, use the remove button instead), and a remove `×`. Clicking the
  thumbnail or name opens the popup.
- **Footer** (below the entries, at the bottom): totals only (`7 models · 15 miniatures`). Buttons live in the
  toolbar at the top instead, not here — that was a deliberate choice after testing: keeping the buttons
  reachable without scrolling matters more than keeping them next to the totals.

**Share link:**
- Format: `<site URL>#list=<id>:<qty>,<id>:<qty>,…` (IDs are `[a-z0-9-]`, so no escaping is needed).
- The Share button copies the URL with a three-step fallback chain, since each step can silently fail
  depending on context (secure-context requirements, permissions, an unfocused document, plain HTTP): try
  `navigator.clipboard.writeText`; if that rejects, fall back to the legacy
  `document.execCommand("copy")` (via a temporary off-screen `<textarea>`), which covers most of the cases the
  Clipboard API can't; only if *that* also fails, fall back to `window.prompt` with the URL selected. Show a
  brief "Link copied" toast whenever either of the first two succeeds.
- On load with a `#list=` hash: parse it, drop unknown IDs, clamp quantities. If the local list is empty → load it directly.
  Otherwise show a small dialog: "Load shared list (N models)?" with **Replace my list** / **Merge** (sum,
  clamped) / **Ignore**. Afterwards, remove the hash with `history.replaceState`.
- A same-page URL that differs only by its `#hash` does **not** reload the document (it's a fragment
  navigation per the HTML spec) — a share link opened in a tab that already has the site loaded won't trigger
  a fresh page load. Handle the `#list=` hash both on initial load **and** on a `hashchange` listener, so it's
  also picked up when the link is pasted into (or already-open in) that same tab.

**Print / PDF:** `window.print()` with a print stylesheet. In print mode, hide the entire app and show only a
print-specific list (render it into a hidden `#print-view` container before printing):
- Title "Miniatures list", the date, and totals.
- Grouped by Storage. Rows: an empty checkbox square (for ticking off while collecting), thumbnail (~40 px),
  `Origin › Kind › Name`, size/base, `qty picked / available`.
- Black text on white, no backgrounds, and page breaks avoided inside rows.

### 4.7 Visual design

The photos show **grey unpainted plastic in front of warm brown stone and wood** (average photo color ≈ `#726E66`). The UI
is a dark, warm "tavern / dungeon" theme that frames the photos without competing with them.
**Hard rule: no blue, purple, violet, indigo or teal anywhere** (including focus rings, links and selection color).

CSS custom properties (tune if needed, but keep the hues):

```css
--bg:          #1c1916;  /* soot / dark leather */
--surface:     #27221e;  /* tile, sidebar */
--surface-2:   #332c26;  /* hover, inputs */
--border:      #4a4038;
--text:        #ece2cf;  /* parchment */
--text-muted:  #b0a28b;
--accent:      #ad5424;  /* ember / rust: primary buttons, add-to-list (white text on it) */
--accent-2:    #d4a340;  /* brass: focus rings, highlights, links */
--ok:          #7d9a50;  /* moss: "in list" state */
--danger:      #a63d2f;
--photo-bg:    #3a342e;  /* behind thumbnails */
```

**Tag chips:** small rounded rectangles (radius 4 px, padding 1–2 px × 6 px, ~12 px font, medium weight) with a solid
background from the family palette and light text. Assign colors to families by column order:

| # | Background | Text | Name |
|---|---|---|---|
| 1 | `#8a6a1f` | `#fff3d6` | ochre |
| 2 | `#8e3a22` | `#ffe9df` | rust |
| 3 | `#4e6634` | `#eef5e2` | moss |
| 4 | `#6e2a2f` | `#fde6e8` | oxblood |
| 5 | `#6b6a2c` | `#f7f6dc` | olive |
| 6 | `#5b4a3c` | `#f3e9dd` | umber |

(If there are more families than colors, cycle through the list.) All pairs must meet WCAG AA contrast for small text; verify this.
- **Origin chip:** parchment background `#d8c9a8`, dark text `#2a221b`.
- **Kind:** outlined chip (1 px `--text-muted` border, transparent background).
- **Size / location:** plain text buttons with an underline on hover.
- **Active chips in the search field:** the same style plus an `×`.
- **`hero` and `boss` pop out:** regardless of which family they're tagged in (both are values within `Class`
  in the sample data), the tag values `hero` and `boss` (case-insensitive) get a **fixed** color instead of
  their family's, so they stand out from the rest of a tile's tags at a glance: `hero` → gold background
  `#e0ac1f`, dark text `#241d12`; `boss` → red background `#b3261e`, white text. Apply this override
  everywhere a tag chip is rendered — gallery tiles, the popup, active filter chips, and the search
  suggestion dropdown — via one shared helper, not four separate copies of the same lookup.

**Typography:** system fonts only. UI uses `system-ui, sans-serif`. Headings and the site title use a serif stack
(`"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif`).

**Details:**
- Tiles use `--surface` with a 1 px `--border`. On hover, lift them slightly and use an `--accent-2` border.
- Focus-visible rings are 2 px `--accent-2`.
- Links are `--accent-2`.
- Optional: a subtle stone-block texture made with CSS gradients on the header background (no image files).
- Any element toggled with the `hidden` attribute (tiles, sections, the sidebar, the toast, …) needs its own
  `display` to actually go away once you give it one. The browser's default `[hidden] { display: none }` rule
  is a *user-agent* stylesheet rule — any author rule with a `display` on that same element (e.g.
  `.placeholder-art { display: flex }`) wins over it regardless of specificity, because author styles always
  beat user-agent styles in the cascade. Fix this with one rule up front, `[hidden] { display: none !important; }`,
  rather than a `.foo[hidden] { display: none; }` override per component (easy to forget on a new one).

### 4.8 Placeholder (models without a photo)

Pure CSS, no image file:
- A stone-grey tile (`--photo-bg` with a faint brick pattern from `repeating-linear-gradient`).
- A centered ellipse representing the base, with its width scaled by base size (25 → 30 %, 50 → 45 %, 75 → 60 %, ≥100 → 75 % of the tile width).
- The caption "No photo yet".

Used in the tile, the popup and the list.

### 4.9 Responsiveness & accessibility

- It must be usable on a phone (≥ 360 px): the grid can drop to 2 columns (minmax 150 px), facet popovers
  become full-width sheets, and the sidebar becomes a drawer (§4.6).
  - The mobile popover is `position: fixed`. Give it an explicit `top` (e.g. anchored to the tracked
    `--header-h`, §4.6) — **not** `top: auto`. A fixed box with both `top` and `bottom` auto falls back to
    its normal-flow "static position", and at least mobile Firefox recomputes that while the page scrolls
    behind it, so the popover visibly drifts down the screen (and eventually off it) as you scroll the
    gallery with the popover still open.
- Everything must be operable by keyboard. Images need alt text, and icon-only buttons need `aria-label`s.
- Respect `prefers-reduced-motion`.

### 4.10 Performance

- Fetch `data.json` once. Render tiles from a template or string building; on filter changes, toggle `hidden` on existing
  tile nodes and section headers instead of rebuilding the DOM.
- Load only thumbnails in the gallery; full images load only in the popup.
- With ~1000 models, a filter update must feel instant (< 50 ms).

---

## 5. Out of scope

- No editing, accounts, backend, analytics or service worker.
- No image export of the list (Print / PDF covers it).
- No filter state in the URL.
- No sort controls.
- No external image URLs; models without a local photo use the placeholder.

---

## 6. Test data & verification

- **Sample data:** the owner will give you the path to a CSV in the §3.2 format and the photos directory (these are task
  inputs, not code defaults). Run:
  `python3 tools/build.py --csv <csv> --photos <photos dir>` and check the warnings list and summary. Then run it
  again and confirm no images are regenerated. Then delete one output thumbnail and confirm only it is regenerated.
- **Serve locally:** `python3 -m http.server -d docs 8000`.
- **Walk through** every scenario in §2, plus:
  - Word-prefix search: `orc` must not match "sorcerer".
  - Tag AND and origin OR.
  - Backspace chip removal.
  - Quantity clamping.
  - The list survives a reload.
  - A share link round-trips in a private window, including the Replace/Merge prompt — **and** in a tab that
    already has the site open (same-tab `hashchange`, no reload), not just a fresh tab.
  - The print preview shows only the list.
  - The layout works at a 375 px width.
  - No blue or purple anywhere.
  - A search or filter combination with zero matches shows the no-results notice under the search box, not a
    panel in the gallery; typing a valid prefix afterwards shows real suggestions instead.
  - `hero` and `boss` tags render in their fixed gold/red colors on a tile, in the popup, as an active filter
    chip, and in the suggestion dropdown.
  - With one item in the shopping list, every part of the sidebar (toolbar buttons at top, the entry, and the
    totals at the bottom) is visible without scrolling, at both a short (~700 px) and a tall (~1440 px)
    viewport height.
  - Collapse the sidebar, then clear the list down to empty and add something back — it must reopen expanded,
    not collapsed.
  - At a narrow width, open a facet popover and scroll the gallery behind it (a real device or its emulator —
    this doesn't reproduce in every engine): the popover must stay anchored below the header, not drift down
    or off the screen.
  - The "Storage" label appears everywhere the field is shown (facet button, popup, grouping, suggestion type
    label) even though the sheet column, chip type and `data.json` field are still named `location`/`Location`.
- Commit the generated `docs/` output along with the code.
- If this is a follow-up change to an already-deployed site rather than the first build, bump the `?v=N` suffix
  (§1) on every file you touched, everywhere that suffix appears.
