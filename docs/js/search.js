// The search combobox (chips + free text + suggestions) and the Origin /
// Size / Location facet popovers. See SPEC.md §4.3.

import { escapeHtml, slugify, chipSpanHTML, debounce } from "./render.js?v=7";
import { hasChip, toggleChip } from "./filter.js?v=7";
import { getSuggestions } from "./catalogIndex.js?v=7";

export function initSearch(ctx) {
  const input = document.getElementById("search-input");
  const chipRow = document.getElementById("chip-row");
  const suggestList = document.getElementById("suggest-list");
  const clearAllBtn = document.getElementById("clear-all");
  const clearTextBtn = document.getElementById("search-clear");
  const facets = [...document.querySelectorAll(".facet")];

  let currentSuggestions = [];
  let highlightedIndex = -1;
  let noticeShown = false; // suggestList is showing "No results found", not real suggestions

  function renderChipRow() {
    chipRow.innerHTML = ctx.state.chips
      .map((c) => chipSpanHTML(c.type, c.value, ctx.catalog.tagFamilies, true))
      .join("");
  }

  chipRow.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove-chip]");
    if (!btn) return;
    ctx.state.chips = toggleChip(ctx.state.chips, btn.dataset.type, btn.dataset.value);
    ctx.refresh();
    input.focus();
  });

  function closeSuggestions() {
    suggestList.hidden = true;
    suggestList.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    currentSuggestions = [];
    highlightedIndex = -1;
    noticeShown = false;
  }

  function renderSuggestions(results) {
    currentSuggestions = results;
    highlightedIndex = -1;
    noticeShown = false;
    if (!results.length) {
      closeSuggestions();
      return;
    }
    suggestList.innerHTML = results
      .map(
        (item, i) => `
      <li class="suggest-item" role="option" id="suggest-opt-${i}" aria-selected="false">
        ${chipSpanHTML(item.type, item.value, ctx.catalog.tagFamilies, false)}
        <span class="suggest-type">${escapeHtml(item.typeLabel)}</span>
        <span class="suggest-count">${item.count}</span>
      </li>`
      )
      .join("");
    suggestList.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function updateSuggestions() {
    const tokens = input.value.trim().split(/\s+/).filter(Boolean);
    const lastToken = tokens.length ? tokens[tokens.length - 1].toLowerCase() : "";
    if (!lastToken) {
      if (!noticeShown) closeSuggestions(); // leave a currently-shown notice alone
      return;
    }
    renderSuggestions(getSuggestions(ctx.suggestionSource, lastToken, ctx.state.chips));
  }

  // Shows "No results found" in the same dropdown suggestions use, instead
  // of a separate block in the gallery — real typed suggestions always take
  // priority over it, since they're still actionable.
  function renderEmptyNotice() {
    currentSuggestions = [];
    highlightedIndex = -1;
    noticeShown = true;
    suggestList.innerHTML = `
      <li class="suggest-item suggest-empty" role="option" aria-selected="false">
        <span>No results found</span>
        <button type="button" class="btn" data-action="clear-notice">Clear filters</button>
      </li>`;
    suggestList.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function syncEmptyNotice() {
    if (ctx.lastVisibleModels > 0) {
      if (noticeShown) closeSuggestions();
      return;
    }
    if (currentSuggestions.length) return; // real suggestions are more useful
    renderEmptyNotice();
  }

  function moveHighlight(delta) {
    if (!currentSuggestions.length) return;
    const items = [...suggestList.children];
    if (highlightedIndex >= 0) items[highlightedIndex].setAttribute("aria-selected", "false");
    highlightedIndex = (highlightedIndex + delta + items.length) % items.length;
    items[highlightedIndex].setAttribute("aria-selected", "true");
    items[highlightedIndex].scrollIntoView({ block: "nearest" });
    input.setAttribute("aria-activedescendant", items[highlightedIndex].id);
  }

  function pickSuggestion(item) {
    ctx.state.chips = toggleChip(ctx.state.chips, item.type, item.value);
    const tokens = input.value.trim().split(/\s+/).filter(Boolean);
    tokens.pop();
    input.value = tokens.length ? `${tokens.join(" ")} ` : "";
    ctx.state.text = input.value;
    updateClearTextBtn();
    closeSuggestions();
    ctx.refresh();
    input.focus();
  }

  suggestList.addEventListener("click", (e) => {
    if (e.target.closest('[data-action="clear-notice"]')) {
      clearAll();
      return;
    }
    if (noticeShown) return; // the notice row itself isn't a pickable suggestion
    const li = e.target.closest(".suggest-item");
    if (!li) return;
    pickSuggestion(currentSuggestions[[...suggestList.children].indexOf(li)]);
  });

  function updateClearTextBtn() {
    clearTextBtn.hidden = !input.value;
  }

  const handleInput = debounce(() => {
    ctx.state.text = input.value;
    ctx.refresh();
    updateSuggestions();
    syncEmptyNotice(); // re-check with this keystroke's fresh suggestion state
  }, 100);
  input.addEventListener("input", () => {
    updateClearTextBtn();
    handleInput();
  });

  input.addEventListener("keydown", (e) => {
    if (!suggestList.hidden && currentSuggestions.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); moveHighlight(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); moveHighlight(-1); return; }
      if (e.key === "Enter") {
        if (highlightedIndex >= 0) { e.preventDefault(); pickSuggestion(currentSuggestions[highlightedIndex]); }
        else closeSuggestions();
        return;
      }
      if (e.key === "Escape") { closeSuggestions(); return; }
    }
    if (e.key === "Backspace" && input.value === "" && ctx.state.chips.length) {
      ctx.state.chips = ctx.state.chips.slice(0, -1);
      ctx.refresh();
    }
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest(".search-wrap")) return;
    if (!noticeShown) closeSuggestions(); // the notice is a status, not a transient dropdown
  });

  function clearAll() {
    ctx.state.chips = [];
    ctx.state.text = "";
    input.value = "";
    updateClearTextBtn();
    closeSuggestions();
    ctx.refresh();
    input.focus();
  }
  clearAllBtn.addEventListener("click", clearAll);

  clearTextBtn.addEventListener("click", () => {
    input.value = "";
    ctx.state.text = "";
    updateClearTextBtn();
    closeSuggestions();
    ctx.refresh();
    syncEmptyNotice();
    input.focus();
  });

  // --- Origin / Size / Location facet popovers -------------------------

  function closeAllFacets() {
    for (const f of facets) {
      f.querySelector(".facet-popover").hidden = true;
      f.querySelector(".facet-btn").setAttribute("aria-expanded", "false");
    }
  }

  function renderFacetPopover(type, pop) {
    const entries = [...ctx.index[type].entries()].filter(([v]) => v);
    if (type === "size") entries.sort((a, b) => ctx.catalog.sizes.indexOf(a[0]) - ctx.catalog.sizes.indexOf(b[0]));
    else entries.sort((a, b) => a[0].localeCompare(b[0]));

    pop.innerHTML = entries.length
      ? entries
          .map(([value, count]) => {
            const id = `facet-${type}-${slugify(value)}`;
            const checked = hasChip(ctx.state.chips, type, value) ? "checked" : "";
            return `<label class="facet-option" for="${id}">
              <input type="checkbox" id="${id}" data-type="${type}" data-value="${escapeHtml(value)}" ${checked}>
              <span>${escapeHtml(value)}</span>
              <span class="n">${count}</span>
            </label>`;
          })
          .join("")
      : "<p>No values.</p>";
  }

  for (const facetEl of facets) {
    const type = facetEl.dataset.facet;
    const btn = facetEl.querySelector(".facet-btn");
    const pop = facetEl.querySelector(".facet-popover");
    btn.addEventListener("click", () => {
      const wasOpen = !pop.hidden;
      closeAllFacets();
      if (!wasOpen) {
        renderFacetPopover(type, pop);
        pop.hidden = false;
        btn.setAttribute("aria-expanded", "true");
      }
    });
    pop.addEventListener("change", (e) => {
      const cb = e.target.closest('input[type="checkbox"]');
      if (!cb) return;
      ctx.state.chips = toggleChip(ctx.state.chips, cb.dataset.type, cb.dataset.value);
      ctx.refresh();
    });
  }

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".facet")) closeAllFacets();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAllFacets();
  });

  function updateFacetButtonStates() {
    for (const facetEl of facets) {
      const type = facetEl.dataset.facet;
      facetEl.querySelector(".facet-btn").classList.toggle("has-active", ctx.state.chips.some((c) => c.type === type));
    }
  }

  function sync() {
    renderChipRow();
    updateFacetButtonStates();
    updateClearTextBtn();
    syncEmptyNotice();
    clearAllBtn.hidden = !(ctx.state.chips.length || ctx.state.text.trim());
  }

  return { sync };
}
