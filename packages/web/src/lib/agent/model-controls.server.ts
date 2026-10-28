import "server-only";

import type { AgentModelOption, AgentModelSelection } from "@superglue/shared";
import type { AgentType } from "./registries/agent-registry";

export class ModelSelectionError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 503,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeModelCatalog(value: unknown): AgentModelOption[] {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    throw new ModelSelectionError("Model catalog is unavailable.", 503);
  }
  const models = new Map<string, AgentModelOption>();
  const duplicates = new Set<string>();
  const seen = new Set<string>();
  for (const row of value.models) {
    if (!isRecord(row)) continue;
    const id = row.slug;
    if (typeof id !== "string" || !id.trim() || id.length > 200) continue;
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
    // The catalog's visibility does not distinguish image generators from chat models.
    if (row.visibility !== "list" || /(?:^|[-_./])(?:image|dall-e|gpt-image)(?:$|[-_./])/i.test(id))
      continue;
    if (typeof row.display_name !== "string" || !row.display_name.trim()) continue;
    const reasoningLevels = row.supported_reasoning_levels ?? [];
    if (!Array.isArray(reasoningLevels)) continue;
    const efforts: string[] = [];
    let malformed = false;
    for (const level of reasoningLevels) {
      if (
        !isRecord(level) ||
        typeof level.effort !== "string" ||
        !level.effort.trim() ||
        level.effort.length > 50
      ) {
        malformed = true;
        break;
      }
      if (!efforts.includes(level.effort)) efforts.push(level.effort);
    }
    if (malformed) continue;
    const defaultEffort = row.default_reasoning_level;
    if (
      defaultEffort != null &&
      (typeof defaultEffort !== "string" || !efforts.includes(defaultEffort))
    )
      continue;
    models.set(id, {
      id,
      label: row.display_name,
      reasoningEfforts: efforts,
      ...(typeof defaultEffort === "string" ? { defaultReasoningEffort: defaultEffort } : {}),
    });
  }
  for (const id of duplicates) models.delete(id);
  return [...models.values()];
}

export async function loadAgentModels(): Promise<AgentModelOption[]> {
  if (
    process.env.LLM_PROVIDER?.toLowerCase() !== "openai" ||
    (process.env.AI_GATEWAY_API_KEY && process.env.AI_GATEWAY_MODEL) ||
    !process.env.OPENAI_BASE_URL ||
    !process.env.OPENAI_API_KEY
  ) {
    throw new ModelSelectionError("Model selection is unavailable for this deployment.", 503);
  }
  try {
    const response = await fetch(
      `${process.env.OPENAI_BASE_URL.replace(/\/$/, "")}/models?client_version=superglue`,
      {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        signal: AbortSignal.timeout(8000),
        cache: "no-store",
      },
    );
    if (!response.ok) throw new Error();
    return normalizeModelCatalog(await response.json());
  } catch {
    throw new ModelSelectionError(
      "Model catalog is unavailable. Refresh models or use the deployment default.",
      503,
    );
  }
}

export interface ResolvedAgentModel extends AgentModelSelection {
  reasoningCapable: boolean;
}

export async function resolveModelSelection(
  selection: AgentModelSelection | undefined,
  agentId: AgentType,
): Promise<ResolvedAgentModel | undefined> {
  if (!selection) return undefined;
  if (agentId !== "main")
    throw new ModelSelectionError("Model selection is only supported in the main chat.", 400);
  const models = await loadAgentModels();
  const model = models.find((option) => option.id === selection.modelId);
  if (!model) throw new ModelSelectionError("Selected model is unavailable.", 400);
  if (
    selection.reasoningEffort !== undefined &&
    !model.reasoningEfforts.includes(selection.reasoningEffort)
  ) {
    throw new ModelSelectionError("Selected reasoning effort is unavailable for this model.", 400);
  }
  const reasoningEffort = selection.reasoningEffort ?? model.defaultReasoningEffort;
  return {
    modelId: model.id,
    reasoningCapable: model.reasoningEfforts.length > 0,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
}

export function agentProviderOptions(selection?: ResolvedAgentModel) {
  return {
    openai: {
      store: false,
      ...(selection?.reasoningCapable
        ? {
            ...(selection.reasoningEffort !== undefined
              ? { reasoningEffort: selection.reasoningEffort }
              : {}),
            forceReasoning: true,
          }
        : {}),
    },
  };
}
