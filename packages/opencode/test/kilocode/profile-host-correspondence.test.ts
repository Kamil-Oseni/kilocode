import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Database } from "bun:sqlite"
import { createKiloClient } from "@kilocode/sdk/v2"
import { HostCapture, hostPayload } from "../../../kilo-vscode/src/kilo-provider/host-capture"
import { capsule, stage, verifyCapsule, type VerifiedCapsule } from "@opencode-ai/core/kilocode/source-capsule"
import type { Ticket } from "@opencode-ai/core/kilocode/source-launch"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { preferences } from "@opencode-ai/core/kilocode/profile-preferences"
import { select } from "../../src/kilocode/migration/profile-selection"
import { held } from "../../src/kilocode/migration/profile-host"
import { lookup, withWorking, type Working } from "../../src/kilocode/migration/profile-image"
import {
  bindHost,
  hostGroups,
  validateHost,
  type HostClaim,
} from "../../src/kilocode/migration/profile-host-correspondence"
import { payload, seal, unseal } from "../../src/kilocode/migration/profile-bundle"
import { collectDisposition } from "../../src/kilocode/migration/profile-disposition"

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")

test.skipIf(process.platform !== "win32")(
  "actual host publication and signed held capsule bind only current safe choices across inactive encrypted hops",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-held-capsule-")))
    const data = path.join(root, "data")
    await mkdir(path.join(data, "storage"), { recursive: true })
    const database = path.join(data, "raya.db")
    const db = new Database(database)
    db.exec("CREATE TABLE evidence(value TEXT)")
    db.close()
    const file = path.join(data, "models.json")
    const choice = preferences.parse({
      format: "raya.profile-preferences",
      version: 1,
      reviewOnly: true,
      activation: "held",
      config: { model: { providerID: "local", modelID: "current-model" } },
      modelState: { models: [], recent: [], favorite: [] },
      extensionState: { recentModels: [], favoriteModels: [] },
    })
    const hosts = new HostCapture()
    const owner = randomUUID()
    const gates: { release?: () => void } = {}
    const gate = new Promise<void>((resolve) => {
      gates.release = resolve
    })
    const job = hosts.run(async () => {
      await gate
      await writeFile(file, JSON.stringify(choice))
    })
    hosts.register(owner, "view", {
      prepare: async () => () => undefined,
      close: async () => {
        const choices = preferences.parse(JSON.parse(await readFile(file, "utf8")))
        await writeFile(path.join(data, "controller-closed"), "joined")
        return { revision: 2, models: [], preferences: { preferences: choices } }
      },
    })
    const closure = hosts.capture(createKiloClient({ baseUrl: "http://127.0.0.1:1" }), Date.now() + 15000)
    const state = { settled: false }
    void closure.then(
      () => {
        state.settled = true
      },
      () => {
        state.settled = true
      },
    )
    try {
      await Bun.sleep(60)
      expect(state.settled).toBe(false)
    } finally {
      gates.release!()
    }
    await job
    const current = hostPayload(await closure)
    expect(await readFile(path.join(data, "controller-closed"), "utf8")).toBe("joined")
    expect(current.hosts[0].models.selected?.modelID).toBe("current-model")
    await assert.rejects(
      hosts.run(async () => writeFile(file, "late")),
      /retired/,
    )
    const history = structuredClone(current)
    history.hosts[0].revision = 1
    history.hosts[0].models.selected!.modelID = "old-model"
    const old = structuredClone(history.hosts[0])
    old.id = randomUUID()
    history.hosts.push(old)
    await writeFile(path.join(data, "restore-host.json"), JSON.stringify(history))
    const merged = await held(data, current)
    expect(merged!.hosts.find((item) => item.id === owner)?.models.selected?.modelID).toBe("current-model")
    expect(merged!.hosts.find((item) => item.id === old.id)?.models.selected?.modelID).toBe("old-model")
    const policy = { version: 1 as const, directories: [data], files: [] }
    const id = randomUUID()
    const secret = randomUUID()
    const source = { pid: process.pid, birth: "1", executable: process.execPath, digest: "a".repeat(64) }
    // Real signed codec publication; synthetic ticket metadata grants no native retirement authority.
    const ticket: Ticket = {
      format: "raya.source-job",
      version: 1,
      control: path.join(root, "control"),
      token: secret,
      header: {
        version: 2,
        token: secret,
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
    const descriptor = await stage(ticket, { id, source, data, payload: current })
    const authorize = async () => ({
      policy,
      verify: (text: string, signature: string) =>
        timingSafeEqual(
          Buffer.from(createHmac("sha256", secret).update(text).digest("hex"), "hex"),
          Buffer.from(signature, "hex"),
        ),
    })
    const expected = { id, source, data }
    const initial = await verifyCapsule(descriptor, expected, authorize)
    const selected = await select({ database, storage: path.join(data, "storage") }, policy)
    const selection = { ...selected, roots: [...selected.roots, { kind: "json" as const, path: descriptor.file }] }
    const executable = path.join(root, "raya-process-host.exe")
    await copyFile(path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe"), executable)
    const input = {
      roots: selection.roots,
      policy,
      helper: { executable, digest: hash(await readFile(executable)) },
      registry: path.join(root, "registry"),
    }
    const saved: { token?: Working; claim?: HostClaim; proof?: VerifiedCapsule } = {}
    await withImage(input, (image) =>
      withWorking(image, selection, async (token) => {
        const proof = await verifyCapsule(
          descriptor,
          { ...expected, readPath: lookup(token, descriptor.file) },
          authorize,
        )
        saved.token = token
        saved.proof = proof
        assert.throws(() => bindHost(token, initial, merged), /current staged/)
        assert.throws(() => bindHost(token, JSON.parse(JSON.stringify(proof)), merged), /provenance/)
        const claim = bindHost(token, proof, merged)
        saved.claim = claim
        const groups = hostGroups(token, claim)
        expect(groups).toHaveLength(1)
        expect(groups[0]).toMatchObject({
          kind: "host-semantic",
          source: descriptor.file,
          sourceDigest: descriptor.digest,
          rawBytesPreserved: false,
          envelopeAuthority: "excluded",
          historicalIntent: "inert",
          activation: "held",
        })
        expect(Object.isFrozen(groups[0].hosts[0])).toBe(true)
        assert.throws(() => hostGroups(token, { ...claim }), /binding/)
        assert.throws(() => validateHost({ ...groups[0], projection: "0".repeat(64) }, merged), /current component/)
        const changed = structuredClone(merged!)
        changed.hosts[0].models.selected!.modelID = "tampered"
        assert.throws(() => validateHost(groups[0], changed), /archived component/)
        await assert.rejects(
          verifyCapsule(
            descriptor,
            { ...expected, id: randomUUID(), readPath: lookup(token, descriptor.file) },
            authorize,
          ),
          /request identity/,
        )
        await assert.rejects(
          verifyCapsule(descriptor, { ...expected, readPath: lookup(token, descriptor.file) }, async () => ({
            policy,
            verify: () => false,
          })),
          /signature/,
        )
        const ledger = collectDisposition(token, [], "selected", undefined, undefined, undefined, claim)
        expect(ledger.files.find((item) => item.path === descriptor.file)?.disposition.kind).toBe("host-semantic")
        expect(ledger.files.find((item) => item.path === file)?.disposition.kind).toBe("unclassified")
        assert.throws(
          () => collectDisposition(token, [], "strict-full", undefined, undefined, undefined, claim),
          /incomplete/,
        )
        const value = payload.parse({
          format: "raya.profile-data",
          version: 1,
          id: randomUUID(),
          createdAt: Date.now(),
          schema: "a".repeat(64),
          workspaces: [],
          sql: [],
          json: [],
          host: merged,
          disposition: ledger,
          review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
        })
        const first = await unseal(
          await seal(value, "capsule first inactive private key"),
          "capsule first inactive private key",
        )
        const second = await unseal(
          await seal(first, "capsule second inactive private key"),
          "capsule second inactive private key",
        )
        expect(second.host).toEqual(merged)
        expect(second.disposition).toEqual(ledger)
        expect(JSON.stringify(second)).not.toContain(secret)
        expect(JSON.stringify(second)).not.toContain('"signature"')
        const forged = structuredClone(second)
        forged.host!.hosts[0].revision++
        assert.throws(() => payload.parse(forged), /Host correspondence/)
        expect(capsule(proof).payload).toEqual(current)
      }),
    )
    assert.throws(() => hostGroups(saved.token!, saved.claim!), /expired/)
    await withImage(input, (image) =>
      withWorking(image, selection, async (token) => {
        assert.throws(() => hostGroups(token, saved.claim!), /another image/)
        assert.throws(() => bindHost(token, saved.proof!, merged), /current staged/)
      }),
    )
    expect(hash(await readFile(descriptor.file))).toBe(descriptor.digest)
    await writeFile(
      path.join(root, "receipt.json"),
      JSON.stringify({
        passed: true,
        actualHostPublicationJoined: true,
        actualSignedCodec: true,
        nativeHeldImage: true,
        syntheticTicketMetadata: true,
        nativeSourceRetirement: false,
        fullCoverage: false,
        replay: false,
      }),
    )
  },
  40000,
)
