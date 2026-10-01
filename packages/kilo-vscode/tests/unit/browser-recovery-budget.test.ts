import { expect, test } from "bun:test"
import type { BrowserRequest, KiloClient } from "@kilocode/sdk/v2/client"
import { BrowserBridge, type BrowserConnection } from "../../src/services/browser-automation/browser-bridge"

test("shares the bounded list retry budget across all recovery directories", async () => {
  const held = Promise.withResolvers<{ data: BrowserRequest[] }>()
  const done = Promise.withResolvers<void>()
  const calls = { list: 0, execute: 0 }
  const client = {
    kilocode: {
      browser: {
        list: async () => {
          if (++calls.list <= 3) return held.promise
          done.resolve()
          return { data: [] }
        },
      },
    },
  } as unknown as KiloClient
  let state: Parameters<BrowserConnection["onStateChange"]>[0] = () => undefined
  const connection: BrowserConnection = {
    getKnownDirectories: () => ["C:\\first", "C:\\second"],
    getClient: () => client,
    onEvent: () => () => undefined,
    onStateChange: (listener) => {
      state = listener
      return () => undefined
    },
  }
  const bridge = new BrowserBridge(connection, {
    show: async () => undefined,
    execute: async () => {
      calls.execute++
      throw new Error("Native work must not run during pending-list retries")
    },
  })
  try {
    state("connected")
    await done.promise
    held.resolve({ data: [] })
    await Bun.sleep(10)
    expect(calls).toEqual({ list: 4, execute: 0 })
  } finally {
    held.resolve({ data: [] })
    bridge.dispose()
  }
}, 10_000)
