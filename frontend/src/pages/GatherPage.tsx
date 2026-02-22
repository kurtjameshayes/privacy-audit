import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { normalizeApiError } from "../api/client";

type GatherMode = "policy" | "statute";

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

const modeContent: Record<
  GatherMode,
  {
    label: string;
    headline: string;
    helper: string;
    placeholder: string;
  }
> = {
  policy: {
    label: "Policies",
    headline: "Gather corporate privacy policies",
    helper:
      "Enter the organization name. We will search for \"Organization Privacy Policy\" on published corporate sites.",
    placeholder: "Lowe's Home Improvement",
  },
  statute: {
    label: "Statutes",
    headline: "Gather privacy statutes and regulations",
    helper:
      "Enter a statute name or jurisdiction. We will search for full-text statutes published online.",
    placeholder: "California Consumer Privacy Act",
  },
};

const formatPercent = (value: number) =>
  Number.isFinite(value) ? `${Math.round(value)}%` : "—";
const formatScore = (value: number) =>
  Number.isFinite(value) ? value.toFixed(2) : "—";

function copyToClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text).catch(() => {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  });
}

export default function GatherPage() {
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
  const [directUrl, setDirectUrl] = useState("");
  const [showFileUploadModal, setShowFileUploadModal] = useState(false);

  const trimmedQuery = query.trim();
  const statuteAppendPrompt = "Privacy Statute Law full text";

  const searchQuery = useMemo(() => {
    if (!trimmedQuery) return "";
    if (mode === "policy") {
      const prepend = policySearchConfig?.prepend_prompt || "";
      const append =
        policySearchConfig?.append_prompt || "Privacy Policy full text";
      return [prepend, trimmedQuery, append].filter(Boolean).join(" ");
    }
    return `${trimmedQuery} ${statuteAppendPrompt}`;
  }, [mode, policySearchConfig, trimmedQuery]);

  useEffect(() => {
    fetch("/api/config/privacy-policy-search")
      .then((r) => r.ok ? r.json() : null)
      .then((config) => config && setPolicySearchConfig(config))
      .catch(() => {});
  }, []);

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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: searchQuery }),
      });
      if (!response.ok) throw new Error(await response.text() || "Unable to gather results.");
      const data = (await response.json()) as GatherResponse;
      setResults(data.results || []);
      setLastQuery(data.query || searchQuery);
    } catch (caught) {
      setError(normalizeApiError(caught) || "Unable to gather results.");
    } finally {
      setIsSearching(false);
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: result.url, depth: 1, breadth: 1 }),
      });
      if (!response.ok) throw new Error(await response.text() || "Unable to crawl.");
      setCrawlData((await response.json()) as CrawlResponse);
    } catch (caught) {
      setError(normalizeApiError(caught) || "Unable to crawl the selected URL.");
    } finally {
      setIsCrawling(false);
    }
  };

  const handleDirectCrawl = async () => {
    const url = directUrl.trim();
    if (!url) {
      setError("Please enter a URL to crawl.");
      return;
    }
    setError(null);
    const syntheticResult: GatherResult = {
      title: url,
      url,
      description: "Direct crawl",
      percent_match: 100,
      score: 1,
    };
    setSelectedResult(syntheticResult);
    setIsCrawling(true);
    setCrawlData(null);
    setSaveMessage(null);
    try {
      const response = await fetch("/api/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, depth: 1, breadth: 1 }),
      });
      if (!response.ok) throw new Error(await response.text() || "Unable to crawl.");
      setCrawlData((await response.json()) as CrawlResponse);
    } catch (caught) {
      setError(normalizeApiError(caught) || "Unable to crawl the URL.");
      setSelectedResult(null);
    } finally {
      setIsCrawling(false);
    }
  };

  const handleFileUpload = async (file: File) => {
    setShowFileUploadModal(false);
    setError(null);
    const syntheticResult: GatherResult = {
      title: file.name,
      url: `file://${file.name}`,
      description: "Uploaded file",
      percent_match: 100,
      score: 1,
    };
    setSelectedResult(syntheticResult);
    setIsCrawling(true);
    setCrawlData(null);
    setSaveMessage(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("mode", mode);
      const response = await fetch("/api/upload-document", {
        method: "POST",
        body: formData,
      });
      if (!response.ok) throw new Error(await response.text() || "Unable to process file.");
      const data = (await response.json()) as { combined_text: string };
      const text = data.combined_text || "";
      setCrawlData({
        url: syntheticResult.url,
        combined_text: text,
        pages_crawled: 1,
        text_length: text.length,
        breadth: 1,
        depth: 1,
      });
    } catch (caught) {
      setError(normalizeApiError(caught) || "Unable to process uploaded file.");
      setSelectedResult(null);
    } finally {
      setIsCrawling(false);
    }
  };

  const handleSaveClick = () => {
    if (!crawlData || !selectedResult) return;
    if (mode === "statute") {
      setCompanyName("");
      setJurisdiction("");
    } else {
      setCompanyName(trimmedQuery);
      setJurisdiction("");
    }
    setShowCompanyNameDialog(true);
  };

  const handleConfirmSave = async () => {
    if (!crawlData || !selectedResult) return;
    setShowCompanyNameDialog(false);
    setIsSaving(true);
    setSaveMessage(null);
    try {
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
      if (mode !== "statute") savePayload.company_name = companyName.trim();

      const response = await fetch("/api/save-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(savePayload),
      });
      if (!response.ok) throw new Error(await response.text() || "Unable to save.");
      const data = (await response.json()) as { message?: string };
      setSaveMessage(data.message || "Saved to policy collection.");
      setShowSaveConfirmation(true);
    } catch (caught) {
      setSaveMessage(normalizeApiError(caught) || "Unable to save policy.");
    } finally {
      setIsSaving(false);
    }
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

  const isStatuteSave = mode === "statute";
  const saveFieldValue = isStatuteSave ? jurisdiction.trim() : companyName.trim();

  return (
    <>
      <header className="main-header">
        <div>
          <p className="eyebrow">Gather</p>
          <h2>Find policies and statutes with purpose-built search</h2>
          <p className="subtitle">
            Use prompt-driven discovery to collect full-text privacy documents.
            Every result can be crawled, reviewed, and appended to your policy
            collection.
          </p>
        </div>
        <div className="header-card">
          <p className="header-card-title">Active pipeline</p>
          <p className="header-card-value">
            {results.length ? results.length : "—"}
          </p>
          <p className="header-card-caption">Results staged for review</p>
        </div>
      </header>
      <div className="context-strip">
        <span className="context-strip-item">Workflow: Gather → Index → Compare</span>
        <span className="context-strip-item">Collection: Policy Vault</span>
        <Link to="/policies" className="context-strip-link">
          View stored policies
        </Link>
      </div>

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
                className={`mode-button ${mode === item ? "is-active" : ""}`}
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
              onChange={(e) => setQuery(e.target.value)}
              rows={4}
            />
            <div className="field-hint">{modeContent[mode].helper}</div>
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
            <div className="direct-url-block">
              <label className="field-label" htmlFor="direct-url">
                Or enter URL to crawl directly
              </label>
              <div className="direct-url-row">
                <input
                  id="direct-url"
                  type="url"
                  value={directUrl}
                  onChange={(e) => setDirectUrl(e.target.value)}
                  placeholder="https://example.com/privacy-policy"
                  className="direct-url-input"
                />
                <button
                  className="ghost-button"
                  type="button"
                  onClick={handleDirectCrawl}
                  disabled={isCrawling || !directUrl.trim()}
                >
                  {isCrawling ? "Crawling…" : "Crawl URL"}
                </button>
              </div>
            </div>
            <p className="gather-alt-link">
              <button
                type="button"
                className="link-button"
                onClick={() => setShowFileUploadModal(true)}
              >
                Upload file
              </button>
              {" "}(PDF, TXT, HTML)
            </p>
            {error ? (
              <div className="error-banner">
                <span className="error-text">{error}</span>
                <button
                  type="button"
                  className="error-copy-button"
                  onClick={async () => {
                    await copyToClipboard(error);
                    setErrorCopied(true);
                    setTimeout(() => setErrorCopied(false), 2000);
                  }}
                  title={errorCopied ? "Copied!" : "Copy error"}
                >
                  {errorCopied ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  )}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="results-panel">
        <div className="panel-header">
          <p className="panel-title">Results</p>
          <p className="panel-subtitle">
            {results.length
              ? `Showing ${results.length} sources for "${lastQuery || searchQuery}".`
              : "Awaiting a gather query."}
          </p>
        </div>
        <div className="results-grid">
          {results.length === 0 ? (
            <div className="empty-state">
              <p>No sources yet.</p>
              <span>Run a gather search to populate policy or statute sources.</span>
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
                    className="ghost-button card-action-arrow"
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

      {selectedResult ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <div className="modal-header">
              <div>
                <p className="modal-title">Crawled source</p>
                <p className="modal-url">{selectedResult.url}</p>
              </div>
              <div className="modal-actions">
                <button className="ghost-button" type="button" onClick={closeModal}>
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
                  <div className="crawl-text">{crawlData.combined_text}</div>
                </>
              ) : (
                <p className="loading-state">No crawl data available yet.</p>
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
                onClick={() => setShowCompanyNameDialog(false)}
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
              <Link
                to="/policies"
                className="ghost-button"
                style={{ marginLeft: 8 }}
                onClick={handleSaveConfirmationOk}
              >
                View in Policies
              </Link>
            </div>
          </div>
        </div>
      ) : null}

      {showFileUploadModal ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card file-upload-dialog">
            <div className="modal-header">
              <div>
                <p className="modal-title">Upload file</p>
                <p className="modal-subtitle">
                  Upload a PDF, TXT, or HTML file to add as a {mode === "policy" ? "policy" : "statute"}.
                </p>
              </div>
              <button
                className="ghost-button modal-close"
                type="button"
                onClick={() => setShowFileUploadModal(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <label className="file-upload-label">
                <input
                  type="file"
                  accept=".pdf,.txt,.html,.htm"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFileUpload(file);
                    e.target.value = "";
                  }}
                  className="file-upload-input"
                />
                <span className="file-upload-button">Choose file</span>
                <span className="file-upload-hint">PDF, TXT, or HTML</span>
              </label>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
