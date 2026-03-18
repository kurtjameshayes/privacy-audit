import { useState, useEffect, useMemo, useRef } from "react";
import { apiGet, apiPost, apiDelete, ApiError } from "../api/client";
import { GapAnalysisResult } from "../components/GapAnalysisView";
import HealthScoreView from "../components/HealthScoreView";
import RiskAssessmentResultView from "../components/RiskAssessmentResultView";
import { InfoIcon, Tooltip } from "../components/Tooltip";
import type {
  RunsListResponse,
  RunDetail,
  RunSummaryItem,
} from "../types/api";
import { toGapAnalysisResponse } from "../types/api";
import {
  History,
  FileJson,
  Download,
  RotateCw,
  Trash2,
  CheckCircle2,
  Search,
  Calendar as CalendarIcon,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  X,
  XCircle,
  RefreshCw,
  AlertCircle,
  Loader2,
} from "lucide-react";

type GapFilter = "all" | "addressed" | "partial" | "ambiguous" | "missing" | "conflict";

function formatDate(value?: string): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const JOB_TYPE_LABELS: Record<string, string> = {
  gap_analysis: "Gap Analysis",
  health_score: "Health Score",
  risk_assessment: "Risk Assessment",
  gap_v3: "Gap v3",
  gap_v4: "Gap Analysis",
  regulatory_drift: "Regulatory Drift",
  applicability: "Applicability",
  multi_jurisdictional: "Multi-Jurisdictional",
  policy_statute: "Policy vs Statute",
};

function formatJobType(value: string): string {
  return JOB_TYPE_LABELS[value] ?? value.replace(/_/g, " ");
}

const SCORE_ASSESSMENT_TEXT_KEYS = [
  "score_assessment_text",
  "score_assessment",
  "report",
  "assessment_text",
  "report_text",
  "summary_text",
  "narrative",
  "assessment_report",
];

