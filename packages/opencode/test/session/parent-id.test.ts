import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"

/**
 * Tests for correct parent-child relationships in message streams.
 *
 * Bug context: When context injection plugins (skills, beads, AGENTS.md) inject
 * synthetic user messages AFTER the actual user message, the assistant response's
 * parentID incorrectly points to the synthetic message instead of the actual user message.
 *
 * These tests verify the behavior of `findLastUserMessage` which is used to determine
 * which user message an assistant response should be parented to.
 */

function createUserMessage(id: string, sessionID: string, parts: MessageV2.Part[]): MessageV2.WithParts {
  return {
    info: {
      id,
      role: "user",
      sessionID,
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
    },
    parts,
  }
}

function createAssistantMessage(id: string, sessionID: string, parentID: string): MessageV2.WithParts {
  return {
    info: {
      id,
      role: "assistant",
      sessionID,
      parentID,
      modelID: "test-model",
      providerID: "test",
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now() },
    },
    parts: [],
  }
}

function createTextPart(messageID: string, sessionID: string, text: string, synthetic = false): MessageV2.TextPart {
  return {
    id: Identifier.ascending("part"),
    messageID,
    sessionID,
    type: "text",
    text,
    synthetic,
  }
}

/**
 * This replicates the CURRENT buggy behavior from prompt.ts lines 252-263.
 * It finds the last user message by scanning backwards, but does NOT skip synthetic messages.
 */
function findLastUserMessageBuggy(msgs: MessageV2.WithParts[]): MessageV2.User | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i]
    if (msg.info.role === "user") return msg.info as MessageV2.User
  }
  return undefined
}

describe("findLastUserMessage - current buggy behavior", () => {
  const sessionID = "test-session"

  test("BUG: returns synthetic message instead of actual user message", () => {
    // This is the bug scenario:
    // 1. User sends: "list your skills"
    // 2. Plugin injects: <available-skills>... (synthetic)
    // The buggy code returns the synthetic message as the parent

    const actualUserMsg = createUserMessage("msg-actual-user", sessionID, [
      createTextPart("msg-actual-user", sessionID, "list your skills"),
    ])

    const syntheticSkillsMsg = createUserMessage("msg-synthetic-skills", sessionID, [
      createTextPart("msg-synthetic-skills", sessionID, "<available-skills>skill1</available-skills>", true),
    ])

    const messages: MessageV2.WithParts[] = [actualUserMsg, syntheticSkillsMsg]

    // Current buggy behavior: picks the last user message regardless of synthetic flag
    const buggyResult = findLastUserMessageBuggy(messages)

    // This demonstrates the bug - it picks the synthetic message
    expect(buggyResult?.id).toBe("msg-synthetic-skills")
    // But it SHOULD have picked the actual user message
    expect(buggyResult?.id).not.toBe("msg-actual-user") // This is the bug!
  })

  test("BUG: with multiple synthetic injections, picks the last one", () => {
    const actualUserMsg = createUserMessage("msg-1-actual", sessionID, [
      createTextPart("msg-1-actual", sessionID, "What is the weather?"),
    ])

    const syntheticBeads = createUserMessage("msg-2-beads", sessionID, [
      createTextPart("msg-2-beads", sessionID, "<beads-context>memory</beads-context>", true),
    ])

    const syntheticSkills = createUserMessage("msg-3-skills", sessionID, [
      createTextPart("msg-3-skills", sessionID, "<available-skills>...</available-skills>", true),
    ])

    const messages: MessageV2.WithParts[] = [actualUserMsg, syntheticBeads, syntheticSkills]

    const buggyResult = findLastUserMessageBuggy(messages)

    // Bug: picks msg-3-skills (last synthetic) instead of msg-1-actual
    expect(buggyResult?.id).toBe("msg-3-skills")
  })
})

