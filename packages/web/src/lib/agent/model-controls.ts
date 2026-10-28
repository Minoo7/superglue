import type { AgentModelOption, AgentModelSelection } from "@superglue/shared";

export const MODEL_SELECTION_REJECTED = "MODEL_SELECTION_REJECTED";

export function parseModelSelection(value: unknown): AgentModelSelection | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("modelId" in value) ||
    typeof value.modelId !== "string" ||
    !value.modelId.trim() ||
    value.modelId.length > 200 ||
    ("reasoningEffort" in value &&
      value.reasoningEffort !== undefined &&
      (typeof value.reasoningEffort !== "string" ||
        !value.reasoningEffort.trim() ||
        value.reasoningEffort.length > 50)) ||
    Object.keys(value).some((key) => key !== "modelId" && key !== "reasoningEffort")
  )
    throw new Error("Invalid model selection.");
  return {
    modelId: value.modelId,
    ...("reasoningEffort" in value && typeof value.reasoningEffort === "string"
      ? { reasoningEffort: value.reasoningEffort }
      : {}),
  };
}

export function selectionsEqual(a?: AgentModelSelection, b?: AgentModelSelection): boolean {
  return a?.modelId === b?.modelId && a?.reasoningEffort === b?.reasoningEffort;
}

export function isSelectionAvailable(
  selection: AgentModelSelection | undefined,
  models: AgentModelOption[],
): boolean {
  if (!selection) return true;
  const model = models.find((option) => option.id === selection.modelId);
  return (
    !!model &&
    (selection.reasoningEffort === undefined ||
      model.reasoningEfforts.includes(selection.reasoningEffort))
  );
}
