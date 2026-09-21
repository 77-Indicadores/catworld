import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ prisma: {} }));

import { runningJobsLikePattern } from "./db";

describe("runningJobsLikePattern", () => {
  it("escapa %, _ e a propria barra com barra invertida", () => {
    expect(runningJobsLikePattern("a%b_c\\d")).toBe("a\\%b\\_c\\\\d-%@%");
  });
  it("nome comum nao muda", () => {
    expect(runningJobsLikePattern("default")).toBe("default-%@%");
  });
});
