import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useDocuments, extractDocumentId } from "./useDocuments";

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    json: () => Promise.resolve(body),
    headers: new Headers(),
  } as unknown as Response;
}

describe("useDocuments", () => {
  it("fetches documents on mount", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ documents: [{ _id: "1", title: "Doc 1" }] })
    );

    const { result } = renderHook(() => useDocuments("policy"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.documents).toHaveLength(1);
    expect(result.current.documents[0].title).toBe("Doc 1");
    expect(result.current.error).toBeNull();
  });

  it("does not clear documents on refetch (M-1 fix)", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ documents: [{ _id: "1", title: "Doc 1" }] })
    );

    const { result } = renderHook(() => useDocuments("policy"));

    await waitFor(() => {
      expect(result.current.documents).toHaveLength(1);
    });

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ documents: [{ _id: "1" }, { _id: "2" }] })
    );

    act(() => {
      result.current.refetch();
    });

    expect(result.current.documents).toHaveLength(1);

    await waitFor(() => {
      expect(result.current.documents).toHaveLength(2);
    });
  });

  it("sets error on failure", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const { result } = renderHook(() => useDocuments("policy"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBeTruthy();
    expect(result.current.documents).toHaveLength(0);
  });

  it("refetches when mode changes", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ documents: [] }));

    const { result, rerender } = renderHook(
      ({ mode }: { mode: "policy" | "statute" }) => useDocuments(mode),
      { initialProps: { mode: "policy" as const } }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ documents: [{ _id: "s1" }] })
    );

    rerender({ mode: "statute" });

    await waitFor(() => {
      expect(result.current.documents).toHaveLength(1);
    });
  });
});

describe("extractDocumentId", () => {
  it("extracts string id", () => {
    expect(extractDocumentId("abc-123")).toBe("abc-123");
  });

  it("extracts document_id from object", () => {
    expect(extractDocumentId({ document_id: "d1" })).toBe("d1");
  });

  it("extracts $oid from object", () => {
    expect(extractDocumentId({ $oid: "mongo-id" })).toBe("mongo-id");
  });

  it("extracts _id from object", () => {
    expect(extractDocumentId({ _id: "raw-id" })).toBe("raw-id");
  });

  it("returns empty for null/undefined", () => {
    expect(extractDocumentId(null)).toBe("");
    expect(extractDocumentId(undefined)).toBe("");
  });

  it("handles number", () => {
    expect(extractDocumentId(42)).toBe("42");
  });
});
