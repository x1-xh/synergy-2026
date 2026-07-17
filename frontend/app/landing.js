"use client"
import { useEffect } from "react"
import Link from "next/link"
import styles from "./landing.module.css"

// ── Data ──────────────────────────────────────────────────────
const FEATURES = [
  {
    tag: "01 / VECTOR EMBEDDINGS",
    title: "Semantic Correlation",
    desc: "We embed every log line into a 384-dimensional vector space using sentence-transformers. Alerts close in both time and semantic meaning collapse into unified incident clusters automatically, bypassing brittle regex rules.",
  },
  {
    tag: "02 / GRAPH TOPOLOGY",
    title: "Root Cause Ranking",
    desc: "Within each cluster, our deterministic temporal graph scores every event. The earliest causal node wins, while service topology resolves ambiguity. You receive the exact root cause with high explainability.",
  },
  {
    tag: "03 / NARRATIVE AI",
    title: "LLM Explanations",
    desc: "Rather than spamming LLMs for every alert, we send only the consolidated cluster (~1 call per 375 alerts). You get a concise, human-readable narrative explaining the root failure and immediate remediation steps.",
  },
]

const BENCHMARKS = [
  { value: "15,000", label: "Raw Alerts Ingested", note: "Simulated HDFS & Spark Storm" },
  { value: "40",     label: "Incident Clusters",   note: "99.7% Compression Ratio" },
  { value: "99%",    label: "Noise Reduction",      note: "Downstream Alert Fatigue Eliminated" },
  { value: "< 5s",   label: "End-to-End Latency",  note: "Ingestion to UI WebSocket Broadcast" },
]

