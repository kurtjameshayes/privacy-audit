import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useWorkflowState, getMissingSteps } from "./useWorkflowState";
import type { WorkflowState } from "../types/api";

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

describe("useWorkflowState", () => {
  it("fetches state for a document", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        document_id: "d1",
        document_type: "policy",
        steps: {
          gathered: { completed: true, completed_at: "t" },
          parsed: { completed: false, completed_at: null },
          vector_indexed: { completed: false, completed_at: null },
        },
        ready_for_compliance: false,
      })
    );

    const { result } = renderHook(() => useWorkflowState("d1", "policy"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.state?.document_id).toBe("d1");
    expect(result.current.state?.steps?.gathered?.completed).toBe(true);
  });

  it("returns null state when documentId is null", async () => {
    const { result } = renderHook(() => useWorkflowState(null));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.state).toBeNull();
  });

  it("handles fetch error", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const { result } = renderHook(() => useWorkflowState("d1"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBeTruthy();
    expect(result.current.state).toBeNull();
  });
});

describe("getMissingSteps", () => {
  it("returns all steps when state is null", () => {
    expect(getMissingSteps(null)).toEqual(["gathered", "parsed", "vector_indexed"]);
  });

  it("returns all steps when steps is empty", () => {
    const state: WorkflowState = {
      document_id: "d1",
      document_type: "policy",
      steps: {},
    };
    expect(getMissingSteps(state)).toEqual(["gathered", "parsed", "vector_indexed"]);
  });

  it("returns only incomplete steps", () => {
    const state: WorkflowState = {
      document_id: "d1",
      document_type: "policy",
      steps: {
        gathered: { completed: true, completed_at: "t" },
        parsed: { completed: true, completed_at: "t" },
        vector_indexed: { completed: false, completed_at: null },
      },
    };
    expect(getMissingSteps(state)).toEqual(["vector_indexed"]);
  });

  it("returns empty when all complete", () => {
    const state: WorkflowState = {
      document_id: "d1",
      document_type: "policy",
      steps: {
        gathered: { completed: true, completed_at: "t" },
        parsed: { completed: true, completed_at: "t" },
        vector_indexed: { completed: true, completed_at: "t" },
      },
      ready_for_compliance: true,
    };
    expect(getMissingSteps(state)).toEqual([]);
  });
});
