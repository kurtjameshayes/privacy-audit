/**
 * Preprocess compliance report content for readable markdown display.
 * Converts plain-text report patterns (e.g. "Policy ID: xxx Company: yyy")
 * into structured markdown when the content lacks markdown syntax.
 */
export function formatReportContent(content: string): string {
  if (!content || typeof content !== "string") return content;

  // Already has markdown structure - pass through
  if (/^#+\s/m.test(content) || /^\s*[-*]\s/m.test(content)) {
    return content;
  }

  let out = content.trim();

  // Section headers: "Compliance Report" at start
  out = out.replace(/^Compliance Report\b/, "## Compliance Report\n\n");

  // Section headers: "Gap Analysis", "Executive Summary", "Multi-Jurisdictional"
  out = out.replace(/\b(Gap Analysis)\b(?=\s|$)/g, "\n\n## $1\n\n");
  out = out.replace(/\b(Executive Summary)\b(?=\s|$)/g, "\n\n## $1\n\n");
  out = out.replace(/\b(Multi-Jurisdictional Conflicts?)\b(?=\s|$)/gi, "\n\n## $1\n\n");

  // Field labels: "Policy ID:", "Company:", "Analyzed at:", etc.
  const fieldLabels = [
    "Policy ID",
    "Company",
    "Analyzed at",
    "Total requirements",
    "Addressed",
    "Missing",
    "Partial",
    "Ambiguous",
    "Conflicts",
    "Privacy Health Score",
    "Score",
  ];
  for (const label of fieldLabels) {
    const re = new RegExp(`\\s+(${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}):\\s*`, "gi");
    out = out.replace(re, "\n\n**$1:** ");
  }

  return out.trim();
}
