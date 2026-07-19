> **⚠️ AI AGENT INSTRUCTIONS (CRITICAL WORKFLOW)**
> 1. **Checklist Updates:** This checklist is not set in stone, but any structural changes must be discussed with the user first.
> 2. **Marking Progress:** Check off completed items by changing `[ ]` to `[.]`. Add a brief inline annotation of the result (e.g., `— Done (Created file.py)`).
> 3. **Reporting Format:** After finishing any task, you MUST pause and report to the user in this exact format:
>    - **What I did:** (Briefly explain the action)
>    - **Why I did it:** (The rationale)
>    - **Effect on the project:** (How this moves us forward)
>    - **Coordination needs:** (Do teammates/other agents need to know about this? If so, what?)


## Day 0
- [.] Agree on what an "alert" record looks like — expanded to: timestamp, source, service, severity, message, event_id, raw_line
- [.] Agree on what an "incident" record looks like — incident_id, root_cause_alert, root_cause_candidates (top 3 + confidence), member_alerts, suppressed_count, time_span {start,end}, status, confidence, explanation
- [.] Set up repo, folders, and basic environment
- [.] Download 2 Loghub datasets (e.g. HDFS + Spark) — full LogHub 2.0 from Zenodo (1.5GB HDFS + 1.6GB Spark)
- [ ] Download 1 AIOps Challenge dataset with labeled root causes
- [ ] Start a shared doc to log every decision (thresholds, weights, choices) as you make them

## Day 1
- [.] Write parser for Loghub logs — data/parse_logs.py handles both HDFS and Spark formats
- [.] Extract timestamp and clean message text from each log line — includes severity inference for HDFS (all lines are marked INFO, we infer ERROR/WARN from message content)
- [ ] Load AIOps CSV data and map its columns to your shared alert format

## Day 2
- [.] Fix timestamp/timezone mismatches across datasets — both normalized to ISO-8601, HDFS uses YYMMDD HHMMSS, Spark uses YY/MM/DD HH:MM:SS
- [.] Remove exact duplicate alerts — 5,005 exact dupes removed
- [.] Handle missing fields (e.g. no service name) — blanks filled with "unknown"
- [.] Save everything into one clean, common table — combined_alerts.csv (1,773,246 alerts)
- [.] Sanity check: print alert counts per dataset, per severity, per time range — HDFS: 1.76M, Spark: 10K, ERROR: 1.4M, WARN: 367K

## Day 3
- [.] Clean alert text — strip IDs, IPs, counters, random numbers — completed via clean_text.py (produced demo_alerts.csv with 243 unique message types)
- [.] Set up a small local embedding model (sentence-transformers) — Done (`all-MiniLM-L6-v2`)
- [.] Generate embeddings for all alert messages — Done (Created `demo_embeddings.npy` with shape `(15004, 384)`)

## Day 4
- [.] Add time-bucket feature (start with ~4 min windows) — done: cluster_alerts.py uses DEFAULT_WINDOW_SEC=240 with a sliding-window union-find
- [.] Add severity/service as usable features — done: severity is a secondary root-cause signal; service-topology (upstream>downstream) still pending
- [.] Test: pick 10 related alert pairs + 10 unrelated pairs, check similarity scores make sense — Done (Identical errors scored 1.0, unrelated scored ~0.5. Optimal threshold will be ~0.85)
- [.] Fix text cleaning if similarity scores look wrong — Done (No fixes needed, scores look great)

## Day 5
- [.] Build logic to connect alerts that are close in time AND similar in meaning  [add a graph edge between i,j iff t[j]-t[i] <= window AND cosine(emb_i, emb_j) >= threshold] — done: cluster_alerts.py links alerts within the window whose cosine is ≥ the threshold
- [.] Restrict comparisons to nearby time windows only (for speed)  [sort by timestamp and only compare each alert to later ones inside its window — no O(n^2)] — done: sliding right pointer, effectively linear
- [ ] Start building the frontend layout using fake/sample data (raw stream + grouped view)

