import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { handleRoutineMessage } from "../../src/kilo-provider/routines"

test("assignment save forwards role, write folder, and sensitive-role consent", async () => {
  const calls: Request[] = []
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      return Response.json({ id: "routine", role: "accountant", dir: "C:/tmp/books-writes" })
    },
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post: () => {},
    message: {
      type: "routineUpdate",
      agentID: "routine",
      name: "Books",
      role: "accountant",
      objective: "Review accounts",
      dir: "C:/tmp/books-writes",
      capabilities: ["money"],
    },
  })
  const patch = calls.find((request) => request.method === "PATCH")
  expect(patch).toBeDefined()
  expect(new URL(patch!.url).searchParams.get("directory")).toBe("workspace")
  expect(await patch!.json()).toEqual({
    name: "Books",
    role: "accountant",
    objective: "Review accounts",
    dir: "C:/tmp/books-writes",
    capabilities: ["money"],
  })
})
