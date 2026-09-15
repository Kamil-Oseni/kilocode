import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { RayaTaskSnapshot } from "@/kilocode/task/snapshot"
import { Storage } from "@/storage/storage"

function memory() {
  const data = new Map<string, unknown>()
  return {
    data,
    create: (key: string[], value: unknown) =>
      Effect.sync(() => {
        const id = key.join("/")
        if (data.has(id)) return false
        data.set(id, value)
        return true
      }),
    replace: (key: string[], value: unknown) => Effect.sync(() => data.set(key.join("/"), value)).pipe(Effect.asVoid),
    read<T>(key: string[]) {
      const value = data.get(key.join("/"))
      return value === undefined
        ? Effect.fail(new Storage.NotFoundError({ message: "missing" }))
        : Effect.succeed(value as T)
    },
    remove: (key: string[]) => Effect.sync(() => data.delete(key.join("/"))).pipe(Effect.asVoid),
  }
}

const agent = {
  id: "worker",
  name: "Worker",
  role: "generalist",
  objective: "Work",
  capabilities: [],
  memoryScope: "session" as const,
  schedule: { kind: "manual" as const },
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
}

test("startup snapshots read v1 and write v2 with exact policy provenance", async () => {
  const storage = memory()
  const snapshots = RayaTaskSnapshot.make({ storage })
  const legacy = {
    version: 1 as const,
    runID: "legacy",
    agentID: agent.id,
    at: 1,
    definition: agent,
    objective: "Work",
  }
  const key = (id: string) => ["raya", "agent-starts", createHash("sha256").update(id).digest("hex")].join("/")
  storage.data.set(key(legacy.runID), legacy)
  expect(await Effect.runPromise(snapshots.find(legacy.runID))).toEqual(legacy)

  const policy = "Preserve café receipts exactly.\nDo not infer totals."
  const current = await Effect.runPromise(
    snapshots.save({
      version: 2,
      runID: "current",
      agentID: agent.id,
      at: 2,
      definition: agent,
      objective: `Policy:\n${policy}`,
      organizationPolicy: {
        organizationID: `org_${"a".repeat(32)}`,
        organizationRevision: 7,
        sha256: createHash("sha256").update(policy, "utf8").digest("hex"),
      },
    }),
  )
  expect(current.version).toBe(2)
  expect(current.organizationPolicy?.sha256).toBe(
    createHash("sha256").update(Buffer.from(policy, "utf8")).digest("hex"),
  )
})