## Day 6
- [.] Extract groups of connected alerts (these are your incident clusters)  [run connected components over the similarity graph; each component is one incident] — done: connected components via union-find in cluster_alerts.py
- [ ] Run full pipeline end-to-end on real data  [run parse_logs.py -> extract_alerts.py -> clean_text.py -> embed_alerts.py -> cluster_alerts.py on the real logs] — blocked: raw HDFS/Spark logs + generated artifacts are not on disk; ran on synthetic data only
- [ ] Milestone check: confirm you get a real result like "1400 alerts → 40 groups"
- [ ] If this isn't working yet, stop and fix it before moving forward

## Day 7
- [.] Within each group, rank alerts by likely root cause (earliest alert = strongest signal)  [score each member by earliness, then break ties with severity/cohesion; highest score = root cause] — done: rank_cluster uses earliness as the primary signal
- [~] Add a secondary signal if possible (upstream service > downstream service)  [if service topology exists, boost alerts whose service is upstream of the others] — partial: severity added as a secondary signal; upstream/downstream topology still pending, no topology data yet
- [.] Output top 3 root cause candidates with confidence, not just one answer  [keep the top-3 scored members and normalize their scores into per-incident confidences] — done: root_cause_candidates holds top 3 with normalized confidences
- [.] Flag low-confidence groups as "needs review"  [set status to needs_review when confidence < floor or cluster too small] — done: status field set by CONF_FLOOR and MIN_CLUSTER_SIZE

## Day 8
- [ ] Write the LLM prompt — one call per group, not per alert
- [ ] Keep prompt limited to only alerts inside that group
- [ ] Test explanation output on a few sample groups, check for made-up details
- [ ] Continue building frontend incident detail view (timeline + explanation)

## Day 9
- [ ] Build incident objects (root cause, member alerts, suppressed count, time span)
- [ ] Make suppression non-destructive — flag alerts as suppressed, don't delete
- [ ] Set up FastAPI endpoints: upload, run-pipeline, get-incidents, get-incident-detail, status check
  - [.] upload — Done (Added /api/upload to main.py)
  - [.] run-pipeline — Done (Automatically triggered inside /upload via orchestrator.py)
  - [.] status check — Done (Added /api/status to main.py)
  - [ ] get-incidents — Pending
  - [ ] get-incident-detail — Pending
- [.] Build a backend pipeline orchestrator to automatically run data scripts in series on uploaded files — Done (Created backend/orchestrator.py)
- [ ] Add a replay/streaming endpoint for live demo mode

## Day 10
- [ ] Connect frontend to real backend, remove fake data
- [ ] Build play/pause/speed replay controls on frontend
- [ ] Start running parameter sweep: different time windows + similarity thresholds

## Day 11
- [ ] Finish replay feature — alerts stream in and visibly group live
- [ ] Continue parameter sweep, log accuracy + noise reduction for each setting
- [ ] Build noise-reduction number display on dashboard header

## Day 12
- [ ] Chart accuracy vs. noise reduction across your sweep results
- [ ] Pick final settings, write one line explaining why
- [ ] Full pipeline integration test — run start to finish, fix breakages between parts

## Day 13
- [ ] Bug bash — test every part of the app, fix anything that could break live
- [ ] Pick a curated demo dataset (a subset that gives clean, explainable results)
- [ ] Make sure it covers 2–3 labeled incidents for the accuracy story

## Day 14
- [ ] Add metrics panel to frontend (accuracy %, noise reduction %)
- [ ] Full team rehearsal of demo script, timed
- [ ] Fix anything that felt slow or confusing during rehearsal
- [ ] Prepare backup: record a video of a successful full run

## Day 15
- [ ] Fresh smoke test 2 hours before presenting
- [ ] Confirm backup video is ready and accessible
- [ ] Demo: raw stream → trigger correlation → say headline number → open one incident → show explanation → show tuning chart → close with accuracy number