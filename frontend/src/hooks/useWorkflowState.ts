import { useEffect, useState, useCallback } from "react";
import { apiGet } from "../api/client";
import type { WorkflowState } from "../types/api";

export function useWorkflowState(
  documentId: string | null,
  documentType: "policy" | "statute" = "policy"
) {
  const [state, setState] = useState<WorkflowState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchState = useCallback(async () => {
    if (!documentId) {
      setState(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<WorkflowState>(
        `/api/documents/${encodeURIComponent(documentId)}/workflow-state`,
        { document_type: documentType }
      );
      setState(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load workflow state.");
      setState(null);
    } finally {
      setLoading(false);
    }
  }, [documentId, documentType]);

  useEffect(() => {
    void fetchState();
  }, [fetchState]);

  return { state, loading, error, refetch: fetchState };
}

export function getMissingSteps(state: WorkflowState | null): string[] {
  if (!state?.steps) return ["gathered", "parsed", "vector_indexed"];
  const missing: string[] = [];
  const steps = state.steps;
  if (!steps.gathered?.completed) missing.push("gathered");
  if (!steps.parsed?.completed) missing.push("parsed");
  if (!steps.vector_indexed?.completed) missing.push("vector_indexed");
  return missing;
}
