"use client"
import { useState, useEffect, useRef, useCallback } from "react"
import Link from "next/link"
import { INITIAL_ALERTS, INCIDENTS, generateStreamAlert } from "../lib/mockData"
import styles from "./dashboard.module.css"

const BASE_INTERVAL_MS = 600

const kpis = [
  { label: "Noise Reduction", value: "98.4", suffix: "%", delta: "+2.1", trend: [30, 34, 40, 38, 46, 52, 58, 62, 68, 74, 82, 88, 94, 98], tone: "primary" },
  { label: "Raw Alerts", value: "14,292", delta: "+842 / hr", trend: [60, 62, 58, 65, 70, 68, 74, 80, 77, 82, 88, 92, 96, 100] },
  { label: "Correlated", value: "04", delta: "2 escalated", trend: [10, 12, 14, 16, 20, 22, 26, 30, 34, 36, 40, 44, 48, 52] },
  { label: "Suppressed", value: "14,018", delta: "98.4% of stream", trend: [40, 48, 55, 60, 66, 70, 74, 78, 82, 86, 90, 94, 97, 100] },
  { label: "Precision", value: "99.1", suffix: "%", delta: "+0.4 wk", trend: [80, 82, 85, 84, 87, 89, 90, 92, 94, 95, 96, 97, 98, 99], tone: "primary" },
]

const initialStream = [
  { time: "14:20:01.002", sev: "FATAL", src: "hdfs.NameNode", msg: "OutOfMemoryError in Java heap space during createBlock", focus: false },
  { time: "14:20:00.891", sev: "WARN",  src: "zookeeper.Client", msg: "Session 0x12a9b3 timed out — awaiting reconnect", focus: false },
  { time: "14:19:59.774", sev: "INFO",  src: "spark.Driver", msg: "Task 142.0 stage 12.0 (TID 2441) finished 142 ms · 10.0.4.16", focus: false },
  { time: "14:19:58.442", sev: "ERROR", src: "hdfs.DataNode", msg: "Block report failed — connection refused /10.0.1.42:50010", focus: true },
  { time: "14:19:57.331", sev: "WARN",  src: "spark.Executor", msg: "Memory usage 88.2% on executor-id 14 — triggering GC", focus: false },
  { time: "14:19:56.009", sev: "INFO",  src: "yarn.ResourceMgr", msg: "Allocating container_1623819_0012 for user: analytics", focus: false },
  { time: "14:19:54.992", sev: "INFO",  src: "hdfs.Client", msg: "Closed output stream for file /user/log/temp_01", focus: false },
  { time: "14:19:53.221", sev: "INFO",  src: "spark.Shuffle", msg: "Shuffle map stage 11.0 completed in 1.42 s · 32 tasks", focus: false },
  { time: "14:19:52.108", sev: "WARN",  src: "hdfs.FSNamesystem", msg: "Slow BlockReceiver — 1180 ms to write block BP-2091", focus: false },
  { time: "14:19:50.887", sev: "ERROR", src: "hdfs.DataNode", msg: "IOException: connection reset by peer reading blk_1073", focus: false },
  { time: "14:19:49.441", sev: "INFO",  src: "zookeeper.Server", msg: "Session 0x12ab04 established · timeout 30000", focus: false },
  { time: "14:19:48.002", sev: "INFO",  src: "spark.TaskSet", msg: "Starting task 15.0 stage 12.0 (TID 2443) · 10.0.4.17", focus: false },
]

const fallbackSecondaryIncidents = [
  { id: "INC-8819", title: "Spark Driver OutOfMemory Pattern", confidence: 72, alerts: 89, age: "4m", host: "spark-drv-07" },
  { id: "INC-8815", title: "ZooKeeper Quorum Timeout", confidence: 68, alerts: 34, age: "12m", host: "zk-quorum-02" },
  { id: "INC-8811", title: "Disk I/O Saturation · /data/vol3", confidence: 45, alerts: 12, age: "22m", host: "node-091" },
]

