import { createConnection } from "net"
import { createServer } from "http"
import { escapeHtml } from "@/util/html"
import * as Log from "@opencode-ai/core/util/log" // kilocode_change
import { OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH, parseRedirectUri } from "./oauth-provider"
import * as KiloOAuthCallback from "../kilocode/mcp-oauth-callback" // kilocode_change

const log = Log.create({ service: "mcp.oauth-callback" }) // kilocode_change

// Current callback server configuration (may differ from defaults if custom redirectUri is used)
let currentPort = OAUTH_CALLBACK_PORT
let currentPath = OAUTH_CALLBACK_PATH

// kilocode_change start - Raya OAuth completion uses one restrained, responsive surface for every outcome
const CALLBACK_STYLE = `<style>
  :root { color-scheme: light dark; --surface: #f7f7f5; --text: #202124; --muted: #666a70; --border: #d7d9dc; --success: #2f6b4f; --danger: #a13d3d; --detail: #f0f0ee; }
  @media (prefers-color-scheme: dark) { :root { --surface: #171819; --text: #f1f1ef; --muted: #a5a8ad; --border: #3c3e42; --success: #7fc49d; --danger: #ee9292; --detail: #222426; } }
  * { box-sizing: border-box; }
  body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: var(--surface); color: var(--text); font-family: "Outfit", system-ui, -apple-system, sans-serif; }
  main { width: min(32rem, 100%); padding: 2rem 1.5rem; }
  h1 { margin: 0 0 0.75rem; color: var(--status); font-family: "Instrument Serif", Georgia, serif; font-size: clamp(2rem, 8vw, 2.75rem); font-weight: 400; line-height: 1.05; }
  p { margin: 0; color: var(--muted); font-size: 1rem; line-height: 1.55; }
  .detail { margin: 1.25rem 0 0; padding: 1rem; overflow-wrap: anywhere; white-space: pre-wrap; border: 1px solid var(--border); border-radius: 0.5rem; background: var(--detail); color: var(--text); font: 0.875rem/1.5 ui-monospace, "SFMono-Regular", Consolas, monospace; }
  .success { --status: var(--success); }
  .error { --status: var(--danger); }
</style>`
// kilocode_change end

// kilocode_change start - Raya result copy, layout, and accessible status semantics
const HTML_SUCCESS = `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <!-- kilocode_change start -->
  <title>Raya - Authorization Successful</title>
  <!-- kilocode_change end -->
  ${CALLBACK_STYLE}
</head>
<body>
  <main class="success" role="status">
    <h1>Authorization complete</h1>
    <!-- kilocode_change start -->
    <p>You can close this window and return to Raya.</p>
    <!-- kilocode_change end -->
  </main>
  <script>setTimeout(() => window.close(), 2000);</script>
</body>
</html>`

const HTML_ERROR = (error: string) => `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <!-- kilocode_change start -->
  <title>Raya - Authorization Failed</title>
  <!-- kilocode_change end -->
  ${CALLBACK_STYLE}
</head>
<body>
  <main class="error" role="alert">
    <h1>Authorization failed</h1>
    <p>Raya couldn't finish connecting this service. Review the detail below, then try connecting again.</p>
    <pre class="detail" id="oc-detail">${escapeHtml(error)}</pre>
  </main>
</body>
</html>`
// kilocode_change end

interface PendingAuth {
  resolve: (code: string) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

let server: ReturnType<typeof createServer> | undefined
const pendingAuths = new Map<string, PendingAuth>()
// Reverse index: mcpName → oauthState, so cancelPending(mcpName) can
// find the right entry in pendingAuths (which is keyed by oauthState).
const mcpNameToState = new Map<string, string>()

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

function cleanupStateIndex(oauthState: string) {
  for (const [name, state] of mcpNameToState) {
    if (state === oauthState) {
      mcpNameToState.delete(name)
      break
    }
  }
}

function stopIfIdle() {
  if (pendingAuths.size > 0 || !server) return

  server.close()
  server = undefined
}

function handleRequest(req: import("http").IncomingMessage, res: import("http").ServerResponse) {
  const url = new URL(req.url || "/", `http://localhost:${currentPort}`)

  if (url.pathname !== currentPath) {
    res.writeHead(404)
    res.end("Not found")
    return
  }

  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const error = url.searchParams.get("error")
  const errorDescription = url.searchParams.get("error_description")

  // Enforce state parameter presence
  if (!state) {
    const errorMsg = "Missing required state parameter - potential CSRF attack"
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
    res.end(HTML_ERROR(errorMsg))
    return
  }

  if (error) {
    const errorMsg = errorDescription || error
    if (pendingAuths.has(state)) {
      const pending = pendingAuths.get(state)!
      clearTimeout(pending.timeout)
      pendingAuths.delete(state)
      cleanupStateIndex(state)
      pending.reject(new Error(errorMsg))
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(HTML_ERROR(errorMsg))
    stopIfIdle()
    return
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
    res.end(HTML_ERROR("No authorization code provided"))
    return
  }

  // Validate state parameter
  if (!pendingAuths.has(state)) {
    const errorMsg = "Invalid or expired state parameter - potential CSRF attack"
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
    res.end(HTML_ERROR(errorMsg))
    return
  }

  const pending = pendingAuths.get(state)!

  clearTimeout(pending.timeout)
  pendingAuths.delete(state)
  cleanupStateIndex(state)
  pending.resolve(code)

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end(HTML_SUCCESS)
  stopIfIdle()
}

export async function ensureRunning(redirectUri?: string): Promise<void> {
  // kilocode_change start - delegate Kilo-specific callback binding from here because OAuth state lives in this module
  await KiloOAuthCallback.ensureRunning({
    redirectUri,
    parse: parseRedirectUri,
    state: () => ({ server, port: currentPort, path: currentPath }),
    set: (next) => {
      server = next.server
      currentPort = next.port
      currentPath = next.path
    },
    create: () => createServer(handleRequest),
    stop,
    info: (msg, data) => log.info(msg, data),
    error: (msg, data) => log.error(msg, data),
  })
  // kilocode_change end
}

export function waitForCallback(oauthState: string, mcpName?: string): Promise<string> {
  if (mcpName) mcpNameToState.set(mcpName, oauthState)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingAuths.has(oauthState)) {
        pendingAuths.delete(oauthState)
        if (mcpName) mcpNameToState.delete(mcpName)
        reject(new Error("OAuth callback timeout - authorization took too long"))
        stopIfIdle()
      }
    }, CALLBACK_TIMEOUT_MS)

    pendingAuths.set(oauthState, { resolve, reject, timeout })
  })
}

export function cancelPending(mcpName: string): void {
  // Look up the oauthState for this mcpName via the reverse index
  const oauthState = mcpNameToState.get(mcpName)
  const key = oauthState ?? mcpName
  const pending = pendingAuths.get(key)
  if (pending) {
    clearTimeout(pending.timeout)
    pendingAuths.delete(key)
    mcpNameToState.delete(mcpName)
    pending.reject(new Error("Authorization cancelled"))
    stopIfIdle()
  }
}

export async function isPortInUse(port: number = OAUTH_CALLBACK_PORT): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(port, "127.0.0.1")
    socket.on("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.on("error", () => {
      resolve(false)
    })
  })
}

export async function stop(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
  }

  for (const [_name, pending] of pendingAuths) {
    clearTimeout(pending.timeout)
    pending.reject(new Error("OAuth callback server stopped"))
  }
  pendingAuths.clear()
  mcpNameToState.clear()
}

export function isRunning(): boolean {
  return server !== undefined
}

export * as McpOAuthCallback from "./oauth-callback"
