"""
extract_alerts.py — Filter, Deduplicate, and Combine alerts from parsed logs.

Takes the full parsed CSVs (hdfs_parsed.csv, spark_parsed.csv) and:
  1. Filters to only WARN / ERROR / FATAL severity lines (these are our "alerts")
  2. Removes exact duplicate alerts (same timestamp + same message)
  3. Handles missing fields (fills blanks with "unknown")
  4. Combines both datasets into one unified alerts table
  5. Prints sanity-check stats

Output: combined_alerts.csv — the single clean table for the rest of the pipeline.
"""

import csv
import os
from collections import Counter, defaultdict
from datetime import datetime

def load_and_filter(csv_path, severities=('WARN', 'ERROR', 'FATAL')):
    """Load a parsed CSV and keep only rows matching the given severities."""
    alerts = []
    if not os.path.exists(csv_path):
        print(f"  File not found: {csv_path}")
        return alerts

    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row['severity'] in severities:
                # Handle missing fields
                for key in row:
                    if not row[key] or row[key].strip() == '':
                        row[key] = 'unknown'
                alerts.append(row)

    print(f"  {csv_path}: {len(alerts)} alerts after severity filter")
    return alerts

def deduplicate(alerts):
    """Remove exact duplicates (same timestamp + same message)."""
    seen = set()
    unique = []
    for alert in alerts:
        key = (alert['timestamp'], alert['message'])
        if key not in seen:
            seen.add(key)
            unique.append(alert)
    removed = len(alerts) - len(unique)
    print(f"  Deduplication: removed {removed} exact duplicates, {len(unique)} remain")
    return unique

def sanity_check(alerts):
    """Print stats about the combined alert table."""
    print("\n" + "=" * 60)
    print("SANITY CHECK")
    print("=" * 60)

    # Total count
    print(f"\nTotal alerts: {len(alerts)}")

    # By source
    source_counts = Counter(a['source'] for a in alerts)
    print(f"\nBy dataset:")
    for source, count in source_counts.most_common():
        print(f"  {source}: {count}")

    # By severity
    sev_counts = Counter(a['severity'] for a in alerts)
    print(f"\nBy severity:")
    for sev, count in sev_counts.most_common():
        print(f"  {sev}: {count}")

    # By service (top 10)
    svc_counts = Counter(a['service'] for a in alerts)
    print(f"\nTop 10 services:")
    for svc, count in svc_counts.most_common(10):
        print(f"  {svc}: {count}")

    # Time range
    timestamps = []
    for a in alerts:
        try:
            ts = datetime.fromisoformat(a['timestamp'])
            timestamps.append(ts)
        except (ValueError, KeyError):
            pass

    if timestamps:
        timestamps.sort()
        print(f"\nTime range:")
        print(f"  Earliest: {timestamps[0]}")
        print(f"  Latest:   {timestamps[-1]}")
        span = timestamps[-1] - timestamps[0]
        print(f"  Span:     {span}")

    print("=" * 60)

def save_combined(alerts, out_path):
    """Write the combined, deduped alerts to a single CSV."""
    if not alerts:
        print("No alerts to save!")
        return

    fieldnames = ['timestamp', 'source', 'service', 'severity', 'message', 'event_id', 'raw_line']
    with open(out_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        # Sort by timestamp for the pipeline
        alerts.sort(key=lambda a: a['timestamp'])
        writer.writerows(alerts)

    print(f"\nSaved {len(alerts)} alerts to {out_path}")

if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    print("Step 1: Loading and filtering parsed logs...")
    hdfs_alerts = load_and_filter('hdfs_parsed.csv')
    spark_alerts = load_and_filter('spark_parsed.csv')

    print(f"\nStep 2: Combining datasets...")
    all_alerts = hdfs_alerts + spark_alerts
    print(f"  Combined total: {len(all_alerts)}")

    print(f"\nStep 3: Deduplicating...")
    all_alerts = deduplicate(all_alerts)

    print(f"\nStep 4: Saving combined table...")
    save_combined(all_alerts, 'combined_alerts.csv')

    print(f"\nStep 5: Sanity check...")
    sanity_check(all_alerts)

    print("\nDone! combined_alerts.csv is ready for the next stage (text cleaning + embeddings).")
