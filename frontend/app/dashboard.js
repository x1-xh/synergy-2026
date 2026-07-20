"use client"
import { useState, useEffect, useRef, useCallback } from "react"
import Link from "next/link"
import { pingBackend, fetchIncidents, fetchIncidentDetail, fetchMetrics, fetchStreamBatch } from "../lib/api"
import styles from "./dashboard.module.css"

const BASE_INTERVAL_MS = 600

/* ---------- Small visual primitives ---------- */

function Sparkline({ data, tone = "ink" }) {
  const w = 96
  const h = 28
  const max = Math.max(...data)
  const min = Math.min(...data)
  const range = Math.max(1, max - min)
  const step = w / (data.length - 1)
  const points = data.map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`)
  const path = `M${points.join(" L")}`
  const area = `${path} L${w},${h} L0,${h} Z`
  const color = tone === "primary" ? "var(--primary)" : "var(--ink-soft)"
  const gradId = `sg-${tone}-${Math.random().toString(36).substring(2, 6)}`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: "28px" }}>
      <defs>
        <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} />
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SeverityToken({ sev }) {
  const s = (sev || "INFO").toUpperCase()
  if (s === "FATAL" || s === "CRITICAL")
    return <span className={`${styles.sevPill} ${styles.sevPillFatal}`}>● FATAL</span>
  if (s === "ERROR") return <span className={`${styles.sevPill} ${styles.sevPillError}`}>● ERROR</span>
  if (s === "WARN" || s === "WARNING") return <span className={`${styles.sevPill} ${styles.sevPillWarn}`}>● WARN</span>
  return <span className={`${styles.sevPill} ${styles.sevPillInfo}`}>● INFO</span>
}

function ConfidenceRing({ value = 0, size = 64 }) {
  const r = size / 2 - 4
  const c = 2 * Math.PI * r
  const offset = c - (value / 100) * c
  return (
    <div style={{ width: size, height: size, position: "relative", flexShrink: 0 }}>
      <svg viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(-90deg)", width: "100%", height: "100%" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="4" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="#FFFFFF"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 800ms cubic-bezier(0.16,1,0.3,1)" }}
        />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
        <div style={{ fontFamily: "var(--font-serif)", fontSize: "18px", lineHeight: 1, color: "#FFFFFF" }}>{value}</div>
      </div>
    </div>
  )
}

/* ---------- Helpers for API data normalization ---------- */

function alertToRow(a) {
  return {
    time: (a.timestamp || "").slice(11, 19),
    sev: a.severity || "WARN",
    src: a.service || "unknown",
    msg: (a.message || "").slice(0, 120),
    focus: a.severity === "FATAL" || a.severity === "ERROR",
  }
}

function confidencePct(inc) {
  const raw = inc.confidence ?? inc.confidence_score ?? 0
  return Math.round(raw <= 1 ? raw * 100 : raw)
}

/* ---------- Live Dashboard Page ---------- */

export default function DashboardPage() {
  const [stream, setStream]       = useState([])
  const [incidents, setIncidents] = useState([])
  const [kpiData, setKpiData]     = useState([])
  const [focusIdx, setFocusIdx]   = useState(0)
  const [activeTab, setActiveTab] = useState("LIVE")
  const [isPlaying, setIsPlaying] = useState(false)
  const [speed, setSpeed]         = useState(1)
  const [ackedIds, setAckedIds]   = useState([])
  const [runbookModalInc, setRunbookModalInc] = useState(null)
  const [isOffline, setIsOffline] = useState(true)
  const [isLoading, setIsLoading] = useState(true)
  const [isUploading, setIsUploading] = useState(false)
  const timerRef = useRef(null)

  // Replay buffer fed from /api/stream
  const streamCursor = useRef(0)
  const alertBuffer = useRef([])
  const refilling = useRef(false)

  const refillBuffer = useCallback(() => {
    if (refilling.current) return
    refilling.current = true
    fetchStreamBatch(streamCursor.current, 120)
      .then((b) => {
        alertBuffer.current.push(...(b.alerts || []))
        streamCursor.current = b.next_cursor ?? 0
      })
      .catch(() => {})
      .finally(() => { refilling.current = false })
  }, [])

  // On mount: load real AIOps data or show offline state
  useEffect(() => {
    let cancelled = false
    async function loadLiveData() {
      if (!(await pingBackend())) {
        if (!cancelled) { setIsLoading(false); setIsOffline(true) }
        return
      }
      try {
        const [incs, mets, batch] = await Promise.all([
          fetchIncidents(), fetchMetrics(), fetchStreamBatch(0, 120),
        ])
        if (cancelled) return
        if (!incs.length) { setIsLoading(false); return }

        setIncidents(incs)
        setFocusIdx(0)
        setKpiData(buildKpis(mets?.pipeline, mets?.evaluation))
        streamCursor.current = batch.next_cursor ?? 0
        alertBuffer.current = batch.alerts || []
        setStream((batch.alerts || []).slice(-12).reverse().map(alertToRow))
        setIsOffline(false)
      } catch (err) {
        console.error("live data load failed", err)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    loadLiveData()
    return () => { cancelled = true }
  }, [])

  function buildKpis(p, eval_) {
    if (!p) return []
    const svcDet = eval_?.detection_rate_service_matched
    return [
      { label: "Noise Reduction", value: String(p.noise_reduction ?? "—"), suffix: "%", tone: "primary",
        trend: [30, 34, 40, 38, 46, 52, 58, 62, 68, 74, 82, 88, 94, 98] },
      { label: "Raw Alerts", value: (p.total_alerts ?? 0).toLocaleString(), delta: "AIOps 2022",
        trend: [60, 62, 58, 65, 70, 68, 74, 80, 77, 82, 88, 92, 96, 100] },
      { label: "Correlated", value: String(p.total_incidents ?? 0), delta: "from pipeline",
        trend: [10, 12, 14, 16, 20, 22, 26, 30, 34, 36, 40, 44, 48, 52] },
      { label: "Suppressed", value: (p.suppressed ?? 0).toLocaleString(), delta: `${p.noise_reduction ?? 0}% of stream`,
        trend: [40, 48, 55, 60, 66, 70, 74, 78, 82, 86, 90, 94, 97, 100] },
      ...(svcDet != null ? [{
        label: "Detection·svc", value: String(svcDet), suffix: "%", delta: "svc-matched",
        trend: [80, 82, 85, 84, 87, 89, 90, 92, 94, 95, 96, 97, 98, 99], tone: "primary"
      }] : []),
    ]
  }

  // Fetch full incident detail when focus changes (only for the timeline)
  const focusId = incidents[focusIdx]?.incident_id
  useEffect(() => {
    if (!focusId) return
    const inc = incidents.find((i) => i.incident_id === focusId)
    if (!inc || inc.timeline) return
    let cancelled = false
    fetchIncidentDetail(focusId)
      .then((det) => {
        if (cancelled || !det) return
        const timeline = (det.member_alerts || []).slice(0, 8).map((a, i) => ({
          t: (a.timestamp || "").slice(11, 19),
          d: `${a.severity} · ${(a.message || "").slice(0, 90)}`,
          now: i === 0,
        }))
        setIncidents((prev) => prev.map((p) =>
          p.incident_id === focusId ? { ...p, timeline, summary: det.explanation } : p))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [focusId])

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("http://localhost:8000/api/upload", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (data.status === "success" && data.incidents) {
        setIncidents(data.incidents);
        setFocusIdx(0);
        setKpiData((prev) => {
          const newKpis = [...prev];
          const reduction = (100 - (data.clusters_count / data.total_alerts * 100)).toFixed(1);
          if (newKpis[0]) newKpis[0] = { ...newKpis[0], value: reduction };
          if (newKpis[1]) newKpis[1] = { ...newKpis[1], value: data.total_alerts.toLocaleString() };
          if (newKpis[2]) newKpis[2] = { ...newKpis[2], value: data.clusters_count < 10 ? `0${data.clusters_count}` : String(data.clusters_count) };
          return newKpis;
        });
      }
    } catch (err) {
      console.error("Upload failed", err);
    } finally {
      setIsUploading(false);
      e.target.value = null;
    }
  };

  // Replay timer
  const stopReplay = useCallback(() => {
    clearInterval(timerRef.current)
  }, [])

  const startReplay = useCallback((spd) => {
    stopReplay()
    const interval = Math.floor(BASE_INTERVAL_MS / spd)
    timerRef.current = setInterval(() => {
      const gen = alertBuffer.current.shift()
      if (!gen) { refillBuffer(); return }
      if (alertBuffer.current.length < 20) refillBuffer()

      setStream((prev) => [alertToRow(gen), ...prev.slice(0, 50)])
    }, interval)
  }, [stopReplay, refillBuffer])

  const handleSpeedChange = (newSpd) => {
    setSpeed(newSpd)
    if (isPlaying) startReplay(newSpd)
  }

  const togglePlay = () => {
    if (isPlaying) { stopReplay(); setIsPlaying(false) }
    else { setIsPlaying(true); startReplay(speed) }
  }

  useEffect(() => () => stopReplay(), [stopReplay])

  // Scroll reveal
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) entry.target.classList.add(styles.revealVisible)
        })
      },
      { threshold: 0.08, rootMargin: "0px 0px -20px 0px" }
    )
    const elements = document.querySelectorAll(`.${styles.reveal}`)
    elements.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [incidents, stream, activeTab])

  const rawFocus = incidents[focusIdx] || incidents[0] || {}
  const activeFocusInc = rawFocus.incident_id ? {
    incident_id: rawFocus.incident_id,
    title: rawFocus.title || "Incident",
    confidence_score: confidencePct(rawFocus),
    suppressed_count: rawFocus.suppressed_count ?? rawFocus.member_count ?? 0,
    detection_time: rawFocus.detection_time || "—",
    mttr_estimate: rawFocus.mttr_estimate || "—",
    summary: rawFocus.summary || rawFocus.explanation || "",
    tags: rawFocus.tags || [],
    timeline: rawFocus.timeline || [],
  } : null

  const queueIncidents = incidents.length > 1
    ? incidents.slice(1).map((inc, idx) => ({
        id: inc.incident_id || `inc_${idx + 1}`,
        title: inc.title || "Incident",
        confidence: confidencePct(inc),
        alerts: inc.suppressed_count ?? inc.member_count ?? 0,
        age: `${(idx + 1) * 3}m`,
        host: (inc.root_cause_alert?.service || inc.tags?.[0] || "unknown").replace(/-\d+$/, ''),
        rawIdx: idx + 1,
      }))
    : []

  /* ---------- Offline fallback UI ---------- */

  if (isLoading) {
    return (
      <div className={styles.root}>
        <header className={styles.header}>
          <div className={styles.headerInner}>
            <div className={styles.headerLeft}>
              <Link href="/" className={styles.logo}>
                <span className={styles.logoMark}>⬡</span>
                CLARITY<span className={styles.logoLight}>OPS</span>
              </Link>
            </div>
          </div>
        </header>
        <div style={{ display: "grid", placeItems: "center", height: "80vh", color: "var(--subtle)" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "40px", marginBottom: "16px", opacity: 0.5 }}>⬡</div>
            <div style={{ fontSize: "18px", fontFamily: "var(--font-mono)" }}>Connecting to AIOps backend...</div>
          </div>
        </div>
      </div>
    )
  }

  if (isOffline) {
    return (
      <div className={styles.root}>
        <header className={styles.header}>
          <div className={styles.headerInner}>
            <div className={styles.headerLeft}>
              <Link href="/" className={styles.logo}>
                <span className={styles.logoMark}>⬡</span>
                CLARITY<span className={styles.logoLight}>OPS</span>
              </Link>
              <nav className={styles.nav}>
                <Link href="/mockdash" className={styles.navLink}>Mock Dashboard →</Link>
              </nav>
            </div>
            <div className={styles.headerRight}>
              <span className={styles.dataBadge}>● Offline</span>
            </div>
          </div>
        </header>
        <div style={{ display: "grid", placeItems: "center", height: "80vh", padding: "0 24px" }}>
          <div style={{ textAlign: "center", maxWidth: "480px" }}>
            <div style={{ fontSize: "56px", marginBottom: "24px", opacity: 0.3 }}>⬡</div>
            <h1 style={{ fontSize: "24px", fontWeight: 600, marginBottom: "12px", color: "var(--ink)" }}>
              Backend Offline
            </h1>
            <p style={{ fontSize: "15px", lineHeight: 1.6, color: "var(--subtle)", marginBottom: "32px" }}>
              The AIOps backend is not reachable at <code style={{ background: "var(--cream)", padding: "2px 8px", borderRadius: "4px", fontSize: "13px" }}>localhost:8000</code>.
              Start the pipeline data server to view 931 real AIOps incidents from the 2022 challenge dataset.
            </p>
            <div style={{ display: "flex", gap: "12px", justifyContent: "center", flexWrap: "wrap" }}>
              <Link href="/mockdash" style={{
                display: "inline-block", padding: "10px 24px", borderRadius: "8px",
                background: "var(--ink)", color: "#fff", fontFamily: "var(--font-mono)",
                fontSize: "13px", textDecoration: "none",
              }}>
                Mock Dashboard →
              </Link>
              <button onClick={() => window.location.reload()}
                style={{
                  display: "inline-block", padding: "10px 24px", borderRadius: "8px",
                  border: "1px solid var(--hairline)", background: "transparent",
                  color: "var(--ink)", fontFamily: "var(--font-mono)", fontSize: "13px", cursor: "pointer",
                }}>
                ↻ Retry
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  /* ---------- Main dashboard ---------- */

  return (
    <div className={styles.root}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.headerLeft}>
            <Link href="/" className={styles.logo}>
              <span className={styles.logoMark}>⬡</span>
              CLARITY<span className={styles.logoLight}>OPS</span>
            </Link>

            <nav className={styles.nav}>
              <button
                onClick={() => { setActiveTab("LIVE"); document.getElementById("kpi-section")?.scrollIntoView({ behavior: "smooth" }) }}
                className={`${styles.navLink} ${activeTab === "LIVE" ? styles.navLinkActive : ""}`}
                style={{ background: "none", border: "none", font: "inherit", cursor: "pointer" }}
              >LIVE VIEW</button>
            </nav>
          </div>

          <div className={styles.headerRight}>
            <button onClick={togglePlay}
              className={`${styles.playControlBtn} ${isPlaying ? styles.playControlBtnActive : ""}`}>
              <span style={{ fontSize: "13px", lineHeight: 1 }}>{isPlaying ? "⏸" : "▶"}</span>
              <span>{isPlaying ? "Pause Stream" : "Play Stream"}</span>
            </button>

            <div className={styles.replayWrap}>
              <span className={styles.replayLabel}>Speed</span>
              <div className={styles.replayGroup}>
                {[1, 5, 10].map((s) => (
                  <button key={s} onClick={() => handleSpeedChange(s)}
                    className={`${styles.replayBtn} ${speed === s ? styles.replayBtnActive : ""}`}>{s}×</button>
                ))}
              </div>
            </div>

            <div className={styles.uploadWrapper}>
              <input type="file" id="logUpload" className={styles.uploadInput} accept=".log,.csv,.json,.txt" onChange={handleFileUpload} disabled={isUploading} />
              <label htmlFor="logUpload" className={`${styles.uploadLabel} ${isUploading ? styles.uploadLoading : ""}`}>
                {isUploading ? "Processing..." : "↑ Upload Logs"}
              </label>
            </div>

            <span className={`${styles.dataBadge} ${styles.dataBadgeLive}`} title="AIOps 2022 dataset via FastAPI backend">
              ● AIOps Live
            </span>
          </div>
        </div>
      </header>

      {/* Hero KPI strip */}
      <section className={`${styles.kpiSection} ${styles.reveal}`} id="kpi-section">
        <div className={styles.headerRow}>
          <div>
            <div className={styles.timeBadge}>Operations · AIOps 2022 · Multi-week</div>
            <h1 className={styles.heroTitle}>
              Signal, <em className={styles.heroItalic}>not</em> noise.
            </h1>
          </div>
          <div className={styles.regionGroup}>
            <div style={{ textAlign: "right" }}>
              <div className={styles.regionLabel}>Pipeline</div>
              <div className={styles.regionVal}>Service-aware clustering</div>
            </div>
            <div className={styles.headerDivider} />
            <div>
              <div className={styles.regionLabel}>Incidents</div>
              <div className={styles.regionVal}>{incidents.length.toLocaleString()} clusters</div>
            </div>
          </div>
        </div>

        <div className={styles.kpiGrid}>
          {kpiData.map((k, i) => {
            const featured = k.tone === "primary"
            return (
              <div key={k.label} className={featured ? styles.kpiCardFeatured : styles.kpiCardWhite}
                style={{ animationDelay: `${i * 60}ms` }}>
                {featured && <div style={{ position: "absolute", inset: 0, opacity: 0.4, pointerEvents: "none",
                  background: "radial-gradient(300px 120px at 100% 0%, rgba(255,255,255,0.35), transparent 60%)" }} />}
                <div className={styles.kpiTopRow}>
                  <div className={featured ? styles.kpiLabelFeatured : styles.kpiLabelWhite}>{k.label}</div>
                  {k.delta && <div className={featured ? styles.kpiDeltaFeatured : styles.kpiDeltaWhite}>↑ {k.delta}</div>}
                </div>
                <div className={styles.kpiValueRow}>
                  <span className={featured ? styles.kpiValueFeatured : styles.kpiValueWhite}>{k.value}</span>
                  {k.suffix && <span className={featured ? styles.kpiSuffixFeatured : styles.kpiSuffixWhite}>{k.suffix}</span>}
                </div>
                {k.trend && <div className={styles.kpiSparkWrap}><Sparkline data={k.trend} tone={featured ? "primary" : "ink"} /></div>}
              </div>
            )
          })}
        </div>
      </section>

      {/* Workspace */}
      <main className={styles.workspaceGrid}>
        <div className={styles.leftColumn}>
          {/* Raw stream card */}
          <section className={`${styles.streamCard} ${styles.reveal}`}>
            <div className={styles.streamHeader}>
              <div className={styles.streamHeaderTop}>
                <div className={styles.streamTitleGroup}>
                  <div className={styles.streamTagRow}>
                    <span className={styles.streamNum}>01</span>
                    <span className={styles.streamLine} />
                    <span className={styles.streamTag}>Ingest</span>
                  </div>
                  <h2 className={styles.streamTitle}>
                    Raw signal <em className={styles.streamItalic}>stream</em>
                  </h2>
                </div>
                <div className={styles.streamStatsGroup}>
                  <div className={styles.streamHeaderSparkline}>
                    <Sparkline data={[42, 48, 52, 58, 64, 60, 68, 75, 72, 80, 85, 92, 98, 104]} tone="primary" />
                    <div className={styles.streamHeaderSparklineLabel}>EVENTS / S</div>
                  </div>
                  <div className={styles.streamStats}>
                    <div className={styles.statItem}>
                      <div className={styles.statLabel}>Throughput</div>
                      <div className={styles.statValue}>4.2k <span className={styles.statUnit}>eps</span></div>
                    </div>
                    <div className={styles.statDivider} />
                    <div className={styles.statItem}>
                      <div className={styles.statLabel}>Latency</div>
                      <div className={styles.statValue}>12<span className={styles.statUnit}>ms</span></div>
                    </div>
                  </div>
                </div>
              </div>
              <div className={styles.streamFilterBar}>
                <div className={styles.streamFilterPills}>
                  <span className={`${styles.filterPill} ${styles.filterPillFatal}`}>● FATAL</span>
                  <span className={`${styles.filterPill} ${styles.filterPillError}`}>● ERROR</span>
                  <span className={`${styles.filterPill} ${styles.filterPillWarn}`}>● WARN</span>
                  <span className={`${styles.filterPill} ${styles.filterPillInfo}`}>● INFO</span>
                </div>
                <div className={styles.streamBufferStatus}>
                  <span className={styles.bufferDot} />
                  <span className={styles.bufferStreaming}>STREAMING</span>
                  <span className={styles.bufferDetails}> · buffer {alertBuffer.current.length} · win 60s</span>
                </div>
              </div>
            </div>

            <div className={styles.streamList}>
              {stream.length === 0 && (
                <div style={{ padding: "20px", textAlign: "center", color: "var(--subtle)", fontFamily: "var(--font-mono)", fontSize: "12px" }}>
                  Stream idle — press ▶ to replay AIOps alerts
                </div>
              )}
              {stream.map((r, i) => {
                const idxHex = (i + 1).toString(16).toUpperCase().padStart(2, "0")
                return (
                  <div key={`${r.time}-${i}`} onClick={() => setFocusIdx(i)}
                    className={`${styles.streamRow} ${r.focus ? styles.streamRowFocus : ""}`}>
                    <span className={styles.stIdx}>{idxHex}</span>
                    <span className={styles.stTime}>{r.time}</span>
                    <SeverityToken sev={r.sev} />
                    <span className={styles.stSrc}>[{r.src}]</span>
                    <span className={styles.stMsg}>{r.msg}</span>
                    {r.focus && <span className={styles.stCorrelatedBadge}>● CORRELATED</span>}
                  </div>
                )
              })}
            </div>
          </section>

          {/* Queue */}
          <div className={`${styles.bottomGrid} ${styles.reveal}`}>

            <section className={styles.queueCard}>
              <div style={{ marginBottom: "16px" }}>
                <div className={styles.topTagRow}>
                  <span className={styles.topNum}>04</span>
                  <span className={styles.topLine} style={{ background: "var(--hairline)" }} />
                  <span className={styles.topLabel} style={{ color: "var(--subtle)" }}>Queue</span>
                </div>
                <h3 className={styles.queueTitle}>Watching</h3>
              </div>
              <div className={styles.queueList}>
                {queueIncidents.length === 0 && (
                  <div style={{ padding: "16px", textAlign: "center", color: "var(--subtle)", fontFamily: "var(--font-mono)", fontSize: "11px" }}>
                    No queued incidents
                  </div>
                )}
                {queueIncidents.map((inc) => {
                  const isIncAcked = ackedIds.includes(inc.id)
                  return (
                    <button key={inc.id} onClick={() => setFocusIdx(inc.rawIdx || 0)}
                      className={styles.queueBtn}
                      style={isIncAcked ? { borderLeft: "3px solid #D97706", background: "var(--cream)" } : {}}>
                      <div className={styles.queueBtnTop}>
                        <span className={styles.queueBtnId} style={isIncAcked ? { color: "#C2410C" } : {}}>
                          {isIncAcked ? `✓ ${inc.id} [ACK]` : inc.id}
                        </span>
                        <span className={styles.queueBtnAge}>{inc.age} · {inc.alerts} alerts</span>
                      </div>
                      <div className={styles.queueBtnTitle}>{inc.title}</div>
                      <div className={styles.queueBtnBottom}>
                        <span className={styles.queueBtnHost}>{inc.host}</span>
                        <div className={styles.queueConfidenceGroup}>
                          <div className={styles.queueBarBg}>
                            <div className={styles.queueBarFill} style={{ width: `${inc.confidence}%` }} />
                          </div>
                          <span className={styles.queueConfidenceVal}>{inc.confidence}%</span>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            </section>
          </div>
        </div>

        {/* Focused incident rail */}
        <aside className={`${styles.focusAside} ${styles.reveal}`}>
          <div className={styles.focusCardSticky}>
            <div className={styles.focusHeader}>
              <div style={{ position: "absolute", top: "-64px", right: "-64px", width: "224px", height: "224px",
                borderRadius: "50%", opacity: 0.3, pointerEvents: "none",
                background: "radial-gradient(circle, #FFFFFF, transparent 70%)" }} />
              <div className={styles.focusHeaderTop}>
                <div className={styles.focusTagRow}>
                  <span className={styles.focusNum}>02</span>
                  <span className={styles.focusLine} />
                  <span className={styles.focusLabel}>Focus</span>
                </div>
                <span className={`${styles.focusStatusBadge} ${ackedIds.includes(activeFocusInc?.incident_id) ? styles.focusStatusAcked : ""}`}>
                  {ackedIds.includes(activeFocusInc?.incident_id) ? "✓ Acknowledged" : `Active · ${focusIdx + 1} of ${incidents.length}`}
                </span>
              </div>
              <div className={styles.focusHeaderMain}>
                <div style={{ minWidth: 0 }}>
                  <span className={styles.focusId}>{activeFocusInc?.incident_id || "—"}</span>
                  <h3 className={styles.focusTitle}>{activeFocusInc?.title || "Select an incident"}</h3>
                </div>
                <ConfidenceRing value={activeFocusInc?.confidence_score || 0} />
              </div>
            </div>

            <div className={styles.focusBody}>
              <p className={styles.focusExplanation}>
                {activeFocusInc?.summary || "Click an incident from the stream or queue to see details."}
              </p>

              <div className={styles.focusMetricsGrid}>
                {[
                  { l: "Suppressed", v: activeFocusInc?.suppressed_count ?? "—" },
                  { l: "Detection",  v: activeFocusInc?.detection_time ?? "—" },
                  { l: "MTTR est.",  v: activeFocusInc?.mttr_estimate ?? "—" },
                ].map((m) => (
                  <div key={m.l} className={styles.metricBox}>
                    <div className={styles.metricBoxLabel}>{m.l}</div>
                    <div className={styles.metricBoxVal}>{m.v}</div>
                  </div>
                ))}
              </div>

              {(activeFocusInc?.timeline?.length > 0) && (
                <div className={styles.timelineSection}>
                  <div className={styles.timelineHeading}>Timeline</div>
                  <div className={styles.timelineList}>
                    {activeFocusInc.timeline.map((e, i) => (
                      <div key={i} className={styles.timelineItem}>
                        <div className={styles.timelineDotWrap}>
                          <span className={`${styles.timelineDot} ${e.now ? styles.timelineDotNow : ""}`} />
                          {i < activeFocusInc.timeline.length - 1 && <span className={styles.timelineConnector} />}
                        </div>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className={styles.timelineTime}>{e.t}</div>
                          <div className={styles.timelineDesc}>{e.d}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {(activeFocusInc?.tags?.length > 0) && (
                <div className={styles.chipsRow}>
                  {activeFocusInc.tags.map((t) => (
                    <span key={t} className={styles.chip}>{t}</span>
                  ))}
                </div>
              )}

              <div className={styles.actionsGrid}>
                <button onClick={() => {
                  const id = activeFocusInc?.incident_id
                  if (!id) return
                  if (ackedIds.includes(id)) {
                    setAckedIds(prev => prev.filter(x => x !== id))
                  } else {
                    setAckedIds(prev => [...new Set([...prev, id])])
                  }
                }} className={`${styles.actionBtnMain} ${activeFocusInc && ackedIds.includes(activeFocusInc.incident_id) ? styles.actionBtnAcked : ""}`}>
                  {activeFocusInc && ackedIds.includes(activeFocusInc.incident_id) ? "✓ Acknowledged" : "Acknowledge"}
                </button>
                <button onClick={() => setRunbookModalInc(activeFocusInc)}
                  disabled={!activeFocusInc}
                  className={styles.actionBtnSecondary}>
                  Runbook →
                </button>
              </div>
            </div>
          </div>
        </aside>
      </main>

      {runbookModalInc && (
        <div className={styles.runbookModalBackdrop} onClick={() => setRunbookModalInc(null)}>
          <div className={styles.runbookModalCard} onClick={(e) => e.stopPropagation()}>
            <div className={styles.runbookModalHeader}>
              <div>
                <div className={styles.topTagRow}>
                  <span className={styles.topNum}>05</span>
                  <span className={styles.topLine} />
                  <span className={styles.topLabel}>Runbook Execution</span>
                </div>
                <h3 className={styles.runbookModalTitle}>Automated Remediation · {runbookModalInc.incident_id}</h3>
              </div>
              <button className={styles.runbookCloseBtn} onClick={() => setRunbookModalInc(null)}>✕</button>
            </div>
            <div className={styles.runbookModalBody}>
              <div className={styles.runbookTargetBox}>
                <span className={styles.runbookTargetLabel}>Target Anomaly:</span>
                <span className={styles.runbookTargetVal}>{runbookModalInc.title}</span>
              </div>
              <div className={styles.runbookStepsList}>
                <div className={styles.runbookStepItem}>
                  <span className={styles.runbookStepNum}>Step 1</span>
                  <div className={styles.runbookStepInfo}>
                    <div className={styles.runbookStepTitle}>Isolate affected hardware interface</div>
                    <div className={styles.runbookStepDesc}>Send SNMP trap to target switch port and reroute active block replication through failover NIC.</div>
                  </div>
                  <span className={styles.runbookStepStatus}>Ready</span>
                </div>
                <div className={styles.runbookStepItem}>
                  <span className={styles.runbookStepNum}>Step 2</span>
                  <div className={styles.runbookStepInfo}>
                    <div className={styles.runbookStepTitle}>Flush service heartbeat queue</div>
                    <div className={styles.runbookStepDesc}>Execute metadata checkpoint sync and clear stale connection locks exceeding the 30s threshold.</div>
                  </div>
                  <span className={styles.runbookStepStatus}>Ready</span>
                </div>
                <div className={styles.runbookStepItem}>
                  <span className={styles.runbookStepNum}>Step 3</span>
                  <div className={styles.runbookStepInfo}>
                    <div className={styles.runbookStepTitle}>Verify downstream cluster health</div>
                    <div className={styles.runbookStepDesc}>Run synthetic verification checks against active cluster dependencies until p99 latency &lt; 15ms.</div>
                  </div>
                  <span className={styles.runbookStepStatus}>Ready</span>
                </div>
              </div>
              <button className={styles.runbookExecuteBtn}
                onClick={() => {
                  setAckedIds(prev => [...new Set([...prev, runbookModalInc.incident_id])])
                  setRunbookModalInc(null)
                }}>
                ⚡ Execute Remediation Pipeline & Resolve
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer status bar */}
      <footer className={styles.footerBar}>
        <div className={styles.footerLeft}>
          <span className={styles.footerDot}>◆</span>
          <span>TERMINAL · 0x88F2A</span>
          <span className={styles.footerSub}>INGEST 4.2K EPS</span>
          <span className={styles.footerSub}>LATENCY 12MS</span>
          <span className={styles.footerRegion}>AIOps 2022 · {incidents.length} incidents</span>
        </div>
        <div className={styles.footerRight}>
          <span onClick={() => { setStream([]); setIsPlaying(false); setFocusIdx(0); setAckedIds([]); setRunbookModalInc(null) }}
            className={styles.footerActionPrimary}>[R] RESET</span>
          <span onClick={() => setRunbookModalInc(null)} className={styles.footerAction}>[ESC] DISMISS</span>
        </div>
      </footer>
    </div>
  )
}
