import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";

const COLORS = [
  "#b7d4ff",
  "#7fc7ff",
  "#8fe3db",
  "#f4f0b3",
  "#ffc88f",
  "#ff9a8b",
  "#f6b7e0",
  "#d6c8ff",
  "#8bb0ff",
  "#c4f2c5",
  "#ffe6a6",
  "#9ef0ff"
];

function pct(value, total) {
  if (!total) return "0.0%";
  return `${((value / total) * 100).toFixed(1)}%`;
}

function orderForAxis(axis, summary) {
  if (axis === "project") return Object.keys(summary?.notes?.project_targets || {});
  if (axis === "time_group") return ["pre-invasion", "year-1", "year-2", "year-3", "year-4+", "unknown"];
  if (axis === "word_bucket") return ["40-79", "80-149", "150-299", "300-599", "600+"];
  return Object.keys(summary?.notes?.axis_targets?.database || {});
}

function normalizeKey(value, axis) {
  const raw = String(value ?? "unknown").trim();
  return axis === "database" ? raw.toLowerCase().replace(/\s+/g, " ") : raw;
}

function titleKey(value, axis) {
  const mapping = {
    "telegram_war correspondent": "Telegram War Correspondent",
    "telegram_official": "Telegram Official",
    "telegram_propagandist": "Telegram Propagandist",
    "telegram_cossack": "Telegram Cossack",
    "google drive": "Google Drive",
    "google_scholar": "Google Scholar",
    "federation_council": "Federation Council",
    "state_duma": "State Duma",
    "russiamatters": "Russia Matters",
    "realclearworld": "RealClearWorld",
    "therussiaprogram": "The Russia Program"
  };
  if (axis !== "database") return value;
  return mapping[value] || value;
}

function buildAxisData(axis, summary, population) {
  const sampleMap = new Map(Object.entries(summary?.notes?.axis_actuals?.[axis] || {}).map(([k, v]) => [normalizeKey(k, axis), v]));
  const overallMap = new Map(
    Object.entries(population?.[axis] || {})
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([k, v]) => [normalizeKey(k, axis), v])
  );
  const labels = [];
  const seen = new Set();
  orderForAxis(axis, summary).forEach((label) => {
    const normalized = normalizeKey(label, axis);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      labels.push(normalized);
    }
  });
  [...overallMap.keys(), ...sampleMap.keys()].forEach((key) => {
    if (!seen.has(key)) {
      seen.add(key);
      labels.push(key);
    }
  });
  let rows = labels.map((key, index) => ({
    key,
    label: titleKey(key, axis),
    sample: sampleMap.get(key) || 0,
    overall: overallMap.get(key) || 0,
    color: COLORS[index % COLORS.length]
  })).filter((row) => row.sample > 0 || row.overall > 0);
  if (axis === "database" && rows.length > 10) {
    rows = rows.sort((a, b) => (b.sample * 1000 + b.overall) - (a.sample * 1000 + a.overall));
    const other = rows.slice(9).reduce((acc, row) => {
      acc.sample += row.sample;
      acc.overall += row.overall;
      return acc;
    }, { key: "other", label: "Other Databases", sample: 0, overall: 0, color: COLORS[9] });
    rows = [...rows.slice(0, 9), other];
  }
  return rows;
}

function CustomTooltip({ item, ring }) {
  if (!item) return null;
  if (ring === "sample") {
    return (
      <div className="chart-tip">
        <strong>{item.label}</strong>
        <div>Sample: {item.sample.toLocaleString()} rows</div>
        <div>Share: {pct(item.sample, item.sampleTotal)}</div>
      </div>
    );
  }
  return (
    <div className="chart-tip">
      <strong>{item.label}</strong>
      <div>Overall: {item.overall.toLocaleString()} rows</div>
      <div>Share: {pct(item.overall, item.overallTotal)}</div>
    </div>
  );
}

