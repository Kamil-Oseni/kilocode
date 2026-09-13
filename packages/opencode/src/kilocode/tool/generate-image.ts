// kilocode_change - new file
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import * as path from "path"
import { readFile } from "fs/promises"
import * as Tool from "../../tool/tool"
import * as Auth from "../../auth"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import * as Log from "@opencode-ai/core/util/log"
import { assertExternalDirectoryEffect } from "../../tool/external-directory"
import { Config } from "@/config/config"
import { KILO_OPENROUTER_BASE } from "@kilocode/kilo-gateway"
import DESCRIPTION from "./generate-image.txt"
import type { RayaGoal } from "@/kilocode/goal"

const log = Log.create({ service: "tool.generate_image" })

const KILO_OPENROUTER_URL = `${KILO_OPENROUTER_BASE}/chat/completions`
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

/** Fallback catalog used when the gateway is unreachable or the user is offline. */
export const FALLBACK_IMAGE_MODELS = [
  { value: "openrouter/auto", label: "Auto Router" },
  { value: "google/gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image" },
  { value: "google/gemini-3-pro-image-preview", label: "Gemini 3 Pro Image Preview" },
  { value: "openai/gpt-5-image", label: "GPT-5 Image" },
  { value: "openai/gpt-5-image-mini", label: "GPT-5 Image Mini" },
  { value: "black-forest-labs/flux.2-flex", label: "Black Forest Labs FLUX.2 Flex" },
  { value: "black-forest-labs/flux.2-pro", label: "Black Forest Labs FLUX.2 Pro" },
] as const

export const DEFAULT_MODEL = "openrouter/auto"

/** Kept for test compatibility. */
export const IMAGE_MODELS = FALLBACK_IMAGE_MODELS

export type ImageFormat = "png" | "jpeg"

export type ImageBilling = {
  id: string
  amount?: number
  source?: string
  reason?: string
}

export type ImageResponse = {
  format: ImageFormat
  base64: string
  billing?: ImageBilling
}

const DATA_URL_RE = /^data:image\/(png|jpeg|jpg);base64,(.+)$/

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function amount(value: unknown) {
  if (typeof value !== "number" && typeof value !== "string") return
  if (typeof value === "string" && !value.trim()) return
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1_000_000 ? parsed : undefined
}

export function parseImageBilling(value: unknown, provider: ResolvedProvider["provider"] = "openrouter") {
  const json = record(value)
  const usage = record(json?.usage)
  const details = record(usage?.cost_details)
  const upstream = amount(details?.upstream_inference_cost)
  const regular = amount(usage?.cost)
  const cost = provider === "kilo" && upstream !== undefined ? upstream : regular
  const raw =
    provider === "kilo" && details?.upstream_inference_cost !== undefined
      ? details.upstream_inference_cost
      : usage?.cost
  const id = typeof json?.id === "string" && json.id.trim() && json.id.length <= 200 ? json.id : undefined
  if (!id) return
  return {
    id,
    ...(cost === undefined ? {} : { amount: cost }),
    ...(cost === undefined
      ? {
          reason:
            raw === undefined
              ? "The image provider completed the request without reporting a billed amount."
              : "The image provider returned an invalid billed amount.",
        }
      : {
          source:
            provider === "kilo" && upstream !== undefined ? "usage.cost_details.upstream_inference_cost" : "usage.cost",
        }),
  } satisfies ImageBilling
}

export function parseImageResponse(
  body: string,
  provider: ResolvedProvider["provider"] = "openrouter",
): ImageResponse | null {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return null
  }
  const json = record(value)
  const choice = Array.isArray(json?.choices) ? record(json.choices[0]) : undefined
  const message = record(choice?.message)
  const image = Array.isArray(message?.images) ? record(message.images[0]) : undefined
  const url = record(image?.image_url)?.url
  if (typeof url !== "string") return null
  const m = url.match(DATA_URL_RE)
  if (!m) return null
  const format = (m[1] === "jpg" ? "jpeg" : m[1]) as ImageFormat
  const billing = parseImageBilling(json, provider)
  return {
    format,
    base64: m[2],
    ...(billing ? { billing } : {}),
  }
}

