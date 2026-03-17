from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "docs" / "data"
DB_DIR = ROOT / "data"
DB_PATH = DB_DIR / "reviews.sqlite3"
WEB_DIST = ROOT / "web" / "dist"


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


def db_connection() -> sqlite3.Connection:
    DB_DIR.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_db() -> None:
    with closing(db_connection()) as conn:
        conn.execute(
            """
            create table if not exists reviews (
                row_uid text primary key,
                sample_row_id integer not null,
                project text not null,
                judgment text not null,
                meets_benchmark integer not null,
                faithful_source integer not null,
                taxonomy_ok integer not null,
                metadata_ok integer not null,
                escalate integer not null,
                reviewer text not null,
                notes text not null,
                saved_at text not null
            )
            """
        )
        conn.commit()


def review_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "row_uid": row["row_uid"],
        "sample_row_id": row["sample_row_id"],
        "project": row["project"],
        "judgment": row["judgment"],
        "meets_benchmark": bool(row["meets_benchmark"]),
        "faithful_source": bool(row["faithful_source"]),
        "taxonomy_ok": bool(row["taxonomy_ok"]),
        "metadata_ok": bool(row["metadata_ok"]),
        "escalate": bool(row["escalate"]),
        "reviewer": row["reviewer"],
        "notes": row["notes"],
        "saved_at": row["saved_at"],
    }


app = FastAPI(title="RU Benchmark Review Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup() -> None:
    ensure_db()


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


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
    with closing(db_connection()) as conn:
        rows = conn.execute(
            "select * from reviews order by datetime(saved_at) desc limit ?",
            (limit,),
        ).fetchall()
    return [review_row_to_dict(row) for row in rows]


@app.post("/api/reviews")
def upsert_review(payload: ReviewPayload) -> dict[str, Any]:
    sample_row = ROW_BY_UID.get(payload.row_uid)
    if not sample_row:
        raise HTTPException(status_code=404, detail="Unknown row_uid")
    saved_at = datetime.now(timezone.utc).isoformat()
    with closing(db_connection()) as conn:
        conn.execute(
            """
            insert into reviews (
                row_uid, sample_row_id, project, judgment, meets_benchmark,
                faithful_source, taxonomy_ok, metadata_ok, escalate,
                reviewer, notes, saved_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(row_uid) do update set
                sample_row_id=excluded.sample_row_id,
                project=excluded.project,
                judgment=excluded.judgment,
                meets_benchmark=excluded.meets_benchmark,
                faithful_source=excluded.faithful_source,
                taxonomy_ok=excluded.taxonomy_ok,
                metadata_ok=excluded.metadata_ok,
                escalate=excluded.escalate,
                reviewer=excluded.reviewer,
                notes=excluded.notes,
                saved_at=excluded.saved_at
            """,
            (
                payload.row_uid,
                sample_row["sample_row_id"],
                sample_row["project"],
                payload.judgment,
                int(payload.meets_benchmark),
                int(payload.faithful_source),
                int(payload.taxonomy_ok),
                int(payload.metadata_ok),
                int(payload.escalate),
                payload.reviewer.strip(),
                payload.notes.strip(),
                saved_at,
            ),
        )
        conn.commit()
        row = conn.execute("select * from reviews where row_uid = ?", (payload.row_uid,)).fetchone()
    return review_row_to_dict(row)


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
        with closing(db_connection()) as conn:
            reviewed = {row["row_uid"] for row in conn.execute("select row_uid from reviews").fetchall()}
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