const ATLAS_INFO = {
  project: {
    title: "Project Balance",
    body: "This view shows how the 250-row review sample is distributed across research projects compared to the full population.\n\nOuter ring: overall population distribution across projects.\nInner ring: sample distribution drawn for review.\n\nThe goal is proportional representation \u2014 each project should appear in the sample roughly in proportion to its share of the total corpus. Large deviations indicate sampling bias that could skew benchmark results.\n\nEach legend chip shows the sample share and overall share side by side for quick comparison."
  },
  database: {
    title: "Database Balance",
    body: "This view compares the source database composition of the review sample against the full source universe.\n\nOuter ring: population share by database (Telegram channels, Google Drive, official sources, etc.).\nInner ring: sample share actually drawn for review.\n\nDatabases with high population share but low sample share are under-represented; the reverse means over-represented. Both distortions can bias quality assessment.\n\nDatabases beyond the top 9 are collapsed into \"Other Databases\" to keep the chart readable."
  },
  time_group: {
    title: "Time Balance",
    body: "This view shows temporal distribution of the review sample versus the full corpus.\n\nOuter ring: population share by time period (pre-invasion, war years 1\u20134+, unknown date).\nInner ring: sample share drawn for review.\n\nTemporal balance matters because language use, source quality, and topical focus shift over time. A sample skewed toward one period may not reflect overall benchmark quality.\n\nThe \"unknown\" category captures documents without reliable date metadata."
  },
  word_bucket: {
    title: "Length Balance",
    body: "This view shows document length distribution of the review sample versus the full corpus.\n\nOuter ring: population share by word-count bucket (40\u201379, 80\u2013149, 150\u2013299, 300\u2013599, 600+).\nInner ring: sample share drawn for review.\n\nLength balance matters because very short and very long documents pose different challenges for LLM processing. Over-sampling one length range could mask systematic quality issues in another.\n\nBuckets are designed around natural breakpoints in reviewer effort."
  }
};

