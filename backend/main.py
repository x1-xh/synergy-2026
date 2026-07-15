from fastapi import FastAPI as fastapi
from fastapi.middleware.cors import CORSMiddleware as corsmw

app = fastapi()

app.add_middleware(
    corsmw,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/up")
def health():
    return {"status": "ok"}
