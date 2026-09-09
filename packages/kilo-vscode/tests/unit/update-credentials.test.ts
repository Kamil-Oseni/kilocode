import { expect, spyOn, test } from "bun:test"
import * as vscode from "vscode"
import { configure, UpdateCredentials } from "../../src/services/update-credentials"

function fixture(value = "legacy-test-token", stored?: string) {
  const state = { legacy: value as string | undefined, saved: stored, fail: false, mismatch: false, cleanup: false }
  const writes: unknown[] = []
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
      inspect: <T>() => ({ key: "token", globalValue: state.legacy as T }),
      update: async (_key, token) => {
        if (state.cleanup) throw new Error("settings write failed")
        writes.push(token)
        state.legacy = token as string | undefined
      },
    }),
  )
  return { credentials, state, writes }
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
