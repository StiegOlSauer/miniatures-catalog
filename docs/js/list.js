// The shopping list: localStorage persistence, the sidebar, share links and
// the print view. See SPEC.md §4.6.

import { escapeHtml } from "./render.js?v=8";

const STORAGE_KEY = "minicat.list.v1";

function loadRaw() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function saveRaw(map) {
  const obj = {};
  for (const [id, qty] of map) obj[id] = qty;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // localStorage unavailable (private mode, quota, ...) — list just won't persist.
  }
}

function sanitize(map, catalog) {
  const clean = new Map();
  let dropped = 0;
  for (const [id, qty] of map) {
    const model = catalog.modelsById.get(id);
    if (!model) {
      dropped++;
      continue;
    }
    const max = model.quantity || 1;
    const q = Math.min(Math.max(1, Math.round(Number(qty)) || 1), max);
    clean.set(id, q);
  }
  return { clean, dropped };
}

function parseShareHash(hash, catalog) {
  const body = hash.slice("#list=".length);
  const map = new Map();
  for (const part of decodeURIComponent(body).split(",")) {
    if (!part) continue;
    const [id, qtyStr] = part.split(":");
    const model = catalog.modelsById.get(id);
    if (!model) continue;
    let qty = parseInt(qtyStr, 10);
    if (!Number.isFinite(qty)) qty = 1;
    map.set(id, Math.min(Math.max(1, qty), model.quantity || 1));
  }
  return map;
}

function buildShareHash(map) {
  return `#list=${[...map.entries()].map(([id, qty]) => `${id}:${qty}`).join(",")}`;
}

// navigator.clipboard needs a secure context and can reject even on HTTPS
// (e.g. document not focused); the legacy execCommand path covers those
// cases silently, so the prompt() fallback is only ever a last resort.
async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy method below
    }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

// Location -> [{model, qty}], blank location sorted last as "No storage".
function groupByLocation(map, catalog) {
  const groups = new Map();
  for (const model of catalog.models) {
    if (!map.has(model.id)) continue;
    const label = model.location || "";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push({ model, qty: map.get(model.id) });
  }
  const orderedKeys = [...groups.keys()].sort((a, b) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return a.localeCompare(b);
  });
  return orderedKeys.map((k) => [k, groups.get(k)]);
}

