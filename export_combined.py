"""
Export combined table: exploded classifications from pipeline + reviewer_annotations + reviews.

Row granularity: one row per (row_uid, annotation_source, annotation_index).
  - annotation_source = 'pipeline'          → from sample.json classifications[]
  - annotation_source = 'claude-opus-4-6'   → from reviewer_annotations in DB
  - annotation_source = <human reviewer>    → from reviewer_annotations in DB

Taxonomy fields (hltp / level_2 / level_3) use the same structure across all
sources so you can compare pipeline vs Claude vs human by (row_uid, hltp).

Review decision (rev_judgment, rev_notes) from the reviews table is repeated
on every classification row that belongs to the same chunk.

Run:
    python export_combined.py [--dry-run] [--csv output.csv]
"""

from __future__ import annotations

import argparse
import csv
import json
import os
from pathlib import Path

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "docs" / "data"

load_dotenv(ROOT / ".env")

DB_CONFIG = {
    "host": os.getenv("DB_HOST", "138.201.62.161"),
    "port": int(os.getenv("DB_PORT", "5432")),
    "dbname": os.getenv("DB_NAME", "ru_benchmark_reviews"),
    "user": os.getenv("DB_USER", "postgres"),
    "password": os.getenv("DB_PASSWORD", ""),
}

EXPORT_TABLE = "export_combined"

# ---------------------------------------------------------------------------
# DDL
# ---------------------------------------------------------------------------

DDL = f"""
CREATE TABLE IF NOT EXISTS {EXPORT_TABLE} (
    -- identity / join key
    row_uid             TEXT    NOT NULL,
    annotation_source   TEXT    NOT NULL,   -- 'pipeline' | reviewer name
    annotation_index    INTEGER NOT NULL,   -- position within source (-1 = no classification)

    -- taxonomy (comparable across all sources on row_uid + hltp)
    hltp                TEXT,
    level_2             TEXT,
    level_3             TEXT,
    confidence          TEXT,   -- numeric string for pipeline; high/medium/low for DB annotations
    relevance           TEXT,   -- 'relevant' / 'not_relevant'
    ann_notes           TEXT,   -- pipeline: explanation; DB: annotation notes
    ann_extra           TEXT,   -- pipeline: directionality/source JSON; DB: extra JSONB

    -- document metadata
    sample_row_id       INTEGER,
    project             TEXT,
    document_id         TEXT,
    chunk_pk            TEXT,
    database_name       TEXT,
    source_norm         TEXT,
    author              TEXT,
    doc_date            TEXT,
    lang                TEXT,
    word_count          INTEGER,
    word_bucket         TEXT,
    time_group          TEXT,
    chunk_text          TEXT,

    -- reviewer decision (from reviews table; repeated per chunk)
    rev_judgment        TEXT,   -- 'relevant' / 'not_relevant' / other
    rev_notes           TEXT,   -- free text; often contains corrected classification

    PRIMARY KEY (row_uid, annotation_source, annotation_index)
);
"""

COLUMNS = [
    "row_uid", "annotation_source", "annotation_index",
    "hltp", "level_2", "level_3", "confidence", "relevance", "ann_notes", "ann_extra",
    "sample_row_id", "project", "document_id", "chunk_pk",
    "database_name", "source_norm", "author", "doc_date", "lang",
    "word_count", "word_bucket", "time_group", "chunk_text",
    "rev_judgment", "rev_notes",
]

# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def load_sample() -> dict[str, dict]:
    path = DATA_DIR / "sample.json"
    rows = json.loads(path.read_text())
    return {row["row_uid"]: row for row in rows}


def fetch_reviews(cur) -> dict[str, dict]:
    cur.execute("SELECT * FROM reviews")
    return {row["row_uid"]: dict(row) for row in cur.fetchall()}


def fetch_reviewer_annotations(cur) -> dict[str, list[dict]]:
    cur.execute(
        "SELECT * FROM reviewer_annotations ORDER BY row_uid, reviewer, annotation_index"
    )
    result: dict[str, list[dict]] = {}
    for row in cur.fetchall():
        result.setdefault(row["row_uid"], []).append(dict(row))
    return result

# ---------------------------------------------------------------------------
# Build rows
# ---------------------------------------------------------------------------

_IRRELEVANT_HLTP = {"NOT_RELEVANT", "UNRESOLVABLE"}


def _parse_classification_value(value: str | None) -> tuple[str | None, str | None, str | None]:
    """Split 'HLTP | 2nd | 3rd' into components."""
    if not value:
        return None, None, None
    parts = [p.strip() for p in value.split("|")]
    return (
        parts[0] if len(parts) > 0 else None,
        parts[1] if len(parts) > 1 else None,
        parts[2] if len(parts) > 2 else None,
    )


