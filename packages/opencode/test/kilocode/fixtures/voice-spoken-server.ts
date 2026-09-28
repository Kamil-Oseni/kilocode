import path from "node:path"
import { createServer } from "node:net"
import { createInterface } from "node:readline"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { RayaVoiceBindingTable as Table } from "@opencode-ai/core/kilocode/voice.sql"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { Server } from "../../../src/server/server"

const [root] = process.argv.slice(2)
if (!root || !path.isAbsolute(root)) throw new Error("Expected absolute disposable spoken transport root")
if (path.resolve(Database.path()) !== path.join(root, "voice.sqlite"))
  throw new Error("Spoken transport fixture database escaped its disposable root")

// Avoid the production port-zero preference for 4096: use a separately allocated ephemeral port.
const socket = createServer()
await new Promise<void>((resolve, reject) => {
  socket.once("error", reject)
  socket.listen(0, "127.0.0.1", resolve)
})
const address = socket.address()
if (!address || typeof address === "string") throw new Error("Expected ephemeral loopback address")
await new Promise<void>((resolve, reject) => socket.close((err) => (err ? reject(err) : resolve())))
const listener = await Server.listen({ hostname: "127.0.0.1", port: address.port })
const database = await AppRuntime.runPromise(Database.Service.use((db) => db.db.all(sql`PRAGMA database_list`)))
process.stdout.write(`SPOKEN_READY ${JSON.stringify({ url: listener.url.href, pid: process.pid, database })}\n`)

const input = createInterface({ input: process.stdin })
try {
  for await (const line of input) {
    if (line !== "inspect") throw new Error("Unexpected spoken fixture control input")
    const report = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const messages = yield* database.db.get<{ count: number }>(sql`SELECT count(*) AS count FROM message`)
        const rows = yield* database.db.select().from(Table).limit(16).all()
        return { messages: messages?.count, bindings: rows.map((row) => ({ id: row.id, calls: row.data.calls })) }
      }),
    )
    process.stdout.write(`SPOKEN_INSPECT ${JSON.stringify(report)}\n`)
  }
} finally {
  input.close()
  await listener.stop(true)
  await AppRuntime.dispose()
}
