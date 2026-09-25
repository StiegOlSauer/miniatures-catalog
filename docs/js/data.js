// Loads docs/data.json and precomputes a search-word list per model.

export async function loadCatalog() {
  const res = await fetch("data.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load data.json: ${res.status}`);
  const raw = await res.json();
  const models = raw.models.map((m) => ({ ...m, searchWords: buildSearchWords(m) }));
  return { sizes: raw.sizes, tagFamilies: raw.tagFamilies, models, generated: raw.generated };
}

function buildSearchWords(model) {
  const parts = [model.origin, model.kind, model.name, ...Object.values(model.tags).flat()];
  const words = new Set();
  for (const part of parts) {
    if (!part) continue;
    for (const w of part.toLowerCase().split(/[^a-z0-9]+/)) {
      if (w) words.add(w);
    }
  }
  return [...words];
}
