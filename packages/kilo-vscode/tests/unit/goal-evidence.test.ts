import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { evidence } from "../../src/kilo-provider/goal-evidence"
import { digest } from "@opencode-ai/core/kilocode/evidence-digest"
import type { GoalEvidenceResultMessage } from "../../webview-ui/src/types/messages/extension-messages"

test("source retrieval uses exact saved identities, preserves output as text and never executes work", async () => {
  const ref = { sessionID: "child", messageID: "message", partID: "part", callID: "call", summary: "summary" }
  const part = {
    id: "part",
    messageID: "message",
    sessionID: "child",
    callID: "call",
    type: "tool",
    tool: "read",
    state: {
      status: "completed",
      input: { filePath: "file.txt" },
      output: "<script>untrusted()</script>",
      metadata: {
        rayaRevision: { status: "unavailable" },
        truncated: true,
        display: { type: "file", lineStart: 2, lineEnd: 3, totalLines: 10, truncated: true },
      },
    },
  }
  let mode = "valid"
  const calls: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url)
      calls.push(`${request.method} ${url.pathname}`)
      if (url.pathname.includes("/goal"))
        return Response.json({
          audit: {
            requirements: [
              {
                evidence:
                  mode === "unreferenced"
                    ? []
                    : [
                        {
                          ...ref,
                          ...(["receipt", "changed"].includes(mode)
                            ? { record: { version: 1, digest: digest(part), at: 1 } }
                            : {}),
                        },
                      ],
              },
            ],
          },
        })
      return Response.json({
        info: { id: mode === "wrong-message" ? "different" : "message", sessionID: "child" },
        parts:
          mode === "missing"
            ? []
            : mode === "duplicate"
              ? [part, part]
              : [
                  {
                    ...part,
                    state: {
                      ...part.state,
                      output:
                        mode === "changed" ? "different" : mode === "large" ? "x".repeat(60_000) : part.state.output,
                    },
                  },
                ],
      })
    },
  })
  try {
    const client = createKiloClient({ baseUrl: server.url.toString() })
    const replies: GoalEvidenceResultMessage[] = []
    for (mode of ["valid", "missing", "duplicate", "wrong-message", "unreferenced", "large", "receipt", "changed"]) {
      calls.length = 0
      await evidence({
        client,
        message: { type: "goalEvidence", sessionID: "parent", requestID: mode, evidence: ref },
        post: (reply) => replies.push(reply),
      })
      const reply = replies.at(-1)!
      expect(reply.requestID).toBe(mode)
      expect(calls.every((call) => call.startsWith("GET "))).toBe(true)
      if (mode === "valid" || mode === "receipt") {
        expect(reply.source?.receipt).toBe(mode === "receipt" ? "matching" : "unrecorded")
        expect(reply.source?.output).toBe(part.state.output)
        expect(reply.source?.metadata).toContain("unavailable")
        expect(reply.source?.truncated).toBe(false)
        expect(reply.source?.inspection).toMatchObject({
          kind: "text",
          coverage: "partial",
          lineStart: 2,
          lineEnd: 3,
          reportedLines: 10,
          fullReview: "not-established",
        })
        continue
      }
      if (mode === "large") {
        expect(reply.source?.output).toHaveLength(50_000)
        expect(reply.source?.truncated).toBe(true)
        continue
      }
      expect(reply.source).toBeUndefined()
      expect(reply.error).toBeTruthy()
      if (mode === "unreferenced") expect(calls).toHaveLength(1)
    }
    calls.length = 0
    await evidence({
      client,
      message: {
        type: "goalEvidence",
        sessionID: "parent",
        requestID: "legacy",
        evidence: { callID: "call", summary: "legacy" },
      },
      post: (reply) => replies.push(reply),
    })
    expect(calls).toHaveLength(0)
    expect(replies.at(-1)?.error).toContain("complete source identity")
  } finally {
    server.stop(true)
  }
})
