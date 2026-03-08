import { useState, useEffect } from "react";
import { useLocation } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { normalizeApiError } from "../api/client";
import { useDocuments, extractDocumentId } from "../hooks/useDocuments";
import type { DocumentRecord } from "../types/api";

export default function ReportsPage() {
  const location = useLocation();
  const policyFromState = (location.state as { policy?: DocumentRecord })?.policy;

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
        format,
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
    } catch (err) {
      setError(normalizeApiError(err) || "Failed to generate report.");
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = () => {
    if (!content) return;
    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `compliance-report-${policyId}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <header className="main-header">
        <div>
          <p className="eyebrow">Reports</p>
          <h2>Generate compliance report</h2>
          <p className="subtitle">
            Export gap list, health score, and multi-jurisdictional summary as
            Markdown or PDF.
          </p>
        </div>
      </header>

      <section className="reports-panel">
        <div className="panel-header">
          <p className="panel-title">Report options</p>
        </div>
        <div className="reports-form">
          <div className="field-group">
            <label className="field-label" htmlFor="report-policy">
              Policy
            </label>
            <select
              id="report-policy"
              value={policyId || ""}
              onChange={(e) => {
                const id = e.target.value;
                const opt = policyOptions.find((p) => p.id === id);
                setSelectedPolicy(opt?.doc ?? null);
              }}
            >
              <option value="">Select a policy…</option>
              {policyOptions.map(({ doc, id }) => (
                <option key={id} value={id}>
                  {doc.title || doc.company_name || id}
                </option>
              ))}
            </select>
          </div>

          <div className="field-group">
            <label className="field-label" htmlFor="report-format">
              Format
            </label>
            <select
              id="report-format"
              value={format}
              onChange={(e) =>
                setFormat(e.target.value as "markdown" | "pdf")
              }
            >
              <option value="markdown">Markdown</option>
              <option value="pdf">PDF</option>
            </select>
          </div>

          <div className="field-group">
            <label className="field-label" htmlFor="report-source">
              Source
            </label>
            <select
              id="report-source"
              value={source}
              onChange={(e) =>
                setSource(e.target.value as "latest_stored" | "run_now")
              }
            >
              <option value="latest_stored">Latest stored result</option>
              <option value="run_now">Run now (no persist)</option>
            </select>
          </div>

          {source === "run_now" && (
            <div className="field-group">
              <label className="field-label" htmlFor="report-jurisdictions">
                Applicable jurisdictions (comma-separated)
              </label>
              <input
                id="report-jurisdictions"
                type="text"
                value={applicableJurisdictions}
                onChange={(e) => setApplicableJurisdictions(e.target.value)}
                placeholder="e.g. CA, VA, CO"
              />
            </div>
          )}

          <div className="reports-checkboxes">
            <label>
              <input
                type="checkbox"
                checked={includeGap}
                onChange={(e) => setIncludeGap(e.target.checked)}
              />
              Include gap analysis
            </label>
            <label>
              <input
                type="checkbox"
                checked={includeHealthScore}
                onChange={(e) => setIncludeHealthScore(e.target.checked)}
              />
              Include Privacy Health Score
            </label>
            <label>
              <input
                type="checkbox"
                checked={includeMultiJurisdictional}
                onChange={(e) =>
                  setIncludeMultiJurisdictional(e.target.checked)
                }
              />
              Include multi-jurisdictional
            </label>
          </div>

          <button
            className="primary-button"
            type="button"
            onClick={handleGenerate}
            disabled={!policyId || loading}
          >
            {loading ? "Generating…" : "Generate report"}
          </button>
        </div>

        {error && (
          <div className="error-banner">
            <span className="error-text">{error}</span>
          </div>
        )}

        {content && (
          <div className="reports-preview">
            <div className="reports-preview-header">
              <h4>Preview</h4>
              <button
                className="ghost-button"
                type="button"
                onClick={handleDownload}
              >
                Download .md
              </button>
            </div>
            <div className="reports-preview-content reports-preview-markdown">
              <ReactMarkdown>{content}</ReactMarkdown>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
