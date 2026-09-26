import { describe, expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import type * as vscode from "vscode"
import { KiloConnectionService } from "../../src/services/cli-backend/connection-service"
import { ServerManager, type ServerInstance } from "../../src/services/cli-backend/server-manager"

function child(pid: number) {
  return { pid, exitCode: null, signalCode: null, killed: false } as ChildProcess
}

function server(pid: number, startedAt: number): ServerInstance {
  return { port: 41000 + pid, password: "test", process: child(pid), startedAt }
}

function manager() {
  return new ServerManager({} as vscode.ExtensionContext)
}

describe("managed backend process identity", () => {
  test("returns no identity and does not spawn when the backend is absent or starting", () => {
    const host = manager()
    let starts = 0
    ;(host as unknown as { startServer: () => Promise<ServerInstance> }).startServer = async () => {
      starts += 1
      return server(123, 1000)
    }
    expect(host.currentProcessIdentity()).toBeNull()
    expect(starts).toBe(0)
    ;(host as unknown as { startupPromise: Promise<ServerInstance> }).startupPromise = Promise.resolve(
      server(123, 1000),
    )
    expect(host.currentProcessIdentity()).toBeNull()
    expect(starts).toBe(0)
  })

  test("returns the exact running child and refuses exited or terminating children", async () => {
    const host = manager()
    const active = server(123, 1000)
    ;(host as unknown as { startServer: () => Promise<ServerInstance> }).startServer = async () => active
    await host.getServer()
    expect(host.currentProcessIdentity()).toEqual({ pid: 123, startedAt: 1000, port: 41123, generation: 1 })
    active.process.exitCode = 1
    expect(host.currentProcessIdentity()).toBeNull()
    active.process.exitCode = null
    active.process.killed = true
    expect(host.currentProcessIdentity()).toBeNull()
  })

  test("increments generation after a replacement and refuses stale connection identity", async () => {
    const host = manager()
    const first = server(123, 1000)
    const second = server(456, 2000)
    const children = [first, second]
    ;(host as unknown as { startServer: () => Promise<ServerInstance> }).startServer = async () => children.shift()!
    await host.getServer()
    const state = Object.create(KiloConnectionService.prototype) as KiloConnectionService
    ;(state as unknown as { serverManager: ServerManager; state: string; info: { port: number } }).serverManager = host
    ;(state as unknown as { state: string }).state = "connected"
    ;(state as unknown as { info: { port: number } }).info = { port: first.port }
    expect(state.currentProcessIdentity()?.generation).toBe(1)
    ;(host as unknown as { instance: ServerInstance | null }).instance = null
    await host.getServer()
    expect(host.currentProcessIdentity()).toEqual({ pid: 456, startedAt: 2000, port: 41456, generation: 2 })
    expect(state.currentProcessIdentity()).toBeNull()
    ;(state as unknown as { info: { port: number } }).info = { port: second.port }
    expect(state.currentProcessIdentity()?.generation).toBe(2)
    ;(state as unknown as { state: string }).state = "disconnected"
    expect(state.currentProcessIdentity()).toBeNull()
  })
})
