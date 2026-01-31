import { useEffect, useMemo, useState } from "react";

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

export default function App() {
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

  const trimmedQuery = query.trim();
  const statuteSearchPhrases = [
    "Identified or identifiable natural person",
    "Right to opt out of the sale of personal information",
    "Right to access, correct, and delete",
    "Determines the purposes and means of processing",
    "Processes personal data on behalf of a controller",
    "Reasonably necessary and proportionate",
    "De-identified data or aggregate consumer information",
    "Decisions that produce legal or similarly significant effects",
    "Specific, informed, and unambiguous consent",
    "Consumer request that is verifiable",
  ].join(" ");

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
    return `${trimmedQuery} ${statuteSearchPhrases}`;
  }, [mode, policySearchConfig, statuteSearchPhrases, trimmedQuery]);

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
    // Default company name to the user's search query (trimmed)
    setCompanyName(trimmedQuery);
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
      const response = await fetch("/api/save-policy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: selectedResult.url,
          title: selectedResult.title,
          description: selectedResult.description,
          combined_text: crawlData.combined_text,
          pages_crawled: crawlData.pages_crawled,
          text_length: crawlData.text_length,
          query: lastQuery || searchQuery,
          company_name: companyName.trim(),
          mode,
        }),
      });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || "Unable to save policy.");
      }

      const data = (await response.json()) as { message?: string };
      setSaveMessage(data.message || "Saved to policy collection.");
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Unable to save policy.";
      setSaveMessage(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelSave = () => {
    setShowCompanyNameDialog(false);
  };

  const closeModal = () => {
    setSelectedResult(null);
    setCrawlData(null);
    setSaveMessage(null);
  };

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
      </aside>

      <main className="main-panel">
        <header className="main-header">
          <div>
            <p className="eyebrow">Gather</p>
            <h2>Find policies and statutes with purpose-built search</h2>
            <p className="subtitle">
              Use prompt-driven discovery to collect full-text privacy
              documents. Every result can be crawled, reviewed, and appended to
              your policy collection.
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
                  <p className="search-preview">
                    {searchQuery || "—"}
                  </p>
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
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
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
                ? `Showing ${results.length} sources for “${lastQuery || searchQuery}”.`
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
                <p className="modal-title">Confirm Company Name</p>
                <p className="modal-subtitle">
                  Please verify the company name before saving.
                </p>
              </div>
            </div>
            <div className="modal-body">
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
                disabled={!companyName.trim()}
              >
                Save Policy
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
