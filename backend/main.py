import os
import shutil
from fastapi import FastAPI, UploadFile, File, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from orchestrator import run_full_pipeline
import aiops_store

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def load_aiops_artifacts():
    """Build/load the compact AIOps artifacts once (see aiops_store)."""
    aiops_store.ensure_built()


@app.get("/api/status")
def status_check():
    return {"status": "ok", "aiops_data": aiops_store._state['available']}


# ---------------------------------------------------------------------------
# Pre-computed AIOps results (data/run_aiops_pipeline.py output)
# ---------------------------------------------------------------------------
@app.get("/api/incidents")
def list_incidents():
    """Light incident summaries (no member_alerts) for the dashboard queue."""
    if not aiops_store._state['available']:
        raise HTTPException(status_code=503,
                            detail="AIOps artifacts not built — run data/run_aiops_pipeline.py")
    return {"incidents": aiops_store.get_incidents(),
            "count": len(aiops_store.get_incidents())}


@app.get("/api/incidents/{incident_id}")
def incident_detail(incident_id: str):
    """One full incident (member alerts capped) for the focus panel/modal."""
    if not aiops_store._state['available']:
        raise HTTPException(status_code=503,
                            detail="AIOps artifacts not built — run data/run_aiops_pipeline.py")
    inc = aiops_store.get_incident(incident_id)
    if inc is None:
        raise HTTPException(status_code=404, detail=f"incident {incident_id} not found")
    return inc


@app.get("/api/stream")
def alert_stream(cursor: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=500)):
    """Cursor-based replay feed of real AIOps alerts (wraps at the end)."""
    if not aiops_store._state['available']:
        raise HTTPException(status_code=503,
                            detail="AIOps artifacts not built — run data/run_aiops_pipeline.py")
    return aiops_store.get_stream_batch(cursor, limit)


@app.get("/api/metrics")
def pipeline_metrics():
    """Pipeline totals + ground-truth evaluation for the KPI cards."""
    if not aiops_store._state['available']:
        raise HTTPException(status_code=503,
                            detail="AIOps artifacts not built — run data/run_aiops_pipeline.py")
    return aiops_store.get_metrics()


# ---------------------------------------------------------------------------
# Upload path: run the pipeline live on an uploaded alert CSV
# ---------------------------------------------------------------------------
@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    # Ensure data/tmp exists to save the uploaded file
    tmp_dir = os.path.join(os.path.dirname(__file__), '../data/tmp')
    os.makedirs(tmp_dir, exist_ok=True)

    file_path = os.path.join(tmp_dir, file.filename)

    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    try:
        incidents, total_alerts = run_full_pipeline(file_path, tmp_dir)

        # Same serialization as the AIOps path so the frontend sees one shape
        incidents = [aiops_store.serialize_incident(inc) for inc in incidents]

        return {
            "status": "success",
            "total_alerts": total_alerts,
            "clusters_count": len(incidents),
            "incidents": incidents
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
