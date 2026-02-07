import { useEffect, useMemo, useState } from "react";

type GatherMode = "policy" | "statute";
type ViewMode = "gather" | "list";

interface PolicySearchConfig {
  module: string;
  append_prompt: string;
  prepend_prompt: string;
}

interface GatherResult {
  title: string;
  description: string;
  percent_match: number;
  score: number;
  url: string;
}

interface GatherResponse {
  query: string;
  results: GatherResult[];
}

interface CrawlResponse {
  url: string;
  combined_text: string;
  pages_crawled: number;
  text_length: number;
  breadth: number;
  depth: number;
  urls_crawled?: string[];
}

interface DocumentRecord {
  _id?: string;
  document_id?: string;
  source_url?: string;
  title?: string;
  description?: string;
  text?: string;
  query?: string;
  company_name?: string;
  jurisdiction?: string;
  pages_crawled?: number;
  text_length?: number;
  mode?: string;
  gathered_at?: string;
  [key: string]: unknown;
}

interface ParsedDocItem {
  document_id: string;
  parsed_header_text: string;
  parsed_text: string;
}

interface ChunkRecord {
  _id?: string;
  document_id?: string;
  chunk_index?: number | string;
  chunk_text_header?: string;
  chunk_header_text?: string;
  chunk_text?: string;
  chunks?: Array<{
    document_id?: string;
    chunk_text_header?: string;
    chunk_header_text?: string;
    chunk_text?: string;
  }>;
  timestamp?: string;
}

const POLICY_CHUNK_COLLECTION = "policy_chunks";
const STATUTE_CHUNK_COLLECTION = "statute_chunks";

const extractResponseArray = (data: unknown): unknown[] => {
  if (Array.isArray(data)) {
    return data;
  }
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const candidates = [
      record.documents,
      record.data,
      record.results,
      record.items,
    ];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        return candidate;
      }
    }
  }
  return [];
};

const modeContent: Record<
  GatherMode,
  {
    label: string;
    headline: string;
    helper: string;
    placeholder: string;
    detail: string;
  }
> = {
  policy: {
    label: "Policies",
    headline: "Gather corporate privacy policies",
    helper:
      "Enter the organization name. We will search for “Organization Privacy Policy” on published corporate sites.",
    placeholder: "Lowe's Home Improvement",
    detail:
      "Use the organization name only. The system appends “Privacy Policy” for targeted results.",
  },
  statute: {
    label: "Statutes",
    headline: "Gather privacy statutes and regulations",
    helper:
      "Enter a statute name or jurisdiction. We will search for full-text statutes published online.",
    placeholder: "California Consumer Privacy Act",
    detail:
      "Use specific statute names or regulators to narrow to authoritative sources.",
  },
};

const formatPercent = (value: number) => {
  if (!Number.isFinite(value)) {
    return "—";
  }
  return `${Math.round(value)}%`;
};

const formatScore = (value: number) => {
  if (!Number.isFinite(value)) {
    return "—";
  }
  return value.toFixed(2);
};

const toDisplayString = (value: unknown) => {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
};

const extractDocumentId = (value: unknown) => {
  if (typeof value === "string" || typeof value === "number") {
    return toDisplayString(value);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const oid = toDisplayString(record.$oid ?? record.oid ?? record.id);
    if (oid) {
      return oid;
    }
  }
  return "";
};

const formatDate = (value?: string) => {
  if (!value) {
    return "—";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
};

const parseDocumentResponse = (data: unknown): DocumentRecord[] =>
  extractResponseArray(data) as DocumentRecord[];

const parseParsedDocResponse = (data: unknown): ParsedDocItem[] => {
  if (Array.isArray(data)) {
    return data as ParsedDocItem[];
  }
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.parsed_doc)) {
      return record.parsed_doc as ParsedDocItem[];
    }
  }
  return [];
};