function getScoreAssessmentText(detail: RunDetail | null): string | null {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  const result = d.result as Record<string, unknown> | undefined;
  const source = result ?? d;
  for (const key of SCORE_ASSESSMENT_TEXT_KEYS) {
    const val = source[key];
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

function getScoreAssessmentResult(detail: RunDetail | null): {
  privacy_health_score: number | null;
  score_breakdown?: Record<string, unknown>;
  components?: Record<string, unknown>;
  error?: string;
  reportText?: string | null;
} | null {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  const jobType = d.job_type as string | undefined;
  const result = d.result as Record<string, unknown> | undefined;
  const score = result?.privacy_health_score ?? d.privacy_health_score;
  const hasScoreData = score != null || result?.score_breakdown || result?.components || d.score_breakdown || d.components;
  if (jobType !== "health_score" && !hasScoreData) return null;
  const reportText = getScoreAssessmentText(detail);
  return {
    privacy_health_score: typeof score === "number" ? score : null,
    score_breakdown: (result?.score_breakdown ?? d.score_breakdown) as Record<string, unknown> | undefined,
    components: (result?.components ?? d.components) as Record<string, unknown> | undefined,
    error: (result?.error ?? d.error) as string | undefined,
    reportText: reportText ?? undefined,
  };
}

function getRunId(run: RunSummaryItem): string | null {
  return run.run_id ?? run.job_id ?? null;
}

function getPolicyIdFromDetail(detail: RunDetail | null): string | undefined {
  if (!detail || typeof detail !== "object") return undefined;
  const d = detail as Record<string, unknown>;
  const req = d.request as Record<string, unknown> | undefined;
  return (req?.policy_document_id as string) ?? (d.policy_document_id as string);
}

function getScoreDisplay(run: RunSummaryItem): { text: string; color: string } | null {
  if (run.privacy_health_score != null) {
    const score = run.privacy_health_score;
    return {
      text: `${score}/100`,
      color: score >= 80 ? "text-emerald-600" : score >= 50 ? "text-amber-600" : "text-red-600",
    };
  }
  const s = run.summary;
  if (s && s.total_requirements) {
    const addressed = s.addressed ?? 0;
    return {
      text: `${addressed}/${s.total_requirements}`,
      color: addressed / s.total_requirements >= 0.8 ? "text-emerald-600" : "text-amber-600",
    };
  }
  return null;
}

export default function RunsPage() {
  const [policyDocumentId, setPolicyDocumentId] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [types, setTypes] = useState("");
  const [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState("");
  const [showDateFilter, setShowDateFilter] = useState(false);
  const dateFilterRef = useRef<HTMLDivElement>(null);

  const [data, setData] = useState<RunsListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<unknown>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [detailView, setDetailView] = useState<"gap" | "raw">("gap");
  const [gapFilter, setGapFilter] = useState<GapFilter>("all");
  const [expandedGapIndex, setExpandedGapIndex] = useState<number | null>(null);

  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [rerunLoading, setRerunLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteSupported, setDeleteSupported] = useState<boolean | null>(null);
  const [rerunNumRows, setRerunNumRows] = useState<string>("");

  const gapResult = useMemo(
    () => toGapAnalysisResponse(runDetail as RunDetail | null),
    [runDetail]
  );

  const scoreAssessmentResult = useMemo(
    () => getScoreAssessmentResult(runDetail as RunDetail | null),
    [runDetail]
  );

  const riskResult = useMemo(() => {
    const d = runDetail as Record<string, unknown> | null;
    if (!d || (d.job_type as string) !== "risk_assessment") return null;
    const res = (d.result ?? d) as Record<string, unknown>;
    if (res.assessment || res.report) return res;
    return null;
  }, [runDetail]);

  const runJobType = (runDetail as Record<string, unknown> | null)?.job_type as string | undefined;

  const gapFilteredItems = useMemo(() => {
    const gaps = gapResult?.gaps ?? [];
    if (gapFilter === "all") return gaps;
    return gaps.filter((g) => g.status === gapFilter);
  }, [gapResult?.gaps, gapFilter]);

  /* ── Close date filter on outside click ─────────────── */
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dateFilterRef.current && !dateFilterRef.current.contains(event.target as Node)) {
        setShowDateFilter(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  /* ── Fetch runs ──────────────────────────────────────── */
  const fetchRuns = async () => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string> = {
        limit: String(limit),
        offset: String(offset),
      };
      if (policyDocumentId) params.policy_document_id = policyDocumentId;
      if (since) params.since = since;
      if (until) params.until = until;
      if (types || filterType) params.types = filterType || types;

      const result = await apiGet<RunsListResponse>(
        "/api/compliance/runs",
        params
      );
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load runs.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchRuns();
  }, [limit, offset]);

  useEffect(() => {
    if (!selectedRunId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedRunId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedRunId]);

  useEffect(() => {
    if (!selectedRunId) {
      setRunDetail(null);
      return;
    }
    const load = async () => {
      setDetailLoading(true);
      try {
        const result = await apiGet<unknown>(
          `/api/compliance/runs/${selectedRunId}`,
          {}
        );
        setRunDetail(result);
        setDetailView("gap");
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

  /* ── Derived data ────────────────────────────────────── */
  const runs = data?.runs ?? [];
  const total = data?.total ?? 0;
  const rangeStart = total > 0 ? data!.offset + 1 : 0;
  const rangeEnd = data ? Math.min(data.offset + runs.length, total) : 0;
  const hasNext = data ? data.offset + runs.length < total : false;
  const hasPrev = offset > 0;

  const uniqueTypes = useMemo(() => {
    const set = new Set<string>();
    for (const r of runs) {
      const t = r.job_type;
      if (t) set.add(t);
      if (Array.isArray(r.types)) r.types.forEach((tt) => { if (tt) set.add(tt); });
    }
    return Array.from(set);
  }, [runs]);

  const filteredRuns = useMemo(() => {
    if (!searchQuery) return runs;
    const q = searchQuery.toLowerCase();
    return runs.filter((run) => {
      const id = (run.run_id ?? run.job_id ?? "").toLowerCase();
      const policy = (run.policy_document_id ?? "").toLowerCase();
      const company = (run.company_name ?? "").toLowerCase();
      return id.includes(q) || policy.includes(q) || company.includes(q);
    });
  }, [runs, searchQuery]);

  /* ── Action handlers ─────────────────────────────────── */
  const handleDownloadReport = async () => {
    const policyId = getPolicyIdFromDetail(runDetail as RunDetail | null);
    if (!policyId) {
      setReportError("No policy document ID in this run.");
      return;
    }
    setReportLoading(true);
    setReportError(null);
    try {
      const d = await apiPost<{ content?: string }>("/api/compliance/report", {
        policy_document_id: policyId,
        format: "markdown",
        source: "latest_stored",
        include_gap: true,
        include_health_score: true,
        include_multi_jurisdictional: false,
      });
      const content = d.content ?? "";
      const blob = new Blob([content], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `compliance-report-${policyId}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setReportError(err instanceof Error ? err.message : "Report download failed.");
    } finally {
      setReportLoading(false);
    }
  };

  const handleRerun = async () => {
    const policyId = getPolicyIdFromDetail(runDetail as RunDetail | null);
    if (!policyId) {
      setReportError("No policy document ID to re-run.");
      return;
    }
    const d = runDetail as Record<string, unknown>;
    const req = d?.request as Record<string, unknown> | undefined;
    const jurisdictions = (req?.applicable_jurisdictions ?? d?.applicable_jurisdictions) as string[] | undefined;
    setRerunLoading(true);
    setReportError(null);
    try {
      const payload: Record<string, unknown> = {
        policy_document_id: policyId,
        applicable_jurisdictions: Array.isArray(jurisdictions) ? jurisdictions : undefined,
        save_results: true,
      };
      const n = rerunNumRows.trim() ? parseInt(rerunNumRows, 10) : undefined;
      if (n !== undefined && !Number.isNaN(n) && n > 0) {
        payload.num_rows = n;
      }
      await apiPost("/api/compliance/gap-analysis", payload);
      await fetchRuns();
      setReportError(null);
    } catch (err) {
      setReportError(err instanceof Error ? err.message : "Re-run failed.");
    } finally {
      setRerunLoading(false);
    }
  };

  const handleDelete = async (runId?: string) => {
    const targetId = runId ?? selectedRunId;
    if (!targetId || !window.confirm(`Delete run ${targetId}? This cannot be undone.`)) return;
    setDeleteLoading(true);
    setReportError(null);
    try {
      await apiDelete(`/api/compliance/runs/${targetId}`);
      if (targetId === selectedRunId) setSelectedRunId(null);
      await fetchRuns();
    } catch (err) {
      if (err instanceof ApiError && err.status === 501) setDeleteSupported(false);
      setReportError(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setDeleteLoading(false);
    }
  };

  const openRunDetail = (run: RunSummaryItem, view?: "gap" | "raw") => {
    const id = getRunId(run);
    if (id) {
      setSelectedRunId(id);
      if (view) setDetailView(view);
    }
  };

  const handleApplyDateFilter = () => {
    setOffset(0);
    setShowDateFilter(false);
    void fetchRuns();
  };

  const handleClearDateFilter = () => {
    setSince("");
    setUntil("");
    setShowDateFilter(false);
  };

  return (
    <div className="p-8 max-w-6xl mx-auto w-full">
      {/* Page header */}
      <div className="flex justify-between items-start mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            Compliance Run History
            <InfoIcon content="Review previous engine runs, inspect raw JSON outputs, re-run analyses, or delete history records." />
          </h1>
          <p className="text-slate-500 mt-1 text-sm">
            Log of all manual and automated compliance checks.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {data && (
            <div className="text-right">
              <p className="text-2xl font-bold text-slate-900">{total}</p>
              <p className="text-xs text-slate-500">Total runs</p>
            </div>
          )}
          <button
            type="button"
            onClick={() => void fetchRuns()}
            disabled={loading}
            className="flex items-center gap-2 bg-white border border-slate-300 rounded-md px-4 py-2 text-sm font-medium hover:bg-slate-50 text-slate-700 shadow-sm transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Main card */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex flex-col">
        {/* Filter bar */}
        <div className="border-b border-slate-200 p-4 bg-slate-50/50">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px] max-w-xs">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400 pointer-events-none" />
              <input
                type="text"
                placeholder="Search runs…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="!w-full !pl-9 !pr-4 !py-2 text-sm !border !border-slate-300 !rounded-lg focus:!outline-none focus:!ring-2 focus:!ring-indigo-500/20 focus:!border-indigo-500 transition-all shadow-sm bg-white"
              />
            </div>

            <div className="h-6 w-px bg-slate-300 mx-1 hidden sm:block" />

            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="bg-white !border !border-slate-300 !rounded-lg !px-3 !py-2 text-sm font-medium text-slate-700 shadow-sm focus:!outline-none focus:!ring-2 focus:!ring-indigo-500/20 focus:!border-indigo-500 min-w-[160px]"
            >
              <option value="">All Analysis Types</option>
              {uniqueTypes.map((t) => (
                <option key={t} value={t}>{formatJobType(t)}</option>
              ))}
            </select>

            {/* Date range dropdown */}
            <div className="relative ml-auto" ref={dateFilterRef}>
              <button
                type="button"
                onClick={() => setShowDateFilter(!showDateFilter)}
                className={`flex items-center gap-2 bg-white border border-slate-300 rounded-lg px-4 py-2 text-sm font-medium hover:bg-slate-50 text-slate-700 shadow-sm transition-colors ${
                  since || until ? "ring-2 ring-indigo-500/20 border-indigo-500" : ""
                }`}
              >
                <CalendarIcon className="h-4 w-4 text-slate-500" />
                {since || until ? "Date filtered" : "Date Range"}
                <ChevronDown className={`h-4 w-4 text-slate-500 transition-transform ${showDateFilter ? "rotate-180" : ""}`} />
              </button>

              {showDateFilter && (
                <div className="absolute right-0 top-full mt-2 w-72 bg-white rounded-xl shadow-lg border border-slate-200 p-4 z-10">
                  <h3 className="font-semibold text-sm text-slate-900 mb-3">Filter by Date</h3>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Start Date</label>
                      <input
                        type="datetime-local"
                        value={since}
                        onChange={(e) => setSince(e.target.value)}
                        className="!w-full text-sm !border !border-slate-300 !rounded-lg !px-3 !py-2 focus:!ring-2 focus:!ring-indigo-500/20 focus:!border-indigo-500 focus:!outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">End Date</label>
                      <input
                        type="datetime-local"
                        value={until}
                        onChange={(e) => setUntil(e.target.value)}
                        className="!w-full text-sm !border !border-slate-300 !rounded-lg !px-3 !py-2 focus:!ring-2 focus:!ring-indigo-500/20 focus:!border-indigo-500 focus:!outline-none"
                      />
                    </div>
                    <div className="pt-2 flex gap-2">
                      <button
                        type="button"
                        onClick={handleApplyDateFilter}
                        className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold py-2 rounded-lg transition-colors"
                      >
                        Apply
                      </button>
                      <button
                        type="button"
                        onClick={handleClearDateFilter}
                        className="flex-1 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 text-sm font-semibold py-2 rounded-lg transition-colors"
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="mx-4 mt-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
            <XCircle className="h-5 w-5 text-red-500 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <th scope="col" className="px-6 py-4 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Run Details</th>
                <th scope="col" className="px-6 py-4 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Analysis Type</th>
                <th scope="col" className="px-6 py-4 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Result / Score</th>
                <th scope="col" className="px-6 py-4 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Date &amp; Status</th>
                <th scope="col" className="relative px-6 py-4"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center">
                    <div className="flex flex-col items-center justify-center text-slate-500">
                      <RefreshCw className="h-8 w-8 text-slate-300 animate-spin mb-3" />
                      <p className="font-medium text-slate-600">Loading runs…</p>
                    </div>
                  </td>
                </tr>
              ) : filteredRuns.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center">
                    <div className="flex flex-col items-center justify-center text-slate-500">
                      <div className="bg-slate-50 p-4 rounded-full mb-3">
                        <History className="h-8 w-8 text-slate-300" />
                      </div>
                      <p className="font-medium text-slate-700">No runs found.</p>
                      <p className="text-sm mt-1">
                        {searchQuery ? "Try adjusting your search." : "Run a compliance engine to see results here."}
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredRuns.map((run) => {
                  const id = getRunId(run) ?? run.policy_document_id ?? "";
                  const displayId = run.run_id ?? run.job_id ?? "";
                  const dateVal = run.run_at ?? run.created_at ?? run.completed_at ?? undefined;
                  const typeVal = run.job_type ?? (Array.isArray(run.types) ? run.types[0] : null);
                  const statusVal = run.status;
                  const scoreDisplay = getScoreDisplay(run);

                  return (
                    <tr
                      key={id}
                      className="hover:bg-slate-50/80 transition-colors group cursor-pointer"
                      onClick={() => openRunDetail(run)}
                    >
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex flex-col">
                          <span className="text-sm font-bold text-slate-900 group-hover:text-indigo-600 transition-colors">
                            {run.company_name ?? "—"}
                          </span>
                          <span className="text-xs text-slate-500 mt-1 font-medium">
                            {run.policy_document_id ?? "—"} &bull;{" "}
                            <span className="font-mono">
                              {displayId ? String(displayId).slice(0, 10) + "…" : "—"}
                            </span>
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex flex-col items-start gap-1.5">
                          {typeVal ? (
                            <span className="px-2.5 py-1 rounded-md bg-slate-100 border border-slate-200 text-xs font-semibold text-slate-700 shadow-sm">
                              {formatJobType(typeVal)}
                            </span>
                          ) : (
                            <span className="text-xs text-slate-500">—</span>
                          )}
                          {Array.isArray(run.types) && run.types.length > 1 && (
                            <span className="text-[10px] text-slate-500 font-medium tracking-wide uppercase">
                              + {run.types.length - 1} more
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {scoreDisplay ? (
                          <span className={`text-base font-bold ${scoreDisplay.color}`}>
                            {scoreDisplay.text}
                          </span>
                        ) : (
                          <span className="text-sm text-slate-500 font-medium italic">Detailed Output</span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex flex-col gap-1.5">
                          <span className="text-sm text-slate-700 font-medium">
                            {formatDate(dateVal)}
                          </span>
                          <StatusBadge status={statusVal} />
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div
                          className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Tooltip content="View JSON Data">
                            <button
                              type="button"
                              title="View JSON Data"
                              className="text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 p-2 rounded-md transition-colors flex items-center justify-center"
                              onClick={() => openRunDetail(run, "raw")}
                            >
                              <FileJson className="h-4 w-4" />
                            </button>
                          </Tooltip>
                          <Tooltip content="Re-run Engine">
                            <button
                              type="button"
                              title="Re-run Engine"
                              className="text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 p-2 rounded-md transition-colors flex items-center justify-center"
                              onClick={() => openRunDetail(run)}
                            >
                              <RotateCw className="h-4 w-4" />
                            </button>
                          </Tooltip>
                          <Tooltip content="Delete Run">
                            <button
                              type="button"
                              title="Delete Run"
                              className="text-slate-400 hover:text-red-600 hover:bg-red-50 p-2 rounded-md transition-colors flex items-center justify-center ml-1"
                              onClick={() => void handleDelete(getRunId(run) ?? undefined)}
                              disabled={deleteLoading}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </Tooltip>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data && total > 0 && (
          <div className="px-6 py-3 bg-slate-50/50 border-t border-slate-200 flex items-center justify-between text-sm">
            <span className="text-xs text-slate-500">
              Showing {rangeStart}–{rangeEnd} of {total} runs
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!hasPrev}
                onClick={() => setOffset((o) => Math.max(0, o - limit))}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm transition-colors"
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Previous
              </button>
              <button
                type="button"
                disabled={!hasNext}
                onClick={() => setOffset((o) => o + limit)}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm transition-colors"
              >
                Next <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Detail Modal ─────────────────────────────────── */}
      {selectedRunId && (
        <div
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-start justify-center pt-[5vh] overflow-y-auto"
          onClick={() => setSelectedRunId(null)}
          role="presentation"
        >
          <div
            className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-3xl mx-4 mb-8 flex flex-col max-h-[90vh]"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="runs-detail-title"
          >
            {/* Modal header */}
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between flex-shrink-0">
              <h2 id="runs-detail-title" className="text-lg font-bold text-slate-900">
                Run Detail
              </h2>
              <button
                type="button"
                onClick={() => setSelectedRunId(null)}
                className="text-slate-400 hover:text-slate-600 transition-colors p-1"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Modal action bar */}
            <div className="px-6 py-3 border-b border-slate-200 bg-slate-50/50 flex flex-wrap items-center gap-2 flex-shrink-0">
              {/* View toggles */}
              <div className="flex items-center gap-1 mr-2">
                {gapResult && (
                  <button
                    type="button"
                    onClick={() => setDetailView("gap")}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      detailView === "gap" ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-200"
                    }`}
                  >
                    Gap Analysis
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setDetailView("raw")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    detailView === "raw" ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  Raw JSON
                </button>
              </div>

              <div className="h-5 w-px bg-slate-300 hidden sm:block" />

              {/* Re-run controls */}
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  value={rerunNumRows}
                  onChange={(e) => setRerunNumRows(e.target.value)}
                  placeholder="Rows"
                  className="!w-20 !px-2 !py-1.5 text-xs !border !border-slate-300 !rounded-lg focus:!outline-none focus:!ring-2 focus:!ring-indigo-500/20"
                />
                <button
                  type="button"
                  onClick={() => void handleRerun()}
                  disabled={!runDetail || rerunLoading || !getPolicyIdFromDetail(runDetail as RunDetail | null)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-indigo-700 bg-indigo-50 border border-indigo-100 rounded-lg hover:bg-indigo-100 disabled:opacity-50 transition-colors"
                >
                  <RotateCw className={`h-3.5 w-3.5 ${rerunLoading ? "animate-spin" : ""}`} />
                  {rerunLoading ? "Running…" : "Re-run"}
                </button>
              </div>

              {/* Downloads + Delete */}
              <div className="flex items-center gap-1 ml-auto">
                <Tooltip content="Download Report (Markdown)">
                  <button
                    type="button"
                    title="Download Report (Markdown)"
                    onClick={() => void handleDownloadReport()}
                    disabled={!runDetail || reportLoading}
                    className="text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 p-2 rounded-md transition-colors disabled:opacity-40"
                  >
                    <Download className={`h-4 w-4 ${reportLoading ? "animate-pulse" : ""}`} />
                  </button>
                </Tooltip>
                <Tooltip content="Delete Run">
                  <button
                    type="button"
                    title="Delete Run"
                    onClick={() => void handleDelete()}
                    disabled={!runDetail || deleteLoading || deleteSupported === false}
                    className="text-slate-500 hover:text-red-600 hover:bg-red-50 p-2 rounded-md transition-colors disabled:opacity-40 ml-1"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </Tooltip>
              </div>
            </div>

            {/* Modal content */}
            <div className="flex-1 overflow-y-auto p-6">
              {detailLoading ? (
                <div className="flex flex-col items-center justify-center py-12 text-slate-500">
                  <Loader2 className="h-8 w-8 animate-spin text-slate-300 mb-3" />
                  <p className="font-medium">Loading run detail…</p>
                </div>
              ) : runDetail ? (
                <div className="space-y-5">
                  {reportError && (
                    <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
                      <XCircle className="h-4 w-4 text-red-500 mt-0.5 flex-shrink-0" />
                      <p className="text-sm text-red-800">{reportError}</p>
                    </div>
                  )}

                  <RunParametersCard detail={runDetail as Record<string, unknown>} />

                  {detailView === "raw" ? (
                    <pre className="text-xs bg-slate-900 text-emerald-400 p-4 rounded-lg overflow-x-auto max-h-[50vh]">
                      {JSON.stringify(runDetail, null, 2)}
                    </pre>
                  ) : (runDetail as Record<string, unknown>).status === "failed" ? (
                    <div className="flex flex-col items-center py-8 text-slate-500">
                      <AlertCircle className="h-10 w-10 text-red-400 mb-3" />
                      <p className="font-semibold text-red-700">Job failed</p>
                      {typeof (runDetail as Record<string, unknown>).error === "string" && (
                        <p className="text-sm text-red-600 mt-1 max-w-md text-center">
                          {(runDetail as Record<string, unknown>).error as string}
                        </p>
                      )}
                      <button
                        type="button"
                        onClick={() => setDetailView("raw")}
                        className="mt-3 text-sm font-semibold text-indigo-600 hover:underline"
                      >
                        View raw JSON
                      </button>
                    </div>
                  ) : (runDetail as Record<string, unknown>).status === "running" ||
                    (runDetail as Record<string, unknown>).status === "pending" ? (
                    <div className="flex flex-col items-center py-8 text-slate-500">
                      <Loader2 className="h-10 w-10 animate-spin text-indigo-400 mb-3" />
                      <p className="font-semibold text-slate-700">Job is running</p>
                      <p className="text-sm mt-1 max-w-md text-center">
                        Compliance analysis is in progress. Results will appear when complete.
                      </p>
                      <button
                        type="button"
                        onClick={() => setDetailView("raw")}
                        className="mt-3 text-sm font-semibold text-indigo-600 hover:underline"
                      >
                        View raw JSON
                      </button>
                    </div>
                  ) : riskResult ? (
                    <RiskAssessmentResultView result={riskResult} />
                  ) : gapResult ? (
                    <GapAnalysisResult
                      result={gapResult}
                      filteredItems={gapFilteredItems}
                      gapFilter={gapFilter}
                      onFilterChange={setGapFilter}
                      expandedGapIndex={expandedGapIndex}
                      onExpandGap={setExpandedGapIndex}
                    />
                  ) : runJobType === "health_score" && scoreAssessmentResult ? (
                    <HealthScoreView
                      score={scoreAssessmentResult.privacy_health_score ?? undefined}
                      components={scoreAssessmentResult.components}
                      scoreBreakdown={scoreAssessmentResult.score_breakdown}
                      reportText={scoreAssessmentResult.reportText}
                      error={scoreAssessmentResult.error}
                    />
                  ) : (
                    <div className="flex flex-col items-center py-8 text-slate-500">
                      <div className="bg-slate-50 p-4 rounded-full mb-3">
                        <History className="h-8 w-8 text-slate-300" />
                      </div>
                      <p className="font-semibold text-slate-700">No compliance results</p>
                      <p className="text-sm mt-1 max-w-md text-center">
                        This run has no gap analysis or score assessment results to display.
                      </p>
                      <button
                        type="button"
                        onClick={() => setDetailView("raw")}
                        className="mt-3 text-sm font-semibold text-indigo-600 hover:underline"
                      >
                        View raw JSON
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-slate-500 text-center py-8">Failed to load run detail.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Run parameters card ───────────────────────────────────────────── */

function RunParametersCard({ detail }: { detail: Record<string, unknown> }) {
  const req = detail.request as Record<string, unknown> | undefined;
  const result = detail.result as Record<string, unknown> | undefined;
  const policyId =
    (req?.policy_document_id as string) ??
    (result?.policy_document_id as string) ??
    (detail.policy_document_id as string) ??
    "";
  const jurisdictions =
    (req?.applicable_jurisdictions as string[]) ??
    (result?.applicable_jurisdictions as string[]) ??
    (detail.applicable_jurisdictions as string[]) ??
    [];
  const company =
    (result?.company_name as string | null | undefined) ??
    (detail.company_name as string | null | undefined);
  const jobType = detail.job_type as string | undefined;
  const status = detail.status as string | undefined;
  const runId = (detail.run_id ?? detail.job_id) as string | undefined;

  const items: Array<{ label: string; value: React.ReactNode }> = [];

  if (runId) items.push({ label: "Run ID", value: <span className="font-mono text-xs">{String(runId).slice(0, 16)}…</span> });
  if (jobType) items.push({
    label: "Job type",
    value: (
      <span className="px-2 py-0.5 rounded-md bg-slate-100 border border-slate-200 text-xs font-semibold text-slate-700">
        {formatJobType(jobType)}
      </span>
    ),
  });
  if (status) items.push({ label: "Status", value: <StatusBadge status={status} /> });
  items.push({ label: "Policy document", value: policyId || "—" });
  items.push({ label: "Jurisdictions", value: jurisdictions.length ? jurisdictions.join(", ") : "—" });
  if (req?.num_rows != null) items.push({ label: "Number of rows", value: String(req.num_rows) });
  if (company != null && company !== "") items.push({ label: "Company", value: company });
  if (detail.created_at) items.push({ label: "Started", value: formatDate(detail.created_at as string) });
  if (detail.completed_at) items.push({ label: "Completed", value: formatDate(detail.completed_at as string) });
  if (detail.privacy_health_score != null) items.push({ label: "Health score", value: String(detail.privacy_health_score) });
  if (detail.error) items.push({ label: "Error", value: <span className="text-red-600">{String(detail.error)}</span> });

  return (
    <div className="bg-slate-50 rounded-lg border border-slate-200 p-4">
      <h4 className="text-xs font-semibold text-slate-500 mb-3 uppercase tracking-wider">Run Parameters</h4>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        {items.map((item) => (
          <div key={item.label} className="contents">
            <dt className="text-slate-500">{item.label}</dt>
            <dd className="text-slate-800 font-medium truncate">{item.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/* ── Status badge ──────────────────────────────────────────────────── */

function StatusBadge({ status }: { status?: string }) {
  if (!status) return <span className="text-xs text-slate-500">—</span>;

  const config: Record<string, { icon: typeof CheckCircle2; color: string }> = {
    completed: { icon: CheckCircle2, color: "text-emerald-600" },
    running: { icon: Loader2, color: "text-amber-600" },
    pending: { icon: Loader2, color: "text-slate-500" },
    failed: { icon: AlertCircle, color: "text-red-600" },
  };

  const c = config[status] ?? { icon: CheckCircle2, color: "text-slate-500" };
  const Icon = c.icon;

  return (
    <span className={`flex items-center gap-1 text-xs font-semibold ${c.color}`}>
      <Icon className={`h-3 w-3 ${status === "running" || status === "pending" ? "animate-spin" : ""}`} />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}
