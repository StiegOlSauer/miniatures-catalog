// Small HTML-building helpers shared by the gallery, dialog and shopping list.

export function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export function slugify(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "");
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Turns bare URLs in an already-escaped string into links.
export function linkify(escapedText) {
  return escapedText.replace(/(https?:\/\/[^\s<]+)/g, (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
}

// Width of the placeholder "base" ellipse, scaled from the real base size.
export function basePct(base) {
  if (!base) return 40;
  if (base <= 25) return 30;
  if (base <= 50) return 45;
  if (base <= 75) return 60;
  return 75;
}

export function placeholderHTML(base, large = false) {
  return `<div class="placeholder-art${large ? " placeholder-art-lg" : ""}">
    <div class="placeholder-base" style="--base-w:${basePct(base)}%"></div>
    <span class="placeholder-caption">No photo yet</span>
  </div>`;
}

// A couple of tag values get a fixed color instead of their family's, so
// they pop out of the tag list regardless of which family they're tagged
// in (see .chip-hero / .chip-boss in style.css).
const POP_TAG_CLASS = { hero: "chip-hero", boss: "chip-boss" };

// Returns the class suffix + data-fam-idx attribute for a tag chip.
export function tagChipStyle(value, famId, tagFamilies) {
  const pop = POP_TAG_CLASS[value.toLowerCase()];
  if (pop) return { extraClass: ` ${pop}`, famAttr: "" };
  const idx = tagFamilies.findIndex((f) => f.id === famId);
  return { extraClass: "", famAttr: ` data-fam-idx="${(idx < 0 ? 0 : idx) % 6}"` };
}

// A colored filter/tag pill. tagFamilies is used to look up a family's
// column position, which decides which of the 6 palette colors it gets.
export function chipSpanHTML(type, value, tagFamilies, removable = false) {
  let cls = "chip";
  let famAttr = "";
  if (type === "origin") cls += " chip-origin";
  else if (type === "kind") cls += " chip-kind";
  else if (type.startsWith("tag:")) {
    const style = tagChipStyle(value, type.slice(4), tagFamilies);
    cls += style.extraClass;
    famAttr = style.famAttr;
  } else {
    cls += " chip-active";
  }
  const x = removable
    ? `<button type="button" class="chip-x" data-remove-chip data-type="${type}" data-value="${escapeHtml(value)}" aria-label="Remove ${escapeHtml(value)} filter">×</button>`
    : "";
  return `<span class="${cls}"${famAttr}>${escapeHtml(value)}${x}</span>`;
}

// A plain filter button (used for Origin/Kind/Size/Location); falls back to
// an em dash when the field is blank in the sheet.
export function linkButton(type, value, label) {
  if (!value) return "<span>—</span>";
  return `<button type="button" class="link-btn" data-filter="${type}" data-value="${escapeHtml(value)}">${escapeHtml(label ?? value)}</button>`;
}

export function tileHTML(model, tagFamilies) {
  const label = model.name || model.kind || "(unnamed)";
  const media = model.image
    ? `<img src="${model.image.thumb}" alt="${escapeHtml(label)}" width="${model.image.w}" height="${model.image.h}" loading="lazy" decoding="async">`
    : placeholderHTML(model.base);
  const tagsHtml = tagFamilies
    .map((fam) => (model.tags[fam.id] || [])
      .map((t) => {
        const style = tagChipStyle(t, fam.id, tagFamilies);
        return `<button type="button" class="chip${style.extraClass}"${style.famAttr} data-filter="tag:${fam.id}" data-value="${escapeHtml(t)}">${escapeHtml(t)}</button>`;
      })
      .join(""))
    .join("");
  const sizeMeta = model.size
    ? `${linkButton("size", model.size)}${model.base ? ` · ${model.base} mm` : ""}`
    : "—";
  return `<div class="tile" tabindex="0" role="button" data-id="${model.id}" aria-label="Open details for ${escapeHtml(label)}">
    <div class="tile-photo">
      ${media}
      <span class="tile-qty-badge">×${model.quantity}</span>
      <button type="button" class="tile-add-btn" data-action="add" data-id="${model.id}" aria-label="Add ${escapeHtml(label)} to shopping list">+</button>
    </div>
    <div class="tile-body">
      <p class="tile-name">${escapeHtml(label)}</p>
      <div class="tile-origin-kind">
        ${linkButton("origin", model.origin)}
        <span class="sep">›</span>
        ${linkButton("kind", model.kind)}
      </div>
      <div class="tile-meta">
        <span>${sizeMeta}</span>
        ${linkButton("location", model.location)}
      </div>
      <div class="tile-tags">${tagsHtml}</div>
    </div>
  </div>`;
}