/* ---------- Small visual primitives from index (1).tsx ---------- */

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
    return (
      <span className={`${styles.sevPill} ${styles.sevPillFatal}`}>
        ● FATAL
      </span>
    )
  if (s === "ERROR") return <span className={`${styles.sevPill} ${styles.sevPillError}`}>● ERROR</span>
  if (s === "WARN" || s === "WARNING") return <span className={`${styles.sevPill} ${styles.sevPillWarn}`}>● WARN</span>
  return <span className={`${styles.sevPill} ${styles.sevPillInfo}`}>● INFO</span>
}

function ConfidenceRing({ value = 94, size = 64 }) {
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

function getTopologyInfo(activeFocusInc, latestStreamSrc) {
  const title = (activeFocusInc?.title || "").toLowerCase()
  const tags = (activeFocusInc?.tags || []).map(t => typeof t === "string" ? t.toLowerCase() : "")
  const isSpark = title.includes("spark") || tags.includes("spark") || tags.includes("oom")
  const isZk = title.includes("zookeeper") || title.includes("quorum") || tags.includes("zookeeper")
  const isDisk = title.includes("disk") || title.includes("vol3") || tags.includes("disk_io")
  const isNameNode = title.includes("namenode") || title.includes("metadata")

  let rack = "Rack-B"
  let affectedText = "6 nodes affected"
  let highlightText = "1 root · 2 downstream"
  
  let nodes = [
    { id: "nn", x: 50, y: 30, label: "NameNode", ring: true, alert: isNameNode, warn: isSpark },
    { id: "dn1", x: 15, y: 70, label: "node-042", alert: !isSpark && !isZk && !isNameNode && !isDisk, warn: isDisk },
    { id: "dn2", x: 35, y: 90, label: "node-043", alert: isSpark },
    { id: "dn3", x: 62, y: 92, label: "node-091", alert: isDisk, warn: !isDisk && !isSpark },
    { id: "zk", x: 82, y: 65, label: "zk-quorum", alert: isZk || (!isSpark && !isDisk && !isNameNode), warn: isNameNode },
    { id: "sd", x: 88, y: 22, label: "spark-drv", alert: isSpark },
  ]

  let edges = [
    ["nn", "dn1", !isSpark && !isZk && !isDisk],
    ["nn", "dn2", isSpark],
    ["nn", "dn3", isDisk],
    ["nn", "zk", isZk || (!isSpark && !isDisk)],
    ["nn", "sd", isSpark],
    ["dn1", "zk", !isSpark && !isZk && !isDisk],
    ["sd", "dn2", isSpark],
    ["zk", "dn3", isZk]
  ]

  let metrics = {
    nodes: { count: "6", total: "128" },
    replicas: { count: "17", status: "unsafe" },
    jobs: { count: "3", status: "stalled" }
  }
  let affectedPath = [
    { node: "node-042", role: "ROOT", impact: "—", tone: "root" },
    { node: "zk-quorum", role: "DOWNSTREAM", impact: "+340ms", tone: "root" },
    { node: "node-091", role: "DOWNSTREAM", impact: "+120ms", tone: "degraded" }
  ]

  if (isSpark) {
    rack = "Rack-A"
    affectedText = "5 nodes affected"
    highlightText = "1 root · 3 downstream"
    metrics = {
      nodes: { count: "5", total: "128" },
      replicas: { count: "12", status: "unsafe" },
      jobs: { count: "8", status: "stalled" }
    }
    affectedPath = [
      { node: "spark-drv-07", role: "ROOT", impact: "—", tone: "root" },
      { node: "node-043", role: "DOWNSTREAM", impact: "+410ms", tone: "root" },
      { node: "node-042", role: "DOWNSTREAM", impact: "+180ms", tone: "degraded" }
    ]
  } else if (isZk) {
    rack = "Rack-C"
    affectedText = "6 nodes affected"
    highlightText = "2 root · 2 downstream"
    metrics = {
      nodes: { count: "6", total: "128" },
      replicas: { count: "24", status: "unsafe" },
      jobs: { count: "2", status: "stalled" }
    }
    affectedPath = [
      { node: "zk-quorum-02", role: "ROOT", impact: "—", tone: "root" },
      { node: "node-091", role: "DOWNSTREAM", impact: "+520ms", tone: "root" },
      { node: "spark-drv", role: "DOWNSTREAM", impact: "+210ms", tone: "degraded" }
    ]
  } else if (isDisk) {
    rack = "Rack-D"
    affectedText = "4 nodes affected"
    highlightText = "1 root · 1 downstream"
    metrics = {
      nodes: { count: "4", total: "128" },
      replicas: { count: "8", status: "unsafe" },
      jobs: { count: "1", status: "stalled" }
    }
    affectedPath = [
      { node: "node-091", role: "ROOT", impact: "—", tone: "root" },
      { node: "zk-quorum", role: "DOWNSTREAM", impact: "+290ms", tone: "degraded" }
    ]
  } else if (isNameNode) {
    rack = "Rack-NN"
    affectedText = "6 nodes affected"
    highlightText = "1 root · 4 downstream"
    metrics = {
      nodes: { count: "6", total: "128" },
      replicas: { count: "32", status: "unsafe" },
      jobs: { count: "5", status: "stalled" }
    }
    affectedPath = [
      { node: "nn-primary", role: "ROOT", impact: "—", tone: "root" },
      { node: "node-042", role: "DOWNSTREAM", impact: "+480ms", tone: "root" },
      { node: "node-043", role: "DOWNSTREAM", impact: "+220ms", tone: "degraded" }
    ]
  }

  if (latestStreamSrc) {
    const srcLower = latestStreamSrc.toLowerCase()
    nodes = nodes.map(n => {
      if ((srcLower.includes("spark") && n.id === "sd") ||
          (srcLower.includes("zookeeper") && n.id === "zk") ||
          (srcLower.includes("namenode") && n.id === "nn") ||
          (srcLower.includes("datanode") && (n.id === "dn1" || n.id === "dn2" || n.id === "dn3"))) {
        return { ...n, alert: true }
      }
      return n
    })
  }

  return { rack, affectedText, highlightText, nodes, edges, metrics, affectedPath }
}

function TopologyMap({ nodes = [], edges = [] }) {
  const pos = (id) => nodes.find((n) => n.id === id) || { x: 50, y: 50 }
  return (
    <svg viewBox="0 0 100 110" style={{ width: "100%", height: "100%" }} preserveAspectRatio="xMidYMid meet">
      <defs>
        <radialGradient id="halo" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="oklch(0.68 0.19 45)" stopOpacity="0.45" />
          <stop offset="100%" stopColor="oklch(0.68 0.19 45)" stopOpacity="0" />
        </radialGradient>
      </defs>
      {edges.map(([a, b, hot], i) => {
        const p1 = pos(a)
        const p2 = pos(b)
        return (
          <line
            key={i}
            x1={p1.x}
            y1={p1.y}
            x2={p2.x}
            y2={p2.y}
            stroke={hot ? "oklch(0.68 0.19 45)" : "oklch(0.55 0.14 45 / 0.35)"}
            strokeWidth={hot ? 0.9 : 0.45}
            strokeDasharray={hot ? "1.5 1" : "0"}
            className={hot ? "co-draw" : ""}
          />
        )
      })}
      {nodes.map((n) => {
        const isTopNode = n.id === "nn" || n.id === "sd"
        const labelY = isTopNode ? n.y - 6.2 : n.y + 8.5
        return (
          <g key={n.id}>
            {n.alert && <circle cx={n.x} cy={n.y} r="8.5" fill="url(#halo)" />}
            <circle
              cx={n.x}
              cy={n.y}
              r={n.ring ? 3.6 : 2.8}
              fill={n.alert ? "oklch(0.68 0.19 45)" : n.warn ? "oklch(0.88 0.09 58)" : "oklch(0.22 0.035 40)"}
              stroke="oklch(0.975 0.022 65)"
              strokeWidth="0.8"
            />
            <text
              x={n.x}
              y={labelY}
              fontSize="4.8"
              fontWeight="700"
              textAnchor="middle"
              fill="#FFFFFF"
              stroke="oklch(0.16 0.03 40)"
              strokeWidth="1.5"
              paintOrder="stroke fill"
              style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.03em" }}
            >
              {n.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/* ---------- Main Dashboard Page ---------- */

export default function DashboardPage() {
  const [stream, setStream]             = useState(initialStream)
  const [incidents, setIncidents]       = useState(INCIDENTS)
  const [focusIdx, setFocusIdx]         = useState(0)
  const [activeTab, setActiveTab]       = useState("LIVE")
  const [isPlaying, setIsPlaying]       = useState(false)
  const [speed, setSpeed]               = useState(1)
  const [ackedIds, setAckedIds]         = useState([])
  const [runbookModalInc, setRunbookModalInc] = useState(null)

  const timerRef = useRef(null)

  // Computed display items
  const rawFocus = incidents[focusIdx] || incidents[0] || {}
  const activeFocusInc = {
    incident_id: rawFocus.incident_id || "INC-8821",
    title: rawFocus.title || "HDFS DataNode connection refusal cluster",
    confidence_score: Math.round((rawFocus.confidence ? rawFocus.confidence * (rawFocus.confidence <= 1 ? 100 : 1) : rawFocus.confidence_score) || 94),
    suppressed_count: rawFocus.suppressed_count || 412,
    detection_time: rawFocus.detection_time || "1.2s",
    mttr_estimate: rawFocus.mttr_estimate || "8m",
    summary: rawFocus.summary || rawFocus.explanation || "Cascading failure originating from node-042.rack-b after a primary NIC timeout. Correlation collapsed 412 alerts into a single root cause.",
    tags: rawFocus.tags || ["NIC_TIMEOUT", "HDFS", "Rack-B", "P1"],
    timeline: rawFocus.timeline || [
      { t: "14:20:01", d: "FATAL · NameNode heap exhausted", now: true },
      { t: "14:19:58", d: "Block report failed on /10.0.1.42" },
      { t: "14:19:52", d: "Slow BlockReceiver 1180ms" },
      { t: "14:18:47", d: "NIC timeout on node-042" },
    ]
  }

  const topologyInfo = getTopologyInfo(activeFocusInc, isPlaying ? stream[0]?.src : null)

  const queueIncidents = incidents.slice(1).length > 0
    ? incidents.slice(1).map((inc, idx) => ({
        id: inc.incident_id || `INC-881${9 - idx * 4}`,
        title: inc.title || "Infrastructure anomaly detected",
        confidence: Math.round((inc.confidence ? inc.confidence * (inc.confidence <= 1 ? 100 : 1) : inc.confidence_score) || 72),
        alerts: inc.suppressed_count || 34,
        age: `${(idx + 1) * 3}m`,
        host: inc.host || "node-042",
        rawIdx: idx + 1
      }))
    : fallbackSecondaryIncidents.map((f, idx) => ({ ...f, rawIdx: idx + 1 }))

  const stopReplay = useCallback(() => {
    clearInterval(timerRef.current)
  }, [])

  const startReplay = useCallback((spd) => {
    stopReplay()
    const interval = Math.floor(BASE_INTERVAL_MS / spd)
    timerRef.current = setInterval(() => {
      const gen = generateStreamAlert()
      const newTime = gen.timestamp ? gen.timestamp.slice(11, 19) : new Date().toISOString().slice(11, 19)
      const newSev = gen.severity || "WARN"
      const newSrc = gen.service || "hdfs.DataNode"
      const newMsg = gen.message || gen.title || "Signal check anomaly"

      setStream((prev) => {
        const newRow = {
          time: newTime,
          sev: newSev,
          src: newSrc,
          msg: newMsg,
          focus: Math.random() < 0.2
        }
        return [newRow, ...prev.slice(0, 50)]
      })

      // Dynamically update right-side incidents & clusters
      setIncidents((prev) => {
        const updated = [...prev]
        if (updated.length > 0) {
          const top = { ...updated[0] }
          top.suppressed_count = (top.suppressed_count || 412) + Math.floor(Math.random() * 3) + 1
          
          const currentTimeline = top.timeline || [
            { t: "14:20:01", d: "FATAL · NameNode heap exhausted", now: true },
            { t: "14:19:58", d: "Block report failed on /10.0.1.42" },
            { t: "14:19:52", d: "Slow BlockReceiver 1180ms" },
            { t: "14:18:47", d: "NIC timeout on node-042" },
          ]
          const newEvent = {
            t: newTime,
            d: `${newSev} · Correlated [${newSrc}]`,
            now: true
          }
          top.timeline = [newEvent, ...currentTimeline.map(e => ({ ...e, now: false })).slice(0, 5)]
          updated[0] = top
        }

        if (Math.random() < 0.24) {
          const clusterTitles = [
            "Spark Driver OutOfMemory Pattern",
            "ZooKeeper Quorum Timeout Cluster",
            "Disk I/O Saturation · /data/vol3",
            "DataNode Network Flap · Rack-C",
            "YARN Resource Manager Fencing"
          ]
          const clusterHosts = ["spark-drv-07", "zk-quorum-02", "node-091", "node-044", "yarn-rm-01"]
          const clusterTags = [
            ["SPARK", "OOM", "DRIVER", "P1"],
            ["ZOOKEEPER", "QUORUM", "TIMEOUT", "P1"],
            ["DISK_IO", "STORAGE", "VOL3", "P2"],
            ["NIC_FLAP", "HDFS", "RACK-C", "P1"],
            ["YARN", "RESOURCE_MGR", "FENCING", "P2"]
          ]
          const pick = Math.floor(Math.random() * clusterTitles.length)
          const newCluster = {
            incident_id: `INC-88${Math.floor(Math.random() * 80) + 20}`,
            title: clusterTitles[pick],
            confidence: 0.86 + Math.random() * 0.13,
            host: clusterHosts[pick],
            suppressed_count: Math.floor(Math.random() * 60) + 12,
            explanation: `Autonomous graph clustering correlated multiple cascading ${newSev} anomalies on ${clusterHosts[pick]} into a unified root cause.`,
            tags: clusterTags[pick],
            detection_time: `${(Math.random() * 2 + 0.4).toFixed(1)}s`,
            mttr_estimate: `${Math.floor(Math.random() * 10) + 3}m`,
            timeline: [
              { t: newTime, d: `${newSev} · ${newMsg}`, now: true },
              { t: "14:19:55", d: `Initial anomaly detected on ${clusterHosts[pick]}` },
              { t: "14:19:40", d: "Vector embeddings established semantic link" }
            ]
          }
          return [newCluster, ...updated.slice(0, 6)]
        }

        return updated
      })
    }, interval)
  }, [stopReplay])

  const handleSpeedChange = (newSpd) => {
    setSpeed(newSpd)
    if (isPlaying) {
      startReplay(newSpd)
    }
  }

  const togglePlay = () => {
    if (isPlaying) {
      stopReplay()
      setIsPlaying(false)
    } else {
      setIsPlaying(true)
      startReplay(speed)
    }
  }

  useEffect(() => {
    return () => stopReplay()
  }, [stopReplay])

  // Smooth scroll reveal observer matching landing page
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add(styles.revealVisible)
          }
        })
      },
      { threshold: 0.08, rootMargin: "0px 0px -20px 0px" }
    )

    const elements = document.querySelectorAll(`.${styles.reveal}`)
    elements.forEach((el) => observer.observe(el))

    return () => observer.disconnect()
  }, [incidents, stream, activeTab])

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
                onClick={() => {
                  setActiveTab("LIVE")
                  document.getElementById("kpi-section")?.scrollIntoView({ behavior: "smooth" })
                }}
                className={`${styles.navLink} ${activeTab === "LIVE" ? styles.navLinkActive : ""}`}
                style={{ background: "none", border: "none", font: "inherit", cursor: "pointer" }}
              >
                LIVE VIEW
              </button>
              <button
                onClick={() => {
                  setActiveTab("TOPOLOGY")
                  document.getElementById("topology-section")?.scrollIntoView({ behavior: "smooth" })
                }}
                className={`${styles.navLink} ${activeTab === "TOPOLOGY" ? styles.navLinkActive : ""}`}
                style={{ background: "none", border: "none", font: "inherit", cursor: "pointer" }}
              >
                TOPOLOGY MAP
              </button>
            </nav>
          </div>

          <div className={styles.headerRight}>
            <button
              onClick={togglePlay}
              className={`${styles.playControlBtn} ${isPlaying ? styles.playControlBtnActive : ""}`}
            >
              <span style={{ fontSize: "13px", lineHeight: 1 }}>
                {isPlaying ? "⏸" : "▶"}
              </span>
              <span>{isPlaying ? "Pause Stream" : "Play Stream"}</span>
            </button>

            <div className={styles.replayWrap}>
              <span className={styles.replayLabel}>Speed</span>
              <div className={styles.replayGroup}>
                {[1, 5, 10].map((s) => (
                  <button
                    key={s}
                    onClick={() => handleSpeedChange(s)}
                    className={`${styles.replayBtn} ${speed === s ? styles.replayBtnActive : ""}`}
                  >
                    {s}×
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={() => {
                setStream(initialStream)
                setIsPlaying(false)
                setFocusIdx(0)
              }}
              className={styles.resetBtnTop}
              title="Reset live stream"
            >
              ↻ Reset
            </button>
          </div>
        </div>
      </header>

      {/* Hero KPI strip */}
      <section className={`${styles.kpiSection} ${styles.reveal}`} id="kpi-section">
        <div className={styles.headerRow}>
          <div>
            <div className={styles.timeBadge}>
              Operations · Friday · 14:20 UTC
            </div>
            <h1 className={styles.heroTitle}>
              Signal, <em className={styles.heroItalic}>not</em> noise.
            </h1>
          </div>
          <div className={styles.regionGroup}>
            <div style={{ textAlign: "right" }}>
              <div className={styles.regionLabel}>Region</div>
              <div className={styles.regionVal}>US-EAST-1 · EU-WEST-1</div>
            </div>
            <div className={styles.headerDivider} />
            <button
              onClick={() => setRunbookModalInc(activeFocusInc)}
              className={styles.openRunbookBtn}
            >
              Open Runbook
            </button>
          </div>
        </div>

        <div className={styles.kpiGrid}>
          {kpis.map((k, i) => {
            const featured = k.tone === "primary"
            return (
              <div
                key={k.label}
                className={featured ? styles.kpiCardFeatured : styles.kpiCardWhite}
                style={{ animationDelay: `${i * 60}ms` }}
              >
                {featured && (
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      opacity: 0.4,
                      pointerEvents: "none",
                      background: "radial-gradient(300px 120px at 100% 0%, rgba(255,255,255,0.35), transparent 60%)"
                    }}
                  />
                )}
                <div className={styles.kpiTopRow}>
                  <div className={featured ? styles.kpiLabelFeatured : styles.kpiLabelWhite}>
                    {k.label}
                  </div>
                  {k.delta && (
                    <div className={featured ? styles.kpiDeltaFeatured : styles.kpiDeltaWhite}>
                      ↑ {k.delta}
                    </div>
                  )}
                </div>
                <div className={styles.kpiValueRow}>
                  <span className={featured ? styles.kpiValueFeatured : styles.kpiValueWhite}>
                    {k.value}
                  </span>
                  {k.suffix && (
                    <span className={featured ? styles.kpiSuffixFeatured : styles.kpiSuffixWhite}>
                      {k.suffix}
                    </span>
                  )}
                </div>
                {k.trend && (
                  <div className={styles.kpiSparkWrap}>
                    <Sparkline data={k.trend} tone={featured ? "primary" : "ink"} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* Workspace */}
      <main className={styles.workspaceGrid}>
        {/* Left column */}
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

              {/* Filter pills & buffer strip */}
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
                  <span className={styles.bufferDetails}> · buffer 128 · win 60s</span>
                </div>
              </div>
            </div>

            <div className={styles.streamList}>
              {stream.map((r, i) => {
                const idxHex = (i + 1).toString(16).toUpperCase().padStart(2, "0")
                return (
                  <div
                    key={`${r.time}-${i}`}
                    onClick={() => setFocusIdx(i)}
                    className={`${styles.streamRow} ${r.focus ? styles.streamRowFocus : ""}`}
                  >
                    <span className={styles.stIdx}>{idxHex}</span>
                    <span className={styles.stTime}>{r.time}</span>
                    <SeverityToken sev={r.sev} />
                    <span className={styles.stSrc}>[{r.src}]</span>
                    <span className={styles.stMsg}>{r.msg}</span>
                    {r.focus && (
                      <span className={styles.stCorrelatedBadge}>
                        ● CORRELATED
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </section>

          {/* Topology + secondary incidents grid */}
          <div className={`${styles.bottomGrid} ${styles.reveal}`}>
            <section className={styles.topologyCard} id="topology-section">
              <div className={styles.topHeaderRow}>
                <div>
                  <div className={styles.topTagRow}>
                    <span className={styles.topNum}>03</span>
                    <span className={styles.topLine} />
                    <span className={styles.topLabel}>Topology</span>
                  </div>
                  <h3 className={styles.topTitle}>Blast radius</h3>
                  <div className={styles.topSubtitle}>containment · t+04:12</div>
                </div>
                <div className={styles.topHeaderRight}>
                  <div className={styles.rackBadge}>
                    <span className={styles.rackDot} />
                    <span className={styles.rackText}>{topologyInfo.rack} · LIVE</span>
                  </div>
                  <div className={styles.rackSev}>SEV · P1</div>
                </div>
              </div>

              <div className={styles.topologyVizWrap}>
                <TopologyMap nodes={topologyInfo.nodes} edges={topologyInfo.edges} />
              </div>

              {/* Legend Row */}
              <div className={styles.topologyLegendRow}>
                <div className={styles.topologyLegendGroup}>
                  <span className={styles.legendItem}><span className={`${styles.legendDot} ${styles.legendDotRoot}`} /> root</span>
                  <span className={styles.legendItem}><span className={`${styles.legendDot} ${styles.legendDotDegraded}`} /> degraded</span>
                  <span className={styles.legendItem}><span className={`${styles.legendDot} ${styles.legendDotHealthy}`} /> healthy</span>
                </div>
                <span className={styles.legendEdgesText}>edges = replica flow</span>
              </div>

              {/* 3 Metric Boxes Grid */}
              <div className={styles.topologyMetricsGrid}>
                <div className={styles.topologyMetricBox}>
                  <div className={styles.topologyMetricLabel}>NODES</div>
                  <div className={styles.topologyMetricVal}>
                    {topologyInfo.metrics.nodes.count} <span className={styles.topologyMetricSub} style={{ color: "#F59E0B" }}>of {topologyInfo.metrics.nodes.total}</span>
                  </div>
                </div>
                <div className={styles.topologyMetricBox}>
                  <div className={styles.topologyMetricLabel}>REPLICAS</div>
                  <div className={styles.topologyMetricVal}>
                    {topologyInfo.metrics.replicas.count} <span className={styles.topologyMetricSub} style={{ color: "#FF6B1A" }}>{topologyInfo.metrics.replicas.status}</span>
                  </div>
                </div>
                <div className={styles.topologyMetricBox}>
                  <div className={styles.topologyMetricLabel}>JOBS</div>
                  <div className={styles.topologyMetricVal}>
                    {topologyInfo.metrics.jobs.count} <span className={styles.topologyMetricSub} style={{ color: "#FF6B1A" }}>{topologyInfo.metrics.jobs.status}</span>
                  </div>
                </div>
              </div>

              {/* Divider & Affected Path section */}
              <div className={styles.affectedPathDivider} />

              <div className={styles.affectedPathSection}>
                <div className={styles.affectedPathHeader}>
                  <span className={styles.affectedPathTitle}>AFFECTED PATH</span>
                  <span className={styles.affectedPathHighlight}>{topologyInfo.highlightText}</span>
                </div>
                <div className={styles.affectedPathList}>
                  {topologyInfo.affectedPath.map((p, idx) => (
                    <div key={idx} className={styles.affectedPathRow}>
                      <div className={styles.affectedPathLeft}>
                        <span className={`${styles.affectedPathDot} ${p.tone === "root" ? styles.affectedPathDotRoot : styles.affectedPathDotDegraded}`} />
                        <span className={styles.affectedPathNode}>{p.node}</span>
                        <span className={styles.affectedPathRole}>{p.role}</span>
                      </div>
                      <span className={styles.affectedPathImpact}>{p.impact}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>

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
                {queueIncidents.map((inc) => {
                  const isIncAcked = ackedIds.includes(inc.id)
                  return (
                    <button
                      key={inc.id}
                      onClick={() => setFocusIdx(inc.rawIdx || 0)}
                      className={styles.queueBtn}
                      style={isIncAcked ? { borderLeft: "3px solid #D97706", background: "var(--cream)" } : {}}
                    >
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
              <div
                style={{
                  position: "absolute",
                  top: "-64px",
                  right: "-64px",
                  width: "224px",
                  height: "224px",
                  borderRadius: "50%",
                  opacity: 0.3,
                  pointerEvents: "none",
                  background: "radial-gradient(circle, #FFFFFF, transparent 70%)"
                }}
              />
              <div className={styles.focusHeaderTop}>
                <div className={styles.focusTagRow}>
                  <span className={styles.focusNum}>02</span>
                  <span className={styles.focusLine} />
                  <span className={styles.focusLabel}>Focus</span>
                </div>
                <span className={`${styles.focusStatusBadge} ${ackedIds.includes(activeFocusInc.incident_id) ? styles.focusStatusAcked : ""}`}>
                  {ackedIds.includes(activeFocusInc.incident_id) ? "✓ Acknowledged · Silenced" : "Active · 03:42"}
                </span>
              </div>
              <div className={styles.focusHeaderMain}>
                <div style={{ minWidth: 0 }}>
                  <span className={styles.focusId}>{activeFocusInc.incident_id || "INC-8821"}</span>
                  <h3 className={styles.focusTitle}>
                    {activeFocusInc.title || "HDFS DataNode connection refusal cluster"}
                  </h3>
                </div>
                <ConfidenceRing value={activeFocusInc.confidence_score || 94} />
              </div>
            </div>

            <div className={styles.focusBody}>
              <p className={styles.focusExplanation}>
                {activeFocusInc.summary || "Cascading failure originating from node-042.rack-b after a primary NIC timeout. Correlation collapsed 412 alerts into a single root cause."}
              </p>

              <div className={styles.focusMetricsGrid}>
                {[
                  { l: "Suppressed", v: activeFocusInc.suppressed_count || "412" },
                  { l: "Detection",  v: activeFocusInc.detection_time || "1.2s" },
                  { l: "MTTR est.",  v: activeFocusInc.mttr_estimate || "8m" },
                ].map((m) => (
                  <div key={m.l} className={styles.metricBox}>
                    <div className={styles.metricBoxLabel}>{m.l}</div>
                    <div className={styles.metricBoxVal}>{m.v}</div>
                  </div>
                ))}
              </div>

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

              <div className={styles.chipsRow}>
                {(activeFocusInc.tags || ["NIC_TIMEOUT", "HDFS", "Rack-B", "P1"]).map((t) => (
                  <span key={t} className={styles.chip}>{t}</span>
                ))}
              </div>

              <div className={styles.actionsGrid}>
                <button
                  onClick={() => {
                    const id = activeFocusInc.incident_id
                    if (ackedIds.includes(id)) {
                      setAckedIds(prev => prev.filter(x => x !== id))
                    } else {
                      setAckedIds(prev => [...new Set([...prev, id])])
                    }
                  }}
                  className={`${styles.actionBtnMain} ${ackedIds.includes(activeFocusInc.incident_id) ? styles.actionBtnAcked : ""}`}
                >
                  {ackedIds.includes(activeFocusInc.incident_id) ? "✓ Acknowledged" : "Acknowledge"}
                </button>
                <button
                  onClick={() => setRunbookModalInc(activeFocusInc)}
                  className={styles.actionBtnSecondary}
                >
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
                <h3 className={styles.runbookModalTitle}>
                  Automated Remediation · {runbookModalInc.incident_id}
                </h3>
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

              <button
                className={styles.runbookExecuteBtn}
                onClick={() => {
                  setAckedIds(prev => [...new Set([...prev, runbookModalInc.incident_id])])
                  setRunbookModalInc(null)
                }}
              >
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
          <span className={styles.footerRegion}>REGION · US-EAST-1 / EU-WEST-1</span>
        </div>
        <div className={styles.footerRight}>
          <span
            onClick={() => {
              setStream(initialStream)
              setIsPlaying(false)
              setFocusIdx(0)
              setAckedIds([])
              setRunbookModalInc(null)
            }}
            className={styles.footerActionPrimary}
          >
            [R] RESET
          </span>
          <span
            onClick={() => setRunbookModalInc(null)}
            className={styles.footerAction}
          >
            [ESC] DISMISS
          </span>
        </div>
      </footer>
    </div>
  )
}

