import { useEffect, useState } from "react";
import { normalizeApiError } from "../api/client";
import type { DocumentRecord } from "../types/api";
import { extractDocumentId } from "../hooks/useDocuments";

interface ParsedDocItem {
  document_id?: string;
  parsed_header_text: string;
  parsed_text: string;
  [key: string]: unknown;
}

interface ChunkRecord {
  _id?: unknown;
  document_id?: unknown;
  chunk_index?: number | string;
  chunk_header_text?: string;
  chunk_text?: string;
  chunks?: Array<Record<string, unknown>>;
  timestamp?: string;
  [key: string]: unknown;
}

function toDisplayString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function extractResponseArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["documents", "data", "results", "items"]) {
      const arr = record[key];
      if (Array.isArray(arr)) return arr;
    }
  }
  return [];
}

function parseParsedDocResponse(data: unknown): ParsedDocItem[] {
  if (Array.isArray(data)) return data as ParsedDocItem[];
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.parsed_doc)) {
      return record.parsed_doc as ParsedDocItem[];
    }
  }
  return [];
}

function parseChunkDocumentsResponse(data: unknown): ParsedDocItem[] {
  const records = extractResponseArray(data) as ChunkRecord[];
  const sorted = [...records].sort((a, b) => {
    const ai = parseInt(toDisplayString(a?.chunk_index), 10);
    const bi = parseInt(toDisplayString(b?.chunk_index), 10);
    if (Number.isFinite(ai) && Number.isFinite(bi)) return ai - bi;
    const at = Date.parse(toDisplayString(a?.timestamp));
    const bt = Date.parse(toDisplayString(b?.timestamp));
    return Number.isNaN(bt) ? 1 : Number.isNaN(at) ? -1 : bt - at;
  });

  return sorted.flatMap((record) => {
    const docId =
      extractDocumentId(record.document_id) || extractDocumentId(record._id);
    const chunks = Array.isArray(record.chunks) ? record.chunks : [];
    if (chunks.length > 0) {
      return chunks.map((chunk) => ({
        ...chunk,
        document_id: toDisplayString(chunk.document_id) || docId,
        parsed_header_text: toDisplayString(chunk.chunk_header_text),
        parsed_text: toDisplayString(chunk.chunk_text),
      })) as ParsedDocItem[];
    }
    if (record.chunk_text || record.chunk_header_text) {
      return [
        {
          document_id: docId,
          parsed_header_text: toDisplayString(record.chunk_header_text),
          parsed_text: toDisplayString(record.chunk_text),
        },
      ] as ParsedDocItem[];
    }
    return [];
  });
}

const getParseKey = (item: ParsedDocItem, index: number) =>
  `${item.document_id}-${index}`;

const POLICY_CHUNK_COLLECTION = "policy_chunks";
const STATUTE_CHUNK_COLLECTION = "statute_chunks";

interface ParseModalProps {
  doc: DocumentRecord | null;
  mode: "policy" | "statute";
  onClose: () => void;
}

