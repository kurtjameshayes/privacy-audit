import { useState, useEffect } from "react";
import { apiGet } from "../api/client";
import type { AlertsListResponse, AlertListItem } from "../types/api";
import { InfoIcon } from "../components/Tooltip";
import {
  BellRing,
  Filter,
  TrendingDown,
  TrendingUp,
  Clock,
  Search,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  XCircle,
  X,
} from "lucide-react";

function timeAgo(dateStr?: string): string {
  if (!dateStr) return "—";
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return dateStr;
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

function getSeverity(delta: number | null | undefined): "high" | "medium" | "low" {
  if (delta == null) return "low";
  const abs = Math.abs(delta);
  if (abs >= 10) return "high";
  if (abs >= 5) return "medium";
  return "low";
}

const SEVERITY_STYLES = {
  high: {
    icon: "bg-red-50 border-red-100 text-red-600",
    drift: "text-red-700",
  },
  medium: {
    icon: "bg-amber-50 border-amber-100 text-amber-600",
    drift: "text-amber-700",
  },
  low: {
    icon: "bg-blue-50 border-blue-100 text-blue-600",
    drift: "text-blue-700",
  },
};

export default function AlertsPage() {
  const [policyDocumentId, setPolicyDocumentId] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [since, setSince] = useState("");
  const [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);
  const [showAdvanced, setShowAdvanced] = useState(false);

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

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      setOffset(0);
      void fetchAlerts();
    }
  };

  const alerts = data?.alerts ?? [];
  const total = data?.total ?? 0;
  const rangeStart = total > 0 ? data!.offset + 1 : 0;
  const rangeEnd = data ? Math.min(data.offset + alerts.length, total) : 0;
  const hasNext = data ? data.offset + alerts.length < total : false;
  const hasPrev = offset > 0;

  return (
    <div className="p-8 max-w-6xl mx-auto w-full">
      {/* Page header */}
      <div className="flex justify-between items-start mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            Regulatory Drift Alerts
            <InfoIcon content="Automatic notifications triggered when external statute changes negatively affect the compliance score of your monitored policies." />
          </h1>
          <p className="text-slate-500 mt-1 text-sm">
            Monitor continuous compliance and address statute updates proactively.
          </p>
        </div>
        {data && (
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-2xl font-bold text-slate-900">{total}</p>
              <p className="text-xs text-slate-500">Total alerts</p>
            </div>
            <button
              type="button"
              onClick={() => void fetchAlerts()}
              disabled={loading}
              className="flex items-center gap-2 bg-white border border-slate-300 rounded-md px-4 py-2 text-sm font-medium hover:bg-slate-50 text-slate-700 shadow-sm transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              {loading ? "Loading…" : "Refresh"}
            </button>
          </div>
        )}
      </div>

      {/* Main card */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex flex-col">
        {/* Filter bar */}
        <div className="border-b border-slate-200 p-4 flex flex-wrap gap-3 bg-slate-50/50">
          <div className="relative flex-1 min-w-[200px] max-w-xs">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400 pointer-events-none" />
            <input
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Filter by company…"
              className="!w-full !pl-9 !pr-4 !py-2 text-sm !border !border-slate-300 !rounded-lg focus:!outline-none focus:!ring-2 focus:!ring-indigo-500/20 focus:!border-indigo-500 transition-all shadow-sm"
            />
          </div>
          <input
            type="text"
            value={jurisdiction}
            onChange={(e) => setJurisdiction(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Jurisdiction (e.g. CA)"
            className="!w-36 !px-4 !py-2 text-sm !border !border-slate-300 !rounded-lg focus:!outline-none focus:!ring-2 focus:!ring-indigo-500/20 focus:!border-indigo-500 text-slate-700 shadow-sm transition-all"
          />
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className={`flex items-center gap-2 bg-white border border-slate-300 rounded-lg px-4 py-2 text-sm font-semibold hover:bg-slate-50 text-slate-700 shadow-sm transition-colors ${
              showAdvanced ? "ring-2 ring-indigo-500/20 border-indigo-500" : ""
            }`}
          >
            <Filter className="h-4 w-4" /> Filters
          </button>
          <button
            type="button"
            onClick={() => { setOffset(0); void fetchAlerts(); }}
            disabled={loading}
            className="flex items-center gap-2 bg-indigo-600 text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-indigo-700 disabled:opacity-70 shadow-sm transition-colors ml-auto"
          >
            {loading ? "Searching…" : "Apply"}
          </button>
        </div>

        {/* Advanced filters */}
        {showAdvanced && (
          <div className="border-b border-slate-200 px-4 py-3 bg-slate-50/30 flex flex-wrap gap-3 items-end">
            <div className="flex-1 min-w-[180px] max-w-xs">
              <label className="block text-xs font-medium text-slate-500 mb-1">Policy Document ID</label>
              <input
                type="text"
                value={policyDocumentId}
                onChange={(e) => setPolicyDocumentId(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder="Filter by policy ID"
                className="!w-full !px-3 !py-2 text-sm !border !border-slate-300 !rounded-lg focus:!outline-none focus:!ring-2 focus:!ring-indigo-500/20 focus:!border-indigo-500 shadow-sm transition-all"
              />
            </div>
            <div className="min-w-[180px] max-w-xs">
              <label className="block text-xs font-medium text-slate-500 mb-1">Since</label>
              <input
                type="datetime-local"
                value={since}
                onChange={(e) => setSince(e.target.value)}
                className="!px-3 !py-2 text-sm !border !border-slate-300 !rounded-lg focus:!outline-none focus:!ring-2 focus:!ring-indigo-500/20 focus:!border-indigo-500 shadow-sm transition-all"
              />
            </div>
            {(policyDocumentId || since) && (
              <button
                type="button"
                onClick={() => { setPolicyDocumentId(""); setSince(""); }}
                className="text-xs font-semibold text-slate-500 hover:text-slate-700 flex items-center gap-1 pb-2"
              >
                <X className="h-3 w-3" /> Clear
              </button>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mx-4 mt-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
            <XCircle className="h-5 w-5 text-red-500 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        {/* Alerts list */}
        <div className="divide-y divide-slate-100 bg-white">
          {loading ? (
            <div className="p-12 text-center flex flex-col items-center justify-center text-slate-500">
              <RefreshCw className="h-8 w-8 text-slate-300 animate-spin mb-3" />
              <p className="font-medium text-slate-600">Loading alerts…</p>
            </div>
          ) : alerts.length === 0 ? (
            <div className="p-12 text-center flex flex-col items-center justify-center text-slate-500">
              <div className="bg-slate-50 p-4 rounded-full mb-3">
                <BellRing className="h-8 w-8 text-slate-300" />
              </div>
              <p className="font-medium text-slate-700">No active alerts found.</p>
              <p className="text-sm mt-1 max-w-sm">
                All monitored policies are up-to-date with the latest statute changes.
              </p>
            </div>
          ) : (
            alerts.map((alert) => (
              <AlertCard key={alert.alert_id || alert.policy_document_id || ""} alert={alert} />
            ))
          )}
        </div>

        {/* Pagination */}
        {data && total > 0 && (
          <div className="px-6 py-3 bg-slate-50/50 border-t border-slate-200 flex items-center justify-between text-sm">
            <span className="text-xs text-slate-500">
              Showing {rangeStart}–{rangeEnd} of {total} alerts
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
    </div>
  );
}

function AlertCard({ alert }: { alert: AlertListItem }) {
  const severity = getSeverity(alert.score_delta);
  const styles = SEVERITY_STYLES[severity];
  const delta = alert.score_delta;
  const isNegative = delta != null && delta < 0;
  const DriftIcon = isNegative ? TrendingDown : TrendingUp;

  return (
    <div className="p-6 hover:bg-slate-50/80 transition-all flex flex-col sm:flex-row sm:items-start justify-between gap-4 group">
      <div className="flex gap-4">
        <div className={`p-2.5 rounded-xl flex items-center justify-center shrink-0 mt-1 shadow-sm border ${styles.icon}`}>
          <BellRing className="h-6 w-6" />
        </div>
        <div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <h3 className="font-bold text-slate-900 text-base">
              {alert.trigger || alert.type || "Drift Alert"}
            </h3>
            {alert.alert_id && (
              <span className="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs font-mono font-medium rounded border border-slate-200">
                {alert.alert_id}
              </span>
            )}
          </div>

          <p className="text-sm text-slate-600 mt-1.5 leading-relaxed">
            Affected document:{" "}
            <span className="font-semibold text-slate-800 bg-slate-100 px-1.5 py-0.5 rounded">
              {alert.policy_document_id || "—"}
            </span>
            {alert.company_name && ` (${alert.company_name})`}
          </p>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-3 text-xs font-medium">
            {alert.type && (
              <span className={`flex items-center gap-1.5 ${styles.drift}`}>
                <DriftIcon className="h-3.5 w-3.5" />
                {alert.type}
                {delta != null && ` (Score ${delta > 0 ? "+" : ""}${delta})`}
              </span>
            )}

            {delta == null && alert.previous_score != null && alert.current_score != null && (
              <span className={`flex items-center gap-1.5 ${styles.drift}`}>
                <DriftIcon className="h-3.5 w-3.5" />
                {alert.previous_score} → {alert.current_score}
              </span>
            )}

            {Array.isArray(alert.affected_jurisdictions) && alert.affected_jurisdictions.length > 0 && (
              <span className="text-slate-500">
                {alert.affected_jurisdictions.join(", ")}
              </span>
            )}

            <span className="flex items-center gap-1.5 text-slate-500">
              <Clock className="h-3.5 w-3.5" />
              Detected {timeAgo(alert.detected_at)}
            </span>
          </div>
        </div>
      </div>

      <div className="sm:ml-4 sm:shrink-0 flex items-center">
        <button
          type="button"
          className="w-full sm:w-auto text-sm font-semibold text-indigo-700 bg-indigo-50 px-4 py-2.5 rounded-lg hover:bg-indigo-100 transition-colors border border-indigo-100 flex items-center justify-center gap-2 group-hover:shadow-sm"
        >
          Review Drift <ExternalLink className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
