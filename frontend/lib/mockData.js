// lib/mockData.js
// Matches exactly the schemas defined in frontend_design_guide.md
// Used for static development — swap fetch() calls when backend is ready

const SERVICES = [
  "dfs.DataNode", "dfs.NameNode", "dfs.FSNamesystem", "dfs.DataBlockScanner",
  "hdfs.server.namenode", "mapred.JobTracker", "mapred.TaskTracker",
  "org.apache.hadoop.ipc", "org.apache.spark.executor", "spark.streaming",
]
const SOURCES = ["hdfs", "spark", "mapred", "system"]
const SEVERITIES = ["INFO", "INFO", "INFO", "WARN", "WARN", "ERROR", "ERROR", "FATAL"]
const ERROR_MSGS = [
  "Connection reset by peer",
  "Datanode unreachable: connection timed out",
  "Block replica not found on any DataNode",
  "Lost heartbeat from DataNode blk_123445",
  "java.io.IOException: Connection refused",
  "Failed to establish connection to NameNode",
  "NetworkException: Unexpected end of stream",
  "Checksum mismatch block_7834322",
  "Unable to obtain block size, retrying",
  "Socket timeout while reading block",
  "WARN: GC overhead limit exceeded",
  "ERROR: Executor lost: heartbeat timeout",
  "NameNode metadata sync failed",
  "Replica placement policy violated",
  "TaskAttempt failed due to node failure",
  "Disk I/O error on /data/vol3",
  "ZooKeeper session expired",
  "Failed to write block: no space left",
]

let _alertId = 1
function makeAlert(overrides = {}) {
  const severity = overrides.severity ?? SEVERITIES[Math.floor(Math.random() * SEVERITIES.length)]
  const ts = overrides.timestamp ?? new Date(Date.now() - Math.random() * 3_600_000).toISOString()
  const service = overrides.service ?? SERVICES[Math.floor(Math.random() * SERVICES.length)]
  return {
    id: `alert_${_alertId++}`,
    timestamp: ts,
    source: SOURCES[Math.floor(Math.random() * SOURCES.length)],
    service,
    severity,
    message: overrides.message ?? ERROR_MSGS[Math.floor(Math.random() * ERROR_MSGS.length)],
    raw_line: `081110 093200 ${Math.floor(Math.random() * 999)} ${severity} ${service} ...`,
  }
}

// ── Initial batch of raw alerts (used to pre-fill the stream) ─
export const INITIAL_ALERTS = Array.from({ length: 80 }, () => makeAlert())

// ── Pre-built incident clusters ────────────────────────────────
export const INCIDENTS = [
  {
    incident_id: "inc_001",
    title: "DataNode Network Cascade",
    root_cause_alert: makeAlert({ severity: "ERROR", service: "dfs.DataNode", message: "Connection reset by peer" }),
    confidence: 0.94,
    explanation:
      "A DataNode on blk-node-04 lost its network connection to the NameNode at 09:32 UTC. This single failure triggered a cascade: the NameNode began re-replicating 420 block replicas, firing WARN-level alerts for each. Simultaneously, downstream MapReduce tasks waiting on those blocks started timing out, generating further ERROR events. Root cause: network interface flap on blk-node-04.",
    time_span: { start: "2008-11-10T09:32:00Z", end: "2008-11-10T09:34:10Z" },
    suppressed_count: 420,
    member_alerts: Array.from({ length: 12 }, () =>
      makeAlert({ service: "dfs.DataNode" })
    ),
  },
  {
    incident_id: "inc_002",
    title: "NameNode Metadata Sync Failure",
    root_cause_alert: makeAlert({ severity: "ERROR", service: "hdfs.server.namenode", message: "NameNode metadata sync failed" }),
    confidence: 0.87,
    explanation:
      "The NameNode failed to sync its edit log to the standby node, causing the standby to fall behind. Secondary symptoms included client read timeouts and fsimage checkpoint failures. The root issue was a slow disk write on the active NameNode's journal directory.",
    time_span: { start: "2008-11-10T10:10:05Z", end: "2008-11-10T10:13:45Z" },
    suppressed_count: 185,
    member_alerts: Array.from({ length: 8 }, () =>
      makeAlert({ service: "hdfs.server.namenode" })
    ),
  },
  {
    incident_id: "inc_003",
    title: "Spark Executor Memory Pressure",
    root_cause_alert: makeAlert({ severity: "WARN", service: "org.apache.spark.executor", message: "WARN: GC overhead limit exceeded" }),
    confidence: 0.79,
    explanation:
      "A GC pressure event on Spark executor spark-exec-07 caused a series of task failures. The executor JVM hit its heap ceiling during a shuffle write phase. Tasks were rescheduled, each generating duplicate WARN events before the job ultimately succeeded on retry.",
    time_span: { start: "2008-11-10T11:05:20Z", end: "2008-11-10T11:07:55Z" },
    suppressed_count: 312,
    member_alerts: Array.from({ length: 10 }, () =>
      makeAlert({ service: "org.apache.spark.executor" })
    ),
  },
  {
    incident_id: "inc_004",
    title: "ZooKeeper Session Expiry",
    root_cause_alert: makeAlert({ severity: "FATAL", service: "dfs.FSNamesystem", message: "ZooKeeper session expired" }),
    confidence: 0.91,
    explanation:
      "A ZooKeeper session expiry on the HDFS NameNode triggered fencing. The NameNode briefly entered safe mode, causing all clients to receive connection refused errors. Recovery was automatic within 45 seconds, but the spike generated 215 downstream alerts.",
    time_span: { start: "2008-11-10T12:22:10Z", end: "2008-11-10T12:23:05Z" },
    suppressed_count: 215,
    member_alerts: Array.from({ length: 7 }, () =>
      makeAlert({ service: "dfs.FSNamesystem" })
    ),
  },
  {
    incident_id: "inc_005",
    title: "Disk I/O Saturation on vol3",
    root_cause_alert: makeAlert({ severity: "ERROR", service: "dfs.DataBlockScanner", message: "Disk I/O error on /data/vol3" }),
    confidence: 0.83,
    explanation:
      "A disk on /data/vol3 entered a degraded I/O state, causing block scanner checks to fail. Write operations to this volume began queuing, eventually timing out. The DataBlockScanner flagged 268 blocks as potentially corrupt, generating individual alerts per block.",
    time_span: { start: "2008-11-10T13:45:30Z", end: "2008-11-10T13:48:15Z" },
    suppressed_count: 268,
    member_alerts: Array.from({ length: 9 }, () =>
      makeAlert({ service: "dfs.DataBlockScanner" })
    ),
  },
]

// ── Stream of new alerts — called repeatedly during replay ────
export function generateStreamAlert() {
  return makeAlert()
}
