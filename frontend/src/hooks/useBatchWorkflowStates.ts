import { useEffect, useState, useCallback } from "react";
import { apiPost } from "../api/client";
import type { WorkflowState } from "../types/api";

export function useBatchWorkflowStates(
  documentIds: string[],
  documentType: "policy" | "statute" = "policy"
) {
  const [states, setStates] = useState<Record<string, WorkflowState>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const idsKey = documentIds.slice().sort().join(",");

  const fetchStates = useCallback(async () => {
    if (!documentIds.length) {
      setStates({});
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await apiPost<{ states: Record<string, WorkflowState> }>(
        "/api/documents/workflow-states",
        { document_ids: documentIds, document_type: documentType }
      );
      setStates(data.states ?? {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load workflow states.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, documentType]);

  useEffect(() => {
    void fetchStates();
  }, [fetchStates]);

  return { states, loading, error, refetch: fetchStates };
}
