"""
parse_logs.py — Loghub Full Dataset Parser
Extracts alerts from the full HDFS and Spark datasets (LogHub 2.0 format).

Outputs a unified CSV with columns:
  timestamp, source, service, severity, message, event_id, raw_line

Key decisions:
  - HDFS logs don't have explicit severity. We infer it from message content.
  - Spark logs have explicit severity in the raw log (INFO/WARN/ERROR/FATAL).
  - We keep ALL severity levels in the parsed output (the filtering to WARN/ERROR/FATAL
    happens in extract_alerts.py so the pipeline can be tuned later).
  - "source" column tracks which dataset this line came from (hdfs / spark).
"""

import re
import csv
import os
from datetime import datetime

# ---------------------------------------------------------------------------
# HDFS raw log format:
#   081109 203518 143 INFO dfs.DataNode$DataXceiver: <message>
# ---------------------------------------------------------------------------
HDFS_PATTERN = re.compile(
    r'(?P<date>\d{6})\s+'
    r'(?P<time>\d{6})\s+'
    r'(?P<pid>\d+)\s+'
    r'(?P<severity>[A-Z]+)\s+'
    r'(?P<service>\S+?):\s+'
    r'(?P<msg>.*)'
)

# Keywords that indicate an error-level event in HDFS messages
# (since HDFS marks everything as INFO)
HDFS_ERROR_KEYWORDS = [
    'Exception', 'exception', 'Error', 'error', 'Failed', 'failed',
    'timeout', 'Timeout', 'refused', 'Broken pipe', 'Connection reset',
    'No route to host', 'does not belong', 'not found', 'invalid',
    'timed out'
]
HDFS_WARN_KEYWORDS = [
    'Unexpected', 'Reopen', 'already existing', 'Removing block',
    'Changing block file offset'
]

def infer_hdfs_severity(raw_severity, message):
    """HDFS marks everything as INFO. Infer real severity from message content."""
    if raw_severity in ('ERROR', 'FATAL'):
        return raw_severity
    if raw_severity == 'WARN':
        return 'WARN'
    # Check message content
    if any(kw in message for kw in HDFS_ERROR_KEYWORDS):
        return 'ERROR'
    if any(kw in message for kw in HDFS_WARN_KEYWORDS):
        return 'WARN'
    return 'INFO'

# ---------------------------------------------------------------------------
# Spark raw log format:
#   17/03/14 21:40:22 INFO executor.CoarseGrainedExecutorBackend: <message>
# ---------------------------------------------------------------------------
SPARK_PATTERN = re.compile(
    r'(?P<date>\d{2}/\d{2}/\d{2})\s+'
    r'(?P<time>\d{2}:\d{2}:\d{2})\s+'
    r'(?P<severity>[A-Z]+)\s+'
    r'(?P<service>\S+?):\s+'
    r'(?P<msg>.*)'
)

def parse_hdfs(raw_log_path, out_path, max_lines=None):
    """Parse the full HDFS raw log file, streaming line-by-line."""
    print(f"Parsing HDFS: {raw_log_path}")
    count = 0
    parsed = 0

    with open(raw_log_path, 'r', encoding='utf-8', errors='ignore') as fin, \
         open(out_path, 'w', newline='', encoding='utf-8') as fout:

        writer = csv.writer(fout)
        writer.writerow(['timestamp', 'source', 'service', 'severity', 'message', 'event_id', 'raw_line'])

        for line in fin:
            count += 1
            if max_lines and count > max_lines:
                break

            line = line.rstrip('\n\r')
            m = HDFS_PATTERN.search(line)
            if not m:
                continue

            # Parse timestamp: YYMMDD HHMMSS
            try:
                ts = datetime.strptime(f"{m.group('date')} {m.group('time')}", "%y%m%d %H%M%S")
            except ValueError:
                continue

            severity = infer_hdfs_severity(m.group('severity'), m.group('msg'))
            writer.writerow([
                ts.isoformat(),
                'hdfs',
                m.group('service'),
                severity,
                m.group('msg'),
                '',  # event_id filled later if needed
                line
            ])
            parsed += 1

    print(f"  Scanned {count:,} lines, parsed {parsed:,} into {out_path}")
    return parsed

def parse_spark(raw_log_path, out_path, max_lines=None):
    """Parse the full Spark raw log file, streaming line-by-line."""
    print(f"Parsing Spark: {raw_log_path}")
    count = 0
    parsed = 0

    with open(raw_log_path, 'r', encoding='utf-8', errors='ignore') as fin, \
         open(out_path, 'w', newline='', encoding='utf-8') as fout:

        writer = csv.writer(fout)
        writer.writerow(['timestamp', 'source', 'service', 'severity', 'message', 'event_id', 'raw_line'])

        for line in fin:
            count += 1
            if max_lines and count > max_lines:
                break

            line = line.rstrip('\n\r')
            m = SPARK_PATTERN.search(line)
            if not m:
                continue

            # Parse timestamp: YY/MM/DD HH:MM:SS
            try:
                ts = datetime.strptime(f"{m.group('date')} {m.group('time')}", "%y/%m/%d %H:%M:%S")
            except ValueError:
                continue

            writer.writerow([
                ts.isoformat(),
                'spark',
                m.group('service'),
                m.group('severity'),  # Spark has real severity
                m.group('msg'),
                '',
                line
            ])
            parsed += 1

    print(f"  Scanned {count:,} lines, parsed {parsed:,} into {out_path}")
    return parsed

if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    # Parse full datasets (streams line-by-line, constant memory)
    parse_hdfs('HDFS/HDFS_full.log', 'hdfs_parsed.csv')
    parse_spark('Spark/Spark_full.log', 'spark_parsed.csv')

    print("\nFull parsing complete.")
    print("Next step: run extract_alerts.py to filter to WARN/ERROR/FATAL and deduplicate.")