export function imageCharge(input: {
  billing: ImageBilling
  provider: ResolvedProvider["provider"]
  model: string
  sessionID: Tool.Context["sessionID"]
  messageID: Tool.Context["messageID"]
  callID?: string
  at: number
}): RayaGoal.Charge {
  const base = {
    id: `generate-image:${input.provider}:${input.billing.id}`,
    kind: "tool" as const,
    provider: input.provider,
    service: input.model,
    origin: {
      sessionID: input.sessionID,
      messageID: input.messageID,
      ...(input.callID ? { callID: input.callID } : {}),
    },
    at: input.at,
  }
  if (input.billing.amount !== undefined)
    return {
      ...base,
      coverage: "recorded",
      amount: input.billing.amount,
      currency: "USD",
      ...(input.billing.source ? { source: input.billing.source } : {}),
    }
  return {
    ...base,
    coverage: "unknown",
    reason: input.billing.reason ?? "The image provider completed the request without reporting a billed amount.",
  }
}

export type AuthInput = {
  type: "oauth" | "api"
  access?: string
  key?: string
  accountId?: string
}

export type ResolvedProvider = {
  url: string
  token: string
  provider: "kilo" | "openrouter"
  organizationId?: string
}

export function resolveProvider(
  auth: AuthInput | undefined,
  openRouterKey: string | undefined,
): ResolvedProvider | null {
  const token = auth?.type === "oauth" ? auth.access : auth?.type === "api" ? auth.key : undefined
  if (token) {
    return {
      url: KILO_OPENROUTER_URL,
      token,
      provider: "kilo",
      ...(auth?.type === "oauth" && auth.accountId ? { organizationId: auth.accountId } : {}),
    }
  }
  if (openRouterKey) {
    return { url: OPENROUTER_URL, token: openRouterKey, provider: "openrouter" }
  }
  return null
}

export function ensureExtension(relPath: string, format: ImageFormat): string {
  const ext = format === "jpeg" ? "jpg" : format
  const match = relPath.match(/\.([a-z]+)$/i)
  if (!match) return `${relPath}.${ext}`
  const existing = match[1].toLowerCase()
  const imageExts = ["png", "jpg", "jpeg"]
  if (!imageExts.includes(existing)) return `${relPath}.${ext}`
  const matches = ext === "jpg" ? ["jpg", "jpeg"] : ["png"]
  if (matches.includes(existing)) return relPath
  return `${relPath.slice(0, -match[0].length)}.${ext}`
}

type ResolvedRequest = { url: string; headers: Record<string, string>; body: string }