export default function ParseModal({
  doc,
  mode,
  onClose,
}: ParseModalProps) {
  const documentId = doc ? (doc.document_id || extractDocumentId(doc)) : "";
  const chunkCollection =
    mode === "policy" ? POLICY_CHUNK_COLLECTION : STATUTE_CHUNK_COLLECTION;
  const listCollection = mode === "policy" ? "policies" : "statutes";

  const [parsePrompt, setParsePrompt] = useState("");
  const [parseResults, setParseResults] = useState<ParsedDocItem[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [isLoadingParsed, setIsLoadingParsed] = useState(false);
  const [isSavingParsed, setIsSavingParsed] = useState(false);
  const [saveParsedMessage, setSaveParsedMessage] = useState<string | null>(
    null
  );
  const [parseSelections, setParseSelections] = useState<
    Record<string, boolean>
  >({});
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexMessage, setIndexMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!doc || !documentId) return;
    const load = async () => {
      setIsLoadingParsed(true);
      setParseError(null);
      setParseResults([]);
      try {
        const res = await fetch("/api/documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            database_name: "privacy-compliance",
            collection_name: chunkCollection,
            query: { document_id: documentId },
          }),
        });
        if (!res.ok) throw new Error(await res.text() || "Unable to load chunks.");
        const data = await res.json();
        setParseResults(parseChunkDocumentsResponse(data));
      } catch (err) {
        setParseError(normalizeApiError(err) || "Unable to load chunks.");
      } finally {
        setIsLoadingParsed(false);
      }
    };
    void load();
  }, [doc, documentId, chunkCollection]);

  useEffect(() => {
    setParseSelections((prev) => {
      if (parseResults.length === 0) return {};
      return parseResults.reduce<Record<string, boolean>>((acc, item, idx) => {
        acc[getParseKey(item, idx)] = prev[getParseKey(item, idx)] ?? true;
        return acc;
      }, {});
    });
  }, [parseResults]);

  const handleRunParse = async () => {
    if (!doc || !documentId || !parsePrompt.trim()) {
      setParseError("Please enter a parsing prompt.");
      return;
    }
    setIsParsing(true);
    setParseError(null);
    setSaveParsedMessage(null);
    try {
      const res = await fetch("/api/parse-llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          database_name: "privacy-compliance",
          collection_name: listCollection,
          document_id: documentId,
          prompt: parsePrompt.trim(),
        }),
      });
      if (!res.ok) throw new Error(await res.text() || "Unable to parse.");
      const data = await res.json();
      const parsed = parseParsedDocResponse(data);
      setParseResults(parsed);
      if (parsed.length === 0) setParseError("No parsed output returned.");
    } catch (err) {
      setParseError(normalizeApiError(err) || "Unable to parse document.");
    } finally {
      setIsParsing(false);
    }
  };

  const handleSaveParsed = async () => {
    if (!doc || !documentId || parseResults.length === 0) {
      setSaveParsedMessage("Run a parse before saving.");
      return;
    }
    const selected = parseResults.filter(
      (item, idx) => parseSelections[getParseKey(item, idx)] ?? true
    );
    if (selected.length === 0) {
      setSaveParsedMessage("Select at least one parsed section to save.");
      return;
    }
    setIsSavingParsed(true);
    setSaveParsedMessage(null);
    try {
      const res = await fetch("/api/save-parsed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          database_name: "privacy-compliance",
          collection_name:
            mode === "policy" ? "policy_chunks" : "statute_chunks",
          document_id: documentId,
          chunks: selected.map((item) => {
            const headerText =
              toDisplayString(item.parsed_header_text) ||
              toDisplayString((item as Record<string, unknown>).chunk_header_text);
            const text =
              toDisplayString(item.parsed_text) ||
              toDisplayString((item as Record<string, unknown>).chunk_text);
            return {
              chunk_header_text: headerText,
              chunk_text: text,
              ...item,
            };
          }),
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        let errMsg = "Unable to save.";
        try {
          const errData = JSON.parse(text) as { error?: string };
          if (errData?.error) errMsg = errData.error;
        } catch {
          if (text) errMsg = text;
        }
        throw new Error(errMsg);
      }
      const data = (await res.json()) as { message?: string };
      setSaveParsedMessage(
        data.message || "Saved parsed document. Subsections and vector index created."
      );
    } catch (err) {
      setSaveParsedMessage(
        normalizeApiError(err) || "Unable to save parsed document."
      );
    } finally {
      setIsSavingParsed(false);
    }
  };

  const handleIndex = async () => {
    if (!documentId) return;
    setIsIndexing(true);
    setIndexMessage(null);
    try {
      const res = await fetch("/api/run-subsection-pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          database_name: "privacy-compliance",
          document_id: documentId,
          mode,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        let errMsg = "Unable to index.";
        try {
          const errData = JSON.parse(text) as { error?: string };
          if (errData?.error) errMsg = errData.error;
        } catch {
          if (text) errMsg = text;
        }
        throw new Error(errMsg);
      }
      const data = (await res.json()) as { message?: string };
      setIndexMessage(data.message || "Subsections and vector index created.");
    } catch (err) {
      setIndexMessage(
        normalizeApiError(err) || "Unable to run subsection pipeline."
      );
    } finally {
      setIsIndexing(false);
    }
  };

  if (!doc) return null;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card parse-modal">
        <div className="modal-header">
          <div>
            <p className="modal-title">View document chunks</p>
            <p className="modal-url">
              {doc.title || doc.company_name || "Selected document"} · ID{" "}
              {documentId || "Unknown"}
            </p>
          </div>
          <div className="modal-actions">
            <button className="ghost-button" type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        <div className="modal-body parse-body">
          <div className="parse-grid">
            <div className="parse-panel">
              <div className="parse-panel-header">
                <p className="panel-title">Source document</p>
                <p className="panel-subtitle">Source text used for parsing.</p>
              </div>
              <div className="parse-source-scroll">
                {toDisplayString(doc.text) ? (
                  <div className="parse-source-body">
                    {toDisplayString(doc.text)}
                  </div>
                ) : (
                  <div className="empty-state">
                    <p>No source text available.</p>
                    <span>Re-crawl or re-ingest this document.</span>
                  </div>
                )}
              </div>
            </div>

            <div className="parse-panel">
              <div className="parse-prompt">
                <label className="field-label" htmlFor="parse-prompt">
                  Parse prompt
                </label>
                <textarea
                  id="parse-prompt"
                  value={parsePrompt}
                  onChange={(e) => setParsePrompt(e.target.value)}
                  rows={3}
                  placeholder="Describe how you want the document segmented."
                />
                <div className="field-hint">
                  Adjust the prompt and re-run until the parsed chunks look
                  right.
                </div>
                <div className="parse-actions">
                  <button
                    className="primary-button"
                    type="button"
                    onClick={handleRunParse}
                    disabled={isParsing || !parsePrompt.trim()}
                  >
                    {isParsing ? "Prompting…" : "Prompt"}
                  </button>
                </div>
              </div>

              {parseError ? (
                <div className="error-banner">
                  <span className="error-text">{parseError}</span>
                </div>
              ) : null}

              <div className="parse-results">
                <div className="parse-results-header">
                  <p className="panel-title">Parsed sections</p>
                  <p className="panel-subtitle">
                    {parseResults.length
                      ? `${parseResults.length} sections ready to review.`
                      : "Run a prompt to generate sections."}
                  </p>
                </div>
                <div className="parse-results-scroll">
                  {isParsing || isLoadingParsed ? (
                    <div className="loading-state">
                      <span className="loader" />
                      {isParsing
                        ? "Parsing document…"
                        : "Loading parsed chunks…"}
                    </div>
                  ) : parseResults.length === 0 ? (
                    <div className="empty-state">
                      <p>No parsed sections yet.</p>
                      <span>Enter a prompt and run parse to continue.</span>
                    </div>
                  ) : (
                    parseResults.map((item, idx) => (
                      <article
                        className="parse-section"
                        key={getParseKey(item, idx)}
                      >
                        <div className="parse-section-header">
                          <p>{item.parsed_header_text || "Untitled section"}</p>
                          <div className="parse-section-meta">
                            <span>
                              Section {idx + 1} · Doc {item.document_id}
                            </span>
                            <label className="parse-include">
                              <input
                                type="checkbox"
                                checked={
                                  parseSelections[getParseKey(item, idx)] ??
                                  true
                                }
                                onChange={(e) => {
                                  const key = getParseKey(item, idx);
                                  setParseSelections((prev) => ({
                                    ...prev,
                                    [key]: e.target.checked,
                                  }));
                                }}
                              />
                              Include
                            </label>
                          </div>
                        </div>
                        <div className="parse-section-body">
                          {item.parsed_text}
                        </div>
                      </article>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-actions parse-footer">
          <button
            className="ghost-button"
            type="button"
            onClick={() => {
              setParsePrompt("");
              setParseResults([]);
              setParseError(null);
              setSaveParsedMessage(null);
              setIndexMessage(null);
              setParseSelections({});
            }}
            disabled={isParsing || isSavingParsed || isIndexing}
          >
            Reset
          </button>
          <button
            className="ghost-button"
            type="button"
            onClick={handleSaveParsed}
            disabled={isSavingParsed || isIndexing || parseResults.length === 0}
          >
            {isSavingParsed ? "Saving…" : "Save parsed"}
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={handleIndex}
            disabled={isIndexing || !documentId}
          >
            {isIndexing ? "Indexing…" : "Index"}
          </button>
        </div>
        {(saveParsedMessage || indexMessage) ? (
          <div className="modal-footer">{indexMessage || saveParsedMessage}</div>
        ) : null}
      </div>
    </div>
  );
}
