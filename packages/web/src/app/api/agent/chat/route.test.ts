import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

const { initialize, infer, authenticate } = vi.hoisted(() => ({
  initialize: vi.fn(),
  infer: vi.fn(),
  authenticate: vi.fn(),
}));
vi.mock("@/src/lib/api-auth", () => ({ authenticateNextJSApiRequest: authenticate }));
vi.mock("@/src/lib/agent/agent-client", () => ({
  AgentClient: class {
    constructor(config: unknown) {
      initialize(config);
    }
    async *streamResponse() {
      infer();
      yield { type: "done" };
    }
    disconnect() {}
  },
}));
import { POST } from "./route";

const catalog = {
  models: [
    {
      slug: "text",
      display_name: "Text",
      visibility: "list",
      supported_reasoning_levels: [{ effort: "medium" }],
      default_reasoning_level: "medium",
    },
    { slug: "hidden", display_name: "Hidden", visibility: "hide", supported_reasoning_levels: [] },
  ],
};
const request = (selection?: unknown, agentId = "main") =>
  new NextRequest("https://app.invalid/api/agent/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentId,
      messages: [],
      userMessage: "hello",
      ...(selection !== undefined ? { modelSelection: selection } : {}),
    }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ token: "test-user", backendUrl: "https://backend.invalid" });
  vi.stubEnv("LLM_PROVIDER", "OPENAI");
  vi.stubEnv("OPENAI_API_KEY", "test-server-key");
  vi.stubEnv("OPENAI_BASE_URL", "https://provider.invalid/v1");
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

describe("chat model selection boundary", () => {
  it.each([
    { modelId: "hidden" },
    { modelId: "unknown" },
    { modelId: "text", reasoningEffort: "high" },
    { modelId: "text", baseURL: "https://other.invalid" },
    null,
  ])(
    "should reject invalid explicit choice %j before initialization or inference",
    async (selection) => {
      const response = await POST(request(selection));
      expect(response.status).toBe(400);
      expect(initialize).not.toHaveBeenCalled();
      expect(infer).not.toHaveBeenCalled();
    },
  );

  it("should reject non-main selection before contacting the catalog", async () => {
    const response = await POST(request({ modelId: "text" }, "playground"));
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
  });

  it("should reject an unavailable catalog without exposing upstream errors", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("private upstream URL and key"));
    const response = await POST(request({ modelId: "text" }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
    expect(initialize).not.toHaveBeenCalled();
  });

  it("should keep default chat functional without contacting the catalog", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("unavailable"));
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"done"');
    expect(fetch).not.toHaveBeenCalled();
    expect(infer).toHaveBeenCalledOnce();
  });

  it("should initialize with server-resolved effort before streaming a valid explicit model", async () => {
    const response = await POST(request({ modelId: "text" }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"done"');
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: { modelId: "text", reasoningEffort: "medium", reasoningCapable: true },
      }),
    );
  });
});
