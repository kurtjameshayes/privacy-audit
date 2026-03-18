import { useEffect, useState, useCallback } from "react";
import { apiPost } from "../api/client";
import type { DocumentRecord } from "../types/api";

const POLICY_DATABASE =
  (import.meta as Record<string, Record<string, string>>).env?.VITE_POLICY_DATABASE ?? "privacy-compliance";

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

export type DocMode = "policy" | "statute";

export function useDocuments(mode: DocMode) {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDocuments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiPost<{ documents?: DocumentRecord[] }>(
        "/api/documents",
        {
          database_name: POLICY_DATABASE,
          collection_name: mode === "policy" ? "policies" : "statutes",
        }
      );
      const arr = extractResponseArray(data);
      setDocuments(arr as DocumentRecord[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load documents.");
    } finally {
      setLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    void fetchDocuments();
  }, [fetchDocuments]);

  return { documents, loading, error, refetch: fetchDocuments };
}

export function extractDocumentId(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.document_id) return String(record.document_id).trim();
    const oid = record.$oid ?? record.oid ?? record.id ?? record._id;
    if (oid) return String(oid).trim();
  }
  return "";
}
