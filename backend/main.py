import os
import shutil
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from orchestrator import run_full_pipeline

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/status")
def status_check():
    return {"status": "ok"}


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
        
        return {
            "status": "success",
            "total_alerts": total_alerts,
            "clusters_count": len(incidents),
            "incidents": incidents
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
