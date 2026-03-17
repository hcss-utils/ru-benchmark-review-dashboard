from __future__ import annotations

import json
import os
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "docs" / "data"
WEB_DIST = ROOT / "web" / "dist"

load_dotenv(ROOT / ".env")

DB_CONFIG = {
    "host": os.getenv("DB_HOST", "138.201.62.161"),
    "port": int(os.getenv("DB_PORT", "5432")),
    "dbname": os.getenv("DB_NAME", "ru_benchmark_reviews"),
    "user": os.getenv("DB_USER", "postgres"),
    "password": os.getenv("DB_PASSWORD", ""),
}


def load_json(name: str) -> Any:
    return json.loads((DATA_DIR / name).read_text())


SAMPLE_ROWS = load_json("sample.json")
SUMMARY = load_json("sample_latest_summary.json")
ASSETS = load_json("project_assets_manifest.json")
POPULATION = load_json("population_strata_counts.json")
ROW_BY_UID = {row["row_uid"]: row for row in SAMPLE_ROWS}


class ReviewPayload(BaseModel):
    row_uid: str
    judgment: str
    meets_benchmark: bool = False
    faithful_source: bool = False
    taxonomy_ok: bool = False
    metadata_ok: bool = False
    escalate: bool = False
    reviewer: str = ""
    notes: str = ""
    annotations: dict = {}


class AnnotationPayload(BaseModel):
    row_uid: str
    reviewer: str
    annotation_index: int = 0
    classification_value: str = ""
    relevance: str = ""
    confidence: str = ""
    notes: str = ""
    extra: dict = {}


class AnnotationDeletePayload(BaseModel):
    row_uid: str
    reviewer: str
    annotation_index: int


@contextmanager
def db_cursor():
    conn = psycopg2.connect(**DB_CONFIG)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            yield cur
            conn.commit()
    finally:
        conn.close()


