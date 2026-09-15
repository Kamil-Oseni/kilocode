import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { RayaAdmin } from "@/kilocode/admin/registry"
import { RayaAdminLog } from "@/kilocode/admin/log"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

const root = "/raya/admin"

export const AdminPaths = {
  health: `${root}/health`,
  logs: `${root}/logs`,
} as const

export const AdminLogQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  after: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
  ),
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
  ),
})

export const AdminApi = HttpApi.make("raya-admin").add(
  HttpApiGroup.make("raya-admin")
    .add(
      HttpApiEndpoint.get("adminHealth", AdminPaths.health, {
        query: WorkspaceRoutingQuery,
        success: described(RayaAdmin.Snapshot, "Redacted subsystem health snapshot"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "raya.admin.health",
          summary: "Get subsystem health",
          description: "Read bounded, redacted health signals for Raya subsystems.",
        }),
      ),
      HttpApiEndpoint.get("adminLogs", AdminPaths.logs, {
        query: AdminLogQuery,
        success: described(Schema.Array(RayaAdminLog.Entry), "Redacted diagnostic log entries"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "raya.admin.logs",
          summary: "List diagnostic entries",
          description:
            "Read the newest retained redacted diagnostic entries, or page forward in sequence order after an explicit cursor.",
        }),
      ),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
