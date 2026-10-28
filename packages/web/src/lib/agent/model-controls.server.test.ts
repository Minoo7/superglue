import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentType } from "./registries/agent-registry";
import {
  agentProviderOptions,
  loadAgentModels,
  normalizeModelCatalog,
  resolveModelSelection,
} from "./model-controls.server";
vi.mock("server-only", () => ({}));
const main = AgentType.MAIN;
const playground = AgentType.PLAYGROUND;

const row = (slug: string, extra = {}) => ({
  slug,
  display_name: slug.toUpperCase(),
  visibility: "list",
  supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }],
  default_reasoning_level: "low",
  ...extra,
});
const catalog = {
  models: [
    row("text"),
    row("hidden", { visibility: "hide" }),
    row("gemini-3.1-flash-image"),
    row("gpt-image-1"),
    row("dall-e-3"),
    row("duplicate"),
    row("duplicate"),
    row("broken", { supported_reasoning_levels: [null] }),
  ],
};

beforeEach(() => {
  vi.stubEnv("LLM_PROVIDER", "OPENAI");
  vi.stubEnv("OPENAI_BASE_URL", "https://provider.invalid/v1/");
  vi.stubEnv("OPENAI_API_KEY", "test-only-key");
  vi.stubEnv("AI_GATEWAY_API_KEY", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(catalog)),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("agent model catalog", () => {
  it("should expose only eligible unique chat models and advertised capabilities", () => {
    expect(normalizeModelCatalog(catalog)).toEqual([
      {
        id: "text",
        label: "TEXT",
        reasoningEfforts: ["low", "ultra"],
        defaultReasoningEffort: "low",
      },
    ]);
    expect(() => normalizeModelCatalog({ data: [{ id: "text" }] })).toThrow();
    expect(
      normalizeModelCatalog({
        models: [row("duplicate"), row("duplicate", { visibility: "hide" })],
      }),
    ).toEqual([]);
  });

  it("should keep models without reasoning metadata usable without inventing efforts", async () => {
    const plain = row("plain", {
      supported_reasoning_levels: undefined,
      default_reasoning_level: undefined,
    });
    vi.mocked(fetch).mockImplementation(async () => Response.json({ models: [plain] }));
    const selection = await resolveModelSelection({ modelId: "plain" }, main);
    expect(selection).toEqual({ modelId: "plain", reasoningCapable: false });
    expect(agentProviderOptions(selection).openai).not.toHaveProperty("forceReasoning");
    await expect(
      resolveModelSelection({ modelId: "plain", reasoningEffort: "low" }, main),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("should use the configured server catalog without exposing upstream metadata", async () => {
    const models = await loadAgentModels();
    expect(fetch).toHaveBeenCalledWith(
      "https://provider.invalid/v1/models?client_version=superglue",
      expect.objectContaining({
        cache: "no-store",
        headers: { Authorization: "Bearer test-only-key" },
      }),
    );
    expect(JSON.stringify(models)).not.toMatch(/key|provider.invalid|visibility|instructions/);
  });

  it("should preserve the default path without any catalog dependency", async () => {
    vi.stubEnv("LLM_PROVIDER", "ANTHROPIC");
    expect(await resolveModelSelection(undefined, main)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["hidden", "gemini-3.1-flash-image", "missing", "duplicate"])(
    "should reject unavailable explicit model %s",
    async (modelId) => {
      await expect(resolveModelSelection({ modelId }, main)).rejects.toMatchObject({ status: 400 });
    },
  );

  it("should reject an incompatible effort and a non-main override", async () => {
    await expect(
      resolveModelSelection({ modelId: "text", reasoningEffort: "invented" }, main),
    ).rejects.toMatchObject({ status: 400 });
    vi.mocked(fetch).mockClear();
    await expect(resolveModelSelection({ modelId: "text" }, playground)).rejects.toMatchObject({
      status: 400,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("should resolve advertised defaults and sanitized catalog failures", async () => {
    expect(await resolveModelSelection({ modelId: "text" }, main)).toMatchObject({
      modelId: "text",
      reasoningEffort: "low",
      reasoningCapable: true,
    });
    vi.mocked(fetch).mockRejectedValue(new Error("secret upstream information"));
    await expect(resolveModelSelection({ modelId: "text" }, main)).rejects.toMatchObject({
      status: 503,
      message: expect.not.stringContaining("secret"),
    });
  });

  it("should reject gateway overrides while preserving gateway defaults", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "test-gateway-key");
    vi.stubEnv("AI_GATEWAY_MODEL", "default/model");
    await expect(resolveModelSelection({ modelId: "text" }, main)).rejects.toMatchObject({
      status: 503,
    });
    expect(await resolveModelSelection(undefined, main)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("should send selected model, unrestricted catalog effort and stateless reasoning through the real Responses SDK", async () => {
    const selection = await resolveModelSelection(
      { modelId: "text", reasoningEffort: "ultra" },
      main,
    );
    const requests: Record<string, unknown>[] = [];
    const provider = createOpenAI({
      apiKey: "test-only-key",
      baseURL: "https://provider.invalid/v1",
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json({
          id: "response-test",
          object: "response",
          created_at: 1,
          model: "text",
          status: "completed",
          output: [
            {
              id: "message-test",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "ready", annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      },
    });
    const result = await generateText({
      model: provider.responses(selection!.modelId),
      prompt: "hello",
      providerOptions: agentProviderOptions(selection),
    });
    expect(result.text).toBe("ready");
    expect(requests[0]).toMatchObject({
      model: "text",
      store: false,
      reasoning: { effort: "ultra" },
      include: ["reasoning.encrypted_content"],
    });
    await generateText({
      model: provider.responses("deployment-model"),
      prompt: "hello",
      providerOptions: agentProviderOptions(),
    });
    expect(requests[1]).toMatchObject({ model: "deployment-model", store: false });
  });
});
