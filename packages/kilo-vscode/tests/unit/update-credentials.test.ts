import { expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as vscode from "vscode"
import { configure, UpdateCredentials } from "../../src/services/update-credentials"

function fixture(value = "legacy-test-token", stored?: string) {
  const state = {
    legacy: value as string | undefined,
    workspace: undefined as string | undefined,
    folder: undefined as string | undefined,
    saved: stored,
    fail: false,
    mismatch: false,
    cleanup: false,
    blocked: undefined as vscode.ConfigurationTarget | undefined,
  }
  const writes: unknown[] = []
  const targets: vscode.ConfigurationTarget[] = []
  const credentials = new UpdateCredentials(
    {
      get: async () => (state.mismatch ? "unverified" : state.saved),
      store: async (_key, token) => {
        if (state.fail) throw new Error("sensitive provider failure: legacy-test-token")
        state.saved = token
      },
      delete: async () => {
        state.saved = undefined
      },
    },
    () => ({
      inspect: () => ({
        key: "token",
        globalValue: state.legacy,
        workspaceValue: state.workspace,
        workspaceFolderValue: state.folder,
      }),
      update: async (_key, token, target) => {
        if (state.cleanup || state.blocked === target) throw new Error("settings write failed")
        writes.push(token)
        targets.push(target)
        if (target === vscode.ConfigurationTarget.Global) state.legacy = token
        if (target === vscode.ConfigurationTarget.Workspace) state.workspace = token
        if (target === vscode.ConfigurationTarget.WorkspaceFolder) state.folder = token
      },
    }),
  )
  return { credentials, state, writes, targets }
}

test("migrates a user token only after verified secret storage and never writes a new settings token", async () => {
  const { credentials, state, writes } = fixture()
  expect(await credentials.get()).toBe("legacy-test-token")
  expect(state.saved).toBe("legacy-test-token")
  expect(state.legacy).toBeUndefined()
  expect(writes).toEqual([undefined])
  expect(await credentials.get()).toBe("legacy-test-token")
  await credentials.set(" replacement-test-token ")
  expect(state.saved).toBe("replacement-test-token")
  expect(writes.every((value) => value === undefined)).toBe(true)
  await credentials.set("")
  expect(await credentials.get()).toBe("")
})

test("failed secret writes retain the legacy credential and redact provider errors", async () => {
  const { credentials, state, writes } = fixture()
  state.fail = true
  await expect(credentials.get()).rejects.toThrow("credential migration could not finish")
  expect(state.legacy).toBe("legacy-test-token")
  expect(writes).toEqual([])
  try {
    await credentials.get()
  } catch (error) {
    expect(String(error)).not.toContain("legacy-test-token")
  }
})

test("unverified and conflicting secrets do not erase settings or replace an existing secret", async () => {
  const conflict = fixture("legacy-test-token", "different-test-token")
  await expect(conflict.credentials.get()).rejects.toThrow("migration")
  expect(conflict.state.saved).toBe("different-test-token")
  expect(conflict.writes).toEqual([])
  const mismatch = fixture()
  mismatch.state.mismatch = true
  await expect(mismatch.credentials.set("new-test-token")).rejects.toThrow("Could not finish saving")
  expect(mismatch.state.legacy).toBe("legacy-test-token")
  expect(mismatch.writes).toEqual([])
})

test("migrates one matching token from every legacy scope and rejects conflicting scope values", async () => {
  const same = fixture()
  same.state.workspace = " legacy-test-token "
  same.state.folder = "legacy-test-token"
  expect(await same.credentials.get()).toBe("legacy-test-token")
  expect(same.state).toMatchObject({
    saved: "legacy-test-token",
    legacy: undefined,
    workspace: undefined,
    folder: undefined,
  })
  expect(same.targets).toEqual([
    vscode.ConfigurationTarget.Global,
    vscode.ConfigurationTarget.Workspace,
    vscode.ConfigurationTarget.WorkspaceFolder,
  ])

  const conflict = fixture()
  conflict.state.workspace = "other-test-token"
  await expect(conflict.credentials.get()).rejects.toThrow("migration")
  expect(conflict.state).toMatchObject({ saved: undefined, legacy: "legacy-test-token", workspace: "other-test-token" })
  expect(conflict.writes).toEqual([])
})

test("failed legacy cleanup cannot resurrect a deliberately removed token", async () => {
  const run = fixture("legacy-test-token", "legacy-test-token")
  run.state.workspace = "legacy-test-token"
  run.state.blocked = vscode.ConfigurationTarget.Workspace
  await expect(run.credentials.set("")).rejects.toThrow("Could not finish saving")
  expect(run.state.legacy).toBeUndefined()
  expect(run.state.workspace).toBe("legacy-test-token")
  expect(run.state.saved).toBe("legacy-test-token")

  run.state.blocked = undefined
  await run.credentials.set("")
  expect(run.state.workspace).toBeUndefined()
  expect(run.state.saved).toBeUndefined()
  expect(await run.credentials.get()).toBe("")
})

test("two credential services serialize migration and deletion through shared storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-update-credentials-"))
  const state = { legacy: "legacy-test-token" as string | undefined, saved: undefined as string | undefined }
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let reads = 0
  const secrets = {
    get: async () => {
      if (++reads === 1) {
        entered.resolve()
        await release.promise
      }
      return state.saved
    },
    store: async (_key: string, value: string) => {
      state.saved = value
    },
    delete: async () => {
      state.saved = undefined
    },
  }
  const config = () => ({
    inspect: () => ({ key: "token", globalValue: state.legacy }),
    update: async () => {
      state.legacy = undefined
    },
  })
  try {
    const migration = new UpdateCredentials(secrets, config, root).get()
    await entered.promise
    const deletion = new UpdateCredentials(secrets, config, root).set("")
    await Bun.sleep(30)
    expect(state.legacy).toBe("legacy-test-token")
    expect(state.saved).toBeUndefined()
    release.resolve()
    expect(await migration).toBe("legacy-test-token")
    await deletion
    expect(state).toEqual({ legacy: undefined, saved: undefined })
  } finally {
    release.resolve()
    await rm(root, { recursive: true, force: true })
  }
})

test("migration resumes after settings cleanup fails and serializes an explicit replacement", async () => {
  const { credentials, state } = fixture()
  state.cleanup = true
  await expect(credentials.get()).rejects.toThrow("migration")
  expect(state.saved).toBe("legacy-test-token")
  expect(state.legacy).toBe("legacy-test-token")
  state.cleanup = false
  const migrating = credentials.get()
  const replacing = credentials.set("replacement-test-token")
  expect(await migrating).toBe("legacy-test-token")
  await replacing
  expect(await credentials.get()).toBe("replacement-test-token")
  expect(state.legacy).toBeUndefined()
})

test("credential input is masked, cancellation is inert, and replacement uses secret storage", async () => {
  const { credentials, state, writes } = fixture("", "existing-test-token")
  const input = spyOn(vscode.window, "showInputBox")
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce("replacement-test-token")
  try {
    await configure(credentials)
    expect(state.saved).toBe("existing-test-token")
    expect(writes).toEqual([])
    expect(input.mock.calls[0]?.[0]).toMatchObject({ password: true })
    expect(input.mock.calls[0]?.[0]?.value).toBeUndefined()
    await configure(credentials)
    expect(state.saved).toBe("replacement-test-token")
    expect(writes).toEqual([undefined])
  } finally {
    input.mockRestore()
  }
})