export default function LandingPage() {
  // Smooth scroll reveal observer
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add(styles.revealVisible)
          }
        })
      },
      { threshold: 0.1, rootMargin: "0px 0px -40px 0px" }
    )

    const elements = document.querySelectorAll(`.${styles.reveal}`)
    elements.forEach((el) => observer.observe(el))

    return () => observer.disconnect()
  }, [])

  return (
    <div className={styles.root}>
      {/* ══════════════════════════════════════════════════
          NAVBAR (Clean White / Minimalist)
      ══════════════════════════════════════════════════ */}
      <nav className={styles.nav}>
        <div className={styles.navInner}>
          <Link href="/" className={styles.logo}>
            <span className={styles.logoMark}>⬡</span>
            CLARITY<span className={styles.logoLight}>OPS</span>
          </Link>

          <div className={styles.navLinks}>
            <a href="#overview"   className={styles.navLink}>Overview</a>
            <a href="#pipeline"   className={styles.navLink}>Architecture</a>
            <a href="#benchmarks" className={styles.navLink}>Benchmarks</a>
          </div>

          <Link href="/dashboard" className={styles.navCta}>
            Launch Dashboard <span>→</span>
          </Link>
        </div>
      </nav>

      {/* ══════════════════════════════════════════════════
          HERO SECTION (Editorial Cream / Pastel Geometric Accent)
      ══════════════════════════════════════════════════ */}
      <section className={styles.hero} id="overview">
        <div className={styles.heroContent}>
          <div className={styles.badge}>
            <span className={styles.badgeDot} />
            ENTERPRISE AIOPS PLATFORM · NEXT-GEN CORRELATION
          </div>

          <h1 className={styles.headline}>
            The enterprise has unique alert streams that require <br />
            <span className={styles.headlineAccent}>intelligent correlation.</span>
          </h1>

          <p className={styles.subline}>
            ClarityOps is a next-generation AIOps correlation engine that transforms unreadable alert storms into clean, actionable incident groups — eliminating 99% of downstream noise in seconds.
          </p>

          <div className={styles.heroActions}>
            <Link href="/dashboard" className={styles.btnPrimary}>
              See Live Demo <span className={styles.arrow}>→</span>
            </Link>
            <a href="#pipeline" className={styles.btnSecondary}>
              Explore Architecture
            </a>
          </div>
        </div>

        {/* Minimalist Graphic Graphic / Node Illustration matching video */}
        <div className={styles.heroGraphic}>
          <div className={styles.floatingCircleSmall} />
          <div className={styles.floatingCircleMedium} />
          <div className={styles.floatingCircleBorder}>
            <div className={styles.floatingCircleCore} />
          </div>

          <div className={styles.connectorDiagram}>
            <div className={styles.nodePoint} style={{ top: "15%", left: "10%" }} />
            <div className={styles.nodePoint} style={{ top: "65%", left: "45%" }} />
            <div className={styles.nodePoint} style={{ top: "35%", left: "85%" }} />
            <svg className={styles.connectorSvg} viewBox="0 0 500 300" fill="none">
              <path d="M 60 45 L 230 195 L 430 105" stroke="#FF6B1A" strokeWidth="1.5" strokeDasharray="4 4" />
              <circle cx="60" cy="45" r="5" fill="#111827" />
              <circle cx="230" cy="195" r="5" fill="#FF6B1A" />
              <circle cx="430" cy="105" r="5" fill="#111827" />
            </svg>
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════
          BENCHMARKS STRIP (Crisp White & Charcoal)
      ══════════════════════════════════════════════════ */}
      <section className={styles.benchmarksSection} id="benchmarks">
        <div className={styles.sectionContainer}>
          <div className={`${styles.sectionHeader} ${styles.reveal}`}>
            <span className={styles.sectionOverline}>PROVEN PERFORMANCE</span>
            <h2 className={styles.sectionTitle}>Separating critical signals from alert noise.</h2>
          </div>

          <div className={styles.benchmarksGrid}>
            {BENCHMARKS.map((b, i) => (
              <div
                key={b.label}
                className={`${styles.benchmarkCard} ${styles.reveal}`}
                style={{ transitionDelay: `${i * 120}ms` }}
              >
                <div className={styles.benchmarkValue}>{b.value}</div>
                <div className={styles.benchmarkLabel}>{b.label}</div>
                <div className={styles.benchmarkNote}>{b.note}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════
          HOW IT WORKS (Minimalist Node Connector Graphic)
      ══════════════════════════════════════════════════ */}
      <section className={styles.pipelineSection} id="pipeline">
        <div className={styles.sectionContainer}>
          <div className={`${styles.sectionHeader} ${styles.reveal}`}>
            <span className={styles.sectionOverline}>CORE CAPABILITIES</span>
            <h2 className={styles.sectionTitle}>An AI-native workflow built for high-scale observability.</h2>
            <p className={styles.sectionSubtitle}>
              By combining graph theory with semantic embeddings, ClarityOps identifies exact root causes without relying on manual runbooks.
            </p>
          </div>

          <div className={styles.featuresGrid}>
            {FEATURES.map((f, i) => (
              <div
                key={f.title}
                className={`${styles.featureCard} ${styles.reveal}`}
                style={{ transitionDelay: `${i * 150}ms` }}
              >
                <span className={styles.featureTag}>{f.tag}</span>
                <h3 className={styles.featureTitle}>{f.title}</h3>
                <div className={styles.featureDivider} />
                <p className={styles.featureDesc}>{f.desc}</p>
              </div>
            ))}
          </div>

          {/* Connected Diagram Strip */}
          <div className={`${styles.flowStrip} ${styles.reveal}`}>
            <div className={styles.flowStep}>
              <span className={styles.flowNum}>01</span>
              <div>
                <strong>Ingest & Normalise</strong>
                <p>High-speed HDFS / Spark log parsing</p>
              </div>
            </div>
            <div className={styles.flowArrow}>───•───</div>
            <div className={styles.flowStep}>
              <span className={styles.flowNum}>02</span>
              <div>
                <strong>Vector Graph Clustering</strong>
                <p>Cosine similarity within 4-min windows</p>
              </div>
            </div>
            <div className={styles.flowArrow}>───•───</div>
            <div className={styles.flowStep}>
              <span className={styles.flowNum}>03</span>
              <div>
                <strong>Explainable Incident</strong>
                <p>Real-time UI broadcast via WebSockets</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════
          THE ORANGE SECTION
      ══════════════════════════════════════════════════ */}
      <section className={styles.orangeSection}>
        <div className={styles.petalTopLeft} />
        <div className={styles.petalTopRight} />

        <div className={styles.orangeContainer}>
          <div className={`${styles.orangeHeader} ${styles.reveal}`}>
            <span className={styles.orangeOverline}>OUR HYBRID APPROACH</span>
            <h2 className={styles.orangeTitle}>Deterministic Precision Meets Generative AI</h2>
            <p className={styles.orangeSubtitle}>
              Our engineering architecture combines deep experience in graph algorithms, distributed log streaming, and large language models — ensuring ultra-low latency without hallucination risks.
            </p>
          </div>

          <div className={styles.orangeCardsGrid}>
            <div className={`${styles.orangeCard} ${styles.reveal}`} style={{ transitionDelay: "100ms" }}>
              <h3>Graph & Temporal Engine</h3>
              <div className={styles.cardAccentBar} />
              <p>
                Processes thousands of concurrent events with O(N) clustering. By building an adjacency graph based on timestamp proximity and topology metadata, we deterministically separate root cause triggers from cascading downstream fallouts.
              </p>
            </div>

            <div className={`${styles.orangeCard} ${styles.reveal}`} style={{ transitionDelay: "250ms" }}>
              <h3>High-Throughput Streaming</h3>
              <div className={styles.cardAccentBar} />
              <p>
                Built with FastAPI and asynchronous WebSocket broadcasting. Our pipeline handles intense alert spikes effortlessly, updating the on-call engineer's screen live as incidents evolve.
              </p>
            </div>
          </div>

          <div className={`${styles.orangeCtaWrap} ${styles.reveal}`} style={{ transitionDelay: "350ms" }}>
            <Link href="/dashboard" className={styles.btnWhite}>
              See the Live Platform <span className={styles.arrow}>→</span>
            </Link>
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════
          CLEAN WHITE FOOTER
      ══════════════════════════════════════════════════ */}
      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div className={`${styles.footerBrand} ${styles.reveal}`}>
            <div className={styles.footerLogo}>CLARITYOPS</div>
            <p className={styles.footerNote}>
              Autonomous AIOps Alert Correlation & Graph Clustering Engine
            </p>
          </div>

          <div className={`${styles.footerMeta} ${styles.reveal}`}>
            <span>Production Ready · Real-Time Vector Embeddings</span>
            <span className={styles.footerCopyright}>© 2026 ClarityOps. Built for scale & reliability.</span>
          </div>
        </div>
      </footer>
    </div>
  )
}


