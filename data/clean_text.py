"""
clean_text.py — Alert text cleaning for the embedding pipeline.

Strips noise from alert messages so the embedding model focuses on
the *type* of error, not the random identifiers.

Replacements:
  - Block IDs (blk_-1234567890)         → <BLOCK>
  - IP addresses (10.251.73.220:50010)  → <IP>
  - File paths (/mnt/hadoop/...)        → <PATH>
  - Hex/long numeric IDs                → <ID>
  - Standalone numbers                  → <NUM>

Also produces a "demo subset" of alerts for the clustering pipeline:
  - Picks a dense time window from HDFS (where error bursts happen)
  - Includes all Spark alerts (they're already small: ~10K)
  - Target: 5,000–15,000 alerts for a realistic demo

Output files:
  - combined_alerts_cleaned.csv  (full dataset, cleaned text)
  - demo_alerts.csv              (curated subset for clustering/demo)
"""

import csv
import re
import os
from collections import Counter, defaultdict
from datetime import datetime, timedelta

# ---------------------------------------------------------------------------
# Text cleaning patterns
# ---------------------------------------------------------------------------

# Block IDs: blk_-1608999687919862906 or blk_7128370237687728475
BLOCK_RE = re.compile(r'blk_-?\d+')

# IP:port: 10.250.19.102:54106 or just 10.250.19.102
IP_RE = re.compile(r'\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?')

# File paths: /mnt/hadoop/mapred/system/job_200811092030_0001/job.jar
PATH_RE = re.compile(r'/[\w./\-]+')

# Java channel references: java.nio.channels.SocketChannel[connected local=/... remote=/...]
CHANNEL_RE = re.compile(r'java\.nio\.channels\.\w+\[[\w\s=/:.]+\]')

# Java object hashes: @5ad3ac2, @1ab71c1e, [Lscala.Tuple2;@hex
JAVA_HASH_RE = re.compile(r'@[0-9a-fA-F]+')

# Long numeric IDs (8+ digits, possibly negative)
LONG_NUM_RE = re.compile(r'(?<![a-zA-Z])-?\d{8,}(?![a-zA-Z])')

# Standalone numbers (but not inside words)
NUM_RE = re.compile(r'(?<![a-zA-Z_])\d+(?![a-zA-Z_])')

def clean_message(msg):
    """Strip noisy identifiers from an alert message."""
    msg = BLOCK_RE.sub('<BLOCK>', msg)
    msg = IP_RE.sub('<IP>', msg)
    msg = CHANNEL_RE.sub('<CHANNEL>', msg)
    msg = JAVA_HASH_RE.sub('<HASH>', msg)
    msg = PATH_RE.sub('<PATH>', msg)
    msg = LONG_NUM_RE.sub('<ID>', msg)
    msg = NUM_RE.sub('<NUM>', msg)

    # Collapse repeated whitespace
    msg = re.sub(r'\s+', ' ', msg).strip()
    return msg


def clean_full_dataset(in_path, out_path):
    """Add a 'cleaned_message' column to the full alert CSV."""
    print(f"Cleaning text in {in_path}...")
    count = 0

    with open(in_path, 'r', encoding='utf-8') as fin, \
         open(out_path, 'w', newline='', encoding='utf-8') as fout:

        reader = csv.DictReader(fin)
        fieldnames = reader.fieldnames + ['cleaned_message']
        writer = csv.DictWriter(fout, fieldnames=fieldnames)
        writer.writeheader()

        for row in reader:
            row['cleaned_message'] = clean_message(row['message'])
            writer.writerow(row)
            count += 1

    print(f"  Cleaned {count:,} alerts -> {out_path}")
    return count


