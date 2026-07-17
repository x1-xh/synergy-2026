"use client"
import { useEffect } from "react"
import styles from "./IncidentModal.module.css"

const SEV_COLOR = { FATAL: "#ef4444", ERROR: "#f97316", WARN: "#eab308", INFO: "#475569" }

const CONF_COLOR = (c) =>
  c >= 0.9 ? "var(--green)" : c >= 0.75 ? "var(--cyan)" : "var(--yellow)"

export default function IncidentModal({ incident, onClose }) {
  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [onClose])

  if (!incident) return null

  const conf = incident.confidence
  const confColor = CONF_COLOR(conf)
  const start = new Date(incident.time_span.start)
  const end = new Date(incident.time_span.end)
  const durationSec = Math.round((end - start) / 1000)

  // Sort member alerts chronologically for timeline
  const sorted = [...incident.member_alerts].sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  )

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className={styles.modalHeader}>
          <div>
            <div className={styles.modalId}>{incident.incident_id}</div>
            <div className={styles.modalTitle}>{incident.title}</div>
          </div>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* Stats row */}
        <div className={styles.statsRow}>
          <Stat value={`${Math.round(conf * 100)}%`} label="AI Confidence" color={confColor} />
          <Stat value={incident.suppressed_count} label="Alerts Suppressed" color="var(--orange)" />
          <Stat value={incident.member_alerts.length} label="In Cluster" color="var(--cyan)" />
          <Stat value={`${durationSec}s`} label="Duration" color="var(--purple)" />
        </div>

        <div className={styles.body}>
          {/* Root Cause */}
          <section className={styles.section}>
            <div className={styles.sectionLabel}>Root Cause Alert</div>
            <div className={styles.rootCard}>
              <div className={styles.rootBadge}>ROOT CAUSE</div>
              <span
                className={styles.sev}
                style={{ color: SEV_COLOR[incident.root_cause_alert.severity] }}
              >
                {incident.root_cause_alert.severity}
              </span>
              <span className={styles.rootSvc}>{incident.root_cause_alert.service}</span>
              <span className={styles.rootMsg}>{incident.root_cause_alert.message}</span>
              <span className={styles.confBadge} style={{ color: confColor, borderColor: confColor }}>
                {Math.round(conf * 100)}% confidence
              </span>
            </div>
          </section>

          {/* LLM Explanation */}
          <section className={styles.section}>
            <div className={styles.sectionLabel}>
              <span className={styles.llmIcon}>⬡</span> AI Explanation
            </div>
            <div className={styles.explanation}>
              {incident.explanation}
            </div>
          </section>

          {/* Timeline */}
          <section className={styles.section}>
            <div className={styles.sectionLabel}>Alert Timeline ({sorted.length} events)</div>
            <div className={styles.timeline}>
              {sorted.map((alert, i) => {
                const isRoot = alert.id === incident.root_cause_alert.id
                return (
                  <div key={alert.id} className={`${styles.tlRow} ${isRoot ? styles.tlRoot : ""}`}>
                    <div className={styles.tlLine}>
                      <div
                        className={styles.tlDot}
                        style={{
                          background: isRoot ? "var(--orange)" : SEV_COLOR[alert.severity],
                          boxShadow: isRoot ? "0 0 8px var(--orange)" : "none",
                        }}
                      />
                      {i < sorted.length - 1 && <div className={styles.tlConnector} />}
                    </div>
                    <div className={styles.tlContent}>
                      <span className={styles.tlTs}>
                        {new Date(alert.timestamp).toLocaleTimeString("en-US", { hour12: false })}
                      </span>
                      <span
                        className={styles.tlSev}
                        style={{ color: SEV_COLOR[alert.severity] }}
                      >
                        {alert.severity}
                      </span>
                      <span className={styles.tlSvc}>{alert.service}</span>
                      <span className={styles.tlMsg}>{alert.message}</span>
                      {isRoot && <span className={styles.rootTag}>ROOT</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function Stat({ value, label, color }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statValue} style={{ color }}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  )
}
