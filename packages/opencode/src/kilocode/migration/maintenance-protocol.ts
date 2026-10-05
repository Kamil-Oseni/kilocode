import { createHmac, timingSafeEqual } from "node:crypto"
import path from "node:path"
import { z } from "zod"

const uuid = z.string().uuid()
const file = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value) && !value.includes("\0"))
export const request = z
  .object({
    format: z.literal("raya.maintenance-request"),
    version: z.literal(1),
    generation: uuid,
    id: uuid,
    roots: z
      .array(z.object({ kind: z.enum(["json", "sqlite"]), path: file }).strict())
      .min(1)
      .max(256),
    source: z
      .object({
        database: file,
        storage: file,
        data: file.optional(),
        preferences: z
          .object({ config: file.optional(), modelState: file.optional(), extensionState: file.optional() })
          .strict()
          .optional(),
        exports: file.optional(),
      })
      .strict(),
    password: z.string().min(12).max(1024),
  })
  .strict()
export const reply = z
  .object({
    format: z.literal("raya.maintenance-reply"),
    version: z.literal(1),
    generation: uuid,
    id: uuid,
    environment: z.object({ home: file, data: file, config: file, state: file, cache: file, database: file }).strict(),
    result: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), bundle: z.string() }).strict(),
      z
        .object({ ok: z.literal(false), reason: z.enum(["invalid-request", "coverage-incomplete", "capture-refused"]) })
        .strict(),
    ]),
  })
  .strict()

export function authenticate(value: unknown, secret: string, digest: string) {
  if (!/^[a-f0-9]{64}$/.test(secret) || !/^[a-f0-9]{64}$/.test(digest))
    throw new Error("Invalid maintenance channel authentication")
  const expected = createHmac("sha256", Buffer.from(secret, "hex")).update(JSON.stringify(value)).digest()
  if (!timingSafeEqual(expected, Buffer.from(digest, "hex")))
    throw new Error("Maintenance request authentication failed")
  return request.parse(value)
}

export function sign(value: unknown, secret: string) {
  return createHmac("sha256", Buffer.from(secret, "hex")).update(JSON.stringify(value)).digest("hex")
}
