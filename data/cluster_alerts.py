"""
cluster_alerts.py — Time-windowed similarity clustering for unified alerts.

Takes the unified alert table (combined / demo) plus its index-aligned embedding
matrix, connects alerts that are close in time AND similar in meaning, extracts
connected components as incident clusters, and ranks a root-cause candidate
within each cluster.

Inputs:
  alerts CSV   — combined_alerts.csv or demo_alerts.csv (the unified 7-col table)
  embeddings   — *.npy produced by embed_alerts.py, row i == alerts row i

Outputs:
  incidents.json — list of incident objects in the frontend schema:
                      incident_id, title, root_cause_alert, confidence,
                      explanation, time_span {start,end}, suppressed_count,
                      member_alerts, status, root_cause_candidates
  clusters.csv   — audit table mapping each alert to its incident + role + score

Key decisions (mirrors design in hackathon_ppt_content.md / checklist Days 4-7):
  - Clustering is COMBINED across HDFS + Spark on one timeline sorted by
    timestamp. HDFS (2008) and Spark (2017) live in different epochs, so they
    never collide in the 4-minute window — the time window naturally partitions
    per source. This matches the deck ("correlate alerts close in time AND
    similar in meaning" on one stream).
  - Edge rule: alert i and j are linked iff t[j]-t[i] <= window_sec AND
    cosine(cleaned_msg_i, cleaned_msg_j) >= sim_threshold. Comparisons are
    restricted to a sliding time window only — practically linear, no O(n^2).
  - Severity / service are NOT used to form clusters (deck: clustering is time +
    meaning). Severity IS used to rank the root cause inside each cluster (Day 7:
    earliest alert is the strongest signal; FATAL>ERROR>WARN>INFO breaks ties).
  - Confidence = mean cosine similarity of members to the root-cause alert
    (cluster cohesion). Clusters below the confidence floor or smaller than a
    minimum size are flagged status="needs_review".
  - suppressed_count = len(cluster) - 1  (every non-root alert that this incident
    collapses). Non-destructive — nothing is deleted, all members stay listed.
  - explanation is left "" here; the LLM pass (Day 8) fills it one call per cluster.
  - Missing fields stay "unknown" exactly like extract_alerts.py handles them.
"""

import argparse
import csv
import json
import os
from datetime import datetime, timedelta

import numpy as np

# ---------------------------------------------------------------------------
# Configuration defaults (overridable via CLI — for the Day-10+ parameter sweep)
# ---------------------------------------------------------------------------
DEFAULT_WINDOW_SEC = 240          # ~4-minute windows (deck spec)
DEFAULT_SIM_THRESHOLD = 0.75      # cosine similarity floor for an edge
CONF_FLOOR = 0.75                 # below this -> status="needs_review"
MIN_CLUSTER_SIZE = 2              # singletons are flagged needs_review
SEVERITY_RANK = {'FATAL': 4, 'ERROR': 3, 'WARN': 2, 'INFO': 1}

# Index of the cleaned-text column added by clean_text.py
CLEANED_COL = 'cleaned_message'

# The 7-column alert schema (same everywhere in the pipeline)
ALERT_FIELDS = ['timestamp', 'source', 'service', 'severity', 'message', 'event_id', 'raw_line']


# ---------------------------------------------------------------------------
# Union-Find (connected components over the similarity graph)
# ---------------------------------------------------------------------------
class UnionFind:
    def __init__(self, n):
        self.parent = list(range(n))
        self.rank = [0] * n
        self.size = [1] * n

    def find(self, x):
        root = x
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[x] != root:        # path compression
            self.parent[x], x = root, self.parent[x]
        return root

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if self.rank[ra] < self.rank[rb]:
            ra, rb = rb, ra
        self.parent[rb] = ra
        self.size[ra] += self.size[rb]
        if self.rank[ra] == self.rank[rb]:
            self.rank[ra] += 1


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------
def load_alerts(csv_path, expected_embedding_count):
    """Load the unified alert table; keep only the subset with a parseable
    timestamp and a real cleaned_message. Returns (alerts, kept_indices).
    kept_indices maps each surviving row back to its position in the embedding
    matrix so we stay index-aligned with embed_alerts.py."""
    alerts = []
    kept = []
    skipped_ts = 0
    skipped_msg = 0
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for i, row in enumerate(reader):
            if i >= expected_embedding_count:
                break
            try:
                datetime.fromisoformat(row['timestamp'])
            except (ValueError, KeyError):
                skipped_ts += 1
                continue
            msg = (row.get(CLEANED_COL) or row.get('message') or '').strip()
            if not msg:
                skipped_msg += 1
                continue
            alerts.append(row)
            kept.append(i)
    if skipped_ts or skipped_msg:
        print(f"  skipped {skipped_ts} alerts with bad timestamp, {skipped_msg} with empty message")
    return alerts, kept