app = FastAPI(title="RU Benchmark Review Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    with db_cursor() as cur:
        cur.execute("SELECT 1")
    return {"status": "ok", "db": "postgresql"}


@app.get("/api/bootstrap")
def bootstrap() -> dict[str, Any]:
    return {
        "sample": SAMPLE_ROWS,
        "summary": SUMMARY,
        "assets": ASSETS,
        "population": POPULATION,
    }


@app.get("/api/reviews")
def list_reviews(limit: int = Query(default=50, ge=1, le=500)) -> list[dict[str, Any]]:
    with db_cursor() as cur:
        cur.execute(
            "SELECT * FROM reviews ORDER BY saved_at DESC LIMIT %s",
            (limit,),
        )
        return [dict(row) for row in cur.fetchall()]


@app.post("/api/reviews")
def upsert_review(payload: ReviewPayload) -> dict[str, Any]:
    sample_row = ROW_BY_UID.get(payload.row_uid)
    if not sample_row:
        raise HTTPException(status_code=404, detail="Unknown row_uid")
    saved_at = datetime.now(timezone.utc)
    with db_cursor() as cur:
        cur.execute(
            """
            INSERT INTO reviews (
                row_uid, sample_row_id, project, judgment, meets_benchmark,
                faithful_source, taxonomy_ok, metadata_ok, escalate,
                reviewer, notes, saved_at, annotations
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (row_uid) DO UPDATE SET
                sample_row_id = EXCLUDED.sample_row_id,
                project = EXCLUDED.project,
                judgment = EXCLUDED.judgment,
                meets_benchmark = EXCLUDED.meets_benchmark,
                faithful_source = EXCLUDED.faithful_source,
                taxonomy_ok = EXCLUDED.taxonomy_ok,
                metadata_ok = EXCLUDED.metadata_ok,
                escalate = EXCLUDED.escalate,
                reviewer = EXCLUDED.reviewer,
                notes = EXCLUDED.notes,
                saved_at = EXCLUDED.saved_at,
                annotations = EXCLUDED.annotations
            RETURNING *
            """,
            (
                payload.row_uid,
                sample_row["sample_row_id"],
                sample_row["project"],
                payload.judgment,
                payload.meets_benchmark,
                payload.faithful_source,
                payload.taxonomy_ok,
                payload.metadata_ok,
                payload.escalate,
                payload.reviewer.strip(),
                payload.notes.strip(),
                saved_at,
                json.dumps(payload.annotations),
            ),
        )
        row = cur.fetchone()
    return dict(row)


@app.get("/api/reviewer-annotations")
def get_annotations(row_uid: str, reviewer: str = "") -> list[dict[str, Any]]:
    with db_cursor() as cur:
        if reviewer:
            cur.execute(
                "SELECT * FROM reviewer_annotations WHERE row_uid = %s AND reviewer = %s ORDER BY annotation_index",
                (row_uid, reviewer),
            )
        else:
            cur.execute(
                "SELECT * FROM reviewer_annotations WHERE row_uid = %s ORDER BY reviewer, annotation_index",
                (row_uid,),
            )
        return [dict(row) for row in cur.fetchall()]


@app.post("/api/reviewer-annotations")
def upsert_annotation(payload: AnnotationPayload) -> dict[str, Any]:
    if payload.row_uid not in ROW_BY_UID:
        raise HTTPException(status_code=404, detail="Unknown row_uid")
    with db_cursor() as cur:
        cur.execute(
            """
            INSERT INTO reviewer_annotations (
                row_uid, reviewer, annotation_index,
                classification_value, relevance, confidence, notes, extra
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (row_uid, reviewer, annotation_index) DO UPDATE SET
                classification_value = EXCLUDED.classification_value,
                relevance = EXCLUDED.relevance,
                confidence = EXCLUDED.confidence,
                notes = EXCLUDED.notes,
                extra = EXCLUDED.extra,
                created_at = NOW()
            RETURNING *
            """,
            (
                payload.row_uid,
                payload.reviewer.strip(),
                payload.annotation_index,
                payload.classification_value.strip(),
                payload.relevance,
                payload.confidence,
                payload.notes.strip(),
                json.dumps(payload.extra),
            ),
        )
        row = cur.fetchone()
    return dict(row)


@app.delete("/api/reviewer-annotations")
def delete_annotation(payload: AnnotationDeletePayload) -> dict[str, str]:
    with db_cursor() as cur:
        cur.execute(
            "DELETE FROM reviewer_annotations WHERE row_uid = %s AND reviewer = %s AND annotation_index = %s",
            (payload.row_uid, payload.reviewer, payload.annotation_index),
        )
    return {"status": "deleted"}


@app.get("/api/review/next")
def next_row(
    project: str | None = None,
    fresh_only: bool = True,
) -> dict[str, Any]:
    rows = SAMPLE_ROWS
    if project and project != "ALL":
        rows = [row for row in rows if row["project"] == project]
    if not rows:
        raise HTTPException(status_code=404, detail="No rows available for that filter")

    reviewed = set()
    if fresh_only:
        with db_cursor() as cur:
            cur.execute("SELECT row_uid FROM reviews")
            reviewed = {row["row_uid"] for row in cur.fetchall()}
        unseen = [row for row in rows if row["row_uid"] not in reviewed]
        if unseen:
            rows = unseen

    rows = sorted(rows, key=lambda row: (row["sample_row_id"], row["row_uid"]))
    pointer = len(reviewed) % len(rows)
    return rows[pointer]


if WEB_DIST.exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")


@app.get("/{name:path}.svg")
def serve_svg(name: str):
    svg_file = WEB_DIST / f"{name}.svg"
    if svg_file.exists():
        return FileResponse(svg_file, media_type="image/svg+xml")
    raise HTTPException(status_code=404, detail="Not found")


@app.get("/{path:path}")
def frontend(path: str = ""):
    index_file = WEB_DIST / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return {
        "message": "Frontend is not built yet.",
        "build": "Run npm install && npm run build inside web/",
    }
