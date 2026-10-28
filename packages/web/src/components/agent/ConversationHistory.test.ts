import { describe, expect, it } from "vitest";
import { updateConversationModelSelection, type Conversation } from "./ConversationHistory";

const conversation = (id: string, timestamp: Date): Conversation => ({
  id,
  title: `Chat ${id}`,
  summary: "Saved title",
  messages: [{ id: "message", role: "user", content: "hello", timestamp }],
  timestamp,
  lastSummarizedMessageCount: 5,
});

describe("conversation model metadata persistence", () => {
  it("should persist selection-only changes without changing history order, summary or message data", () => {
    const records = [conversation("recent", new Date(200)), conversation("older", new Date(100))];
    const updated = updateConversationModelSelection(records, "older", {
      modelId: "selected",
      reasoningEffort: "high",
    });
    expect(updated.map((record) => record.id)).toEqual(["recent", "older"]);
    expect(updated[1].modelSelection).toEqual({ modelId: "selected", reasoningEffort: "high" });
    expect(updated[1].timestamp).toBe(records[1].timestamp);
    expect(updated[1].messages).toBe(records[1].messages);
    expect(updated[1].summary).toBe("Saved title");
    expect(updated[1].lastSummarizedMessageCount).toBe(5);
    expect(records[1].modelSelection).toBeUndefined();
  });

  it("should preserve record identity for equal settings and ignore a different conversation", () => {
    const records = [
      { ...conversation("saved", new Date(100)), modelSelection: { modelId: "selected" } },
    ];
    expect(updateConversationModelSelection(records, "saved", { modelId: "selected" })).toBe(
      records,
    );
    expect(updateConversationModelSelection(records, "other", { modelId: "selected" })).toBe(
      records,
    );
    expect(updateConversationModelSelection(records, "saved")[0].modelSelection).toBeUndefined();
  });
});
