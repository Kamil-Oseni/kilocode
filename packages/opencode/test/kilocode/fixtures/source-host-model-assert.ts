import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import type z from "zod"
import { read } from "@opencode-ai/core/kilocode/profile-models"
import { validateHostModel } from "../../../src/kilocode/migration/profile-host-model-correspondence"
import { payload } from "../../../src/kilocode/migration/profile-bundle"

export async function verifyModels(bundle: z.output<typeof payload>) {
  const groups = bundle.disposition?.files.filter((item) => item.disposition.kind === "host-model") ?? []
  assert.equal(groups.length, 1)
  const record = groups[0]
  assert.equal(record.disposition.kind, "host-model")
  if (record.disposition.kind !== "host-model") throw new Error("Actual host model correspondence is absent")
  const entry = record.disposition
  const bytes = await readFile(entry.source)
  assert.equal(bytes.length, record.bytes)
  assert.equal(createHash("sha256").update(bytes).digest("hex"), record.digest)
  assert.equal(entry.dev, record.dev)
  assert.equal(entry.ino, record.ino)
  assert.equal(entry.activation, "inert")
  assert.equal(entry.rawBytesPreserved, false)
  const current = bundle.host?.hosts.find((item) => item.id === entry.host)
  const owner = current?.owners.find((item) => item.id === entry.owner)
  assert.ok(owner?.models)
  assert.equal(owner.revision, entry.revision)
  const raw = JSON.parse(bytes.toString("utf8"))
  assert.deepEqual(read(raw), owner.models)
  assert.deepEqual(Object.keys(raw.model).sort(), ["ask", "auto", "build"])
  assert.equal(owner.models.agents.length, 3)
  assert.deepEqual(owner.models.variants, [{ providerID: "qwen-local", modelID: "qwen3-raya-32k", variant: "high" }])
  assert.throws(() => validateHostModel({ ...entry, owner: crypto.randomUUID() }, bundle.host), /owner projection/)
  assert.throws(() => validateHostModel({ ...entry, projection: "0".repeat(64) }, bundle.host), /owner projection/)
  const changed = structuredClone(bundle)
  const target = changed.host?.hosts
    .find((item) => item.id === entry.host)
    ?.owners.find((item) => item.id === entry.owner)
  assert.ok(target)
  target.revision++
  assert.equal(payload.safeParse(changed).success, false)
  return { count: groups.length, exactNativeBytes: true, inertModelChoices: true, tamperRefused: true }
}
