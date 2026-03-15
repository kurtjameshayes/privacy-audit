import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import { formatReportContent } from "../utils/formatReportContent";

export default function RiskAssessmentResultView({
  result,
}: {
  result: Record<string, unknown>;
}) {
  const assessment = result.assessment as Record<string, unknown> | undefined;
  const report = result.report as string | undefined;
  const dataCategories = (assessment?.data_categories as string[] | undefined) ?? [];
  const processingPurposes = (assessment?.processing_purposes as string[] | undefined) ?? [];
  const risks = (assessment?.risks as Array<{ description?: string; mitigation?: string; severity?: string }> | undefined) ?? [];
  const gapsFromStatute = (assessment?.gaps_from_statute as Array<{ jurisdiction?: string; requirement?: string; status?: string }> | undefined) ?? [];
  const mitigations = (assessment?.mitigations as string[] | undefined) ?? [];

  const severityStyles: Record<string, string> = {
    high: "bg-red-100 text-red-700 border-red-200",
    medium: "bg-amber-100 text-amber-700 border-amber-200",
    low: "bg-slate-100 text-slate-700 border-slate-200",
  };

  return (
    <div className="space-y-6">
      {report && (
        <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
          <h3 className="text-sm font-semibold text-slate-700 mb-2">Report</h3>
          <div className="prose prose-sm prose-slate max-w-none reports-preview-markdown text-slate-800">
            <ReactMarkdown remarkPlugins={[remarkBreaks]}>
              {formatReportContent(String(report))}
            </ReactMarkdown>
          </div>
        </div>
      )}
      {assessment && (
        <>
          {dataCategories.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-slate-700 mb-2">Data Categories</h3>
              <div className="flex flex-wrap gap-2">
                {dataCategories.map((cat, i) => (
                  <span key={i} className="px-2.5 py-1 rounded-md text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-100">
                    {cat}
                  </span>
                ))}
              </div>
            </div>
          )}
          {processingPurposes.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-slate-700 mb-2">Processing Purposes</h3>
              <ul className="list-disc list-inside space-y-1 text-sm text-slate-700">
                {processingPurposes.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          {risks.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-slate-700 mb-2">Risks</h3>
              <div className="space-y-3">
                {risks.map((r, i) => (
                  <div key={i} className="p-4 rounded-lg border border-slate-200 bg-white shadow-sm">
                    <div className="flex items-start gap-2">
                      <span className={`px-2 py-0.5 rounded text-xs font-semibold border shrink-0 ${severityStyles[r.severity ?? "low"] ?? severityStyles.low}`}>
                        {(r.severity ?? "low").toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-slate-800">{r.description}</p>
                        {r.mitigation && (
                          <p className="text-xs text-slate-600 mt-2 pt-2 border-t border-slate-100">
                            <span className="font-medium text-slate-700">Mitigation:</span> {r.mitigation}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {gapsFromStatute.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-slate-700 mb-2">Gaps from Statute</h3>
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500 uppercase">Jurisdiction</th>
                      <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500 uppercase">Requirement</th>
                      <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500 uppercase">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {gapsFromStatute.map((g, i) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="px-4 py-2 text-slate-700 font-medium">{g.jurisdiction ?? "—"}</td>
                        <td className="px-4 py-2 text-slate-700">{g.requirement ?? "—"}</td>
                        <td className="px-4 py-2">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${g.status === "missing" ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-600"}`}>
                            {g.status ?? "—"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {mitigations.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-slate-700 mb-2">Mitigations</h3>
              <ol className="list-decimal list-inside space-y-1.5 text-sm text-slate-700">
                {mitigations.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ol>
            </div>
          )}
        </>
      )}
    </div>
  );
}
