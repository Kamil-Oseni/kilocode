import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "../../effect/app-node"
import type { Location } from "../../location"
import type { PtyID } from "../../pty/schema"

export type Request = {
  readonly version: 1
  readonly id: PtyID
  readonly location: Location.Ref
  readonly cwd: string
  readonly ownerSessionID?: string
}

export type Identity = {
  readonly pid: number
  readonly birth: string
  readonly helper: number
  readonly helperBirth: string
}

export type Proof = { readonly version: 2; readonly token: string; readonly proof: "windows-job"; readonly empty: true }

export type Lease = {
  readonly token: string
  readonly control: string
  readonly dispatch: () => Effect.Effect<void>
  readonly admit: (identity: Identity) => Effect.Effect<void>
  readonly retire: (proof: Proof) => Effect.Effect<void>
}

export interface Interface {
  readonly admission: <A>(request: Request, body: (lease: Lease) => Effect.Effect<A>) => Effect.Effect<A>
}

export class Service extends Context.Service<Service, Interface>()("@kilocode/PtyLifecycle") {}

export const layer = Layer.succeed(
  Service,
  Service.of({ admission: () => Effect.die(new Error("Native PTY requires an authoritative lifecycle adapter")) }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [] })

export * as KiloPtyLifecycle from "./lifecycle"
