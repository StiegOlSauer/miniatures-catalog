// The model detail popup. See SPEC.md §4.5.

import { escapeHtml, basePct, linkify, linkButton, tagChipStyle } from "./render.js?v=8";
import { applyFilterFromButton } from "./filter.js?v=8";

export function initDialog(ctx) {
  const dlg = document.getElementById("model-dialog");
  const imgEl = document.getElementById("dialog-image");
  const phEl = document.getElementById("dialog-placeholder");
  const phBase = phEl.querySelector(".placeholder-base");
  const originKindEl = document.getElementById("dialog-origin-kind");
  const nameEl = document.getElementById("dialog-name");
  const factsEl = document.getElementById("dialog-facts");
  const tagsEl = document.getElementById("dialog-tags");
  const madeByEl = document.getElementById("dialog-madeby");
  const listControlEl = document.getElementById("dialog-list-control");
  const closeBtn = document.getElementById("dialog-close");
  const prevBtn = document.getElementById("dialog-prev");
  const nextBtn = document.getElementById("dialog-next");

  let order = []; // ids of the currently-filtered models, for Prev/Next
  let currentId = null;

  function renderListControl() {
    const model = ctx.catalog.modelsById.get(currentId);
    if (!model || !ctx.list) return;
    if (!ctx.list.has(model.id)) {
      listControlEl.innerHTML = `<button type="button" class="btn btn-primary" data-action="dialog-add">Add to list</button>`;
      return;
    }
    const qty = ctx.list.qty(model.id);
    const max = model.quantity || 1;
    listControlEl.innerHTML = `
      <div class="qty-stepper">
        <button type="button" data-action="dialog-dec" ${qty <= 1 ? "disabled" : ""} aria-label="Decrease quantity">−</button>
        <span class="qty-val">${qty} / ${max}</span>
        <button type="button" data-action="dialog-inc" ${qty >= max ? "disabled" : ""} aria-label="Increase quantity">+</button>
      </div>
      <button type="button" class="btn" data-action="dialog-remove">Remove</button>`;
  }

  listControlEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn || !currentId || !ctx.list) return;
    if (btn.dataset.action === "dialog-add") ctx.list.add(currentId);
    else if (btn.dataset.action === "dialog-remove") ctx.list.remove(currentId);
    else if (btn.dataset.action === "dialog-inc") ctx.list.setQty(currentId, ctx.list.qty(currentId) + 1);
    else if (btn.dataset.action === "dialog-dec") ctx.list.setQty(currentId, ctx.list.qty(currentId) - 1);
    renderListControl();
  });

  function renderModel(model) {
    currentId = model.id;
    const label = model.name || model.kind || "(unnamed)";
    nameEl.textContent = label;
    originKindEl.innerHTML = `${linkButton("origin", model.origin)} <span class="sep">›</span> ${linkButton("kind", model.kind)}`;

    if (model.image) {
      imgEl.hidden = false;
      phEl.hidden = true;
      imgEl.alt = label;
      imgEl.src = model.image.thumb; // shown immediately, swapped once the full image is ready
      imgEl.onclick = () => window.open(model.image.full, "_blank", "noopener");
      const preload = new Image();
      preload.onload = () => { imgEl.src = model.image.full; };
      preload.src = model.image.full;
    } else {
      imgEl.hidden = true;
      imgEl.onclick = null;
      phEl.hidden = false;
      phBase.style.setProperty("--base-w", `${basePct(model.base)}%`);
    }

    factsEl.innerHTML = `
      <dt>Size</dt><dd>${linkButton("size", model.size)}</dd>
      <dt>Base</dt><dd>${model.base ? `${model.base} mm` : "—"}</dd>
      <dt>Quantity</dt><dd>${model.quantity}</dd>
      <dt>Storage</dt><dd>${linkButton("location", model.location)}</dd>
    `;

    tagsEl.innerHTML = ctx.catalog.tagFamilies
      .map((fam) => {
        const vals = model.tags[fam.id] || [];
        if (!vals.length) return "";
        const chips = vals
          .map((v) => {
            const style = tagChipStyle(v, fam.id, ctx.catalog.tagFamilies);
            return `<button type="button" class="chip${style.extraClass}"${style.famAttr} data-filter="tag:${fam.id}" data-value="${escapeHtml(v)}">${escapeHtml(v)}</button>`;
          })
          .join("");
        return `<div class="dialog-tag-family"><span class="fam-label">${escapeHtml(fam.label)}</span>${chips}</div>`;
      })
      .join("");

    madeByEl.innerHTML = model.madeBy ? `Made by: ${linkify(escapeHtml(model.madeBy))}` : "";

    renderListControl();
  }

  function go(delta) {
    if (!order.length) return;
    const idx = order.indexOf(currentId);
    const next = (idx + delta + order.length) % order.length;
    const model = ctx.catalog.modelsById.get(order[next]);
    if (model) renderModel(model);
  }

  prevBtn.addEventListener("click", () => go(-1));
  nextBtn.addEventListener("click", () => go(1));
  closeBtn.addEventListener("click", () => dlg.close());

  dlg.addEventListener("click", (e) => {
    const filterBtn = e.target.closest("[data-filter]");
    if (filterBtn) {
      applyFilterFromButton(ctx, filterBtn);
      dlg.close();
      return;
    }
    // A click that lands on the <dialog> element itself (not its content)
    // is a click on the backdrop area.
    if (e.target === dlg) dlg.close();
  });

  document.addEventListener("keydown", (e) => {
    if (!dlg.open) return;
    if (e.key === "ArrowLeft") go(-1);
    else if (e.key === "ArrowRight") go(1);
  });

  function open(model, visibleIds) {
    order = visibleIds && visibleIds.length ? visibleIds : [model.id];
    renderModel(model);
    dlg.showModal();
  }

  return { open, refreshListControl: renderListControl };
}
