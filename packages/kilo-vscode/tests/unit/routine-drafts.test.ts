import { describe, expect, test } from "bun:test"
import { RoutineDrafts } from "../../src/kilo-provider/routine-drafts"

function fixture(revision = 1) {
  const drafts = new RoutineDrafts()
  const row = {
    owner: "canonical-owner",
    conversationID: "conversation-one",
    revision,
    draft: "" as string | null,
    attachments: [] as { id: string }[],
  }
  let active = true
  drafts.mount("pane-one", {
    agentID: "agent-one",
    owner: row.owner,
    conversationID: row.conversationID,
    revision: row.revision,
    current: () => active,
    read: async () => ({ ...row }),
    write: async (draft, attachmentIDs, revision) => {
      if (revision !== row.revision) throw new Error("stale base")
      row.revision++
      row.draft = draft
      row.attachments = attachmentIDs.map((id) => ({ id }))
      return { ...row }
    },
  })
  return { drafts, row, revoke: () => (active = false) }
}

describe("Routine draft host cutover", () => {
  test("opens a new worker conversation at SQL revision zero", async () => {
    const state = fixture(0)
    const ticket = state.drafts.issue({
      paneID: "pane-one",
      agentID: "agent-one",
      owner: state.row.owner,
      conversationID: state.row.conversationID,
      expectedRevision: 0,
      sequence: 1,
      draft: "first",
    })
    ticket.before([])
    state.row.revision = 1
    state.row.draft = "first"
    ticket.settle({ ...state.row })
    const ack = await state.drafts.flush(
      "pane-one",
      { ...state.row, agentID: "agent-one" },
      { cutoff: 1, draft: "first", attachmentIDs: [] },
      Date.now() + 1000,
    )
    expect(ack.revision).toBe(1)
  })

  test("joins an issued save, then commits and reads the final snapshot", async () => {
    const state = fixture()
    const ticket = state.drafts.issue({
      paneID: "pane-one",
      agentID: "agent-one",
      owner: state.row.owner,
      conversationID: state.row.conversationID,
      expectedRevision: 1,
      sequence: 2,
      draft: "first",
    })
    const flush = state.drafts.flush(
      "pane-one",
      { ...state.row, agentID: "agent-one" },
      { cutoff: 3, draft: "final", attachmentIDs: [] },
      Date.now() + 1000,
    )
    ticket.before([])
    state.row.revision = 2
    state.row.draft = "first"
    ticket.settle({ ...state.row })
    const ack = await flush
    expect(ack.revision).toBe(3)
    expect(ack.draft).toBe("final")
    expect(await state.drafts.drain(Date.now() + 1000)).toBe(true)
  })

  test("commits an unsent final edit, but refuses a foreign incarnation", async () => {
    const state = fixture()
    const ack = await state.drafts.flush(
      "pane-one",
      { ...state.row, agentID: "agent-one" },
      { cutoff: 0, draft: "unsent", attachmentIDs: [] },
      Date.now() + 1000,
    )
    expect(ack.draft).toBe("unsent")
    expect(ack.revision).toBe(2)
    await expect(
      state.drafts.flush(
        "pane-one",
        { ...state.row, agentID: "agent-one", conversationID: "other" },
        { cutoff: 1, draft: "unsent", attachmentIDs: [] },
        Date.now() + 1000,
      ),
    ).rejects.toThrow()
  })

  test("does not permit a delayed file selection to write after the owner changes", () => {
    const state = fixture()
    const ticket = state.drafts.issue({
      paneID: "pane-one",
      agentID: "agent-one",
      owner: state.row.owner,
      conversationID: state.row.conversationID,
      expectedRevision: 1,
      sequence: 1,
      draft: "file",
    })
    state.revoke()
    expect(() => ticket.before([])).toThrow()
    ticket.settle()
    expect(state.row.revision).toBe(1)
  })

  test("rejects a file ACK missing the selected attachment and poisons stale retry", async () => {
    const state = fixture()
    const ticket = state.drafts.issue({
      paneID: "pane-one",
      agentID: "agent-one",
      owner: state.row.owner,
      conversationID: state.row.conversationID,
      expectedRevision: 1,
      sequence: 1,
      draft: "file",
    })
    ticket.before(["file-one"])
    ticket.settle({ ...state.row, revision: 2, draft: "file", attachments: [] })
    expect(() =>
      state.drafts.issue({
        paneID: "pane-one",
        agentID: "agent-one",
        owner: state.row.owner,
        conversationID: state.row.conversationID,
        expectedRevision: 1,
        sequence: 2,
        draft: "retry",
      }),
    ).toThrow("uncertain")
    expect(await state.drafts.drain(Date.now() + 1000)).toBe(false)
  })

  test("rebases the mounted pane to the post-send SQL revision", async () => {
    const state = fixture()
    const identity = { ...state.row, agentID: "agent-one" }
    const prior = await state.drafts.flush(
      "pane-one",
      identity,
      { cutoff: 0, draft: "Send this", attachmentIDs: [] },
      Date.now() + 1000,
    )
    expect(prior.revision).toBe(2)
    const send = state.drafts.send("pane-one", identity)
    send.before()
    state.row.revision = 3
    state.row.draft = null
    send.settle({ ...state.row })
    const next = state.drafts.issue({
      paneID: "pane-one",
      agentID: "agent-one",
      owner: state.row.owner,
      conversationID: state.row.conversationID,
      expectedRevision: 3,
      sequence: 1,
      draft: "After send",
    })
    next.before([])
    state.row.revision = 4
    state.row.draft = "After send"
    next.settle({ ...state.row })
    const ack = await state.drafts.flush(
      "pane-one",
      identity,
      { cutoff: 1, draft: "After send", attachmentIDs: [] },
      Date.now() + 1000,
    )
    expect(ack.revision).toBe(4)
  })

  test("refuses a send when the owner changes after its draft flush", async () => {
    const state = fixture()
    const identity = { ...state.row, agentID: "agent-one" }
    await state.drafts.flush(
      "pane-one",
      identity,
      { cutoff: 0, draft: "Send this", attachmentIDs: [] },
      Date.now() + 1000,
    )
    const send = state.drafts.send("pane-one", identity)
    state.revoke()
    expect(send.before).toThrow("changed")
    expect(send.settle()).toBe(false)
    expect(state.row.revision).toBe(2)
  })

  test("an uncertain send cannot be blindly replayed from its stale pane", async () => {
    const state = fixture()
    const identity = { ...state.row, agentID: "agent-one" }
    await state.drafts.flush(
      "pane-one",
      identity,
      { cutoff: 0, draft: "Send this", attachmentIDs: [] },
      Date.now() + 1000,
    )
    const send = state.drafts.send("pane-one", identity)
    send.before()
    expect(send.settle()).toBe(false)
    expect(() => state.drafts.send("pane-one", identity)).toThrow("Confirm")
    expect(await state.drafts.drain(Date.now() + 1000)).toBe(false)
  })
})
