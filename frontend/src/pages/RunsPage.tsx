import { useState, useEffect, useMemo } from "react";
import { apiGet, apiPost } from "../api/client";
import { GapAnalysisResult } from "../components/GapAnalysisView";
import type {
  RunsListResponse,
  RunDetail,
  RunSummaryItem,
} from "../types/api";
import { toGapAnalysisResponse } from "../types/api";

type GapFilter = "all" | "addressed" | "partial" | "ambiguous" | "missing" | "conflict";

function formatDate(value?: string): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
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

function RunParametersCard({
  detail,
  formatDate,
}: {
  detail: Record<string, unknown>;
  formatDate: (v?: string) => string;
}) {
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

  return (
    <div className="run-params-card">
      <h5 className="run-params-title">Run parameters</h5>
      <dl className="run-params-list">
        {runId && (
          <>
            <dt>Run ID</dt>
            <dd>{String(runId).slice(0, 12)}…</dd>
          </>
        )}
        {jobType && (
          <>
            <dt>Job type</dt>
            <dd>{jobType}</dd>
          </>
        )}
        {status && (
          <>
            <dt>Status</dt>
            <dd>
              <span className={`status-badge status-${status}`}>{status}</span>
            </dd>
          </>
        )}
        <dt>Policy document</dt>
        <dd>{policyId || "—"}</dd>
        <dt>Jurisdictions</dt>
        <dd>{jurisdictions.length ? jurisdictions.join(", ") : "—"}</dd>
        {req?.num_rows != null && (
          <>
            <dt>Number of rows</dt>
            <dd>{String(req.num_rows)}</dd>
          </>
        )}
        {company != null && company !== "" && (
          <>
            <dt>Company</dt>
            <dd>{company}</dd>
          </>
        )}
        {detail.created_at && (
          <>
            <dt>Started</dt>
            <dd>{formatDate(detail.created_at as string)}</dd>
          </>
        )}
        {detail.completed_at && (
          <>
            <dt>Completed</dt>
            <dd>{formatDate(detail.completed_at as string)}</dd>
          </>
        )}
        {detail.privacy_health_score != null && (
          <>
            <dt>Health score</dt>
            <dd>{String(detail.privacy_health_score)}</dd>
          </>
        )}
        {detail.error && (
          <>
            <dt>Error</dt>
            <dd className="run-params-error">{String(detail.error)}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

export default function RunsPage() {
  const [policyDocumentId, setPolicyDocumentId] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [types, setTypes] = useState("");
  const [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);

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

  const gapFilteredItems = useMemo(() => {
    const gaps = gapResult?.gaps ?? [];
    if (gapFilter === "all") return gaps;
    return gaps.filter((g) => g.status === gapFilter);
  }, [gapResult?.gaps, gapFilter]);

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
      if (types) params.types = types;

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

  const handleDownloadJson = () => {
    if (!runDetail) return;
    const blob = new Blob([JSON.stringify(runDetail, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const policyId = getPolicyIdFromDetail(runDetail as RunDetail | null) ?? "run";
    a.download = `compliance-result-${String(policyId)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadReport = async () => {
    const policyId = getPolicyIdFromDetail(runDetail as RunDetail | null);
    if (!policyId) {
      setReportError("No policy document ID in this run.");
      return;
    }
    setReportLoading(true);
    setReportError(null);
    try {
      const res = await fetch("/api/compliance/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          policy_document_id: policyId,
          format: "markdown",
          source: "latest_stored",
          include_gap: true,
          include_health_score: true,
          include_multi_jurisdictional: false,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(
          (err as { error?: string }).error || res.statusText || "Report failed"
        );
      }
      const data = (await res.json()) as { content?: string };
      const content = data.content ?? "";
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

  const handleDelete = async () => {
    if (!selectedRunId || !window.confirm(`Delete run ${selectedRunId}? This cannot be undone.`)) return;
    setDeleteLoading(true);
    setReportError(null);
    try {
      const res = await fetch(`/api/compliance/runs/${selectedRunId}`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        if (res.status === 501) setDeleteSupported(false);
        throw new Error((data as { error?: string }).error ?? res.statusText);
      }
      setSelectedRunId(null);
      await fetchRuns();
    } catch (err) {
      setReportError(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <>
      <header className="main-header">
        <div>
          <p className="eyebrow">Audit Trail</p>
          <h2>Compliance runs</h2>
          <p className="subtitle">
            Browse gap analysis and compliance results. View structured details
            or download as JSON or Markdown report.
          </p>
        </div>
        {data && (
          <div className="header-card">
            <p className="header-card-title">Total runs</p>
            <p className="header-card-value">{data.total}</p>
            <p className="header-card-caption">
              {data.offset + 1}–
              {Math.min(data.offset + data.runs.length, data.total)} shown
            </p>
          </div>
        )}
      </header>

      <section className="runs-panel">
        <div className="panel-header">
          <p className="panel-title">Filters</p>
        </div>
        <div className="runs-filters">
          <div className="field-group">
            <label className="field-label" htmlFor="runs-policy">
              Policy document ID
            </label>
            <input
              id="runs-policy"
              type="text"
              value={policyDocumentId}
              onChange={(e) => setPolicyDocumentId(e.target.value)}
              placeholder="Filter by policy"
            />
          </div>
          <div className="field-group">
            <label className="field-label" htmlFor="runs-since">
              Since (ISO8601)
            </label>
            <input
              id="runs-since"
              type="datetime-local"
              value={since}
              onChange={(e) => setSince(e.target.value)}
            />
          </div>
          <div className="field-group">
            <label className="field-label" htmlFor="runs-until">
              Until (ISO8601)
            </label>
            <input
              id="runs-until"
              type="datetime-local"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
            />
          </div>
          <div className="field-group">
            <label className="field-label" htmlFor="runs-types">
              Types (comma-separated)
            </label>
            <input
              id="runs-types"
              type="text"
              value={types}
              onChange={(e) => setTypes(e.target.value)}
              placeholder="gap, health_score, multi_jurisdictional, applicability"
            />
          </div>
          <button
            className="primary-button"
            type="button"
            onClick={fetchRuns}
            disabled={loading}
          >
            {loading ? "Loading…" : "Apply filters"}
          </button>
          <button
            className="ghost-button"
            type="button"
            onClick={fetchRuns}
            disabled={loading}
          >
            Refresh
          </button>
        </div>

        {error && (
          <div className="error-banner">
            <span className="error-text">{error}</span>
          </div>
        )}

        <div className="runs-layout">
          <div className="runs-table-container runs-table-container--full">
            {loading ? (
              <div className="loading-state">
                <span className="loader" />
                Loading runs…
              </div>
            ) : data ? (
              <>
                <table className="runs-table">
                  <thead>
                    <tr>
                      <th>Run ID</th>
                      <th>Policy ID</th>
                      <th>Company</th>
                      <th>Run at</th>
                      <th>Status</th>
                      <th>Health Score</th>
                      <th>Summary</th>
                      <th>Types</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.runs.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="empty-cell">
                          No runs match the filters.
                        </td>
                      </tr>
                    ) : (
                      data.runs.map((run) => {
                        const id = getRunId(run) ?? run.policy_document_id ?? "";
                        const displayId = run.run_id ?? run.job_id ?? "";
                        const dateVal = run.completed_at ?? run.run_at ?? run.created_at;
                        const typeVal = run.job_type ?? (Array.isArray(run.types) ? run.types.join(", ") : null);
                        const statusVal = run.status;
                        return (
                          <tr
                            key={id}
                            className={
                              selectedRunId === (run.run_id ?? run.job_id ?? null)
                                ? "selected"
                                : ""
                            }
                            onClick={() => setSelectedRunId(getRunId(run))}
                          >
                            <td className="runs-cell-id">
                              {displayId ? String(displayId).slice(0, 8) + "…" : "—"}
                            </td>
                            <td>{run.policy_document_id ?? "—"}</td>
                            <td>{run.company_name ?? "—"}</td>
                            <td>{formatDate(dateVal)}</td>
                            <td>
                              {statusVal ? (
                                <span
                                  className={`status-badge status-${statusVal}`}
                                >
                                  {statusVal}
                                </span>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td>{run.privacy_health_score ?? "—"}</td>
                            <td>
                              {run.summary
                                ? `${(run.summary as { addressed?: number }).addressed ?? "—"}/${(run.summary as { total_requirements?: number }).total_requirements ?? "—"} addressed`
                                : "—"}
                            </td>
                            <td>{typeVal ?? "—"}</td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
                <div className="runs-pagination">
                  <button
                    disabled={offset === 0}
                    onClick={() =>
                      setOffset((o) => Math.max(0, o - limit))
                    }
                  >
                    Previous
                  </button>
                  <span>
                    {data.offset + 1}–
                    {Math.min(data.offset + data.runs.length, data.total)} of{" "}
                    {data.total}
                  </span>
                  <button
                    disabled={
                      data.offset + data.runs.length >= data.total
                    }
                    onClick={() => setOffset((o) => o + limit)}
                  >
                    Next
                  </button>
                </div>
              </>
            ) : null}
          </div>

          {selectedRunId && (
            <div
              className="runs-detail-modal-backdrop"
              onClick={() => setSelectedRunId(null)}
              role="presentation"
            >
              <div
                className="runs-detail-modal"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-labelledby="runs-detail-title"
              >
          <div className="runs-detail-panel runs-detail-panel--enhanced">
                <div className="runs-detail-header">
                  <h4 id="runs-detail-title">Run detail</h4>
                  <div className="runs-detail-actions">
                    <div className="runs-view-toggle">
                      {gapResult && (
                        <button
                          type="button"
                          className={`ghost-button ${detailView === "gap" ? "is-active" : ""}`}
                          onClick={() => setDetailView("gap")}
                        >
                          Gap analysis
                        </button>
                      )}
                      <button
                        type="button"
                        className={`ghost-button ${detailView === "raw" ? "is-active" : ""}`}
                        onClick={() => setDetailView("raw")}
                      >
                        Raw JSON
                      </button>
                    </div>
                    <div className="runs-detail-rerun">
                      <label className="runs-num-rows-label">
                        <span>Number of rows:</span>
                        <input
                          type="number"
                          min={1}
                          value={rerunNumRows}
                          onChange={(e) => setRerunNumRows(e.target.value)}
                          placeholder="default"
                        />
                      </label>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={handleRerun}
                        disabled={!runDetail || rerunLoading || !getPolicyIdFromDetail(runDetail as RunDetail | null)}
                      >
                        {rerunLoading ? "Re-running…" : "Re-run"}
                      </button>
                    </div>
                    <div className="runs-download-buttons">
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={handleDownloadJson}
                        disabled={!runDetail}
                      >
                        Download JSON
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={handleDownloadReport}
                        disabled={!runDetail || reportLoading}
                      >
                        {reportLoading ? "Generating…" : "Download report"}
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={handleDelete}
                        disabled={!runDetail || deleteLoading || deleteSupported === false}
                      >
                        {deleteLoading ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </div>
                </div>

                {detailLoading ? (
                  <div className="loading-state">
                    <span className="loader" />
                    Loading…
                  </div>
                ) : runDetail ? (
                  <>
                    {reportError && (
                      <div className="error-banner runs-report-error">
                        <span className="error-text">{reportError}</span>
                      </div>
                    )}
                    <RunParametersCard
                      detail={runDetail as Record<string, unknown>}
                      formatDate={formatDate}
                    />
                    {detailView === "raw" ? (
                      <pre className="run-detail-json">
                        {JSON.stringify(runDetail, null, 2)}
                      </pre>
                    ) : (runDetail as Record<string, unknown>).status === "running" ||
                      (runDetail as Record<string, unknown>).status === "pending" ? (
                      <div className="run-status-running">
                        <span className="loader" />
                        <p className="run-status-message">Job is running</p>
                        <p className="run-status-hint">
                          Compliance analysis is in progress. Results will appear when complete.
                        </p>
                      </div>
                    ) : gapResult ? (
                      <div className="runs-gap-view">
                        <GapAnalysisResult
                          result={gapResult}
                          filteredItems={gapFilteredItems}
                          gapFilter={gapFilter}
                          onFilterChange={setGapFilter}
                          expandedGapIndex={expandedGapIndex}
                          onExpandGap={setExpandedGapIndex}
                        />
                      </div>
                    ) : (runDetail as Record<string, unknown>).status === "failed" ? (
                      <div className="run-status-failed">
                        <p className="run-status-message">Job failed</p>
                        {(runDetail as Record<string, unknown>).error && (
                          <p className="run-status-error">
                            {String((runDetail as Record<string, unknown>).error)}
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="run-status-no-results">
                        <p className="run-status-message">No compliance results</p>
                        <p className="run-status-hint">
                          This run has no gap analysis results to display.
                        </p>
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => setDetailView("raw")}
                        >
                          View raw JSON
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <p>Failed to load run detail.</p>
                )}
                <button
                  className="ghost-button runs-close-btn"
                  type="button"
                  onClick={() => setSelectedRunId(null)}
                >
                  Close
                </button>
          </div>
              </div>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