def build_combined_rows(
    sample: dict[str, dict],
    reviews: dict[str, dict],
    annotations: dict[str, list[dict]],
) -> list[dict]:
    combined = []

    for row_uid, doc in sample.items():
        rev = reviews.get(row_uid)
        ann_list = annotations.get(row_uid, [])

        # Document fields repeated on every classification row for this chunk
        doc_base = {
            "row_uid": row_uid,
            "sample_row_id": doc.get("sample_row_id"),
            "project": doc.get("project"),
            "document_id": doc.get("document_id"),
            "chunk_pk": str(doc.get("chunk_pk")) if doc.get("chunk_pk") is not None else None,
            "database_name": doc.get("database"),
            "source_norm": doc.get("source_norm"),
            "author": doc.get("author"),
            "doc_date": doc.get("date"),
            "lang": doc.get("lang"),
            "word_count": doc.get("word_count"),
            "word_bucket": doc.get("word_bucket"),
            "time_group": doc.get("time_group"),
            "chunk_text": doc.get("chunk_text"),
            "rev_judgment": rev.get("judgment") if rev else None,
            "rev_notes": rev.get("notes") if rev else None,
        }

        # --- Pipeline classifications (exploded from sample.json) ---
        pipe_cls = [
            c for c in doc.get("classifications", [])
            if c.get("HLTP")
        ]
        if pipe_cls:
            for i, cls in enumerate(pipe_cls):
                hltp = cls.get("HLTP")
                is_relevant = hltp not in _IRRELEVANT_HLTP
                combined.append({
                    **doc_base,
                    "annotation_source": "pipeline",
                    "annotation_index": i,
                    "hltp": hltp if is_relevant else None,
                    "level_2": cls.get("2nd_level_TE") if is_relevant else None,
                    "level_3": cls.get("3rd_level_TE") if is_relevant else None,
                    "confidence": str(cls["confidence"]) if cls.get("confidence") is not None else None,
                    "relevance": "relevant" if is_relevant else "not_relevant",
                    "ann_notes": cls.get("explanation"),
                    "ann_extra": json.dumps(
                        {"directionality": cls.get("directionality"), "source": cls.get("source")},
                        ensure_ascii=False,
                    ),
                })
        else:
            # Chunk has no pipeline classification — include sentinel row
            combined.append({
                **doc_base,
                "annotation_source": "pipeline",
                "annotation_index": -1,
                "hltp": None,
                "level_2": None,
                "level_3": None,
                "confidence": None,
                "relevance": "not_relevant",
                "ann_notes": None,
                "ann_extra": None,
            })

        # --- DB reviewer annotations (Claude + human, exploded) ---
        for ann in ann_list:
            hltp, level_2, level_3 = _parse_classification_value(ann.get("classification_value"))
            combined.append({
                **doc_base,
                "annotation_source": ann.get("reviewer"),
                "annotation_index": ann.get("annotation_index"),
                "hltp": hltp,
                "level_2": level_2,
                "level_3": level_3,
                "confidence": ann.get("confidence"),
                "relevance": ann.get("relevance"),
                "ann_notes": ann.get("notes"),
                "ann_extra": json.dumps(ann.get("extra"), ensure_ascii=False) if ann.get("extra") is not None else None,
            })

    return combined

# ---------------------------------------------------------------------------
# DB write / CSV export
# ---------------------------------------------------------------------------

def insert_rows(cur, rows: list[dict]) -> None:
    placeholders = ", ".join(["%s"] * len(COLUMNS))
    cols = ", ".join(COLUMNS)
    pk = ("row_uid", "annotation_source", "annotation_index")
    sql = (
        f"INSERT INTO {EXPORT_TABLE} ({cols}) VALUES ({placeholders}) "
        f"ON CONFLICT (row_uid, annotation_source, annotation_index) DO UPDATE SET "
        + ", ".join(f"{c} = EXCLUDED.{c}" for c in COLUMNS if c not in pk)
    )
    data = [tuple(row[c] for c in COLUMNS) for row in rows]
    psycopg2.extras.execute_batch(cur, sql, data, page_size=200)


def export_csv(rows: list[dict], path: str) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    print(f"CSV saved → {path}")

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Export combined review table.")
    parser.add_argument("--dry-run", action="store_true", help="Build rows but skip DB write.")
    parser.add_argument("--csv", metavar="FILE", help="Also export rows to CSV file.")
    args = parser.parse_args()

    print("Loading sample.json …")
    sample = load_sample()
    print(f"  {len(sample)} document rows loaded.")

    print("Connecting to PostgreSQL …")
    conn = psycopg2.connect(**DB_CONFIG, cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        with conn.cursor() as cur:
            print("Fetching reviews …")
            reviews = fetch_reviews(cur)
            print(f"  {len(reviews)} reviews found.")

            print("Fetching reviewer_annotations …")
            annotations = fetch_reviewer_annotations(cur)
            ann_count = sum(len(v) for v in annotations.values())
            print(f"  {ann_count} annotation rows found for {len(annotations)} unique row_uids.")

        print("Building combined rows …")
        rows = build_combined_rows(sample, reviews, annotations)
        pipe_rows = sum(1 for r in rows if r["annotation_source"] == "pipeline")
        db_rows = sum(1 for r in rows if r["annotation_source"] != "pipeline")
        print(f"  {len(rows)} combined rows ready ({pipe_rows} pipeline, {db_rows} DB annotations).")

        if args.csv:
            export_csv(rows, args.csv)

        if args.dry_run:
            print("Dry run — skipping DB write.")
            if rows:
                print("Sample row:")
                for k, v in rows[0].items():
                    print(f"  {k}: {repr(v)[:100]}")
            return

        print(f"Recreating table '{EXPORT_TABLE}' …")
        with conn.cursor() as cur:
            cur.execute(f"DROP TABLE IF EXISTS {EXPORT_TABLE}")
            cur.execute(DDL)
            conn.commit()

        print(f"Inserting {len(rows)} rows into '{EXPORT_TABLE}' …")
        with conn.cursor() as cur:
            insert_rows(cur, rows)
            conn.commit()

        print("Done.")

    finally:
        conn.close()


if __name__ == "__main__":
    main()
