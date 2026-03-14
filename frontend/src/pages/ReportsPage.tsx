import { useState, useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import { normalizeApiError } from "../api/client";
import { formatReportContent } from "../utils/formatReportContent";
import { useDocuments, extractDocumentId } from "../hooks/useDocuments";
import type { DocumentRecord } from "../types/api";
import { InfoIcon } from "../components/Tooltip";
import {
  FileUp,
  Eye,
  FileText,
  CheckCircle2,
  Download,
  XCircle,
} from "lucide-react";

export default function ReportsPage() {
  const location = useLocation();
  const policyFromState = (location.state as { policy?: DocumentRecord })?.policy;
  const previewRef = useRef<HTMLDivElement>(null);
  const reportContentRef = useRef<HTMLDivElement>(null);

  const { documents } = useDocuments("policy");

  const [selectedPolicy, setSelectedPolicy] = useState<DocumentRecord | null>(
    policyFromState ?? null
  );
  const [format, setFormat] = useState<"markdown" | "pdf">("markdown");
  const [source, setSource] = useState<"latest_stored" | "run_now">(
    "latest_stored"
  );
  const [includeGap, setIncludeGap] = useState(true);
  const [includeHealthScore, setIncludeHealthScore] = useState(true);
  const [includeMultiJurisdictional, setIncludeMultiJurisdictional] =
    useState(false);
  const [applicableJurisdictions, setApplicableJurisdictions] = useState("");

  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const policyId = selectedPolicy ? extractDocumentId(selectedPolicy) : "";

  useEffect(() => {
    if (policyFromState && !selectedPolicy) {
      setSelectedPolicy(policyFromState);
    }
  }, [policyFromState, selectedPolicy]);

  const policyOptions = (() => {
    const fromDocs = documents.map((d) => ({
      doc: d,
      id: extractDocumentId(d),
    }));
    if (
      selectedPolicy &&
      policyId &&
      !fromDocs.some((p) => p.id === policyId)
    ) {
      return [{ doc: selectedPolicy, id: policyId }, ...fromDocs];
    }
    return fromDocs;
  })();

  const handleGenerate = async () => {
    if (!policyId) return;
    setLoading(true);
    setError(null);
    setContent(null);
    try {
      const body: Record<string, unknown> = {
        policy_document_id: policyId,
        format: "markdown",
        source,
        include_gap: includeGap,
        include_health_score: includeHealthScore,
        include_multi_jurisdictional: includeMultiJurisdictional,
      };
      if (source === "run_now" && applicableJurisdictions.trim()) {
        body.applicable_jurisdictions = applicableJurisdictions
          .split(/[,;\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);
      }

      const res = await fetch("/api/compliance/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(
          (err as { error?: string }).error || res.statusText || "Request failed"
        );
      }
      const data = (await res.json()) as { content?: string; format?: string };
      setContent(data.content || "");
      setTimeout(() => previewRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    } catch (err) {
      setError(normalizeApiError(err) || "Failed to generate report.");
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async () => {
    if (!content) return;
    if (format === "pdf") {
      const element = reportContentRef.current;
      if (!element) return;
      try {
        const { default: html2pdf } = await import("html2pdf.js");
        await html2pdf()
          .set({
            margin: 12,
            filename: `compliance-report-${policyId}.pdf`,
            image: { type: "jpeg", quality: 0.98 },
            html2canvas: { scale: 2 },
            jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
          })
          .from(element)
          .save();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to generate PDF.");
      }
    } else {
      const blob = new Blob([content], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `compliance-report-${policyId}.md`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const handlePreview = () => {
    if (content) {
      previewRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  };

  const isRunNow = source === "run_now";
  const selectedCount = [includeGap, includeHealthScore, includeMultiJurisdictional].filter(Boolean).length;

  const sections = [
    { id: "health", label: "Executive Summary (Health Score)", checked: includeHealthScore, onChange: setIncludeHealthScore },
    { id: "gap", label: "Detailed Gap Analysis Findings", checked: includeGap, onChange: setIncludeGap },
    { id: "multi", label: "Multi-Jurisdictional Conflicts", checked: includeMultiJurisdictional, onChange: setIncludeMultiJurisdictional },
  ];

  return (
    <div className="p-8 max-w-5xl mx-auto w-full">
      {/* Page header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          Report Generation
          <InfoIcon content="Compile compliance engine results into professional executive summaries or detailed audit reports. Output to PDF or Markdown." />
        </h1>
        <p className="text-slate-500 mt-1 text-sm">
          Configure and export assessment reports based on saved runs or live analysis.
        </p>
      </div>

      {/* Configuration card */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-6 border-b border-slate-100 bg-slate-50/50">
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <FileText className="h-5 w-5 text-indigo-500" />
            Report Configuration
          </h2>
        </div>

        <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-8">
          {/* Left column */}
          <div className="space-y-6">
            {/* Policy select */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-2">
                Select Policy Document
              </label>
              <select
                value={policyId || ""}
                onChange={(e) => {
                  const id = e.target.value;
                  const opt = policyOptions.find((p) => p.id === id);
                  setSelectedPolicy(opt?.doc ?? null);
                }}
                className="w-full rounded-lg border border-slate-300 px-4 py-2.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 shadow-sm transition-all bg-white"
              >
                <option value="">Select a policy…</option>
                {policyOptions.map(({ doc, id }) => (
                  <option key={id} value={id}>
                    {doc.title || doc.company_name || id}
                  </option>
                ))}
              </select>
            </div>

            {/* Data source */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-3">
                Data Source
              </label>
              <div className="space-y-3">
                <label className="flex items-start gap-3 p-3 rounded-lg border border-slate-200 hover:border-indigo-200 hover:bg-slate-50 transition-colors cursor-pointer group">
                  <input
                    type="radio"
                    name="source"
                    checked={source === "latest_stored"}
                    onChange={() => setSource("latest_stored")}
                    className="mt-0.5 text-indigo-600 focus:ring-indigo-500 border-slate-300"
                  />
                  <div>
                    <div className="text-sm font-medium text-slate-900 group-hover:text-indigo-900">
                      Latest Stored Analysis Result
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5 leading-relaxed">
                      Uses the most recent compliance engine run from the database. Faster, no re-processing needed.
                    </div>
                  </div>
                </label>
                <label className="flex items-start gap-3 p-3 rounded-lg border border-slate-200 hover:border-indigo-200 hover:bg-slate-50 transition-colors cursor-pointer group">
                  <input
                    type="radio"
                    name="source"
                    checked={source === "run_now"}
                    onChange={() => setSource("run_now")}
                    className="mt-0.5 text-indigo-600 focus:ring-indigo-500 border-slate-300"
                  />
                  <div>
                    <div className="text-sm font-medium text-slate-900 group-hover:text-indigo-900">
                      Run Analysis Now (Live Mode)
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5 leading-relaxed">
                      Executes fresh engine runs instantly without persisting history. May take longer.
                    </div>
                  </div>
                </label>
              </div>
            </div>

            {/* Output format */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-2">
                Output Format
              </label>
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value as "markdown" | "pdf")}
                className="w-full rounded-lg border border-slate-300 px-4 py-2.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 shadow-sm transition-all bg-white"
              >
                <option value="pdf">PDF Document (.pdf)</option>
                <option value="markdown">Markdown File (.md)</option>
              </select>
            </div>
          </div>

          {/* Right column */}
          <div className="space-y-6 md:border-l md:border-slate-100 md:pl-12">
            {/* Include sections */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-3 flex items-center justify-between">
                <span>Include Sections</span>
                <span className="text-xs font-normal text-slate-500">
                  {selectedCount} selected
                </span>
              </label>
              <div className="space-y-3 bg-slate-50 p-4 rounded-xl border border-slate-100">
                {sections.map((section) => (
                  <label
                    key={section.id}
                    className="flex items-center gap-3 text-sm text-slate-700 cursor-pointer group"
                  >
                    <input
                      type="checkbox"
                      checked={section.checked}
                      onChange={(e) => section.onChange(e.target.checked)}
                      className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-4 h-4 transition-all"
                    />
                    <span className="font-medium group-hover:text-indigo-700 transition-colors">
                      {section.label}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* Target jurisdictions */}
            <div className={isRunNow ? "" : "opacity-50"}>
              <label className="block text-sm font-semibold text-slate-700 mb-2 flex items-center gap-1.5">
                Target Jurisdictions
                <InfoIcon content="Only required if 'Run Analysis Now' is selected. Comma-separated, e.g. CA, VA, GDPR." />
              </label>
              <input
                type="text"
                value={applicableJurisdictions}
                onChange={(e) => setApplicableJurisdictions(e.target.value)}
                disabled={!isRunNow}
                placeholder="e.g. CA, VA, GDPR"
                className={`w-full rounded-lg border border-slate-300 px-4 py-2.5 text-sm shadow-sm transition-all ${
                  isRunNow
                    ? "bg-white focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                    : "bg-slate-50 text-slate-500 cursor-not-allowed"
                }`}
              />
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="mx-6 mb-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
            <XCircle className="h-5 w-5 text-red-500 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        {/* Action bar */}
        <div className="p-6 border-t border-slate-100 bg-slate-50 flex items-center gap-4">
          <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={!policyId || loading}
            className="flex flex-1 md:flex-none justify-center items-center gap-2 bg-indigo-600 text-white rounded-lg px-6 py-3 text-sm font-semibold hover:bg-indigo-700 transition-all shadow-sm disabled:opacity-70 disabled:cursor-not-allowed"
          >
            {loading ? (
              <span className="flex items-center gap-2 animate-pulse">
                Generating Report…
              </span>
            ) : content ? (
              <span className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4" /> Regenerate Report
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <FileUp className="h-4 w-4" /> Generate Report
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={handlePreview}
            disabled={!content || loading}
            className="flex justify-center items-center gap-2 bg-white border border-slate-300 text-slate-700 rounded-lg px-5 py-3 text-sm font-semibold hover:bg-slate-50 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Eye className="h-4 w-4" /> Preview Draft
          </button>

          {content && (
            <button
              type="button"
              onClick={() => void handleDownload()}
              className="flex justify-center items-center gap-2 bg-white border border-slate-300 text-slate-700 rounded-lg px-5 py-3 text-sm font-semibold hover:bg-slate-50 transition-colors shadow-sm"
            >
              <Download className="h-4 w-4" /> Download {format === "pdf" ? ".pdf" : ".md"}
            </button>
          )}
        </div>
      </div>

      {/* Preview section */}
      {content && (
        <div ref={previewRef} className="mt-8 bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 bg-slate-50/50 flex items-center justify-between">
            <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
              <Eye className="h-5 w-5 text-indigo-500" />
              Report Preview
            </h2>
            <button
              type="button"
              onClick={() => void handleDownload()}
              className="flex items-center gap-2 text-sm font-semibold text-indigo-700 bg-indigo-50 border border-indigo-100 px-4 py-2 rounded-lg hover:bg-indigo-100 transition-colors"
            >
              <Download className="h-4 w-4" /> Download {format === "pdf" ? ".pdf" : ".md"}
            </button>
          </div>
          <div
            ref={reportContentRef}
            className="p-6 prose prose-sm prose-slate max-w-none reports-preview-markdown"
          >
            <ReactMarkdown remarkPlugins={[remarkBreaks]}>
              {formatReportContent(content)}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}
