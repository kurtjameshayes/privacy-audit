import { useState, useMemo, useEffect, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { apiGet, normalizeApiError } from "../api/client";
import RiskAssessmentResultView from "../components/RiskAssessmentResultView";
import { useDocuments, extractDocumentId } from "../hooks/useDocuments";
import { useWorkflowState, getMissingSteps } from "../hooks/useWorkflowState";
import type { DocumentRecord, RunSummaryItem, RunsListResponse } from "../types/api";
import type {
  PolicyStatuteComplianceResponse,
  PolicySectionResult,
  AppliedStatute,
  GapAnalysisResponse,
  GapItem,
  GapSummary,
} from "../types/api";
import { toGapAnalysisResponse } from "../types/api";
import { GapAnalysisResult } from "../components/GapAnalysisView";
import { InfoIcon } from "../components/Tooltip";
import type { LucideIcon } from "lucide-react";
import {
  ShieldCheck,
  Play,
  CheckCircle2,
  AlertTriangle,
  ChevronRight,
  Settings2,
  ShieldAlert,
  Sparkles,
  Check,
  ChevronDown,
  XCircle,
  X,
  Rocket,
  Search,
  FileBarChart,
  Loader2,
  History,
} from "lucide-react";

const DEFAULT_POLICY_COLLECTION = "policy_legal_embeddings";
type PageTab = "analysis" | "results";
type ComplianceFilter = "all" | "compliant" | "non_compliant" | "neither";
type GapFilter = "all" | "addressed" | "partial" | "ambiguous" | "missing" | "conflict";
type EngineId = "gap" | "health" | "multi" | "policystatute" | "risk";
type ResultTab = "gap" | "health" | "multi" | "policy-statute" | "risk";
type ComplianceJobType = "gap_analysis" | "health_score" | "multi_jurisdictional" | "policy_statute" | "risk_assessment";

const ENGINE_LIST: ReadonlyArray<{ id: EngineId; title: string; desc: string }> = [
  { id: "gap", title: "Gap Analysis", desc: "Identifies missing or deficient clauses compared to statutes." },
  { id: "health", title: "Health Score", desc: "Overall scoring based on key compliance pillars." },
  { id: "multi", title: "Multi-Jurisdictional", desc: "Checks cross-compatibility and strictness conflicts." },
  { id: "policystatute", title: "Policy vs Statute", desc: "1-to-1 strict analysis for a single jurisdiction." },
  { id: "risk", title: "Risk Assessment", desc: "DPIA-style risk assessment with data categories and mitigations." },
];

const RESULT_TAB_LABELS: Record<ResultTab, string> = {
  gap: "Gap Analysis",
  health: "Health Score",
  multi: "Multi-Jurisdictional",
  "policy-statute": "Policy vs Statute",
  risk: "Risk Assessment",
};

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

const GAP_STATUS_CONFIG: Record<
  string,
  { border: string; bg: string; hoverBg: string; titleColor: string; iconColor: string; Icon: LucideIcon; badgeBg: string; badgeText: string; badgeBorder: string; label: string }
> = {
  missing: { border: "border-red-200", bg: "bg-red-50/30", hoverBg: "hover:bg-red-50/50", titleColor: "text-red-800", iconColor: "text-red-500", Icon: ShieldAlert, badgeBg: "bg-red-100", badgeText: "text-red-700", badgeBorder: "border-red-200", label: "MISSING" },
  partial: { border: "border-amber-200", bg: "bg-amber-50/30", hoverBg: "hover:bg-amber-50/50", titleColor: "text-amber-800", iconColor: "text-amber-500", Icon: AlertTriangle, badgeBg: "bg-amber-100", badgeText: "text-amber-700", badgeBorder: "border-amber-200", label: "PARTIAL" },
  ambiguous: { border: "border-slate-200", bg: "bg-slate-50/30", hoverBg: "hover:bg-slate-50/50", titleColor: "text-slate-800", iconColor: "text-slate-500", Icon: AlertTriangle, badgeBg: "bg-slate-100", badgeText: "text-slate-700", badgeBorder: "border-slate-200", label: "AMBIGUOUS" },
  addressed: { border: "border-emerald-200", bg: "bg-emerald-50/30", hoverBg: "hover:bg-emerald-50/50", titleColor: "text-emerald-800", iconColor: "text-emerald-500", Icon: Check, badgeBg: "bg-emerald-100", badgeText: "text-emerald-700", badgeBorder: "border-emerald-200", label: "ADDRESSED" },
  conflict: { border: "border-red-200", bg: "bg-red-50/30", hoverBg: "hover:bg-red-50/50", titleColor: "text-red-800", iconColor: "text-red-500", Icon: ShieldAlert, badgeBg: "bg-red-100", badgeText: "text-red-700", badgeBorder: "border-red-200", label: "CONFLICT" },
};

export default function CompliancePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const policyFromState = (location.state as { policy?: DocumentRecord })?.policy;

  const [pageTab, setPageTab] = useState<PageTab>("analysis");

  const { documents } = useDocuments("policy");

  const [selectedPolicy, setSelectedPolicy] = useState<DocumentRecord | null>(
    policyFromState ?? null
  );
  const [jurisdictionOverride, setJurisdictionOverride] = useState("");
  const [applicabilityLoading, setApplicabilityLoading] = useState(false);
  const [applicabilityError, setApplicabilityError] = useState<string | null>(null);
  const [selectedEngine, setSelectedEngine] = useState<EngineId>("gap");

  const [gapResult, setGapResult] = useState<GapAnalysisResponse | null>(null);
  const [gapLoading, setGapLoading] = useState(false);
  const [gapError, setGapError] = useState<string | null>(null);

  const [healthResult, setHealthResult] = useState<Record<string, unknown> | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);

  const [multiResult, setMultiResult] = useState<Record<string, unknown> | null>(null);
  const [multiLoading, setMultiLoading] = useState(false);
  const [multiError, setMultiError] = useState<string | null>(null);

  const [policyStatuteResult, setPolicyStatuteResult] =
    useState<PolicyStatuteComplianceResponse | null>(null);
  const [policyStatuteLoading, setPolicyStatuteLoading] = useState(false);
  const [policyStatuteError, setPolicyStatuteError] = useState<string | null>(null);
  const [policyStatuteJurisdiction, setPolicyStatuteJurisdiction] = useState("CA");

  const [complianceFilter, setComplianceFilter] = useState<ComplianceFilter>("all");
  const [expandedSectionId, setExpandedSectionId] = useState<string | null>(null);
  const [gapFilter, setGapFilter] = useState<GapFilter>("all");
  const [expandedGapIndex, setExpandedGapIndex] = useState<number | null>(null);
  const [numRows, setNumRows] = useState<string>("");
  const [activeTab, setActiveTab] = useState<ResultTab>("gap");
  const [jobToast, setJobToast] = useState<{ engine: string; jobId: string } | null>(null);
  const [jobSubmitting, setJobSubmitting] = useState(false);
  const [jobSubmitError, setJobSubmitError] = useState<string | null>(null);
  const [pendingJobEngine, setPendingJobEngine] = useState<string | null>(null);

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
    return jurisdictionOverride
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }, [jurisdictionOverride]);

  useEffect(() => {
    if (policyFromState && !selectedPolicy) {
      setSelectedPolicy(policyFromState);
    }
  }, [policyFromState, selectedPolicy]);

  useEffect(() => {
    setApplicabilityError(null);
  }, [policyId]);

  /* ── Handlers ────────────────────────────────────────────── */

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

  const dismissToast = useCallback(() => setJobToast(null), []);

  const handleRunSelected = async () => {
    if (!policyId) return;
    if (selectedEngine === "multi" && jurisdictions.length === 0) {
      setJobSubmitError("Enter jurisdictions (e.g. CA, VA, CO).");
      return;
    }
    if (selectedEngine === "policystatute" && !policyStatuteJurisdiction.trim()) {
      setJobSubmitError("Enter a jurisdiction (e.g. CA).");
      return;
    }

    const engineLabel = ENGINE_LIST.find((e) => e.id === selectedEngine)?.title ?? selectedEngine;
    setJobSubmitting(true);
    setPendingJobEngine(engineLabel);
    setJobSubmitError(null);

    // Clear prior inline results so the panel doesn't imply a fresh completion.
    setGapResult(null);
    setGapError(null);
    setHealthResult(null);
    setHealthError(null);
    setMultiResult(null);
    setMultiError(null);
    setPolicyStatuteResult(null);
    setPolicyStatuteError(null);

    let jobType: ComplianceJobType = "gap_analysis";
    if (selectedEngine === "health") jobType = "health_score";
    if (selectedEngine === "multi") jobType = "multi_jurisdictional";
    if (selectedEngine === "policystatute") jobType = "policy_statute";
    if (selectedEngine === "risk") jobType = "risk_assessment";

    const payload: Record<string, unknown> = {
      job_type: jobType,
      policy_document_id: policyId,
      applicable_jurisdictions: jurisdictions.length > 0 ? jurisdictions : undefined,
    };
    if (selectedEngine === "gap") {
      const n = numRows.trim() ? parseInt(numRows, 10) : undefined;
      if (n !== undefined && !Number.isNaN(n) && n > 0) {
        payload.num_rows = n;
      }
    }
    if (selectedEngine === "policystatute") {
      payload.jurisdiction = policyStatuteJurisdiction.trim();
      payload.policy_collection = DEFAULT_POLICY_COLLECTION;
    }
    if (selectedEngine === "risk") {
      payload.template_id = "default";
      payload.include_report = false;
    }

    try {
      const res = await fetch("/api/compliance/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (res.status === 409) void refetchWorkflow();
        throw new Error(
          (err as { error?: string }).error || res.statusText || "Failed to start job"
        );
      }
      const data = (await res.json()) as { job_id?: string };
      if (!data.job_id) {
        throw new Error("Job started but no job_id was returned.");
      }
      setJobToast({ engine: engineLabel, jobId: data.job_id });
      setPageTab("analysis");
    } catch (err) {
      setJobSubmitError(normalizeApiError(err) || "Failed to start compliance job.");
    } finally {
      setJobSubmitting(false);
      setPendingJobEngine(null);
    }
  };

  /* ── Computed values ─────────────────────────────────────── */

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

  const isSelectedLoading =
    jobSubmitting ||
    (selectedEngine === "gap" && gapLoading) ||
    (selectedEngine === "health" && healthLoading) ||
    (selectedEngine === "multi" && multiLoading) ||
    (selectedEngine === "policystatute" && policyStatuteLoading);

  const isAnyLoading = jobSubmitting || gapLoading || healthLoading || multiLoading || policyStatuteLoading;

  const resultTabs = useMemo(() => {
    const tabs: Array<{ id: ResultTab; label: string }> = [];
    if (gapResult || gapError) tabs.push({ id: "gap", label: "Gap Analysis" });
    if (healthResult || healthError) tabs.push({ id: "health", label: "Health Score" });
    if (multiResult || multiError) tabs.push({ id: "multi", label: "Multi-Jurisdictional" });
    if (policyStatuteResult || policyStatuteError) tabs.push({ id: "policy-statute", label: "Policy vs Statute" });
    return tabs;
  }, [gapResult, gapError, healthResult, healthError, multiResult, multiError, policyStatuteResult, policyStatuteError]);

  const hasAnyResult = resultTabs.length > 0;
  const activeResultTab = resultTabs.find((t) => t.id === activeTab)?.id ?? resultTabs[0]?.id ?? "gap";

  const gapSummary = (gapResult?.summary ?? {}) as GapSummary;
  const policyLabel = selectedPolicy?.title || selectedPolicy?.company_name || policyId || "—";

  return (
    <div className="p-8 max-w-7xl mx-auto w-full">
      {/* Job started toast */}
      {jobToast && (
        <JobStartedToast
          engine={jobToast.engine}
          jobId={jobToast.jobId}
          onDismiss={dismissToast}
        />
      )}

      {/* Page header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          Compliance Analysis
          <InfoIcon content="Compare a selected corporate privacy policy against one or more statutes to evaluate compliance using AI-driven engines." />
        </h1>
        <p className="text-slate-500 mt-1 text-sm">
          Run automated compliance engines to detect gaps and calculate health scores.
        </p>
      </div>

      {/* Page-level tabs */}
      <div className="flex space-x-1 mb-8">
        {([
          { id: "analysis" as PageTab, label: "Analysis", icon: Play },
          { id: "results" as PageTab, label: "Results", icon: FileBarChart },
        ]).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setPageTab(tab.id)}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold transition-all ${
              pageTab === tab.id
                ? "bg-indigo-600 text-white shadow-sm"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-100 border border-transparent"
            }`}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Results Tab ────────────────────────────────────── */}
      {pageTab === "results" && (
        <ResultsBrowser policies={policyOptions} />
      )}

      {/* ── Analysis Tab ───────────────────────────────────── */}
      {pageTab === "analysis" && <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
        {/* ── Setup Column ─────────────────────────────────── */}
        <div className="xl:col-span-1 space-y-6">
          {/* Card 1: Setup Configuration */}
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
            <h2 className="text-lg font-semibold text-slate-800 mb-5 flex items-center gap-2">
              <Settings2 className="h-5 w-5 text-indigo-500" />
              1. Setup Configuration
            </h2>

            <div className="space-y-5">
              {/* Policy selector */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  Target Policy
                </label>
                <select
                  value={policyId || ""}
                  onChange={(e) => {
                    const id = e.target.value;
                    const opt = policyOptions.find((p) => p.id === id);
                    setSelectedPolicy(opt?.doc ?? null);
                  }}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 bg-white shadow-sm transition-all"
                >
                  <option value="">Select a policy…</option>
                  {policyOptions.map(({ doc, id }) => (
                    <option key={id} value={id}>
                      {doc.title || doc.company_name || id}
                    </option>
                  ))}
                </select>

                {policyId && policyReadyForCompliance && (
                  <div className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-50 border border-emerald-100 text-xs font-medium text-emerald-700">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Fully Indexed
                  </div>
                )}

                {policyId && !policyReadyForCompliance && (
                  <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
                    <p className="font-medium">Policy not ready for compliance</p>
                    <p className="text-xs mt-1">
                      Complete these steps: {missingSteps.join(", ")}.
                    </p>
                    <div className="flex items-center gap-3 mt-2">
                      <button
                        type="button"
                        className="text-xs font-semibold text-amber-700 hover:underline"
                        onClick={() => void refetchWorkflow()}
                      >
                        Refresh status
                      </button>
                      <button
                        type="button"
                        className="text-xs font-semibold text-indigo-600 hover:underline"
                        onClick={() => navigate("/policies")}
                      >
                        Browse policies
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Jurisdictions */}
              <div>
                <label className="text-sm font-medium text-slate-700 mb-1.5 flex items-center justify-between">
                  <span>Jurisdictions</span>
                  <button
                    type="button"
                    className="text-indigo-600 text-xs font-semibold hover:underline flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={() => void handleSuggestJurisdictions()}
                    disabled={!policyId || !policyReadyForCompliance || applicabilityLoading}
                  >
                    <Sparkles className="h-3 w-3" />
                    {applicabilityLoading ? "Inferring…" : "Auto-infer"}
                  </button>
                </label>
                <input
                  type="text"
                  value={jurisdictionOverride}
                  onChange={(e) => setJurisdictionOverride(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 shadow-sm transition-all"
                  placeholder="e.g. CA, VA, CO"
                />
                <p className="text-xs text-slate-500 mt-2">
                  Comma-separated regions to test against. Statutes must be indexed in library.
                </p>
                {applicabilityError && (
                  <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
                    {applicabilityError}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Card 2: Select Engine */}
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
            <h2 className="text-lg font-semibold text-slate-800 mb-5 flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-indigo-500" />
              2. Select Engine
            </h2>

            <div className="space-y-3">
              {ENGINE_LIST.map((engine) => (
                <div
                  key={engine.id}
                  onClick={() => setSelectedEngine(engine.id)}
                  className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
                    selectedEngine === engine.id
                      ? "border-indigo-500 bg-indigo-50/50 shadow-sm"
                      : "border-slate-100 hover:border-indigo-200 hover:bg-slate-50"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className={`font-semibold text-sm ${selectedEngine === engine.id ? "text-indigo-900" : "text-slate-800"}`}>
                      {engine.title}
                    </span>
                    <div className={`h-4 w-4 rounded-full border flex items-center justify-center ${selectedEngine === engine.id ? "border-indigo-600" : "border-slate-300"}`}>
                      {selectedEngine === engine.id && <div className="h-2 w-2 rounded-full bg-indigo-600" />}
                    </div>
                  </div>
                  <p className="text-xs text-slate-500 leading-relaxed">{engine.desc}</p>
                </div>
              ))}
            </div>

            {/* Engine-specific options */}
            {selectedEngine === "gap" && (
              <div className="mt-5 pt-5 border-t border-slate-100">
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  Number of rows
                </label>
                <input
                  type="number"
                  min={1}
                  value={numRows}
                  onChange={(e) => setNumRows(e.target.value)}
                  placeholder="e.g. 50 (optional)"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 shadow-sm transition-all"
                />
              </div>
            )}
            {selectedEngine === "policystatute" && (
              <div className="mt-5 pt-5 border-t border-slate-100">
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  Jurisdiction
                </label>
                <input
                  type="text"
                  value={policyStatuteJurisdiction}
                  onChange={(e) => setPolicyStatuteJurisdiction(e.target.value)}
                  placeholder="e.g. CA"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 shadow-sm transition-all"
                />
              </div>
            )}

            {/* Run button */}
            <div className="mt-6 pt-6 border-t border-slate-100">
              <button
                type="button"
                onClick={() => void handleRunSelected()}
                disabled={!policyId || !policyReadyForCompliance || isSelectedLoading}
                className="w-full flex items-center justify-center gap-2 bg-indigo-600 text-white rounded-lg px-4 py-3 text-sm font-semibold hover:bg-indigo-700 disabled:opacity-70 disabled:cursor-not-allowed shadow-sm transition-all"
              >
                {isSelectedLoading ? (
                  <span className="flex items-center gap-2 animate-pulse">
                    <Sparkles className="h-4 w-4" /> {jobSubmitting ? "Starting job…" : "Analyzing Policy…"}
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <Play className="h-4 w-4 fill-current" /> Run Selected Engine
                  </span>
                )}
              </button>
              {isAnyLoading && !isSelectedLoading && (
                <p className="text-xs text-slate-500 mt-2 text-center animate-pulse">
                  {jobSubmitting && `Starting ${pendingJobEngine || "compliance"} job…`}
                  {gapLoading && "Running gap analysis…"}
                  {healthLoading && "Running health score…"}
                  {multiLoading && "Running multi-jurisdictional…"}
                  {policyStatuteLoading && "Running policy-statute…"}
                </p>
              )}
              {jobSubmitError && (
                <div className="mt-3 p-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
                  {jobSubmitError}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Results Column ───────────────────────────────── */}
        <div className="xl:col-span-2">
          {hasAnyResult ? (
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex flex-col">
              {/* Tabs + header */}
              <div className="bg-slate-50 border-b border-slate-200 px-6 py-4">
                {resultTabs.length > 1 && (
                  <div className="flex space-x-1 mb-4">
                    {resultTabs.map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setActiveTab(tab.id)}
                        className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                          activeResultTab === tab.id
                            ? "bg-indigo-600 text-white"
                            : "text-slate-600 hover:bg-slate-200"
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap justify-between items-center gap-4">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">
                      {RESULT_TAB_LABELS[activeResultTab]} Results
                    </h2>
                    <p className="text-sm text-slate-500 font-medium">
                      {policyLabel}
                      {jurisdictions.length > 0 && ` vs ${jurisdictions.join(", ")}`}
                    </p>
                  </div>
                </div>
              </div>

              {/* Result content */}
              <div className="p-6 flex-1 overflow-y-auto">
                {/* ─ Gap Analysis ─ */}
                {activeResultTab === "gap" && (
                  <>
                    {(gapError || gapResult?.error) && (
                      <ErrorBanner message={gapError || gapResult?.message || gapResult?.error || "Gap analysis failed."} />
                    )}
                    {gapResult && !gapResult.error && (
                      <>
                        {/* Summary badges */}
                        <div className="flex flex-wrap gap-3 mb-6 pb-5 border-b border-slate-100">
                          <SummaryBadge color="red" count={gapSummary.missing ?? 0} label="Missing" />
                          <SummaryBadge color="amber" count={gapSummary.partial ?? 0} label="Partial" />
                          <SummaryBadge color="slate" count={gapSummary.ambiguous ?? 0} label="Ambiguous" />
                          <SummaryBadge color="emerald" count={gapSummary.addressed ?? 0} label="Addressed" />
                          <SummaryBadge color="red" count={gapSummary.conflicts ?? 0} label="Conflicts" />
                        </div>

                        {/* Filters */}
                        <div className="flex flex-wrap gap-2 mb-5">
                          {(
                            [
                              ["all", "All"],
                              ["addressed", "Addressed"],
                              ["partial", "Partial"],
                              ["ambiguous", "Ambiguous"],
                              ["missing", "Missing"],
                              ["conflict", "Conflicts"],
                            ] as const
                          ).map(([value, label]) => (
                            <button
                              key={value}
                              type="button"
                              onClick={() => setGapFilter(value)}
                              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                                gapFilter === value
                                  ? "bg-indigo-600 text-white"
                                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                              }`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>

                        {/* Gap items */}
                        <div className="space-y-4">
                          {gapFilteredItems.length === 0 ? (
                            <p className="text-sm text-slate-500 py-4 text-center">
                              {(gapResult.gaps?.length ?? 0) === 0
                                ? "No gaps found. All requirements are addressed."
                                : `No ${gapFilter === "all" ? "" : gapFilter + " "}gaps match the filter.`}
                            </p>
                          ) : (
                            gapFilteredItems.map((gap, i) => (
                              <GapItemCardTW
                                key={i}
                                gap={gap}
                                expanded={expandedGapIndex === i}
                                onToggle={() => setExpandedGapIndex(expandedGapIndex === i ? null : i)}
                              />
                            ))
                          )}
                        </div>
                      </>
                    )}
                  </>
                )}

                {/* ─ Health Score ─ */}
                {activeResultTab === "health" && (
                  <>
                    {healthError && <ErrorBanner message={healthError} />}
                    {healthResult && (
                      <div className="space-y-6">
                        {/* Score display */}
                        <div className="flex items-end gap-3 pb-5 border-b border-slate-100">
                          <span className="text-5xl font-bold text-slate-900">
                            {healthScore != null ? healthScore : "—"}
                          </span>
                          <span className="text-xl text-slate-400 mb-1">/ 100</span>
                        </div>

                        {/* Components */}
                        {healthResult.components && typeof healthResult.components === "object" && (
                          <div>
                            <h3 className="text-sm font-semibold text-slate-700 mb-3">Components</h3>
                            <div className="grid grid-cols-2 gap-3">
                              {Object.entries(healthResult.components as Record<string, unknown>).map(([k, v]) => (
                                <div key={k} className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                                  <p className="text-xs text-slate-500 capitalize">{k.replace(/_/g, " ")}</p>
                                  <p className="text-sm font-semibold text-slate-800 mt-0.5">
                                    {typeof v === "boolean" ? (v ? "Yes" : "No") : String(v)}
                                  </p>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Score breakdown */}
                        {healthResult.score_breakdown && typeof healthResult.score_breakdown === "object" && (
                          <div>
                            <h3 className="text-sm font-semibold text-slate-700 mb-3">Score Breakdown</h3>
                            {Object.entries(healthResult.score_breakdown as Record<string, unknown>).map(([sectionKey, sectionVal]) => {
                              if (typeof sectionVal !== "object" || sectionVal === null || Array.isArray(sectionVal)) return null;
                              const entries = Object.entries(sectionVal as Record<string, unknown>);
                              if (entries.length === 0) return null;
                              const sectionLabel = sectionKey === "by_jurisdiction" ? "By jurisdiction" : sectionKey === "by_category" ? "By category" : sectionKey.replace(/_/g, " ");
                              return (
                                <div key={sectionKey} className="mb-4">
                                  <p className="text-xs font-medium text-slate-500 mb-2 uppercase tracking-wider">{sectionLabel}</p>
                                  <div className="overflow-x-auto">
                                    <table className="min-w-full text-sm">
                                      <tbody className="divide-y divide-slate-100">
                                        {entries.map(([k, v]) => (
                                          <tr key={k}>
                                            <td className="py-2 pr-4 text-slate-600 capitalize">{k.replace(/_/g, " ")}</td>
                                            <td className="py-2 font-medium text-slate-800">{String(v)}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}

                {/* ─ Multi-Jurisdictional ─ */}
                {activeResultTab === "multi" && (
                  <>
                    {multiError && <ErrorBanner message={multiError} />}
                    {multiResult && (
                      <div className="space-y-6">
                        {multiResult.applicable_jurisdictions && Array.isArray(multiResult.applicable_jurisdictions) && (
                          <div className="flex flex-wrap gap-2 pb-5 border-b border-slate-100">
                            {(multiResult.applicable_jurisdictions as string[]).map((j) => (
                              <span key={j} className="px-3 py-1.5 bg-indigo-50 text-indigo-700 rounded-lg text-xs font-semibold border border-indigo-100">
                                {j}
                              </span>
                            ))}
                          </div>
                        )}

                        {multiResult.strictest_common_denominator && Array.isArray(multiResult.strictest_common_denominator) && (
                          <div>
                            <h3 className="text-sm font-semibold text-slate-700 mb-3">Strictest Common Denominator</h3>
                            <div className="overflow-x-auto rounded-lg border border-slate-200">
                              <table className="min-w-full text-sm divide-y divide-slate-200">
                                <thead className="bg-slate-50">
                                  <tr>
                                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Requirement</th>
                                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Jurisdiction</th>
                                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Policy alignment</th>
                                  </tr>
                                </thead>
                                <tbody className="bg-white divide-y divide-slate-100">
                                  {(multiResult.strictest_common_denominator as Record<string, unknown>[]).map((r, i) => (
                                    <tr key={i} className="hover:bg-slate-50">
                                      <td className="px-4 py-3 text-slate-700">{String(r.label ?? r.canonical_requirement_id ?? "—")}</td>
                                      <td className="px-4 py-3 text-slate-600">{String(r.strictest_jurisdiction ?? "—")}</td>
                                      <td className="px-4 py-3 text-slate-600">{String(r.policy_alignment ?? "—")}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}

                        {multiResult.conflicts_between_jurisdictions && Array.isArray(multiResult.conflicts_between_jurisdictions) && (multiResult.conflicts_between_jurisdictions as unknown[]).length > 0 && (
                          <div>
                            <h3 className="text-sm font-semibold text-slate-700 mb-3">Conflicts Between Jurisdictions</h3>
                            <div className="space-y-2">
                              {(multiResult.conflicts_between_jurisdictions as Record<string, unknown>[]).map((c, i) => (
                                <div key={i} className="p-3 bg-red-50/30 border border-red-200 rounded-lg text-sm text-red-800">
                                  {typeof c === "object" && c !== null
                                    ? Object.entries(c)
                                        .map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v)}`)
                                        .join(" — ")
                                    : String(c)}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}

                {/* ─ Policy-Statute ─ */}
                {activeResultTab === "policy-statute" && (
                  <>
                    {policyStatuteError && <ErrorBanner message={policyStatuteError} />}
                    {policyStatuteResult && (
                      <div className="space-y-5">
                        {/* Overall summary */}
                        <div className="flex flex-wrap gap-3 pb-5 border-b border-slate-100">
                          <SummaryBadge color="emerald" count={policyStatuteResult.summary.counts.compliant} label="Compliant" />
                          <SummaryBadge color="red" count={policyStatuteResult.summary.counts.non_compliant} label="Non-compliant" />
                          <SummaryBadge color="slate" count={policyStatuteResult.summary.counts.neither} label="Neither" />
                          <div className={`ml-auto px-4 py-2 rounded-lg text-sm font-bold ${
                            policyStatuteResult.summary.overall_compliance === "compliant"
                              ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                              : policyStatuteResult.summary.overall_compliance === "non_compliant"
                                ? "bg-red-100 text-red-800 border border-red-200"
                                : "bg-amber-100 text-amber-800 border border-amber-200"
                          }`}>
                            Overall: {policyStatuteResult.summary.overall_compliance.replace("_", " ")}
                          </div>
                        </div>

                        {/* Warnings */}
                        {policyStatuteResult.warnings?.length > 0 && (
                          <div className="space-y-2">
                            {policyStatuteResult.warnings.map((w, i) => (
                              <div key={i} className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800 flex items-start gap-2">
                                <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                                {w}
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Remediation suggestions */}
                        {remediationSuggestions.length > 0 && (
                          <div className="p-4 bg-indigo-50/50 border border-indigo-200 rounded-xl">
                            <p className="text-sm font-semibold text-indigo-800 mb-2">Remediation Recommendations</p>
                            <ol className="list-decimal list-inside space-y-1">
                              {remediationSuggestions.map((s, i) => (
                                <li key={i} className="text-sm text-indigo-700">{s}</li>
                              ))}
                            </ol>
                          </div>
                        )}

                        {/* Filters */}
                        <div className="flex flex-wrap gap-2">
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
                              onClick={() => setComplianceFilter(value)}
                              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                                complianceFilter === value
                                  ? "bg-indigo-600 text-white"
                                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                              }`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>

                        {/* Sections */}
                        <div className="space-y-3">
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
                      </div>
                    )}
                  </>
                )}

              </div>
            </div>
          ) : (
            /* Empty state */
            <div className="bg-white border-2 border-dashed border-slate-200 rounded-xl h-full min-h-[500px] flex flex-col items-center justify-center text-slate-400 p-8">
              <div className="w-20 h-20 bg-slate-50 rounded-full flex items-center justify-center mb-4">
                <ShieldCheck className="h-10 w-10 text-slate-300" />
              </div>
              <p className="font-semibold text-slate-600 text-lg">Ready to Analyze</p>
              <p className="text-sm max-w-sm text-center mt-2 leading-relaxed">
                Configure your analysis on the left and click{" "}
                <span className="font-semibold text-slate-500">"Run Selected Engine"</span>{" "}
                to execute the compliance checks against indexed statutes.
              </p>
            </div>
          )}
        </div>
      </div>}
    </div>
  );
}

/* ── Results Browser ───────────────────────────────────────────────── */

const RESULTS_TYPE_OPTIONS = [
  { value: "gap_analysis", label: "Gap Analysis" },
  { value: "health_score", label: "Health Score" },
  { value: "risk_assessment", label: "Risk Assessment" },
  { value: "gap_v4", label: "Gap v4" },
  { value: "regulatory_drift", label: "Regulatory Drift" },
] as const;

function ResultsBrowser({
  policies,
}: {
  policies: Array<{ doc: DocumentRecord; id: string }>;
}) {
  const [policyId, setPolicyId] = useState("");
  const [analysisType, setAnalysisType] = useState("gap_analysis");

  const [runs, setRuns] = useState<RunSummaryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<Record<string, unknown> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [gapFilter, setGapFilter] = useState<GapFilter>("all");
  const [expandedGapIndex, setExpandedGapIndex] = useState<number | null>(null);

  const fetchResults = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSelectedRunId(null);
    setRunDetail(null);
    setSearched(true);
    try {
      const params: Record<string, string> = {
        limit: "50",
        offset: "0",
        types: analysisType,
      };
      if (policyId) params.policy_document_id = policyId;
      const result = await apiGet<RunsListResponse>("/api/compliance/runs", params);
      setRuns(result.runs ?? []);
    } catch (err) {
      setError(normalizeApiError(err));
    } finally {
      setLoading(false);
    }
  }, [policyId, analysisType]);

  useEffect(() => {
    if (!selectedRunId) { setRunDetail(null); return; }
    const load = async () => {
      setDetailLoading(true);
      try {
        const result = await apiGet<Record<string, unknown>>(
          `/api/compliance/runs/${selectedRunId}`, {}
        );
        setRunDetail(result);
        setGapFilter("all");
        setExpandedGapIndex(null);
      } catch {
        setRunDetail(null);
      } finally {
        setDetailLoading(false);
      }
    };
    void load();
  }, [selectedRunId]);

  const gapResult = useMemo(
    () => toGapAnalysisResponse(runDetail as any),
    [runDetail]
  );

  const gapFilteredItems = useMemo(() => {
    const gaps = gapResult?.gaps ?? [];
    if (gapFilter === "all") return gaps;
    return gaps.filter((g) => g.status === gapFilter);
  }, [gapResult?.gaps, gapFilter]);

  const healthResult = useMemo(() => {
    if (!runDetail) return null;
    const res = (runDetail.result ?? runDetail) as Record<string, unknown>;
    if (res.privacy_health_score != null) return res;
    return null;
  }, [runDetail]);

  const riskResult = useMemo(() => {
    if (!runDetail) return null;
    const jobType = runDetail.job_type as string | undefined;
    if (jobType !== "risk_assessment") return null;
    const res = (runDetail.result ?? runDetail) as Record<string, unknown>;
    if (res.assessment || res.report) return res;
    return null;
  }, [runDetail]);

  const policyLabel = useMemo(() => {
    if (!policyId) return "";
    const match = policies.find((p) => p.id === policyId);
    return match?.doc.title || match?.doc.company_name || policyId;
  }, [policyId, policies]);

  return (
    <div className="space-y-6">
      {/* Filters row */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
        <h2 className="text-lg font-semibold text-slate-800 mb-5 flex items-center gap-2">
          <Search className="h-5 w-5 text-indigo-500" />
          Browse Existing Results
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Policy</label>
            <select
              value={policyId}
              onChange={(e) => setPolicyId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 bg-white shadow-sm"
            >
              <option value="">All policies</option>
              {policies.map(({ doc, id }) => (
                <option key={id} value={id}>
                  {doc.title || doc.company_name || id}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Analysis Type</label>
            <select
              value={analysisType}
              onChange={(e) => setAnalysisType(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 bg-white shadow-sm"
            >
              {RESULTS_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => void fetchResults()}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 bg-indigo-600 text-white rounded-lg px-4 py-2.5 text-sm font-semibold hover:bg-indigo-700 disabled:opacity-70 disabled:cursor-not-allowed shadow-sm transition-all"
            >
              {loading ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Searching…</>
              ) : (
                <><Search className="h-4 w-4" /> Search Results</>
              )}
            </button>
          </div>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {/* Results list / detail */}
      {searched && !loading && !error && runs.length === 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-12 text-center">
          <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <History className="h-8 w-8 text-slate-300" />
          </div>
          <p className="font-semibold text-slate-700">No results found</p>
          <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
            No existing {RESULTS_TYPE_OPTIONS.find((o) => o.value === analysisType)?.label ?? analysisType} results
            {policyLabel ? ` for "${policyLabel}"` : ""}.
            Run an analysis first from the Analysis tab.
          </p>
        </div>
      )}

      {runs.length > 0 && !selectedRunId && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 bg-slate-50 border-b border-slate-200">
            <p className="text-sm font-semibold text-slate-700">
              {runs.length} result{runs.length !== 1 ? "s" : ""} found
              <span className="font-normal text-slate-500 ml-1">(most recent first)</span>
            </p>
          </div>
          <div className="divide-y divide-slate-100">
            {runs.map((run) => {
              const id = run.run_id ?? run.job_id ?? "";
              const score = run.privacy_health_score;
              const s = run.summary;
              const dateVal = run.run_at ?? run.created_at ?? run.completed_at;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSelectedRunId(id)}
                  className="w-full text-left px-6 py-4 hover:bg-slate-50 transition-colors flex items-center justify-between group"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-900 group-hover:text-indigo-600 transition-colors truncate">
                      {run.company_name || run.policy_document_id || "—"}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {dateVal ? new Date(dateVal).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—"}
                      {run.policy_document_id && <span className="font-mono ml-2">{run.policy_document_id.slice(0, 12)}…</span>}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 ml-4 flex-shrink-0">
                    {score != null && (
                      <span className={`text-lg font-bold ${score >= 80 ? "text-emerald-600" : score >= 50 ? "text-amber-600" : "text-red-600"}`}>
                        {score}/100
                      </span>
                    )}
                    {s && s.total_requirements != null && s.total_requirements > 0 && (
                      <div className="flex gap-1.5">
                        {(s.addressed ?? 0) > 0 && <span className="text-xs font-semibold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-100">{s.addressed} addr</span>}
                        {(s.missing ?? 0) > 0 && <span className="text-xs font-semibold px-2 py-0.5 rounded bg-red-50 text-red-700 border border-red-100">{s.missing} miss</span>}
                        {(s.conflicts ?? 0) > 0 && <span className="text-xs font-semibold px-2 py-0.5 rounded bg-red-50 text-red-700 border border-red-100">{s.conflicts} conf</span>}
                      </div>
                    )}
                    <ChevronRight className="h-4 w-4 text-slate-400 group-hover:text-indigo-500 transition-colors" />
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Inline detail view */}
      {selectedRunId && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setSelectedRunId(null)}
              className="text-sm font-semibold text-indigo-600 hover:text-indigo-800 flex items-center gap-1"
            >
              <ChevronRight className="h-4 w-4 rotate-180" /> Back to results
            </button>
            <span className="text-xs text-slate-500 font-mono">{selectedRunId.slice(0, 16)}…</span>
          </div>
          <div className="p-6">
            {detailLoading ? (
              <div className="flex flex-col items-center justify-center py-12 text-slate-500">
                <Loader2 className="h-8 w-8 animate-spin text-slate-300 mb-3" />
                <p className="font-medium">Loading result…</p>
              </div>
            ) : runDetail ? (
              <div className="space-y-5">
                {gapResult ? (
                  <GapAnalysisResult
                    result={gapResult}
                    filteredItems={gapFilteredItems}
                    gapFilter={gapFilter}
                    onFilterChange={setGapFilter}
                    expandedGapIndex={expandedGapIndex}
                    onExpandGap={setExpandedGapIndex}
                  />
                ) : riskResult ? (
                  <RiskAssessmentResultView result={riskResult} />
                ) : healthResult ? (
                  <div className="space-y-6">
                    <div className="flex items-end gap-3 pb-5 border-b border-slate-100">
                      <span className="text-5xl font-bold text-slate-900">
                        {healthResult.privacy_health_score != null ? String(healthResult.privacy_health_score) : "—"}
                      </span>
                      <span className="text-xl text-slate-400 mb-1">/ 100</span>
                    </div>
                    {healthResult.components && typeof healthResult.components === "object" && (
                      <div>
                        <h3 className="text-sm font-semibold text-slate-700 mb-3">Components</h3>
                        <div className="grid grid-cols-2 gap-3">
                          {Object.entries(healthResult.components as Record<string, unknown>).map(([k, v]) => (
                            <div key={k} className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                              <p className="text-xs text-slate-500 capitalize">{k.replace(/_/g, " ")}</p>
                              <p className="text-sm font-semibold text-slate-800 mt-0.5">
                                {typeof v === "boolean" ? (v ? "Yes" : "No") : String(v)}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {healthResult.score_breakdown && typeof healthResult.score_breakdown === "object" && (
                      <div>
                        <h3 className="text-sm font-semibold text-slate-700 mb-3">Score Breakdown</h3>
                        {Object.entries(healthResult.score_breakdown as Record<string, unknown>).map(([sectionKey, sectionVal]) => {
                          if (typeof sectionVal !== "object" || sectionVal === null || Array.isArray(sectionVal)) return null;
                          const entries = Object.entries(sectionVal as Record<string, unknown>);
                          if (entries.length === 0) return null;
                          const sectionLabel = sectionKey === "by_jurisdiction" ? "By jurisdiction" : sectionKey === "by_category" ? "By category" : sectionKey.replace(/_/g, " ");
                          return (
                            <div key={sectionKey} className="mb-4">
                              <p className="text-xs font-medium text-slate-500 mb-2 uppercase tracking-wider">{sectionLabel}</p>
                              <div className="overflow-x-auto">
                                <table className="min-w-full text-sm">
                                  <tbody className="divide-y divide-slate-100">
                                    {entries.map(([k, v]) => (
                                      <tr key={k}>
                                        <td className="py-2 pr-4 text-slate-600 capitalize">{k.replace(/_/g, " ")}</td>
                                        <td className="py-2 font-medium text-slate-800">{String(v)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-center py-8 text-slate-500">
                    <p className="font-medium">Raw result data</p>
                    <pre className="mt-4 text-xs bg-slate-900 text-emerald-400 p-4 rounded-lg overflow-x-auto max-h-[50vh] text-left">
                      {JSON.stringify(runDetail, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-slate-500 text-center py-8">Failed to load result.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Summary badge sub-component ───────────────────────────────────── */

const BADGE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  red: { bg: "bg-red-50", text: "text-red-700", border: "border-red-100" },
  amber: { bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-100" },
  emerald: { bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-100" },
  slate: { bg: "bg-slate-100", text: "text-slate-700", border: "border-slate-200" },
};

function SummaryBadge({ color, count, label }: { color: string; count: number; label: string }) {
  const c = BADGE_COLORS[color] ?? BADGE_COLORS.slate;
  return (
    <div className={`px-4 py-2 ${c.bg} ${c.text} rounded-lg border ${c.border} flex items-center gap-2 shadow-sm`}>
      <span className="text-xl font-bold">{count}</span>
      <span className="text-xs font-semibold uppercase tracking-wider">{label}</span>
    </div>
  );
}

/* ── Error banner sub-component ────────────────────────────────────── */

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2 mb-5">
      <XCircle className="h-5 w-5 text-red-500 mt-0.5 flex-shrink-0" />
      <p className="text-sm text-red-800">{message}</p>
    </div>
  );
}

/* ── Job started toast ─────────────────────────────────────────────── */

function JobStartedToast({
  engine,
  jobId,
  onDismiss,
}: {
  engine: string;
  jobId: string;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 6000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div className="fixed top-6 right-6 z-50 animate-in fade-in slide-in-from-top-2 duration-300">
      <div className="bg-white rounded-xl shadow-lg border border-slate-200 p-4 pr-10 min-w-[340px] relative overflow-hidden">
        <button
          type="button"
          onClick={onDismiss}
          className="absolute top-3 right-3 text-slate-400 hover:text-slate-600 transition-colors"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
            <Rocket className="h-4.5 w-4.5 text-indigo-600" />
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-slate-900 text-sm">Compliance job started</p>
            <p className="text-xs text-slate-500 mt-0.5">{engine}</p>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs font-mono bg-slate-100 text-slate-700 px-2 py-1 rounded border border-slate-200">
                {jobId}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Gap item card (Tailwind) ──────────────────────────────────────── */

function GapItemCardTW({
  gap,
  expanded,
  onToggle,
}: {
  gap: GapItem;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const status = gap.analysis_failed ? "missing" : gap.status ?? "missing";
  const config = GAP_STATUS_CONFIG[status] || GAP_STATUS_CONFIG.missing;
  const { Icon } = config;

  const description = gap.policy_quote || gap.statute_quote || gap.conflict_description || "";
  const statuteRef = [gap.jurisdiction, gap.statute_reference || gap.statute_name || gap.section]
    .filter(Boolean)
    .join(" — ");

  const hasExpandable = gap.policy_quote || gap.statute_quote || gap.conflict_description || gap.policy_subchunk_text || gap.statute_subchunk_text;

  return (
    <div
      className={`border ${config.border} rounded-xl p-5 ${config.bg} ${config.hoverBg} transition-colors group ${
        status === "addressed" ? "opacity-70 hover:opacity-100" : ""
      }`}
    >
      <div className="flex justify-between items-start mb-3">
        <div className={`flex items-center gap-2.5 ${config.titleColor} font-semibold text-base`}>
          <Icon className={`h-5 w-5 ${config.iconColor} flex-shrink-0`} />
          <span>{gap.requirement_summary || "—"}</span>
        </div>
        <span className={`text-xs font-bold px-2.5 py-1 ${config.badgeBg} ${config.badgeText} rounded-md border ${config.badgeBorder} shadow-sm whitespace-nowrap ml-3`}>
          {gap.analysis_failed ? "FAILED" : config.label}
        </span>
      </div>

      {description && (
        <p className="text-sm text-slate-700 mb-4 leading-relaxed">{description}</p>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {statuteRef && (
          <span className="text-xs font-medium text-slate-500 bg-white border border-slate-200 px-2 py-1 rounded">
            {statuteRef}
          </span>
        )}
        {gap.confidence && (
          <span className="text-xs font-medium text-slate-500 bg-white border border-slate-200 px-2 py-1 rounded">
            Confidence: {gap.confidence}
          </span>
        )}
        {hasExpandable && onToggle && (
          <button
            type="button"
            className="text-sm font-semibold text-indigo-600 hover:text-indigo-800 flex items-center ml-auto group-hover:underline"
            onClick={onToggle}
          >
            {expanded ? "Hide details" : "View details"}
            <ChevronRight className={`h-4 w-4 transition-transform ${expanded ? "rotate-90" : ""}`} />
          </button>
        )}
      </div>

      {expanded && hasExpandable && (
        <div className="mt-4 pt-4 border-t border-slate-200/50 space-y-3">
          {gap.policy_quote && (
            <div>
              <p className="text-xs font-semibold text-slate-500 mb-1">Policy quote</p>
              <blockquote className="text-sm text-slate-600 bg-white/60 border-l-2 border-slate-300 pl-3 py-1 rounded-r">
                {gap.policy_quote}
              </blockquote>
            </div>
          )}
          {(gap.statute_name || gap.section || gap.statute_reference) && (
            <div>
              <p className="text-xs font-semibold text-slate-500 mb-1">Statute</p>
              <p className="text-sm text-slate-600">
                {[gap.section, gap.statute_reference, gap.statute_name]
                  .filter(Boolean)
                  .filter((v, i, arr) => arr.indexOf(v) === i)
                  .join(" · ")}
              </p>
            </div>
          )}
          {gap.statute_quote && (
            <div>
              <p className="text-xs font-semibold text-slate-500 mb-1">Statute requirement</p>
              <blockquote className="text-sm text-slate-600 bg-white/60 border-l-2 border-slate-300 pl-3 py-1 rounded-r">
                {gap.statute_quote}
              </blockquote>
            </div>
          )}
          {gap.conflict_description && (
            <div>
              <p className="text-xs font-semibold text-slate-500 mb-1">Conflict</p>
              <p className="text-sm text-slate-700">{gap.conflict_description}</p>
            </div>
          )}
          {gap.statute_subchunk_text && (
            <div>
              <p className="text-xs font-semibold text-slate-500 mb-1">Statute context</p>
              <div className="text-sm text-slate-600 bg-white/60 p-3 rounded border border-slate-200 max-h-40 overflow-y-auto whitespace-pre-wrap">
                {gap.statute_subchunk_text}
              </div>
            </div>
          )}
          {gap.policy_subchunk_text && (
            <div>
              <p className="text-xs font-semibold text-slate-500 mb-1">Policy context</p>
              <div className="text-sm text-slate-600 bg-white/60 p-3 rounded border border-slate-200 max-h-40 overflow-y-auto whitespace-pre-wrap">
                {gap.policy_subchunk_text}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Compliance Section Card (policy-statute results) ──────────────── */

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

  const complianceConfig: Record<string, { border: string; bg: string; badgeBg: string; badgeText: string; badgeBorder: string; label: string }> = {
    compliant: { border: "border-emerald-200", bg: "bg-emerald-50/30", badgeBg: "bg-emerald-100", badgeText: "text-emerald-700", badgeBorder: "border-emerald-200", label: "Compliant" },
    non_compliant: { border: "border-red-200", bg: "bg-red-50/30", badgeBg: "bg-red-100", badgeText: "text-red-700", badgeBorder: "border-red-200", label: "Non-compliant" },
    neither: { border: "border-slate-200", bg: "bg-slate-50/30", badgeBg: "bg-slate-100", badgeText: "text-slate-700", badgeBorder: "border-slate-200", label: "Neither" },
  };

  const cfg = complianceConfig[section.compliance] ?? complianceConfig.neither;

  return (
    <div className={`border ${cfg.border} rounded-xl p-5 ${cfg.bg} hover:shadow-sm transition-all`}>
      <div className="flex justify-between items-start mb-2">
        <div>
          <h3 className="font-semibold text-slate-800 text-sm">
            {primaryStatute
              ? formatStatuteCitation(primaryStatute)
              : section.section_id}
          </h3>
          {primaryStatute?.title && (
            <p className="text-xs text-slate-500 mt-0.5">{primaryStatute.title}</p>
          )}
        </div>
        <div className="flex items-center gap-2 ml-3">
          <span className={`text-xs font-bold px-2.5 py-1 ${cfg.badgeBg} ${cfg.badgeText} rounded-md border ${cfg.badgeBorder} shadow-sm`}>
            {cfg.label}
          </span>
          <span className="text-xs text-slate-500">{formatConfidence(section.confidence)}</span>
        </div>
      </div>

      <p className="text-sm text-slate-700 mb-2 leading-relaxed">
        {section.rationale || "—"}
      </p>

      <p className="text-xs text-slate-500 mb-3">
        {truncateAtBoundary(section.section_text || "", 120)}
      </p>

      <button
        type="button"
        className="text-sm font-semibold text-indigo-600 hover:text-indigo-800 flex items-center hover:underline"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        {expanded ? "Hide details" : "Details"}
        <ChevronDown className={`h-4 w-4 ml-1 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded && (
        <div className="mt-4 pt-4 border-t border-slate-200/50 space-y-3">
          <div>
            <p className="text-xs font-semibold text-slate-500 mb-1">Section text</p>
            <div className="text-sm text-slate-600 bg-white/60 p-3 rounded border border-slate-200 max-h-48 overflow-y-auto whitespace-pre-wrap">
              {section.section_text || "—"}
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-500 mb-1">Rationale</p>
            <p className="text-sm text-slate-700">{section.rationale || "—"}</p>
          </div>
          {section.remediation_suggestions?.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 mb-1">Remediation suggestions</p>
              <ul className="list-disc list-inside space-y-1">
                {section.remediation_suggestions.map((s, i) => (
                  <li key={i} className="text-sm text-slate-700">{s}</li>
                ))}
              </ul>
            </div>
          )}
          {section.applied_statutes?.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 mb-2">Applied statutes</p>
              <div className="space-y-2">
                {section.applied_statutes.map((statute, i) => (
                  <div key={i} className="p-3 bg-white/60 rounded-lg border border-slate-200">
                    <p className="text-sm font-medium text-slate-800">
                      {statute.statute_id} – {statute.title}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {statute.jurisdiction} · Evidence {formatConfidence(statute.evidence_score)}
                    </p>
                    {statute.matched_span && (
                      <blockquote className="text-xs text-slate-600 mt-1.5 border-l-2 border-slate-300 pl-2">
                        {statute.matched_span}
                      </blockquote>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