export function initList(ctx, dialogApi) {
  const sidebar = document.getElementById("list-sidebar");
  const collapseBtn = document.getElementById("list-collapse");
  const closeBtn = document.getElementById("list-close");
  const noteEl = document.getElementById("list-note");
  const entriesEl = document.getElementById("list-entries");
  const totalsEl = document.getElementById("list-totals");
  const shareBtn = document.getElementById("list-share");
  const printBtn = document.getElementById("list-print");
  const clearBtn = document.getElementById("list-clear");
  const fab = document.getElementById("list-fab");
  const fabCount = document.getElementById("list-fab-count");
  const toastEl = document.getElementById("toast");
  const shareDialog = document.getElementById("share-dialog");
  const shareDialogText = document.getElementById("share-dialog-text");
  const printView = document.getElementById("print-view");

  const { clean, dropped } = sanitize(new Map(Object.entries(loadRaw())), ctx.catalog);
  let map = clean;
  saveRaw(map);

  let pendingShared = null;

  function isDesktop() {
    return window.matchMedia("(min-width: 1100px)").matches;
  }

  function setCollapsed(collapsed) {
    sidebar.classList.toggle("collapsed", collapsed);
    collapseBtn.setAttribute("aria-label", collapsed ? "Expand shopping list" : "Collapse shopping list");
  }

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toastEl.hidden = true; }, 2200);
  }

  function updateTileButtons() {
    for (const btn of document.querySelectorAll('[data-action="add"]')) {
      const inList = map.has(btn.dataset.id);
      btn.classList.toggle("in-list", inList);
      btn.textContent = inList ? `✓ ${map.get(btn.dataset.id)}` : "+";
    }
  }

  function render() {
    const size = map.size;
    let totalQty = 0;
    for (const q of map.values()) totalQty += q;

    sidebar.hidden = size === 0;
    // Reset collapse when the list empties out, so it reopens expanded next
    // time something is added — otherwise it comes back as a thin arrow
    // strip with everything (including Share/Print) hidden behind it.
    if (size === 0) sidebar.classList.remove("collapsed");
    fab.hidden = size === 0 || isDesktop();
    fabCount.textContent = String(size);

    if (size === 0) {
      entriesEl.innerHTML = "";
      totalsEl.textContent = "";
    } else {
      const groups = groupByLocation(map, ctx.catalog);
      entriesEl.innerHTML = groups
        .map(
          ([label, rows]) => `
        <div class="list-group-label">${escapeHtml(label || "No storage")}</div>
        ${rows
          .map(({ model, qty }) => {
            const max = model.quantity || 1;
            const name = model.name || model.kind || "(unnamed)";
            const thumb = model.image
              ? `<img src="${model.image.thumb}" alt="" loading="lazy">`
              : '<div class="placeholder-art"><div class="placeholder-base" style="--base-w:50%"></div></div>';
            return `<div class="list-entry" data-id="${model.id}">
              <button type="button" class="list-entry-thumb" data-action="open">${thumb}</button>
              <div class="list-entry-main">
                <button type="button" class="list-entry-name" data-action="open">${escapeHtml(model.origin)} › ${escapeHtml(model.kind)} › ${escapeHtml(name)}</button>
                <div class="list-entry-size">${escapeHtml(model.size || "—")}${model.base ? ` · ${model.base} mm` : ""}</div>
              </div>
              <div class="list-entry-controls">
                <div class="qty-stepper">
                  <button type="button" data-action="dec" ${qty <= 1 ? "disabled" : ""} aria-label="Decrease quantity">−</button>
                  <span class="qty-val">${qty} / ${max}</span>
                  <button type="button" data-action="inc" ${qty >= max ? "disabled" : ""} aria-label="Increase quantity">+</button>
                </div>
                <button type="button" class="list-entry-remove" data-action="remove" aria-label="Remove ${escapeHtml(name)}">×</button>
              </div>
            </div>`;
          })
          .join("")}
      `
        )
        .join("");
      totalsEl.textContent = `${size} model${size === 1 ? "" : "s"} · ${totalQty} miniature${totalQty === 1 ? "" : "s"}`;
    }

    updateTileButtons();
    dialogApi.refreshListControl();
  }

  function persist() {
    saveRaw(map);
    render();
  }

  entriesEl.addEventListener("click", (e) => {
    const entry = e.target.closest(".list-entry");
    const btn = e.target.closest("button[data-action]");
    if (!entry || !btn) return;
    const id = entry.dataset.id;
    if (btn.dataset.action === "open") {
      sidebar.classList.remove("overlay-open");
      const model = ctx.catalog.modelsById.get(id);
      if (model) ctx.openDialog(model, ctx.getVisibleModelIds());
    } else if (btn.dataset.action === "inc") {
      const model = ctx.catalog.modelsById.get(id);
      map.set(id, Math.min((map.get(id) || 0) + 1, model.quantity || 1));
      persist();
    } else if (btn.dataset.action === "dec") {
      const q = (map.get(id) || 1) - 1;
      if (q >= 1) map.set(id, q);
      persist();
    } else if (btn.dataset.action === "remove") {
      map.delete(id);
      persist();
    }
  });

  collapseBtn.addEventListener("click", () => setCollapsed(!sidebar.classList.contains("collapsed")));

  closeBtn.addEventListener("click", () => {
    if (isDesktop()) setCollapsed(true);
    else sidebar.classList.remove("overlay-open");
  });

  fab.addEventListener("click", () => {
    sidebar.classList.add("overlay-open");
    sidebar.classList.remove("collapsed");
  });

  window.addEventListener("resize", () => {
    if (isDesktop()) sidebar.classList.remove("overlay-open");
    fab.hidden = map.size === 0 || isDesktop();
  });

  noteEl.addEventListener("click", (e) => {
    if (e.target.closest('[data-action="dismiss-note"]')) noteEl.hidden = true;
  });

  clearBtn.addEventListener("click", () => {
    if (map.size === 0) return;
    if (!window.confirm("Clear the whole shopping list?")) return;
    map.clear();
    persist();
  });

  shareBtn.addEventListener("click", async () => {
    const url = `${location.origin}${location.pathname}${location.search}${buildShareHash(map)}`;
    if (await copyToClipboard(url)) showToast("Link copied");
    else window.prompt("Copy this link:", url);
  });

  printBtn.addEventListener("click", () => {
    const groups = groupByLocation(map, ctx.catalog);
    let totalQty = 0;
    for (const q of map.values()) totalQty += q;
    printView.innerHTML = `
      <h1>Miniatures list</h1>
      <div class="print-meta">${new Date().toLocaleDateString()} · ${map.size} model${map.size === 1 ? "" : "s"} · ${totalQty} miniature${totalQty === 1 ? "" : "s"}</div>
      ${groups
        .map(
          ([label, rows]) => `
        <div class="print-group-label">${escapeHtml(label || "No storage")}</div>
        <table>${rows
          .map(({ model, qty }) => {
            const name = model.name || model.kind || "(unnamed)";
            const thumb = model.image ? `<img class="print-thumb" src="${model.image.thumb}">` : "";
            return `<tr>
              <td><span class="print-check"></span></td>
              <td>${thumb}</td>
              <td>${escapeHtml(model.origin)} › ${escapeHtml(model.kind)} › ${escapeHtml(name)}</td>
              <td>${escapeHtml(model.size || "—")}${model.base ? ` / ${model.base} mm` : ""}</td>
              <td>${qty} / ${model.quantity}</td>
            </tr>`;
          })
          .join("")}</table>
      `
        )
        .join("")}
    `;
    window.print();
  });

  shareDialog.addEventListener("close", () => {
    const shared = pendingShared;
    pendingShared = null;
    if (!shared) return;
    if (shareDialog.returnValue === "replace") {
      map = new Map(shared);
      persist();
    } else if (shareDialog.returnValue === "merge") {
      for (const [id, qty] of shared) {
        const model = ctx.catalog.modelsById.get(id);
        if (!model) continue;
        map.set(id, Math.min((map.get(id) || 0) + qty, model.quantity || (map.get(id) || 0) + qty));
      }
      persist();
    }
    // "ignore" (or dialog dismissed): leave the local list untouched.
  });

  function offerSharedList(shared) {
    shareDialogText.textContent = `Load shared list (${shared.size} model${shared.size === 1 ? "" : "s"})?`;
    pendingShared = shared;
    shareDialog.showModal();
  }

  ctx.list = {
    has: (id) => map.has(id),
    qty: (id) => map.get(id) || 0,
    add(id) {
      const model = ctx.catalog.modelsById.get(id);
      if (!model || map.has(id)) return;
      map.set(id, 1);
      persist();
    },
    remove(id) {
      if (!map.has(id)) return;
      map.delete(id);
      persist();
    },
    setQty(id, qty) {
      const model = ctx.catalog.modelsById.get(id);
      if (!model) return;
      map.set(id, Math.min(Math.max(1, qty), model.quantity || 1));
      persist();
    },
    toggle(id) {
      if (map.has(id)) this.remove(id);
      else this.add(id);
    },
  };

  if (dropped > 0) {
    noteEl.hidden = false;
    noteEl.innerHTML = `<span>${dropped} model${dropped === 1 ? "" : "s"} from your list ${dropped === 1 ? "is" : "are"} no longer in the catalog.</span>
      <button type="button" class="icon-btn" data-action="dismiss-note" aria-label="Dismiss">✕</button>`;
  }

  // A same-page URL that differs only by #hash does not reload the document
  // (it's a fragment navigation per the HTML spec), so a share link opened
  // in a tab that already has the site loaded won't re-run this module.
  // Handle it on both the initial load and any later 'hashchange' too.
  function handleShareHash() {
    if (!location.hash.startsWith("#list=")) return;
    const shared = parseShareHash(location.hash, ctx.catalog);
    history.replaceState(null, "", location.pathname + location.search);
    if (shared.size === 0) return;
    if (map.size === 0) {
      map = shared;
      persist();
    } else {
      offerSharedList(shared);
    }
  }
  window.addEventListener("hashchange", handleShareHash);
  handleShareHash();

  render();
}
