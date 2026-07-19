"""
run_aiops_pipeline.py — End-to-end pipeline for the AIOps Challenge dataset.

Runs the complete flow on AIOps data:
  1. Filter aiops_parsed.csv → keep only WARN/ERROR/FATAL alerts
  2. Deduplicate
  3. Clean text (strip IDs, IPs, numbers)
  4. Generate embeddings (sentence-transformers)
  5. Cluster alerts (time-windowed cosine similarity)
  6. Rank root causes within each cluster
  7. Compare predicted root causes against ground truth labels
  8. Output accuracy metrics

This is a self-contained script so the pipeline runs sequentially without
needing to manually chain parse→extract→clean→embed→cluster.

Usage:
  python3 run_aiops_pipeline.py                    # full run
  python3 run_aiops_pipeline.py --max-alerts 5000  # quick test with subset
"""

import csv
import json
import os
import sys
import time
import re
import argparse
import numpy as np
from datetime import datetime, timezone, timedelta
from collections import Counter, defaultdict

# Add parent data dir to path for imports
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from clean_text import clean_message
from cluster_alerts import (
    UnionFind, l2_normalize, build_clusters, segment_clusters, rank_cluster,
    build_incident, make_title, sanity_report, base_service,
    ALERT_FIELDS, CLEANED_COL,
    DEFAULT_WINDOW_SEC, DEFAULT_SIM_THRESHOLD, CONF_FLOOR, MIN_CLUSTER_SIZE,
    DEFAULT_CROSS_SERVICE_THRESHOLD, DEFAULT_MAX_GAP_SEC, DEFAULT_MAX_SPAN_SEC,
)

# ---------------------------------------------------------------------------
# Step 1 + 2: Filter & deduplicate
# ---------------------------------------------------------------------------
def filter_and_dedup(parsed_csv, severities=('WARN', 'ERROR', 'FATAL'),
                     start=None, end=None):
    """Load aiops_parsed.csv, keep only alert-level severities, deduplicate.

    start/end bound the alert timestamps (inclusive/exclusive). All timestamps
    are UTC ISO-8601 from parse_aiops.py, so plain string comparison is
    chronological — a date prefix like '2022-03-20' works as a day bound.
    Without a bound, --max-alerts would otherwise grab only the earliest
    (pre-fault) data: 2022-03-19 has 26K alerts and zero ground truth faults.
    """
    print("=" * 60)
    print("STEP 1: Filter & Deduplicate")
    print("=" * 60)

    alerts = []
    total = 0
    skipped_window = 0
    with open(parsed_csv, 'r', encoding='utf-8', errors='ignore') as f:
        reader = csv.DictReader(f)
        for row in reader:
            total += 1
            if row.get('severity') in severities:
                ts = row.get('timestamp', '')
                if (start and ts < start) or (end and ts >= end):
                    skipped_window += 1
                    continue
                # Fill missing fields
                for key in row:
                    if not row[key] or row[key].strip() == '':
                        row[key] = 'unknown'
                alerts.append(row)

    print(f"  Total rows scanned: {total:,}")
    if start or end:
        print(f"  Time window: [{start or '-inf'}, {end or '+inf'}) "
              f"— skipped {skipped_window:,} outside")
    print(f"  After severity filter: {len(alerts):,}")

    # Deduplicate by (timestamp, service, message) — service must be in the
    # key or same-second alerts from different replicas drop each other.
    seen = set()
    unique = []
    for a in alerts:
        key = (a['timestamp'], a['service'], a['message'])
        if key not in seen:
            seen.add(key)
            unique.append(a)

    removed = len(alerts) - len(unique)
    print(f"  Duplicates removed: {removed:,}")
    print(f"  Final alert count: {len(unique):,}")

    # Sort by timestamp
    unique.sort(key=lambda a: a['timestamp'])

    # Stats
    sev_counts = Counter(a['severity'] for a in unique)
    svc_counts = Counter(a['service'] for a in unique)
    print(f"\n  By severity: {dict(sev_counts)}")
    print(f"  Top services:")
    for svc, c in svc_counts.most_common(10):
        print(f"    {svc}: {c}")

    return unique


