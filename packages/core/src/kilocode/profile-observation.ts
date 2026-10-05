import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import path from "node:path"
import z from "zod"

const schema = z
  .object({
    format: z.literal("raya.profile-root-observation"),
    version: z.literal(1),
    roots: z
      .array(z.object({ kind: z.enum(["sqlite", "json"]), path: z.string().min(1).max(32768) }).strict())
      .max(4096),
    inventory: z.string().regex(/^[a-f0-9]{64}$/),
    observation: z.enum(["participating-roots", "no-participating-roots"]),
    processLocal: z.literal(true),
    participantOnly: z.literal(true),
    cooperativeOnly: z.literal(true),
    completeProfileCoverage: z.literal(false),
    portableCaptureAuthorized: z.literal(false),
    portable: z.literal(false),
  })
  .strict()

export type Observation = Readonly<
  Omit<z.infer<typeof schema>, "roots"> & {
    roots: readonly Readonly<z.infer<typeof schema>["roots"][number]>[]
  }
>

const normalize = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)

/** Historical metadata is never a global-zero or complete capture certificate. */
export function parseObservation(raw: unknown): Observation {
  const value = schema.parse(raw)
  const keys = value.roots.map((root) => {
    if (!path.isAbsolute(root.path) || path.normalize(root.path) !== root.path)
      throw new Error("Profile observation root is not absolute and normalized")
    return `${root.kind}:${normalize(root.path)}`
  })
  const sorted = [...keys].sort()
  if (new Set(keys).size !== keys.length || keys.some((key, index) => key !== sorted[index]))
    throw new Error("Profile observation roots are not ordered and distinct")
  if ((value.observation === "no-participating-roots") !== (keys.length === 0))
    throw new Error("Profile observation root count changed")
  const inventory = createHash("sha256")
    .update(
      JSON.stringify(
        value.roots.map((root) => ({
          kind: root.kind,
          path: normalize(root.path),
        })),
      ),
    )
    .digest("hex")
  if (inventory !== value.inventory) throw new Error("Profile observation fingerprint changed")
  return Object.freeze({ ...value, roots: Object.freeze(value.roots.map((root) => Object.freeze(root))) })
}

async function canonical(file: string): Promise<string> {
  return realpath(file).catch(async (err: unknown) => {
    if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT") throw err
    const parent = path.dirname(file)
    if (parent === file) throw err
    return path.join(await canonical(parent), path.basename(file))
  })
}

/** Resolve only declared paths; never initialize Global, a database or any profile writer. */
export async function validateObservation(raw: unknown): Promise<Observation> {
  const value = parseObservation(raw)
  for (const root of value.roots) {
    if (normalize(await canonical(root.path)) !== normalize(root.path))
      throw new Error("Profile observation canonical root identity changed")
  }
  return value
}
