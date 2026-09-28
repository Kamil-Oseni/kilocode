import { buildLocationServiceMap as build } from "@opencode-ai/core/location-services"
import { KiloPtyLifecycle } from "@opencode-ai/core/kilocode/pty/lifecycle"
import type { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { Duration } from "effect"
import { PtyOwners } from "./lifecycle"

export const buildLocationServiceMap = (
  replacements: LayerNode.Replacements = [],
  options: { readonly idleTimeToLive?: Duration.Input } = {},
) => build([[KiloPtyLifecycle.node, PtyOwners.node], ...replacements], options)

export const locationServiceMapLayer = buildLocationServiceMap()
