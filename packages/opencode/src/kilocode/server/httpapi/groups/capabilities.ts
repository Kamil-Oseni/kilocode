import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"

export const Capabilities = Schema.Struct({
  version: Schema.Literal(1),
  features: Schema.Struct({ "goal.commandCheck": Schema.Literal(1) }),
})

export const CapabilitiesApi = HttpApi.make("capabilities").add(
  HttpApiGroup.make("capabilities")
    .add(
      HttpApiEndpoint.get("get", "/kilocode/capabilities", { success: Capabilities }).annotateMerge(
        OpenApi.annotations({
          identifier: "capabilities.get",
          summary: "Get supported Raya capability contracts",
          description: "Read explicit semantic contract versions before sending feature-dependent mutations.",
        }),
      ),
    )
    .middleware(Authorization),
)
