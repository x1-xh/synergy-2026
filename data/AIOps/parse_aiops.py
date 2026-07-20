"""
parse_aiops.py — AIOps Challenge Dataset Parser

Parses the AIOps Challenge 2022 dataset (Kubernetes microservice testbed) and
maps it to the shared alert format used by the rest of the pipeline.

Data layout understood:
  ds/
  ├── training_data_with_faults/
  │   ├── training_data_with_faults/
  │   │   ├── tar/                       ← 7 date-cloudbed dirs
  │   │   │   └── YYYY-MM-DD-cloudbedN/
  │   │   │       ├── log/all/
  │   │   │       │   ├── log_filebeat-testbed-log-service.csv   (app logs)
  │   │   │       │   └── log_filebeat-testbed-log-envoy.csv     (gateway)
  │   │   │       ├── metric/container/   (KPI CSVs — not parsed here)
  │   │   │       └── trace/all/          (Jaeger spans — parsed for errors)
  │   │   └── groundtruth/               ← CSV ground truth per cluster/date
  │   └── training_data_with_faults_groundtruth/  ← same CSV ground truth
  └── 初赛评分数据/
      ├── YYYY-MM-DD/cloudbed/           ← same log/metric/trace structure
      └── groundtruth/                   ← JSON ground truth per date

Service log format (value column):
  "severity: info, message: conversion request successful"
  OR free-form text (cartservice .NET logs, etc.)

Envoy log format (value column):
  "POST /hipstershop.AdService/GetAds HTTP/2" 200 - via_upstream ...

Trace format:
  timestamp,cmdb_id,span_id,trace_id,duration,type,status_code,operation_name,parent_span

Ground truth format (CSV):
  timestamp,level,cmdb_id,failure_type

Ground truth format (JSON):
  {"timestamp": [...], "level": [...], "cmdb_id": [...], "failure_type": [...]}

Output files:
  aiops_parsed.csv        — all parsed alerts in the shared 7-column format
  aiops_groundtruth.csv   — merged ground truth from all sources, normalized

Key decisions:
  - We parse BOTH service logs AND envoy logs. Service logs give us application-
    level errors; envoy logs give us HTTP 5xx and connection failures.
  - Traces are parsed only for error spans (status_code != 0 or high duration).
  - Severity mapping: service logs embed severity in the value field. Envoy logs
    use HTTP status code (5xx=ERROR, 4xx=WARN). Traces use status_code.
  - source = "aiops" for all records (distinguishes from hdfs/spark).
  - cmdb_id becomes the service column (e.g. "frontend-0", "cartservice-1").
  - AIOps timestamps are Unix epoch seconds (or ms for traces). Normalized to ISO-8601.
  - Ground truth failure_type is in Chinese; we keep it as-is for matching and
    also add an English translation for the dashboard/LLM explanation.
"""

import csv
import json
import os
import re
import glob
from datetime import datetime, timezone
from collections import Counter

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DS_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'ds')

ALERT_FIELDS = ['timestamp', 'source', 'service', 'severity', 'message', 'event_id', 'raw_line']

# Severity from structured service log value field
SERVICE_SEVERITY_RE = re.compile(r'severity:\s*(\w+)', re.IGNORECASE)
SERVICE_MESSAGE_RE = re.compile(r'message:\s*(.*)', re.IGNORECASE)

# Envoy HTTP status extraction (first quoted string: "METHOD path HTTP/ver" STATUS ...)
ENVOY_STATUS_RE = re.compile(r'"[^"]*"\s+(\d{3})')

# Chinese → English failure type translations (for dashboard display)
FAILURE_TYPE_EN = {
    'k8s容器cpu负载': 'k8s container CPU overload',
    'k8s容器内存负载': 'k8s container memory overload',
    'k8s容器读io负载': 'k8s container read I/O overload',
    'k8s容器写io负载': 'k8s container write I/O overload',
    'k8s容器网络丢包': 'k8s container network packet loss',
    'k8s容器网络延迟': 'k8s container network latency',
    'k8s容器网络资源包损坏': 'k8s container network packet corruption',
    'k8s容器网络资源包重复发送': 'k8s container network packet retransmission',
    'k8s容器进程中止': 'k8s container process killed',
    'node节点CPU故障': 'node CPU fault',
    'node节点CPU爬升': 'node CPU ramp-up',
    'node 内存消耗': 'node memory exhaustion',
    'node 磁盘读IO消耗': 'node disk read I/O exhaustion',
    'node 磁盘写IO消耗': 'node disk write I/O exhaustion',
    'node 磁盘空间消耗': 'node disk space exhaustion',
}


