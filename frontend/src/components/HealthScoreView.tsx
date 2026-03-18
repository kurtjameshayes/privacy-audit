import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import { formatReportContent } from "../utils/formatReportContent";

export interface HealthScoreViewProps {
  score: number | null | undefined;
  components?: Record<string, unknown>;
  scoreBreakdown?: Record<string, unknown>;
  reportText?: string | null;
  error?: string | null;
}

const COMPONENT_LABELS: Record<string, string> = {
  requirements_total: "Requirements total",
  addressed: "Addressed",
  missing: "Missing",
  conflicts: "Conflicts",
  raw_ratio: "Raw ratio",
  conflict_penalty_applied: "Conflict penalty applied",
};

function formatComponentValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  return String(value);
}

function getComponentLabel(key: string): string {
  return COMPONENT_LABELS[key] ?? key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function getSectionLabel(sectionKey: string): string {
  if (sectionKey === "by_jurisdiction") return "By jurisdiction";
  if (sectionKey === "by_category") return "By category";
  return sectionKey.replace(/_/g, " ");
}

export default function HealthScoreView({
  score,
  components,
  scoreBreakdown,
  reportText,
  error,
}: HealthScoreViewProps) {
  const hasComponents = components && typeof components === "object" && Object.keys(components).length > 0;
  const hasScoreBreakdown =
    scoreBreakdown &&
    typeof scoreBreakdown === "object" &&
    Object.keys(scoreBreakdown).length > 0;

  return (
    <div className="space-y-6">
      {/* Score display */}
      <div className="flex items-end gap-3 pb-5 border-b border-slate-100">
        {score != null ? (
          <>
            <span className="text-5xl font-bold text-slate-900">{score}</span>
            <span className="text-xl text-slate-400 mb-1">/ 100</span>
          </>
        ) : !error ? (
          <span className="text-slate-500 italic">Score unavailable</span>
        ) : null}
      </div>

      {/* Report text */}
      {reportText && reportText.trim() && (
        <div className="prose prose-sm max-w-none bg-slate-50 p-4 rounded-lg border border-slate-200">
          <ReactMarkdown remarkPlugins={[remarkBreaks]}>
            {formatReportContent(reportText)}
          </ReactMarkdown>
        </div>
      )}

      {/* Error */}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* Components */}
      {hasComponents && (
        <div>
          <h3 className="text-sm font-semibold text-slate-700 mb-3">Components</h3>
          <div className="grid grid-cols-2 gap-3">
            {Object.entries(components).map(([k, v]) => (
              <div key={k} className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                <p className="text-xs text-slate-500">{getComponentLabel(k)}</p>
                <p className="text-sm font-semibold text-slate-800 mt-0.5">
                  {formatComponentValue(v)}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Score breakdown */}
      {hasScoreBreakdown && (
        <div>
          <h3 className="text-sm font-semibold text-slate-700 mb-3">Score Breakdown</h3>
          {Object.entries(scoreBreakdown).map(([sectionKey, sectionVal]) => {
            if (
              typeof sectionVal !== "object" ||
              sectionVal === null ||
              Array.isArray(sectionVal)
            )
              return null;
            const entries = Object.entries(sectionVal as Record<string, unknown>);
            if (entries.length === 0) return null;
            const sectionLabel = getSectionLabel(sectionKey);
            return (
              <div key={sectionKey} className="mb-4">
                <p className="text-xs font-semibold text-slate-500 mb-2 uppercase tracking-wider">
                  {sectionLabel}
                </p>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <tbody className="divide-y divide-slate-100">
                      {entries.map(([k, v]) => (
                        <tr key={k}>
                          <td className="py-2 pr-4 text-slate-600 capitalize">
                            {k.replace(/_/g, " ")}
                          </td>
                          <td className="py-2 font-medium text-slate-800">
                            {formatComponentValue(v)}
                          </td>
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
  );
}
