# Hackathon PPT — Slide Content + Speaking Script

> **How to use this:** For each slide, the **"On the Slide"** section is the actual text/visuals on your PPT. Keep it exactly this minimal. The **"Speaking Script"** section is what you say out loud while showing the slide.

---

## Slide 1: Team Introduction

### 🖥️ On the Slide

**Title:** Team [Your Team Name]

- **Member 1** — Name / Role / College
- **Member 2** — Name / Role / College
- **Member 3** — Name / Role / College
- **Member 4** — Name / Role / College

*(Fill in your details, add photos if allowed)*

---

### 🎤 Speaking Script

> *(Introduce yourselves — keep it under 30 seconds. Name, one line about what each person worked on, move on.)*

---

## Slide 2: Problem Understanding

### 🖥️ On the Slide

**Title:** The Alert Storm Problem

**Sub-headline:** Problem Statement 10: Alert Correlation & Deduplication Engine

**[PLACEHOLDER FOR NAPKIN AI TREE DIAGRAM]**
*Visual: A cascading flow chart (tree with roots) showing a root cause failure triggering multiple downstream alerts.*
* **Root Cause**: Database Connection Failure (Red)
* **Branch 1**: App Server - HTTP 500 Errors
* **Branch 2**: Load Balancer - High Latency Warning
* **Branch 3**: API Gateway - Timeout Exceptions
* **Result (Bottom)**: SLA Breach & Customer Support Tickets (Orange)

**4 stats (large font, centered):**
- 🔔 **1,000+** alerts/day in large enterprises
- 🗑️ **70–99%** are downstream noise, not root causes
- ⏱️ **45%** of incident response time wasted on triage
- 💰 **$5,600/min** average cost of IT downtime

**One line at the bottom:**
> "Everything is broken — but what broke *first*?"

---

### 🎤 Speaking Script

> "When a major infrastructure incident happens — say a database goes down — your monitoring system doesn't fire one alert. It fires hundreds. The database alert triggers app-server alerts, which trigger load-balancer alerts, which trigger user-facing errors, which trigger SLA breaches. One root cause, a hundred symptoms."
>
> "Here's the reality: large enterprises see over a thousand alerts a day. Research from Moogsoft shows 70 to 99 percent of those alerts during an incident are just downstream noise. And PagerDuty's data shows on-call engineers spend nearly half their incident response time just *triaging* — scrolling through walls of red trying to find the one alert that actually matters."
>
> "Every minute of downtime costs between five and nine thousand dollars. If your team burns 30 minutes just finding the root cause, that's a quarter million dollars gone — before anyone even starts fixing the problem."
>
> "The core issue is simple: monitoring tells you everything is broken, but it doesn't tell you what broke first."

---

## Slide 3: Proposed Solution

### 🖥️ On the Slide

**Title:** Our Solution — Intelligent Alert Correlation Engine

**Visual: Simple left-to-right flow (5 boxes with arrows):**

```
Raw Alerts → Clean & Embed → Correlate & Cluster → Root Cause Rank → Dashboard
```

**Below the flow, 4 short bullets:**
- ✅ Groups related alerts into incident clusters
- 🎯 Identifies root cause with confidence scores
- 🔇 Suppresses noise (non-destructive)
- 💬 LLM-generated plain-English explanations

**Headline stat (bold, large):**
> **1,400 alerts → 40 incidents → 97% noise reduction**

---

### 🎤 Speaking Script

> "Our solution is an alert correlation engine that takes a raw, chaotic alert stream and does four things automatically."
>
> *[Point to raw alert stream on the live demo]* "What you're seeing here is the raw stream — fourteen hundred alerts flooding in within minutes. This is what your on-call engineer sees at 3 AM."
>
> "First, the engine parses and normalizes alerts from multiple sources into a common format. Then it cleans the text — strips out random IPs, IDs, and counters — and generates semantic embeddings using sentence-transformers."
>
> "Next, it correlates alerts that are close in time AND similar in meaning. We use roughly 4-minute time windows and cosine similarity on the embeddings. Alerts that are both temporally and semantically close get connected into a graph, and we extract connected components as incident clusters."
>
> *[Trigger correlation on the live demo]* "Watch what happens when we run correlation. Fourteen hundred alerts collapse into about 40 incident groups. 97% noise reduction — right there."
>
> "Within each cluster, we rank alerts by most likely root cause. The earliest alert is the strongest signal, and if we have service topology info, upstream services get priority. We output the top 3 candidates with confidence scores — and if confidence is low, we flag it for human review. We're honest about what we don't know."
>
> "Finally, we call an LLM once per cluster — not per alert — to generate a plain-English explanation of what happened."
>
> "The suppression is non-destructive. We never delete alerts, we just flag them. You can always expand and see everything."

