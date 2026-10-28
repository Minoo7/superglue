import { authenticateNextJSApiRequest } from "@/src/lib/api-auth";
import { loadAgentModels, ModelSelectionError } from "@/src/lib/agent/model-controls.server";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const auth = await authenticateNextJSApiRequest(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(
      { models: await loadAgentModels() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof ModelSelectionError ? error.message : "Model catalog is unavailable.",
      },
      { status: 503 },
    );
  }
}
