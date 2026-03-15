import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDocuments, extractDocumentId } from "../hooks/useDocuments";
import { useWorkflowState, getMissingSteps } from "../hooks/useWorkflowState";
import ParseModal from "../components/ParseModal";
import { InfoIcon } from "../components/Tooltip";
import type { DocumentRecord, WorkflowState } from "../types/api";
import {
  Search,
  FileText,
  CheckCircle2,
  Circle,
  ListTree,
  Server,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

function toDisplayString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function formatDate(value?: string): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString();
}

export default function PoliciesPage() {
  const [listMode, setListMode] = useState<"policy" | "statute">("policy");
  const [documentSearch, setDocumentSearch] = useState("");
  const [parseTarget, setParseTarget] = useState<DocumentRecord | null>(null);

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

  const activeTab = listMode === "policy" ? "Policies" : "Statutes";

  return (
    <div className="p-8 max-w-6xl mx-auto w-full">
      <div className="flex justify-between items-start mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            Document Library
            <InfoIcon content="View and manage all gathered privacy documents. Documents must progress through parsing to 'Indexed' before they can be analyzed." />
          </h1>
          <p className="text-slate-500 mt-1 text-sm">
            Browse, filter, parse, and index your policies and statutes.
          </p>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={loading}
          className="flex items-center gap-2 bg-white border border-slate-300 rounded-md px-4 py-2 text-sm font-medium hover:bg-slate-50 text-slate-700 shadow-sm transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 p-3 rounded-lg text-sm mb-6">
          {error}
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 flex flex-col overflow-hidden">
        {/* Tabs & Search */}
        <div className="border-b border-slate-200 p-4 flex justify-between items-center bg-slate-50/50">
          <div className="flex space-x-2">
            {(["Policies", "Statutes"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() =>
                  setListMode(tab === "Policies" ? "policy" : "statute")
                }
                className={`text-sm font-medium px-4 py-2 rounded-lg transition-all ${
                  activeTab === tab
                    ? "bg-indigo-100 text-indigo-700 shadow-sm ring-1 ring-indigo-200"
                    : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
          <div className="relative w-64">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400 pointer-events-none" />
            <input
              type="text"
              value={documentSearch}
              onChange={(e) => setDocumentSearch(e.target.value)}
              placeholder="Search by title, entity, URL…"
              className="!w-full !pl-9 !pr-4 !py-2 text-sm !border !border-slate-300 !rounded-lg focus:!outline-none focus:!ring-2 focus:!ring-indigo-500/20 focus:!border-indigo-500 transition-all shadow-sm"
            />
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <th
                  scope="col"
                  className="px-6 py-4 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider"
                >
                  Document Title
                </th>
                <th
                  scope="col"
                  className="px-6 py-4 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider"
                >
                  Entity / Juris.
                </th>
                <th
                  scope="col"
                  className="px-6 py-4 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider"
                >
                  <div className="flex items-center gap-1.5">
                    Workflow Status
                    <InfoIcon content="Gathered: Raw text acquired. Parsed: Broken into semantic chunks. Indexed: Vectorized and ready for AI-powered compliance analysis." />
                  </div>
                </th>
                <th
                  scope="col"
                  className="px-6 py-4 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider"
                >
                  Date Added
                </th>
                <th scope="col" className="relative px-6 py-4">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center">
                    <div className="flex items-center justify-center gap-3 text-slate-500 text-sm">
                      <div className="h-4 w-4 border-2 border-slate-300 border-t-indigo-500 rounded-full animate-spin" />
                      Loading documents…
                    </div>
                  </td>
                </tr>
              ) : filteredDocuments.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-6 py-12 text-center text-slate-500 text-sm"
                  >
                    No documents found. Try refreshing or adjust the search
                    filter.
                  </td>
                </tr>
              ) : (
                filteredDocuments.map((doc, index) => (
                  <DocumentRow
                    key={`${doc.source_url || doc.title || "doc"}-${index}`}
                    doc={doc}
                    mode={listMode}
                    onRunCompliance={
                      listMode === "policy" ? handleRunCompliance : undefined
                    }
                    onViewChunks={() => setParseTarget(doc)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>

        {!loading && (
          <div className="px-6 py-3 bg-slate-50/50 border-t border-slate-200 text-xs text-slate-500">
            Showing {filteredDocuments.length} of {documents.length} documents
          </div>
        )}
      </div>

      {parseTarget && (
        <ParseModal
          doc={parseTarget}
          mode={listMode}
          onClose={() => setParseTarget(null)}
        />
      )}
    </div>
  );
}

/* ─── Table Row ─── */

function DocumentRow({
  doc,
  mode,
  onRunCompliance,
  onViewChunks,
}: {
  doc: DocumentRecord;
  mode: "policy" | "statute";
  onRunCompliance?: (doc: DocumentRecord) => void;
  onViewChunks?: (doc: DocumentRecord) => void;
}) {
  const docId = extractDocumentId(doc);
  const { state: workflowState } = useWorkflowState(docId || null, mode);
  const missingSteps = getMissingSteps(workflowState);
  const readyForCompliance = workflowState?.ready_for_compliance ?? false;

  const isIndexed = workflowState?.steps?.vector_indexed?.completed;
  const isParsed = workflowState?.steps?.parsed?.completed;

  const entity =
    mode === "statute"
      ? doc.jurisdiction || "—"
      : doc.company_name || "—";

  const truncatedId = docId
    ? docId.length > 12
      ? docId.slice(0, 12) + "…"
      : docId
    : "—";

  return (
    <tr className="hover:bg-slate-50/80 transition-colors group">
      {/* Title */}
      <td className="px-6 py-4">
        <div className="flex items-center">
          <div
            className={`p-2 rounded-lg mr-3 flex-shrink-0 ${
              mode === "policy"
                ? "bg-blue-50 text-blue-600"
                : "bg-amber-50 text-amber-600"
            }`}
          >
            <FileText className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-900 group-hover:text-indigo-600 transition-colors truncate">
              {doc.title || "Untitled document"}
            </div>
            <div className="text-xs text-slate-500 mt-0.5 font-mono truncate">
              {truncatedId} &middot;{" "}
              {mode === "policy" ? "Policy" : "Statute"}
              {doc.text_length
                ? ` · ${doc.text_length.toLocaleString()} chars`
                : ""}
            </div>
          </div>
        </div>
      </td>

      {/* Entity */}
      <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-700 font-medium">
        {entity}
      </td>

      {/* Workflow Status */}
      <td className="px-6 py-4 whitespace-nowrap">
        <StatusBadge workflowState={workflowState} />
      </td>

      {/* Date */}
      <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">
        {formatDate(doc.gathered_at)}
      </td>

      {/* Actions */}
      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
        <div className="flex items-center justify-end gap-2">
          {onViewChunks && (
            <button
              type="button"
              onClick={() => onViewChunks(doc)}
              className="text-blue-600 hover:text-blue-900 bg-blue-50 hover:bg-blue-100 px-3 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5 transition-colors border border-blue-100"
            >
              <ListTree className="h-3 w-3" /> View / Parse
            </button>
          )}
          {isIndexed && mode === "policy" && onRunCompliance && (
            <button
              type="button"
              onClick={() => onRunCompliance(doc)}
              disabled={!readyForCompliance}
              title={
                readyForCompliance
                  ? "Run compliance analysis"
                  : `Complete: ${missingSteps.join(", ")}`
              }
              className="text-indigo-600 hover:text-indigo-900 bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5 transition-colors border border-indigo-100 disabled:opacity-40"
            >
              <ShieldCheck className="h-3 w-3" /> Analyze
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function StatusBadge({
  workflowState,
}: {
  workflowState: WorkflowState | null;
}) {
  const isReady = workflowState?.ready_for_compliance ?? false;
  const isIndexed = workflowState?.steps?.vector_indexed?.completed;
  const isParsed = workflowState?.steps?.parsed?.completed;

  if (isReady) {
    return (
      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 shadow-sm">
        <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
        Ready
      </span>
    );
  }
  if (isIndexed) {
    return (
      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200 shadow-sm">
        <AlertTriangle className="w-3.5 h-3.5 mr-1.5" />
        Indexed (incomplete)
      </span>
    );
  }
  if (isParsed) {
    return (
      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 shadow-sm">
        <Circle className="w-3.5 h-3.5 mr-1.5 fill-blue-500 text-blue-500" />
        Parsed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700 border border-slate-200 shadow-sm">
      <Circle className="w-3.5 h-3.5 mr-1.5 text-slate-400" />
      Gathered
    </span>
  );
}

