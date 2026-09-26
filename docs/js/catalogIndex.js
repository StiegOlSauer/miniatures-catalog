// Precomputed value -> count maps (for facet popovers) and a flat list of
// every filterable value (for search suggestions). Built once at startup.

export function buildIndex(catalog) {
  const origin = new Map();
  const kind = new Map();
  const location = new Map();
  const size = new Map();
  const tags = {};
  for (const fam of catalog.tagFamilies) tags[fam.id] = new Map();

  const bump = (map, key) => {
    if (!key) return;
    map.set(key, (map.get(key) || 0) + 1);
  };

  for (const m of catalog.models) {
    bump(origin, m.origin);
    bump(kind, m.kind);
    bump(location, m.location);
    bump(size, m.size);
    for (const fam of catalog.tagFamilies) {
      for (const t of m.tags[fam.id] || []) bump(tags[fam.id], t);
    }
  }
  return { origin, kind, location, size, tags };
}

export function buildSuggestionSource(catalog, index) {
  const items = [];
  for (const [value, count] of index.origin) items.push({ type: "origin", value, count, typeLabel: "Origin" });
  for (const [value, count] of index.kind) items.push({ type: "kind", value, count, typeLabel: "Kind" });
  for (const [value, count] of index.location) items.push({ type: "location", value, count, typeLabel: "Storage" });
  for (const [value, count] of index.size) items.push({ type: "size", value, count, typeLabel: "Size" });
  for (const fam of catalog.tagFamilies) {
    for (const [value, count] of index.tags[fam.id]) {
      items.push({ type: `tag:${fam.id}`, value, count, typeLabel: fam.label });
    }
  }
  return items;
}

// 2 = the value itself starts with the token, 1 = some word in the value
// does, 0 = no match. Used to rank suggestions (spec §4.3).
function matchScore(token, value) {
  const v = value.toLowerCase();
  if (v.startsWith(token)) return 2;
  if (v.split(/[^a-z0-9]+/).some((w) => w.startsWith(token))) return 1;
  return 0;
}

export function getSuggestions(source, token, activeChips, limit = 12) {
  if (!token) return [];
  const isActive = (type, value) => activeChips.some((c) => c.type === type && c.value === value);
  const scored = [];
  for (const item of source) {
    if (isActive(item.type, item.value)) continue;
    const score = matchScore(token, item.value);
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || b.item.count - a.item.count || a.item.value.localeCompare(b.item.value));
  return scored.slice(0, limit).map((s) => s.item);
}
