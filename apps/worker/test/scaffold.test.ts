import { describe, expect, it } from "vitest";
import { WORKER_READY } from "../src/index.js";

describe("scaffold: @platform/worker", () => {
  it("is wired into the workspace (flips to true in ticket 003)", () => {
    expect(WORKER_READY).toBe(false);
  });
});
