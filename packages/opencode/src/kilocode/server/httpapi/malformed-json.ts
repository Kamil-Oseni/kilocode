import { HttpServerResponse } from "effect/unstable/http"

const message = "Malformed JSON request body"

export function response(
  error: unknown,
  request: { headers: Record<string, string | undefined>; url: string },
): HttpServerResponse.HttpServerResponse | undefined {
  if (!(error instanceof SyntaxError)) return undefined

  const media = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase()
  if (media !== "application/json" && !media?.endsWith("+json")) return undefined

  const path = request.url.split("?", 1)[0] ?? request.url
  if (path === "/api" || path.startsWith("/api/")) {
    return HttpServerResponse.jsonUnsafe({ _tag: "InvalidRequestError", message, kind: "Body" }, { status: 400 })
  }

  return HttpServerResponse.jsonUnsafe({ name: "BadRequest", data: { message, kind: "Body" } }, { status: 400 })
}