def find_densest_window(csv_path, window_minutes=30, source_filter='hdfs'):
    """
    Scan the CSV and find the time window with the highest alert density.
    Returns (window_start, window_end, alert_count).
    """
    print(f"\nFinding densest {window_minutes}-minute window in {source_filter} data...")

    # Count alerts per minute bucket
    minute_counts = defaultdict(int)
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row['source'] != source_filter:
                continue
            try:
                ts = datetime.fromisoformat(row['timestamp'])
                # Round down to the minute
                bucket = ts.replace(second=0, microsecond=0)
                minute_counts[bucket] += 1
            except (ValueError, KeyError):
                pass

    if not minute_counts:
        print(f"  No {source_filter} alerts found!")
        return None, None, 0

    # Sliding window to find densest period
    sorted_minutes = sorted(minute_counts.keys())
    best_start = sorted_minutes[0]
    best_count = 0
    window_delta = timedelta(minutes=window_minutes)

    for start in sorted_minutes:
        end = start + window_delta
        total = sum(c for t, c in minute_counts.items() if start <= t < end)
        if total > best_count:
            best_count = total
            best_start = start

    best_end = best_start + window_delta
    print(f"  Densest window: {best_start} to {best_end} ({best_count} alerts)")
    return best_start, best_end, best_count


def extract_demo_subset(cleaned_csv, out_path, hdfs_start, hdfs_end, target_max=15000):
    """
    Extract a demo-ready subset using stratified sampling:
    - ALL Spark alerts (they're already small)
    - HDFS alerts from the densest time window, sampled proportionally by error type
    This ensures every error type is represented in the demo.
    """
    print(f"\nExtracting demo subset (stratified)...")
    spark_alerts = []
    hdfs_alerts_by_type = defaultdict(list)

    with open(cleaned_csv, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames

        for row in reader:
            if row['source'] == 'spark':
                spark_alerts.append(row)
            elif row['source'] == 'hdfs' and hdfs_start and hdfs_end:
                try:
                    ts = datetime.fromisoformat(row['timestamp'])
                    if hdfs_start <= ts < hdfs_end:
                        hdfs_alerts_by_type[row['cleaned_message']].append(row)
                except (ValueError, KeyError):
                    pass

    # Budget for HDFS = target_max - spark count
    hdfs_budget = target_max - len(spark_alerts)
    if hdfs_budget < 0:
        hdfs_budget = 0

    # Stratified sample: proportional by type, minimum 1 per type
    total_hdfs = sum(len(v) for v in hdfs_alerts_by_type.values())
    sampled_hdfs = []
    for msg_type, alerts in hdfs_alerts_by_type.items():
        # At least 1, at most proportional share
        proportion = len(alerts) / total_hdfs if total_hdfs > 0 else 0
        n = max(1, int(proportion * hdfs_budget))
        n = min(n, len(alerts))
        sampled_hdfs.extend(alerts[:n])

    demo_alerts = spark_alerts + sampled_hdfs
    demo_alerts.sort(key=lambda a: a['timestamp'])

    with open(out_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(demo_alerts)

    # Stats
    sources = Counter(a['source'] for a in demo_alerts)
    sevs = Counter(a['severity'] for a in demo_alerts)
    unique_types = len(set(a['cleaned_message'] for a in demo_alerts))
    print(f"  Demo subset: {len(demo_alerts)} alerts")
    print(f"    By source: {dict(sources)}")
    print(f"    By severity: {dict(sevs)}")
    print(f"    Unique message types: {unique_types}")
    print(f"  Saved to {out_path}")

    return len(demo_alerts)


if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    # Step 1: Clean all alert text
    clean_full_dataset('combined_alerts.csv', 'combined_alerts_cleaned.csv')

    # Step 2: Find densest HDFS time window for demo
    hdfs_start, hdfs_end, hdfs_count = find_densest_window(
        'combined_alerts_cleaned.csv',
        window_minutes=60,  # 1-hour window
        source_filter='hdfs'
    )

    # Step 3: Extract demo subset
    extract_demo_subset(
        'combined_alerts_cleaned.csv',
        'demo_alerts.csv',
        hdfs_start, hdfs_end,
        target_max=15000
    )

    print("\nText cleaning complete!")
    print("Files ready:")
    print("  combined_alerts_cleaned.csv  — full dataset with cleaned text")
    print("  demo_alerts.csv              — curated subset for clustering pipeline")
