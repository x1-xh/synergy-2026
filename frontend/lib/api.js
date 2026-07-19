// lib/api.js
// Thin client for the ClarityOps FastAPI backend (backend/main.py).
// Every helper degrades gracefully — callers fall back to mock data when the
// backend is unreachable, so the demo never hard-fails.

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"

async function get(path) {
  const res = await fetch(`${API_BASE}${path}`, { cache: "no-store" })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json()
}

// Light incident summaries (no member_alerts) for the queue/focus panels
export async function fetchIncidents() {
  const data = await get("/api/incidents")
  return data.incidents || []
}

// One full incident (member alerts, capped at 500 by the backend)
export async function fetchIncidentDetail(incidentId) {
  return get(`/api/incidents/${encodeURIComponent(incidentId)}`)
}

// Next batch of real alerts for the replay feed; wraps at the end
export async function fetchStreamBatch(cursor = 0, limit = 50) {
  return get(`/api/stream?cursor=${cursor}&limit=${limit}`)
}

// Pipeline totals + ground-truth evaluation metrics for the KPI cards
export async function fetchMetrics() {
  return get("/api/metrics")
}

// Cheap liveness check used before swapping mock data for live data
export async function pingBackend() {
  try {
    const data = await get("/api/status")
    return data?.aiops_data === true
  } catch {
    return false
  }
}
