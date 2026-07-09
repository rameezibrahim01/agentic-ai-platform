import { describe, expect, it } from "vitest";
import { CORE_READY } from "@platform/core";

describe("scaffold: @platform/core", () => {
  it("is wired into the workspace (flips to true in ticket 001)", () => {
    expect(CORE_READY).toBe(false);
  });
});