describe("findLastUserMessage - expected correct behavior", () => {
  const sessionID = "test-session"

  test("should return actual user message, skipping synthetic messages after it", () => {
    const actualUserMsg = createUserMessage("msg-actual-user", sessionID, [
      createTextPart("msg-actual-user", sessionID, "list your skills"),
    ])

    const syntheticSkillsMsg = createUserMessage("msg-synthetic-skills", sessionID, [
      createTextPart("msg-synthetic-skills", sessionID, "<available-skills>skill1</available-skills>", true),
    ])

    const messages: MessageV2.WithParts[] = [actualUserMsg, syntheticSkillsMsg]

    // The CORRECT behavior should find the actual user message
    const correctResult = MessageV2.findLastUserMessage(messages)

    expect(correctResult?.id).toBe("msg-actual-user")
  })

  test("should skip multiple synthetic messages to find actual user message", () => {
    const actualUserMsg = createUserMessage("msg-1-actual", sessionID, [
      createTextPart("msg-1-actual", sessionID, "What is the weather?"),
    ])

    const syntheticBeads = createUserMessage("msg-2-beads", sessionID, [
      createTextPart("msg-2-beads", sessionID, "<beads-context>memory</beads-context>", true),
    ])

    const syntheticSkills = createUserMessage("msg-3-skills", sessionID, [
      createTextPart("msg-3-skills", sessionID, "<available-skills>...</available-skills>", true),
    ])

    const messages: MessageV2.WithParts[] = [actualUserMsg, syntheticBeads, syntheticSkills]

    const correctResult = MessageV2.findLastUserMessage(messages)

    expect(correctResult?.id).toBe("msg-1-actual")
  })

  test("should find most recent actual user message in multi-turn conversation", () => {
    const firstUserMsg = createUserMessage("msg-1-first-user", sessionID, [
      createTextPart("msg-1-first-user", sessionID, "First question"),
    ])

    const firstAssistantMsg = createAssistantMessage("msg-2-assistant", sessionID, "msg-1-first-user")

    const secondUserMsg = createUserMessage("msg-3-second-user", sessionID, [
      createTextPart("msg-3-second-user", sessionID, "Follow-up question"),
    ])

    const syntheticInjection = createUserMessage("msg-4-synthetic", sessionID, [
      createTextPart("msg-4-synthetic", sessionID, "<skill>injected content</skill>", true),
    ])

    const messages: MessageV2.WithParts[] = [firstUserMsg, firstAssistantMsg, secondUserMsg, syntheticInjection]

    const correctResult = MessageV2.findLastUserMessage(messages)

    // Should find msg-3 (second actual user message), not msg-4 (synthetic)
    expect(correctResult?.id).toBe("msg-3-second-user")
  })

  test("should return undefined when all user messages are synthetic", () => {
    const syntheticMsg1 = createUserMessage("msg-1-synthetic", sessionID, [
      createTextPart("msg-1-synthetic", sessionID, "<available-skills>...</available-skills>", true),
    ])

    const syntheticMsg2 = createUserMessage("msg-2-synthetic", sessionID, [
      createTextPart("msg-2-synthetic", sessionID, "<beads-context>...</beads-context>", true),
    ])

    const messages: MessageV2.WithParts[] = [syntheticMsg1, syntheticMsg2]

    const result = MessageV2.findLastUserMessage(messages)

    expect(result).toBeUndefined()
  })

  test("should handle message with mixed synthetic and non-synthetic parts as actual", () => {
    // A message that has SOME non-synthetic content should be considered "actual"
    const mixedMsg = createUserMessage("msg-mixed", sessionID, [
      createTextPart("msg-mixed", sessionID, "<context>some context</context>", true),
      createTextPart("msg-mixed", sessionID, "But here is my actual question"), // non-synthetic
    ])

    const purelysyntheticMsg = createUserMessage("msg-synthetic", sessionID, [
      createTextPart("msg-synthetic", sessionID, "<available-skills>...</available-skills>", true),
    ])

    const messages: MessageV2.WithParts[] = [mixedMsg, purelysyntheticMsg]

    const result = MessageV2.findLastUserMessage(messages)

    // Should find the mixed message since it has non-synthetic content
    expect(result?.id).toBe("msg-mixed")
  })

  test("should work when actual user message is last (no synthetic messages)", () => {
    const userMsg = createUserMessage("msg-user", sessionID, [
      createTextPart("msg-user", sessionID, "A simple question"),
    ])

    const messages: MessageV2.WithParts[] = [userMsg]

    const result = MessageV2.findLastUserMessage(messages)

    expect(result?.id).toBe("msg-user")
  })

  test("should skip assistant messages when searching for user message", () => {
    const userMsg = createUserMessage("msg-1-user", sessionID, [
      createTextPart("msg-1-user", sessionID, "User question"),
    ])

    const assistantMsg = createAssistantMessage("msg-2-assistant", sessionID, "msg-1-user")

    const messages: MessageV2.WithParts[] = [userMsg, assistantMsg]

    const result = MessageV2.findLastUserMessage(messages)

    expect(result?.id).toBe("msg-1-user")
  })

  test("should return undefined for empty message array", () => {
    const result = MessageV2.findLastUserMessage([])

    expect(result).toBeUndefined()
  })
})

describe("parent-id assignment integration scenario", () => {
  const sessionID = "test-session"

  test("assistant response should be parented to actual user message, not synthetic injection", () => {
    // Full scenario simulation:
    // 1. User sends: "list your skills"
    // 2. Plugin injects: <available-skills>... as synthetic user message
    // 3. Assistant responds - its parentID should point to (1), not (2)

    const actualUserMsg = createUserMessage("msg-user-actual", sessionID, [
      createTextPart("msg-user-actual", sessionID, "list your skills"),
    ])

    const syntheticInjection = createUserMessage("msg-synthetic", sessionID, [
      createTextPart("msg-synthetic", sessionID, "<available-skills>skill-a, skill-b</available-skills>", true),
    ])

    const messages: MessageV2.WithParts[] = [actualUserMsg, syntheticInjection]

    // When we determine the parent for the assistant response
    const parentMessage = MessageV2.findLastUserMessage(messages)

    // The parent should be the actual user message
    expect(parentMessage?.id).toBe("msg-user-actual")

    // And NOT the synthetic injection
    expect(parentMessage?.id).not.toBe("msg-synthetic")

    // Now if we were to create an assistant message, it would use this correct parent
    const assistantMsg = createAssistantMessage("msg-assistant", sessionID, parentMessage!.id)
    expect(assistantMsg.info.role === "assistant" && assistantMsg.info.parentID).toBe("msg-user-actual")
  })
})
