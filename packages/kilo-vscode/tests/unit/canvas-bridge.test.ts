// raya_change - Milestone E typed data-channel bridge test
import { describe, expect, it } from "bun:test"
import type { CanvasRequest, KiloClient } from "@kilocode/sdk/v2/client"
import type { SSEPayload } from "../../src/services/cli-backend/sdk-sse-adapter"
import { CanvasBridge, type CanvasConnection, type CanvasHost } from "../../src/services/canvas/canvas-bridge"

describe("Raya canvas bridge", () => {
  it("routes source and typed data to the workspace host and replies with render status", async () => {
    const requests: Array<{ request: CanvasRequest; directory: string }> = []
    const done = Promise.withResolvers<Record<string, unknown>>()
    const client = {
      kilocode: {
        canvas: {
          list: async () => ({ data: [] }),
          reply: async (input: Record<string, unknown>) => {
            done.resolve(input)
            return {}
          },
          reject: async () => ({}),
        },
      },
    } as unknown as KiloClient
    const connection = harness(client)
    const host: CanvasHost = {
      execute: async (request, directory) => {
        requests.push({ request, directory })
        return {
          operation: request.operation,
          name: request.name,
          path: `${directory}\\.raya\\canvases\\${request.name}.canvas.tsx`,
          status: "ready",
          version: 1,
        }
      },
    }
    const bridge = new CanvasBridge(connection.value, host)

    connection.event({
      id: "evt_canvas",
      type: "kilocode.canvas.requested",
      properties: {
        id: "cnr_test",
        sessionID: "ses_test",
        operation: "create",
        name: "sales-report",
        source: "export default function Report({ data }) { return <div>{data.total}</div> }",
        data: { total: 42, labels: ["Revenue"] },
      },
    })

    expect(await done.promise).toMatchObject({
      requestID: "cnr_test",
      directory: "C:\\workspace",
      result: {
        operation: "create",
        name: "sales-report",
        status: "ready",
      },
    })
    expect(requests).toEqual([
      {
        directory: "C:\\workspace",
        request: {
          id: "cnr_test",
          sessionID: "ses_test",
          operation: "create",
          name: "sales-report",
          source: "export default function Report({ data }) { return <div>{data.total}</div> }",
          data: { total: 42, labels: ["Revenue"] },
        },
      },
    ])
    bridge.dispose()
  })
})

function harness(client: KiloClient) {
  let event: (event: SSEPayload, directory?: string) => void = () => undefined
  const value: CanvasConnection = {
    onEvent(listener) {
      event = listener
      return () => undefined
    },
    onStateChange() {
      return () => undefined
    },
    getKnownDirectories: () => ["C:\\workspace"],
    getClient: () => client,
  }
  return {
    value,
    event(input: unknown) {
      event(input as SSEPayload, "C:\\workspace")
    },
  }
}