const parseChunkDocumentsResponse = (data: unknown): ParsedDocItem[] => {
  const records = extractResponseArray(data) as ChunkRecord[];
  const sortedRecords = [...records].sort((first, second) => {
    const firstIndex = Number.parseInt(
      toDisplayString(first?.chunk_index),
      10
    );
    const secondIndex = Number.parseInt(
      toDisplayString(second?.chunk_index),
      10
    );
    if (Number.isFinite(firstIndex) && Number.isFinite(secondIndex)) {
      return firstIndex - secondIndex;
    }
    const firstTime = Date.parse(toDisplayString(first?.timestamp));
    const secondTime = Date.parse(toDisplayString(second?.timestamp));
    if (Number.isNaN(firstTime) && Number.isNaN(secondTime)) {
      return 0;
    }
    if (Number.isNaN(firstTime)) {
      return 1;
    }
    if (Number.isNaN(secondTime)) {
      return -1;
    }
    return secondTime - firstTime;
  });

  return sortedRecords.flatMap((record) => {
    const documentId =
      extractDocumentId(record.document_id) || extractDocumentId(record._id);
    const chunks = Array.isArray(record.chunks) ? record.chunks : [];
    if (chunks.length > 0) {
      return chunks.map((chunk) => ({
        document_id: toDisplayString(chunk.document_id) || documentId,
        parsed_header_text: toDisplayString(
          chunk.chunk_text_header ?? chunk.chunk_header_text
        ),
        parsed_text: toDisplayString(chunk.chunk_text),
      }));
    }
    if (
      record.chunk_text ||
      record.chunk_text_header ||
      record.chunk_header_text
    ) {
      return [
        {
          document_id: documentId,
          parsed_header_text: toDisplayString(
            record.chunk_text_header ?? record.chunk_header_text
          ),
          parsed_text: toDisplayString(record.chunk_text),
        },
      ];
    }
    return [];
  });
};

const getParseKey = (item: ParsedDocItem, index: number) =>
  `${item.document_id}-${index}`;

