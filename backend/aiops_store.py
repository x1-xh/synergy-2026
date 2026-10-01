"""
aiops_store.py — serves the pre-computed AIOps pipeline results to the API.

data/AIOps/run_aiops_pipeline.py writes data/AIOps/aiops_incidents.json: a
~276MB JSON array with every member alert embedded. Too large to serve
wholesale or parse per request, so on first access we derive three compact
artifacts once and cache them on disk under data/AIOps/aiops_api/:

  incidents_light.json   — every incident WITHOUT member_alerts (list view)
  details/inc_NNN.json   — one file per incident, member_alerts capped
  stream.json            — stratified, time-ordered sample of the raw alerts
                           for the dashboard's live-replay feed

Serialization rules shared with the upload path (orchestrator output):
  - every alert gets a stable `id` — the frontend uses it for React keys and
    to locate the root cause inside the member list (IncidentModal)
  - empty `explanation` gets a deterministic fallback (the LLM pass that
    would fill it hasn't been run on this data)
  - `member_count` preserves the true cluster size when member_alerts is
    truncated for transport
"""

import json
import os
import re
from datetime import datetime

DATA_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', 'data', 'AIOps'))
INCIDENTS_JSON = os.path.join(DATA_DIR, 'aiops_incidents.json')
EVALUATION_JSON = os.path.join(DATA_DIR, 'aiops_evaluation.json')
API_DIR = os.path.join(DATA_DIR, 'aiops_api')
LIGHT_JSON = os.path.join(API_DIR, 'incidents_light.json')
STREAM_JSON = os.path.join(API_DIR, 'stream.json')
DETAIL_DIR = os.path.join(API_DIR, 'details')

MAX_DETAIL_MEMBERS = 500      # cap member_alerts in the detail payload
STREAM_TARGET = 40_000        # stratified sample size for the replay feed

# Module-level cache populated by ensure_built()
_state = {
    'available': False,
    'light': [],               # list of light incident dicts, start-time ordered
    'stream': [],              # sampled raw alerts, time ordered
    'metrics': {},             # merged pipeline + evaluation metrics
}


# ---------------------------------------------------------------------------
# Serialization helpers (shared with the upload path)
# ---------------------------------------------------------------------------
def _alert_key(alert):
    return (alert.get('timestamp'), alert.get('service'), alert.get('message'))


def fallback_explanation(incident):
    """Deterministic 2-3 sentence explanation for incidents the LLM pass
    never annotated. Built from the root alert, cluster size, and span."""
    root = incident.get('root_cause_alert') or {}
    service = root.get('service', 'unknown')
    severity = root.get('severity', 'ERROR')
    message = (root.get('message') or '').strip()
    n = incident.get('member_count') or len(incident.get('member_alerts') or [])

    try:
        start = datetime.fromisoformat(incident['time_span']['start'])
        end = datetime.fromisoformat(incident['time_span']['end'])
        dur_sec = max(1, int((end - start).total_seconds()))
        dur = f"{dur_sec // 60}m {dur_sec % 60}s" if dur_sec >= 60 else f"{dur_sec}s"
    except (KeyError, ValueError):
        dur = "a short window"

    services = sorted({
        (a.get('service') or 'unknown') for a in (incident.get('member_alerts') or [])
    } - {service})
    spread = (f" Alerts also correlated from: {', '.join(services[:4])}."
              if services else "")

    return (f"Correlation collapsed {n:,} alerts on {service} into a single "
            f"incident spanning {dur}. Root candidate: {severity} — {message[:140]}.{spread}")


def make_tags(incident):
    """Short uppercase chips for the dashboard focus panel."""
    root = incident.get('root_cause_alert') or {}
    service = re.sub(r'-\d+$', '', root.get('service') or 'unknown').upper()
    severity = (root.get('severity') or 'ERROR').upper()
    priority = 'P1' if severity in ('FATAL', 'ERROR') else 'P2'
    return [service, severity, 'AIOPS', priority]


def serialize_incident(incident, cap_members=MAX_DETAIL_MEMBERS):
    """Return a transport-ready copy of one incident: stable alert ids,
    fallback explanation, member cap with member_count preserved."""
    inc = dict(incident)
    members = sorted(inc.get('member_alerts') or [],
                     key=lambda a: a.get('timestamp') or '')
    inc['member_count'] = len(members)

    kept = members[:cap_members]
    for i, alert in enumerate(kept):
        alert['id'] = f"{inc.get('incident_id', 'inc')}_a{i}"

    # Root cause id must match its member entry so the UI can highlight it
    root = dict(inc.get('root_cause_alert') or {})
    root_id = None
    root_key = _alert_key(root)
    for alert in kept:
        if _alert_key(alert) == root_key:
            root_id = alert['id']
            break
    root['id'] = root_id or f"{inc.get('incident_id', 'inc')}_root"
    inc['root_cause_alert'] = root

    inc['member_alerts'] = kept
    if not (inc.get('explanation') or '').strip():
        inc['explanation'] = fallback_explanation({**inc, 'member_alerts': members})
    inc['tags'] = make_tags(incident)
    return inc


