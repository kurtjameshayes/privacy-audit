import type { GapAnalysisResponse, GapItem, GapSummary } from "../types/api";

type GapFilter = "all" | "missing" | "addressed" | "conflict";

function truncateRequirement(text: string, maxLen: number): string {
  if (!text || text.length <= maxLen) return text;
  return text.slice(0, maxLen).trimEnd() + "…";
}

export function GapItemCard({
  gap,
  expanded,
  onToggle,
}: {
  gap: GapItem;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const status = gap.analysis_failed ? "failed" : gap.status ?? "missing";
  const statusLabel =
    gap.analysis_failed
      ? "Analysis failed"
      : status === "conflict"
        ? "Conflict"
        : status.charAt(0).toUpperCase() + status.slice(1);

  const hasDetails =
    gap.policy_quote ||
    gap.statute_quote ||
    gap.conflict_description ||
    gap.statute_name ||
    gap.section;

  return (
    <article className="result-card gap-item-card">
      <div className="gap-item-header">
        <div className="gap-item-header-main">
          <p className="gap-item-summary">
            {truncateRequirement(gap.requirement_summary ?? "", 80)}
          </p>
          <div className="gap-item-badges">
            {gap.jurisdiction && (
              <span className="gap-item-meta">
                <span className="gap-item-meta-label">Jurisdiction</span>
                <span className="gap-jurisdiction-badge">{gap.jurisdiction}</span>
              </span>
            )}
            <span className="gap-item-meta">
              <span className="gap-item-meta-label">Resolution</span>
              <span
                className={`compliance-badge compliance-badge--${status === "failed" ? "analysis_failed" : status}`}
              >
                {statusLabel}
              </span>
            </span>
            {gap.confidence && (
              <span className="gap-item-meta">
                <span className="gap-item-meta-label">Confidence</span>
                <span className="gap-confidence-badge">{gap.confidence}</span>
              </span>
            )}
          </div>
        </div>
      </div>
      {hasDetails && (
        <div className="gap-item-body">
          {gap.policy_quote && (
            <div className="gap-item-detail-block">
              <p className="compliance-detail-label">Policy quote</p>
              <blockquote className="applied-statute-span">
                {gap.policy_quote}
              </blockquote>
            </div>
          )}
          {gap.statute_quote && (
            <div className="gap-item-detail-block">
              <p className="compliance-detail-label">Statute requirement</p>
              <blockquote className="gap-statute-quote">
                {gap.statute_quote}
              </blockquote>
            </div>
          )}
          {gap.conflict_description && (
            <div className="gap-item-detail-block gap-conflict-block">
              <p className="compliance-detail-label">Conflict</p>
              <p className="gap-conflict-text">{gap.conflict_description}</p>
            </div>
          )}
          {(gap.statute_name || gap.section || gap.statute_reference) && (
            <div className="gap-item-detail-block">
              <p className="compliance-detail-label">Statute</p>
              <p className="gap-statute-meta">
                {[gap.statute_name, gap.section, gap.statute_reference]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
          )}
          {onToggle && (gap.policy_subchunk_text || gap.statute_subchunk_text) && (
            <button
              type="button"
              className="ghost-button gap-expand-btn"
              onClick={onToggle}
              aria-expanded={expanded}
            >
              {expanded ? "Hide full context" : "Show full context"}
            </button>
          )}
          {expanded && (gap.policy_subchunk_text || gap.statute_subchunk_text) && (
            <div className="gap-expanded-context">
              {gap.statute_subchunk_text && (
                <div className="gap-item-detail-block">
                  <p className="compliance-detail-label">Statute context</p>
                  <div className="gap-context-block">{gap.statute_subchunk_text}</div>
                </div>
              )}
              {gap.policy_subchunk_text && (
                <div className="gap-item-detail-block">
                  <p className="compliance-detail-label">Policy context</p>
                  <div className="gap-context-block">{gap.policy_subchunk_text}</div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export function GapAnalysisResult({
  result,
  filteredItems,
  gapFilter,
  onFilterChange,
  expandedGapIndex,
  onExpandGap,
}: {
  result: GapAnalysisResponse;
  filteredItems: GapItem[];
  gapFilter: GapFilter;
  onFilterChange: (f: GapFilter) => void;
  expandedGapIndex?: number | null;
  onExpandGap?: (index: number | null) => void;
}) {
  const summary = (result.summary ?? {}) as GapSummary;
  const total = summary.total_requirements ?? 0;
  const addressed = summary.addressed ?? 0;
  const missing = summary.missing ?? 0;
  const conflicts = summary.conflicts ?? 0;

  return (
    <div className="gap-analysis-result">
      <div className="header-card compliance-summary-strip gap-summary-strip">
        <p className="header-card-title">Total requirements</p>
        <p className="header-card-value">{total}</p>
        <div className="compliance-summary-badges">
          <span className="compliance-summary-badge compliance-badge--addressed">
            {addressed} addressed
          </span>
          <span className="compliance-summary-badge compliance-badge--missing">
            {missing} missing
          </span>
          <span className="compliance-summary-badge compliance-badge--conflict">
            {conflicts} conflicts
          </span>
        </div>
      </div>
      <div className="compliance-filters">
        {(
          [
            ["all", "All"],
            ["missing", "Missing"],
            ["addressed", "Addressed"],
            ["conflict", "Conflicts"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`mode-button ${gapFilter === value ? "is-active" : ""}`}
            onClick={() => onFilterChange(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="compliance-section-list">
        {filteredItems.length === 0 ? (
          <p className="gap-empty-message">
            {result.gaps?.length === 0
              ? "No gaps found. All requirements are addressed."
              : `No ${gapFilter === "all" ? "" : gapFilter + " "}gaps match the filter.`}
          </p>
        ) : (
          filteredItems.map((gap, i) => (
            <GapItemCard
              key={i}
              gap={gap}
              expanded={expandedGapIndex === i}
              onToggle={
                onExpandGap
                  ? () => onExpandGap(expandedGapIndex === i ? null : i)
                  : undefined
              }
            />
          ))
        )}
      </div>
    </div>
  );
}