export default function App() {
  const [view, setView] = useState<ViewMode>("gather");
  const [mode, setMode] = useState<GatherMode>("policy");
  const [query, setQuery] = useState("");
  const [lastQuery, setLastQuery] = useState("");
  const [results, setResults] = useState<GatherResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedResult, setSelectedResult] = useState<GatherResult | null>(
    null
  );
  const [crawlData, setCrawlData] = useState<CrawlResponse | null>(null);
  const [isCrawling, setIsCrawling] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [errorCopied, setErrorCopied] = useState(false);
  const [policySearchConfig, setPolicySearchConfig] =
    useState<PolicySearchConfig | null>(null);
  const [showCompanyNameDialog, setShowCompanyNameDialog] = useState(false);
  const [companyName, setCompanyName] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [showSaveConfirmation, setShowSaveConfirmation] = useState(false);
  const [listMode, setListMode] = useState<GatherMode>("policy");
  const [documentSearch, setDocumentSearch] = useState("");
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [isLoadingDocuments, setIsLoadingDocuments] = useState(false);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  const [parseTarget, setParseTarget] = useState<DocumentRecord | null>(null);
  const [parseDocumentId, setParseDocumentId] = useState("");
  const [parsePrompt, setParsePrompt] = useState("");
  const [parseResults, setParseResults] = useState<ParsedDocItem[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [isLoadingParsed, setIsLoadingParsed] = useState(false);
  const [isSavingParsed, setIsSavingParsed] = useState(false);
  const [saveParsedMessage, setSaveParsedMessage] = useState<string | null>(null);
  const [parseSelections, setParseSelections] = useState<
    Record<string, boolean>
  >({});
  const copyErrorToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setErrorCopied(true);
      setTimeout(() => setErrorCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement("textarea");
      textArea.value = text;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
      setErrorCopied(true);
      setTimeout(() => setErrorCopied(false), 2000);
    }
  };

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const response = await fetch("/api/config/privacy-policy-search");
        if (response.ok) {
          const config = (await response.json()) as PolicySearchConfig;
          setPolicySearchConfig(config);
        }
      } catch {
        // Use default config if fetch fails
      }
    };
    fetchConfig();
  }, []);

  useEffect(() => {
    if (view === "list") {
      setSelectedResult(null);
      setCrawlData(null);
      setSaveMessage(null);
    }
  }, [view]);

  const trimmedQuery = query.trim();
  const statuteAppendPrompt = "Privacy Statute Law full text";
  const listCollection = listMode === "policy" ? "policies" : "statutes";
  const chunkCollection =
    listMode === "policy" ? POLICY_CHUNK_COLLECTION : STATUTE_CHUNK_COLLECTION;

  const searchQuery = useMemo(() => {
    if (!trimmedQuery) {
      return "";
    }
    if (mode === "policy") {
      const prepend = policySearchConfig?.prepend_prompt || "";
      const append = policySearchConfig?.append_prompt || "Privacy Policy full text";
      const parts = [prepend, trimmedQuery, append].filter(Boolean);
      return parts.join(" ");
    }
    return `${trimmedQuery} ${statuteAppendPrompt}`;
  }, [mode, policySearchConfig, statuteAppendPrompt, trimmedQuery]);

  const handleSearch = async () => {
    if (!trimmedQuery) {
      setError("Please enter an organization or statute name.");
      return;
    }
    setIsSearching(true);
    setError(null);
    setResults([]);
    setCrawlData(null);
    setSelectedResult(null);
    setSaveMessage(null);

    try {
      const response = await fetch("/api/gather", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: searchQuery }),
      });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || "Unable to gather results.");
      }

      const data = (await response.json()) as GatherResponse;
      setResults(data.results || []);
      setLastQuery(data.query || searchQuery);
    } catch (caught) {
      const message =
        caught instanceof Error
          ? caught.message
          : "Unable to gather results.";
      setError(message);
    } finally {
      setIsSearching(false);
    }
  };

  const handleDocumentsFetch = async (targetMode: GatherMode) => {
    setIsLoadingDocuments(true);
    setDocumentsError(null);
    setDocuments([]);

    try {
      const response = await fetch("/api/documents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          database_name: "privacy-compliance",
          collection_name: targetMode === "policy" ? "policies" : "statutes",
        }),
      });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || "Unable to load documents.");
      }

      const data = (await response.json()) as unknown;
      const parsed = parseDocumentResponse(data);
      setDocuments(parsed);
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Unable to load documents.";
      setDocumentsError(message);
    } finally {
      setIsLoadingDocuments(false);
    }
  };

  const getDocumentId = (doc: DocumentRecord) => extractDocumentId(doc._id);

  const handleOpenParse = (doc: DocumentRecord) => {
    const documentId = getDocumentId(doc);
    setParseTarget(doc);
    setParseDocumentId(documentId);
    setParsePrompt("");
    setParseResults([]);
    setParseError(null);
    setSaveParsedMessage(null);
    setParseSelections({});
  };

  const handleCloseParse = () => {
    setParseTarget(null);
    setParseDocumentId("");
    setParseResults([]);
    setParseError(null);
    setSaveParsedMessage(null);
    setParseSelections({});
  };

  useEffect(() => {
    if (!parseTarget) {
      return;
    }
    const documentId = parseDocumentId;
    if (!documentId) {
      setParseError("Document ID is missing for this record.");
      return;
    }

    const loadExistingParsed = async () => {
      setIsLoadingParsed(true);
      setParseError(null);
      setParseResults([]);

      try {
        const response = await fetch("/api/documents", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            database_name: "privacy-compliance",
            collection_name: chunkCollection,
            query: {
              document_id: documentId,
            },
          }),
        });

        if (!response.ok) {
          const message = await response.text();
          throw new Error(message || "Unable to load parsed chunks.");
        }

        const data = (await response.json()) as unknown;
        const parsed = parseChunkDocumentsResponse(data);
        setParseResults(parsed);
      } catch (caught) {
        const message =
          caught instanceof Error
            ? caught.message
            : "Unable to load parsed chunks.";
        setParseError(message);
      } finally {
        setIsLoadingParsed(false);
      }
    };

    void loadExistingParsed();
  }, [parseDocumentId, parseTarget, chunkCollection]);

  useEffect(() => {
    setParseSelections((previous) => {
      if (parseResults.length === 0) {
        return {};
      }
      return parseResults.reduce<Record<string, boolean>>((acc, item, idx) => {
        const key = getParseKey(item, idx);
        acc[key] = previous[key] ?? true;
        return acc;
      }, {});
    });
  }, [parseResults]);

  const handleRunParse = async () => {
    if (!parseTarget) {
      return;
    }
    const prompt = parsePrompt.trim();
    const documentId = parseDocumentId;
    if (!documentId) {
      setParseError("Document ID is missing for this record.");
      return;
    }
    if (!prompt) {
      setParseError("Please enter a parsing prompt.");
      return;
    }

    setIsParsing(true);
    setParseError(null);
    setSaveParsedMessage(null);

    try {
      const response = await fetch("/api/parse-llm", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          database_name: "privacy-compliance",
          collection_name: listCollection,
          document_id: documentId,
          prompt,
        }),
      });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || "Unable to parse document.");
      }

      const data = (await response.json()) as unknown;
      const parsed = parseParsedDocResponse(data);
      setParseResults(parsed);
      if (parsed.length === 0) {
        setParseError("No parsed output returned.");
      }
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Unable to parse document.";
      setParseError(message);
    } finally {
      setIsParsing(false);
    }
  };

  const handleSaveParsed = async () => {
    if (!parseTarget) {
      return;
    }
    const documentId = parseDocumentId;
    if (!documentId) {
      setSaveParsedMessage("Document ID is missing for this record.");
      return;
    }
    if (parseResults.length === 0) {
      setSaveParsedMessage("Run a parse before saving.");
      return;
    }
    const selectedResults = parseResults.filter((item, idx) => {
      const key = getParseKey(item, idx);
      return parseSelections[key] ?? true;
    });
    if (selectedResults.length === 0) {
      setSaveParsedMessage("Select at least one parsed section to save.");
      return;
    }

    setIsSavingParsed(true);
    setSaveParsedMessage(null);

    try {
      const response = await fetch("/api/save-parsed", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          database_name: "privacy-compliance",
          collection_name:
            listMode === "policy" ? "policy_chunks" : "statute_chunks",
          document_id: documentId,
          chunks: selectedResults.map((item) => ({
            chunk_text_header: toDisplayString(item.parsed_header_text),
            chunk_text: toDisplayString(item.parsed_text),
          })),
        }),
      });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || "Unable to save parsed document.");
      }

      const data = (await response.json()) as { message?: string };
      setSaveParsedMessage(data.message || "Saved parsed document.");
    } catch (caught) {
      const message =
        caught instanceof Error
          ? caught.message
          : "Unable to save parsed document.";
      setSaveParsedMessage(message);
    } finally {
      setIsSavingParsed(false);
    }
  };

  const handleView = async (result: GatherResult) => {
    setSelectedResult(result);
    setIsCrawling(true);
    setCrawlData(null);
    setSaveMessage(null);

    try {
      const response = await fetch("/api/crawl", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: result.url,
          depth: 1,
          breadth: 1,
        }),
      });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || "Unable to crawl the selected URL.");
      }

      const data = (await response.json()) as CrawlResponse;
      setCrawlData(data);
    } catch (caught) {
      const message =
        caught instanceof Error
          ? caught.message
          : "Unable to crawl the selected URL.";
      setError(message);
    } finally {
      setIsCrawling(false);
    }
  };

  const handleSaveClick = () => {
    if (!crawlData || !selectedResult) {
      return;
    }
    if (mode === "statute") {
      setCompanyName("");
      setJurisdiction("");
    } else {
      // Default company name to the user's search query (trimmed)
      setCompanyName(trimmedQuery);
      setJurisdiction("");
    }
    setShowCompanyNameDialog(true);
  };

  const handleConfirmSave = async () => {
    if (!crawlData || !selectedResult) {
      return;
    }

    setShowCompanyNameDialog(false);
    setIsSaving(true);
    setSaveMessage(null);

    try {
      // #region agent log
      fetch('http://127.0.0.1:7244/ingest/786e75f5-da0a-4fd9-9936-7cb070dccc74',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'pre-fix',hypothesisId:'H1',location:'App.tsx:691',message:'handleConfirmSave entry',data:{hasCrawlData:!!crawlData,hasSelectedResult:!!selectedResult,mode},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      const savePayload: Record<string, unknown> = {
        url: selectedResult.url,
        title: selectedResult.title,
        description: selectedResult.description,
        combined_text: crawlData.combined_text,
        pages_crawled: crawlData.pages_crawled,
        text_length: crawlData.text_length,
        query: lastQuery || searchQuery,
        jurisdiction: jurisdiction.trim(),
        mode,
      };
      if (mode !== "statute") {
        savePayload.company_name = companyName.trim();
      }
      // #region agent log
      fetch('http://127.0.0.1:7244/ingest/786e75f5-da0a-4fd9-9936-7cb070dccc74',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'pre-fix',hypothesisId:'H2',location:'App.tsx:709',message:'savePayload prepared',data:{payloadKeys:Object.keys(savePayload),mode,companyNameIncluded:mode!=="statute"},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      const response = await fetch("/api/save-policy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(savePayload),
      });

      if (!response.ok) {
        // #region agent log
        fetch('http://127.0.0.1:7244/ingest/786e75f5-da0a-4fd9-9936-7cb070dccc74',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'pre-fix',hypothesisId:'H3',location:'App.tsx:721',message:'save-policy non-ok response',data:{status:response.status,statusText:response.statusText},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        const message = await response.text();
        throw new Error(message || "Unable to save policy.");
      }

      const data = (await response.json()) as { message?: string };
      // #region agent log
      fetch('http://127.0.0.1:7244/ingest/786e75f5-da0a-4fd9-9936-7cb070dccc74',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'pre-fix',hypothesisId:'H4',location:'App.tsx:728',message:'save-policy success',data:{hasMessage:!!data.message},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      setSaveMessage(data.message || "Saved to policy collection.");
      setShowSaveConfirmation(true);
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Unable to save policy.";
      // #region agent log
      fetch('http://127.0.0.1:7244/ingest/786e75f5-da0a-4fd9-9936-7cb070dccc74',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'pre-fix',hypothesisId:'H5',location:'App.tsx:736',message:'save-policy error',data:{errorMessage:message},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      setSaveMessage(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelSave = () => {
    setShowCompanyNameDialog(false);
  };

  const handleSaveConfirmationOk = () => {
    setShowSaveConfirmation(false);
    setSelectedResult(null);
    setCrawlData(null);
    setSaveMessage(null);
  };

  const closeModal = () => {
    setSelectedResult(null);
    setCrawlData(null);
    setSaveMessage(null);
  };

  useEffect(() => {
    if (view !== "list") {
      return;
    }
    void handleDocumentsFetch(listMode);
  }, [listMode, view]);

  const filteredDocuments = useMemo(() => {
    const search = documentSearch.trim().toLowerCase();
    if (!search) {
      return documents;
    }
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

  const isStatuteSave = mode === "statute";
  const saveFieldValue = isStatuteSave
    ? jurisdiction.trim()
    : companyName.trim();

  return (
    <div className="app-shell">
      <aside className="brand-column">
        <div className="brand-mark">PA</div>
        <div className="brand-block">
          <p className="brand-overline">Privacy Audit Studio</p>
          <h1>Policy Intelligence Lab</h1>
          <p className="brand-summary">
            Gather, index, and compare privacy policies with statutory and
            industry standards. Built for legal and compliance teams who need
            defensible sourcing.
          </p>
        </div>
        <div className="brand-metrics">
          <div>
            <span className="metric-label">Collection</span>
            <span className="metric-value">Policy Vault</span>
          </div>
          <div>
            <span className="metric-label">Workflow</span>
            <span className="metric-value">Gather → Index → Compare</span>
          </div>
          <div>
            <span className="metric-label">Status</span>
            <span className="metric-value">Ready for ingestion</span>
          </div>
        </div>
        <nav className="side-nav">
          <p className="side-nav-title">Navigation</p>
          <button
            type="button"
            className={`side-nav-item ${view === "gather" ? "is-active" : ""}`}
            onClick={() => setView("gather")}
          >
            Gather Policies and Statutes
          </button>
          <button
            type="button"
            className={`side-nav-item ${view === "list" ? "is-active" : ""}`}
            onClick={() => setView("list")}
          >
            List Policies and Statutes
          </button>
        </nav>
      </aside>

      <main className="main-panel">
        {view === "gather" ? (
          <>
            <header className="main-header">
              <div>
                <p className="eyebrow">Gather</p>
                <h2>Find policies and statutes with purpose-built search</h2>
                <p className="subtitle">
                  Use prompt-driven discovery to collect full-text privacy
                  documents. Every result can be crawled, reviewed, and appended
                  to your policy collection.
                </p>
              </div>
              <div className="header-card">
                <p className="header-card-title">Active pipeline</p>
                <p className="header-card-value">
                  {results.length ? results.length : "—"}
                </p>
                <p className="header-card-caption">
                  Results staged for review
                </p>
              </div>
            </header>

            <section className="gather-panel">
              <div className="panel-header">
                <div>
                  <p className="panel-title">Gather sources</p>
                  <p className="panel-subtitle">{modeContent[mode].headline}</p>
                </div>
                <div className="mode-toggle">
                  {(["policy", "statute"] as GatherMode[]).map((item) => (
                    <button
                      key={item}
                      className={`mode-button ${
                        mode === item ? "is-active" : ""
                      }`}
                      type="button"
                      onClick={() => {
                        setMode(item);
                        setQuery("");
                        setResults([]);
                        setError(null);
                      }}
                    >
                      {modeContent[item].label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="panel-body">
                <div className="search-block">
                  <label className="field-label" htmlFor="query">
                    Search prompt
                  </label>
                  <textarea
                    id="query"
                    value={query}
                    placeholder={modeContent[mode].placeholder}
                    onChange={(event) => setQuery(event.target.value)}
                    rows={4}
                  />
                  <div className="field-hint">
                    {modeContent[mode].helper}
                  </div>
                  <div className="search-row">
                    <div>
                      <p className="search-preview-label">Query preview</p>
                      <p className="search-preview">{searchQuery || "—"}</p>
                    </div>
                    <button
                      className="primary-button"
                      type="button"
                      onClick={handleSearch}
                      disabled={isSearching}
                    >
                      {isSearching ? "Searching…" : "Gather results"}
                    </button>
                  </div>
                  {error ? (
                    <div className="error-banner">
                      <span className="error-text">{error}</span>
                      <button
                        type="button"
                        className="error-copy-button"
                        onClick={() => copyErrorToClipboard(error)}
                        title={errorCopied ? "Copied!" : "Copy error"}
                      >
                        {errorCopied ? (
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        ) : (
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <rect
                              x="9"
                              y="9"
                              width="13"
                              height="13"
                              rx="2"
                              ry="2"
                            />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                        )}
                      </button>
                    </div>
                  ) : null}
                </div>
                <div className="context-block">
                  <p className="context-title">Workflow notes</p>
                  <ul>
                    <li>{modeContent[mode].detail}</li>
                    <li>Results are returned with relevance scoring.</li>
                    <li>
                      Use “View” to crawl the source at depth 1 and breadth 1.
                    </li>
                    <li>
                      Save appends the crawled text to the policy collection.
                    </li>
                  </ul>
                </div>
              </div>
            </section>

            <section className="results-panel">
              <div className="panel-header">
                <p className="panel-title">Results</p>
                <p className="panel-subtitle">
                  {results.length
                    ? `Showing ${results.length} sources for “${
                        lastQuery || searchQuery
                      }”.`
                    : "Awaiting a gather query."}
                </p>
              </div>
              <div className="results-grid">
                {results.length === 0 ? (
                  <div className="empty-state">
                    <p>No sources yet.</p>
                    <span>
                      Run a gather search to populate policy or statute sources.
                    </span>
                  </div>
                ) : (
                  results.map((result) => (
                    <article className="result-card" key={result.url}>
                      <div className="result-header">
                        <div>
                          <h3>{result.title}</h3>
                          <p>{result.description}</p>
                        </div>
                        <div className="score-stack">
                          <span className="score-pill">
                            {formatPercent(result.percent_match)}
                          </span>
                          <span className="score-caption">
                            score {formatScore(result.score)}
                          </span>
                        </div>
                      </div>
                      <div className="result-footer">
                        <span className="result-url">{result.url}</span>
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => handleView(result)}
                        >
                          View
                        </button>
                      </div>
                    </article>
                  ))
                )}
              </div>
            </section>
          </>
        ) : (
          <>
            <header className="main-header">
              <div>
                <p className="eyebrow">List</p>
                <h2>Browse stored policies and statutes</h2>
                <p className="subtitle">
                  Review documents already stored in the privacy-compliance
                  database. Filter locally using the list search.
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

            <section className="results-panel">
              <div className="panel-header list-header">
                <div>
                  <p className="panel-title">Document library</p>
                  <p className="panel-subtitle">
                    {isLoadingDocuments
                      ? "Loading documents…"
                      : `${filteredDocuments.length} of ${documents.length} documents shown.`}
                  </p>
                </div>
                <div className="mode-toggle">
                  {(["policy", "statute"] as GatherMode[]).map((item) => (
                    <button
                      key={item}
                      className={`mode-button ${
                        listMode === item ? "is-active" : ""
                      }`}
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
                    onChange={(event) => setDocumentSearch(event.target.value)}
                    placeholder="Search by title, company, URL, or text"
                  />
                </div>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => handleDocumentsFetch(listMode)}
                  disabled={isLoadingDocuments}
                >
                  {isLoadingDocuments ? "Refreshing…" : "Refresh list"}
                </button>
              </div>

              {documentsError ? (
                <div className="error-banner list-error">
                  <span className="error-text">{documentsError}</span>
                  <button
                    type="button"
                    className="error-copy-button"
                    onClick={() => copyErrorToClipboard(documentsError)}
                    title={errorCopied ? "Copied!" : "Copy error"}
                  >
                    {errorCopied ? (
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    )}
                  </button>
                </div>
              ) : null}

              <div className="results-grid">
                {isLoadingDocuments ? (
                  <div className="loading-state list-loading">
                    <span className="loader" />
                    Loading documents…
                  </div>
                ) : filteredDocuments.length === 0 ? (
                  <div className="empty-state">
                    <p>No documents yet.</p>
                    <span>
                      Try refreshing or adjust the local search filter.
                    </span>
                  </div>
                ) : (
                  filteredDocuments.map((doc, index) => (
                    <article
                      className="result-card document-card"
                      key={`${doc.source_url || doc.title || "doc"}-${index}`}
                    >
                      <div className="result-header">
                        <div>
                          <h3>{doc.title || "Untitled document"}</h3>
                          <p>
                            {listMode === "statute"
                              ? doc.jurisdiction ||
                                doc.description ||
                                "No description available."
                              : doc.company_name ||
                              doc.description ||
                              "No description available."}
                          </p>
                        </div>
                        <div className="score-stack">
                          <span className="score-pill">
                            {doc.text_length
                              ? `${doc.text_length} chars`
                              : "—"}
                          </span>
                          <span className="score-caption">
                            {formatDate(doc.gathered_at)}
                          </span>
                        </div>
                      </div>
                      <div className="result-footer">
                        <span className="result-url">
                          {doc.source_url ||
                            toDisplayString(doc.url) ||
                            "No source URL"}
                        </span>
                        <div className="document-actions">
                          <span className="document-tag">
                            {listMode === "policy"
                              ? "Policy"
                              : "Statute"}
                          </span>
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => handleOpenParse(doc)}
                          >
                            View
                          </button>
                        </div>
                      </div>
                    </article>
                  ))
                )}
              </div>
            </section>
          </>
        )}
      </main>

      {selectedResult ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <div className="modal-header">
              <div>
                <p className="modal-title">Crawled source</p>
                <p className="modal-url">{selectedResult.url}</p>
              </div>
              <div className="modal-actions">
                <button
                  className="ghost-button"
                  type="button"
                  onClick={closeModal}
                >
                  Close
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={handleSaveClick}
                  disabled={isSaving || isCrawling}
                >
                  {isSaving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
            <div className="modal-body">
              {isCrawling ? (
                <div className="loading-state">
                  <span className="loader" />
                  Crawling content…
                </div>
              ) : crawlData ? (
                <>
                  <div className="crawl-meta">
                    <span>Pages: {crawlData.pages_crawled}</span>
                    <span>Depth: {crawlData.depth}</span>
                    <span>Breadth: {crawlData.breadth}</span>
                    <span>Text length: {crawlData.text_length}</span>
                  </div>
                  <div className="crawl-text">
                    {crawlData.combined_text}
                  </div>
                </>
              ) : (
                <p className="loading-state">
                  No crawl data available yet.
                </p>
              )}
            </div>
            {saveMessage ? (
              <div className="modal-footer">{saveMessage}</div>
            ) : null}
          </div>
        </div>
      ) : null}

      {showCompanyNameDialog ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card company-name-dialog">
            <div className="modal-header">
              <div>
                <p className="modal-title">
                  {isStatuteSave ? "Confirm Jurisdiction" : "Confirm Company Name"}
                </p>
                <p className="modal-subtitle">
                  {isStatuteSave
                    ? "Please enter the jurisdiction before saving."
                    : "Please verify the company name before saving."}
                </p>
              </div>
            </div>
            <div className="modal-body">
              {isStatuteSave ? (
                <div className="field-group">
                  <label className="field-label" htmlFor="statute-jurisdiction">
                    Jurisdiction
                  </label>
                  <input
                    id="statute-jurisdiction"
                    type="text"
                    value={jurisdiction}
                    onChange={(e) => setJurisdiction(e.target.value)}
                    placeholder="Enter jurisdiction"
                    autoFocus
                  />
                </div>
              ) : (
                <div className="field-group">
                  <label className="field-label" htmlFor="company-name">
                    Company Name
                  </label>
                  <input
                    id="company-name"
                    type="text"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    placeholder="Enter company name"
                    autoFocus
                  />
                </div>
              )}
            </div>
            <div className="modal-actions dialog-actions">
              <button
                className="ghost-button"
                type="button"
                onClick={handleCancelSave}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={handleConfirmSave}
                disabled={!saveFieldValue}
              >
                {isStatuteSave ? "Save Statute" : "Save Policy"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showSaveConfirmation ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card save-confirmation-dialog">
            <div className="modal-header">
              <div>
                <p className="modal-title">Saved Successfully</p>
                <p className="modal-subtitle">
                  {saveMessage || "The policy has been saved to the collection."}
                </p>
              </div>
            </div>
            <div className="modal-actions dialog-actions">
              <button
                className="primary-button"
                type="button"
                onClick={handleSaveConfirmationOk}
                autoFocus
              >
                OK
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {parseTarget ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card parse-modal">
            <div className="modal-header">
              <div>
                <p className="modal-title">View document</p>
                <p className="modal-url">
                  {parseTarget.title ||
                    parseTarget.company_name ||
                    "Selected document"}{" "}
                  · ID {parseDocumentId || "Unknown"}
                </p>
              </div>
              <div className="modal-actions">
                <button
                  className="ghost-button"
                  type="button"
                  onClick={handleCloseParse}
                >
                  Close
                </button>
              </div>
            </div>
            <div className="modal-body parse-body">
              <div className="parse-grid">
                <div className="parse-panel">
                  <div className="parse-panel-header">
                    <p className="panel-title">Unparsed document</p>
                    <p className="panel-subtitle">
                      Source text used for parsing.
                    </p>
                  </div>
                  <div className="parse-source-scroll">
                    {toDisplayString(parseTarget.text) ? (
                      <div className="parse-source-body">
                        {toDisplayString(parseTarget.text)}
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
                      onChange={(event) => setParsePrompt(event.target.value)}
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
                                    onChange={(event) => {
                                      const key = getParseKey(item, idx);
                                      setParseSelections((previous) => ({
                                        ...previous,
                                        [key]: event.target.checked,
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
                  setParseSelections({});
                }}
                disabled={isParsing || isSavingParsed}
              >
                Reset
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={handleSaveParsed}
                disabled={isSavingParsed || parseResults.length === 0}
              >
                {isSavingParsed ? "Saving…" : "Save parsed"}
              </button>
            </div>
            {saveParsedMessage ? (
              <div className="modal-footer">{saveParsedMessage}</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
