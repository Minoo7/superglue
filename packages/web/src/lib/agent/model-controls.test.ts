import { describe, expect, it } from "vitest";
import { isSelectionAvailable, parseModelSelection, selectionsEqual } from "./model-controls";

describe("model selection", () => {
  it("should preserve deployment default when selection is omitted", () => {
    expect(parseModelSelection(undefined)).toBeUndefined();
    expect(isSelectionAvailable(undefined, [])).toBe(true);
  });

  it.each([
    null,
    [],
    {},
    { modelId: "" },
    { modelId: "text", reasoningEffort: 3 },
    { modelId: "text", baseURL: "https://other.example" },
  ])("should reject malformed selection %j", (value) => {
    expect(() => parseModelSelection(value)).toThrow();
  });

  it("should keep a stale model or effort unavailable instead of substituting defaults", () => {
    const models = [{ id: "text", label: "Text", reasoningEfforts: ["low"] }];
    expect(isSelectionAvailable({ modelId: "missing" }, models)).toBe(false);
    expect(isSelectionAvailable({ modelId: "text", reasoningEffort: "high" }, models)).toBe(false);
    expect(isSelectionAvailable({ modelId: "text", reasoningEffort: "low" }, models)).toBe(true);
  });

  it("should distinguish selection-only changes from equal persisted settings", () => {
    expect(
      selectionsEqual(
        { modelId: "text", reasoningEffort: "low" },
        { modelId: "text", reasoningEffort: "low" },
      ),
    ).toBe(true);
    expect(
      selectionsEqual(
        { modelId: "text", reasoningEffort: "low" },
        { modelId: "text", reasoningEffort: "high" },
      ),
    ).toBe(false);
    expect(selectionsEqual({ modelId: "text" }, undefined)).toBe(false);
  });
});