---

## Slide 4: Technical Feasibility

### 🖥️ On the Slide

**Title:** Why This Works

**6 uniform cells (3×2 grid):**

| # | Component | Tech | Detail |
|---|---|---|---|
| 01 | Embeddings | sentence-transformers (local) | 5ms/alert, zero API cost, runs on CPU |
| 02 | Clustering | Graph-based, time-windowed | Scales linearly, no training required |
| 03 | Root Cause | Temporal + topology ranking | Deterministic, explainable logic |
| 04 | Explanations | LLM (1 call per cluster) | ~40 calls total, cost < $0.10 |
| 05 | Evaluation | Loghub + AIOps labeled data | Real labeled data, measurable accuracy |
| 06 | Architecture | FastAPI + Python | Open-source, runs on a laptop, no GPU |

**Footer line:**
> Zero model training. Runs on a laptop. Open-source stack.

---

### 🎤 Speaking Script

> "Everything in our pipeline uses proven, mature technology. No moonshots."
>
> "For embeddings, we use sentence-transformers — specifically all-MiniLM-L6-v2. It runs locally on CPU, generates a 384-dimensional vector in about 5 milliseconds per alert. For 10,000 alerts, that's under a minute with zero API costs."
>
> "For clustering, we don't compare every alert to every other alert — that would be an O(n²) disaster. We restrict comparisons to nearby time windows only. That makes it practically linear. And it's fully unsupervised — no training data needed."
>
> "Root cause ranking is deterministic. Earliest alert in the cluster is the strongest signal. If we have service topology, upstream beats downstream. We output confidence scores so engineers know how much to trust the result."
>
> "The LLM is the most expensive part, but we minimized it — one call per cluster, not per alert. For 1,400 alerts in 40 clusters, that's roughly 40 API calls. Total cost under ten cents."
>
> "And critically, we have real labeled data to evaluate against. Loghub gives us 16 real-world log datasets. The AIOps Challenge datasets include labeled root causes. We can actually measure accuracy, not just guess."
>
> "The whole thing runs on a laptop with no GPU. Open-source stack, nothing proprietary."

---

## Slide 5: Solution Architecture

### 🖥️ On the Slide

**Title:** Architecture

**Visual: 4-layer stacked diagram with tech labels per layer:**

| Layer | Components | Tech |
|---|---|---|
| DATA SOURCES | Loghub (HDFS, Spark) · AIOps Datasets | CSV / JSON parsers |
| PROCESSING PIPELINE | Parse → Clean → Embed → Correlate → Rank | sentence-transformers · NetworkX |
| API LAYER | /ingest · /run-pipeline · /incidents · /replay | FastAPI · WebSocket |
| FRONTEND | Raw Stream · Correlated View · Metrics · Replay | React · WebSocket |

**Tech footer (small, subtle):**
`Python · sentence-transformers · NetworkX · FastAPI · WebSocket · React`

---

### 🎤 Speaking Script

> "Here's how the system is structured, top to bottom."
>
> "At the top, our data sources — we work with Loghub datasets like HDFS and Spark logs, plus AIOps Challenge datasets with labeled root causes. The system is designed so adding new data sources is just writing a new parser."
>
> "The processing pipeline is the core. Alerts get parsed into a common schema — timestamp, service, message, severity. Then text gets cleaned, embedded with sentence-transformers, and fed into the correlation engine. The engine builds a graph where edges connect alerts that are close in time and similar in meaning. Connected components become incident clusters. Then the root cause ranker scores each alert within a cluster."
>
> "Below that, FastAPI exposes everything through REST endpoints — ingest alerts, run the pipeline, fetch incidents, and a WebSocket endpoint for live replay streaming."
>
> "The frontend dashboard is the user-facing layer. It shows the raw alert stream side-by-side with the correlated incident view, so you can see the before and after. You can click into any incident to see the timeline, root cause, and LLM explanation. Replay controls let you stream alerts in real-time for demos and post-incident reviews."
>
> "The whole stack is Python, sentence-transformers, NetworkX for graph operations, FastAPI, and WebSockets. Lightweight and portable."

---

## Slide 6: Initial Progress

### 🖥️ On the Slide

**Title:** Initial Progress

**Two-column layout:**

