// Builds the tile grid once, then just toggles [hidden] on filter changes
// instead of re-rendering (see SPEC.md §4.10).

import { escapeHtml, tileHTML } from "./render.js?v=8";
import { matchesModel, tokenize } from "./filter.js?v=8";

export function renderGallery(container, catalog) {
  const groups = new Map(); // origin -> models, in first-seen order
  for (const m of catalog.models) {
    if (!groups.has(m.origin)) groups.set(m.origin, []);
    groups.get(m.origin).push(m);
  }
  let html = "";
  for (const [origin, models] of groups) {
    html += `<section class="origin-section" data-origin="${escapeHtml(origin)}">
      <h2 class="origin-header">${escapeHtml(origin) || "Unspecified origin"} <span class="n" data-role="section-count"></span></h2>
      <div class="tile-grid">${models.map((m) => tileHTML(m, catalog.tagFamilies)).join("")}</div>
    </section>`;
  }
  container.innerHTML = html;
}

export function applyFilters(catalog, state) {
  const textTokens = tokenize(state.text);
  const gallery = document.getElementById("gallery");
  const resultCount = document.getElementById("result-count");
  let visibleModels = 0;
  let visibleMinis = 0;

  for (const section of gallery.querySelectorAll(".origin-section")) {
    let sectionVisible = 0;
    for (const tile of section.querySelectorAll(".tile")) {
      const model = catalog.modelsById.get(tile.dataset.id);
      const match = matchesModel(model, state.chips, textTokens);
      tile.hidden = !match;
      if (match) {
        sectionVisible++;
        visibleModels++;
        visibleMinis += model.quantity;
      }
    }
    section.hidden = sectionVisible === 0;
    const countEl = section.querySelector('[data-role="section-count"]');
    if (countEl) countEl.textContent = `(${sectionVisible})`;
  }

  resultCount.textContent = `${visibleModels} of ${catalog.models.length} models · ${visibleMinis} miniatures`;
  return { visibleModels, visibleMinis };
}

export function getVisibleModelIds() {
  return [...document.querySelectorAll("#gallery .tile:not([hidden])")].map((t) => t.dataset.id);
}