# ---------------------------------------------------------------------------
# Step 3: Clean text
# ---------------------------------------------------------------------------
def clean_alerts(alerts):
    """Add cleaned_message column to each alert."""
    print("\n" + "=" * 60)
    print("STEP 2: Clean Text")
    print("=" * 60)

    for a in alerts:
        a['cleaned_message'] = clean_message(a['message'])

    unique_types = len(set(a['cleaned_message'] for a in alerts))
    print(f"  Cleaned {len(alerts):,} alerts")
    print(f"  Unique message types after cleaning: {unique_types}")

    # Show sample cleaned messages
    print(f"\n  Sample cleaned messages:")
    samples = list(set(a['cleaned_message'] for a in alerts))[:5]
    for s in samples:
        print(f"    → {s[:100]}")

    return alerts


# ---------------------------------------------------------------------------
# Step 4: Embed
# ---------------------------------------------------------------------------
def embed_alerts(alerts, model_name='all-MiniLM-L6-v2'):
    """Generate embeddings over "service: cleaned_message" text.

    The AIOps testbed produces only a handful of distinct message templates
    ("request error", "NullPointerException", ...) shared by every service, so
    message-only embeddings collapse the whole day into a few mega-clusters.
    Prefixing the base service name ("frontend: request error" vs
    "checkoutservice: request error") makes the embedding itself carry the
    service signal."""
    print("\n" + "=" * 60)
    print("STEP 3: Generate Embeddings")
    print("=" * 60)

    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        print("ERROR: sentence-transformers not installed.")
        print("Run: pip install sentence-transformers")
        sys.exit(1)

    print(f"  Loading model: {model_name}...")
    model = SentenceTransformer(model_name)

    messages = []
    for a in alerts:
        svc = base_service(a.get('service'))
        msg = a['cleaned_message']
        messages.append(f"{svc}: {msg}" if svc and svc != 'unknown' else msg)
    print(f"  Encoding {len(messages):,} service-tagged messages...")
    start = time.time()
    embeddings = model.encode(messages, show_progress_bar=True, batch_size=256)
    elapsed = time.time() - start

    print(f"  Done in {elapsed:.1f}s — shape: {embeddings.shape}")
    return embeddings


# ---------------------------------------------------------------------------
# Step 5 + 6: Cluster & rank
# ---------------------------------------------------------------------------
def cluster_and_rank(alerts, embeddings, window_sec, sim_threshold,
                     cross_service_threshold, max_gap_sec, max_span_sec):
    """Build similarity graph, segment clusters in time, rank root causes."""
    print("\n" + "=" * 60)
    print("STEP 4: Cluster & Rank Root Causes")
    print("=" * 60)
    print(f"  Cross-service threshold: {cross_service_threshold}")
    print(f"  Segmentation: max gap {max_gap_sec}s, max span {max_span_sec}s")

    emb_norm = l2_normalize(embeddings)
    clusters = build_clusters(alerts, emb_norm, window_sec, sim_threshold,
                              cross_service_threshold=cross_service_threshold)
    # Bound chronic error streams: without segmentation, a service that logs
    # the same error every few seconds chains into one cluster spanning the
    # whole dataset and "detects" every fault by time overlap alone.
    segments = segment_clusters(clusters, alerts,
                                max_gap_sec=max_gap_sec,
                                max_span_sec=max_span_sec)
    print(f"  {len(clusters)} connected components -> "
          f"{len(segments)} time-bounded segments")

    incidents = []
    member_index = []
    for n, members in enumerate(segments, start=1):
        inc, root_idx = build_incident(n, members, alerts, emb_norm)
        inc['_root_idx'] = root_idx
        incidents.append(inc)
        for m in members:
            member_index.append((m, inc))

    sanity_report(incidents, len(alerts))
    return incidents, member_index


