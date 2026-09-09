import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { evidence } from "../../src/kilo-provider/goal-evidence"
import { digest } from "@opencode-ai/core/kilocode/evidence-digest"
import type { GoalEvidenceResultMessage } from "../../webview-ui/src/types/messages/extension-messages"

test("historical evidence is checked against the selected goal, never a different audit", async () => {
  const ref = { sessionID: "child", messageID: "message", partID: "part", callID: "call", summary: "summary" }
  const part = {
    type: "tool",
    tool: "read",
    id: "part",
    messageID: "message",
    sessionID: "child",
    callID: "call",
    state: { status: "completed", input: {}, output: "original", metadata: {} },
  }
  const audit = (value: string) => ({
    requirements: [{ evidence: [{ ...ref, record: { version: 1, digest: value, at: 10 } }] }],
  })
  const revision = { id: "version", audit: audit(digest(part)) }
  const archived = { createdAt: 1, audit: audit(digest(part)), revisions: [revision] }
  let duplicate = false
  let reads = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      if (new URL(request.url).pathname.includes("/goal"))
        return Response.json({
          createdAt: 2,
          audit: audit("different"),
          revisions: [{ ...revision, audit: audit("different") }],
          history: duplicate ? [archived, archived] : [archived],
        })
      reads++
      return Response.json({ info: { id: "message", sessionID: "child" }, parts: [part] })
    },
  })
  try {
    const client = createKiloClient({ baseUrl: server.url.toString() })
    const replies: GoalEvidenceResultMessage[] = []
    const load = async (createdAt?: number, revisionID?: unknown) => {
      await evidence({
        client,
        message: { sessionID: "parent", requestID: "request", createdAt, revisionID, evidence: ref },
        post: (reply) => replies.push(reply),
      })
      return replies.at(-1)!
    }
    expect((await load(1)).source?.receipt).toBe("matching")
    expect((await load(2)).error).toContain("changed since")
    expect((await load()).error).toContain("changed since")
    expect((await load(1, "version")).source?.receipt).toBe("matching")
    expect((await load(2, "version")).error).toContain("changed since")
    const before = reads
    expect((await load(1, "missing")).error).toContain("revision is missing or ambiguous")
    expect((await load(1, "")).error).toContain("revision is missing or ambiguous")
    archived.revisions.push(revision)
    expect((await load(1, "version")).error).toContain("revision is missing or ambiguous")
    expect((await load(3)).error).toContain("missing or ambiguous")
    duplicate = true
    expect((await load(1)).error).toContain("missing or ambiguous")
    expect(reads).toBe(before)
  } finally {
    server.stop(true)
  }
})