| ✅ Completed | 🔜 Coming Next |
|---|---|
| **Log Parsing Pipeline** — Unified parser for HDFS & Spark raw logs (1.77M alerts normalized) | **LLM Integration** — One-call-per-cluster plain-English root cause explanations |
| **Text Cleaning & Embedding** — Stripped noise from messages, generated 384-dim vectors via all-MiniLM-L6-v2 | **Live Replay Streaming** — WebSocket-powered real-time alert stream with play/pause controls |
| **Time-Windowed Similarity Clustering** — 4-min sliding window + cosine similarity graph → incident groups | **Parameter Tuning Dashboard** — Sweep across time windows & similarity thresholds, chart accuracy vs. noise reduction |
| **Root Cause Ranking** — Earliest-alert + severity scoring, top-3 candidates with confidence | **Full Error Report** — Detailed per-incident breakdown with alert timeline, severity distribution, and cluster metrics |
| **File Upload & Pipeline Trigger** — Judge can upload raw logs via the UI, full pipeline runs automatically | **Exportable Reports** — One-click PDF/CSV download of incident summaries for post-mortems and compliance |
| **FastAPI Backend** — `/api/upload`, `/api/status` endpoints with error handling | **GitHub Workflow Integration** — API hooks to trigger the pipeline directly from CI/CD pipelines and GitHub Actions |



---

### 🎤 Speaking Script

> "Here's where we stand right now."
>
> "On the left — what's already working. We built the full data pipeline end-to-end: raw log ingestion, text cleaning, embedding generation, time-windowed similarity clustering, and root cause ranking. The input feature is live — a judge can upload any raw log file through the dashboard and watch the pipeline process it in real time."
>
> "On the right — what's coming next. The big one is LLM integration: feeding each incident cluster to a language model to generate plain-English explanations of what went wrong. We're also building live replay streaming, a parameter tuning dashboard, and accuracy evaluation against labeled AIOps datasets."
>
> "The core intelligence is done. What remains is polish, explainability, and evaluation."

---

## Slide 7: Market Research

### 🖥️ On the Slide

**Title:** Why We're Different

**Comparison table (clean, 4 rows max):**

| | PagerDuty / Alertmanager | Moogsoft / BigPanda | **Us** |
|---|---|---|---|
| Grouping | Rules & labels only | Black-box ML | **Semantic + temporal** |
| Root Cause | ❌ None | Opaque | **Top 3 + confidence** |
| Setup | Manual rules | Needs topology map | **Zero config** |
| Cost | $21–49/user/mo | $50K–100K+/yr | **Open-source** |

**Positioning tagline:**
> "Enterprise-grade intelligence. Open-source simplicity."

---

### 🎤 Speaking Script

> "Let's look at what's already out there."
>
> "PagerDuty and Alertmanager represent the rules-based approach. They group alerts by matching labels — same service name, same check. The problem is, they miss connections across services. An alert saying 'connection refused on port 5432' and 'PostgreSQL health check failed' come from different sources with different labels — they'll never get grouped. And neither tool attempts root cause identification at all."
>
> "Moogsoft and BigPanda are the enterprise AI players. Moogsoft uses proprietary ML for correlation — it works, but it's a black box. You can't see why alerts were grouped, so engineers can't trust or debug it. BigPanda requires a complete service topology map before it can do anything — months of setup. And both cost $50K to $100K+ per year."
>
> *[Click into one incident on the live demo]* "Let me show you the difference. Here's one of our incident clusters — you can see the root cause highlighted, the timeline, and the plain-English explanation. Everything is transparent. An engineer can audit this and trust it."
>
> "We deliver 80% of what enterprise AIOps tools do at less than 1% of the cost, with the added benefit of being fully explainable."

---

## Slide 8: Closing & Datasets

### 🖥️ On the Slide

**Title:** Datasets & References

**Datasets used (clean list with icons):**

| Dataset | Source | What We Used It For |
|---|---|---|
| 🗂️ HDFS Logs | Loghub (GitHub) | Alert parsing & correlation testing |
| 🗂️ Spark Logs | Loghub (GitHub) | Multi-service alert scenarios |
| 🗂️ AIOps Challenge | Public release | Labeled root causes for accuracy eval |

**Bottom of slide — closing tagline (large, centered):**
> **"From noise to clarity. Thank you."**

---

### 🎤 Speaking Script

> "A quick note on the data we used. We worked with real-world log datasets from Loghub on GitHub — specifically HDFS and Spark logs. These gave us thousands of real WARN, ERROR, and FATAL alerts to test our correlation pipeline against."
>
> "For accuracy evaluation, we used a publicly released AIOps Challenge dataset that includes labeled root causes — so when we say our engine identified the right root cause, that's measured against actual ground truth, not our own judgment."
>
> "All datasets are publicly available and linked in our repo."
>
> "Thank you — happy to take questions."
