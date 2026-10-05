import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { copyFile, link, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { capsule, PayloadSchema, stage, verify, verifyCapsule } from "../../src/kilocode/source-capsule"
import type { Ticket } from "../../src/kilocode/source-launch"
import { validatePolicy } from "../../src/kilocode/source-policy"
import { decode, encode } from "../../src/kilocode/source-transfer"

test("signed capsule preserves safe historical owner metadata and verifies original and staged bytes", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-source-capsule-")))
  const data = path.join(root, "data")
  await mkdir(data)
  const policy = await validatePolicy({ version: 1, directories: [root], files: [] })
  const id = randomUUID()
  const token = randomUUID()
  const source = { pid: process.pid, birth: "1", executable: process.execPath, digest: "a".repeat(64) }
  // Ticket metadata signs evidence only; no native retirement authority is asserted in this codec fixture.
  const ticket: Ticket = {
    format: "raya.source-job",
    version: 1,
    control: path.join(root, "control"),
    token,
    header: {
      version: 2,
      token,
      proof: "windows-job",
      ...source,
      helper: process.pid,
      helperBirth: "1",
      interpreted: true,
      roots: [{ kind: "json", path: data }],
      policy,
      state: "suspended",
      completeProfileCoverage: false,
      portableCaptureAuthorized: false,
    },
    image: { executable: process.execPath, digest: source.digest },
  }
  const models = {
    selected: { providerID: "local", modelID: "model-a" },
    recent: [],
    favorite: [{ providerID: "local", modelID: "model-b" }],
    agents: [{ agent: "build", providerID: "local", modelID: "model-a" }],
    variants: [{ providerID: "local", modelID: "model-a", variant: "high" }],
    expanded: false,
  }
  const payload = PayloadSchema.parse({
    format: "raya.host-capsule",
    version: 1,
    hosts: [
      {
        id: randomUUID(),
        role: "view",
        revision: 2,
        models,
        owners: [
          {
            id: randomUUID(),
            revision: 1,
            root: { kind: "json", path: data },
            models: { ...models, selected: { providerID: "local", modelID: "old-model" } },
          },
        ],
        contexts: [{ id: randomUUID(), project: "project", path: path.join(root, "workspace") }],
      },
    ],
  })
  const descriptor = await stage(ticket, { id, source, data, payload })
  const authorize = async () => ({
    policy,
    verify: (text: string, signature: string) =>
      timingSafeEqual(
        Buffer.from(createHmac("sha256", token).update(text).digest("hex"), "hex"),
        Buffer.from(signature, "hex"),
      ),
  })
  const result = await verify(descriptor, { id, source, data }, authorize)
  expect(result).toEqual(payload)
  expect(Object.isFrozen(result.hosts[0].owners[0].models)).toBe(true)
  expect(result.hosts[0].contexts[0].root).toBeUndefined()
  const staged = path.join(root, "staged.json")
  await copyFile(descriptor.file, staged)
  expect(await verify(descriptor, { id, source, data, readPath: staged }, authorize)).toEqual(payload)
  const proof = await verifyCapsule(descriptor, { id, source, data, readPath: staged }, authorize)
  expect(capsule(proof)).toMatchObject({ descriptor, payload, selected: staged })
  expect(capsule(proof).bytes).toBe((await readFile(staged)).length)
  expect(Object.isFrozen(capsule(proof).descriptor)).toBe(true)
  expect(Object.isFrozen(capsule(proof).payload.hosts[0].models)).toBe(true)
  expect(() => capsule({ ...proof })).toThrow(/provenance/)
  expect(() => capsule(JSON.parse(JSON.stringify(proof)))).toThrow(/provenance/)
  const wire = encode({
    format: "raya.source-export",
    version: 1,
    id,
    source,
    host: descriptor,
    profile: { database: path.join(data, "raya.db"), storage: path.join(data, "storage") },
    password: "private-password-only-in-pipe",
    output: path.join(root, "output.raya"),
  })
  expect(decode(wire).host).toEqual(descriptor)
  const text = await readFile(descriptor.file, "utf8")
  expect(text.includes(token)).toBe(false)
  expect(text.includes("private-password")).toBe(false)
  await assert.rejects(stage(ticket, { id, source: { ...source, birth: "2" }, data, payload }), /source identity/)
  await assert.rejects(stage(ticket, { id, source, data: path.join(root, "absent"), payload }), /ENOENT/)
  const outside = PayloadSchema.parse({
    ...payload,
    hosts: [
      {
        ...payload.hosts[0],
        owners: [
          {
            id: randomUUID(),
            revision: 0,
            root: { kind: "json", path: path.join(os.tmpdir(), "outside-capsule-policy") },
          },
        ],
      },
    ],
  })
  await assert.rejects(stage(ticket, { id, source, data, payload: outside }), /outside producer policy/)
  await assert.rejects(verify(descriptor, { id: randomUUID(), source, data }, authorize), /request identity/)
  await assert.rejects(
    verify(descriptor, { id, source: { ...source, birth: "2" }, data }, authorize),
    /request identity/,
  )
  await assert.rejects(
    verify(descriptor, { id, source, data }, async () => {
      throw new Error("retirement token expired")
    }),
    /expired/,
  )
  await writeFile(staged, text.replace("old-model", "bad-model"))
  await assert.rejects(verify(descriptor, { id, source, data, readPath: staged }, authorize), /digest/)
  const tampered = {
    file: staged,
    digest: createHash("sha256")
      .update(await readFile(staged))
      .digest("hex"),
  }
  await assert.rejects(verify(tampered, { id, source, data, readPath: staged }, authorize), /outside selected/)
  await writeFile(descriptor.file, text.replace("old-model", "bad-model"))
  await assert.rejects(
    verify(
      {
        ...descriptor,
        digest: createHash("sha256")
          .update(await readFile(descriptor.file))
          .digest("hex"),
      },
      { id, source, data },
      authorize,
    ),
    /signature/,
  )
})

