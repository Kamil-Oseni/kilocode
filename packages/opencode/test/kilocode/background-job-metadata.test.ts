import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { BackgroundJobInfo, BackgroundJobMetadata } from "../../src/kilocode/server/httpapi/groups/kilocode"

describe("background job HTTP metadata", () => {
  test("omits undefined task fields before JSON encoding", () => {
    const metadata = BackgroundJobMetadata.clean({
      parentSessionId: "ses_parent",
      sessionId: "ses_child",
      variant: undefined,
    })
    const result = Schema.encodeUnknownSync(Schema.Array(BackgroundJobInfo))([
      {
        id: "ses_child",
        type: "task",
        status: "running",
        started_at: 1,
        metadata,
      },
    ])

    expect(metadata).toEqual({ parentSessionId: "ses_parent", sessionId: "ses_child" })
    expect(metadata).not.toHaveProperty("variant")
    expect(result[0]?.metadata).not.toHaveProperty("variant")
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })

  test("omits empty metadata objects", () => {
    expect(BackgroundJobMetadata.clean({ variant: undefined })).toBeUndefined()
  })
})
