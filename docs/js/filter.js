// Filter-chip state and matching. See SPEC.md §4.3.
// A chip is {type, value} with type in origin | kind | size | location | tag:<familyId>.

export function tokenize(text) {
  return text.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export function hasChip(chips, type, value) {
  return chips.some((c) => c.type === type && c.value === value);
}

export function toggleChip(chips, type, value) {
  if (hasChip(chips, type, value)) return chips.filter((c) => !(c.type === type && c.value === value));
  return [...chips, { type, value }];
}

// Chips of the same type OR together; different types AND; tag chips require
// every chosen tag to be present in the model's tag list for that family.
export function matchesModel(model, chips, textTokens) {
  const groups = {};
  for (const c of chips) (groups[c.type] ??= []).push(c.value);

  if (groups.origin && !groups.origin.includes(model.origin)) return false;
  if (groups.kind && !groups.kind.includes(model.kind)) return false;
  if (groups.size && !groups.size.includes(model.size)) return false;
  if (groups.location && !groups.location.includes(model.location)) return false;

  for (const key in groups) {
    if (!key.startsWith("tag:")) continue;
    const famId = key.slice(4);
    const modelTags = model.tags[famId] || [];
    for (const v of groups[key]) {
      if (!modelTags.includes(v)) return false;
    }
  }

  if (textTokens.length) {
    for (const token of textTokens) {
      if (!model.searchWords.some((w) => w.startsWith(token))) return false;
    }
  }
  return true;
}

// Shared by every place that renders a clickable origin/kind/size/location/tag
// button (tile, dialog, list entries all use data-filter/data-value).
export function applyFilterFromButton(ctx, btn) {
  const type = btn.dataset.filter;
  const value = btn.dataset.value;
  if (!type || !value) return;
  ctx.state.chips = toggleChip(ctx.state.chips, type, value);
  ctx.refresh();
}
