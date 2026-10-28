import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { authenticate } = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/src/lib/api-auth", () => ({ authenticateNextJSApiRequest: authenticate }));
import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ token: "test-user", backendUrl: "https://backend.invalid" });
  vi.stubEnv("LLM_PROVIDER", "OPENAI");
  vi.stubEnv("OPENAI_API_KEY", "test-server-key");
  vi.stubEnv("OPENAI_BASE_URL", "https://provider.invalid/v1");
  vi.stubEnv("AI_GATEWAY_API_KEY", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        models: [
          {
            slug: "text",
            display_name: "Text",
            visibility: "list",
            supported_reasoning_levels: [{ effort: "high" }],
            default_reasoning_level: "high",
            base_instructions: "private instructions",
          },
        ],
      }),
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("authenticated model catalog", () => {
  it("should require the existing authentication boundary before contacting upstream", async () => {
    authenticate.mockResolvedValue(null);
    const response = await GET(new NextRequest("https://app.invalid/api/agent/models"));
    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("should return only normalized capabilities with no wildcard CORS", async () => {
    const response = await GET(new NextRequest("https://app.invalid/api/agent/models"));
    expect(await response.json()).toEqual({
      models: [
        { id: "text", label: "Text", reasoningEfforts: ["high"], defaultReasoningEffort: "high" },
      ],
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("should sanitize upstream errors", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("private URL and credential"));
    const response = await GET(new NextRequest("https://app.invalid/api/agent/models"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(
      /private|credential|provider.invalid|test-server-key/,
    );
  });
});
