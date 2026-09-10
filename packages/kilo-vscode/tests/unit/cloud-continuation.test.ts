import { expect, test } from "bun:test"
import { createCloudContinuation } from "../../webview-ui/src/context/session-cloud-continuation"

test("cloud preview correlation ignores late reads and failures and preserves a failed continuation", () => {
  const called: string[] = []
  const cloud = createCloudContinuation({
    loaded: () => called.push("loaded"),
    imported: () => called.push("imported"),
    failed: () => called.push("failed"),
  })
  const stale = cloud.request("cloud")
  const requestID = cloud.request("cloud")
  const continuation = { id: "ticket", directory: "/repo", status: "preview" as const }
  cloud.receive({
    type: "cloudSessionDataLoaded",
    cloudSessionId: "cloud",
    requestID: stale,
    title: "Late",
    messages: [],
    continuation,
  })
  expect(called).toEqual([])
  cloud.receive({
    type: "cloudSessionDataLoaded",
    cloudSessionId: "cloud",
    requestID,
    title: "Preview",
    messages: [],
    continuation,
  })
  expect(cloud.send("cloud")).toBe("ticket")
  cloud.receive({ type: "cloudSessionImportFailed", cloudSessionId: "cloud", continuationID: "old", error: "Stale" })
  expect(called).toEqual(["loaded"])
  cloud.receive({
    type: "cloudSessionImportFailed",
    cloudSessionId: "cloud",
    continuationID: "ticket",
    status: "uncertain",
    error: "Check Local history",
  })
  expect(cloud.get("cloud")).toEqual({
    ...continuation,
    status: "uncertain",
    error: "Check Local history",
    sessionID: undefined,
  })
  expect(called).toEqual(["loaded", "failed"])
})

test("a late admitted import updates its own continuation without replacing another preview", () => {
  const imported: string[] = []
  const cloud = createCloudContinuation({
    loaded() {},
    imported: (message) => imported.push(message.cloudSessionId),
    failed() {},
  })
  for (const id of ["first", "second"]) {
    const requestID = cloud.request(id)
    cloud.receive({
      type: "cloudSessionDataLoaded",
      cloudSessionId: id,
      requestID,
      title: id,
      messages: [],
      continuation: { id: id + "-ticket", directory: "/repo", status: "preview" },
    })
  }
  const second = cloud.get("second")
  cloud.receive({
    type: "cloudSessionImported",
    cloudSessionId: "first",
    continuationID: "first-ticket",
    session: { id: "local", title: "Copy", createdAt: "", updatedAt: "" },
  })
  expect(cloud.get("second")).toBe(second)
  expect(cloud.get("first")).toMatchObject({ status: "imported", sessionID: "local" })
  expect(imported).toEqual(["first"])
})
