"""
Export combined table: original document + reviewer_annotations + reviews.

Creates (or replaces) table `export_combined` in the same PostgreSQL database.

One row per (row_uid, annotation_index) from reviewer_annotations.
If a row_uid has no reviewer_annotations, it still appears once with NULLs
for annotation columns (LEFT JOIN behaviour).

Run:
    python export_combined.py [--dry-run] [--csv output.csv]
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
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
# DDL for export table
# ---------------------------------------------------------------------------

DDL = f"""
CREATE TABLE IF NOT EXISTS {EXPORT_TABLE} (
    -- document fields (from sample.json)
    row_uid               TEXT        NOT NULL,
    sample_row_id         INTEGER,
    project               TEXT,
    document_id           TEXT,
    chunk_pk              BIGINT,
    database_name         TEXT,
    source_norm           TEXT,
    author                TEXT,
    doc_date              TEXT,
    lang                  TEXT,
    word_count            INTEGER,
    word_bucket           TEXT,
    time_group            TEXT,
    chunk_text            TEXT,
    original_classifications  JSONB,   -- classifications[] from sample.json

    -- reviewer_annotations fields (from DB)
    ra_reviewer           TEXT,
    ra_annotation_index   INTEGER,
    ra_classification_value TEXT,
    ra_relevance          TEXT,
    ra_confidence         TEXT,
    ra_notes              TEXT,
    ra_extra              JSONB,
    ra_created_at         TIMESTAMPTZ,

    -- reviews fields (from DB)
    rev_judgment          TEXT,
    rev_meets_benchmark   BOOLEAN,
    rev_faithful_source   BOOLEAN,
    rev_taxonomy_ok       BOOLEAN,
    rev_metadata_ok       BOOLEAN,
    rev_escalate          BOOLEAN,
    rev_reviewer          TEXT,
    rev_notes             TEXT,
    rev_saved_at          TIMESTAMPTZ,
    rev_annotations       JSONB,       -- annotations dict stored in reviews

    PRIMARY KEY (row_uid, ra_annotation_index)
);
"""


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


def build_combined_rows(
    sample: dict[str, dict],
    reviews: dict[str, dict],
    annotations: dict[str, list[dict]],
) -> list[dict]:
    combined = []

    # Use sample.json as the source-of-truth for all row_uids
    for row_uid, doc in sample.items():
        rev = reviews.get(row_uid)
        ann_list = annotations.get(row_uid)

        # Base document fields
        doc_fields = {
            "row_uid": row_uid,
            "sample_row_id": doc.get("sample_row_id"),
            "project": doc.get("project"),
            "document_id": doc.get("document_id"),
            "chunk_pk": doc.get("chunk_pk"),
            "database_name": doc.get("database"),
            "source_norm": doc.get("source_norm"),
            "author": doc.get("author"),
            "doc_date": doc.get("date"),
            "lang": doc.get("lang"),
            "word_count": doc.get("word_count"),
            "word_bucket": doc.get("word_bucket"),
            "time_group": doc.get("time_group"),
            "chunk_text": doc.get("chunk_text"),
            "original_classifications": json.dumps(
                doc.get("classifications", []), ensure_ascii=False
            ),
        }

        # Review fields (NULL if no review yet)
        rev_fields: dict = {
            "rev_judgment": None,
            "rev_meets_benchmark": None,
            "rev_faithful_source": None,
            "rev_taxonomy_ok": None,
            "rev_metadata_ok": None,
            "rev_escalate": None,
            "rev_reviewer": None,
            "rev_notes": None,
            "rev_saved_at": None,
            "rev_annotations": None,
        }
        if rev:
            rev_fields = {
                "rev_judgment": rev.get("judgment"),
                "rev_meets_benchmark": rev.get("meets_benchmark"),
                "rev_faithful_source": rev.get("faithful_source"),
                "rev_taxonomy_ok": rev.get("taxonomy_ok"),
                "rev_metadata_ok": rev.get("metadata_ok"),
                "rev_escalate": rev.get("escalate"),
                "rev_reviewer": rev.get("reviewer"),
                "rev_notes": rev.get("notes"),
                "rev_saved_at": rev.get("saved_at"),
                "rev_annotations": rev.get("annotations"),  # already TEXT/JSON in DB
            }

        if ann_list:
            for ann in ann_list:
                row = {
                    **doc_fields,
                    **rev_fields,
                    "ra_reviewer": ann.get("reviewer"),
                    "ra_annotation_index": ann.get("annotation_index"),
                    "ra_classification_value": ann.get("classification_value"),
                    "ra_relevance": ann.get("relevance"),
                    "ra_confidence": ann.get("confidence"),
                    "ra_notes": ann.get("notes"),
                    "ra_extra": ann.get("extra"),
                    "ra_created_at": ann.get("created_at"),
                }
                combined.append(row)
        else:
            # No annotations yet — still include the document row
            row = {
                **doc_fields,
                **rev_fields,
                "ra_reviewer": None,
                "ra_annotation_index": -1,  # sentinel so PK is valid
                "ra_classification_value": None,
                "ra_relevance": None,
                "ra_confidence": None,
                "ra_notes": None,
                "ra_extra": None,
                "ra_created_at": None,
            }
            combined.append(row)

    return combined


COLUMNS = [
    "row_uid", "sample_row_id", "project", "document_id", "chunk_pk",
    "database_name", "source_norm", "author", "doc_date", "lang",
    "word_count", "word_bucket", "time_group", "chunk_text",
    "original_classifications",
    "ra_reviewer", "ra_annotation_index", "ra_classification_value",
    "ra_relevance", "ra_confidence", "ra_notes", "ra_extra", "ra_created_at",
    "rev_judgment", "rev_meets_benchmark", "rev_faithful_source",
    "rev_taxonomy_ok", "rev_metadata_ok", "rev_escalate",
    "rev_reviewer", "rev_notes", "rev_saved_at", "rev_annotations",
]


def insert_rows(cur, rows: list[dict]) -> None:
    placeholders = ", ".join(["%s"] * len(COLUMNS))
    cols = ", ".join(COLUMNS)
    sql = (
        f"INSERT INTO {EXPORT_TABLE} ({cols}) VALUES ({placeholders}) "
        f"ON CONFLICT (row_uid, ra_annotation_index) DO UPDATE SET "
        + ", ".join(f"{c} = EXCLUDED.{c}" for c in COLUMNS if c not in ("row_uid", "ra_annotation_index"))
    )
    data = [tuple(row[c] for c in COLUMNS) for row in rows]
    psycopg2.extras.execute_batch(cur, sql, data, page_size=200)


def export_csv(rows: list[dict], path: str) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    print(f"CSV saved → {path}")


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
        print(f"  {len(rows)} combined rows ready.")

        if args.csv:
            export_csv(rows, args.csv)

        if args.dry_run:
            print("Dry run — skipping DB write.")
            if rows:
                print("Sample combined row:")
                for k, v in list(rows[0].items())[:10]:
                    print(f"  {k}: {repr(v)[:80]}")
            return

        print(f"Creating/verifying table '{EXPORT_TABLE}' …")
        with conn.cursor() as cur:
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
