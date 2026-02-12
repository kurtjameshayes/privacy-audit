import { useState, useEffect } from "react";
import { apiGet } from "../api/client";
import type { RunsListResponse } from "../types/api";

function formatDate(value?: string): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
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
      } catch {
        setRunDetail(null);
      } finally {
        setDetailLoading(false);
      }
    };
    void load();
  }, [selectedRunId]);

  return (
    <>
      <header className="main-header">
        <div>
          <p className="eyebrow">Audit Trail</p>
          <h2>Compliance runs</h2>
          <p className="subtitle">
            Versioned compliance run history. Click a run for full details.
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
        </div>

        {error && (
          <div className="error-banner">
            <span className="error-text">{error}</span>
          </div>
        )}

        <div className="runs-layout">
          <div className="runs-table-container">
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
                      <th>Health Score</th>
                      <th>Summary</th>
                      <th>Types</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.runs.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="empty-cell">
                          No runs match the filters.
                        </td>
                      </tr>
                    ) : (
                      data.runs.map((run) => (
                        <tr
                          key={run.run_id || run.policy_document_id || ""}
                          className={
                            selectedRunId === run.run_id ? "selected" : ""
                          }
                          onClick={() =>
                            setSelectedRunId(run.run_id || null)
                          }
                        >
                          <td>{run.run_id ?? "—"}</td>
                          <td>{run.policy_document_id ?? "—"}</td>
                          <td>{run.company_name ?? "—"}</td>
                          <td>{formatDate(run.run_at)}</td>
                          <td>{run.privacy_health_score ?? "—"}</td>
                          <td>
                            {run.summary
                              ? `${(run.summary as { addressed?: number }).addressed ?? "—"}/${(run.summary as { total_requirements?: number }).total_requirements ?? "—"} addressed`
                              : "—"}
                          </td>
                          <td>
                            {Array.isArray(run.types)
                              ? run.types.join(", ")
                              : "—"}
                          </td>
                        </tr>
                      ))
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

          <div className="runs-detail-panel">
            {selectedRunId ? (
              <>
                <h4>Run detail</h4>
                {detailLoading ? (
                  <div className="loading-state">
                    <span className="loader" />
                    Loading…
                  </div>
                ) : runDetail ? (
                  <pre className="run-detail-json">
                    {JSON.stringify(runDetail, null, 2)}
                  </pre>
                ) : (
                  <p>Failed to load run detail.</p>
                )}
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => setSelectedRunId(null)}
                >
                  Close
                </button>
              </>
            ) : (
              <p className="runs-detail-placeholder">
                Click a run row to view full payload.
              </p>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
