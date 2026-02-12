import { useMemo, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { normalizeApiError } from "../api/client";
import { useDocuments, extractDocumentId } from "../hooks/useDocuments";
import DocumentCard from "../components/DocumentCard";
import ParseModal from "../components/ParseModal";
import type { DocumentRecord } from "../types/api";

const modeContent = {
  policy: { label: "Policies" as const },
  statute: { label: "Statutes" as const },
};

function toDisplayString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

export default function PoliciesPage() {
  const [listMode, setListMode] = useState<"policy" | "statute">("policy");
  const [documentSearch, setDocumentSearch] = useState("");
  const [parseTarget, setParseTarget] = useState<DocumentRecord | null>(null);
  const [citationsTarget, setCitationsTarget] = useState<DocumentRecord | null>(null);
  const [reportTarget, setReportTarget] = useState<DocumentRecord | null>(null);
  const [riskTarget, setRiskTarget] = useState<DocumentRecord | null>(null);

  const navigate = useNavigate();
  const { documents, loading, error, refetch } = useDocuments(listMode);

  const filteredDocuments = useMemo(() => {
    const search = documentSearch.trim().toLowerCase();
    if (!search) return documents;
    return documents.filter((doc) => {
      const haystack = [
        doc.title,
        doc.company_name,
        doc.jurisdiction,
        doc.description,
        doc.source_url,
        doc.query,
        doc.text,
      ]
        .map(toDisplayString)
        .join(" ")
        .toLowerCase();
      return haystack.includes(search);
    });
  }, [documentSearch, documents]);

  const handleRunCompliance = (doc: DocumentRecord) => {
    navigate("/compliance", { state: { policy: doc } });
  };

  const handleExtractCitations = (doc: DocumentRecord) => {
    setCitationsTarget(doc);
  };

  const handleGenerateReport = (doc: DocumentRecord) => {
    navigate("/reports", { state: { policy: doc } });
  };

  const handleRiskAssessment = (doc: DocumentRecord) => {
    setRiskTarget(doc);
  };

  return (
    <>
      <header className="main-header">
        <div>
          <p className="eyebrow">Policies</p>
          <h2>Document library</h2>
          <p className="subtitle">
            Browse stored policies and statutes. Run compliance, extract
            citations, generate reports, or view parsed chunks.
          </p>
        </div>
        <div className="header-card">
          <p className="header-card-title">Stored documents</p>
          <p className="header-card-value">
            {documents.length ? documents.length : "—"}
          </p>
          <p className="header-card-caption">Available in this list</p>
        </div>
      </header>
      <div className="context-strip">
        <span className="context-strip-item">Document library</span>
        <span className="context-strip-item">
          {modeContent[listMode].label}
        </span>
      </div>

      <section className="results-panel">
        <div className="panel-header list-header">
          <div>
            <p className="panel-title">Document library</p>
            <p className="panel-subtitle">
              {loading
                ? "Loading documents…"
                : `${filteredDocuments.length} of ${documents.length} documents shown.`}
              {listMode === "policy" && documents.length > 0
                ? " Use card actions to run compliance, extract citations, or generate reports."
                : ""}
            </p>
          </div>
          <div className="mode-toggle">
            {(["policy", "statute"] as const).map((item) => (
              <button
                key={item}
                className={`mode-button ${listMode === item ? "is-active" : ""}`}
                type="button"
                onClick={() => setListMode(item)}
              >
                {modeContent[item].label}
              </button>
            ))}
          </div>
        </div>

        <div className="list-controls">
          <div className="list-search">
            <label className="field-label" htmlFor="document-search">
              Search listed documents
            </label>
            <input
              id="document-search"
              type="text"
              value={documentSearch}
              onChange={(e) => setDocumentSearch(e.target.value)}
              placeholder="Search by title, company, URL, or text"
            />
          </div>
          <button
            type="button"
            className="ghost-button"
            onClick={() => refetch()}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh list"}
          </button>
        </div>

        {error ? (
          <div className="error-banner list-error">
            <span className="error-text">{error}</span>
          </div>
        ) : null}

        <div className="results-grid">
          {loading ? (
            <div className="loading-state list-loading">
              <span className="loader" />
              Loading documents…
            </div>
          ) : filteredDocuments.length === 0 ? (
            <div className="empty-state">
              <p>No documents yet.</p>
              <span>Try refreshing or adjust the local search filter.</span>
            </div>
          ) : (
            filteredDocuments.map((doc, index) => (
              <DocumentCard
                key={`${doc.source_url || doc.title || "doc"}-${index}`}
                doc={doc}
                mode={listMode}
                onRunCompliance={
                  listMode === "policy" ? handleRunCompliance : undefined
                }
                onExtractCitations={
                  listMode === "policy" ? handleExtractCitations : undefined
                }
                onGenerateReport={
                  listMode === "policy" ? handleGenerateReport : undefined
                }
                onRiskAssessment={
                  listMode === "policy" ? handleRiskAssessment : undefined
                }
                onViewChunks={() => setParseTarget(doc)}
              />
            ))
          )}
        </div>
      </section>

      {parseTarget && (
        <ParseModal
          doc={parseTarget}
          mode={listMode}
          onClose={() => setParseTarget(null)}
        />
      )}

      {citationsTarget && (
        <CitationsModal
          doc={citationsTarget}
          onClose={() => setCitationsTarget(null)}
        />
      )}

      {riskTarget && (
        <RiskAssessmentModal
          doc={riskTarget}
          onClose={() => setRiskTarget(null)}
        />
      )}
    </>
  );
}

function CitationsModal({
  doc,
  onClose,
}: {
  doc: DocumentRecord;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{
    citations: Array<{
      policy_excerpt?: string;
      statute_reference?: string;
      statute_excerpt?: string;
      alignment?: boolean;
      jurisdiction?: string;
    }>;
    summary?: { aligned?: number; not_aligned?: number; total_citations?: number };
  } | null>(null);
  const docId = extractDocumentId(doc);

  const handleRun = async () => {
    if (!docId) return;
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch("/api/compliance/citations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy_document_id: docId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(
          (err as { error?: string }).error || res.statusText || "Request failed"
        );
      }
      const result = await res.json();
      setData(result);
    } catch (err) {
      setError(normalizeApiError(err) || "Failed to extract citations.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        <div className="modal-header">
          <div>
            <p className="modal-title">Extract citations</p>
            <p className="modal-subtitle">
              {doc.title || doc.company_name || "Policy"} · ID {docId}
            </p>
          </div>
          <div className="modal-actions">
            <button className="ghost-button" type="button" onClick={onClose}>
              Close
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={handleRun}
              disabled={loading}
            >
              {loading ? "Extracting…" : "Extract"}
            </button>
          </div>
        </div>
        <div className="modal-body">
          {error ? (
            <div className="error-banner">
              <span className="error-text">{error}</span>
            </div>
          ) : data ? (
            <>
              {data.summary && (
                <div className="citations-summary">
                  <p>
                    Aligned: {data.summary.aligned ?? 0} · Not aligned:{" "}
                    {data.summary.not_aligned ?? 0} · Total:{" "}
                    {data.summary.total_citations ?? 0}
                  </p>
                </div>
              )}
              <div className="citations-list">
                {data.citations?.map((c, i) => (
                  <article key={i} className="citation-item">
                    <p className="citation-statute">{c.statute_reference || "—"}</p>
                    <p className="citation-policy">{c.policy_excerpt || "—"}</p>
                    <span
                      className={`citation-badge ${
                        c.alignment ? "aligned" : "not-aligned"
                      }`}
                    >
                      {c.alignment ? "Aligned" : "Not aligned"}
                    </span>
                  </article>
                ))}
              </div>
            </>
          ) : (
            <p className="subtitle">
              Click Extract to run statute–policy citation extraction.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function RiskAssessmentModal({
  doc,
  onClose,
}: {
  doc: DocumentRecord;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{
    assessment?: Record<string, unknown>;
    report?: string;
  } | null>(null);
  const [templates, setTemplates] = useState<Array<{ id: string; label: string }>>(
    []
  );
  const [templateId, setTemplateId] = useState("");
  const [includeReport, setIncludeReport] = useState(false);
  const docId = extractDocumentId(doc);

  useEffect(() => {
    fetch("/api/compliance/risk-assessment/templates")
      .then((r) => r.ok ? r.json() : null)
      .then((res: { templates?: Array<{ id: string; label: string }> } | null) => {
        if (res?.templates) setTemplates(res.templates);
      })
      .catch(() => {});
  }, []);

  const handleRun = async () => {
    if (!docId) return;
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const body: Record<string, unknown> = {
        policy_document_id: docId,
        include_report: includeReport,
      };
      if (templateId) body.template_id = templateId;

      const res = await fetch("/api/compliance/risk-assessment", {
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
      const result = await res.json();
      setData(result);
    } catch (err) {
      setError(normalizeApiError(err) || "Failed to run risk assessment.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        <div className="modal-header">
          <div>
            <p className="modal-title">Risk assessment</p>
            <p className="modal-subtitle">
              {doc.title || doc.company_name || "Policy"} · ID {docId}
            </p>
          </div>
          <div className="modal-actions">
            <button className="ghost-button" type="button" onClick={onClose}>
              Close
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={handleRun}
              disabled={loading}
            >
              {loading ? "Running…" : "Run assessment"}
            </button>
          </div>
        </div>
        <div className="modal-body">
          {templates.length > 0 && (
            <div className="field-group" style={{ marginBottom: 12 }}>
              <label className="field-label">Template</label>
              <select
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
              >
                <option value="">Default</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <label className="risk-include-report">
            <input
              type="checkbox"
              checked={includeReport}
              onChange={(e) => setIncludeReport(e.target.checked)}
            />
            Include report
          </label>

          {error ? (
            <div className="error-banner">
              <span className="error-text">{error}</span>
            </div>
          ) : data ? (
            <>
              {data.report && (
                <div className="risk-report">
                  <pre>{data.report}</pre>
                </div>
              )}
              {data.assessment && (
                <div className="risk-assessment">
                  <pre>{JSON.stringify(data.assessment, null, 2)}</pre>
                </div>
              )}
            </>
          ) : (
            <p className="subtitle">
              Click Run assessment to generate a DPIA/PIA-style risk assessment.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
