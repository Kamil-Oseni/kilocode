import { expect, test } from "bun:test"
import { matches, sameContent } from "../../webview-ui/src/utils/routine-draft-recovery"

test("a retained Routine draft needs the same owner and conversation before a SQL summary can settle it", () => {
  const cached = {
    body: "  Keep my notes  ",
    files: [{ id: "file", name: "notes.txt", mime: "text/plain", size: 12 }],
    base: 3,
    owner: "profile-a",
    conversationID: "conversation-a",
  }
  const saved = {
    draft: cached.body,
    draftAttachments: cached.files,
    draftRevision: 4,
    owner: cached.owner,
    conversationID: cached.conversationID,
  }
  expect(matches(cached, saved)).toBe(true)
  expect(matches(cached, { ...saved, owner: "profile-b" })).toBe(false)
  expect(matches(cached, { ...saved, conversationID: "conversation-b" })).toBe(false)
  expect(matches(cached, { ...saved, draftRevision: 2 })).toBe(false)
  expect(matches({ ...cached, owner: undefined }, saved)).toBe(false)
  expect(sameContent(cached, { ...saved, owner: "profile-b" })).toBe(true)
})
