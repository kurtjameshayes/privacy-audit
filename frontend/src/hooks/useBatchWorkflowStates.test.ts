import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useBatchWorkflowStates } from "./useBatchWorkflowStates";

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

describe("useBatchWorkflowStates", () => {
  it("fetches states for given document IDs", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        states: {
          d1: {
            document_id: "d1",
            document_type: "policy",
            steps: {
              gathered: { completed: true, completed_at: "t" },
              parsed: { completed: true, completed_at: "t" },
              vector_indexed: { completed: true, completed_at: "t" },
            },
            ready_for_compliance: true,
          },
          d2: {
            document_id: "d2",
            document_type: "policy",
            steps: {
              gathered: { completed: false, completed_at: null },
              parsed: { completed: false, completed_at: null },
              vector_indexed: { completed: false, completed_at: null },
            },
            ready_for_compliance: false,
          },
        },
      })
    );

    const { result } = renderHook(() =>
      useBatchWorkflowStates(["d1", "d2"], "policy")
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.states.d1?.ready_for_compliance).toBe(true);
    expect(result.current.states.d2?.ready_for_compliance).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("returns empty states for empty document IDs", async () => {
    const { result } = renderHook(() =>
      useBatchWorkflowStates([], "policy")
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.states).toEqual({});
  });

  it("handles error gracefully", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const { result } = renderHook(() =>
      useBatchWorkflowStates(["d1"], "policy")
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBeTruthy();
  });

  it("sends correct document_type", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ states: {} }));

    renderHook(() => useBatchWorkflowStates(["s1"], "statute"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.document_type).toBe("statute");
    expect(body.document_ids).toEqual(["s1"]);
  });
});
