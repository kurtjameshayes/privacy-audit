import type { DocumentRecord } from "../types/api";
import { extractDocumentId } from "../hooks/useDocuments";
import { useWorkflowState, getMissingSteps } from "../hooks/useWorkflowState";

function toDisplayString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function formatDate(value?: string): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

interface DocumentCardProps {
  doc: DocumentRecord;
  mode: "policy" | "statute";
  onRunCompliance?: (doc: DocumentRecord) => void;
  onExtractCitations?: (doc: DocumentRecord) => void;
  onGenerateReport?: (doc: DocumentRecord) => void;
  onRiskAssessment?: (doc: DocumentRecord) => void;
  onViewChunks?: (doc: DocumentRecord) => void;
}

export default function DocumentCard({
  doc,
  mode,
  onRunCompliance,
  onExtractCitations,
  onGenerateReport,
  onRiskAssessment,
  onViewChunks,
}: DocumentCardProps) {
  const docId = extractDocumentId(doc);
  const { state: workflowState } = useWorkflowState(docId || null, mode);
  const missingSteps = getMissingSteps(workflowState);
  const readyForCompliance = workflowState?.ready_for_compliance ?? false;

  const subtitle =
    mode === "statute"
      ? doc.jurisdiction || doc.description || "No description available."
      : doc.company_name || doc.description || "No description available.";

  return (
    <article className="result-card document-card">
      <div className="result-header">
        <div>
          <h3>{doc.title || "Untitled document"}</h3>
          <p>{subtitle}</p>
        </div>
        <div className="score-stack">
          <span className="score-pill">
            {doc.text_length ? `${doc.text_length} chars` : "—"}
          </span>
          <span className="score-caption">
            {formatDate(doc.gathered_at)}
          </span>
        </div>
      </div>
      <div className="workflow-badges">
        <span
          className={`workflow-badge ${workflowState?.steps?.gathered?.completed ? "completed" : ""}`}
          title={workflowState?.steps?.gathered?.completed ? "Gathered" : "Not gathered"}
        >
          Gathered
        </span>
        <span
          className={`workflow-badge ${workflowState?.steps?.parsed?.completed ? "completed" : ""}`}
          title={workflowState?.steps?.parsed?.completed ? "Parsed" : "Not parsed"}
        >
          Parsed
        </span>
        <span
          className={`workflow-badge ${workflowState?.steps?.vector_indexed?.completed ? "completed" : ""}`}
          title={workflowState?.steps?.vector_indexed?.completed ? "Indexed" : "Not indexed"}
        >
          Indexed
        </span>
      </div>
      <div className="result-footer">
        <span className="result-url">
          {doc.source_url ||
            toDisplayString((doc as Record<string, unknown>).url) ||
            "No source URL"}
        </span>
        <div className="document-actions">
          <span className="document-tag">
            {mode === "policy" ? "Policy" : "Statute"}
          </span>
          {mode === "policy" && onRunCompliance && (
            <button
              type="button"
              className="ghost-button card-action-arrow"
              onClick={() => onRunCompliance(doc)}
              disabled={!readyForCompliance}
              title={
                readyForCompliance
                  ? "Run compliance analysis"
                  : `Complete these steps first: ${missingSteps.join(", ")}`
              }
            >
              Run compliance
            </button>
          )}
          {mode === "policy" && onExtractCitations && (
            <button
              type="button"
              className="ghost-button card-action-arrow"
              onClick={() => onExtractCitations(doc)}
              disabled={!readyForCompliance}
              title={
                readyForCompliance
                  ? "Extract citations"
                  : `Complete these steps first: ${missingSteps.join(", ")}`
              }
            >
              Extract citations
            </button>
          )}
          {mode === "policy" && onGenerateReport && (
            <button
              type="button"
              className="ghost-button card-action-arrow"
              onClick={() => onGenerateReport(doc)}
              disabled={!readyForCompliance}
              title={
                readyForCompliance
                  ? "Generate report"
                  : `Complete these steps first: ${missingSteps.join(", ")}`
              }
            >
              Generate report
            </button>
          )}
          {mode === "policy" && onRiskAssessment && (
            <button
              type="button"
              className="ghost-button card-action-arrow"
              onClick={() => onRiskAssessment(doc)}
              disabled={!readyForCompliance}
              title={
                readyForCompliance
                  ? "Risk assessment"
                  : `Complete these steps first: ${missingSteps.join(", ")}`
              }
            >
              Risk assessment
            </button>
          )}
          {onViewChunks && (
            <button
              type="button"
              className="ghost-button card-action-arrow"
              onClick={() => onViewChunks(doc)}
            >
              View chunks
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
