/* OpenAPI-aligned TypeScript interfaces */

export interface AlertListItem {
  alert_id?: string;
  company_name?: string | null;
  policy_document_id?: string;
  trigger?: string;
  type?: string;
  affected_jurisdictions?: string[];
  previous_score?: number | null;
  current_score?: number | null;
  score_delta?: number | null;
  new_gaps?: unknown[];
  resolved_gaps?: unknown[];
  detected_at?: string;
}

export interface AlertsListResponse {
  alerts: AlertListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface CitationItem {
  alignment?: boolean;
  jurisdiction?: string;
  policy_chunk_id?: string | null;
  policy_excerpt?: string;
  statute_excerpt?: string | null;
  statute_reference?: string;
}

export interface CitationsRequest {
  policy_document_id: string;
  applicable_jurisdictions?: string[];
}

export interface CitationsResponse {
  analyzed_at?: string;
  applicable_jurisdictions?: string[];
  citations: CitationItem[];
  company_name?: string | null;
  policy_document_id?: string;
  summary?: {
    aligned?: number;
    not_aligned?: number;
    total_citations?: number;
  };
}

export interface AppliedStatute {
  statute_id: string;
  jurisdiction: string;
  title: string;
  section_id: string;
  matched_span: string;
  evidence_score: number;
}

export interface PolicySectionResult {
  section_id: string;
  section_text: string;
  applied_statutes: AppliedStatute[];
  compliance: "compliant" | "non_compliant" | "neither";
  confidence: number;
  rationale: string;
  remediation_suggestions: string[];
  retrieval_trace: string[];
}

export interface SummaryCounts {
  compliant: number;
  non_compliant: number;
  neither: number;
}

export interface SummaryResult {
  overall_compliance: "compliant" | "non_compliant" | "mixed" | "unknown";
  counts: SummaryCounts;
}

export interface PolicyStatuteComplianceResponse {
  policy_id: string | null;
  jurisdiction: string;
  sections: PolicySectionResult[];
  summary: SummaryResult;
  warnings: string[];
}

export interface PolicyStatuteComplianceRequest {
  policy_id: string;
  policy_collection: string;
  jurisdiction: string;
}

export interface ReportRequest {
  policy_document_id: string;
  format: "markdown" | "pdf";
  source?: "latest_stored" | "run_now";
  applicable_jurisdictions?: string[];
  include_gap?: boolean;
  include_health_score?: boolean;
  include_multi_jurisdictional?: boolean;
}

export interface ReportResponseMarkdown {
  format: "markdown";
  content: string;
}

export interface RiskAssessmentRequest {
  policy_document_id: string;
  applicable_jurisdictions?: string[];
  template_id?: string | null;
  include_report?: boolean;
}

export interface RiskAssessmentResponse {
  analyzed_at?: string;
  applicable_jurisdictions?: string[];
  assessment?: Record<string, unknown>;
  company_name?: string | null;
  policy_document_id?: string;
  report?: string | null;
  template_id?: string;
}

export interface TemplateItem {
  id: string;
  label: string;
}

export interface TemplatesResponse {
  templates: TemplateItem[];
}

export interface RunSummaryItem {
  company_name?: string | null;
  policy_document_id?: string;
  privacy_health_score?: number | null;
  run_at?: string;
  run_id?: string;
  summary?: {
    addressed?: number;
    conflicts?: number;
    missing?: number;
    total_requirements?: number;
  };
  types?: string[];
}

export interface RunsListResponse {
  runs: RunSummaryItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface GapItem {
  jurisdiction?: string;
  requirement_summary?: string;
  status?: "missing" | "addressed" | "conflict";
  policy_quote?: string | null;
  conflict_description?: string | null;
  statute_name?: string | null;
  section?: string | null;
  analysis_failed?: boolean;
}

export interface GapSummary {
  total_requirements?: number;
  addressed?: number;
  missing?: number;
  conflicts?: number;
}

export interface GapAnalysisResponse {
  policy_document_id?: string;
  company_name?: string | null;
  applicable_jurisdictions?: string[];
  analyzed_at?: string;
  gaps?: GapItem[];
  summary?: GapSummary;
  error?: string;
  message?: string;
}

export interface ErrorResponse {
  error?: string;
}

export interface WorkflowStepState {
  completed: boolean;
  completed_at: string | null;
}

export interface WorkflowState {
  document_id: string;
  document_type: "policy" | "statute";
  steps?: {
    gathered?: WorkflowStepState;
    parsed?: WorkflowStepState;
    vector_indexed?: WorkflowStepState;
  };
  ready_for_compliance?: boolean;
}

export interface DocumentRecord {
  _id?: unknown;
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
