import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import type { Capabilities } from "../groups/capabilities"

export const capabilitiesHandlers = HttpApiBuilder.group(InstanceHttpApi, "capabilities", (handlers) =>
  handlers.handle("get", () =>
    Effect.succeed({ version: 1, features: { "goal.commandCheck": 1 } } satisfies typeof Capabilities.Type),
  ),
)
