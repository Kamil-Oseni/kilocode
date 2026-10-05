import path from "node:path"
import { Effect, Layer } from "effect"
import { Credential } from "../../../src/credential"
import { CredentialTable } from "../../../src/credential/sql"
import { Database } from "../../../src/database/database"
import { Global } from "../../../src/global"
import { LayerNode } from "../../../src/effect/layer-node"
import { Integration } from "../../../src/integration"
import { CredentialPublication } from "../../../src/kilocode/credential-publication"

const [mode, dir] = process.argv.slice(2) as [string, string]
const layer = LayerNode.compile(Credential.node, [
  [Database.node, Database.layerFromPath(path.join(dir, "credentials.db"))],
  [Global.node, Global.layerWith({ data: dir })],
])
if (mode === "core") {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* Credential.Service).create({
        integrationID: Integration.ID.make("core"),
        value: Credential.Key.make({ type: "key", key: "synthetic-core" }),
      })
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
}
if (mode === "import") {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      return (yield* (yield* Credential.Service).all()).length
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.exit),
  )
  console.log(JSON.stringify({ imported: result._tag === "Success" }))
  if (result._tag === "Success") process.exitCode = 1
}
if (mode === "crash") {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* CredentialPublication.run(path.join(dir, "auth.json"), (channel) =>
        Effect.gen(function* () {
          yield* channel.begin
          yield* db
            .insert(CredentialTable)
            .values({
              id: Credential.ID.make("cred_crash"),
              integration_id: Integration.ID.make("crash"),
              label: "synthetic",
              value: Credential.Key.make({ type: "key", key: "synthetic-new" }),
            })
            .run()
          console.log("COMMITTED")
          yield* Effect.never
        }),
      )
    }).pipe(Effect.provide(Database.layerFromPath(path.join(dir, "credentials.db"))), Effect.scoped),
  )
}
