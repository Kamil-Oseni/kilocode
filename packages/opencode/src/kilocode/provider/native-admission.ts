import { LocalInferenceError, type localFetch } from "./local-scheduler"
import { OllamaBridgeError } from "./ollama-bridge"

/** Preserve terminal local refusal before Effect's HTTP client can classify a thrown fetch error as retryable. */
export function terminal(
  fetcher: ReturnType<typeof localFetch>,
  record?: (err: LocalInferenceError | OllamaBridgeError) => void,
): ReturnType<typeof localFetch> {
  return async (input, init) => {
    try {
      return await fetcher(input, init)
    } catch (err) {
      if (!(err instanceof LocalInferenceError) && !(err instanceof OllamaBridgeError)) throw err
      record?.(err)
      return Response.json(
        {
          error: {
            message: err.message,
            type: "raya_local_admission",
            code: err instanceof LocalInferenceError ? err.code : "ollama-bridge",
          },
        },
        {
          status: 400,
          headers: { "x-raya-local-admission": err instanceof LocalInferenceError ? err.code : "ollama-bridge" },
        },
      )
    }
  }
}
