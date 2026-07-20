# synergy 2026

An AIOps incident-correlation prototype. We take a raw stream of log-derived alerts, cluster them into incidents using time-windowed semantic similarity, rank the most likely root-cause candidates inside each cluster, and expose the whole thing through a FastAPI backend + Next.js dashboard with a live replay mode.

Built for the 2026 Synergy hackathon. The full day-by-day build log lives in [`checklist.md`](./checklist.md) and the demo narrative / pitch content lives in [`hackathon_ppt_content.md`](./hackathon_ppt_content.md).

## stack

- **backend** — python / fastapi / uv
- **frontend** — next.js / react / bun
- **ml** — sentence-transformers (`all-MiniLM-L6-v2`), union-find clustering
- **data** — Loghub (HDFS + Spark) + AIOps Challenge `14k` labeled dataset

## how it works

```
raw logs ─► parse_logs.py ─► extract_alerts.py ─► clean_text.py ─► embed_alerts.py ─► cluster_alerts.py ─► incidents
                                                                                                              │
                                                                  backend/main.py (FastAPI) ◄──────────────────┘
                                                                                                              │
                                                                                  frontend/dashboard ◄──────┘
```

1. **parse_logs.py** — normalize HDFS / Spark logs into a common alert schema (`timestamp, source, service, severity, message, event_id, raw_line`).
2. **extract_alerts.py** — dedupe, fill missing fields, merge into `combined_alerts.csv`.
3. **clean_text.py** — strip IDs / IPs / counters so similar messages collapse to one type.
4. **embed_alerts.py** — `all-MiniLM-L6-v2` -> 384-dim embeddings.
5. **cluster_alerts.py** — sliding time window (`DEFAULT_WINDOW_SEC=240`) + cosine threshold; union-find connected components become incidents. Each incident gets top-3 root-cause candidates with normalized confidence; low-confidence clusters are flagged `needs_review`.
6. **orchestrator.py** — runs the full chain live on an uploaded CSV via `POST /api/upload`.

## running

### one shot

```sh
./run.sh
```

This spawns the FastAPI backend on `http://localhost:8000` and the Next.js frontend on `http://localhost:3000`.

### backend

```sh
cd backend
uv sync
uv run uvicorn main:app --reload --port 8000
```

### frontend

In another terminal:

```sh
cd frontend
bun install
bun dev
```

Open http://localhost:3000

## api

| method | path                          | description                                                          |
|--------|-------------------------------|----------------------------------------------------------------------|
| GET    | `/api/status`                 | health check + whether AIOps artifacts are loaded                    |
| GET    | `/api/incidents`              | light incident summaries for the dashboard queue                     |
| GET    | `/api/incidents/{id}`         | one full incident (member alerts capped) for the detail panel        |
| GET    | `/api/stream?cursor=&limit=`  | cursor-based replay feed of real AIOps alerts (wraps at the end)     |
| GET    | `/api/metrics`                | pipeline totals + ground-truth evaluation for the KPI cards         |
| POST   | `/api/upload`                 | upload an alert CSV and run the full pipeline live                    |

A precomputed AIOps dataset is bundled via `backend/aiops_store.py`; build it with `data/run_aiops_pipeline.py` if the artifacts are missing.

## project layout

```
backend/        fastapi app, orchestrator, aiops artifact store
frontend/       next.js app (dashboard + landing), components, api client
data/           parsing + ml pipeline scripts, parsed datasets, AIOps groundtruth
.github/        ci config
run.sh          one-shot launcher for backend + frontend
checklist.md    day-by-day build log
hackathon_ppt_content.md   demo narrative / pitch content
```

## notes

- The frontend expects the backend's CORS-allowed origin at `http://localhost:3000`.
- Raw Loghub / Spark logs and generated artifacts are not committed (see `.gitignore`); the pipeline currently runs against a curated AIOps subset plus any CSV you upload.