# ---------------------------------------------------------------------------
# Timestamp helpers
# ---------------------------------------------------------------------------
def epoch_to_iso(epoch_sec):
    """Convert Unix epoch seconds to ISO-8601 string."""
    return datetime.fromtimestamp(int(epoch_sec), tz=timezone.utc).isoformat()


def epoch_ms_to_iso(epoch_ms):
    """Convert Unix epoch milliseconds to ISO-8601 string."""
    return datetime.fromtimestamp(int(epoch_ms) / 1000.0, tz=timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Service log parser
# ---------------------------------------------------------------------------
def parse_service_log(csv_path, writer, stats):
    """Parse log_filebeat-testbed-log-service.csv

    Columns: log_id, timestamp, cmdb_id, log_name, value

    The 'value' field has two formats:
      1. Structured: "severity: info, message: conversion request successful"
      2. Free-form: raw .NET / Java log lines
    """
    if not os.path.exists(csv_path):
        print(f"  [skip] {csv_path} not found")
        return

    print(f"  Parsing service log: {os.path.basename(os.path.dirname(os.path.dirname(csv_path)))} ...")

    count = 0
    with open(csv_path, 'r', encoding='utf-8', errors='ignore') as f:
        reader = csv.DictReader(f)
        for row in reader:
            log_id = row.get('log_id', '')
            ts_raw = row.get('timestamp', '')
            cmdb_id = row.get('cmdb_id', 'unknown')
            value = row.get('value', '')

            if not ts_raw:
                continue

            # Extract severity and message from the value field
            sev_match = SERVICE_SEVERITY_RE.search(value)
            msg_match = SERVICE_MESSAGE_RE.search(value)

            if sev_match:
                raw_sev = sev_match.group(1).upper()
                severity = _normalize_severity(raw_sev)
                message = msg_match.group(1).strip() if msg_match else value
            else:
                # Free-form log line — infer severity from content
                severity = _infer_severity_from_text(value)
                message = value.strip()

            # Truncate extremely long messages (some .NET stack traces are huge)
            if len(message) > 500:
                message = message[:497] + '...'

            try:
                ts_iso = epoch_to_iso(ts_raw)
            except (ValueError, OSError):
                stats['bad_ts'] += 1
                continue

            writer.writerow([
                ts_iso,
                'aiops',
                cmdb_id,
                severity,
                message,
                log_id,
                value[:200],  # truncated raw line
            ])
            count += 1
            stats[severity] += 1

    stats['service_logs'] += count
    print(f"    → {count:,} log entries parsed")


# ---------------------------------------------------------------------------
# Envoy gateway log parser
# ---------------------------------------------------------------------------
def parse_envoy_log(csv_path, writer, stats):
    """Parse log_filebeat-testbed-log-envoy.csv

    Columns: log_id, timestamp, cmdb_id, log_name, value

    The 'value' field is an envoy access log line. We extract HTTP status codes
    and flag 5xx as ERROR, 4xx as WARN. 2xx/3xx are skipped (not alerts).
    """
    if not os.path.exists(csv_path):
        print(f"  [skip] {csv_path} not found")
        return

    print(f"  Parsing envoy log: {os.path.basename(os.path.dirname(os.path.dirname(csv_path)))} ...")

    count = 0
    with open(csv_path, 'r', encoding='utf-8', errors='ignore') as f:
        reader = csv.DictReader(f)
        for row in reader:
            log_id = row.get('log_id', '')
            ts_raw = row.get('timestamp', '')
            cmdb_id = row.get('cmdb_id', 'unknown')
            value = row.get('value', '')

            if not ts_raw:
                continue

            # Extract HTTP status
            status_match = ENVOY_STATUS_RE.search(value)
            if not status_match:
                continue

            status_code = int(status_match.group(1))

            # Only keep error responses as alerts
            if status_code >= 500:
                severity = 'ERROR'
            elif status_code >= 400:
                severity = 'WARN'
            else:
                continue  # 2xx/3xx are normal, not alerts

            # Build a concise message from the envoy log
            message = f"HTTP {status_code} on {cmdb_id}: {value[:150]}"

            try:
                ts_iso = epoch_to_iso(ts_raw)
            except (ValueError, OSError):
                stats['bad_ts'] += 1
                continue

            writer.writerow([
                ts_iso,
                'aiops',
                cmdb_id,
                severity,
                message,
                log_id,
                value[:200],
            ])
            count += 1
            stats[severity] += 1

    stats['envoy_logs'] += count
    print(f"    → {count:,} envoy alerts (4xx/5xx only)")


# ---------------------------------------------------------------------------
# Trace parser (error spans only)
# ---------------------------------------------------------------------------
def parse_traces(csv_path, writer, stats, duration_threshold_ms=5000):
    """Parse trace_jaeger-span.csv for error spans.

    Columns: timestamp, cmdb_id, span_id, trace_id, duration, type, status_code,
             operation_name, parent_span

    We emit alerts for:
      - status_code != 0 (gRPC/HTTP errors)
      - duration > threshold (slow spans — potential timeouts)
    """
    if not os.path.exists(csv_path):
        print(f"  [skip] {csv_path} not found")
        return

    print(f"  Parsing traces: {os.path.basename(os.path.dirname(os.path.dirname(csv_path)))} ...")

    count = 0
    with open(csv_path, 'r', encoding='utf-8', errors='ignore') as f:
        reader = csv.DictReader(f)
        for row in reader:
            ts_raw = row.get('timestamp', '')
            cmdb_id = row.get('cmdb_id', 'unknown')
            span_id = row.get('span_id', '')
            trace_id = row.get('trace_id', '')
            duration = row.get('duration', '0')
            status_code = row.get('status_code', '0')
            operation = row.get('operation_name', 'unknown')

            if not ts_raw:
                continue

            try:
                sc = int(status_code)
                dur = int(duration)
            except (ValueError, TypeError):
                continue

            # Only keep error spans or very slow spans
            is_error = sc != 0
            is_slow = dur > duration_threshold_ms

            if not is_error and not is_slow:
                continue

            if is_error:
                severity = 'ERROR'
                message = f"Span error (code={sc}) on {operation} [{cmdb_id}] duration={dur}ms trace={trace_id[:16]}"
            else:
                severity = 'WARN'
                message = f"Slow span ({dur}ms) on {operation} [{cmdb_id}] trace={trace_id[:16]}"

            try:
                # Trace timestamps are in milliseconds
                ts_iso = epoch_ms_to_iso(ts_raw)
            except (ValueError, OSError):
                stats['bad_ts'] += 1
                continue

            writer.writerow([
                ts_iso,
                'aiops',
                cmdb_id,
                severity,
                message,
                span_id,
                f"trace={trace_id} span={span_id} op={operation} status={sc} dur={dur}",
            ])
            count += 1
            stats[severity] += 1

    stats['trace_spans'] += count
    print(f"    → {count:,} error/slow spans")


# ---------------------------------------------------------------------------
# Directory walker — find all log/trace CSVs across all cloudbeds and dates
# ---------------------------------------------------------------------------
def discover_data_dirs(ds_root):
    """Return list of directories containing log/metric/trace subdirs."""
    data_dirs = []

    # training_data_with_faults/training_data_with_faults/tar/YYYY-MM-DD-cloudbedN/
    faults_tar = os.path.join(ds_root, 'training_data_with_faults',
                              'training_data_with_faults', 'tar')
    if os.path.isdir(faults_tar):
        for d in sorted(os.listdir(faults_tar)):
            p = os.path.join(faults_tar, d)
            if os.path.isdir(p) and not d.startswith('.'):
                data_dirs.append(('training_faults', d, p))

    # 初赛评分数据/YYYY-MM-DD/cloudbed/
    scoring_root = os.path.join(ds_root, '初赛评分数据')
    if os.path.isdir(scoring_root):
        for d in sorted(os.listdir(scoring_root)):
            cb = os.path.join(scoring_root, d, 'cloudbed')
            if os.path.isdir(cb):
                data_dirs.append(('scoring', d, cb))

    # training_data_normal/cloudbed-N/cloudbed/  (baseline, no faults)
    normal_root = os.path.join(ds_root, 'training_data_normal')
    if os.path.isdir(normal_root):
        for d in sorted(os.listdir(normal_root)):
            cb = os.path.join(normal_root, d, 'cloudbed')
            if os.path.isdir(cb):
                data_dirs.append(('normal', d, cb))

    return data_dirs


# ---------------------------------------------------------------------------
# Ground truth loader
# ---------------------------------------------------------------------------
def load_groundtruth(ds_root):
    """Load and merge all ground truth files (CSV + JSON) into a unified list."""
    records = []

    # CSV ground truths (training_data_with_faults)
    for gt_dir in [
        os.path.join(ds_root, 'training_data_with_faults',
                     'training_data_with_faults_groundtruth'),
        os.path.join(ds_root, 'training_data_with_faults',
                     'training_data_with_faults', 'groundtruth'),
    ]:
        if not os.path.isdir(gt_dir):
            continue
        for csv_file in sorted(glob.glob(os.path.join(gt_dir, '*.csv'))):
            with open(csv_file, 'r', encoding='utf-8') as f:
                reader = csv.DictReader(f)
                for row in reader:
                    records.append({
                        'timestamp': epoch_to_iso(row['timestamp']),
                        'timestamp_epoch': int(row['timestamp']),
                        'level': row['level'],
                        'cmdb_id': row['cmdb_id'],
                        'failure_type': row['failure_type'],
                        'failure_type_en': FAILURE_TYPE_EN.get(row['failure_type'],
                                                               row['failure_type']),
                        'source_file': os.path.basename(csv_file),
                    })

    # JSON ground truths (初赛评分数据)
    gt_json_dir = os.path.join(ds_root, '初赛评分数据', 'groundtruth')
    if os.path.isdir(gt_json_dir):
        for json_file in sorted(glob.glob(os.path.join(gt_json_dir, '*.json'))):
            with open(json_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            n = len(data.get('timestamp', []))
            for i in range(n):
                ft = data['failure_type'][i]
                records.append({
                    'timestamp': epoch_to_iso(data['timestamp'][i]),
                    'timestamp_epoch': int(data['timestamp'][i]),
                    'level': data['level'][i],
                    'cmdb_id': data['cmdb_id'][i],
                    'failure_type': ft,
                    'failure_type_en': FAILURE_TYPE_EN.get(ft, ft),
                    'source_file': os.path.basename(json_file),
                })

    # Deduplicate by (timestamp_epoch, cmdb_id, failure_type)
    seen = set()
    unique = []
    for r in records:
        key = (r['timestamp_epoch'], r['cmdb_id'], r['failure_type'])
        if key not in seen:
            seen.add(key)
            unique.append(r)

    unique.sort(key=lambda r: r['timestamp_epoch'])
    return unique


def save_groundtruth(records, out_path):
    """Write merged ground truth to a CSV."""
    fieldnames = ['timestamp', 'timestamp_epoch', 'level', 'cmdb_id',
                  'failure_type', 'failure_type_en', 'source_file']
    with open(out_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(records)
    print(f"\nGround truth: {len(records)} labeled faults → {out_path}")


# ---------------------------------------------------------------------------
# Severity helpers
# ---------------------------------------------------------------------------
def _normalize_severity(raw):
    """Normalize severity strings to our standard set."""
    raw = raw.upper().strip()
    if raw in ('FATAL', 'CRITICAL', 'CRIT'):
        return 'FATAL'
    if raw in ('ERROR', 'ERR', 'SEVERE'):
        return 'ERROR'
    if raw in ('WARN', 'WARNING'):
        return 'WARN'
    if raw in ('DEBUG', 'TRACE', 'FINE', 'FINER', 'FINEST'):
        return 'DEBUG'
    return 'INFO'


def _infer_severity_from_text(text):
    """Infer severity from free-form log text (for .NET/Java unstructured logs)."""
    t = text.lower()
    if any(kw in t for kw in ('exception', 'error', 'failed', 'failure', 'fatal',
                               'crash', 'refused', 'timeout', 'timed out')):
        return 'ERROR'
    if any(kw in t for kw in ('warn', 'warning', 'unexpected', 'retry', 'retrying')):
        return 'WARN'
    return 'INFO'


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------
def parse_all(ds_root, out_csv, out_gt_csv, skip_envoy=False, skip_traces=False):
    """Parse all AIOps data directories and write the unified alert CSV."""
    data_dirs = discover_data_dirs(ds_root)
    print(f"Discovered {len(data_dirs)} data directories in {ds_root}\n")

    if not data_dirs:
        print("ERROR: No data directories found. Check that 'ds/' folder exists "
              "next to the 'data/' folder.")
        return

    stats = Counter()
    with open(out_csv, 'w', newline='', encoding='utf-8') as fout:
        writer = csv.writer(fout)
        writer.writerow(ALERT_FIELDS)

        for dataset_type, label, dirpath in data_dirs:
            print(f"\n[{dataset_type}] {label}")
            print(f"  path: {dirpath}")

            # Service logs
            svc_log = os.path.join(dirpath, 'log', 'all',
                                   'log_filebeat-testbed-log-service.csv')
            parse_service_log(svc_log, writer, stats)

            # Envoy logs (optional — very large, ~3GB each)
            if not skip_envoy:
                envoy_log = os.path.join(dirpath, 'log', 'all',
                                         'log_filebeat-testbed-log-envoy.csv')
                parse_envoy_log(envoy_log, writer, stats)

            # Traces (optional)
            if not skip_traces:
                trace_csv = os.path.join(dirpath, 'trace', 'all',
                                         'trace_jaeger-span.csv')
                parse_traces(trace_csv, writer, stats)

    # Summary
    total = stats['service_logs'] + stats['envoy_logs'] + stats['trace_spans']
    print("\n" + "=" * 60)
    print("AIOPS PARSING SUMMARY")
    print("=" * 60)
    print(f"Total alerts parsed: {total:,}")
    print(f"  Service logs:      {stats['service_logs']:,}")
    print(f"  Envoy alerts:      {stats['envoy_logs']:,}")
    print(f"  Trace error spans: {stats['trace_spans']:,}")
    print(f"\nBy severity:")
    for sev in ('FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG'):
        if stats[sev]:
            print(f"  {sev}: {stats[sev]:,}")
    if stats['bad_ts']:
        print(f"\nSkipped {stats['bad_ts']} rows with bad timestamps")
    print(f"\nSaved → {out_csv}")
    print("=" * 60)

    # Ground truth
    gt_records = load_groundtruth(ds_root)
    if gt_records:
        save_groundtruth(gt_records, out_gt_csv)

        # Quick stats
        levels = Counter(r['level'] for r in gt_records)
        types = Counter(r['failure_type_en'] for r in gt_records)
        print(f"\nGround truth breakdown:")
        print(f"  By level: {dict(levels)}")
        print(f"  Top failure types:")
        for ft, c in types.most_common(8):
            print(f"    {ft}: {c}")
    else:
        print("\nNo ground truth files found.")

    print(f"\nNext step: run extract_alerts.py on {out_csv} to filter to "
          f"WARN/ERROR/FATAL and deduplicate.")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    import argparse

    p = argparse.ArgumentParser(description='Parse AIOps Challenge dataset')
    p.add_argument('--ds-root', default=DS_ROOT,
                   help='Path to the ds/ folder (default: ../ds relative to this script)')
    p.add_argument('--out', default=None,
                   help='Output CSV path (default: ../aiops_parsed.csv in data/)')
    p.add_argument('--out-gt', default=None,
                   help='Output ground truth CSV (default: ../aiops_groundtruth.csv in data/)')
    p.add_argument('--skip-envoy', action='store_true',
                   help='Skip envoy gateway logs (saves time, they are ~3GB each)')
    p.add_argument('--skip-traces', action='store_true',
                   help='Skip trace span parsing')
    args = p.parse_args()

    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    out_csv = args.out or '../aiops_parsed.csv'
    out_gt = args.out_gt or '../aiops_groundtruth.csv'

    parse_all(args.ds_root, out_csv, out_gt,
              skip_envoy=args.skip_envoy, skip_traces=args.skip_traces)

    print("\nDone! AIOps data is ready for the pipeline.")
    print("Pipeline: parse_aiops.py → extract_alerts.py → clean_text.py → "
          "embed_alerts.py → cluster_alerts.py")