test("capsule schemas exclude authority and credentials; aliased, oversized and policy-escaping files refuse", async () => {
  expect(
    PayloadSchema.safeParse({ format: "raya.host-capsule", version: 1, hosts: [], password: "secret" }).success,
  ).toBe(false)
  expect(
    PayloadSchema.safeParse({ format: "raya.host-capsule", version: 1, hosts: [], completeProfileCoverage: true })
      .success,
  ).toBe(false)
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-capsule-refusal-")))
  const data = path.join(root, "data")
  const capture = path.join(data, "capture")
  await mkdir(capture, { recursive: true })
  const target = path.join(capture, "host.json")
  await writeFile(target, "x")
  const policy = await validatePolicy({ version: 1, directories: [root], files: [] })
  const source = { pid: process.pid, birth: "1", executable: process.execPath, digest: "a".repeat(64) }
  const expected = { id: randomUUID(), source, data }
  const authorize = async () => ({ policy, verify: () => false })
  await link(target, path.join(capture, "duplicate"))
  await assert.rejects(verify({ file: target, digest: "a".repeat(64) }, expected, authorize), /unique/)
  const other = path.join(root, "other")
  await mkdir(other)
  await symlink(other, path.join(capture, "alias"), process.platform === "win32" ? "junction" : "dir")
  await writeFile(path.join(other, "file.json"), "x")
  await assert.rejects(
    verify({ file: path.join(capture, "alias/file.json"), digest: "a".repeat(64) }, expected, authorize),
    /canonical/,
  )
  const big = path.join(capture, "big.json")
  await writeFile(big, Buffer.alloc(1024 * 1024 + 1))
  await assert.rejects(verify({ file: big, digest: "a".repeat(64) }, expected, authorize), /bounded/)
})
