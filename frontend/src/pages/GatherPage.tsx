import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { apiGet, apiPost, normalizeApiError } from "../api/client";
import {
  Search,
  Globe,
  Upload,
  File as FileIcon,
  Plus,
  Copy,
  Check,
} from "lucide-react";
import { InfoIcon } from "../components/Tooltip";

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
      'Enter the organization name. We will search for "Organization Privacy Policy" on published corporate sites.',
    placeholder: "e.g. Acme Corp Privacy Policy...",
  },
  statute: {
    label: "Statutes",
    headline: "Gather privacy statutes and regulations",
    helper:
      "Enter a statute name or jurisdiction. We will search for full-text statutes published online.",
    placeholder: "e.g. California Consumer Privacy Act",
  },
};

const formatPercent = (value: number) =>
  Number.isFinite(value) ? `${Math.round(value)}%` : "—";

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
  const [upstreamStatus, setUpstreamStatus] = useState<{
    available: boolean;
    error?: string;
  } | null>(null);

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
    apiGet<PolicySearchConfig>("/api/config/privacy-policy-search")
      .then((config) => setPolicySearchConfig(config))
      .catch(() => {});
  }, []);

  useEffect(() => {
    apiGet<{ available?: boolean; error?: string }>("/api/upstream-status")
      .then((data) => setUpstreamStatus({ available: data.available ?? false, error: data.error }))
      .catch(() => setUpstreamStatus({ available: false, error: "Could not check status" }));
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
      const data = await apiPost<GatherResponse>("/api/gather", { query: searchQuery });
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
      const crawled = await apiPost<CrawlResponse>("/api/crawl", { url: result.url, depth: 1, breadth: 1 });
      setCrawlData(crawled);
    } catch (caught) {
      setError(
        normalizeApiError(caught) || "Unable to crawl the selected URL."
      );
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
      const crawled = await apiPost<CrawlResponse>("/api/crawl", { url, depth: 1, breadth: 1 });
      setCrawlData(crawled);
    } catch (caught) {
      setError(normalizeApiError(caught) || "Unable to crawl the URL.");
      setSelectedResult(null);
    } finally {
      setIsCrawling(false);
    }
  };

  const handleFileUpload = async (file: File) => {
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
      if (!response.ok)
        throw new Error(
          (await response.text()) || "Unable to process file."
        );
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
      setError(
        normalizeApiError(caught) || "Unable to process uploaded file."
      );
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

      const data = await apiPost<{ message?: string }>("/api/save-policy", savePayload);
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
  const saveFieldValue = isStatuteSave
    ? jurisdiction.trim()
    : companyName.trim();

  return (
    <div className="p-8 max-w-6xl mx-auto w-full">
      {/* Page Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          Gather Documents
          <InfoIcon content="Acquire privacy policies and statutes either by searching the web, crawling from URLs, or uploading local files. This is the first step in the workflow." />
        </h1>
        <p className="text-slate-500 mt-1 text-sm">
          Find and import documents into your library to begin parsing and
          compliance analysis.
        </p>
      </div>

      {upstreamStatus && (
        <div
          className={`mb-6 px-4 py-3 rounded-lg border text-sm ${
            upstreamStatus.available
              ? "bg-emerald-50 border-emerald-200 text-emerald-800"
              : "bg-amber-50 border-amber-200 text-amber-800"
          }`}
        >
          {upstreamStatus.available ? (
            <span>Upstream service available.</span>
          ) : (
            <span>
              Upstream service unavailable.
              {upstreamStatus.error ? ` ${upstreamStatus.error}` : ""}
            </span>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* ─── Left Column: Acquisition Methods ─── */}
        <div className="space-y-6">
          {/* Search Panel */}
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
            <div className="flex items-center gap-2 mb-4">
              <div className="p-2 bg-indigo-50 rounded-lg">
                <Search className="h-5 w-5 text-indigo-600" />
              </div>
              <h2 className="text-lg font-semibold text-slate-800">
                Search the Web
              </h2>
            </div>
            <p className="text-sm text-slate-600 mb-5">
              Search the web for global corporate policies and published privacy
              statutes.
            </p>

            <div className="space-y-4">
              <div>
                <label
                  htmlFor="query"
                  className="text-sm font-medium text-slate-700 mb-1 flex items-center gap-1"
                >
                  Query
                  <InfoIcon content="Use natural language. e.g., 'Latest GDPR text' or 'Acme Corp Privacy Policy 2024'" />
                </label>
                <div className="flex mt-1">
                  <input
                    id="query"
                    type="text"
                    value={query}
                    placeholder={modeContent[mode].placeholder}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                    className="!flex-1 !rounded-l-md !rounded-r-none !border !border-slate-300 !px-3 !py-2 text-sm focus:!border-indigo-500 focus:!outline-none focus:!ring-1 focus:!ring-indigo-500"
                  />
                  <button
                    type="button"
                    onClick={handleSearch}
                    disabled={isSearching}
                    className="bg-slate-100 border border-l-0 border-slate-300 rounded-r-md px-4 py-2 text-sm font-medium hover:bg-slate-200 text-slate-700 transition-colors disabled:opacity-50"
                  >
                    {isSearching ? "Searching…" : "Search"}
                  </button>
                </div>
                {searchQuery && (
                  <p
                    className="text-xs text-slate-400 mt-1.5 truncate"
                    title={searchQuery}
                  >
                    Preview: {searchQuery}
                  </p>
                )}
              </div>

              <div className="flex gap-6 pt-2">
                <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer group">
                  <input
                    type="radio"
                    name="search_type"
                    checked={mode === "policy"}
                    onChange={() => {
                      setMode("policy");
                      setQuery("");
                      setResults([]);
                      setError(null);
                    }}
                    className="text-indigo-600 focus:ring-indigo-500 border-slate-300"
                  />
                  <span className="group-hover:text-indigo-700 transition-colors">
                    Corporate Policies
                  </span>
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer group">
                  <input
                    type="radio"
                    name="search_type"
                    checked={mode === "statute"}
                    onChange={() => {
                      setMode("statute");
                      setQuery("");
                      setResults([]);
                      setError(null);
                    }}
                    className="text-indigo-600 focus:ring-indigo-500 border-slate-300"
                  />
                  <span className="group-hover:text-indigo-700 transition-colors">
                    Statutes &amp; Regulations
                  </span>
                </label>
              </div>
            </div>
          </div>

          {/* Direct Ingestion Panel */}
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
            <div className="flex items-center gap-2 mb-4">
              <div className="p-2 bg-emerald-50 rounded-lg">
                <Plus className="h-5 w-5 text-emerald-600" />
              </div>
              <h2 className="text-lg font-semibold text-slate-800">
                Direct Ingestion
              </h2>
            </div>
            <p className="text-sm text-slate-600 mb-5">
              Crawl a public webpage or manually upload a local document for
              parsing.
            </p>

            <div className="space-y-5">
              {/* URL Crawl */}
              <div className="border border-slate-100 bg-slate-50/50 rounded-lg p-5">
                <label
                  htmlFor="direct-url"
                  className="text-sm font-medium text-slate-700 mb-1 flex items-center gap-1"
                >
                  <Globe className="h-4 w-4 text-slate-400" /> Crawl from URL
                  <InfoIcon content="We will attempt to scrape the main text from the provided URL, ignoring navigation menus and footers." />
                </label>
                <div className="flex mt-2">
                  <input
                    id="direct-url"
                    type="url"
                    value={directUrl}
                    onChange={(e) => setDirectUrl(e.target.value)}
                    onKeyDown={(e) =>
                      e.key === "Enter" &&
                      directUrl.trim() &&
                      handleDirectCrawl()
                    }
                    placeholder="https://example.com/privacy"
                    className="!flex-1 !rounded-l-md !rounded-r-none !border !border-slate-300 !px-3 !py-2 text-sm focus:!border-indigo-500 focus:!outline-none focus:!ring-1 focus:!ring-indigo-500 !bg-white"
                  />
                  <button
                    type="button"
                    onClick={handleDirectCrawl}
                    disabled={isCrawling || !directUrl.trim()}
                    className="bg-indigo-600 text-white border border-indigo-600 rounded-r-md px-4 py-2 text-sm font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50"
                  >
                    {isCrawling && selectedResult?.description === "Direct crawl"
                      ? "Fetching…"
                      : "Fetch Content"}
                  </button>
                </div>
              </div>

              {/* File Upload */}
              <div className="border border-slate-100 bg-slate-50/50 rounded-lg p-5">
                <span className="text-sm font-medium text-slate-700 mb-2 flex items-center gap-1">
                  <Upload className="h-4 w-4 text-slate-400" /> Upload Local
                  File
                  <InfoIcon content="Supported formats: PDF, TXT, HTML." />
                </span>
                <label className="mt-2 flex justify-center rounded-lg border-2 border-dashed border-slate-300 bg-white px-6 py-8 hover:bg-indigo-50/50 hover:border-indigo-300 cursor-pointer transition-all group">
                  <div className="text-center">
                    <FileIcon className="mx-auto h-8 w-8 text-slate-300 group-hover:text-indigo-400 transition-colors" />
                    <div className="mt-3 flex text-sm leading-6 text-slate-600 justify-center">
                      <span className="font-semibold text-indigo-600 hover:text-indigo-500">
                        Click to browse
                      </span>
                      <span className="pl-1">or drag and drop</span>
                    </div>
                    <p className="text-xs text-slate-500 mt-1">
                      PDF, TXT, or HTML up to 10MB
                    </p>
                    <input
                      type="file"
                      accept=".pdf,.txt,.html,.htm"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleFileUpload(file);
                        e.target.value = "";
                      }}
                      className="hidden"
                    />
                  </div>
                </label>
              </div>
            </div>
          </div>

          {/* Error Banner */}
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-800 p-3 rounded-lg text-sm flex items-start justify-between gap-3">
              <span className="flex-1">{error}</span>
              <button
                type="button"
                onClick={async () => {
                  await copyToClipboard(error);
                  setErrorCopied(true);
                  setTimeout(() => setErrorCopied(false), 2000);
                }}
                title={errorCopied ? "Copied!" : "Copy error"}
                className="flex-shrink-0 p-1 rounded hover:bg-red-100 transition-colors"
              >
                {errorCopied ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </button>
            </div>
          )}

          {/* Search Results */}
          {results.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-slate-700 mb-3">
                {results.length} results for &ldquo;
                {lastQuery || searchQuery}&rdquo;
              </h3>
              <div className="space-y-3">
                {results.map((result) => {
                  const isSelected = selectedResult?.url === result.url;
                  return (
                  <div
                    key={result.url}
                    className={`p-4 rounded-lg border transition-shadow cursor-pointer ${
                      isSelected
                        ? "bg-indigo-50 border-indigo-300 ring-1 ring-indigo-200"
                        : "bg-white border-slate-200 hover:shadow-sm"
                    }`}
                    onClick={() => handleView(result)}
                  >
                    <div className="flex justify-between items-start gap-4">
                      <div className="min-w-0 flex-1">
                        <h4 className={`font-medium text-sm truncate ${isSelected ? "text-indigo-900" : "text-slate-900"}`}>
                          {result.title}
                        </h4>
                        <p className="text-xs text-slate-500 mt-1 line-clamp-2">
                          {result.description}
                        </p>
                        <p className="text-xs text-slate-400 mt-1 truncate">
                          {result.url}
                        </p>
                      </div>
                      <div className="flex items-center gap-3 flex-shrink-0">
                        <span className={`text-xs px-2 py-1 rounded font-medium ${
                          isSelected ? "bg-indigo-100 text-indigo-700" : "bg-indigo-50 text-indigo-600"
                        }`}>
                          {formatPercent(result.percent_match)}
                        </span>
                        <span
                          className={`text-sm font-medium transition-colors whitespace-nowrap ${
                            isSelected ? "text-indigo-700" : "text-indigo-600"
                          }`}
                        >
                          {isSelected ? "Viewing" : "View →"}
                        </span>
                      </div>
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* ─── Right Column: Document Preview ─── */}
        <div className="bg-slate-800 rounded-xl shadow-lg border border-slate-700 flex flex-col overflow-hidden lg:h-[calc(100vh-10rem)] lg:sticky lg:top-8">
          <div className="bg-slate-900 px-4 py-3 border-b border-slate-700 flex justify-between items-center">
            <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
              Document Preview
              <InfoIcon content="Inspect the fetched or uploaded raw text to ensure clarity before saving it to your Library." />
            </h3>
            <span className="text-xs font-mono text-slate-400 bg-slate-800 px-2 py-0.5 rounded">
              {crawlData ? "Loaded" : isCrawling ? "Fetching" : "Waiting"}
            </span>
          </div>

          <div className="flex-1 p-6 overflow-y-auto bg-slate-800 text-slate-300 font-mono text-sm leading-relaxed whitespace-pre-wrap min-h-[300px]">
            {isCrawling ? (
              <div className="flex items-center gap-3 text-slate-400">
                <div className="h-4 w-4 border-2 border-slate-600 border-t-indigo-400 rounded-full animate-spin" />
                Fetching content…
              </div>
            ) : crawlData ? (
              <>
                <div className="flex flex-wrap gap-4 mb-4 text-xs text-slate-500 border-b border-slate-700 pb-3">
                  <span>Pages: {crawlData.pages_crawled}</span>
                  <span>Depth: {crawlData.depth}</span>
                  <span>Breadth: {crawlData.breadth}</span>
                  <span>
                    Length: {crawlData.text_length.toLocaleString()} chars
                  </span>
                </div>
                {crawlData.combined_text}
              </>
            ) : (
              <span className="text-slate-500">
                {`Select a document from Search, fetch via URL, or upload a file to preview its raw text contents here.\n\nOnce content is loaded, you can verify it before saving to your Document Library.`}
              </span>
            )}
          </div>

          {/* Save Controls */}
          <div className="bg-slate-900 border-t border-slate-700 p-4">
            <div className="flex gap-3">
              <button
                type="button"
                onClick={handleSaveClick}
                disabled={isSaving || !crawlData}
                className="flex-1 bg-indigo-500 text-white rounded px-4 py-2 text-sm font-medium hover:bg-indigo-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSaving ? "Saving…" : "Save to Library"}
              </button>
              {crawlData && (
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-4 py-2 text-sm font-medium text-slate-300 border border-slate-600 rounded hover:bg-slate-800 transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
            {saveMessage && !showSaveConfirmation && (
              <p className="text-xs mt-2 text-slate-400">{saveMessage}</p>
            )}
          </div>
        </div>
      </div>

      {/* ─── Company Name / Jurisdiction Dialog ─── */}
      {showCompanyNameDialog && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card company-name-dialog">
            <div className="modal-header">
              <div>
                <p className="modal-title">
                  {isStatuteSave
                    ? "Confirm Jurisdiction"
                    : "Confirm Company Name"}
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
                  <label
                    className="field-label"
                    htmlFor="statute-jurisdiction"
                  >
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
      )}

      {/* ─── Save Confirmation Dialog ─── */}
      {showSaveConfirmation && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card save-confirmation-dialog">
            <div className="modal-header">
              <div>
                <p className="modal-title">Saved Successfully</p>
                <p className="modal-subtitle">
                  {saveMessage ||
                    "The policy has been saved to the collection."}
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
      )}
    </div>
  );
}
