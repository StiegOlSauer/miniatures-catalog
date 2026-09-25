// Every import below (and the <script>/<link> tags in index.html) carries a
// "?v=N" cache-busting suffix. Bump N everywhere it appears whenever any
// docs/js/*.js or docs/style.css file changes — otherwise a browser with an
// old copy cached can run mismatched old/new files together and crash. See
// HOSTING.md's troubleshooting section.
import { loadCatalog } from "./data.js?v=7";
import { buildIndex, buildSuggestionSource } from "./catalogIndex.js?v=7";
import { renderGallery, applyFilters, getVisibleModelIds } from "./gallery.js?v=7";
import { applyFilterFromButton } from "./filter.js?v=7";
import { initSearch } from "./search.js?v=7";
import { initDialog } from "./dialog.js?v=7";
import { initList } from "./list.js?v=7";

// Keeps --header-h in sync with the sticky header's real height (it wraps
// to more lines at narrow widths), so the docked shopping-list sidebar can
// size itself to exactly the remaining viewport instead of overflowing it.
function trackHeaderHeight() {
  const header = document.querySelector(".site-header");
  const sync = () => document.documentElement.style.setProperty("--header-h", `${header.offsetHeight}px`);
  sync();
  if (window.ResizeObserver) new ResizeObserver(sync).observe(header);
  else window.addEventListener("resize", sync);
}

async function main() {
  trackHeaderHeight();
  const catalog = await loadCatalog();
  catalog.modelsById = new Map(catalog.models.map((m) => [m.id, m]));
  const index = buildIndex(catalog);
  const suggestionSource = buildSuggestionSource(catalog, index);

  const ctx = {
    catalog,
    index,
    suggestionSource,
    state: { chips: [], text: "" },
    getVisibleModelIds,
  };

  renderGallery(document.getElementById("gallery"), catalog);

  const dialogApi = initDialog(ctx);
  ctx.openDialog = dialogApi.open;

  initList(ctx, dialogApi); // sets ctx.list

  const searchApi = initSearch(ctx);
  ctx.refresh = () => {
    const { visibleModels } = applyFilters(catalog, ctx.state);
    ctx.lastVisibleModels = visibleModels;
    searchApi.sync();
  };
  ctx.refresh();

  // Gallery clicks: the add-to-list button and filter buttons (origin, kind,
  // size, location, tags) stop the click from also opening the popup.
  const galleryEl = document.getElementById("gallery");
  galleryEl.addEventListener("click", (e) => {
    const addBtn = e.target.closest('[data-action="add"]');
    if (addBtn) {
      e.stopPropagation();
      ctx.list.toggle(addBtn.dataset.id);
      return;
    }
    const filterBtn = e.target.closest("[data-filter]");
    if (filterBtn) {
      e.stopPropagation();
      applyFilterFromButton(ctx, filterBtn);
      return;
    }
    const tile = e.target.closest(".tile");
    if (tile) {
      const model = catalog.modelsById.get(tile.dataset.id);
      if (model) ctx.openDialog(model, getVisibleModelIds());
    }
  });
  galleryEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.classList.contains("tile")) {
      // Without this, Chromium's default Enter-activation for role="button"
      // fires a synthetic click after showModal() has already moved focus
      // into the dialog, landing on the close button and closing it again.
      e.preventDefault();
      const model = catalog.modelsById.get(e.target.dataset.id);
      if (model) ctx.openDialog(model, getVisibleModelIds());
    }
  });
}

main().catch((err) => {
  console.error(err);
  document.getElementById("gallery").textContent = "Failed to load catalog data. See the console for details.";
});