function buildRequest(resolved: ResolvedProvider, prompt: string, model: string, inputImage?: string): ResolvedRequest {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${resolved.token}`,
    "Content-Type": "application/json",
  }
  if (resolved.organizationId) headers["X-KILOCODE-ORGANIZATIONID"] = resolved.organizationId

  const content = inputImage
    ? [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: inputImage } },
      ]
    : prompt

  return {
    url: resolved.url,
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      modalities: ["image", "text"],
    }),
  }
}

const Parameters = Schema.Struct({
  prompt: Schema.String.annotate({ description: "Text description of the image to generate or the edits to apply" }),
  path: Schema.String.annotate({
    description: "Filesystem path (relative to the workspace) where the resulting image should be saved",
  }),
  image: Schema.optional(Schema.String).annotate({
    description:
      "Optional path (relative to the workspace) to an existing image to edit; supports PNG, JPG, JPEG, GIF, and WEBP",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Model ID to use for image generation. Omit to use the configured default.",
  }),
})

type Meta = {
  format?: ImageFormat
  filepath?: string
  provider?: "kilo" | "openrouter"
  error?: string
  rayaGoalCharge?: { version: 1; receipt: RayaGoal.Charge }
}

export const GenerateImageTool = Tool.define(
  "generate_image",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const authSvc = yield* Auth.Service
    const configSvc = yield* Config.Service
    const http = yield* HttpClient.HttpClient

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const auth = yield* authSvc.get("kilo")
          const authInput: AuthInput | undefined = auth
            ? {
                type: auth.type === "api" ? "api" : "oauth",
                ...(auth.type === "api" ? { key: auth.key } : {}),
                ...(auth.type === "oauth" ? { access: auth.access } : {}),
                ...(auth.type === "oauth" && auth.accountId ? { accountId: auth.accountId } : {}),
              }
            : undefined
          const resolved = resolveProvider(authInput, process.env["OPENROUTER_API_KEY"])
          if (!resolved) {
            return {
              title: "Image generation unavailable",
              output:
                "No image generation provider available. Log in to Kilo or set OPENROUTER_API_KEY, then try again.",
              metadata: { error: "no-provider" } as Meta,
            }
          }

          yield* ctx.metadata({
            title: `Generate image "${params.prompt.slice(0, 60)}"`,
            metadata: { provider: resolved.provider },
          })

          let inputImage: string | undefined
          if (params.image) {
            const imgPath = path.isAbsolute(params.image) ? params.image : path.join(instance.directory, params.image)
            yield* assertExternalDirectoryEffect(ctx, imgPath)
            const buf = yield* Effect.tryPromise(() => readFile(imgPath))
            const ext = path.extname(imgPath).slice(1).toLowerCase() || "png"
            const mime = ext === "jpg" ? "jpeg" : ext
            inputImage = `data:image/${mime};base64,${buf.toString("base64")}`
          }

          const cfg = yield* configSvc.get()
          const model = params.model ?? cfg.experimental?.image_generation_model ?? DEFAULT_MODEL
          const req = buildRequest(resolved, params.prompt, model, inputImage)

          const response = yield* http.execute(
            HttpClientRequest.post(req.url).pipe(
              HttpClientRequest.setHeaders(req.headers),
              HttpClientRequest.bodyText(req.body, "application/json"),
            ),
          )

          const status = response.status
          if (status < 200 || status >= 300) {
            const errText = yield* response.text
            log.warn("image generation failed", { status, errText: errText.slice(0, 200) })
            return {
              title: "Image generation failed",
              output: `Image generation request failed (HTTP ${status}).`,
              metadata: { provider: resolved.provider, error: "http-error" } as Meta,
            }
          }

          const text = yield* response.text
          const value = (() => {
            try {
              return JSON.parse(text) as unknown
            } catch {
              return undefined
            }
          })()
          const billing = parseImageBilling(value, resolved.provider)
          const charge = billing
            ? imageCharge({
                billing,
                provider: resolved.provider,
                model,
                sessionID: ctx.sessionID,
                messageID: ctx.messageID,
                callID: ctx.callID,
                at: Date.now(),
              })
            : undefined
          if (charge)
            yield* ctx.metadata({
              metadata: { provider: resolved.provider, rayaGoalCharge: { version: 1 as const, receipt: charge } },
            })
          const parsed = parseImageResponse(text, resolved.provider)
          if (!parsed) {
            return {
              title: "Image generation produced no image",
              output: "The model did not return an image. Try a different prompt or model.",
              metadata: {
                provider: resolved.provider,
                error: "no-image",
                ...(charge ? { rayaGoalCharge: { version: 1 as const, receipt: charge } } : {}),
              } as Meta,
            }
          }

          const finalPath = ensureExtension(params.path, parsed.format)
          const absPath = path.isAbsolute(finalPath) ? finalPath : path.join(instance.directory, finalPath)
          yield* assertExternalDirectoryEffect(ctx, absPath)
          yield* ctx.ask({
            permission: "write",
            patterns: [path.relative(instance.worktree, absPath)],
            always: ["*"],
            metadata: { filepath: absPath },
          })

          const buf = Buffer.from(parsed.base64, "base64")
          yield* fs.writeWithDirs(absPath, buf)

          return {
            title: path.relative(instance.worktree, absPath),
            output: `Image saved to ${finalPath}.`,
            metadata: {
              format: parsed.format,
              filepath: absPath,
              provider: resolved.provider,
              ...(charge ? { rayaGoalCharge: { version: 1 as const, receipt: charge } } : {}),
            } as Meta,
            attachments: [
              {
                type: "file" as const,
                mime: `image/${parsed.format}`,
                url: `file://${absPath}`,
                filename: path.basename(absPath),
              },
            ],
          }
        }).pipe(Effect.orDie),
    }
  }),
)
