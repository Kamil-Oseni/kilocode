// raya_change - Generated voice API surface and secret-isolation contract.
import { describe, expect, it } from "bun:test"
import { join } from "node:path"

type Operation = {
  operationId?: string
  requestBody?: unknown
  responses?: unknown
}

type Spec = {
  paths: Record<string, Record<string, Operation>>
}

describe("Raya realtime voice API", () => {
  it("publishes start, state, close, and ordered event endpoints", async () => {
    const file = join(import.meta.dir, "../../../sdk/openapi.json")
    const spec = (await Bun.file(file).json()) as Spec
    expect(spec.paths["/kilocode/voice/session"]?.post?.operationId).toBe("kilocode.voice.start")
    expect(spec.paths["/kilocode/voice/session/{voiceSessionID}"]?.get?.operationId).toBe("kilocode.voice.state")
    expect(spec.paths["/kilocode/voice/session/{voiceSessionID}"]?.delete?.operationId).toBe("kilocode.voice.close")
    expect(spec.paths["/kilocode/voice/events"]?.post?.operationId).toBe("kilocode.voice.event")
  })

  it("returns room credentials and capability truth without provider keys", async () => {
    const file = join(import.meta.dir, "../../../sdk/openapi.json")
    const spec = (await Bun.file(file).json()) as Spec
    const start = JSON.stringify(spec.paths["/kilocode/voice/session"]?.post)
    expect(start).toContain("clientToken")
    expect(start).toContain("mediaToken")
    expect(start).toContain("acceptsTruncation")
    expect(start).not.toContain("qwenKey")
    expect(start).not.toContain("apiSecret")
  })
})
