import { useState, useMemo, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { normalizeApiError } from "../api/client";
import { useDocuments, extractDocumentId } from "../hooks/useDocuments";
import { useWorkflowState, getMissingSteps } from "../hooks/useWorkflowState";
import type { DocumentRecord } from "../types/api";
import { GapAnalysisResult } from "../components/GapAnalysisView";
import type {
  PolicyStatuteComplianceResponse,
  PolicySectionResult,
  AppliedStatute,
  GapAnalysisResponse,
  GapItem,
} from "../types/api";

const DEFAULT_POLICY_COLLECTION = "policy_embeddings";
type ComplianceFilter = "all" | "compliant" | "non_compliant" | "neither";
type GapFilter = "all" | "addressed" | "partial" | "ambiguous" | "missing" | "conflict";

function truncateAtBoundary(text: string, maxLen: number): string {
  if (!text || text.length <= maxLen) return text;
  const segment = text.slice(0, maxLen + 1);
  const cut = Math.max(
    segment.lastIndexOf("\n\n"),
    segment.lastIndexOf("\n"),
    segment.lastIndexOf(". "),
    segment.lastIndexOf("! "),
    segment.lastIndexOf("? "),
    segment.lastIndexOf(" "),
    0
  );
  if (cut === 0) return segment.slice(0, maxLen).trimEnd() + "…";
  return segment.slice(0, cut).trimEnd() + "…";
}

function formatConfidence(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${Math.round(value <= 1 ? value * 100 : value)}%`;
}

function formatStatuteCitation(statute: AppliedStatute): string {
  const j = statute.jurisdiction || "";
  const id = statute.statute_id || "";
  const sub = statute.section_id ? `(${statute.section_id})` : "";
  return `${j} §${id}${sub}`;
}

export default function CompliancePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const policyFromState = (location.state as { policy?: DocumentRecord })?.policy;

  const { documents } = useDocuments("policy");

  const [selectedPolicy, setSelectedPolicy] = useState<DocumentRecord | null>(
    policyFromState ?? null
  );
  const [jurisdictionOverride, setJurisdictionOverride] = useState("");
  const [applicabilityLoading, setApplicabilityLoading] = useState(false);
  const [applicabilityError, setApplicabilityError] = useState<string | null>(
    null
  );
  const [gapResult, setGapResult] = useState<GapAnalysisResponse | null>(null);
  const [gapLoading, setGapLoading] = useState(false);
  const [gapError, setGapError] = useState<string | null>(null);
  const [healthResult, setHealthResult] = useState<Record<string, unknown> | null>(
    null
  );
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [multiResult, setMultiResult] = useState<Record<string, unknown> | null>(
    null
  );
  const [multiLoading, setMultiLoading] = useState(false);
  const [multiError, setMultiError] = useState<string | null>(null);
  const [policyStatuteResult, setPolicyStatuteResult] =
    useState<PolicyStatuteComplianceResponse | null>(null);
  const [policyStatuteLoading, setPolicyStatuteLoading] = useState(false);
  const [policyStatuteError, setPolicyStatuteError] = useState<string | null>(
    null
  );
  const [policyStatuteJurisdiction, setPolicyStatuteJurisdiction] =
    useState("CA");
  const [complianceFilter, setComplianceFilter] =
    useState<ComplianceFilter>("all");
  const [expandedSectionId, setExpandedSectionId] = useState<string | null>(
    null
  );
  const [gapFilter, setGapFilter] = useState<GapFilter>("all");
  const [numRows, setNumRows] = useState<string>("");
  const [activeTab, setActiveTab] = useState<
    "applicability" | "gap" | "health" | "multi" | "policy-statute"
  >("applicability");

  const policyId = selectedPolicy ? extractDocumentId(selectedPolicy) : "";
  const { state: workflowState, refetch: refetchWorkflow } = useWorkflowState(policyId || null, "policy");
  const missingSteps = getMissingSteps(workflowState);
  const policyReadyForCompliance = workflowState?.ready_for_compliance ?? false;

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && policyId) {
        void refetchWorkflow();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [policyId, refetchWorkflow]);

  const policyOptions = useMemo(() => {
    const fromDocs = documents.map((d) => ({
      doc: d,
      id: extractDocumentId(d),
    }));
    if (selectedPolicy && policyId) {
      const seen = new Set(fromDocs.map((p) => p.id));
      if (!seen.has(policyId)) {
        return [{ doc: selectedPolicy, id: policyId }, ...fromDocs];
      }
    }
    return fromDocs;
  }, [documents, selectedPolicy, policyId]);

  const jurisdictions = useMemo(() => {
    const override = jurisdictionOverride
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return override;
  }, [jurisdictionOverride]);

  useEffect(() => {
    if (policyFromState && !selectedPolicy) {
      setSelectedPolicy(policyFromState);
    }
  }, [policyFromState, selectedPolicy]);

  useEffect(() => {
    setApplicabilityError(null);
  }, [policyId]);

  const handleSuggestJurisdictions = async () => {
    if (!policyId) return;
    setApplicabilityLoading(true);
    setApplicabilityError(null);
    try {
      const res = await fetch("/api/compliance/applicability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy_document_id: policyId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(
          (err as { error?: string }).error || res.statusText || "Request failed"
        );
      }
      const data = (await res.json()) as {
        applicable_jurisdictions?: string[];
        error?: string;
      };
      const suggested = data.applicable_jurisdictions ?? [];
      if (data.error) {
        setApplicabilityError(
          data.error === "policy_not_found"
            ? "Policy not found. Ensure the document is gathered, parsed, and vector-indexed."
            : data.error === "could_not_parse_slm_response"
              ? "Could not parse suggestion from model."
              : String(data.error)
        );
      } else {
        setApplicabilityError(null);
        if (Array.isArray(suggested) && suggested.length > 0) {
          setJurisdictionOverride(suggested.join(", "));
        }
      }
    } catch (err) {
      setApplicabilityError(normalizeApiError(err) || "Suggestion failed.");
    } finally {
      setApplicabilityLoading(false);
    }
  };

  const handleRunGap = async () => {
    if (!policyId) return;
    setGapLoading(true);
    setGapError(null);
    setGapResult(null);
    try {
      const payload: Record<string, unknown> = {
        policy_document_id: policyId,
        applicable_jurisdictions:
          jurisdictions.length > 0 ? jurisdictions : undefined,
        save_results: true,
      };
      const n = numRows.trim() ? parseInt(numRows, 10) : undefined;
      if (n !== undefined && !Number.isNaN(n) && n > 0) {
        payload.num_rows = n;
      }
      const res = await fetch("/api/compliance/gap-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (res.status === 409) void refetchWorkflow();
        throw new Error(
          (err as { error?: string }).error || res.statusText || "Request failed"
        );
      }
      const data = (await res.json()) as GapAnalysisResponse;
      setGapResult(data);
      setActiveTab("gap");
    } catch (err) {
      setGapError(normalizeApiError(err) || "Gap analysis failed.");
    } finally {
      setGapLoading(false);
    }
  };

  const handleRunHealth = async () => {
    if (!policyId) return;
    setHealthLoading(true);
    setHealthError(null);
    setHealthResult(null);
    try {
      const res = await fetch("/api/compliance/health-score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          policy_document_id: policyId,
          applicable_jurisdictions:
            jurisdictions.length > 0 ? jurisdictions : undefined,
          save_results: true,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (res.status === 409) void refetchWorkflow();
        throw new Error(
          (err as { error?: string }).error || res.statusText || "Request failed"
        );
      }
      const data = await res.json();
      setHealthResult(data);
      setActiveTab("health");
    } catch (err) {
      setHealthError(normalizeApiError(err) || "Health score failed.");
    } finally {
      setHealthLoading(false);
    }
  };

  const handleRunMulti = async () => {
    if (!policyId || jurisdictions.length === 0) {
      setMultiError("Enter jurisdictions (e.g. CA, VA, CO).");
      return;
    }
    setMultiLoading(true);
    setMultiError(null);
    setMultiResult(null);
    try {
      const res = await fetch("/api/compliance/multi-jurisdictional", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          applicable_jurisdictions: jurisdictions,
          policy_document_id: policyId,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (res.status === 409) void refetchWorkflow();
        throw new Error(
          (err as { error?: string }).error || res.statusText || "Request failed"
        );
      }
      const data = await res.json();
      setMultiResult(data);
      setActiveTab("multi");
    } catch (err) {
      setMultiError(normalizeApiError(err) || "Multi-jurisdictional failed.");
    } finally {
      setMultiLoading(false);
    }
  };

  const handleRunPolicyStatute = async () => {
    const j = policyStatuteJurisdiction.trim();
    if (!policyId || !j) return;
    setPolicyStatuteLoading(true);
    setPolicyStatuteError(null);
    setPolicyStatuteResult(null);
    try {
      const res = await fetch("/api/compliance/policy-statute-compliance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          policy_id: policyId,
          policy_collection: DEFAULT_POLICY_COLLECTION,
          jurisdiction: j,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (res.status === 409) void refetchWorkflow();
        throw new Error(
          (err as { error?: string }).error || res.statusText || "Request failed"
        );
      }
      const data = (await res.json()) as PolicyStatuteComplianceResponse;
      setPolicyStatuteResult(data);
      setActiveTab("policy-statute");
    } catch (err) {
      setPolicyStatuteError(normalizeApiError(err) || "Policy-statute compliance failed.");
    } finally {
      setPolicyStatuteLoading(false);
    }
  };

  const policyStatuteFilteredSections = useMemo(() => {
    if (!policyStatuteResult?.sections) return [];
    if (complianceFilter === "all") return policyStatuteResult.sections;
    return policyStatuteResult.sections.filter((s) => s.compliance === complianceFilter);
  }, [policyStatuteResult?.sections, complianceFilter]);

  const gapFilteredItems = useMemo(() => {
    const gaps = gapResult?.gaps ?? [];
    if (gapFilter === "all") return gaps;
    return gaps.filter((g) => g.status === gapFilter);
  }, [gapResult?.gaps, gapFilter]);

  const remediationSuggestions = useMemo(() => {
    if (!policyStatuteResult?.sections) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of policyStatuteResult.sections) {
      if (s.compliance === "compliant") continue;
      for (const r of s.remediation_suggestions || []) {
        const t = r.trim();
        if (t && !seen.has(t)) {
          seen.add(t);
          out.push(t);
        }
      }
    }
    return out;
  }, [policyStatuteResult?.sections]);

  const healthScore = healthResult?.privacy_health_score as number | undefined;

  return (
    <>
      <header className="main-header">
        <div>
          <p className="eyebrow">Compliance</p>
          <h2>Run compliance engines</h2>
          <p className="subtitle">
            Run applicability, gap analysis, health score, multi-jurisdictional,
            or policy-statute compliance.
          </p>
        </div>
        {policyStatuteResult && (
          <div className="header-card compliance-summary-strip">
            <p className="header-card-title">Overall</p>
            <p
              className={`header-card-value compliance-overall compliance-overall--${policyStatuteResult.summary.overall_compliance}`}
            >
              {policyStatuteResult.summary.overall_compliance}
            </p>
            <div className="compliance-summary-badges">
              <span className="compliance-summary-badge compliance-badge--compliant">
                {policyStatuteResult.summary.counts.compliant} compliant
              </span>
              <span className="compliance-summary-badge compliance-badge--non_compliant">
                {policyStatuteResult.summary.counts.non_compliant} non-compliant
              </span>
              <span className="compliance-summary-badge compliance-badge--neither">
                {policyStatuteResult.summary.counts.neither} neither
              </span>
            </div>
          </div>
        )}
        {healthResult && !policyStatuteResult && (
          <div className="header-card">
            <p className="header-card-title">Privacy Health Score</p>
            <p className="header-card-value">
              {healthScore != null ? healthScore : "—"}
            </p>
            <p className="header-card-caption">0–100</p>
          </div>
        )}
      </header>

      <section className="compliance-panel">
        <div className="panel-header">
          <p className="panel-title">Policy selection</p>
          <div className="compliance-policy-picker">
            <select
              value={policyId || ""}
              onChange={(e) => {
                const id = e.target.value;
                const opt = policyOptions.find((p) => p.id === id);
                setSelectedPolicy(opt?.doc ?? null);
              }}
            >
              <option value="">Select a policy…</option>
              {policyOptions.map(({ doc, id }) => (
                <option key={id} value={id}>
                  {doc.title || doc.company_name || id}
                </option>
              ))}
            </select>
            {policyId && (
              <button
                type="button"
                className="ghost-button"
                onClick={() => navigate("/policies")}
              >
                Browse policies
              </button>
            )}
          </div>
        </div>

        {policyId && !policyReadyForCompliance && (
          <div className="compliance-not-ready-banner">
            <p>Policy is not ready for compliance. Complete these steps: {missingSteps.join(", ")}.</p>
            <p className="compliance-not-ready-hint">Gather, parse, and vector index the document in Policies.</p>
            <button
              type="button"
              className="ghost-button"
              onClick={() => void refetchWorkflow()}
            >
              Refresh workflow status
            </button>
          </div>
        )}
        <div className="compliance-steps">
          <div className="compliance-step">
            <h4>Step 1: Jurisdictions</h4>
            <p className="compliance-step-desc">
              Enter applicable jurisdictions (e.g. CA, VA, CO, CT, US).
            </p>
            <label className="applicability-result">
              <span>Jurisdictions (comma-separated):</span>
              <input
                type="text"
                value={jurisdictionOverride}
                onChange={(e) => setJurisdictionOverride(e.target.value)}
                placeholder="e.g. CA, VA, CO"
              />
            </label>
            <button
              className="ghost-button"
              type="button"
              onClick={handleSuggestJurisdictions}
              disabled={!policyId || !policyReadyForCompliance || applicabilityLoading}
            >
              {applicabilityLoading ? "Suggesting…" : "Suggest from policy"}
            </button>
            {applicabilityError && (
              <div className="error-banner">
                <span className="error-text">{applicabilityError}</span>
              </div>
            )}
          </div>

          <div className="compliance-step">
            <h4>Step 2: Run engines</h4>
            <label className="applicability-result">
              <span>Number of rows (gap analysis):</span>
              <input
                type="number"
                min={1}
                value={numRows}
                onChange={(e) => setNumRows(e.target.value)}
                placeholder="e.g. 50"
              />
            </label>
            {(gapLoading || healthLoading || multiLoading || policyStatuteLoading) && (
              <p className="compliance-loading-hint">
                {gapLoading && "Running gap analysis…"}
                {healthLoading && "Running health score…"}
                {multiLoading && "Running multi-jurisdictional…"}
                {policyStatuteLoading && "Running policy-statute compliance…"}
              </p>
            )}
            <div className="compliance-engine-buttons">
              <button
                className="ghost-button"
                type="button"
                onClick={handleRunGap}
                disabled={!policyId || !policyReadyForCompliance || gapLoading}
              >
                {gapLoading ? "…" : "Gap analysis"}
              </button>
              <button
                className="ghost-button"
                type="button"
                onClick={handleRunHealth}
                disabled={!policyId || !policyReadyForCompliance || healthLoading}
              >
                {healthLoading ? "…" : "Health score"}
              </button>
              <button
                className="ghost-button"
                type="button"
                onClick={handleRunMulti}
                disabled={!policyId || !policyReadyForCompliance || jurisdictions.length === 0 || multiLoading}
              >
                {multiLoading ? "…" : "Multi-jurisdictional"}
              </button>
              <div className="policy-statute-inline">
                <input
                  type="text"
                  value={policyStatuteJurisdiction}
                  onChange={(e) => setPolicyStatuteJurisdiction(e.target.value)}
                  placeholder="Jurisdiction (e.g. CA)"
                  style={{ width: 120 }}
                />
                <button
                  className="ghost-button"
                  type="button"
                  onClick={handleRunPolicyStatute}
                  disabled={!policyId || !policyReadyForCompliance || policyStatuteLoading}
                >
                  {policyStatuteLoading ? "…" : "Policy-statute"}
                </button>
              </div>
            </div>
          </div>
        </div>

        {(gapResult || gapError) && (
          <div className="compliance-result-block">
            <h4>Gap analysis</h4>
            {(gapError || gapResult?.error) && (
              <div className="error-banner">
                <span className="error-text">
                  {gapError || gapResult?.message || gapResult?.error}
                </span>
              </div>
            )}
            {gapResult && !gapResult.error && (
              <GapAnalysisResult
                result={gapResult}
                filteredItems={gapFilteredItems}
                gapFilter={gapFilter}
                onFilterChange={setGapFilter}
              />
            )}
          </div>
        )}

        {(healthResult || healthError) && (
          <div className="compliance-result-block">
            <h4>Health score</h4>
            {healthError && (
              <div className="error-banner">
                <span className="error-text">{healthError}</span>
              </div>
            )}
            {healthResult && (
              <div className="health-score-display">
                <p>
                  Score: {healthScore != null ? healthScore : "—"} / 100
                </p>
                {healthResult.score_breakdown && (
                  <pre>
                    {JSON.stringify(healthResult.score_breakdown, null, 2)}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}

        {(multiResult || multiError) && (
          <div className="compliance-result-block">
            <h4>Multi-jurisdictional</h4>
            {multiError && (
              <div className="error-banner">
                <span className="error-text">{multiError}</span>
              </div>
            )}
            {multiResult && <pre>{JSON.stringify(multiResult, null, 2)}</pre>}
          </div>
        )}

        {(policyStatuteResult || policyStatuteError) && (
          <div className="compliance-result-block">
            <h4>Policy-statute compliance</h4>
            {policyStatuteError && (
              <div className="error-banner">
                <span className="error-text">{policyStatuteError}</span>
              </div>
            )}
            {policyStatuteResult && (
              <>
                {policyStatuteResult.warnings?.length > 0 && (
                  <div className="compliance-warnings">
                    {policyStatuteResult.warnings.map((w, i) => (
                      <p key={i} className="compliance-warning-item">
                        {w}
                      </p>
                    ))}
                  </div>
                )}
                {remediationSuggestions.length > 0 && (
                  <div className="compliance-remediation-panel">
                    <p className="compliance-remediation-title">
                      Remediation recommendations
                    </p>
                    <ol className="compliance-remediation-list">
                      {remediationSuggestions.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ol>
                  </div>
                )}
                <div className="compliance-filters">
                  {(
                    [
                      ["all", "All"],
                      ["compliant", "Compliant"],
                      ["non_compliant", "Non-compliant"],
                      ["neither", "Neither"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={`mode-button ${complianceFilter === value ? "is-active" : ""}`}
                      onClick={() => setComplianceFilter(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="compliance-section-list">
                  {policyStatuteFilteredSections.map((section) => (
                    <ComplianceSectionCard
                      key={section.section_id}
                      section={section}
                      expanded={expandedSectionId === section.section_id}
                      onToggle={() =>
                        setExpandedSectionId(
                          expandedSectionId === section.section_id
                            ? null
                            : section.section_id
                        )
                      }
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </section>
    </>
  );
}

function ComplianceSectionCard({
  section,
  expanded,
  onToggle,
}: {
  section: PolicySectionResult;
  expanded: boolean;
  onToggle: () => void;
}) {
  const primaryStatute =
    section.applied_statutes?.length > 0
      ? [...section.applied_statutes].sort(
          (a, b) => (b.evidence_score ?? 0) - (a.evidence_score ?? 0)
        )[0]
      : null;

  return (
    <article
      className={`result-card compliance-section-card compliance-section-card--${section.compliance}`}
    >
      <div className="result-header">
        <div>
          <h3>
            {primaryStatute
              ? formatStatuteCitation(primaryStatute)
              : section.section_id}
          </h3>
          {primaryStatute?.title && (
            <p className="compliance-statute-description">
              {primaryStatute.title}
            </p>
          )}
        </div>
        <div className="score-stack">
          <span
            className={`score-pill compliance-badge compliance-badge--${section.compliance}`}
          >
            {section.compliance.replace("_", " ")}
          </span>
          <span className="score-caption">
            {formatConfidence(section.confidence)}
          </span>
        </div>
      </div>
      <p className="compliance-rationale-block">
        {section.compliance === "compliant" && "Compliant: "}
        {section.compliance === "non_compliant" && "Non-compliant: "}
        {section.compliance === "neither" &&
          "Neither compliant nor non-compliant: "}
        {section.rationale || "—"}
      </p>
      <p className="compliance-section-preview">
        {truncateAtBoundary(section.section_text || "", 120)}
      </p>
      <button
        type="button"
        className="ghost-button"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        {expanded ? "Hide details" : "Details"}
      </button>
      {expanded && (
        <div className="compliance-section-detail">
          <div className="compliance-section-detail-block">
            <p className="compliance-detail-label">Section text</p>
            <div className="compliance-section-text">
              {section.section_text || "—"}
            </div>
          </div>
          <div className="compliance-section-detail-block">
            <p className="compliance-detail-label">Rationale</p>
            <p>{section.rationale || "—"}</p>
          </div>
          {section.remediation_suggestions?.length > 0 && (
            <div className="compliance-section-detail-block">
              <p className="compliance-detail-label">Remediation suggestions</p>
              <ul>
                {section.remediation_suggestions.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {section.applied_statutes?.length > 0 && (
            <div className="compliance-section-detail-block">
              <p className="compliance-detail-label">Applied statutes</p>
              <div className="applied-statute-list">
                {section.applied_statutes.map((statute, i) => (
                  <div key={i} className="applied-statute">
                    <p className="applied-statute-title">
                      {statute.statute_id} – {statute.title}
                    </p>
                    <p className="applied-statute-meta">
                      {statute.jurisdiction} · Evidence{" "}
                      {formatConfidence(statute.evidence_score)}
                    </p>
                    <blockquote className="applied-statute-span">
                      {statute.matched_span || "—"}
                    </blockquote>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
