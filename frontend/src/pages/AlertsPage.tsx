import { useState, useEffect } from "react";
import { apiGet } from "../api/client";
import type { AlertsListResponse } from "../types/api";

function formatDate(value?: string): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

export default function AlertsPage() {
  const [policyDocumentId, setPolicyDocumentId] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [since, setSince] = useState("");
  const [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);

  const [data, setData] = useState<AlertsListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAlerts = async () => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string> = {
        limit: String(limit),
        offset: String(offset),
      };
      if (policyDocumentId) params.policy_document_id = policyDocumentId;
      if (companyName) params.company_name = companyName;
      if (jurisdiction) params.jurisdiction = jurisdiction;
      if (since) params.since = since;

      const result = await apiGet<AlertsListResponse>(
        "/api/compliance/alerts",
        params
      );
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load alerts.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchAlerts();
  }, [limit, offset]);

  return (
    <>
      <header className="main-header">
        <div>
          <p className="eyebrow">Regulatory Drift</p>
          <h2>Drift alerts</h2>
          <p className="subtitle">
            List and filter regulatory drift alerts from compliance_alerts.
          </p>
        </div>
        {data && (
          <div className="header-card">
            <p className="header-card-title">Total alerts</p>
            <p className="header-card-value">{data.total}</p>
            <p className="header-card-caption">
              {data.offset + 1}–{Math.min(data.offset + data.alerts.length, data.total)} shown
            </p>
          </div>
        )}
      </header>

      <section className="alerts-panel">
        <div className="panel-header">
          <p className="panel-title">Filters</p>
        </div>
        <div className="alerts-filters">
          <div className="field-group">
            <label className="field-label" htmlFor="alerts-policy">
              Policy document ID
            </label>
            <input
              id="alerts-policy"
              type="text"
              value={policyDocumentId}
              onChange={(e) => setPolicyDocumentId(e.target.value)}
              placeholder="Filter by policy"
            />
          </div>
          <div className="field-group">
            <label className="field-label" htmlFor="alerts-company">
              Company name
            </label>
            <input
              id="alerts-company"
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="Substring match"
            />
          </div>
          <div className="field-group">
            <label className="field-label" htmlFor="alerts-jurisdiction">
              Jurisdiction
            </label>
            <input
              id="alerts-jurisdiction"
              type="text"
              value={jurisdiction}
              onChange={(e) => setJurisdiction(e.target.value)}
              placeholder="e.g. CA"
            />
          </div>
          <div className="field-group">
            <label className="field-label" htmlFor="alerts-since">
              Since (date-time)
            </label>
            <input
              id="alerts-since"
              type="datetime-local"
              value={since}
              onChange={(e) => setSince(e.target.value)}
            />
          </div>
          <button
            className="primary-button"
            type="button"
            onClick={fetchAlerts}
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

        <div className="alerts-table-container">
          {loading ? (
            <div className="loading-state">
              <span className="loader" />
              Loading alerts…
            </div>
          ) : data ? (
            <>
              <table className="alerts-table">
                <thead>
                  <tr>
                    <th>Alert ID</th>
                    <th>Company</th>
                    <th>Policy ID</th>
                    <th>Trigger</th>
                    <th>Type</th>
                    <th>Jurisdictions</th>
                    <th>Previous</th>
                    <th>Current</th>
                    <th>Delta</th>
                    <th>Detected</th>
                  </tr>
                </thead>
                <tbody>
                  {data.alerts.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="empty-cell">
                        No alerts match the filters.
                      </td>
                    </tr>
                  ) : (
                    data.alerts.map((alert) => (
                      <tr key={alert.alert_id || alert.policy_document_id || ""}>
                        <td>{alert.alert_id || "—"}</td>
                        <td>{alert.company_name ?? "—"}</td>
                        <td>{alert.policy_document_id ?? "—"}</td>
                        <td>{alert.trigger ?? "—"}</td>
                        <td>{alert.type ?? "—"}</td>
                        <td>
                          {Array.isArray(alert.affected_jurisdictions)
                            ? alert.affected_jurisdictions.join(", ")
                            : "—"}
                        </td>
                        <td>{alert.previous_score ?? "—"}</td>
                        <td>{alert.current_score ?? "—"}</td>
                        <td>{alert.score_delta ?? "—"}</td>
                        <td>{formatDate(alert.detected_at)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
              <div className="alerts-pagination">
                <button
                  disabled={offset === 0}
                  onClick={() => setOffset((o) => Math.max(0, o - limit))}
                >
                  Previous
                </button>
                <span>
                  {data.offset + 1}–{Math.min(data.offset + data.alerts.length, data.total)} of {data.total}
                </span>
                <button
                  disabled={data.offset + data.alerts.length >= data.total}
                  onClick={() => setOffset((o) => o + limit)}
                >
                  Next
                </button>
              </div>
            </>
          ) : null}
        </div>
      </section>
    </>
  );
}
