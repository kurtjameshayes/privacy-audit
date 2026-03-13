import { useState, useMemo, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { apiPost, normalizeApiError } from "../api/client";
import { useDocuments, extractDocumentId } from "../hooks/useDocuments";
import { useWorkflowState, getMissingSteps } from "../hooks/useWorkflowState";
import { InfoIcon } from "../components/Tooltip";
import type { DocumentRecord } from "../types/api";
import {
  Loader2,
  XCircle,
  ChevronRight,
  Play,
  Settings2,
  Sparkles,
  CheckCircle2,
  GitBranchPlus,
} from "lucide-react";

/* ── Types (shaped by upstream API response) ────────────────────────── */

interface StateInfo {
  name: string;
  abbr: string;
  color?: string;
}

const STATE_COLORS: Record<string, string> = {
  california: "#1a5276",
  virginia: "#6c3483",
  colorado: "#1e8449",
  texas: "#b9770e",
  connecticut: "#2e4057",
  utah: "#c0392b",
  iowa: "#2980b9",
  indiana: "#8e44ad",
  tennessee: "#d35400",
  montana: "#16a085",
  oregon: "#27ae60",
  delaware: "#2c3e50",
  new_jersey: "#7d3c98",
  new_hampshire: "#1abc9c",
};

function stateColor(key: string, info?: StateInfo): string {
  if (info?.color) return info.color;
  const slug = key.toLowerCase().replace(/\s+/g, "_");
  if (STATE_COLORS[slug]) return STATE_COLORS[slug];
  // Deterministic fallback color from slug hash.
  let hash = 0;
  for (let i = 0; i < slug.length; i++) {
    hash = slug.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 45%, 35%)`;
}

function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  const hex = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const raw = hex[1];
    const full = raw.length === 3 ? raw.split("").map((ch) => ch + ch).join("") : raw;
    const int = Number.parseInt(full, 16);
    const r = (int >> 16) & 255;
    const g = (int >> 8) & 255;
    const b = int & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const hsl = c.match(
    /^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i
  );
  if (hsl) {
    return `hsla(${hsl[1]}, ${hsl[2]}%, ${hsl[3]}%, ${alpha})`;
  }
  return `rgba(51, 65, 85, ${alpha})`;
}

function stateTintColor(key: string, info?: StateInfo): string {
  return withAlpha(stateColor(key, info), 0.2);
}

function jurisdictionButtonLabel(info: StateInfo): string {
  const abbr = (info.abbr || "").trim();
  const name = (info.name || "").split("(")[0].trim();
  if (!name || name.toLowerCase() === abbr.toLowerCase()) return abbr;
  return `${abbr} — ${name}`;
}

interface ActionNode {
  id: string;
  action: string;
  detail: string;
  sla: string;
  exceptions: string[];
  question?: undefined;
  yes?: undefined;
  no?: undefined;
}

interface QuestionNode {
  id: string;
  question: string;
  yes: TreeNode;
  no: TreeNode;
  action?: undefined;
}

type TreeNode = ActionNode | QuestionNode;

interface PolicyGap {
  covered: boolean;
  gap: string | null;
}

interface ConsumerRightsRouterResponse {
  states: Record<string, StateInfo>;
  request_types: Record<string, string>;
  trees: Record<string, Record<string, TreeNode>>;
  policy_gaps: Record<string, Record<string, PolicyGap>>;
  policy_document_id?: string | null;
  company_name?: string | null;
  applicable_jurisdictions?: string[];
  analyzed_at?: string;
}

/* ── Decision node component ────────────────────────────────────────── */

function DecisionNode({
  node,
  depth = 0,
  stateColor,
}: {
  node: TreeNode;
  depth?: number;
  stateColor: string;
}) {
  const [expanded, setExpanded] = useState(depth < 2);

  if (!node) return null;

  if (node.action) {
    const isBlock =
      node.action.includes("NO OBLIGATION") ||
      node.action.includes("NOT APPLICABLE") ||
      node.action.includes("NOT PERSONAL");
    const isWarning =
      node.action.includes("REQUEST ADDITIONAL") ||
      node.action.includes("DENY");

    const variant = isBlock ? "block" : isWarning ? "warning" : "success";
    const styles = {
      block: {
        bg: "bg-red-50",
        border: "border-red-300",
        title: "text-red-600",
        icon: "\u2298",
      },
      warning: {
        bg: "bg-amber-50",
        border: "border-amber-300",
        title: "text-amber-600",
        icon: "\u26A0",
      },
      success: {
        bg: "bg-emerald-50",
        border: "border-emerald-300",
        title: "text-emerald-600",
        icon: "\u2713",
      },
    }[variant];

    return (
      <div
        className={`${styles.bg} border-2 ${styles.border} rounded-lg p-3.5 font-mono`}
        style={{ marginLeft: depth * 24 }}
      >
        <div
          className={`font-bold text-xs tracking-wide ${styles.title} mb-1.5`}
        >
          {styles.icon} {node.action}
        </div>
        <div className="text-[13px] text-slate-700 leading-relaxed">
          {node.detail}
        </div>
        {node.sla && (
          <div className="mt-2 text-xs text-slate-500">
            <span className="font-semibold">SLA:</span> {node.sla}
          </div>
        )}
        {node.exceptions && node.exceptions.length > 0 && (
          <div className="mt-1.5 text-xs text-slate-500">
            <span className="font-semibold">Exceptions:</span>{" "}
            {node.exceptions.join(" \u00B7 ")}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ marginLeft: depth * 24 }} className={depth > 0 ? "mt-2" : ""}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={`w-full text-left px-3.5 py-2.5 rounded-lg border-[1.5px] flex items-center gap-2.5 transition-all ${
          expanded
            ? "border-slate-300 bg-slate-50"
            : "border-slate-200 bg-white hover:bg-slate-50"
        }`}
      >
        <div
          className="w-[22px] h-[22px] rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0"
          style={{ backgroundColor: stateColor }}
        >
          ?
        </div>
        <span className="text-sm font-medium text-slate-800 flex-1">
          {node.question}
        </span>
        <span className="text-[11px] text-slate-400 shrink-0">
          {expanded ? "\u25BE" : "\u25B8"}
        </span>
      </button>

      {expanded && (
        <div
          className="ml-[11px] pl-3 mt-0.5"
          style={{ borderLeft: `2px solid ${stateColor}33` }}
        >
          <div className="text-[11px] font-bold text-emerald-600 mt-2 mb-0.5 tracking-wide">
            YES &darr;
          </div>
          {node.yes && (
            <DecisionNode
              node={node.yes}
              depth={depth + 1}
              stateColor={stateColor}
            />
          )}
          <div className="text-[11px] font-bold text-red-500 mt-2.5 mb-0.5 tracking-wide">
            NO &darr;
          </div>
          {node.no && (
            <DecisionNode
              node={node.no}
              depth={depth + 1}
              stateColor={stateColor}
            />
          )}
        </div>
      )}
    </div>
  );
}

/* ── Gap summary card ───────────────────────────────────────────────── */

function GapSummaryCard({
  stateKey,
  stateInfo,
  gap,
  active,
  onSelect,
}: {
  stateKey: string;
  stateInfo: StateInfo;
  gap: PolicyGap | null;
  active: boolean;
  onSelect: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasGap = !!gap?.gap;

  return (
    <div
      className={`text-left p-3 rounded-lg border transition-all ${
        active
          ? "bg-slate-700 border-blue-500"
          : "bg-slate-950 border-slate-700 hover:border-slate-500"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="w-full flex items-center gap-2 bg-transparent"
      >
        <div
          className="w-2 h-2 rounded-full shrink-0"
          style={{
            backgroundColor: hasGap ? "#f0883e" : "#3fb950",
          }}
        />
        <span className="text-[13px] font-semibold text-slate-100">
          {stateInfo.abbr}
        </span>
        <span
          className={`text-[11px] ml-auto ${
            hasGap ? "text-amber-400" : "text-slate-500"
          }`}
        >
          {hasGap ? "Gap" : "Aligned"}
        </span>
      </button>

      {hasGap && (
        <div className="mt-1.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              const nextExpanded = !expanded;
              setExpanded(nextExpanded);
            }}
            className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200 transition-colors"
          >
            <ChevronRight
              className={`h-3 w-3 transition-transform ${
                expanded ? "rotate-90" : ""
              }`}
            />
            {expanded ? "Hide details" : "Show details"}
          </button>
          {expanded && (
            <div className="mt-1.5 text-xs leading-snug text-amber-400">
              {gap!.gap}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Page component ─────────────────────────────────────────────────── */

export default function ConsumerRightsRouterPage() {
  const navigate = useNavigate();
  const { documents } = useDocuments("policy");

  const [selectedPolicy, setSelectedPolicy] = useState<DocumentRecord | null>(null);
  const [jurisdictionOverride, setJurisdictionOverride] = useState("");
  const [applicabilityLoading, setApplicabilityLoading] = useState(false);
  const [applicabilityError, setApplicabilityError] = useState<string | null>(null);

  const policyId = selectedPolicy ? extractDocumentId(selectedPolicy) : "";
  const { state: workflowState, refetch: refetchWorkflow } = useWorkflowState(
    policyId || null,
    "policy"
  );
  const missingSteps = getMissingSteps(workflowState);
  const policyReadyForCompliance = workflowState?.ready_for_compliance ?? false;

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

  // API result state
  const [result, setResult] = useState<ConsumerRightsRouterResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tree navigation state
  const [selectedRight, setSelectedRight] = useState<string | null>(null);
  const [selectedState, setSelectedState] = useState<string | null>(null);

  // Reset navigation state when new results arrive
  useEffect(() => {
    if (!result) return;
    const rightKeys = Object.keys(result.request_types);
    const stateKeys = Object.keys(result.states);
    if (rightKeys.length > 0 && !selectedRight) setSelectedRight(rightKeys[0]);
    if (stateKeys.length > 0 && !selectedState) setSelectedState(stateKeys[0]);
  }, [result, selectedRight, selectedState]);

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

  const handleRun = useCallback(async () => {
    if (!policyId) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setSelectedRight(null);
    setSelectedState(null);
    try {
      const body: Record<string, unknown> = {
        policy_document_id: policyId,
      };
      if (jurisdictions.length > 0) {
        body.applicable_jurisdictions = jurisdictions;
      }
      const data = await apiPost<ConsumerRightsRouterResponse>(
        "/api/compliance/consumer-rights-router",
        body
      );
      setResult(data);
    } catch (err) {
      setError(normalizeApiError(err));
    } finally {
      setLoading(false);
    }
  }, [policyId, jurisdictions]);

  // Derived values from API result
  const states = result?.states ?? {};
  const requestTypes = result?.request_types ?? {};
  const trees = result?.trees ?? {};
  const policyGaps = result?.policy_gaps ?? {};

  const tree =
    selectedRight && selectedState
      ? trees[selectedRight]?.[selectedState]
      : undefined;
  const gap =
    selectedRight && selectedState
      ? policyGaps[selectedRight]?.[selectedState]
      : undefined;
  const stateInfo = selectedState ? states[selectedState] : undefined;

  return (
    <div className="p-8 max-w-7xl mx-auto w-full">
      {/* Page header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          Consumer Rights Request Router
          <InfoIcon content="Maps your policy's stated consumer rights against what each state actually requires, then generates a decision tree for handling incoming DSR requests." />
        </h1>
        <p className="text-slate-500 mt-1 text-sm">
          Select a policy and jurisdictions, then generate decision trees for
          handling data subject requests.
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
        {/* ── Setup Column ──────────────────────────────────────── */}
        <div className="xl:col-span-1 space-y-6">
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
            <h2 className="text-lg font-semibold text-slate-800 mb-5 flex items-center gap-2">
              <Settings2 className="h-5 w-5 text-indigo-500" />
              Configuration
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
                    disabled={
                      !policyId ||
                      !policyReadyForCompliance ||
                      applicabilityLoading
                    }
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
                  placeholder="e.g. CA, VA, CO, TX"
                />
                <p className="text-xs text-slate-500 mt-2">
                  Comma-separated jurisdictions to analyze consumer rights
                  against.
                </p>
                {applicabilityError && (
                  <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
                    {applicabilityError}
                  </div>
                )}
              </div>

              {/* Run button */}
              <div className="pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => void handleRun()}
                  disabled={!policyId || !policyReadyForCompliance || loading}
                  className="w-full flex items-center justify-center gap-2 bg-indigo-600 text-white rounded-lg px-4 py-3 text-sm font-semibold hover:bg-indigo-700 disabled:opacity-70 disabled:cursor-not-allowed shadow-sm transition-all"
                >
                  {loading ? (
                    <span className="flex items-center gap-2 animate-pulse">
                      <Loader2 className="h-4 w-4 animate-spin" /> Generating
                      Decision Trees…
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Play className="h-4 w-4 fill-current" /> Generate Rights
                      Router
                    </span>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* ── Results Column ────────────────────────────────────── */}
        <div className="xl:col-span-2">
          {/* Error */}
          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2 mb-5">
              <XCircle className="h-5 w-5 text-red-500 mt-0.5 shrink-0" />
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          {/* Loading */}
          {loading && (
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-16 flex flex-col items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-indigo-400 mb-3" />
              <p className="font-medium text-slate-600">
                Generating decision trees…
              </p>
              <p className="text-sm text-slate-400 mt-1">
                Analyzing policy against state statutes
              </p>
            </div>
          )}

          {/* Empty state */}
          {!loading && !result && !error && (
            <div className="bg-white border-2 border-dashed border-slate-200 rounded-xl h-full min-h-[500px] flex flex-col items-center justify-center text-slate-400 p-8">
              <div className="w-20 h-20 bg-slate-50 rounded-full flex items-center justify-center mb-4">
                <GitBranchPlus className="h-10 w-10 text-slate-300" />
              </div>
              <p className="font-semibold text-slate-600 text-lg">
                Ready to Generate
              </p>
              <p className="text-sm max-w-sm text-center mt-2 leading-relaxed">
                Select a policy and jurisdictions on the left, then click{" "}
                <span className="font-semibold text-slate-500">
                  &quot;Generate Rights Router&quot;
                </span>{" "}
                to build decision trees for handling consumer data subject
                requests.
              </p>
            </div>
          )}

          {/* Results */}
          {!loading && result && selectedRight && selectedState && (
            <>
              {/* Metadata bar */}
              <div className="bg-slate-900 rounded-xl p-5 mb-5">
                <div className="flex items-center gap-2 mb-1">
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#3fb95066]" />
                  <span className="text-[11px] font-semibold text-emerald-400 tracking-[1.5px] uppercase">
                    Consumer Rights Request Router
                  </span>
                </div>
                <div className="text-lg font-bold text-slate-100 mt-2">
                  Request Handling Decision Trees
                </div>
                <div className="text-[13px] text-slate-400 mt-1">
                  Policy vs. statute analysis &middot; Operational routing for
                  incoming DSRs
                </div>
                <div className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-md text-xs text-slate-400 flex-wrap">
                  Policy:{" "}
                  <span className="text-slate-200">
                    {result.company_name ?? result.policy_document_id ?? policyId}
                  </span>
                  {result.applicable_jurisdictions && result.applicable_jurisdictions.length > 0 && (
                    <>
                      &nbsp;&middot;&nbsp;Jurisdictions:{" "}
                      <span className="text-slate-200">
                        {result.applicable_jurisdictions.join(", ")}
                      </span>
                    </>
                  )}
                  {result.analyzed_at && (
                    <>
                      &nbsp;&middot;&nbsp;Analyzed:{" "}
                      <span className="text-slate-200">
                        {result.analyzed_at}
                      </span>
                    </>
                  )}
                </div>
              </div>

              {/* Controls */}
              <div className="bg-slate-900 rounded-xl p-5 mb-5 border border-slate-800">
                <div className="flex gap-8 flex-wrap items-start">
                  {/* Request Type selector */}
                  <div>
                    <div className="text-[11px] font-semibold text-slate-400 tracking-wide uppercase mb-2">
                      Request Type
                    </div>
                    <div className="flex gap-1.5 flex-wrap">
                      {Object.entries(requestTypes).map(([key, label]) => {
                        const active = selectedRight === key;
                        const gapCnt = policyGaps[key]
                          ? Object.values(policyGaps[key]).filter(
                              (g) => g.gap
                            ).length
                          : 0;
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => setSelectedRight(key)}
                            className={`px-3 py-1.5 text-[13px] rounded-md border flex items-center gap-1.5 transition-colors ${
                              active
                                ? "font-semibold text-slate-100 bg-slate-700 border-blue-500"
                                : "text-slate-400 bg-transparent border-slate-700 hover:border-slate-500 hover:text-slate-300"
                            }`}
                          >
                            {label}
                            {gapCnt > 0 && (
                              <span className="bg-red-600 text-white text-[10px] font-bold px-1.5 py-px rounded-full leading-tight">
                                {gapCnt}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Jurisdiction selector */}
                  <div>
                    <div className="text-[11px] font-semibold text-slate-400 tracking-wide uppercase mb-2">
                      Jurisdiction
                    </div>
                    <div className="flex gap-1.5 flex-wrap">
                      {Object.entries(states).map(([key, st]) => {
                        const active = selectedState === key;
                        const hasGap =
                          policyGaps[selectedRight]?.[key]?.gap;
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => setSelectedState(key)}
                            className={`px-3 py-1.5 text-[13px] rounded-md border flex items-center gap-1.5 transition-colors ${
                              active
                                ? "font-semibold text-slate-100 border-blue-500 bg-transparent"
                                : "text-slate-400 bg-transparent border-slate-700 hover:border-slate-500 hover:text-slate-300"
                            }`}
                            style={
                              active
                                ? { backgroundColor: stateTintColor(key, st) }
                                : undefined
                            }
                          >
                            {jurisdictionButtonLabel(st)}
                            {hasGap && (
                              <span className="text-amber-500 text-sm leading-none">
                                &#9679;
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>

              {/* Gap summary matrix (replaces prior alert block) */}
              <div className="bg-slate-900 rounded-xl border border-slate-800 p-5 mb-5">
                <div className="text-sm font-semibold text-slate-100 mb-3.5">
                  Gap Summary &mdash; {requestTypes[selectedRight]}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
                  {Object.entries(states).map(([key, st]) => {
                    const g = policyGaps[selectedRight]?.[key];
                    return (
                      <GapSummaryCard
                        key={key}
                        stateKey={key}
                        stateInfo={st}
                        gap={g ?? null}
                        active={selectedState === key}
                        onSelect={() => setSelectedState(key)}
                      />
                    );
                  })}
                </div>
              </div>

              {/* Decision Tree */}
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-5">
                <div className="flex items-center gap-2.5 mb-4 pb-3.5 border-b-2 border-slate-100">
                  {stateInfo && (
                    <span
                      className="px-2.5 py-1 text-white rounded text-xs font-bold tracking-wide"
                      style={{
                        backgroundColor: selectedState ? stateColor(selectedState, stateInfo) : "#64748b",
                      }}
                    >
                      {stateInfo.abbr}
                    </span>
                  )}
                  <span className="text-base font-bold text-slate-800">
                    {requestTypes[selectedRight]} &mdash;{" "}
                    {stateInfo?.name ?? selectedState}
                  </span>
                  {gap && !gap.gap && (
                    <span className="ml-auto px-2.5 py-1 bg-emerald-50 text-emerald-600 rounded text-[11px] font-semibold border border-emerald-100">
                      &#10003; POLICY ALIGNED
                    </span>
                  )}
                  {gap?.gap && (
                    <span className="ml-auto px-2.5 py-1 bg-amber-50 text-amber-600 rounded text-[11px] font-semibold border border-amber-100">
                      &#9888; GAP FLAGGED
                    </span>
                  )}
                </div>

                {tree ? (
                  <DecisionNode
                    node={tree}
                    depth={0}
                    stateColor={selectedState ? stateColor(selectedState, stateInfo) : "#64748b"}
                  />
                ) : (
                  <div className="py-8 text-center text-slate-400">
                    No decision tree available for this combination.
                  </div>
                )}
              </div>

            </>
          )}
        </div>
      </div>
    </div>
  );
}
