import { useEffect, useState, useCallback } from "react";
import { apiPost } from "../api/client";
import type { DocumentRecord } from "../types/api";

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
    setDocuments([]);
    // #region agent log
    fetch('http://127.0.0.1:7900/ingest/7f03b215-7f34-44b8-af4b-b58b95aa6a53',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7a2619'},body:JSON.stringify({sessionId:'7a2619',location:'useDocuments.ts:fetchDocuments',message:'fetchDocuments start',data:{mode},hypothesisId:'all',timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    try {
      const data = await apiPost<{ documents?: DocumentRecord[] }>(
        "/api/documents",
        {
          database_name: "privacy-compliance",
          collection_name: mode === "policy" ? "policies" : "statutes",
        }
      );
      const arr = extractResponseArray(data);
      // #region agent log
      fetch('http://127.0.0.1:7900/ingest/7f03b215-7f34-44b8-af4b-b58b95aa6a53',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7a2619'},body:JSON.stringify({sessionId:'7a2619',location:'useDocuments.ts:fetchDocuments',message:'fetchDocuments success',data:{arrLen:arr.length},hypothesisId:'H4',timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      setDocuments(arr as DocumentRecord[]);
    } catch (err) {
      // #region agent log
      fetch('http://127.0.0.1:7900/ingest/7f03b215-7f34-44b8-af4b-b58b95aa6a53',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7a2619'},body:JSON.stringify({sessionId:'7a2619',location:'useDocuments.ts:fetchDocuments',message:'fetchDocuments error',data:{errMsg:err instanceof Error?err.message:String(err)},hypothesisId:'H4,H5',timestamp:Date.now()})}).catch(()=>{});
      // #endregion
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
