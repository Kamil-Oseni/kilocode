import { AccountRepo } from "@/account/repo"
import { KiloSessions } from "@/kilo-sessions/kilo-sessions"
import { SessionID } from "@/session/schema"
import { ShareNext } from "@/share/share-next"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EnvAlias } from "@opencode-ai/core/kilocode/env-alias"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { provideTmpdirInstance } from "../../fixture/fixture"

const calls: string[] = []
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith("/api/user")) return new Response("{}", { status: 200 })
    if (url.endsWith("/api/session")) {
      return Response.json({ id: "private-session", ingestPath: "/api/ingest/private-session" })
    }
    throw new Error(`Unexpected network request: ${url}`)
  },
  { preconnect: globalThis.fetch.preconnect },
)

let effectCalls = 0
const client = HttpClient.make(() => {
  effectCalls += 1
  return Effect.die("unexpected ShareNext network request")
})
const replacement = [httpClient, Layer.succeed(HttpClient.HttpClient, client)] as const
const platform = LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node]))
const layer = LayerNode.compile(LayerNode.group([ShareNext.node, AccountRepo.node]), [replacement])

const result = await Effect.runPromise(
  Effect.scoped(
    provideTmpdirInstance(() =>
      ShareNext.Service.use((svc) => svc.create(SessionID.make("ses_share-disabled-worker"))).pipe(
        Effect.provide(layer),
      ),
    ).pipe(Effect.provide(platform)),
  ),
)

const errors: string[] = []
for (const action of [KiloSessions.share, KiloSessions.unshare]) {
  await action("share-disabled-worker").catch((error: unknown) => {
    errors.push(error instanceof Error ? error.message : String(error))
  })
}

const before = calls.length
const ingest =
  process.env["RAYA_SHARE_TEST_INGEST"] === "1" ? await KiloSessions.bootstrap("private-session") : undefined

console.log(JSON.stringify({ result, errors, effectCalls, before, calls, ingest, conflicts: EnvAlias.conflicts() }))
process.exit(0)
