import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { apiGet, apiPost, normalizeApiError } from "../api/client";
import { InfoIcon } from "../components/Tooltip";
import type {
  RunsListResponse,
  RunSummaryItem,
  RunDetail,
  GapItem,
  SuggestPolicyResponse,
} from "../types/api";
import { toGapAnalysisResponse } from "../types/api";
import { Copy, Check } from "lucide-react";
import {
  Lightbulb,
  ChevronRight,
  Loader2,
  History,
  ShieldAlert,
  AlertTriangle,
  XCircle,
  RefreshCw,
  FileText,
  Zap,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

function formatDate(value?: string): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const STATUS_STYLES: Record<string, { bg: string; text: string; border: string; label: string }> = {
  missing: { bg: "bg-red-50", text: "text-red-700", border: "border-red-200", label: "Missing" },
  partial: { bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200", label: "Partial" },
  conflict: { bg: "bg-red-50", text: "text-red-700", border: "border-red-200", label: "Conflict" },
  ambiguous: { bg: "bg-slate-100", text: "text-slate-700", border: "border-slate-200", label: "Ambiguous" },
  addressed: { bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200", label: "Addressed" },
};

function resolvePolicyText(gap: GapItem): string {
  return gap.policy_chunk_text || gap.policy_subchunk_text || gap.policy_combined_sections || gap.policy_quote || "";
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-indigo-600 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

interface BatchGapResult {
  gap: GapItem;
  suggestion: SuggestPolicyResponse | null;
  error: string | null;
}

type PageMode = "single" | "batch";

export default function AdvisorPage() {
  const [runs, setRuns] = useState<RunSummaryItem[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runsError, setRunsError] = useState<string | null>(null);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [mode, setMode] = useState<PageMode>("single");

  // Single-gap state
  const [selectedGapIndex, setSelectedGapIndex] = useState<number | null>(null);
  const [suggestion, setSuggestion] = useState<SuggestPolicyResponse | null>(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  // Batch state
  const [batchResults, setBatchResults] = useState<BatchGapResult[]>([]);
  const [batchCurrent, setBatchCurrent] = useState(0);
  const [batchTotal, setBatchTotal] = useState(0);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchDone, setBatchDone] = useState(false);
  const cancelRef = useRef(false);

  useEffect(() => {
    const load = async () => {
      setRunsLoading(true);
      setRunsError(null);
      try {
        const result = await apiGet<RunsListResponse>("/api/compliance/runs", {
          types: "gap_analysis,gap_v4",
          limit: "100",
          offset: "0",
        });
        setRuns(result.runs ?? []);
      } catch (err) {
        setRunsError(normalizeApiError(err));
      } finally {
        setRunsLoading(false);
      }
    };
    void load();
  }, []);

  useEffect(() => {
    if (!selectedRunId) {
      setRunDetail(null);
      resetSingleState();
      resetBatchState();
      setMode("single");
      return;
    }
    const load = async () => {
      setDetailLoading(true);
      resetSingleState();
      resetBatchState();
      setMode("single");
      try {
        const result = await apiGet<RunDetail>(
          `/api/compliance/runs/${selectedRunId}`,
          {}
        );
        setRunDetail(result);
      } catch {
        setRunDetail(null);
      } finally {
        setDetailLoading(false);
      }
    };
    void load();
  }, [selectedRunId]);

  function resetSingleState() {
    setSelectedGapIndex(null);
    setSuggestion(null);
    setSuggestError(null);
    setSuggestLoading(false);
  }

  function resetBatchState() {
    cancelRef.current = true;
    setBatchResults([]);
    setBatchCurrent(0);
    setBatchTotal(0);
    setBatchRunning(false);
    setBatchDone(false);
  }

  const gapResult = useMemo(
    () => toGapAnalysisResponse(runDetail),
    [runDetail]
  );

  const actionableGaps = useMemo(() => {
    if (!gapResult?.gaps) return [];
    return gapResult.gaps
      .map((g, i) => ({ gap: g, originalIndex: i }))
      .filter(({ gap }) =>
        gap.status === "missing" || gap.status === "partial" || gap.status === "conflict"
      );
  }, [gapResult?.gaps]);

  const eligibleGaps = useMemo(
    () => actionableGaps.filter(({ gap }) =>
      !!(resolvePolicyText(gap) && gap.statute_chunk_text && gap.conflict_description)
    ),
    [actionableGaps]
  );

  const selectedGap = selectedGapIndex != null ? actionableGaps[selectedGapIndex]?.gap ?? null : null;

  const canGenerate = useMemo(() => {
    if (!selectedGap) return false;
    const policyText = resolvePolicyText(selectedGap);
    const statuteText = selectedGap.statute_chunk_text;
    const gapText = selectedGap.conflict_description;
    return !!(policyText && statuteText && gapText);
  }, [selectedGap]);

  const handleGenerate = async () => {
    if (!selectedGap) return;
    const policyText = resolvePolicyText(selectedGap);
    const statuteText = selectedGap.statute_chunk_text || "";
    const gapText = selectedGap.conflict_description || "";
    const match = selectedGap.status || "missing";

    setSuggestLoading(true);
    setSuggestError(null);
    setSuggestion(null);
    try {
      const result = await apiPost<SuggestPolicyResponse>(
        "/api/compliance/suggest-policy",
        {
          policy_text: policyText,
          gap_analysis_text: gapText,
          gap_analysis_match: match,
          statute_text: statuteText,
        }
      );
      setSuggestion(result);
    } catch (err) {
      setSuggestError(normalizeApiError(err));
    } finally {
      setSuggestLoading(false);
    }
  };

  const handleBatchRewrite = async () => {
    if (eligibleGaps.length === 0) return;
    cancelRef.current = false;
    setBatchResults([]);
    setBatchCurrent(0);
    setBatchTotal(eligibleGaps.length);
    setBatchRunning(true);
    setBatchDone(false);
    setMode("batch");

    const results: BatchGapResult[] = [];
    for (let i = 0; i < eligibleGaps.length; i++) {
      if (cancelRef.current) break;
      setBatchCurrent(i + 1);
      const { gap } = eligibleGaps[i];
      try {
        const result = await apiPost<SuggestPolicyResponse>(
          "/api/compliance/suggest-policy",
          {
            policy_text: resolvePolicyText(gap),
            gap_analysis_text: gap.conflict_description || "",
            gap_analysis_match: gap.status || "missing",
            statute_text: gap.statute_chunk_text || "",
          }
        );
        results.push({ gap, suggestion: result, error: null });
      } catch (err) {
        results.push({ gap, suggestion: null, error: normalizeApiError(err) });
      }
      setBatchResults([...results]);
    }
    setBatchRunning(false);
    setBatchDone(true);
  };

  const mergedPolicy = useMemo(() => {
    if (!batchDone || batchResults.length === 0) return "";
    const sections = batchResults
      .filter((r) => r.suggestion?.suggested_policy_text)
      .map((r, i) => {
        const header = r.gap.requirement_summary || `Section ${i + 1}`;
        const jurisdiction = r.gap.jurisdiction ? ` [${r.gap.jurisdiction}]` : "";
        return `## ${header}${jurisdiction}\n\n${r.suggestion!.suggested_policy_text}`;
      });
    return sections.join("\n\n---\n\n");
  }, [batchDone, batchResults]);

  const mergedModifications = useMemo(() => {
    if (!batchDone || batchResults.length === 0) return "";
    return batchResults
      .filter((r) => r.suggestion?.modifications_description)
      .map((r) => {
        const label = r.gap.requirement_summary || "Gap";
        return `• ${label}: ${r.suggestion!.modifications_description}`;
      })
      .join("\n\n");
  }, [batchDone, batchResults]);

  const batchSuccessCount = batchResults.filter((r) => r.suggestion).length;
  const batchErrorCount = batchResults.filter((r) => r.error).length;

  const currentStep = !selectedRunId ? 1 : mode === "batch" ? (batchDone ? 3 : 2) : !selectedGap ? 2 : 3;

  return (
    <div className="p-8 max-w-5xl mx-auto w-full">
      {/* Page header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          Policy Advisor
          <InfoIcon content="Select a gap analysis run, then generate AI-suggested policy text for individual gaps or rewrite the entire policy at once." />
        </h1>
        <p className="text-slate-500 mt-1 text-sm">
          AI-suggested policy rewrites to close compliance gaps identified in prior analyses.
        </p>
      </div>

      {/* Progress steps */}
      <div className="flex items-center gap-2 mb-8">
        {[
          { num: 1, label: "Select Run" },
          { num: 2, label: mode === "batch" ? "Processing" : "Choose Gap" },
          { num: 3, label: mode === "batch" ? "Merged Policy" : "Generate" },
        ].map((step) => (
          <div key={step.num} className="flex items-center gap-2">
            {step.num > 1 && <ChevronRight className="h-4 w-4 text-slate-300" />}
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              currentStep === step.num
                ? "bg-indigo-100 text-indigo-700 border border-indigo-200"
                : currentStep > step.num
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                  : "bg-slate-50 text-slate-400 border border-slate-200"
            }`}>
              <span className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold ${
                currentStep === step.num
                  ? "bg-indigo-600 text-white"
                  : currentStep > step.num
                    ? "bg-emerald-500 text-white"
                    : "bg-slate-200 text-slate-500"
              }`}>
                {step.num}
              </span>
              {step.label}
            </div>
          </div>
        ))}
      </div>

      {/* Step 1: Select a gap analysis run */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden mb-6">
        <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            <History className="h-4 w-4 text-indigo-500" />
            1. Select a Gap Analysis Run
          </h2>
          {selectedRunId && (
            <button
              type="button"
              onClick={() => setSelectedRunId(null)}
              className="text-xs font-semibold text-indigo-600 hover:text-indigo-800"
            >
              Change run
            </button>
          )}
        </div>

        {runsLoading ? (
          <div className="flex items-center justify-center py-12 text-slate-500">
            <Loader2 className="h-6 w-6 animate-spin text-slate-300 mr-3" />
            <span className="text-sm font-medium">Loading gap analysis runs…</span>
          </div>
        ) : runsError ? (
          <div className="p-6">
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
              <XCircle className="h-5 w-5 text-red-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-red-800">{runsError}</p>
            </div>
          </div>
        ) : runs.length === 0 ? (
          <div className="py-12 text-center text-slate-500">
            <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4">
              <History className="h-8 w-8 text-slate-300" />
            </div>
            <p className="font-semibold text-slate-700">No gap analysis runs found</p>
            <p className="text-sm mt-1">Run a gap analysis from the Compliance Analysis page first.</p>
          </div>
        ) : selectedRunId ? (
          <div className="px-6 py-4">
            {(() => {
              const run = runs.find((r) => (r.run_id ?? r.job_id) === selectedRunId);
              if (!run) return null;
              const s = run.summary;
              return (
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">
                      {run.company_name || run.policy_document_id || "—"}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {formatDate(run.run_at ?? run.created_at)}
                      {run.policy_document_id && <span className="font-mono ml-2">{run.policy_document_id.slice(0, 12)}…</span>}
                    </p>
                  </div>
                  {s && s.total_requirements != null && (
                    <div className="flex gap-1.5">
                      {(s.missing ?? 0) > 0 && <span className="text-xs font-semibold px-2 py-0.5 rounded bg-red-50 text-red-700 border border-red-100">{s.missing} missing</span>}
                      {(s.conflicts ?? 0) > 0 && <span className="text-xs font-semibold px-2 py-0.5 rounded bg-red-50 text-red-700 border border-red-100">{s.conflicts} conflicts</span>}
                      {(s.addressed ?? 0) > 0 && <span className="text-xs font-semibold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-100">{s.addressed} addressed</span>}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        ) : (
          <div className="divide-y divide-slate-100 max-h-[360px] overflow-y-auto">
            {runs.map((run) => {
              const id = run.run_id ?? run.job_id ?? "";
              const s = run.summary;
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
                      {formatDate(run.run_at ?? run.created_at)}
                      {run.policy_document_id && <span className="font-mono ml-2">{run.policy_document_id.slice(0, 12)}…</span>}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 ml-4 flex-shrink-0">
                    {s && s.total_requirements != null && s.total_requirements > 0 && (
                      <div className="flex gap-1.5">
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
        )}
      </div>

      {/* Step 2: Choose mode — single gap or batch rewrite */}
      {selectedRunId && !detailLoading && actionableGaps.length > 0 && mode === "single" && selectedGapIndex == null && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden mb-6">
          <div className="px-6 py-4 bg-slate-50 border-b border-slate-200">
            <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-indigo-500" />
              2. Choose a Compliance Gap — or Rewrite All
            </h2>
          </div>

          {/* Batch rewrite CTA */}
          {eligibleGaps.length > 0 && (
            <div className="px-6 pt-5 pb-3">
              <button
                type="button"
                onClick={() => void handleBatchRewrite()}
                className="w-full flex items-center justify-center gap-2.5 bg-gradient-to-r from-indigo-100 to-violet-100 text-indigo-900 rounded-lg px-4 py-3.5 text-sm font-semibold hover:from-indigo-200 hover:to-violet-200 shadow-sm border border-indigo-200 transition-all"
              >
                <Zap className="h-4 w-4" />
                Rewrite Full Policy ({eligibleGaps.length} gap{eligibleGaps.length !== 1 ? "s" : ""})
              </button>
              <p className="text-xs text-slate-500 text-center mt-2">
                Generates AI-suggested text for every gap and merges into a complete rewritten policy.
              </p>
            </div>
          )}

          <div className="px-6 py-2">
            <div className="flex items-center gap-3 text-xs text-slate-400">
              <div className="flex-1 border-t border-slate-200" />
              <span className="uppercase tracking-wider font-semibold">or pick one gap</span>
              <div className="flex-1 border-t border-slate-200" />
            </div>
          </div>

          {/* Individual gap list */}
          <div className="divide-y divide-slate-100 max-h-[320px] overflow-y-auto">
            {actionableGaps.map(({ gap }, i) => {
              const st = STATUS_STYLES[gap.status ?? "missing"] ?? STATUS_STYLES.missing;
              const hasRequired = !!(resolvePolicyText(gap) && gap.statute_chunk_text && gap.conflict_description);
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => setSelectedGapIndex(i)}
                  disabled={!hasRequired}
                  className={`w-full text-left px-6 py-4 transition-colors flex items-center justify-between group ${
                    hasRequired ? "hover:bg-slate-50" : "opacity-50 cursor-not-allowed"
                  }`}
                  title={!hasRequired ? "Missing required data (policy text, statute text, or conflict description)" : undefined}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-900 group-hover:text-indigo-600 transition-colors truncate">
                      {gap.requirement_summary || "—"}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">
                      {gap.jurisdiction && <span className="mr-2">{gap.jurisdiction}</span>}
                      {gap.statute_reference || gap.statute_name || ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded border ${st.bg} ${st.text} ${st.border}`}>
                      {st.label}
                    </span>
                    {hasRequired && <ChevronRight className="h-4 w-4 text-slate-400 group-hover:text-indigo-500 transition-colors" />}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Step 2 — selected single gap preview */}
      {selectedRunId && mode === "single" && selectedGapIndex != null && selectedGap && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden mb-6">
          <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-indigo-500" />
              2. Compliance Gap
            </h2>
            <button
              type="button"
              onClick={() => { resetSingleState(); }}
              className="text-xs font-semibold text-indigo-600 hover:text-indigo-800"
            >
              Change gap
            </button>
          </div>
          <div className="p-6">
            <SelectedGapPreview gap={selectedGap} />
          </div>
        </div>
      )}

      {/* Batch progress / results */}
      {mode === "batch" && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden mb-6">
          <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <Zap className="h-4 w-4 text-indigo-500" />
              {batchDone ? "Full Policy Rewrite Complete" : "Processing All Gaps…"}
            </h2>
            {(batchDone || !batchRunning) && (
              <button
                type="button"
                onClick={() => { resetBatchState(); setMode("single"); }}
                className="text-xs font-semibold text-indigo-600 hover:text-indigo-800"
              >
                Back to gap list
              </button>
            )}
          </div>

          <div className="p-6 space-y-6">
            {/* Progress bar */}
            {batchRunning && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-600 font-medium flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
                    Processing gap {batchCurrent} of {batchTotal}…
                  </span>
                  <span className="text-slate-500 text-xs font-mono">
                    {Math.round((batchCurrent / batchTotal) * 100)}%
                  </span>
                </div>
                <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                  <div
                    className="bg-indigo-500 h-2 rounded-full transition-all duration-500"
                    style={{ width: `${(batchCurrent / batchTotal) * 100}%` }}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => { cancelRef.current = true; }}
                  className="text-xs font-semibold text-red-600 hover:text-red-800"
                >
                  Cancel
                </button>
              </div>
            )}

            {/* Summary badges */}
            {batchResults.length > 0 && (
              <div className="flex items-center gap-3">
                {batchSuccessCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                    <CheckCircle2 className="h-3.5 w-3.5" /> {batchSuccessCount} succeeded
                  </span>
                )}
                {batchErrorCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded bg-red-50 text-red-700 border border-red-200">
                    <XCircle className="h-3.5 w-3.5" /> {batchErrorCount} failed
                  </span>
                )}
              </div>
            )}

            {/* Per-gap results accordion */}
            {batchResults.length > 0 && (
              <BatchResultsList results={batchResults} />
            )}

            {/* Merged policy output */}
            {batchDone && mergedPolicy && (
              <div className="space-y-4">
                {mergedModifications && (
                  <div className="p-4 bg-indigo-50 border border-indigo-200 rounded-xl">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-semibold text-indigo-800 flex items-center gap-2">
                        <FileText className="h-4 w-4" />
                        All Modifications Summary
                      </p>
                      <CopyButton text={mergedModifications} />
                    </div>
                    <pre className="text-sm text-indigo-700 leading-relaxed whitespace-pre-wrap font-sans">
                      {mergedModifications}
                    </pre>
                  </div>
                )}

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                      <FileText className="h-4 w-4 text-indigo-500" />
                      Complete Rewritten Policy
                    </p>
                    <CopyButton text={mergedPolicy} />
                  </div>
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-5 max-h-[60vh] overflow-y-auto">
                    <pre className="text-sm text-slate-700 whitespace-pre-wrap font-sans leading-relaxed">
                      {mergedPolicy}
                    </pre>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void handleBatchRewrite()}
                  className="flex items-center gap-2 text-sm font-semibold text-indigo-600 hover:text-indigo-800"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Regenerate All
                </button>
              </div>
            )}

            {batchDone && !mergedPolicy && (
              <div className="py-8 text-center text-slate-500">
                <p className="font-semibold text-slate-700">No suggestions were generated</p>
                <p className="text-sm mt-1">All gap requests failed. Check that the upstream service is running.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Step 3: Generate single suggestion */}
      {mode === "single" && selectedGap && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden mb-6">
          <div className="px-6 py-4 bg-slate-50 border-b border-slate-200">
            <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <Lightbulb className="h-4 w-4 text-indigo-500" />
              3. Generate Policy Suggestion
            </h2>
          </div>
          <div className="p-6 space-y-5">
            {!canGenerate && (
              <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-500 mt-0.5 flex-shrink-0" />
                <p className="text-sm text-amber-800">
                  This gap item is missing required data (policy chunk text, statute chunk text, or conflict description).
                  Choose a different gap with complete data.
                </p>
              </div>
            )}

            {!suggestion && !suggestLoading && (
              <button
                type="button"
                onClick={() => void handleGenerate()}
                disabled={!canGenerate || suggestLoading}
                className="w-full flex items-center justify-center gap-2 bg-indigo-600 text-white rounded-lg px-4 py-3 text-sm font-semibold hover:bg-indigo-700 disabled:opacity-70 disabled:cursor-not-allowed shadow-sm transition-all"
              >
                <Lightbulb className="h-4 w-4" />
                Generate Suggested Policy Text
              </button>
            )}

            {suggestLoading && (
              <div className="flex flex-col items-center justify-center py-12 text-slate-500">
                <Loader2 className="h-8 w-8 animate-spin text-indigo-400 mb-3" />
                <p className="font-medium text-slate-700">Generating suggestion…</p>
                <p className="text-xs text-slate-500 mt-1">The AI is analyzing the gap and drafting revised policy text.</p>
              </div>
            )}

            {suggestError && (
              <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
                <XCircle className="h-5 w-5 text-red-500 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm text-red-800">{suggestError}</p>
                  <button
                    type="button"
                    onClick={() => void handleGenerate()}
                    className="mt-2 text-xs font-semibold text-indigo-600 hover:underline flex items-center gap-1"
                  >
                    <RefreshCw className="h-3 w-3" /> Retry
                  </button>
                </div>
              </div>
            )}

            {suggestion && (
              <div className="space-y-5">
                {suggestion.modifications_description && (
                  <div className="p-4 bg-indigo-50 border border-indigo-200 rounded-xl">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-semibold text-indigo-800">Modifications Summary</p>
                      <CopyButton text={suggestion.modifications_description} />
                    </div>
                    <p className="text-sm text-indigo-700 leading-relaxed whitespace-pre-wrap">
                      {suggestion.modifications_description}
                    </p>
                  </div>
                )}

                {suggestion.suggested_policy_text && (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-semibold text-slate-700">Suggested Policy Text</p>
                      <CopyButton text={suggestion.suggested_policy_text} />
                    </div>
                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 max-h-[50vh] overflow-y-auto">
                      <pre className="text-sm text-slate-700 whitespace-pre-wrap font-sans leading-relaxed">
                        {suggestion.suggested_policy_text}
                      </pre>
                    </div>
                  </div>
                )}

                {suggestion.analyzed_at && (
                  <p className="text-xs text-slate-400 text-right">
                    Generated {formatDate(suggestion.analyzed_at)}
                  </p>
                )}

                <button
                  type="button"
                  onClick={() => void handleGenerate()}
                  disabled={suggestLoading}
                  className="flex items-center gap-2 text-sm font-semibold text-indigo-600 hover:text-indigo-800"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Regenerate
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Detail-loading and empty states for Step 2 */}
      {selectedRunId && detailLoading && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden mb-6">
          <div className="flex items-center justify-center py-12 text-slate-500">
            <Loader2 className="h-6 w-6 animate-spin text-slate-300 mr-3" />
            <span className="text-sm font-medium">Loading run detail…</span>
          </div>
        </div>
      )}

      {selectedRunId && !detailLoading && actionableGaps.length === 0 && mode === "single" && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden mb-6">
          <div className="py-12 text-center text-slate-500">
            <p className="font-semibold text-slate-700">No actionable gaps</p>
            <p className="text-sm mt-1">This run has no missing, partial, or conflict gaps to advise on.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function BatchResultsList({ results }: { results: BatchGapResult[] }) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden divide-y divide-slate-100">
      {results.map((r, i) => {
        const isExpanded = expandedIndex === i;
        const st = STATUS_STYLES[r.gap.status ?? "missing"] ?? STATUS_STYLES.missing;
        return (
          <div key={i}>
            <button
              type="button"
              onClick={() => setExpandedIndex(isExpanded ? null : i)}
              className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-slate-50 transition-colors"
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {r.suggestion ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                ) : (
                  <XCircle className="h-4 w-4 text-red-400 flex-shrink-0" />
                )}
                <span className="text-sm font-medium text-slate-800 truncate">
                  {r.gap.requirement_summary || "—"}
                </span>
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${st.bg} ${st.text} ${st.border} flex-shrink-0`}>
                  {st.label}
                </span>
              </div>
              {isExpanded ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
            </button>
            {isExpanded && (
              <div className="px-4 pb-4 pt-1 bg-slate-50 border-t border-slate-100">
                {r.error && (
                  <p className="text-sm text-red-700 bg-red-50 p-3 rounded-lg border border-red-200">{r.error}</p>
                )}
                {r.suggestion?.modifications_description && (
                  <div className="mb-3">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Changes</p>
                      <CopyButton text={r.suggestion.modifications_description} />
                    </div>
                    <p className="text-sm text-slate-700">{r.suggestion.modifications_description}</p>
                  </div>
                )}
                {r.suggestion?.suggested_policy_text && (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Suggested Text</p>
                      <CopyButton text={r.suggestion.suggested_policy_text} />
                    </div>
                    <pre className="text-sm text-slate-600 whitespace-pre-wrap font-sans bg-white p-3 rounded-lg border border-slate-200 max-h-40 overflow-y-auto">
                      {r.suggestion.suggested_policy_text}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SelectedGapPreview({ gap }: { gap: GapItem }) {
  const st = STATUS_STYLES[gap.status ?? "missing"] ?? STATUS_STYLES.missing;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-slate-900">{gap.requirement_summary || "—"}</p>
        <span className={`text-xs font-bold px-2.5 py-1 rounded border ${st.bg} ${st.text} ${st.border}`}>
          {st.label}
        </span>
      </div>
      {gap.jurisdiction && (
        <p className="text-xs text-slate-500">Jurisdiction: {gap.jurisdiction}</p>
      )}
      {gap.conflict_description && (
        <div>
          <p className="text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wider">Gap Finding</p>
          <p className="text-sm text-slate-700 bg-slate-50 p-3 rounded-lg border border-slate-200">
            {gap.conflict_description}
          </p>
        </div>
      )}
      {resolvePolicyText(gap) && (
        <div>
          <p className="text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wider">Current Policy Text</p>
          <div className="text-sm text-slate-600 bg-slate-50 p-3 rounded-lg border border-slate-200 max-h-32 overflow-y-auto whitespace-pre-wrap">
            {resolvePolicyText(gap)}
          </div>
        </div>
      )}
      {gap.statute_chunk_text && (
        <div>
          <p className="text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wider">Statute Text</p>
          <div className="text-sm text-slate-600 bg-slate-50 p-3 rounded-lg border border-slate-200 max-h-32 overflow-y-auto whitespace-pre-wrap">
            {gap.statute_chunk_text}
          </div>
        </div>
      )}
    </div>
  );
}