def light_incident(incident):
    """List-view shape: everything except the (large) member_alerts array."""
    out = {k: v for k, v in incident.items() if k != 'member_alerts'}
    out['member_count'] = incident.get('member_count',
                                       len(incident.get('member_alerts') or []))
    return out


# ---------------------------------------------------------------------------
# One-time artifact build
# ---------------------------------------------------------------------------
def ensure_built(force=False):
    """Load the derived artifacts, building them from aiops_incidents.json
    on first run. Safe to call at server startup; ~30-60s the first time
    (one json.load of the 276MB source), instant afterwards."""
    if _state['available'] and not force:
        return True

    if not os.path.exists(INCIDENTS_JSON):
        print(f"[aiops_store] {INCIDENTS_JSON} not found — "
              f"run data/AIOps/run_aiops_pipeline.py first. AIOps endpoints will 503.")
        return False

    built = os.path.exists(LIGHT_JSON) and os.path.isdir(DETAIL_DIR) \
        and os.path.exists(STREAM_JSON)
    if force or not built:
        _build_artifacts()

    with open(LIGHT_JSON, encoding='utf-8') as f:
        _state['light'] = json.load(f)
    with open(STREAM_JSON, encoding='utf-8') as f:
        _state['stream'] = json.load(f)
    _state['metrics'] = _load_metrics()
    _state['available'] = True
    print(f"[aiops_store] ready: {len(_state['light'])} incidents, "
          f"{len(_state['stream'])} stream alerts")
    return True


def _build_artifacts():
    print(f"[aiops_store] building derived artifacts from {INCIDENTS_JSON} "
          f"(one-time, large file)...")
    with open(INCIDENTS_JSON, encoding='utf-8') as f:
        incidents = json.load(f)

    os.makedirs(DETAIL_DIR, exist_ok=True)

    light = []
    all_members = []
    for inc in incidents:
        full = serialize_incident(inc)
        iid = full['incident_id']
        with open(os.path.join(DETAIL_DIR, f"{iid}.json"), 'w', encoding='utf-8') as f:
            json.dump(full, f)
        light.append(light_incident(full))
        # Stream source: the UNCAPPED member list (serialize caps at 500)
        all_members.extend(inc.get('member_alerts') or [])

    light.sort(key=lambda i: i['time_span']['start'])
    with open(LIGHT_JSON, 'w', encoding='utf-8') as f:
        json.dump(light, f)

    # Stratified, time-ordered sample of the raw alert stream for replay
    all_members.sort(key=lambda a: a.get('timestamp') or '')
    step = max(1, len(all_members) // STREAM_TARGET)
    stream = [{
        'id': f"s{i}",
        'timestamp': a.get('timestamp'),
        'severity': a.get('severity'),
        'service': a.get('service'),
        'message': (a.get('message') or '')[:200],
    } for i, a in enumerate(all_members[::step])]
    with open(STREAM_JSON, 'w', encoding='utf-8') as f:
        json.dump(stream, f)

    print(f"[aiops_store] built {len(light)} light incidents, "
          f"{len(light)} detail files, {len(stream)} stream alerts "
          f"(from {len(all_members):,} clustered alerts)")


def _load_metrics():
    metrics = {}
    if os.path.exists(EVALUATION_JSON):
        with open(EVALUATION_JSON, encoding='utf-8') as f:
            metrics['evaluation'] = json.load(f).get('metrics', {})
    total_alerts = sum(i.get('member_count', 0) for i in _state.get('light', []))
    total_incidents = len(_state.get('light', []))
    suppressed = sum(i.get('suppressed_count', 0) for i in _state.get('light', []))
    metrics['pipeline'] = {
        'total_alerts': total_alerts,
        'total_incidents': total_incidents,
        'suppressed': suppressed,
        'noise_reduction': round(100 * suppressed / total_alerts, 1) if total_alerts else 0,
    }
    return metrics


# ---------------------------------------------------------------------------
# Accessors used by the API routes
# ---------------------------------------------------------------------------
def get_incidents():
    return _state['light']


def get_incident(incident_id):
    path = os.path.join(DETAIL_DIR, f"{os.path.basename(incident_id)}.json")
    if not os.path.exists(path):
        return None
    with open(path, encoding='utf-8') as f:
        inc = json.load(f)
        
    current_exp = inc.get('explanation', '')
    if not current_exp or 'autonomously' in current_exp:
        import sys
        sys.path.append(os.path.join(os.path.dirname(__file__), '../data'))
        try:
            from llm_explainer import generate_incident_explanation
            new_exp = generate_incident_explanation(inc)
            if new_exp and 'autonomously' not in new_exp:
                inc['explanation'] = new_exp
                with open(path, 'w', encoding='utf-8') as fw:
                    json.dump(inc, fw, indent=2)
        except ImportError:
            pass

    return inc


def get_stream_batch(cursor=0, limit=50):
    stream = _state['stream']
    cursor = max(0, int(cursor))
    batch = stream[cursor:cursor + limit]
    next_cursor = cursor + len(batch)
    return {
        'alerts': batch,
        'next_cursor': next_cursor if next_cursor < len(stream) else 0,  # loop
        'total': len(stream),
    }


def get_metrics():
    return _state['metrics']
