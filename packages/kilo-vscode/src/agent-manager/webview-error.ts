export function report(msg: Record<string, unknown>, log: (message: string) => void) {
  if (msg.type !== "agentManager.webviewError") return false
  const source = typeof msg.source === "string" ? msg.source.slice(0, 32) : "unknown"
  const message = typeof msg.message === "string" ? msg.message.slice(0, 4_000) : "No diagnostic was provided."
  log(`Webview ${source} failure: ${message}`)
  return true
}
