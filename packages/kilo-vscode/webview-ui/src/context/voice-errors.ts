/** Safe microphone guidance; raw device/provider errors never enter the transcript. */
export class MicrophoneError extends Error {
  constructor(err?: unknown) {
    super(capture(err) ?? "Your microphone is unavailable. Check your input device, then reconnect or continue typing.")
    this.name = "MicrophoneUnavailableError"
  }
}

export function capture(err: unknown) {
  const name = err instanceof Error || err instanceof DOMException ? err.name : ""
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Raya couldn't access your microphone. Allow microphone access for VS Code, then reconnect or continue typing."
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "Raya couldn't find a usable microphone. Connect or select one, then reconnect or continue typing."
  if (name === "NotReadableError" || name === "AbortError")
    return "Raya couldn't open your microphone. Close other apps using it, check your input device, then reconnect or continue typing."
  if (name === "MicrophoneUnavailableError")
    return "Your microphone is unavailable. Check your input device, then reconnect or continue typing."
}