# ---------------------------------------------------------------------------
# Step 7: Compare against ground truth
# ---------------------------------------------------------------------------
def load_groundtruth(gt_csv):
    """Load the merged ground truth CSV."""
    records = []
    with open(gt_csv, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            records.append(row)
    return records


def evaluate_against_groundtruth(incidents, gt_records, time_tolerance_sec=600):
    """Compare predicted incidents/root causes against labeled ground truth.

    For each ground truth fault, we check:
    1. Did we create an incident cluster near that time? (within time_tolerance)
    2. Does the incident's root cause alert reference the correct cmdb_id (service)?
    3. Does the incident capture the right failure type?

    Scoring:
    - Detection rate: what % of ground truth faults have a matching incident?
      NOTE: this only needs ANY incident nearby, so chronic background error
      streams (which produce incidents around the clock) inflate it. The
      service-matched variant below is the honest number.
    - Service-matched detection: % of faults with a nearby incident whose
      members include the faulted service — "right service at the right time".
    - Localization accuracy: of detected faults, what % identified the right service?
    - Root cause accuracy: of detected faults, what % had the right service as root?
    """
    print("\n" + "=" * 60)
    print("STEP 5: Evaluate Against Ground Truth")
    print("=" * 60)

    if not gt_records:
        print("  No ground truth available — skipping evaluation.")
        return {}

    print(f"  Ground truth faults: {len(gt_records)}")
    print(f"  Predicted incidents: {len(incidents)}")
    print(f"  Time tolerance: ±{time_tolerance_sec}s ({time_tolerance_sec//60} min)")

    # Build incident lookup by time windows
    incident_by_time = []
    for inc in incidents:
        try:
            start = datetime.fromisoformat(inc['time_span']['start'])
            end = datetime.fromisoformat(inc['time_span']['end'])
            root_service = inc['root_cause_alert'].get('service', 'unknown')
            root_msg = inc['root_cause_alert'].get('message', '')
            # Collect all services in the cluster
            member_services = set(a.get('service', '') for a in inc['member_alerts'])
            incident_by_time.append({
                'incident': inc,
                'start': start,
                'end': end,
                'root_service': root_service,
                'root_msg': root_msg,
                'member_services': member_services,
                'member_count': len(inc['member_alerts']),
            })
        except (ValueError, KeyError):
            continue

    # Match each ground truth fault to nearest incident
    results = []
    for gt in gt_records:
        try:
            gt_time = datetime.fromisoformat(gt['timestamp'])
        except (ValueError, KeyError):
            continue

        gt_cmdb = gt['cmdb_id']
        gt_type = gt.get('failure_type_en', gt.get('failure_type', ''))
        gt_level = gt.get('level', '')

        # Extract the base service name from cmdb_id
        # e.g., "cartservice-0" → "cartservice", "node-1" → "node-1"
        gt_service_base = re.sub(r'-\d+$', '', gt_cmdb)

        best_match = None
        best_dist = float('inf')

        for entry in incident_by_time:
            # Check time overlap: incident window should be near the fault time
            inc_start = entry['start']
            inc_end = entry['end']
            tolerance = timedelta(seconds=time_tolerance_sec)

            # Fault should be within [inc_start - tolerance, inc_end + tolerance]
            if gt_time < inc_start - tolerance or gt_time > inc_end + tolerance:
                continue

            # Time distance to the incident's center
            inc_center = inc_start + (inc_end - inc_start) / 2
            dist = abs((gt_time - inc_center).total_seconds())

            # Check if any member references the ground truth service
            service_match = any(
                gt_cmdb in svc or gt_service_base in svc
                for svc in entry['member_services']
            )

            # Prefer incidents that mention the right service
            adj_dist = dist if service_match else dist + 100000

            if adj_dist < best_dist:
                best_dist = adj_dist
                best_match = entry

        detected = best_match is not None
        localized = False
        root_localized = False

        if detected:
            root_svc = best_match['root_service']
            member_svcs = best_match['member_services']

            # Check if the fault's cmdb_id appears anywhere in the cluster
            localized = any(
                gt_cmdb in svc or gt_service_base in svc
                for svc in member_svcs
            )

            # Check if the root cause specifically points to the right service
            root_localized = (
                gt_cmdb in root_svc or gt_service_base in root_svc
            )

        results.append({
            'gt_time': gt_time.isoformat(),
            'gt_cmdb': gt_cmdb,
            'gt_type': gt_type,
            'gt_level': gt_level,
            'detected': detected,
            'localized': localized,
            'root_localized': root_localized,
            'matched_incident': best_match['incident']['incident_id'] if detected else None,
            'matched_root_service': best_match['root_service'] if detected else None,
            'matched_cluster_size': best_match['member_count'] if detected else None,
        })

    # Compute metrics
    n_total = len(results)
    n_detected = sum(1 for r in results if r['detected'])
    n_svc_detected = sum(1 for r in results if r['detected'] and r['localized'])
    n_localized = sum(1 for r in results if r['localized'])
    n_root_localized = sum(1 for r in results if r['root_localized'])

    detection_rate = n_detected / n_total * 100 if n_total else 0
    svc_detection_rate = n_svc_detected / n_total * 100 if n_total else 0
    localization_rate = n_localized / n_detected * 100 if n_detected else 0
    root_accuracy = n_root_localized / n_detected * 100 if n_detected else 0

    metrics = {
        'total_faults': n_total,
        'detected': n_detected,
        'service_matched_detected': n_svc_detected,
        'localized': n_localized,
        'root_localized': n_root_localized,
        'detection_rate': round(detection_rate, 1),
        'detection_rate_service_matched': round(svc_detection_rate, 1),
        'localization_rate': round(localization_rate, 1),
        'root_cause_accuracy': round(root_accuracy, 1),
    }

    print(f"\n  {'─' * 50}")
    print(f"  EVALUATION RESULTS")
    print(f"  {'─' * 50}")
    print(f"  Total ground truth faults:    {n_total}")
    print(f"  Detected (incident nearby):   {n_detected}/{n_total} "
          f"({detection_rate:.1f}%)  ← inflated by chronic background clusters")
    print(f"  Detected w/ right service:    {n_svc_detected}/{n_total} "
          f"({svc_detection_rate:.1f}%)  ← honest detection")
    print(f"  Service localized (in cluster): {n_localized}/{n_detected} "
          f"({localization_rate:.1f}%)")
    print(f"  Root cause correct:           {n_root_localized}/{n_detected} "
          f"({root_accuracy:.1f}%)")
    print(f"  {'─' * 50}")

    # Breakdown by failure type
    type_results = defaultdict(lambda: {'total': 0, 'detected': 0, 'svc': 0,
                                        'localized': 0, 'root': 0})
    for r in results:
        t = r['gt_type']
        type_results[t]['total'] += 1
        if r['detected']:
            type_results[t]['detected'] += 1
        if r['detected'] and r['localized']:
            type_results[t]['svc'] += 1
        if r['localized']:
            type_results[t]['localized'] += 1
        if r['root_localized']:
            type_results[t]['root'] += 1

    print(f"\n  By failure type:")
    for ft, counts in sorted(type_results.items(), key=lambda x: -x[1]['total']):
        det_pct = counts['detected'] / counts['total'] * 100 if counts['total'] else 0
        svc_pct = counts['svc'] / counts['total'] * 100 if counts['total'] else 0
        print(f"    {ft}: {counts['detected']}/{counts['total']} detected ({det_pct:.0f}%), "
              f"svc-matched: {counts['svc']}/{counts['total']} ({svc_pct:.0f}%), "
              f"root correct: {counts['root']}/{counts['detected'] or 1}")

    # Breakdown by level
    level_results = defaultdict(lambda: {'total': 0, 'detected': 0})
    for r in results:
        level_results[r['gt_level']]['total'] += 1
        if r['detected']:
            level_results[r['gt_level']]['detected'] += 1

    print(f"\n  By level:")
    for lv, counts in level_results.items():
        det_pct = counts['detected'] / counts['total'] * 100 if counts['total'] else 0
        print(f"    {lv}: {counts['detected']}/{counts['total']} ({det_pct:.0f}%)")

    # Show undetected faults
    undetected = [r for r in results if not r['detected']]
    if undetected:
        print(f"\n  Undetected faults ({len(undetected)}):")
        for r in undetected[:10]:
            print(f"    {r['gt_time']} | {r['gt_cmdb']} | {r['gt_type']}")
        if len(undetected) > 10:
            print(f"    ... and {len(undetected) - 10} more")

    print(f"  {'─' * 50}")

    return metrics, results


# ---------------------------------------------------------------------------
# Save outputs
# ---------------------------------------------------------------------------
def save_outputs(incidents, eval_metrics, eval_results, out_dir):
    """Save incidents JSON, evaluation results, and metrics."""

    # Clean internal keys before saving
    clean_incidents = []
    for inc in incidents:
        inc_copy = {k: v for k, v in inc.items() if not k.startswith('_')}
        clean_incidents.append(inc_copy)

    # incidents.json
    inc_path = os.path.join(out_dir, 'aiops_incidents.json')
    with open(inc_path, 'w', encoding='utf-8') as f:
        json.dump(clean_incidents, f, indent=2, default=str)
    print(f"\n  Saved {len(clean_incidents)} incidents → {inc_path}")

    # evaluation_results.json
    if eval_metrics:
        eval_path = os.path.join(out_dir, 'aiops_evaluation.json')
        with open(eval_path, 'w', encoding='utf-8') as f:
            json.dump({
                'metrics': eval_metrics,
                'details': eval_results,
            }, f, indent=2, default=str)
        print(f"  Saved evaluation → {eval_path}")

    # Summary markdown
    summary_path = os.path.join(out_dir, 'aiops_pipeline_summary.md')
    with open(summary_path, 'w', encoding='utf-8') as f:
        f.write("# AIOps Pipeline Results\n\n")
        f.write(f"**Total incidents:** {len(clean_incidents)}\n\n")
        if eval_metrics:
            f.write("## Evaluation Against Ground Truth\n\n")
            f.write(f"| Metric | Value |\n|---|---|\n")
            f.write(f"| Ground truth faults | {eval_metrics['total_faults']} |\n")
            f.write(f"| Detection rate (any incident nearby) | {eval_metrics['detection_rate']}% |\n")
            f.write(f"| **Detection rate (service-matched)** | "
                    f"**{eval_metrics.get('detection_rate_service_matched', 0)}%** |\n")
            f.write(f"| Service localization | {eval_metrics['localization_rate']}% |\n")
            f.write(f"| Root cause accuracy | {eval_metrics['root_cause_accuracy']}% |\n")
        f.write(f"\n## Top Incidents\n\n")
        for inc in clean_incidents[:5]:
            f.write(f"### {inc['incident_id']}: {inc.get('title', 'untitled')}\n")
            f.write(f"- **Status:** {inc['status']}\n")
            f.write(f"- **Confidence:** {inc['confidence']}\n")
            f.write(f"- **Members:** {len(inc['member_alerts'])} alerts\n")
            f.write(f"- **Time span:** {inc['time_span']['start']} → {inc['time_span']['end']}\n")
            f.write(f"- **Root cause:** {inc['root_cause_alert'].get('service', '?')} — "
                    f"{inc['root_cause_alert'].get('message', '?')[:100]}\n\n")
    print(f"  Saved summary → {summary_path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    p = argparse.ArgumentParser(description='Run full AIOps pipeline')
    p.add_argument('--parsed', default='../aiops_parsed.csv',
                   help='Parsed AIOps CSV (output of parse_aiops.py)')
    p.add_argument('--groundtruth', default='../aiops_groundtruth.csv',
                   help='Ground truth CSV (output of parse_aiops.py)')
    p.add_argument('--start', default=None,
                   help='Only keep alerts at/after this ISO date or timestamp '
                        '(e.g. 2022-03-20). Ground truth faults start 2022-03-20.')
    p.add_argument('--end', default=None,
                   help='Only keep alerts before this ISO date or timestamp (exclusive)')
    p.add_argument('--max-alerts', type=int, default=None,
                   help='Cap alert count by sampling EVENLY across the whole time '
                        'range (not head-truncation, which only sees pre-fault data)')
    p.add_argument('--window-sec', type=float, default=DEFAULT_WINDOW_SEC,
                   help=f'Time window in seconds (default: {DEFAULT_WINDOW_SEC})')
    p.add_argument('--sim-threshold', type=float, default=DEFAULT_SIM_THRESHOLD,
                   help=f'Cosine similarity threshold (default: {DEFAULT_SIM_THRESHOLD})')
    p.add_argument('--cross-service-threshold', type=float,
                   default=DEFAULT_CROSS_SERVICE_THRESHOLD,
                   help=f'Similarity required for edges between different services '
                        f'(default: {DEFAULT_CROSS_SERVICE_THRESHOLD})')
    p.add_argument('--max-gap-sec', type=float, default=DEFAULT_MAX_GAP_SEC,
                   help=f'Split clusters when members are >this many seconds apart '
                        f'(default: {DEFAULT_MAX_GAP_SEC})')
    p.add_argument('--max-span-sec', type=float, default=DEFAULT_MAX_SPAN_SEC,
                   help=f'Max cluster duration in seconds (default: {DEFAULT_MAX_SPAN_SEC})')
    p.add_argument('--time-tolerance', type=int, default=600,
                   help='Time tolerance for ground truth matching in seconds (default: 600)')
    p.add_argument('--model', default='all-MiniLM-L6-v2',
                   help='Sentence transformer model name')
    args = p.parse_args()

    os.chdir(SCRIPT_DIR)
sys.path.insert(0, os.path.dirname(SCRIPT_DIR))  # parent dir (data/) for module imports

    print("\n" + "█" * 60)
    print("  AIOps FULL PIPELINE")
    print("█" * 60)
    print(f"  Parsed CSV:    {args.parsed}")
    print(f"  Ground truth:  {args.groundtruth}")
    print(f"  Time range:    [{args.start or '-inf'}, {args.end or '+inf'})")
    print(f"  Window:        {args.window_sec}s")
    print(f"  Sim threshold: {args.sim_threshold} (cross-service: {args.cross_service_threshold})")
    print(f"  Segmentation:  max gap {args.max_gap_sec}s, max span {args.max_span_sec}s")
    print(f"  Max alerts:    {args.max_alerts or 'all'}")
    print("█" * 60 + "\n")

    if not os.path.exists(args.parsed):
        print(f"ERROR: {args.parsed} not found. Run parse_aiops.py first.")
        return 1

    pipeline_start = time.time()

    # Step 1+2: Filter & deduplicate
    alerts = filter_and_dedup(args.parsed, start=args.start, end=args.end)

    if not alerts:
        print("ERROR: No alerts after filtering. Check the parsed CSV "
              "(and that --start/--end overlap the data).")
        return 1

    # Apply max-alerts cap by EVEN sampling across the time range — head
    # truncation (alerts[:n]) only sees the earliest data, which for AIOps is
    # the pre-fault baseline day with zero ground truth.
    if args.max_alerts and len(alerts) > args.max_alerts:
        step = len(alerts) / args.max_alerts
        alerts = [alerts[int(i * step)] for i in range(args.max_alerts)]
        print(f"\n  [Sampled {args.max_alerts:,} alerts evenly across "
              f"{alerts[0]['timestamp'][:10]} → {alerts[-1]['timestamp'][:10]}]")

    # Step 3: Clean text
    alerts = clean_alerts(alerts)

    # Step 4: Embed
    embeddings = embed_alerts(alerts, model_name=args.model)

    # Step 5+6: Cluster & rank
    incidents, member_index = cluster_and_rank(
        alerts, embeddings, args.window_sec, args.sim_threshold,
        args.cross_service_threshold, args.max_gap_sec, args.max_span_sec
    )

    # Step 7: Evaluate
    eval_metrics = {}
    eval_results = []
    if os.path.exists(args.groundtruth):
        gt_records = load_groundtruth(args.groundtruth)
        eval_metrics, eval_results = evaluate_against_groundtruth(
            incidents, gt_records, time_tolerance_sec=args.time_tolerance
        )
    else:
        print(f"\n  Ground truth file not found ({args.groundtruth}), skipping evaluation.")

    # Save outputs
    save_outputs(incidents, eval_metrics, eval_results, SCRIPT_DIR)

    elapsed = time.time() - pipeline_start
    print(f"\n{'█' * 60}")
    print(f"  PIPELINE COMPLETE — {elapsed:.1f}s total")
    noise_red = 100 * (len(alerts) - len(incidents)) / len(alerts) if alerts else 0
    print(f"  {len(alerts):,} alerts → {len(incidents)} incidents "
          f"({noise_red:.1f}% noise reduction)")
    if eval_metrics:
        print(f"  Detection (svc-matched): {eval_metrics.get('detection_rate_service_matched', 0)}% | "
              f"Detection (any nearby): {eval_metrics['detection_rate']}% | "
              f"Localization: {eval_metrics['localization_rate']}% | "
              f"Root cause: {eval_metrics['root_cause_accuracy']}%")
    print(f"{'█' * 60}\n")

    return 0


if __name__ == '__main__':
    sys.exit(main() or 0)
