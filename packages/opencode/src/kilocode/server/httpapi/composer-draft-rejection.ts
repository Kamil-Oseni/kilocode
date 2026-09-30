import { HttpServerResponse } from "effect/unstable/http"

/** Use route metadata before formatting Schema issues, which may contain the complete draft. */
export function rejection(path: string) {
  if (!/^\/(?:api\/)?kilocode\/composer-drafts\/(?:list|load|save|clear|promote)$/.test(path)) return
  return HttpServerResponse.jsonUnsafe(
    { _tag: "ComposerDraftError", code: "invalid", message: "Composer draft request is invalid." },
    { status: 400 },
  )
}
