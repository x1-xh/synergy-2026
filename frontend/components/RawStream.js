"use client"
import { useEffect, useRef } from "react"
import styles from "./RawStream.module.css"

const SEV_CONFIG = {
  FATAL: { color: "#ef4444", bg: "rgba(239,68,68,0.08)", label: "FATAL" },
  ERROR: { color: "#f97316", bg: "rgba(249,115,22,0.06)", label: "ERROR" },
  WARN:  { color: "#eab308", bg: "rgba(234,179,8,0.05)",  label: "WARN " },
  INFO:  { color: "#475569", bg: "transparent",            label: "INFO " },
}

export default function RawStream({ alerts, flyingIds = new Set() }) {
  const topRef = useRef(null)

  // Auto-scroll to top whenever new alerts arrive (newest is at top)
  useEffect(() => {
    topRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [alerts.length])

  return (
    <div className={styles.panel}>
      {/* Panel header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className="pulse-dot" style={{ background: "var(--orange)" }} />
          <span className={styles.title}>Raw Alert Stream</span>
        </div>
        <span className={styles.count}>{alerts.length.toLocaleString()} events</span>
      </div>

      {/* Terminal log */}
      <div className={styles.stream}>
        <div ref={topRef} />
        {alerts.map((alert) => {
          const cfg = SEV_CONFIG[alert.severity] ?? SEV_CONFIG.INFO
          const isFlying = flyingIds.has(alert.id)
          return (
            <div
              key={alert.id}
              className={`${styles.row} fade-in ${isFlying ? "fly-out" : ""}`}
              style={{ background: cfg.bg }}
            >
              <span className={styles.ts} style={{ color: "var(--text-dim)" }}>
                {new Date(alert.timestamp).toLocaleTimeString("en-US", { hour12: false })}
              </span>
              <span className={styles.sev} style={{ color: cfg.color }}>
                {cfg.label}
              </span>
              <span className={styles.svc}>{alert.service}</span>
              <span className={styles.msg}>{alert.message}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