def load_embeddings(npy_path, kept_indices):
    """Load the full embedding matrix and slice to surviving rows."""
    emb = np.load(npy_path)
    if emb.ndim != 2:
        raise ValueError(f"Expected 2-D embedding matrix, got shape {emb.shape}")
    if emb.shape[0] == 0:
        raise ValueError("Embedding matrix is empty — run embed_alerts.py first.")
    sel = np.asarray(kept_indices, dtype=int)
    if sel.max(initial=0) >= emb.shape[0]:
        raise ValueError(
            f"Alert table references row {sel.max()} but embeddings only have "
            f"{emb.shape[0]} rows (table/embeddings out of sync).")
    return emb[sel]


# ---------------------------------------------------------------------------
# Graph build + connected components
# ---------------------------------------------------------------------------
def l2_normalize(emb):
    norms = np.linalg.norm(emb, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return emb / norms


def build_clusters(alerts, emb_norm, window_sec, sim_threshold):
    """Sliding-time-window union-find. Alerts MUST already be sorted by
    timestamp. Returns dict {root_idx: [member global indices...]} where the
    global index refers to position within the surviving `alerts` list."""
    n = len(alerts)
    uf = UnionFind(n)
    timestamps = [datetime.fromisoformat(a['timestamp']) for a in alerts]
    emb_norm = np.asarray(emb_norm, dtype=np.float32)

    right = 1
    edges = 0
    for left in range(n):
        if right <= left:
            right = left + 1
        # advance right pointer to include everything within the time window
        while right < n and (timestamps[right] - timestamps[left]).total_seconds() <= window_sec:
            right += 1
        # compare left against [left+1, right)
        if right > left + 1:
            sims = emb_norm[left + 1:right] @ emb_norm[left]
            hits = np.where(sims >= sim_threshold)[0]
            for h in hits:
                j = left + 1 + int(h)
                uf.union(left, j)
                edges += 1

    clusters = {}
    for idx in range(n):
        clusters.setdefault(uf.find(idx), []).append(idx)
    # sort members by timestamp within each cluster, themselves by start time
    clusters = dict(sorted(
        ((root, sorted(members, key=lambda i: timestamps[i]))
         for root, members in clusters.items()),
        key=lambda kv: timestamps[kv[1][0]]
    ))
    print(f"  built graph: {edges:,} edges across {n:,} alerts -> "
          f"{len(clusters)} connected components")
    return clusters


# ---------------------------------------------------------------------------
# Root-cause ranking within a cluster (Day 7)
# ---------------------------------------------------------------------------
def candidate_score(idx, members, alerts, emb_norm, timestamps):
    """Earliest alert is the strongest signal (deck). Ties and confidence use:
       severity rank (FATAL>ERROR>WARN>INFO) and mean cosine similarity to the
    other members (cohesion). Returns a raw scalar; normalize later into a
    [0,1] per-incident confidence."""
    severity = SEVERITY_RANK.get(alerts[idx]['severity'], 1)
    # seconds since the cluster's first alert — earlier is better
    earliness = (timestamps[idx] - timestamps[members[0]]).total_seconds()
    earliness_norm = 1.0 / (1.0 + earliness / 60.0)  # decay over minutes
    others = [m for m in members if m != idx]
    cohesion = float(np.mean([emb_norm[idx] @ emb_norm[m] for m in others])) if others else 1.0
    return (0.45 * earliness_norm     # temporal priority (primary)
          + 0.30 * severity / 4.0     # severity (secondary)
          + 0.25 * cohesion)          # semantic cohesion (secondary)


def rank_cluster(members, alerts, emb_norm):
    """Return sorted candidates [{alert, idx, score, confidence, signal}] and
    the incident-level confidence (top candidate's cohesion), plus a 'needs
    review' flag."""
    timestamps = [datetime.fromisoformat(a['timestamp']) for a in alerts]
    scored = sorted(members, key=lambda i: candidate_score(i, members, alerts, emb_norm, timestamps),
                    reverse=True)
    raw = [candidate_score(i, members, alerts, emb_norm, timestamps) for i in scored]

    # normalize per-incident into confidences summing to ~1 across top-3
    top3 = scored[:3]
    top_raw = raw[:3]
    denom = sum(top_raw) or 1.0
    candidates = []
    for idx, r in zip(top3, top_raw):
        candidates.append({
            'alert': alerts[idx],
            'confidence': round(r / denom, 3),
            'signal': 'earliest+severity' ,
        })

    # incident-level confidence = cohesion of the chosen root vs its cluster
    root_idx = scored[0]
    others = [m for m in members if m != root_idx]
    cohesion = float(np.mean([emb_norm[root_idx] @ emb_norm[m] for m in others])) if others else 1.0
    confidence = round(cohesion, 3)
    return root_idx, candidates, confidence


# ---------------------------------------------------------------------------
# Incident assembly
# ---------------------------------------------------------------------------
def make_title(alert):
    service = alert.get('service') or 'unknown'
    msg = (alert.get(CLEANED_COL) or alert.get('message') or '').strip()
    msg = msg if msg else alert.get('message', '')
    msg = (msg[:60] + '…') if len(msg) > 60 else msg
    return f"{service}: {msg}" if service and service != 'unknown' else msg or 'incident'


def build_incident(inc_n, members, alerts, emb_norm):
    """Assemble one incident object in the frontend schema."""
    timestamps = [datetime.fromisoformat(a['timestamp']) for a in [alerts[i] for i in members]]
    root_idx, candidates, confidence = rank_cluster(members, alerts, emb_norm)
    root_alert = alerts[root_idx]

    member_alerts = [alerts[i] for i in members]

    # Build the timeline array for the frontend UI
    timeline = []
    # Sort members by timestamp descending for the timeline
    sorted_members = sorted(member_alerts, key=lambda a: a['timestamp'], reverse=True)
    # Take up to 5 alerts for the timeline to prevent UI overflow
    for a in sorted_members[:5]:
        msg_trunc = (a.get('message', '')[:60] + '…') if len(a.get('message', '')) > 60 else a.get('message', '')
        timeline.append({
            't': a['timestamp'][11:19],
            'd': f"{a['severity']} · {msg_trunc}",
            'now': a == root_alert
        })

    incident = {
        'incident_id': f'inc_{inc_n:03d}',
        'title': make_title(root_alert),
        'root_cause_alert': root_alert,
        'confidence': confidence,
        'explanation': 'Anomalous cluster detected autonomously by ClarityOps vector similarity engine.',  # LLM pass (Day 8) fills this, one call per cluster
        'time_span': {
            'start': min(a['timestamp'] for a in member_alerts),
            'end': max(a['timestamp'] for a in member_alerts),
        },
        'suppressed_count': max(0, len(members) - 1),
        'member_alerts': member_alerts,
        'timeline': timeline,
        'status': 'confirmed' if (confidence >= CONF_FLOOR and len(members) >= MIN_CLUSTER_SIZE)
                  else 'needs_review',
        'root_cause_candidates': candidates,
    }
    return incident, root_idx


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
def write_outputs(incidents, member_index, alerts, out_json, out_csv):
    with open(out_json, 'w', encoding='utf-8') as f:
        json.dump(incidents, f, indent=2)
    print(f"  wrote {len(incidents)} incidents -> {out_json}")

    with open(out_csv, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['global_index', 'incident_id', 'role', 'candidate_conf',
                         'timestamp', 'source', 'service', 'severity', 'message'])
        for idx, inc in member_index:
            role = 'root' if idx == inc.get('_root_idx') else 'member'
            a = alerts[idx]
            cand_conf = ''
            if role == 'root' and inc.get('root_cause_candidates'):
                cand_conf = inc['root_cause_candidates'][0]['confidence']
            writer.writerow([idx, inc['incident_id'], role, cand_conf,
                             a['timestamp'], a['source'], a['service'],
                             a['severity'], a.get('message', '')])
    print(f"  wrote audit table -> {out_csv}")


# ---------------------------------------------------------------------------
# Sanity report (so teammates can eyeball the mapping, per project convention)
# ---------------------------------------------------------------------------
def sanity_report(incidents, total_alerts):
    print("\n" + "=" * 60)
    print("CLUSTERING SANITY CHECK")
    print("=" * 60)
    print(f"\nTotal alerts clustered: {total_alerts}")
    print(f"Incidents (clusters):  {len(incidents)}")
    if total_alerts and incidents:
        noise_reduction = 100.0 * (total_alerts - len(incidents)) / total_alerts
        print(f"Noise reduction:       {noise_reduction:.1f}% "
              f"({total_alerts} alerts -> {len(incidents)} incidents)")

    sizes = sorted(len(inc['member_alerts']) for inc in incidents)
    if sizes:
        print(f"\nCluster size distribution:")
        print(f"  min={sizes[0]}  median={sizes[len(sizes)//2]}  max={sizes[-1]}")

    from collections import Counter
    status_counts = Counter(inc['status'] for inc in incidents)
    print(f"\nBy status:")
    for s, c in status_counts.most_common():
        print(f"  {s}: {c}")

    sev_counts = Counter(inc['root_cause_alert']['severity'] for inc in incidents)
    print(f"\nRoot-cause severity:")
    for sev, c in sev_counts.most_common():
        print(f"  {sev}: {c}")

    print("\nSample incidents (first 3):")
    for inc in incidents[:3]:
        print(f"\n  {inc['incident_id']}  [{inc['status']}]  conf={inc['confidence']}  "
              f"members={len(inc['member_alerts'])}  suppressed={inc['suppressed_count']}")
        print(f"    root: {inc['root_cause_alert']['severity']} "
              f"{inc['root_cause_alert']['service']} :: "
              f"{inc['root_cause_alert'].get('message','')[:80]}")
        print(f"    span: {inc['time_span']['start']}  ->  {inc['time_span']['end']}")
    print("=" * 60)


# ---------------------------------------------------------------------------
# Synthetic self-test — runnable WITHOUT the 1.5GB data, validates the algo
# end-to-end. Builds deterministic fake alerts + embeddings shaped like three
# incident bursts plus noise.
# ---------------------------------------------------------------------------
def selftest():
    print("Running synthetic self-test (no real data needed)...\n")
    base = datetime(2008, 11, 10, 9, 0, 0)

    templates = [
        ("dfs.DataNode", "Connection reset by peer", [0]),
        ("dfs.DataNode", "Datanode unreachable: connection timed out", [0]),
        ("hdfs.server.namenode", "NameNode metadata sync failed", [1]),
        ("hdfs.server.namenode", "Edit log sync failed", [1]),
        ("org.apache.spark.executor", "GC overhead limit exceeded", [2]),
        ("org.apache.spark.executor", "Executor lost: heartbeat timeout", [2]),
        ("dfs.FSNamesystem", "Routine heartbeat check ok", [3]),
        ("mapred.TaskTracker", "Task progress update received", [3]),
    ]
    # Per-template base embedding: templates in the same burst share a basis
    # vector so within-burst cos ~ high, across-burst ~ low.
    dim = 16
    basis = np.eye(dim, dtype=np.float32)

    alerts = []
    emb = []
    # burst 0 at t=0..200s (DataNode cascade) — repeated identical messages
    for _ in range(6):
        for tname in templates[0:2]:
            alerts.append(_mk_alert(base, tname, "ERROR"))
            emb.append(basis[0] + _small_noise())
    # burst 1 at t=0 (NameNode) — overlap in time with burst 0 but different meaning
    for _ in range(3):
        for tname in templates[2:3]:
            alerts.append(_mk_alert(base, tname, "ERROR"))
            emb.append(basis[1] + _small_noise())
    # burst 2 at t=3600..3800s (Spark) — far in time
    for _ in range(4):
        for tname in templates[4:5]:
            alerts.append(_mk_alert(base + timedelta(seconds=3600), tname, "WARN"))
            emb.append(basis[2] + _small_noise())
    # noise (INFO heartbeat) scattered
    for s in range(0, 4000, 120):
        alerts.append(_mk_alert(base + timedelta(seconds=s), templates[6], "INFO"))
        emb.append(basis[3] + _small_noise())

    alerts.sort(key=lambda a: a['timestamp'])
    emb = np.vstack(emb)
    emb_norm = l2_normalize(emb)
    clusters = build_clusters(alerts, emb_norm, DEFAULT_WINDOW_SEC, DEFAULT_SIM_THRESHOLD)

    member_index = []
    incidents = []
    for n, (_, members) in enumerate(clusters.items(), start=1):
        inc, root_idx = build_incident(n, members, alerts, emb_norm)
        inc['_root_idx'] = root_idx
        incidents.append(inc)
        for m in members:
            member_index.append((m, inc))

    sanity_report(incidents, len(alerts))
    print("\nSelf-test expectation: 3 incident bursts + 1 noise cluster for heartbeats.")
    inc_ids = [i['incident_id'] for i in incidents]
    assert len(incidents) >= 3, f"expected >=3 clusters, got {len(incidents)}"
    for inc in incidents[:3]:
        if inc['root_cause_alert']['severity'] == 'WARN':
            assert inc['root_cause_alert']['source'] in ('spark',), inc
    print("Self-test PASSED.")
    return incidents


def _mk_alert(ts, tname, severity):
    service, message, _ = tname
    return {
        'timestamp': ts.isoformat(),
        'source': 'spark' if 'spark' in service else 'hdfs',
        'service': service,
        'severity': severity,
        'message': message,
        'cleaned_message': message,
        'event_id': 'unknown',
        'raw_line': f"raw {service} {message}",
    }


def _small_noise():
    # deterministic pseudo-noise (Date/random not available; use a fixed pattern)
    v = np.zeros(16, dtype=np.float32)
    v[5] = 0.05
    return v


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main():
    p = argparse.ArgumentParser(description="Time-windowed similarity alert clusterer")
    p.add_argument('--alerts', default='demo_alerts.csv', help="unified alert CSV (default: demo_alerts.csv)")
    p.add_argument('--embeddings', default='demo_embeddings.npy', help="aligned embedding .npy")
    p.add_argument('--window-sec', type=float, default=DEFAULT_WINDOW_SEC, help="time window in seconds")
    p.add_argument('--sim-threshold', type=float, default=DEFAULT_SIM_THRESHOLD, help="cosine similarity threshold")
    p.add_argument('--out-json', default='incidents.json')
    p.add_argument('--out-csv', default='clusters.csv')
    p.add_argument('--selftest', action='store_true', help="run synthetic self-test (no real data needed)")
    args = p.parse_args()

    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    if args.selftest:
        selftest()
        return

    # Real-pipeline path: need the artifacts embed_alerts.py/clean_text.py produce
    here = os.path.dirname(os.path.abspath(__file__))
    ap = os.path.join(here, args.alerts)
    ep = os.path.join(here, args.embeddings)
    if not os.path.exists(ap):
        print(f"Error: {ap} not found. Run parse_logs.py -> extract_alerts.py -> "
              f"clean_text.py to produce it first.")
        return 1
    if not os.path.exists(ep):
        print(f"Error: {ep} not found. Run embed_alerts.py first to generate embeddings.")
        return 1

    emb_full = np.load(ep)
    alerts, kept = load_alerts(ap, expected_embedding_count=emb_full.shape[0])
    if not alerts:
        print("Error: no alerts survived loading (check timestamp/message columns).")
        return 1

    emb = load_embeddings(ep, kept)
    emb_norm = l2_normalize(emb)

    # sort by timestamp for the sliding window (load preserved CSV order — sort now)
    order = sorted(range(len(alerts)), key=lambda i: alerts[i]['timestamp'])
    alerts = [alerts[i] for i in order]
    emb_norm = emb_norm[order]

    clusters = build_clusters(alerts, emb_norm, args.window_sec, args.sim_threshold)

    member_index = []
    incidents = []
    for n, (_, members) in enumerate(clusters.items(), start=1):
        inc, root_idx = build_incident(n, members, alerts, emb_norm)
        inc['_root_idx'] = root_idx
        incidents.append(inc)
        for m in members:
            member_index.append((m, inc))

    write_outputs(incidents, member_index, alerts, args.out_json, args.out_csv)
    sanity_report(incidents, len(alerts))
    # strip internal key before anything downstream re-reads the json
    for inc in incidents:
        inc.pop('_root_idx', None)
    with open(args.out_json, 'w', encoding='utf-8') as f:
        json.dump(incidents, f, indent=2)
    print("\nDone! incidents.json + clusters.csv ready for the root-cause / LLM stage.")


if __name__ == '__main__':
    sys_exit = main()
    raise SystemExit(sys_exit if isinstance(sys_exit, int) else 0)