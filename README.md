# RU Benchmark Review Dashboard

Static GitHub Pages dashboard for reviewing a **250-row RU-only benchmark sample** stratified by:

- `project`
- `source`
- `time`
- `chunk word count`

## What This Repo Contains

- `docs/index.html`
  - Interactive dashboard with 3 tabs:
    - **Distribution**: project/source/time/word-bucket visualizations
    - **Expert Review**: inspect a row and save human judgments
    - **Project Assets**: prompt/result source manifest
- `docs/data/sample.json`
  - Benchmark sample rows (latest snapshot)
- `docs/data/sample_latest_summary.json`
  - Sample distribution summary
- `docs/data/project_assets_manifest.json`
  - Prompt + result source references per project

## Included Project Strata

- `rnla-deterrence`
- `rnla-grey-zone`
- `wacko`
- `ruw-core-taxonomy`
- `ruw-transparent-battlefield`
- `ruw-red-lines`

Project/source references are listed in the **Project Assets** tab and in `docs/data/project_assets_manifest.json`.

## Expert Review Behavior

- Judgments are stored in browser `localStorage` (client-side, no backend).
- You can export all judgments to CSV via **Download CSV**.

## Why Static

GitHub Pages serves static sites only. This implementation keeps the review workflow interactive in-browser without requiring a server runtime.

## Local Preview

From repo root:

```bash
python3 -m http.server 8080
```

Open: `http://localhost:8080/docs/`

## Deployment

This repo uses a GitHub Actions Pages workflow (`.github/workflows/pages.yml`) that deploys the `docs/` folder.

## Data Refresh Workflow

If you regenerate benchmark data upstream, refresh these files:

- `docs/data/sample.json`
- `docs/data/sample_latest_summary.json`
- `docs/data/project_assets_manifest.json`

Then commit + push to update Pages.