function InfoModal({ info, onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-body" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{info.title}</h3>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>
        <div className="modal-content">
          {info.body.split("\n\n").map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </div>
      </div>
    </div>
  );
}

function DonutCard({ title, subtitle, axis, summary, population, isFocused = false }) {
  const rows = useMemo(() => buildAxisData(axis, summary, population), [axis, summary, population]);
  const sampleTotal = rows.reduce((sum, row) => sum + row.sample, 0);
  const overallTotal = rows.reduce((sum, row) => sum + row.overall, 0);
  const overallRows = rows.map((row) => ({ ...row, overallTotal, sampleTotal }));
  const sampleRows = rows.map((row) => ({ ...row, overallTotal, sampleTotal }));
  const cardRef = useRef(null);
  const copyRef = useRef(null);
  const bodyRef = useRef(null);
  const stackRef = useRef(null);
  const [layout, setLayout] = useState({ leftWidth: 0, rightWidth: 0, bodyHeight: 0 });
  const [tip, setTip] = useState({ item: null, ring: null, x: 0, y: 0, visible: false });

  useLayoutEffect(() => {
    function measure() {
      if (!cardRef.current || !copyRef.current || !bodyRef.current) return;
      const gap = 10;
      const cardRect = cardRef.current.getBoundingClientRect();
      const copyRect = copyRef.current.getBoundingClientRect();
      const bodyWidth = bodyRef.current.clientWidth;
      const bodyHeight = Math.max(260, Math.floor(cardRect.bottom - copyRect.bottom - 16));
      const leftWidth = Math.floor((bodyWidth - gap) / 2);
      const rightWidth = bodyWidth - leftWidth - gap;
      const donutSize = Math.min(leftWidth, bodyHeight);
      setLayout({ leftWidth, rightWidth, bodyHeight, donutSize });
    }

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    if (cardRef.current) observer.observe(cardRef.current);
    if (bodyRef.current) observer.observe(bodyRef.current);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  function handlePieEnter(entry, ring) {
    setTip((prev) => ({ ...prev, item: entry, ring, visible: true }));
  }

  function handlePieLeave() {
    setTip((prev) => ({ ...prev, item: null, visible: false }));
  }

  function handleDonutMouseMove(e) {
    if (!stackRef.current) return;
    const rect = stackRef.current.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const angle = Math.atan2(dy, dx);
    const tipDist = (layout.donutSize || rect.width) * 0.42;
    const tipX = Math.round(rect.width / 2 + Math.cos(angle) * tipDist);
    const tipY = Math.round(rect.height / 2 + Math.sin(angle) * tipDist);
    setTip((prev) => ({ ...prev, x: tipX, y: tipY }));
  }

  function handleDonutMouseLeave() {
    setTip({ item: null, ring: null, x: 0, y: 0, visible: false });
  }

  return (
    <section className={`panel donut-card ${isFocused ? "focused" : ""}`} data-atlas-card={axis} ref={cardRef}>
      <div className="card-copy" ref={copyRef}>
        <h3>{title}</h3>
        <p>{subtitle}</p>
      </div>
      <div
        className="donut-body"
        ref={bodyRef}
        style={layout.leftWidth ? { gridTemplateColumns: `${layout.leftWidth}px ${layout.rightWidth}px` } : undefined}
      >
        <div
          className="donut-stack"
          ref={stackRef}
          style={layout.leftWidth ? { width: `${layout.leftWidth}px`, height: `${layout.bodyHeight}px` } : undefined}
          onMouseMove={handleDonutMouseMove}
          onMouseLeave={handleDonutMouseLeave}
        >
          <ResponsiveContainer width={layout.donutSize || "100%"} height={layout.donutSize || "100%"}>
            <PieChart>
              <Pie
                data={overallRows}
                dataKey="overall"
                cx="50%" cy="50%"
                outerRadius="88%" innerRadius="54%"
                stroke="none"
                isAnimationActive={false}
                onMouseEnter={(_, idx) => handlePieEnter(overallRows[idx], "overall")}
                onMouseLeave={handlePieLeave}
              >
                {overallRows.map((row) => <Cell key={`overall-${row.key}`} fill={row.color} />)}
              </Pie>
              <Pie
                data={sampleRows}
                dataKey="sample"
                cx="50%" cy="50%"
                outerRadius="50%" innerRadius="22%"
                stroke="none"
                isAnimationActive={false}
                onMouseEnter={(_, idx) => handlePieEnter(sampleRows[idx], "sample")}
                onMouseLeave={handlePieLeave}
              >
                {sampleRows.map((row) => <Cell key={`sample-${row.key}`} fill={row.color} fillOpacity={0.92} />)}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="donut-center">
            <strong>{sampleTotal}</strong>
          </div>
          {tip.visible && tip.item && (
            <div
              className="chart-tip chart-tip-abs"
              style={{ left: tip.x, top: tip.y }}
            >
              <CustomTooltip item={tip.item} ring={tip.ring} />
            </div>
          )}
        </div>
        <div className="legend-grid">
          {rows.map((row) => (
            <div className="legend-chip" key={row.key}>
              <span className="swatch" style={{ background: row.color }} />
              <div>
                <strong>{row.label}</strong>
                <span>{pct(row.sample, sampleTotal)} sample · {row.overall ? pct(row.overall, overallTotal) : "overall pending"}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function AtlasPanel({ summary, population }) {
  const [subtab, setSubtab] = useState("project");
  const [showInfo, setShowInfo] = useState(false);
  const cards = [
    {
      key: "project",
      title: "Project Balance",
      subtitle: "Overall outer ring vs sample inner ring.",
      axis: "project"
    },
    {
      key: "database",
      title: "Database Balance",
      subtitle: "Source universe vs constrained review draw.",
      axis: "database"
    },
    {
      key: "time",
      title: "Time Balance",
      subtitle: "Pre-invasion, war-year, and unknown-date mix.",
      axis: "time_group"
    },
    {
      key: "length",
      title: "Length Balance",
      subtitle: "Word-bucket fit for reviewer effort.",
      axis: "word_bucket"
    }
  ];

  const activeCard = cards.find((card) => card.key === subtab) || cards[0];

  return (
    <section className="atlas-shell">
      <div className="atlas-subtabs">
        <button className={subtab === "project" ? "active" : ""} onClick={() => setSubtab("project")}>Projects</button>
        <button className={subtab === "database" ? "active" : ""} onClick={() => setSubtab("database")}>Databases</button>
        <button className={subtab === "time" ? "active" : ""} onClick={() => setSubtab("time")}>Time</button>
        <button className={subtab === "length" ? "active" : ""} onClick={() => setSubtab("length")}>Length</button>
        <button className="info-btn" onClick={() => setShowInfo(true)}>?</button>
      </div>
      <main className="atlas-grid single">
        <DonutCard
          key={activeCard.key}
          title={activeCard.title}
          subtitle={activeCard.subtitle}
          axis={activeCard.axis}
          summary={summary}
          population={population}
          isFocused
        />
      </main>
      {showInfo && <InfoModal info={ATLAS_INFO[activeCard.axis]} onClose={() => setShowInfo(false)} />}
    </section>
  );
}

function emptyAnnotation(idx) {
  return { annotation_index: idx, classification_value: "", relevance: "relevant", confidence: "medium", notes: "" };
}

function ReviewPanel({ sample, isStatic = false }) {
  const [project, setProject] = useState("ALL");
  const [current, setCurrent] = useState(null);
  const [reviews, setReviews] = useState([]);
  const [gtRows, setGtRows] = useState([emptyAnnotation(0)]);
  const [form, setForm] = useState({
    judgment: "unsure",
    meets_benchmark: false,
    faithful_source: false,
    taxonomy_ok: false,
    metadata_ok: false,
    escalate: false,
    reviewer: "sdspieg",
    notes: ""
  });

  const filtered = useMemo(
    () => (project === "ALL" ? sample : sample.filter((row) => row.project === project)),
    [project, sample]
  );

  // --- localStorage helpers for static mode ---
  function lsKey() { return "ru_benchmark_reviews"; }
  function lsLoad() { try { return JSON.parse(localStorage.getItem(lsKey()) || "[]"); } catch { return []; } }
  function lsSave(arr) { localStorage.setItem(lsKey(), JSON.stringify(arr)); }
  function lsAnnoKey() { return "ru_benchmark_annotations"; }
  function lsAnnoLoad() { try { return JSON.parse(localStorage.getItem(lsAnnoKey()) || "{}"); } catch { return {}; } }
  function lsAnnoSave(obj) { localStorage.setItem(lsAnnoKey(), JSON.stringify(obj)); }

  async function refreshReviews() {
    if (isStatic) { setReviews(lsLoad()); return; }
    const res = await fetch("/api/reviews");
    setReviews(await res.json());
  }

  async function loadAnnotations(rowUid) {
    if (isStatic) {
      const all = lsAnnoLoad();
      const rows = all[rowUid] || [];
      setGtRows(rows.length ? rows : [emptyAnnotation(0)]);
      return;
    }
    try {
      const res = await fetch(`/api/reviewer-annotations?row_uid=${encodeURIComponent(rowUid)}&reviewer=${encodeURIComponent(form.reviewer)}`);
      const rows = await res.json();
      setGtRows(rows.length ? rows : [emptyAnnotation(0)]);
    } catch { setGtRows([emptyAnnotation(0)]); }
  }

  function resetForm() {
    setForm((prev) => ({ ...prev, judgment: "unsure", meets_benchmark: false, faithful_source: false, taxonomy_ok: false, metadata_ok: false, escalate: false, notes: "" }));
    setGtRows([emptyAnnotation(0)]);
  }

  function pickLocal(freshOnly) {
    let rows = project === "ALL" ? sample : sample.filter((r) => r.project === project);
    if (!rows.length) return;
    const reviewed = new Set(lsLoad().map((r) => r.row_uid));
    if (freshOnly) {
      const unseen = rows.filter((r) => !reviewed.has(r.row_uid));
      if (unseen.length) rows = unseen;
    }
    rows = rows.sort((a, b) => a.sample_row_id - b.sample_row_id);
    const next = rows[reviewed.size % rows.length];
    setCurrent(next);
    resetForm();
    loadAnnotations(next.row_uid);
  }

  async function fetchFresh(freshOnly = true) {
    if (isStatic) { pickLocal(freshOnly); return; }
    const params = new URLSearchParams({ project, fresh_only: String(freshOnly) });
    const res = await fetch(`/api/review/next?${params}`);
    const next = await res.json();
    setCurrent(next);
    resetForm();
    loadAnnotations(next.row_uid);
  }

  async function saveReview(andNext = false) {
    if (!current) return;
    // Save ground truth annotations
    const validGt = gtRows.filter((r) => r.classification_value.trim());
    if (isStatic) {
      const all = lsLoad().filter((r) => r.row_uid !== current.row_uid);
      all.unshift({ ...form, row_uid: current.row_uid, sample_row_id: current.sample_row_id, project: current.project, saved_at: new Date().toISOString() });
      lsSave(all);
      setReviews(all);
      const annoAll = lsAnnoLoad();
      annoAll[current.row_uid] = validGt;
      lsAnnoSave(annoAll);
      if (andNext) pickLocal(true);
      return;
    }
    await fetch("/api/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, row_uid: current.row_uid })
    });
    // Save each annotation row
    for (let i = 0; i < validGt.length; i++) {
      await fetch("/api/reviewer-annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validGt[i], annotation_index: i, row_uid: current.row_uid, reviewer: form.reviewer })
      });
    }
    await refreshReviews();
    if (andNext) await fetchFresh(true);
  }

  function updateGtRow(idx, field, value) {
    setGtRows((prev) => prev.map((r, i) => i === idx ? { ...r, [field]: value } : r));
  }

  function addGtRow() {
    if (gtRows.length >= 9) return;
    setGtRows((prev) => [...prev, emptyAnnotation(prev.length)]);
  }

  function removeGtRow(idx) {
    setGtRows((prev) => prev.length <= 1 ? [emptyAnnotation(0)] : prev.filter((_, i) => i !== idx).map((r, i) => ({ ...r, annotation_index: i })));
  }

  useEffect(() => {
    if (!sample.length) return;
    fetchFresh(false);
    refreshReviews();
  }, [sample.length]);

  useEffect(() => {
    if (!sample.length) return;
    fetchFresh(false);
  }, [project]);

  if (!current) return <section className="panel">Loading review workspace...</section>;

  return (
    <section className="review-screen">
      <div className="review-toolbar">
        <div className="panel compact">
          <strong>Reviewer Flow</strong>
          <span>Serve a fresh chunk, judge it quickly, persist to the server, move on.</span>
        </div>
        <button className="button secondary" onClick={() => fetchFresh(true)}>Serve Fresh Chunk</button>
        <button className="button primary" onClick={() => saveReview(true)}>Save + Next</button>
      </div>
      <div className="review-grid">
        <aside className="panel sidebar">
          <div className="queue-grid">
            <div className="metric"><strong>{filtered.length}</strong><span>rows in filter</span></div>
            <div className="metric"><strong>{reviews.length}</strong><span>saved reviews</span></div>
          </div>
          <label>Project</label>
          <select value={project} onChange={(event) => setProject(event.target.value)}>
            <option value="ALL">All projects</option>
            {[...new Set(sample.map((row) => row.project))].sort().map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
          <div className="button-row">
            <button className="button secondary" onClick={() => fetchFresh(false)}>Another</button>
          </div>
          <h3>Judge This Chunk</h3>
          <div className="judgment-grid">
            {["correct", "partial", "incorrect", "unsure"].map((value) => (
              <button
                key={value}
                className={`choice ${form.judgment === value ? "active" : ""}`}
                onClick={() => setForm((prev) => ({ ...prev, judgment: value }))}
              >
                {value}
              </button>
            ))}
          </div>
          <div className="check-grid">
            {[
              ["faithful_source", "Faithful to source text"],
              ["taxonomy_ok", "Taxonomy assignment looks right"],
              ["metadata_ok", "Metadata looks right"],
              ["escalate", "Needs escalation"]
            ].map(([key, label]) => (
              <label className="check-chip" key={key}>
                <input type="checkbox" checked={form[key]} onChange={(event) => setForm((prev) => ({ ...prev, [key]: event.target.checked }))} />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <label className="check-chip block">
            <input type="checkbox" checked={form.meets_benchmark} onChange={(event) => setForm((prev) => ({ ...prev, meets_benchmark: event.target.checked }))} />
            <span>Meets benchmark criteria</span>
          </label>

          <h3>Ground Truth Annotations</h3>
          <div className="gt-annotations">
            {gtRows.map((gt, idx) => (
              <div className="gt-row" key={idx}>
                <div className="gt-row-head">
                  <span className="gt-row-num">#{idx + 1}</span>
                  <select value={gt.relevance} onChange={(e) => updateGtRow(idx, "relevance", e.target.value)}>
                    <option value="relevant">Relevant</option>
                    <option value="partially_relevant">Partially</option>
                    <option value="not_relevant">Not relevant</option>
                  </select>
                  <select value={gt.confidence} onChange={(e) => updateGtRow(idx, "confidence", e.target.value)}>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                  <button className="gt-remove" onClick={() => removeGtRow(idx)}>x</button>
                </div>
                <input
                  placeholder="Classification row (e.g. HLTP | TE | Classification)"
                  value={gt.classification_value}
                  onChange={(e) => updateGtRow(idx, "classification_value", e.target.value)}
                />
                <input
                  placeholder="Notes (optional)"
                  value={gt.notes}
                  onChange={(e) => updateGtRow(idx, "notes", e.target.value)}
                />
              </div>
            ))}
            {gtRows.length < 9 && (
              <button className="button secondary" onClick={addGtRow}>+ Add Classification Row</button>
            )}
          </div>

          <label>Reviewer</label>
          <input value={form.reviewer} onChange={(event) => setForm((prev) => ({ ...prev, reviewer: event.target.value }))} />
          <label>Notes</label>
          <textarea value={form.notes} onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))} />
          <button className="button primary" onClick={() => saveReview(false)}>Save Review</button>
        </aside>
        <main className="review-main">
          <section className="panel row-summary">
            <div>
              <h2>Row {current.sample_row_id} · {current.project}</h2>
              <p>{current.source_norm} · {current.database} · {current.time_group} · {current.word_bucket}</p>
            </div>
            <div className="chip">{current.row_uid}</div>
          </section>
          <section className="panel source-text">
            <div className="source-head">
              <strong>Source Text</strong>
              <span className="chip">{current.word_count} words</span>
            </div>
            <pre>{(current.chunk_text || "").replace(/\n{3,}/g, "\n\n").trim()}</pre>
          </section>
          <section className="review-details">
            <section className="panel meta-grid">
              {[
                ["Project", current.project],
                ["Project DB", current.project_db],
                ["Document ID", current.document_id],
                ["Database", current.database],
                ["Source", current.source_norm],
                ["Date", current.date || "Unknown"],
                ["Author", current.author || "Unknown"],
                ["Word Bucket", current.word_bucket]
              ].map(([label, value]) => (
                <div className="meta-card" key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </section>
            <section className="passes-grid">
              {[
                ["Pass 1", current.pass1],
                ["Pass 2", current.pass2],
                ["Pass 3", current.pass3]
              ].map(([label, value]) => (
                <article className="panel pass-card" key={label}>
                  <span>{label}</span>
                  <p>{value}</p>
                </article>
              ))}
            </section>
          </section>
        </main>
      </div>
    </section>
  );
}

function AssetsPanel({ assets }) {
  return (
    <section className="asset-screen panel">
      <h2>Project Assets</h2>
      <div className="asset-grid">
        {(assets.projects || []).map((project) => (
          <article className="asset-card" key={project.project}>
            <strong>{project.project}</strong>
            <span>{project.results_source}</span>
            <a href={project.prompts_repo} target="_blank" rel="noreferrer">{project.prompts_repo}</a>
          </article>
        ))}
      </div>
    </section>
  );
}

export default function App() {
  const [boot, setBoot] = useState(null);
  const [tab, setTab] = useState("atlas");

  useEffect(() => {
    fetch("/api/bootstrap")
      .then((res) => { if (!res.ok) throw new Error(); return res.json(); })
      .then(setBoot)
      .catch(() => {
        // Static mode: load data files directly (GitHub Pages)
        const base = import.meta.env.BASE_URL || "/";
        Promise.all([
          fetch(base + "data/sample.json").then((r) => r.json()),
          fetch(base + "data/sample_latest_summary.json").then((r) => r.json()),
          fetch(base + "data/project_assets_manifest.json").then((r) => r.json()),
          fetch(base + "data/population_strata_counts.json").then((r) => r.json())
        ]).then(([sample, summary, assets, population]) => {
          setBoot({ sample, summary, assets, population, static: true });
        });
      });
  }, []);

  if (!boot) return <div className="screen loading">Loading server app…</div>;

  return (
    <div className={`screen ${tab !== "atlas" ? "focused" : ""}`}>
      <header className="topline">
        <a href="https://hcss.nl/rubase/" target="_blank" rel="noopener noreferrer">
          <img src={import.meta.env.BASE_URL + "rubase_logo.svg"} alt="RuBase" className="header-logo" />
        </a>
        <div className="header-center">
          <div className="brand">RU LLM Classification Benchmark Review Dashboard</div>
          <div className="chip">{new Date(boot.summary.generated_at).toLocaleString()}</div>
        </div>
        <a href="https://hcss.nl/" target="_blank" rel="noopener noreferrer">
          <img src={import.meta.env.BASE_URL + "hcss_logo.svg"} alt="HCSS" className="header-logo" />
        </a>
      </header>
      <nav className="tabs">
        <button className={tab === "atlas" ? "active" : ""} onClick={() => setTab("atlas")}>Stratification Atlas</button>
        <button className={tab === "review" ? "active" : ""} onClick={() => setTab("review")}>Review Workspace</button>
        <button className={tab === "assets" ? "active" : ""} onClick={() => setTab("assets")}>Project Assets</button>
      </nav>
      {tab === "atlas" && <AtlasPanel summary={boot.summary} population={boot.population} />}
      {tab === "review" && <ReviewPanel sample={boot.sample} isStatic={!!boot.static} />}
      {tab === "assets" && <AssetsPanel assets={boot.assets} />}
    </div>
  );
}
