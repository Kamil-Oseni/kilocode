import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

export const header = "x-request-id"

const valid = /^[A-Za-z0-9._:-]{1,128}$/

export function resolve(value?: string) {
  if (value && valid.test(value)) return value
  return `req_${crypto.randomUUID()}`
}

export const layer = HttpRouter.middleware(
  (effect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const id = resolve(request.headers[header])
      const response = yield* effect.pipe(Effect.annotateLogs({ requestID: id }))
      return HttpServerResponse.setHeader(response, header, id)
    }),
  { global: true },
)
