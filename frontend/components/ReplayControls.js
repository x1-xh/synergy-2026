"use client"
import styles from "./ReplayControls.module.css"

const SPEEDS = [
  { label: "1×",  value: 1 },
  { label: "5×",  value: 5 },
  { label: "10×", value: 10 },
]

export default function ReplayControls({ isPlaying, speed, onPlay, onPause, onReset, onSpeed }) {
  return (
    <div className={styles.bar}>
      <span className={styles.label}>Replay</span>

      {/* Play / Pause */}
      <button
        className={`${styles.btn} ${styles.primary}`}
        onClick={isPlaying ? onPause : onPlay}
        title={isPlaying ? "Pause" : "Play"}
      >
        {isPlaying ? "⏸" : "▶"}
      </button>

      {/* Reset */}
      <button
        className={`${styles.btn}`}
        onClick={onReset}
        title="Reset stream"
      >
        ↺
      </button>

      <div className={styles.sep} />

      {/* Speed */}
      <span className={styles.label}>Speed</span>
      <div className={styles.speedGroup}>
        {SPEEDS.map((s) => (
          <button
            key={s.value}
            className={`${styles.speedBtn} ${speed === s.value ? styles.active : ""}`}
            onClick={() => onSpeed(s.value)}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  )
}
