import { describe, expect, test, mock } from "bun:test"
import { importCloudSession, reportCloudImportError } from "../../src/kilocode/cloud-session"

const errorMock = mock()
mock.module("@/cli/ui", () => ({ UI: { error: errorMock } }))

type ImportResult = { data?: unknown; error?: unknown }

const client = (
  imp: (params: { sessionId: string; expectedUpdated: number }) => Promise<ImportResult>,
  get: () => Promise<ImportResult> = async () => ({ data: { info: { time: { updated: 7 } } } }),
) => ({ kilo: { cloud: { session: { get, import: imp } } } }) as Parameters<typeof importCloudSession>[0]

describe("importCloudSession", () => {
  test("returns local id on success", async () => {
    const c = client(async (input) => {
      expect(input).toEqual({ sessionId: "ses_cloud", expectedUpdated: 7 })
      return { data: { id: "ses_local" } }
    })
    const id = await importCloudSession(c, "ses_cloud")
    expect(id).toBe("ses_local")
  })

  test("throws when server returns HTTP error", async () => {
    const c = client(async () => ({
      data: undefined,
      error: { name: "GatewayError", message: "session not found", status: 404 },
    }))
    await expect(importCloudSession(c, "ses_cloud")).rejects.toThrow("session not found")
  })

  test("throws with the gateway's { error } reason (400/500 contract)", async () => {
    const c = client(async () => ({
      data: undefined,
      error: { error: "Invalid export data" },
    }))
    await expect(importCloudSession(c, "ses_cloud")).rejects.toThrow("Invalid export data")
  })

  test("throws when data.id is missing", async () => {
    const c = client(async () => ({ data: {} }))
    await expect(importCloudSession(c, "ses_cloud")).rejects.toThrow()
  })

  test("rejects a preview without a stable revision before import", async () => {
    const imp = mock(async () => ({ data: { id: "ses_local" } }))
    const c = client(imp, async () => ({ data: { info: {} } }))
    await expect(importCloudSession(c, "ses_cloud")).rejects.toThrow("requires a stable revision")
    expect(imp).not.toHaveBeenCalled()
  })

  test("propagates thrown fetch exceptions", async () => {
    const c = client(async () => {
      throw new Error("network down")
    })
    await expect(importCloudSession(c, "ses_cloud")).rejects.toThrow("network down")
  })
})

describe("reportCloudImportError", () => {
  test("surfaces the reason via UI.error and does not throw", () => {
    const err = new Error("session not found")
    expect(() => reportCloudImportError(err)).not.toThrow()
    expect(errorMock).toHaveBeenCalledWith("Failed to import session from cloud: session not found")
  })
})
