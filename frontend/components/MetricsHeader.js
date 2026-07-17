"use client"
import styles from "./MetricsHeader.module.css"

const SEV_COLOR = { FATAL: "#ef4444", ERROR: "#f97316", WARN: "#eab308", INFO: "#64748b" }

export default function MetricsHeader({ totalAlerts, totalIncidents, suppressed, isLive, accuracy = 94.2 }) {
  const noisePct = totalAlerts > 0
    ? ((suppressed / totalAlerts) * 100).toFixed(1)
    : "0.0"

  return (
    <header className={styles.header}>
      {/* Brand */}
      <div className={styles.brand}>
        <span className={styles.logo}>⬡</span>
        <div>
          <div className={styles.brandName}>ClarityOps</div>
          <div className={styles.brandSub}>Alert Intelligence & Real-Time Correlation</div>
        </div>
      </div>

      {/* Metrics */}
      <div className={styles.metrics}>
        <MetricCard
          value={noisePct + "%"}
          label="Noise Reduction"
          color="var(--green)"
          glow="var(--green-glow)"
        />
        <Divider />
        <MetricCard
          value={totalAlerts.toLocaleString()}
          label="Raw Alerts"
          color="var(--orange)"
          glow="var(--orange-glow)"
        />
        <span className={styles.arrow}>→</span>
        <MetricCard
          value={totalIncidents}
          label="Incidents"
          color="var(--cyan)"
          glow="var(--cyan-glow)"
        />
        <Divider />
        <MetricCard
          value={suppressed.toLocaleString()}
          label="Suppressed"
          color="var(--purple)"
          glow="var(--purple-glow)"
        />
        <Divider />
        <MetricCard
          value={accuracy + "%"}
          label="Accuracy"
          color="var(--cyan)"
          glow="var(--cyan-glow)"
        />
      </div>

      {/* Live indicator */}
      <div className={styles.liveArea}>
        <span
          className="pulse-dot"
          style={{ background: isLive ? "var(--green)" : "var(--text-dim)" }}
        />
        <span className={styles.liveLabel}>{isLive ? "LIVE" : "PAUSED"}</span>
      </div>
    </header>
  )
}

function MetricCard({ value, label, color, glow }) {
  return (
    <div className={styles.metric}>
      <span className={styles.metricValue} style={{ color, textShadow: `0 0 24px ${glow}` }}>
        {value}
      </span>
      <span className={styles.metricLabel}>{label}</span>
    </div>
  )
}

function Divider() {
  return <div className={styles.divider} />
}
