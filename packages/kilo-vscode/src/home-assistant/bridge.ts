import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { randomBytes, createHash, timingSafeEqual } from "node:crypto"
import { Lights } from "./client"
import { record } from "./policy"
import { Failure, safe } from "./error"
import { Moods } from "./moods"

function id(value: unknown): value is string | number {
  return (
    (typeof value === "string" && /^[a-z0-9_-]{1,80}$/i.test(value)) ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  )
}
function uncertain(error: unknown): boolean {
  return error instanceof Failure ? error.uncertain : error instanceof AggregateError && error.errors.some(uncertain)
}
async function input(request: IncomingMessage) {
  const parts: Buffer[] = []
  let size = 0
  for await (const part of request) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part)
    size += bytes.length
    if (size > 16384) throw new Failure("invalid_request")
    parts.push(bytes)
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, size))) as unknown
}
async function output(response: ServerResponse, code: number, value?: unknown, session?: string) {
  if (response.destroyed) return
  response.writeHead(code, { "Content-Type": "application/json", ...(session ? { "Mcp-Session-Id": session } : {}) })
  await new Promise<void>((resolve) => {
    response.once("close", resolve)
    response.end(value === undefined ? undefined : JSON.stringify(value), resolve)
  })
}

/** Private runtime MCP transport: HA credentials never enter this protocol or the CLI. */
export class Bridge {
  #key = randomBytes(32).toString("hex")
  #sessions = new Set<string>()
  #replies = new Map<string, { hash: string; job: Promise<unknown> }>()
  #controllers = new Map<string, AbortController>()
  #jobs = new Set<Promise<void>>()
  #closed = false
  #opening?: Promise<{ url: string; headers: { Authorization: string } }>
  #failures = new Set<Error>()
  #ending?: Promise<void>
  #port = 0
  #server = createServer((request, response) => {
    const job = this.receive(request, response).catch((error: unknown) => {
      if (!(error instanceof Failure && error.code === "invalid_request")) this.#failures.add(safe(error, false))
      return output(response, 400, { error: "Home Assistant bridge request refused" })
    })
    this.#jobs.add(job)
    void job.then(
      () => this.#jobs.delete(job),
      (error: unknown) => {
        this.#failures.add(safe(error, false))
        this.#jobs.delete(job)
      },
    )
  })
  constructor(
    private readonly lights: Lights,
    private readonly admission: () => boolean = () => true,
    private readonly owns = true,
    private readonly moods?: Moods,
  ) {}

  open() {
    if (this.#closed) return Promise.reject(new Failure("closed"))
    this.#server.headersTimeout = 5000
    this.#server.requestTimeout = 10000
    this.#server.keepAliveTimeout = 1000
    this.#server.maxHeadersCount = 32
    this.#opening ??= new Promise<void>((resolve, reject) => {
      const failure = (error: Error) => reject(error)
      this.#server.once("error", failure)
      this.#server.listen(0, "127.0.0.1", () => {
        this.#server.removeListener("error", failure)
        resolve()
      })
    }).then(() => {
      const address = this.#server.address()
      if (!address || typeof address === "string") throw new Failure("bridge_unavailable")
      this.#port = address.port
      return { url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: `Bearer ${this.#key}` } }
    })
    return this.#opening
  }

  private tools() {
    const entities = this.lights.config.entities
    const schema = (properties: object, required: string[]) => ({
      type: "object",
      properties,
      required,
      additionalProperties: false,
    })
    return [
      ...(this.moods
        ? [
            {
              name: "moods_list",
              description:
                "Read locally saved dynamic light moods and the actual running/stopped/failed host cycle status. A source URL documents palette inspiration, not an official colour palette.",
              inputSchema: schema({}, []),
            },
            {
              name: "moods_save",
              description:
                "Save a reviewed named dynamic mood locally without changing lights. Research a requested theme first and include source URLs; identify inferred colours as inspiration. Use 60 seconds for the user's preferred slow staggered movement. Only configured lights are allowed. Explicit replace=true is required to overwrite a name.",
              inputSchema: schema(
                {
                  mood: {
                    type: "object",
                    additionalProperties: false,
                    required: ["name", "theme", "sources", "palette", "seconds", "duration", "lights"],
                    properties: {
                      name: { type: "string", pattern: "^[a-z][a-z0-9_]{0,39}$" },
                      theme: { type: "string", minLength: 1, maxLength: 240 },
                      sources: { type: "array", maxItems: 5, items: { type: "string", maxLength: 1024 } },
                      palette: {
                        type: "array",
                        minItems: 2,
                        maxItems: 6,
                        items: {
                          type: "array",
                          minItems: 3,
                          maxItems: 3,
                          items: { type: "integer", minimum: 0, maximum: 255 },
                        },
                      },
                      seconds: { type: "integer", minimum: 30, maximum: 600 },
                      duration: { type: "integer", minimum: 60, maximum: 10800 },
                      lights: {
                        type: "array",
                        minItems: 1,
                        maxItems: entities.length,
                        items: {
                          type: "object",
                          additionalProperties: false,
                          required: ["entity", "brightness", "phase"],
                          properties: {
                            entity: { type: "string", enum: entities },
                            brightness: { type: "integer", minimum: 1, maximum: 255 },
                            phase: { type: "number", minimum: 0, maximum: 599 },
                          },
                        },
                      },
                    },
                  },
                  replace: { type: "boolean" },
                },
                ["mood"],
              ),
            },
            {
              name: "moods_start",
              description:
                "Start one explicitly requested saved mood. Confirms the first frame through HA readback, then runs a bounded host-owned cycle; this is startup, not completed physical playback. Other Raya light commands stop it; observed external light changes stop it too. It never resumes after restart. Inspect mood status for failures.",
              inputSchema: schema({ name: { type: "string", pattern: "^[a-z][a-z0-9_]{0,39}$" } }, ["name"]),
            },
            {
              name: "moods_stop",
              description:
                "Stop and join the current host-owned colour cycle, preserving the current colours. Does not stop unrelated HA scripts.",
              inputSchema: schema({}, []),
            },
          ]
        : []),
      {
        name: "lights_read",
        description:
          "Read an explicitly allowed Home Assistant light's reported state, color capability and RGB color when reported. No physical-device acknowledgement is implied.",
        inputSchema: schema({ entity: { type: "string", enum: entities } }, ["entity"]),
      },
      {
        name: "lights_set",
        description:
          "Set one explicitly requested allowed light on/off, with optional brightness 1-255 or rgb_color [red,green,blue] integers 0-255 when on. For requested colors include rgb_color and first inspect color capability; on alone preserves the old color. Preserve every requested target and do not turn other lights off. Sends once and checks target-specific HA state/color. Never retry an uncertain action.",
        inputSchema: {
          ...schema(
            {
              entity: { type: "string", enum: entities },
              state: { type: "string", enum: ["on", "off"] },
              brightness: { type: "integer", minimum: 1, maximum: 255 },
              rgb_color: {
                type: "array",
                items: { type: "integer", minimum: 0, maximum: 255 },
                minItems: 3,
                maxItems: 3,
              },
            },
            ["entity", "state"],
          ),
          anyOf: [
            { properties: { state: { enum: ["on"] } } },
            { properties: { state: { enum: ["off"] }, brightness: false, rgb_color: false } },
          ],
        },
      },
      ...(this.lights.config.modes.length
        ? [
            {
              name: "lights_mode",
              description:
                "Activate an explicitly allowed existing scene/script, or stop an explicitly stoppable script. Accepted/started is not completed physical change; long scripts continue afterward. Never retry an uncertain action.",
              inputSchema: {
                ...schema(
                  {
                    mode: { type: "string", enum: this.lights.config.modes.map((mode) => mode.name) },
                    action: { type: "string", enum: ["activate", "stop"] },
                  },
                  ["mode"],
                ),
                oneOf: [
                  { properties: { action: { enum: ["activate"] } } },
                  {
                    properties: {
                      mode: {
                        enum: this.lights.config.modes.filter((mode) => mode.stop === true).map((mode) => mode.name),
                      },
                      action: { enum: ["stop"] },
                    },
                    required: ["action"],
                  },
                ].filter((_, index) => index === 0 || this.lights.config.modes.some((mode) => mode.stop === true)),
              },
            },
          ]
        : []),
    ]
  }

  private authorized(request: IncomingMessage) {
    const header = request.headers.authorization
    const actual = typeof header === "string" ? Buffer.from(header) : Buffer.alloc(0)
    const expected = Buffer.from(`Bearer ${this.#key}`)
    return (
      actual.length === expected.length &&
      timingSafeEqual(actual, expected) &&
      request.headers.origin === undefined &&
      request.headers.host === `127.0.0.1:${this.#port}`
    )
  }

  private async receive(request: IncomingMessage, response: ServerResponse) {
    if (this.#closed || !this.admission() || request.url !== "/mcp" || !this.authorized(request))
      return output(response, 403)
    const session = request.headers["mcp-session-id"]
    if (request.method === "DELETE") return this.remove(session, response)
    if (request.method !== "POST") return output(response, 405)
    if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json")
      return output(response, 415)
    request.setTimeout(5000)
    const expired = () => request.destroy(new Failure("invalid_request"))
    request.once("timeout", expired)
    const value = await input(request)
      .catch(() => {
        throw new Failure("invalid_request")
      })
      .finally(() => {
        request.setTimeout(0)
        request.removeListener("timeout", expired)
      })
    if (this.#closed || !this.admission()) return output(response, 403)
    if (!record(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") return output(response, 400)
    if (value.method === "initialize") return this.initialize(value, response)
    if (typeof session !== "string" || !this.#sessions.has(session)) return output(response, 404)
    return this.dispatch(value, session, response)
  }

  private async remove(session: unknown, response: ServerResponse) {
    if (typeof session !== "string" || !this.#sessions.delete(session)) return output(response, 404)
    for (const [key, controller] of this.#controllers) if (key.startsWith(session + ":")) controller.abort()
    const jobs = [...this.#replies.entries()]
      .filter(([key]) => key.startsWith(session + ":"))
      .map(([, value]) => value.job)
    await Promise.allSettled(jobs)
    return output(response, 200, {})
  }

  private initialize(value: Record<string, unknown>, response: ServerResponse) {
    if (
      !id(value.id) ||
      !record(value.params) ||
      typeof value.params.protocolVersion !== "string" ||
      !["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].includes(value.params.protocolVersion) ||
      this.#sessions.size >= 32
    )
      return output(response, 400)
    const next = randomBytes(24).toString("hex")
    this.#sessions.add(next)
    return output(
      response,
      200,
      {
        jsonrpc: "2.0",
        id: value.id,
        result: {
          protocolVersion: value.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "raya-home-assistant", version: "1" },
        },
      },
      next,
    )
  }

  private async dispatch(value: Record<string, unknown>, session: string, response: ServerResponse) {
    if (value.id === undefined) {
      if (value.method === "notifications/cancelled" && record(value.params) && id(value.params.requestId))
        this.#controllers.get(session + ":" + String(value.params.requestId))?.abort()
      return output(response, 202)
    }
    if (!id(value.id)) return output(response, 400)
    if (value.method === "tools/list")
      return output(response, 200, { jsonrpc: "2.0", id: value.id, result: { tools: this.tools() } })
    if (value.method === "ping") return output(response, 200, { jsonrpc: "2.0", id: value.id, result: {} })
    if (value.method !== "tools/call")
      return output(response, 200, {
        jsonrpc: "2.0",
        id: value.id,
        error: { code: -32601, message: "Unsupported method" },
      })
    const key = session + ":" + String(value.id)
    const hash = createHash("sha256").update(JSON.stringify(value)).digest("hex")
    const prior = this.#replies.get(key)
    if (prior) {
      if (prior.hash !== hash) return output(response, 409)
      return output(response, 200, { jsonrpc: "2.0", id: value.id, result: await prior.job })
    }
    if (this.#replies.size >= 512) return output(response, 429)
    const controller = new AbortController()
    const abort = () => {
      if (!response.writableFinished) controller.abort()
    }
    response.once("close", abort)
    this.#controllers.set(key, controller)
    const job = this.call(value.params, controller.signal).finally(() => {
      this.#controllers.delete(key)
      response.removeListener("close", abort)
    })
    this.#replies.set(key, { hash, job })
    return output(response, 200, { jsonrpc: "2.0", id: value.id, result: await job })
  }

  private async call(input: unknown, signal: AbortSignal) {
    try {
      if (this.#closed || !this.admission() || signal.aborted) throw new Failure("closed_or_revoked")
      if (!record(input) || typeof input.name !== "string" || !record(input.arguments))
        throw new Failure("invalid_request")
      const args = input.arguments
      const fields = Object.keys(args).sort().join()
      const result = await (() => {
        if (typeof input.name === "string" && input.name.startsWith("moods_"))
          return this.mood(input.name, args, fields, signal)
        if (input.name === "lights_read" && fields === "entity" && typeof args.entity === "string")
          return this.lights.state(args.entity, signal)
        if (
          input.name === "lights_set" &&
          [
            "entity,state",
            "brightness,entity,state",
            "entity,rgb_color,state",
            "brightness,entity,rgb_color,state",
          ].includes(fields) &&
          typeof args.entity === "string"
        )
          return (this.moods?.stop() ?? Promise.resolve()).then(() =>
            this.lights.set(
              args.entity as string,
              {
                state: args.state,
                ...(args.brightness === undefined ? {} : { brightness: args.brightness }),
                ...(args.rgb_color === undefined ? {} : { rgb_color: args.rgb_color }),
              },
              signal,
            ),
          )
        if (
          input.name === "lights_mode" &&
          ["mode", "action,mode"].includes(fields) &&
          typeof args.mode === "string" &&
          (args.action === undefined || args.action === "activate" || args.action === "stop")
        )
          return (this.moods?.stop() ?? Promise.resolve()).then(() =>
            this.lights.mode(args.mode as string, args.action === "stop" ? "stop" : "activate", signal),
          )
        throw new Failure("invalid_request")
      })()
      return { content: [{ type: "text", text: JSON.stringify(result) }] }
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              code: error instanceof Failure ? error.code : "operation_failed",
              uncertain: uncertain(error),
              notice: "Do not retry an uncertain action. Inspect the target in Home Assistant.",
            }),
          },
        ],
      }
    }
  }

  private mood(name: string, args: Record<string, unknown>, fields: string, signal: AbortSignal) {
    if (!this.moods) throw new Failure("invalid_request")
    if (name === "moods_list" && fields === "") return this.moods.list()
    if (
      name === "moods_save" &&
      ["mood", "mood,replace"].includes(fields) &&
      (args.replace === undefined || typeof args.replace === "boolean")
    )
      return this.moods.save(args.mood, args.replace ?? false)
    if (name === "moods_start" && fields === "name" && typeof args.name === "string")
      return this.moods.start(args.name, signal)
    if (name === "moods_stop" && fields === "") return this.moods.stop()
    throw new Failure("invalid_request")
  }

  dispose() {
    this.#closed = true
    for (const controller of this.#controllers.values()) controller.abort()
    this.#ending ??= (async () => {
      const owned = Promise.allSettled(
        this.owns
          ? [
              (async () => {
                const stopped = await Promise.allSettled(this.moods ? [this.moods.dispose()] : [])
                const closed = await Promise.allSettled([this.lights.dispose()])
                const errors = [...stopped, ...closed].flatMap((value) =>
                  value.status === "rejected" ? [value.reason] : [],
                )
                if (errors.length) throw new AggregateError(errors, "Home Assistant mood and light ownership retained")
              })(),
            ]
          : [],
      )
      const opening = await Promise.allSettled(this.#opening ? [this.#opening] : [])
      const closing = this.#server.listening
        ? new Promise<void>((resolve, reject) => {
            this.#server.close((error) => (error ? reject(error) : resolve()))
            this.#server.closeIdleConnections()
          })
        : Promise.resolve()
      const jobs = await Promise.allSettled([...this.#jobs, closing])
      const lights = await owned
      while (this.#jobs.size) await Promise.allSettled([...this.#jobs])
      const errors = [
        ...new Set([
          ...this.#failures,
          ...[...opening, ...jobs, ...lights].flatMap((value) => (value.status === "rejected" ? [value.reason] : [])),
        ]),
      ]
      this.#sessions.clear()
      if (errors.length === 1) throw errors[0]
      if (errors.length) throw new AggregateError(errors, "Home Assistant original closure failures retained")
    })()
    return this.#ending
  }
}
