#!/usr/bin/env python3
"""Build docs/data.json (plus full-size images and thumbnails) from the
Miniatures Catalogue spreadsheet. See SPEC.md sections 3 and 6.

Usage:
    python3 tools/build.py --sheet-url URL --photos DIR
    python3 tools/build.py --csv FILE --photos DIR [--out DIR] [--force]

Nothing here should hard-code a sheet URL, a username or a photo directory:
those are always supplied on the command line.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageOps

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO_ROOT / "docs"

ALLOWED_SIZES = ["S", "M", "L", "XL", "XXL", "XXXL"]
PHOTO_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}
REQUIRED_HEADERS = ["origin", "kind", "size", "base (mm)", "quantity", "location"]
OPTIONAL_HEADERS = ["name", "image", "made by"]
# Display form for error messages (str.title() would turn "mm" into "Mm").
HEADER_DISPLAY = {
    "origin": "Origin", "kind": "Kind", "size": "Size", "base (mm)": "Base (mm)",
    "quantity": "Quantity", "location": "Location",
}

FULL_MAX_EDGE = 1600
THUMB_WIDTH = 480


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------

def slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.strip().lower())
    return s.strip("-")


def normalize_ws(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip())


def dup_key(text: str) -> str:
    """Normalize a value for near-duplicate detection: lowercase,
    strip non-alphanumerics, strip one trailing 's'."""
    k = re.sub(r"[^a-z0-9]", "", text.lower())
    if len(k) > 1 and k.endswith("s"):
        k = k[:-1]
    return k


def is_url(text: str) -> bool:
    return bool(re.match(r"^https?://", text, re.IGNORECASE))


class BuildError(Exception):
    """A fatal problem; the build stops."""


# --------------------------------------------------------------------------
# sheet loading
# --------------------------------------------------------------------------

def fetch_sheet_csv(sheet_url: str) -> str:
    m = re.search(r"/spreadsheets/d/([a-zA-Z0-9_-]+)", sheet_url)
    if not m:
        raise BuildError(
            "Could not find a spreadsheet ID in --sheet-url. Copy the URL "
            "from the browser address bar while the Catalogue tab is open."
        )
    sheet_id = m.group(1)

    m = re.search(r"[?#&]gid=(\d+)", sheet_url)
    if not m:
        raise BuildError(
            "The URL has no gid= for a specific tab. Open the Catalogue tab "
            "in Google Sheets and copy the URL from the address bar again."
        )
    gid = m.group(1)

    export_url = (
        f"https://docs.google.com/spreadsheets/d/{sheet_id}"
        f"/export?format=csv&gid={gid}"
    )
    try:
        with urllib.request.urlopen(export_url, timeout=30) as resp:
            status = getattr(resp, "status", 200)
            content_type = resp.headers.get("Content-Type", "")
            body = resp.read()
    except urllib.error.URLError as exc:
        raise BuildError(f"Could not download the sheet: {exc}") from exc

    if status != 200:
        raise BuildError(
            f"Sheet is not accessible (HTTP {status}). Set Share -> General "
            "access -> Anyone with the link -> Viewer, then try again."
        )
    text = body.decode("utf-8-sig", errors="replace")
    if "text/html" in content_type or text.lstrip().startswith("<"):
        raise BuildError(
            "Sheet is not accessible (got an HTML page instead of CSV). Set "
            "Share -> General access -> Anyone with the link -> Viewer, then "
            "try again."
        )
    return text


# --------------------------------------------------------------------------
# row parsing
# --------------------------------------------------------------------------

class Warnings:
    """Collects build warnings grouped by category, for a readable summary."""

    def __init__(self):
        self.by_category: dict[str, list[str]] = defaultdict(list)

    def add(self, category: str, message: str) -> None:
        self.by_category[category].append(message)

    def count(self) -> int:
        return sum(len(v) for v in self.by_category.values())

    def print_report(self) -> None:
        for category, messages in self.by_category.items():
            print(f"\n{category} ({len(messages)}):")
            for msg in messages:
                print(f"  - {msg}")


def parse_header(header_row: list[str]) -> tuple[dict[str, int], list[tuple[str, str, int]]]:
    """Returns (column index for each known non-tag header, list of
    (family label, family id, column index) for Tags: columns, in order)."""
    col_index: dict[str, int] = {}
    tag_cols: list[tuple[str, str, int]] = []
    ignored: list[str] = []
    for i, raw in enumerate(header_row):
        key = normalize_ws(raw)
        lkey = key.lower()
        if lkey.startswith("tags:"):
            label = key[len("tags:"):].strip()
            tag_cols.append((label, slug(label), i))
        elif lkey in REQUIRED_HEADERS or lkey in OPTIONAL_HEADERS:
            col_index[lkey] = i
        elif key:
            ignored.append(key)

    missing = [h for h in REQUIRED_HEADERS if h not in col_index]
    if missing:
        raise BuildError(
            "The sheet is missing required column(s): "
            + ", ".join(HEADER_DISPLAY[h] for h in missing)
        )
    if ignored:
        print(f"Ignoring unrecognized column(s): {', '.join(ignored)}")
    return col_index, tag_cols


def model_label(origin: str, kind: str, name: str) -> str:
    return f"{origin or '?'} › {kind or '?'} › {name or '(unnamed)'}"


def parse_rows(
    rows: list[list[str]],
    col_index: dict[str, int],
    tag_cols: list[tuple[str, str, int]],
    photos_dir: Path,
    warnings: Warnings,
) -> list[dict]:
    def cell(row: list[str], key: str) -> str:
        idx = col_index.get(key)
        if idx is None or idx >= len(row):
            return ""
        return normalize_ws(row[idx])

    models: list[dict] = []
    seen_ids: dict[str, int] = {}
    # value -> count, per field, for near-duplicate detection
    value_counts: dict[str, dict[str, int]] = {
        "Origin": defaultdict(int),
        "Kind": defaultdict(int),
        "Location": defaultdict(int),
    }
    tag_value_counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    tag_family_membership: dict[str, set[str]] = defaultdict(set)
    referenced_images: dict[str, str] = {}  # filename -> first model label that uses it

    for offset, row in enumerate(rows):
        row_num = offset + 2  # header is row 1
        if not any(normalize_ws(c) for c in row):
            continue  # fully blank row

        origin = cell(row, "origin")
        kind = cell(row, "kind")
        name = cell(row, "name")
        size_raw = cell(row, "size").upper()
        base_raw = cell(row, "base (mm)")
        qty_raw = cell(row, "quantity")
        location = cell(row, "location")
        image_raw = cell(row, "image")
        made_by = cell(row, "made by")

        label = model_label(origin, kind, name)

        missing_fields = []
        if not origin:
            missing_fields.append("Origin")
        if not kind:
            missing_fields.append("Kind")
        if not size_raw:
            missing_fields.append("Size")
        if not base_raw:
            missing_fields.append("Base (mm)")
        if not qty_raw:
            missing_fields.append("Quantity")
        if not location:
            missing_fields.append("Location")
        if missing_fields:
            warnings.add(
                "Missing required value",
                f"row {row_num} ({label}): blank {', '.join(missing_fields)}",
            )

        if size_raw and size_raw not in ALLOWED_SIZES:
            warnings.add(
                "Unrecognized size",
                f"row {row_num} ({label}): size \"{size_raw}\" is not one of "
                + ", ".join(ALLOWED_SIZES),
            )

        base = None
        if base_raw:
            try:
                base = int(base_raw)
                if base % 25 != 0:
                    warnings.add(
                        "Base is not a multiple of 25",
                        f"row {row_num} ({label}): base = {base}",
                    )
            except ValueError:
                warnings.add(
                    "Invalid base",
                    f"row {row_num} ({label}): base \"{base_raw}\" is not a whole number",
                )
                base = None

        qty = 1
        if qty_raw:
            try:
                qty = int(qty_raw)
                if qty <= 0:
                    warnings.add(
                        "Invalid quantity",
                        f"row {row_num} ({label}): quantity \"{qty_raw}\" is not positive, using 1",
                    )
                    qty = 1
            except ValueError:
                warnings.add(
                    "Invalid quantity",
                    f"row {row_num} ({label}): quantity \"{qty_raw}\" is not a whole number, using 1",
                )
                qty = 1

        image_ref = None
        if image_raw:
            if is_url(image_raw):
                warnings.add(
                    "Image problem",
                    f"row {row_num} ({label}): image \"{image_raw}\" is a web "
                    "address, not a local file; using a placeholder",
                )
            elif not (photos_dir / image_raw).is_file():
                warnings.add(
                    "Image problem",
                    f"row {row_num} ({label}): image file \"{image_raw}\" was "
                    "not found; using a placeholder",
                )
            else:
                image_ref = image_raw
                referenced_images.setdefault(image_raw, label)

        tags: dict[str, list[str]] = {}
        for fam_label, fam_id, idx in tag_cols:
            cell_val = row[idx] if idx < len(row) else ""
            vals: list[str] = []
            seen: set[str] = set()
            for t in cell_val.split(","):
                t = normalize_ws(t).lower()
                if t and t not in seen:
                    seen.add(t)
                    vals.append(t)
                    tag_value_counts[fam_id][t] += 1
                    tag_family_membership[t].add(fam_id)
            tags[fam_id] = vals

        if origin:
            value_counts["Origin"][origin] += 1
        if kind:
            value_counts["Kind"][kind] += 1
        if location:
            value_counts["Location"][location] += 1

        base_id = slug(origin) + "-" + slug(kind)
        if name:
            base_id += "-" + slug(name)
        base_id = base_id.strip("-") or "model"
        n = seen_ids.get(base_id, 0)
        seen_ids[base_id] = n + 1
        model_id = base_id if n == 0 else f"{base_id}-{n + 1}"

        models.append(
            {
                "id": model_id,
                "origin": origin,
                "kind": kind,
                "name": name,
                "size": size_raw,
                "base": base,
                "quantity": qty,
                "location": location,
                "tags": tags,
                "image": None,  # filled in later, once photos are processed
                "madeBy": made_by,
                "_image_ref": image_ref,  # internal, stripped before writing data.json
                "_label": label,
            }
        )

    # near-duplicate detection: Origin, Kind, Location
    for field, counts in value_counts.items():
        groups: dict[str, dict[str, int]] = defaultdict(dict)
        for value, n in counts.items():
            groups[dup_key(value)][value] = n
        for key, variants in groups.items():
            if len(variants) > 1:
                parts = ", ".join(f"\"{v}\" ({n})" for v, n in sorted(variants.items()))
                warnings.add("Possible near-duplicate values", f"{field}: {parts}")

    # near-duplicate detection: each tag family
    for fam_label, fam_id, _ in tag_cols:
        counts = tag_value_counts.get(fam_id, {})
        groups: dict[str, dict[str, int]] = defaultdict(dict)
        for value, n in counts.items():
            groups[dup_key(value)][value] = n
        for key, variants in groups.items():
            if len(variants) > 1:
                parts = ", ".join(f"\"{v}\" ({n})" for v, n in sorted(variants.items()))
                warnings.add(
                    "Possible near-duplicate values", f"Tag [{fam_label}]: {parts}"
                )

    # tags that appear in more than one family
    for value, families in tag_family_membership.items():
        if len(families) > 1:
            fam_labels = [lbl for lbl, fid, _ in tag_cols if fid in families]
            warnings.add(
                "Tag used in more than one family",
                f"\"{value}\" appears in: {', '.join(fam_labels)}",
            )

    return models, referenced_images


# --------------------------------------------------------------------------
# image processing
# --------------------------------------------------------------------------

def downscale_long_edge(im: Image.Image, max_edge: int) -> Image.Image:
    w, h = im.size
    long_edge = max(w, h)
    if long_edge <= max_edge:
        return im.copy()
    scale = max_edge / long_edge
    return im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)


def resize_to_width(im: Image.Image, width: int) -> Image.Image:
    w, h = im.size
    if w <= width:
        return im.copy()
    scale = width / w
    return im.resize((width, max(1, round(h * scale))), Image.LANCZOS)


def process_images(
    referenced_images: dict[str, str],
    photos_dir: Path,
    out_dir: Path,
    force: bool,
    warnings: Warnings,
) -> dict[str, dict]:
    """Returns filename -> {"thumb", "full", "w", "h"} for every referenced,
    existing photo. Regenerates full/thumb outputs only when needed, and
    removes outputs for photos no longer referenced."""
    full_dir = out_dir / "images" / "full"
    thumb_dir = out_dir / "images" / "thumbs"
    full_dir.mkdir(parents=True, exist_ok=True)
    thumb_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "images" / "manifest.json"

    old_manifest: dict[str, dict] = {}
    if manifest_path.is_file():
        try:
            old_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            old_manifest = {}

    # Assign stable, collision-free output slugs, sorted for determinism.
    filenames = sorted(referenced_images.keys())
    slug_counts: dict[str, int] = defaultdict(int)
    collisions: dict[str, list[str]] = defaultdict(list)
    file_slug: dict[str, str] = {}
    for fname in filenames:
        stem = Path(fname).stem
        base_slug = slug(stem) or "image"
        n = slug_counts[base_slug]
        file_slug[fname] = base_slug if n == 0 else f"{base_slug}-{n + 1}"
        slug_counts[base_slug] += 1
        collisions[base_slug].append(fname)
    for base_slug, files in collisions.items():
        if len(files) > 1:
            warnings.add(
                "Image name collision",
                f"these files all simplify to \"{base_slug}\": {', '.join(files)}",
            )

    new_manifest: dict[str, dict] = {}
    result: dict[str, dict] = {}
    regenerated = 0

    for fname in filenames:
        src_path = photos_dir / fname
        out_slug = file_slug[fname]
        full_path = full_dir / f"{out_slug}.jpg"
        thumb_path = thumb_dir / f"{out_slug}.webp"

        digest = hashlib.sha256(src_path.read_bytes()).hexdigest()
        old = old_manifest.get(fname)
        needs_regen = (
            force
            or old is None
            or old.get("hash") != digest
            or old.get("slug") != out_slug
            or not full_path.is_file()
            or not thumb_path.is_file()
        )

        if needs_regen:
            with Image.open(src_path) as im:
                im = ImageOps.exif_transpose(im)
                if im.mode != "RGB":
                    im = im.convert("RGB")
                full_im = downscale_long_edge(im, FULL_MAX_EDGE)
                full_im.save(full_path, "JPEG", quality=85, progressive=True, optimize=True)
                thumb_im = resize_to_width(im, THUMB_WIDTH)
                thumb_im.save(thumb_path, "WEBP", quality=72, method=6)
                thumb_w, thumb_h = thumb_im.size
            regenerated += 1
        else:
            thumb_w = old.get("thumb_w")
            thumb_h = old.get("thumb_h")

        new_manifest[fname] = {
            "hash": digest,
            "slug": out_slug,
            "thumb_w": thumb_w,
            "thumb_h": thumb_h,
        }
        result[fname] = {
            "thumb": f"images/thumbs/{out_slug}.webp",
            "full": f"images/full/{out_slug}.jpg",
            "w": thumb_w,
            "h": thumb_h,
        }

    # Remove outputs for photos no longer referenced.
    live_slugs = {v["slug"] for v in new_manifest.values()}
    removed = 0
    for existing in list(full_dir.glob("*.jpg")) + list(thumb_dir.glob("*.webp")):
        if existing.stem not in live_slugs:
            existing.unlink()
            removed += 1

    manifest_path.write_text(
        json.dumps(new_manifest, indent=1, ensure_ascii=False), encoding="utf-8"
    )

    print(
        f"Images: {len(filenames)} referenced, {regenerated} regenerated, "
        f"{removed} stale output file(s) removed."
    )
    return result


def warn_unused_photos(photos_dir: Path, referenced: set[str], warnings: Warnings) -> None:
    all_photos = {
        p.name for p in photos_dir.iterdir() if p.is_file() and p.suffix.lower() in PHOTO_EXTS
    }
    unused = sorted(all_photos - referenced)
    for fname in unused:
        warnings.add("Unused photo (no model references it)", fname)


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="Build the miniatures catalog site data.")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--sheet-url", help="Google Sheets URL of the Catalogue tab (must contain gid=).")
    source.add_argument("--csv", help="Local CSV export of the Catalogue tab.")
    parser.add_argument("--photos", required=True, help="Directory containing the source photos.")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="Output directory (default: docs/).")
    parser.add_argument("--force", action="store_true", help="Regenerate all images even if unchanged.")
    args = parser.parse_args()

    photos_dir = Path(args.photos).expanduser().resolve()
    out_dir = Path(args.out).expanduser().resolve()

    if not photos_dir.is_dir():
        print(f"error: photos directory not found: {photos_dir}", file=sys.stderr)
        return 1

    try:
        if args.sheet_url:
            csv_text = fetch_sheet_csv(args.sheet_url)
        else:
            csv_path = Path(args.csv).expanduser().resolve()
            if not csv_path.is_file():
                raise BuildError(f"CSV file not found: {csv_path}")
            csv_text = csv_path.read_text(encoding="utf-8-sig")

        rows = list(csv.reader(csv_text.splitlines()))
        if not rows:
            raise BuildError("The sheet/CSV is empty.")
        col_index, tag_cols = parse_header(rows[0])

        warnings = Warnings()
        models, referenced_images = parse_rows(rows[1:], col_index, tag_cols, photos_dir, warnings)

        out_dir.mkdir(parents=True, exist_ok=True)
        image_map = process_images(referenced_images, photos_dir, out_dir, args.force, warnings)
        warn_unused_photos(photos_dir, set(referenced_images.keys()), warnings)

        placeholders = 0
        total_minis = 0
        for m in models:
            ref = m.pop("_image_ref")
            m.pop("_label", None)
            if ref and ref in image_map:
                m["image"] = image_map[ref]
            else:
                placeholders += 1
            total_minis += m["quantity"]

        data = {
            "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "sizes": ALLOWED_SIZES,
            "tagFamilies": [{"id": fam_id, "label": fam_label} for fam_label, fam_id, _ in tag_cols],
            "models": models,
        }
        (out_dir / "data.json").write_text(
            json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8"
        )
        (out_dir / ".nojekyll").write_text("", encoding="utf-8")

    except BuildError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    warnings.print_report()
    print(
        f"\n{len(models)} models, {total_minis} miniatures, "
        f"{len(image_map)} photos, {placeholders} placeholders, "
        f"{warnings.count()} warnings"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
