import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Label } from "recharts";

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

function PieLabel({ cx, cy, midAngle, innerRadius, outerRadius, percent, payload, ring }) {
  if (percent < 0.06) return null; // only show on segments >= 6%
  const RADIAN = Math.PI / 180;
  const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  const pctText = `${(percent * 100).toFixed(0)}%`;
  return (
    <text x={x} y={y} textAnchor="middle" dominantBaseline="central"
      fill="#0a1e3a" fontWeight="700" fontSize={percent > 0.12 ? 13 : 11}
      style={{ pointerEvents: "none", textShadow: "0 0 3px rgba(255,255,255,0.6)" }}>
      {pctText}
    </text>
  );
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
    body: "This view shows how the 250-chunk benchmark sample is distributed across 11 research projects compared to the full annotation population.\n\nOuter ring: population share based on actual annotation counts per project.\nInner ring: sample share in the benchmark set.\n\nDesign: 185 relevant chunks (74%) + 65 borderline irrelevant chunks (26%). The irrelevant chunks are NOT trivial spam \u2014 they are borderline cases where the pipeline classified them as not relevant with low confidence (3\u20138), meaning models are likely to disagree. This tests first-pass precision.\n\nNon-RUW projects get a base allocation. RUW sub-projects receive the remainder, distributed proportionally to their annotation volume.\n\nEach relevant chunk carries a classifications array with multiple taxonomy rows (avg 3.5 per chunk), pulled from source database tables. Edge cases have 2+ conflicting taxonomy categories."
  },
  database: {
    title: "Database Balance",
    body: "This view compares the source database composition of the benchmark sample against the full source universe.\n\nOuter ring: population share by database (Telegram channels, Integrum press archive, Google Drive, official Kremlin/MFA/MoD sources, ISW reports, etc.).\nInner ring: sample share actually drawn for the benchmark.\n\nRuBase aggregates text from 16+ source databases. Telegram channels alone account for ~45% of the corpus, split across war correspondents, official outlets, propagandists, Cossack groups, and expert analysis channels.\n\nDatabases with high population share but low sample share are under-represented in the benchmark. The \"Other Databases\" category collapses sources beyond the top 9 for readability."
  },
  time_group: {
    title: "Time Balance",
    body: "This view shows temporal distribution of the benchmark sample versus the full corpus.\n\nOuter ring: population share by time period.\nInner ring: sample share drawn for the benchmark.\n\nTime groups: pre-invasion (before Feb 2022), year-1 (2022), year-2 (2023), year-3 (2024), year-4+ (2025\u2013), and unknown (no reliable date metadata).\n\nTemporal balance matters because Russian military discourse, source quality, and topical focus shift significantly over the course of the war. A sample skewed toward one period may not reflect overall classification difficulty.\n\nEdge-case chunks from the database queries may have \"unknown\" time group if their source metadata was incomplete."
  },
  word_bucket: {
    title: "Length Balance",
    body: "This view shows document length distribution of the benchmark sample versus the full corpus.\n\nOuter ring: population share by word-count bucket.\nInner ring: sample share drawn for the benchmark.\n\nBuckets: 40\u201379 words (very short), 80\u2013149, 150\u2013299, 300\u2013599, 600+ (long-form).\n\nLength balance matters because very short chunks (e.g., single Telegram posts) and very long chunks (e.g., Kremlin speeches, academic papers) pose fundamentally different classification challenges. Short chunks may lack context for accurate taxonomy assignment; long chunks may contain multiple overlapping themes.\n\nThe benchmark intentionally includes chunks from 300\u20134000 characters for edge cases, biased toward medium-length texts where classification ambiguity is highest."
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

function buildPerProjectData(axis, sample, selectedProject) {
  const filtered = selectedProject === "ALL" ? sample : sample.filter((c) => (c.row_uid || "").split(":")[0] === selectedProject);
  const counts = {};
  for (const c of filtered) {
    const val = axis === "time_group" ? (c.time_group || "unknown") : axis === "word_bucket" ? (c.word_bucket || "unknown") : (c.database || "unknown");
    const key = axis === "database" ? val.toLowerCase().replace(/\s+/g, " ") : val;
    counts[key] = (counts[key] || 0) + 1;
  }
  const order = axis === "time_group" ? ["pre-invasion", "year-1", "year-2", "year-3", "year-4+", "unknown"]
    : axis === "word_bucket" ? ["40-79", "80-149", "150-299", "300-599", "600+"]
    : Object.keys(counts).sort((a, b) => (counts[b] || 0) - (counts[a] || 0));
  let rows = order.filter((k) => counts[k]).map((key, index) => ({
    key, label: titleKey(key, axis), sample: counts[key] || 0, overall: 0, color: COLORS[index % COLORS.length]
  }));
  // Add any keys not in order
  Object.keys(counts).filter((k) => !order.includes(k)).forEach((key, i) => {
    rows.push({ key, label: titleKey(key, axis), sample: counts[key], overall: 0, color: COLORS[(order.length + i) % COLORS.length] });
  });
  if (axis === "database" && rows.length > 10) {
    rows = rows.sort((a, b) => b.sample - a.sample);
    const other = rows.slice(9).reduce((acc, row) => { acc.sample += row.sample; return acc; }, { key: "other", label: "Other Databases", sample: 0, overall: 0, color: COLORS[9] });
    rows = [...rows.slice(0, 9), other];
  }
  return rows;
}

function DonutCard({ title, subtitle, axis, summary, population, sample, selectedProject, isFocused = false }) {
  const isFiltered = selectedProject && selectedProject !== "ALL";
  const rows = useMemo(() =>
    isFiltered ? buildPerProjectData(axis, sample || [], selectedProject) : buildAxisData(axis, summary, population),
    [axis, summary, population, sample, selectedProject, isFiltered]);
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
                label={(props) => <PieLabel {...props} ring="overall" />}
                labelLine={false}
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
                label={(props) => <PieLabel {...props} ring="sample" />}
                labelLine={false}
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

function AtlasPanel({ summary, population, sample }) {
  const [subtab, setSubtab] = useState("project");
  const [showInfo, setShowInfo] = useState(false);
  const [selectedProject, setSelectedProject] = useState("ALL");
  const showFilter = subtab !== "project";
  const projects = useMemo(() => {
    if (!sample) return [];
    const set = new Set(sample.map((c) => (c.row_uid || "").split(":")[0]));
    return [...set].sort();
  }, [sample]);

  const cards = [
    {
      key: "project",
      title: "Project Balance",
      subtitle: "Overall outer ring vs sample inner ring.",
      axis: "project"
    },
    {
      key: "database",
      title: selectedProject !== "ALL" ? `Database Balance — ${selectedProject}` : "Database Balance",
      subtitle: selectedProject !== "ALL" ? `Showing ${selectedProject} only.` : "Source universe vs constrained review draw.",
      axis: "database"
    },
    {
      key: "time",
      title: selectedProject !== "ALL" ? `Time Balance — ${selectedProject}` : "Time Balance",
      subtitle: selectedProject !== "ALL" ? `Showing ${selectedProject} only.` : "Pre-invasion, war-year, and unknown-date mix.",
      axis: "time_group"
    },
    {
      key: "length",
      title: selectedProject !== "ALL" ? `Length Balance — ${selectedProject}` : "Length Balance",
      subtitle: selectedProject !== "ALL" ? `Showing ${selectedProject} only.` : "Word-bucket fit for reviewer effort.",
      axis: "word_bucket"
    }
  ];

  const activeCard = cards.find((card) => card.key === subtab) || cards[0];

  return (
    <section className="atlas-shell">
      <div className="atlas-subtabs">
        <button className={subtab === "project" ? "active" : ""} onClick={() => { setSubtab("project"); setSelectedProject("ALL"); }}>Projects</button>
        <button className={subtab === "database" ? "active" : ""} onClick={() => setSubtab("database")}>Databases</button>
        <button className={subtab === "time" ? "active" : ""} onClick={() => setSubtab("time")}>Time</button>
        <button className={subtab === "length" ? "active" : ""} onClick={() => setSubtab("length")}>Length</button>
        {showFilter && (
          <select className="atlas-project-filter" value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)}>
            <option value="ALL">All Projects</option>
            {projects.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        )}
        <button className="info-btn" onClick={() => setShowInfo(true)}>?</button>
      </div>
      <main className="atlas-grid single">
        <DonutCard
          key={activeCard.key + "-" + selectedProject}
          title={activeCard.title}
          subtitle={activeCard.subtitle}
          axis={activeCard.axis}
          summary={summary}
          population={population}
          sample={sample}
          selectedProject={showFilter ? selectedProject : "ALL"}
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

function ReviewPanel({ sample, isStatic = false, claudeRelevance = {} }) {
  const [project, setProject] = useState("ALL");
  const [filterMode, setFilterMode] = useState("disagreements"); // "all" | "disagreements" | "agreements"
  const [currentIdx, setCurrentIdx] = useState(0);
  const [current, setCurrent] = useState(null);
  const [reviews, setReviews] = useState([]);
  const [gtRows, setGtRows] = useState([emptyAnnotation(0)]);
  const [claudeAnnotations, setClaudeAnnotations] = useState([]);
  const [liliiaDecisions, setLiliiaDecisions] = useState(() => {
    try { return JSON.parse(localStorage.getItem("liliia_decisions") || "{}"); } catch { return {}; }
  });
  const [form, setForm] = useState({
    judgment: "unsure",
    meets_benchmark: false,
    faithful_source: false,
    taxonomy_ok: false,
    metadata_ok: false,
    escalate: false,
    reviewer: "liliia",
    notes: ""
  });

  // Compute disagreements: pipeline vs claude relevance mismatch
  const allWithStatus = useMemo(() => {
    return sample.map((row) => {
      const pipelineRelevant = Boolean(row.classifications && row.classifications.length > 0);
      const claudeRelevant = claudeRelevance[row.row_uid] === "relevant";
      const isDisagreement = pipelineRelevant !== claudeRelevant;
      return { ...row, pipelineRelevant, claudeRelevant, isDisagreement };
    });
  }, [sample, claudeRelevance]);

  const filtered = useMemo(() => {
    let rows = project === "ALL" ? allWithStatus : allWithStatus.filter((row) => row.project === project);
    if (filterMode === "disagreements") rows = rows.filter((row) => row.isDisagreement);
    else if (filterMode === "agreements") rows = rows.filter((row) => !row.isDisagreement);
    rows = rows.sort((a, b) => (a.sample_row_id || 0) - (b.sample_row_id || 0));
    return rows;
  }, [project, allWithStatus, filterMode]);

  // Track decided count
  const decidedCount = useMemo(() => {
    return filtered.filter((r) => liliiaDecisions[r.row_uid]).length;
  }, [filtered, liliiaDecisions]);

  function saveLiliiaDecision(uid, decision, notes) {
    const updated = { ...liliiaDecisions, [uid]: { decision, notes, saved_at: new Date().toISOString() } };
    setLiliiaDecisions(updated);
    localStorage.setItem("liliia_decisions", JSON.stringify(updated));
  }

  function exportDecisions() {
    const data = JSON.stringify(liliiaDecisions, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "liliia_decisions.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  // --- localStorage helpers for static mode ---
  function lsKey() { return "ru_benchmark_reviews"; }
  function lsLoad() { try { return JSON.parse(localStorage.getItem(lsKey()) || "[]"); } catch { return []; } }
  function lsSave(arr) { localStorage.setItem(lsKey(), JSON.stringify(arr)); }
  function lsAnnoKey() { return "ru_benchmark_annotations"; }
  function lsAnnoLoad() { try { return JSON.parse(localStorage.getItem(lsAnnoKey()) || "{}"); } catch { return {}; } }
  function lsAnnoSave(obj) { localStorage.setItem(lsAnnoKey(), JSON.stringify(obj)); }

  async function refreshReviews() {
    if (isStatic) { setReviews(lsLoad()); return; }
    const res = await authFetch("/api/reviews");
    setReviews(await res.json());
  }

  async function loadClaudeAnnotations(rowUid) {
    if (isStatic) { setClaudeAnnotations([]); return; }
    try {
      const res = await authFetch(`/api/reviewer-annotations?row_uid=${encodeURIComponent(rowUid)}&reviewer=claude-opus-4-6`);
      setClaudeAnnotations(await res.json());
    } catch { setClaudeAnnotations([]); }
  }

  async function loadAnnotations(rowUid) {
    if (isStatic) {
      const all = lsAnnoLoad();
      const rows = all[rowUid] || [];
      setGtRows(rows.length ? rows : [emptyAnnotation(0)]);
      return;
    }
    try {
      const res = await authFetch(`/api/reviewer-annotations?row_uid=${encodeURIComponent(rowUid)}&reviewer=${encodeURIComponent(form.reviewer)}`);
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
    loadClaudeAnnotations(next.row_uid);
  }

  async function fetchFresh(freshOnly = true) {
    if (isStatic) { pickLocal(freshOnly); return; }
    const params = new URLSearchParams({ project, fresh_only: String(freshOnly) });
    const res = await authFetch(`/api/review/next?${params}`);
    const next = await res.json();
    setCurrent(next);
    resetForm();
    loadAnnotations(next.row_uid);
    loadClaudeAnnotations(next.row_uid);
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
    await authFetch("/api/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, row_uid: current.row_uid })
    });
    // Save each annotation row
    for (let i = 0; i < validGt.length; i++) {
      await authFetch("/api/reviewer-annotations", {
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
          <strong>Stage 3 Review</strong>
          <span>Compare pipeline vs Claude annotations. Mark your decision for each chunk.</span>
        </div>
        <div className="filter-pills">
          {[
            ["disagreements", "Disagreements Only"],
            ["all", "All Chunks"],
            ["agreements", "Agreements Only"],
          ].map(([mode, label]) => (
            <button key={mode} className={`pill ${filterMode === mode ? "active" : ""}`} onClick={() => { setFilterMode(mode); setCurrentIdx(0); }}>{label}</button>
          ))}
        </div>
        <div className="nav-controls">
          <button className="button secondary" disabled={currentIdx <= 0} onClick={() => { const ni = Math.max(0, currentIdx - 1); setCurrentIdx(ni); const row = filtered[ni]; if (row) { setCurrent(row); resetForm(); loadAnnotations(row.row_uid); loadClaudeAnnotations(row.row_uid); } }}>← Prev</button>
          <span className="nav-counter">{currentIdx + 1} / {filtered.length}</span>
          <button className="button secondary" disabled={currentIdx >= filtered.length - 1} onClick={() => { const ni = Math.min(filtered.length - 1, currentIdx + 1); setCurrentIdx(ni); const row = filtered[ni]; if (row) { setCurrent(row); resetForm(); loadAnnotations(row.row_uid); loadClaudeAnnotations(row.row_uid); } }}>Next →</button>
        </div>
        <span className="decided-counter">{decidedCount}/{filtered.length} decided</span>
        <button className="button primary" onClick={exportDecisions}>Export Decisions</button>
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
          <section className="comparison-section">
            <h3>Pipeline vs Claude — Taxonomy Comparison</h3>
            {(() => {
              const pCls = (current.classifications || []).filter((c) => c.HLTP && c.HLTP !== "NOT_RELEVANT" && c.HLTP !== "UNRESOLVABLE");
              const cCls = claudeAnnotations.filter((g) => g.classification_value && g.classification_value !== "NOT_RELEVANT" && g.relevance === "relevant");
              const pSet = new Set(pCls.map((c) => (c.HLTP || "").split("|")[0].trim()));
              const cSet = new Set(cCls.map((g) => (g.classification_value || "").split("|")[0].trim()));
              const agree = [...pSet].filter((h) => cSet.has(h));
              const pOnly = [...pSet].filter((h) => !cSet.has(h));
              const cOnly = [...cSet].filter((h) => !pSet.has(h));
              const pRelev = pCls.length > 0 || (current.classifications || []).some((c) => c.HLTP && c.HLTP !== "NOT_RELEVANT");
              const cRelev = cCls.length > 0 || (claudeAnnotations.length > 0 && claudeAnnotations.some((g) => g.relevance === "relevant"));
              const isIrrel = (current.row_uid || "").includes("irrelevant");
              return (
                <div className="comparison-grid">
                  <div className="comparison-col">
                    <div className="comparison-header">Pipeline</div>
                    <div className={`relevance-badge ${pRelev && !isIrrel ? "rel" : "irrel"}`}>{pRelev && !isIrrel ? "Relevant" : "Not Relevant"}</div>
                    {pCls.map((c, i) => {
                      const hltp = (c.HLTP || "").split("|")[0].trim();
                      const isAgreed = cSet.has(hltp);
                      return (
                        <div className={`te-chip ${isAgreed ? "agree" : "disagree"}`} key={`p-${i}`}>
                          <span className="te-badge">{isAgreed ? "AGREE" : "PIPELINE ONLY"}</span>
                          <strong>{c.HLTP}</strong>
                          {c["2nd_level_TE"] && <span>{c["2nd_level_TE"]}{c["3rd_level_TE"] ? " | " + c["3rd_level_TE"] : ""}</span>}
                          {c.confidence && <span className="te-conf">conf: {c.confidence}</span>}
                        </div>
                      );
                    })}
                    {pCls.length === 0 && <div className="te-chip empty">No taxonomy assigned</div>}
                  </div>
                  <div className="comparison-col">
                    <div className="comparison-header">Claude Opus 4.6</div>
                    <div className={`relevance-badge ${cRelev ? "rel" : "irrel"}`}>{cRelev ? "Relevant" : "Not Relevant"}</div>
                    {cCls.map((g, i) => {
                      const hltp = (g.classification_value || "").split("|")[0].trim();
                      const isAgreed = pSet.has(hltp);
                      return (
                        <div className={`te-chip ${isAgreed ? "agree" : "claude-only"}`} key={`c-${i}`}>
                          <span className="te-badge">{isAgreed ? "AGREE" : "CLAUDE ONLY"}</span>
                          <strong>{g.classification_value}</strong>
                          {g.confidence && <span className="te-conf">conf: {g.confidence}</span>}
                        </div>
                      );
                    })}
                    {cCls.length === 0 && claudeAnnotations.some((g) => g.relevance === "not_relevant") && (
                      <div className="te-chip irrel-note">{claudeAnnotations.find((g) => g.relevance === "not_relevant")?.notes || "Not relevant"}</div>
                    )}
                    {cCls.length === 0 && !claudeAnnotations.some((g) => g.relevance === "not_relevant") && (
                      <div className="te-chip empty">No taxonomy assigned</div>
                    )}
                  </div>
                </div>
              );
            })()}
          </section>
          <section className="panel decision-panel">
            <h3>Your Decision</h3>
            <div className="decision-buttons">
              <button
                className={`decision-btn relevant ${liliiaDecisions[current.row_uid]?.decision === "relevant" ? "active" : ""}`}
                onClick={() => { saveLiliiaDecision(current.row_uid, "relevant", form.notes); }}
              >RELEVANT</button>
              <button
                className={`decision-btn not-relevant ${liliiaDecisions[current.row_uid]?.decision === "not_relevant" ? "active" : ""}`}
                onClick={() => { saveLiliiaDecision(current.row_uid, "not_relevant", form.notes); }}
              >NOT RELEVANT</button>
            </div>
            {liliiaDecisions[current.row_uid] && (
              <div className="decision-saved">
                Saved: <strong>{liliiaDecisions[current.row_uid].decision.toUpperCase()}</strong>
                {" "}at {new Date(liliiaDecisions[current.row_uid].saved_at).toLocaleTimeString()}
              </div>
            )}
            <textarea
              placeholder="Optional notes..."
              value={form.notes}
              onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
              rows={2}
            />
            <button
              className="button primary"
              onClick={() => {
                if (!liliiaDecisions[current.row_uid]) saveLiliiaDecision(current.row_uid, "unsure", form.notes);
                const ni = Math.min(filtered.length - 1, currentIdx + 1);
                setCurrentIdx(ni);
                const row = filtered[ni];
                if (row) { setCurrent(row); resetForm(); loadAnnotations(row.row_uid); loadClaudeAnnotations(row.row_uid); }
              }}
            >Save + Next →</button>
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

function getAuthHeaders() {
  const creds = sessionStorage.getItem("auth_creds");
  if (creds) return { "Authorization": "Basic " + creds };
  return {};
}

function authFetch(url, opts = {}) {
  const headers = { ...getAuthHeaders(), ...(opts.headers || {}) };
  return fetch(url, { ...opts, headers });
}

export default function App() {
  const [boot, setBoot] = useState(null);
  const [tab, setTab] = useState("atlas");
  const [authPrompt, setAuthPrompt] = useState(false);
  const [authError, setAuthError] = useState(false);

  function tryLogin(username, password) {
    const creds = btoa(username + ":" + password);
    sessionStorage.setItem("auth_creds", creds);
    fetch("/api/bootstrap", { headers: { "Authorization": "Basic " + creds } })
      .then((res) => { if (!res.ok) throw new Error(); return res.json(); })
      .then((data) => { setBoot(data); setAuthPrompt(false); setAuthError(false); })
      .catch(() => { setAuthError(true); sessionStorage.removeItem("auth_creds"); });
  }

  useEffect(() => {
    authFetch("/api/bootstrap")
      .then((res) => { if (res.status === 401) { setAuthPrompt(true); throw new Error("auth"); } if (!res.ok) throw new Error(); return res.json(); })
      .then(setBoot)
      .catch((e) => { if (e.message === "auth") return;
        // Static mode: load data files directly (GitHub Pages)
        const base = import.meta.env.BASE_URL || "/";
        Promise.all([
          fetch(base + "data/sample.json").then((r) => r.json()),
          fetch(base + "data/sample_latest_summary.json").then((r) => r.json()),
          fetch(base + "data/project_assets_manifest.json").then((r) => r.json()),
          fetch(base + "data/population_strata_counts.json").then((r) => r.json()),
          fetch(base + "data/claude_relevance.json").then((r) => r.json()).catch(() => ({}))
        ]).then(([sample, summary, assets, population, claudeRelevance]) => {
          setBoot({ sample, summary, assets, population, claudeRelevance, static: true });
        });
      });
  }, []);

  if (authPrompt) return (
    <div className="screen loading">
      <div className="login-box">
        <h2>RU Benchmark Review</h2>
        <p>Enter your credentials</p>
        {authError && <p style={{color: "#ff6b6b"}}>Invalid credentials</p>}
        <form onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.target); tryLogin(f.get("user"), f.get("pass")); }}>
          <input name="user" placeholder="Username" autoFocus />
          <input name="pass" type="password" placeholder="Password" />
          <button className="button primary" type="submit">Login</button>
        </form>
      </div>
    </div>
  );

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
      {tab === "atlas" && <AtlasPanel summary={boot.summary} population={boot.population} sample={boot.sample} />}
      {tab === "review" && <ReviewPanel sample={boot.sample} isStatic={!!boot.static} claudeRelevance={boot.claudeRelevance || {}} />}
      {tab === "assets" && <AssetsPanel assets={boot.assets} />}
    </div>
  );
}
