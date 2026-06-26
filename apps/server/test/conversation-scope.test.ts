import { describe, expect, it } from "vitest";
import { findLatestJobConversationScope, type ConversationTurnCandidate } from "auto-chat-shared";

describe("conversation scope selection", () => {
  it("selects the latest assistant turn for repeated job submissions", () => {
    const turns: ConversationTurnCandidate[] = [
      { role: "user", text: "JOB_ID: img_1\n生成 4 张图" },
      { role: "assistant", text: "first response with one image" },
      { role: "user", text: "JOB_ID: img_1\n生成 4 张图" },
      { role: "assistant", text: "second response with four images" }
    ];

    expect(findLatestJobConversationScope(turns, "img_1")).toEqual({
      userIndex: 2,
      assistantIndex: 3,
      nextUserIndex: null
    });
  });

  it("limits the selected scope at the next user turn", () => {
    const turns: ConversationTurnCandidate[] = [
      { role: "user", text: "JOB_ID: img_1" },
      { role: "assistant", text: "first response" },
      { role: "user", text: "unrelated prompt" },
      { role: "assistant", text: "unrelated response" }
    ];

    expect(findLatestJobConversationScope(turns, "img_1")).toEqual({
      userIndex: 0,
      assistantIndex: 1,
      nextUserIndex: 2
    });
  });

  it("does not fall back to stale output when the latest matching user turn is still waiting", () => {
    const turns: ConversationTurnCandidate[] = [
      { role: "user", text: "JOB_ID: img_1" },
      { role: "assistant", text: "old response" },
      { role: "user", text: "JOB_ID: img_1" }
    ];

    expect(findLatestJobConversationScope(turns, "img_1")).toEqual({
      userIndex: 2,
      assistantIndex: null,
      nextUserIndex: null
    });
  });
});
