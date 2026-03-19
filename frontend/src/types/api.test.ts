import { describe, it, expect } from "vitest";
import { toGapAnalysisResponse } from "./api";
import type { ComplianceJob, GapAnalysisResponse } from "./api";

describe("toGapAnalysisResponse", () => {
  it("returns null for null input", () => {
    expect(toGapAnalysisResponse(null)).toBeNull();
  });

  it("extracts from job-shaped detail", () => {
    const job: ComplianceJob = {
      job_id: "j1",
      status: "completed",
      result: {
        policy_document_id: "p1",
        gaps: [{ status: "addressed" }],
        summary: { total_requirements: 1, addressed: 1 },
      },
    };
    const result = toGapAnalysisResponse(job);
    expect(result).not.toBeNull();
    expect(result!.gaps).toHaveLength(1);
  });

  it("extracts from flat gap response", () => {
    const flat: GapAnalysisResponse & { run_id?: string } = {
      policy_document_id: "p1",
      gaps: [{ status: "missing" }],
      summary: { total_requirements: 1, missing: 1 },
      run_id: "r1",
    };
    const result = toGapAnalysisResponse(flat);
    expect(result).not.toBeNull();
    expect(result!.gaps).toHaveLength(1);
  });

  it("returns null when no gaps present", () => {
    const job: ComplianceJob = {
      job_id: "j1",
      status: "completed",
      result: { policy_document_id: "p1" },
    };
    const result = toGapAnalysisResponse(job);
    expect(result).toBeNull();
  });
});
