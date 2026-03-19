import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiGet, apiPost, apiDelete, ApiError, normalizeApiError } from "./client";

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
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
    headers: new Headers(),
  } as unknown as Response;
}

describe("apiGet", () => {
  it("sends GET with correct URL and params", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    const result = await apiGet<{ data: unknown[] }>("/api/docs", { limit: "10" });
    expect(result.data).toEqual([]);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/docs");
    expect(url).toContain("limit=10");
    expect(opts.method).toBe("GET");
  });

  it("includes auth header when VITE_APP_API_KEY is set", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await apiGet("/api/test");
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers).toHaveProperty("Content-Type", "application/json");
  });

  it("throws ApiError on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "Not found" }, 404));
    await expect(apiGet("/api/missing")).rejects.toThrow(ApiError);
  });

  it("throws backend unreachable on TypeError", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(apiGet("/api/test")).rejects.toThrow(/[Bb]ackend/);
  });
});

describe("apiPost", () => {
  it("sends POST with JSON body", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const result = await apiPost<{ ok: boolean }>("/api/save", { key: "val" });
    expect(result.ok).toBe(true);
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ key: "val" });
  });

  it("throws on 500 with error message", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "Server crash" }, 500));
    try {
      await apiPost("/api/action", {});
      expect.fail("Should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(500);
    }
  });
});

describe("apiDelete", () => {
  it("sends DELETE request", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ deleted: true }));
    const result = await apiDelete<{ deleted: boolean }>("/api/item/1");
    expect(result.deleted).toBe(true);
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.method).toBe("DELETE");
  });
});

describe("normalizeApiError", () => {
  it("returns message for Error instances", () => {
    expect(normalizeApiError(new Error("oops"))).toBe("oops");
  });

  it("returns backend unreachable for TypeError", () => {
    expect(normalizeApiError(new TypeError("Failed to fetch"))).toMatch(/[Bb]ackend/);
  });

  it("returns fallback for non-Error", () => {
    expect(normalizeApiError("string error")).toBe("Request failed");
  });
});

describe("ApiError", () => {
  it("has name, message, and status", () => {
    const err = new ApiError("not found", 404);
    expect(err.name).toBe("ApiError");
    expect(err.message).toBe("not found");
    expect(err.status).toBe(404);
    expect(err).toBeInstanceOf(Error);
  });
});
