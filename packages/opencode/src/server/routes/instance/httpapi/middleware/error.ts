import { ConfigErrorV1 } from "@opencode-ai/core/v1/config/error"
import { busyMessage, isBusy } from "@/kilocode/database/sqlite-error" // kilocode_change
import { DiagnosticError } from "@/kilocode/diagnostic-error" // kilocode_change
import { response as malformedJSON } from "@/kilocode/server/httpapi/malformed-json" // kilocode_change
import { Cause, Effect } from "effect"
// kilocode_change start
import {
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http"
// kilocode_change end

// kilocode_change start
function failure(error: unknown, cause: Cause.Cause<unknown>) {
  const receipt = DiagnosticError.make({
    code: "server.unexpected",
    message: "Unexpected server error. Check server logs for details.",
  })
  return Effect.logError("failed", { ref: receipt.ref, error, cause: Cause.pretty(cause) }).pipe(
    Effect.as(HttpServerResponse.jsonUnsafe(receipt.error, { status: 500 })),
  )
}
// kilocode_change end

// Keep typed HttpApi failures on their declared error path; this boundary only replaces defect-only empty 500s.
export const errorLayer = HttpRouter.middleware<{ handles: unknown }>()((effect) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      const defect = cause.reasons.filter(Cause.isDieReason).find((reason) => {
        if (HttpServerResponse.isHttpServerResponse(reason.defect)) return false
        if (HttpServerError.isHttpServerError(reason.defect)) return false
        if (HttpServerRespondable.isRespondable(reason.defect)) return false
        return true
      })
      if (!defect) return Effect.failCause(cause)

      const error = defect.defect
      // kilocode_change start - Effect's JSON decoder promotes malformed request bodies to defects
      if (error instanceof SyntaxError) {
        return Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const response = malformedJSON(error, request)
          if (!response) return yield* failure(error, cause)
          return yield* Effect.logWarning("malformed JSON request", {
            method: request.method,
            path: request.url.split("?", 1)[0],
          }).pipe(Effect.as(response))
        })
      }
      // kilocode_change end
      // kilocode_change start - SQLite lock contention is expected with multiple local clients
      if (isBusy(error)) {
        const receipt = DiagnosticError.make({ code: "database.busy", message: busyMessage })
        return Effect.logWarning("database busy", { ref: receipt.ref }).pipe(
          Effect.as(HttpServerResponse.jsonUnsafe(receipt.error, { status: 503 })),
        )
      }
      // kilocode_change end
      if (
        ConfigErrorV1.JsonError.isInstance(error) ||
        ConfigErrorV1.InvalidError.isInstance(error) ||
        ConfigErrorV1.FrontmatterError.isInstance(error) ||
        ConfigErrorV1.DirectoryTypoError.isInstance(error)
      ) {
        return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status: 400 }))
      }

      return failure(error, cause) // kilocode_change
    }),
  ),
).layer
