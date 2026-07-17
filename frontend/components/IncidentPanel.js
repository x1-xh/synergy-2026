"use client"
import styles from "./IncidentPanel.module.css"

const CONF_COLOR = (c) =>
  c >= 0.9 ? "var(--green)" : c >= 0.75 ? "var(--cyan)" : "var(--yellow)"

export default function IncidentPanel({ incidents, onSelect }) {
  return (
    <div className={styles.panel}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className="pulse-dot" style={{ background: "var(--cyan)" }} />
          <span className={styles.title}>Correlated Incidents</span>
        </div>
        <span className={styles.count}>{incidents.length} groups</span>
      </div>

      {/* Incident cards */}
      <div className={styles.list}>
        {incidents.length === 0 && (
          <div className={styles.empty}>
            <span>Waiting for correlation engine…</span>
          </div>
        )}
        {incidents.map((inc) => (
          <IncidentCard key={inc.incident_id} inc={inc} onClick={() => onSelect(inc)} />
        ))}
      </div>
    </div>
  )
}

function IncidentCard({ inc, onClick }) {
  const conf = inc.confidence
  const confColor = CONF_COLOR(conf)
  const start = new Date(inc.time_span.start)
  const end = new Date(inc.time_span.end)
  const durationSec = Math.round((end - start) / 1000)

  return (
    <button className={`${styles.card} card-new`} onClick={onClick}>
      {/* Top row */}
      <div className={styles.cardTop}>
        <span className={styles.incId}>{inc.incident_id}</span>
        <span className={styles.conf} style={{ color: confColor }}>
          {Math.round(conf * 100)}% conf
        </span>
      </div>

      {/* Title */}
      <div className={styles.cardTitle}>{inc.title}</div>

      {/* Root cause */}
      <div className={styles.rootLine}>
        <span className={styles.rootLabel}>Root cause:</span>
        <span className={styles.rootMsg}>{inc.root_cause_alert.message}</span>
      </div>

      {/* Footer row */}
      <div className={styles.cardFooter}>
        <span className={styles.chip} style={{ background: "rgba(249,115,22,0.12)", color: "var(--orange)", borderColor: "rgba(249,115,22,0.3)" }}>
          {inc.suppressed_count} suppressed
        </span>
        <span className={styles.chip} style={{ background: "rgba(0,212,255,0.08)", color: "var(--cyan)", borderColor: "rgba(0,212,255,0.2)" }}>
          {inc.member_alerts.length} alerts
        </span>
        <span className={styles.dur}>{durationSec}s</span>
      </div>
    </button>
  )
}
