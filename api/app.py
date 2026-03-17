from __future__ import annotations

import json
import os
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import secrets as _secrets

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
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


_http_security = HTTPBasic()


def authenticate(credentials: HTTPBasicCredentials = Depends(_http_security)) -> str:
    expected_user = os.getenv("APP_USER", "")
    expected_pass = os.getenv("APP_PASSWORD", "")
    user_ok = _secrets.compare_digest(credentials.username.encode(), expected_user.encode())
    pass_ok = _secrets.compare_digest(credentials.password.encode(), expected_pass.encode())
    if not (expected_user and expected_pass and user_ok and pass_ok):
        raise HTTPException(
            status_code=401,
            detail="Unauthorized",
            headers={"WWW-Authenticate": "Basic"},
        )
    return credentials.username


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
def health(_: str = Depends(authenticate)) -> dict[str, str]:
    with db_cursor() as cur:
        cur.execute("SELECT 1")
    return {"status": "ok", "db": "postgresql"}


@app.get("/api/bootstrap")
def bootstrap(_: str = Depends(authenticate)) -> dict[str, Any]:
    return {
        "sample": SAMPLE_ROWS,
        "summary": SUMMARY,
        "assets": ASSETS,
        "population": POPULATION,
    }


@app.get("/api/reviews")
def list_reviews(limit: int = Query(default=50, ge=1, le=500), _: str = Depends(authenticate)) -> list[dict[str, Any]]:
    with db_cursor() as cur:
        cur.execute(
            "SELECT * FROM reviews ORDER BY saved_at DESC LIMIT %s",
            (limit,),
        )
        return [dict(row) for row in cur.fetchall()]


@app.post("/api/reviews")
def upsert_review(payload: ReviewPayload, _: str = Depends(authenticate)) -> dict[str, Any]:
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
                reviewer, notes, saved_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
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
                saved_at = EXCLUDED.saved_at
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
            ),
        )
        row = cur.fetchone()
    return dict(row)


@app.get("/api/review/next")
def next_row(
    project: str | None = None,
    fresh_only: bool = True,
    _: str = Depends(authenticate),
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
