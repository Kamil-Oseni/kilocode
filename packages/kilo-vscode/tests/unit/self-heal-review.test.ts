import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { detail, review, type View } from "../../src/self-heal/review"

const artifact = {
  version: 1,
  id: "artifact_ready",
  itemID: "heal_ready",
  attemptID: "attempt_ready",
  sessionID: "ses_ready",
  messageID: "msg_ready",
  callID: "call_ready",
  completion: "c".repeat(64),
  checks: ["check_ready"],
  source: "s".repeat(64),
  head: "deadbeef",
  target: "win32-x64",
  extension: "7.4.23-repair+deadbeef",
  cli: "bin/kilo.exe",
  contract: "verified",
  status: "ready-for-review",
  output: "C:\\artifact.vsix",
  artifact: { digest: "a".repeat(64), size: 1024 * 1024 },
  binary: { digest: "b".repeat(64), size: 2 * 1024 * 1024 },
  at: 1,
}

const item = (digest = artifact.artifact.digest, status = "ready-for-review") => ({
  id: "heal_ready",
  fingerprint: "fingerprint",
  title: "Repair review",
  description: "Review this repair",
  category: "ui",
  severity: "medium",
  explanation: "Observed issue",
  approach: "Repair it",
  status: "verified",
  createdAt: 1,
  updatedAt: 2,
  reports: 1,
  evidence: [],
  reloadRequired: false,
  completion: {
    goal: {
      audit: {
        summary: "Focused checks passed.",
        requirements: [
          {
            requirement: "The issue no longer reproduces",
            passed: true,
            evidence: [{ summary: "Runtime check passed" }],
          },
        ],
      },
    },
  },
  artifact: {
    status,
    artifact: { ...artifact, artifact: { ...artifact.artifact, digest } },
    ...(status === "install-ready" ? { approval: { artifactID: artifact.id } } : {}),
  },
})

function client(rows: unknown[], calls: Request[]) {
  return createKiloClient({
    baseUrl: "http://unused.invalid",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      if (request.method === "POST")
        return Response.json({
          ...artifact,
          id: "approval_ready",
          artifactID: artifact.id,
          source: artifact.source,
          head: artifact.head,
          artifact: artifact.artifact,
          binary: artifact.binary,
          status: "install-ready",
        })
      return Response.json(rows.shift())
    },
  })
}

test("review shows exact evidence and records approval only after confirmation and refresh", async () => {
  const calls: Request[] = []
  const views: View[] = []
  const result = await review({
    client: client([item(), item()], calls),
    itemID: "heal_ready",
    directory: "C:\\state",
    confirm: async (view) => {
      views.push(view)
      return true
    },
  })
  expect(result.approval?.id).toBe("approval_ready")
  expect(result.notice).toContain("It has not been installed")
  expect(calls.map((call) => call.method)).toEqual(["GET", "GET", "POST"])
  expect(await calls[2].json()).toEqual({
    artifactID: artifact.id,
    digest: artifact.artifact.digest,
    extension: artifact.extension,
  })
  const copy = detail(views[0])
  expect(copy).toContain(`Source commit: ${artifact.head}`)
  expect(copy).toContain(`VSIX SHA-256: ${artifact.artifact.digest}`)
  expect(copy).toContain(`Bundled CLI SHA-256: ${artifact.binary.digest}`)
  expect(copy).toContain("Passed: The issue no longer reproduces")
  expect(copy).toContain("Runtime check passed")
  expect(copy).toContain("Approval does not install this update")
})

test("closing review performs no approval request", async () => {
  const calls: Request[] = []
  const result = await review({
    client: client([item()], calls),
    itemID: "heal_ready",
    directory: "C:\\state",
    confirm: async () => false,
  })
  expect(result.notice).toBe("Review closed. No approval was saved.")
  expect(calls.map((call) => call.method)).toEqual(["GET"])
})

test("changed artifact after confirmation requires a new review", async () => {
  const calls: Request[] = []
  const result = await review({
    client: client([item(), item("d".repeat(64))], calls),
    itemID: "heal_ready",
    directory: "C:\\state",
    confirm: async () => true,
  })
  expect(result.notice).toContain("artifact changed")
  expect(calls.map((call) => call.method)).toEqual(["GET", "GET"])
})

test("an approved artifact opens no second confirmation", async () => {
  const calls: Request[] = []
  let confirmed = false
  const result = await review({
    client: client([item(undefined, "install-ready")], calls),
    itemID: "heal_ready",
    directory: "C:\\state",
    confirm: async () => {
      confirmed = true
      return true
    },
  })
  expect(result.notice).toContain("already approved")
  expect(confirmed).toBe(false)
  expect(calls.map((call) => call.method)).toEqual(["GET"])
})
