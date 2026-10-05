import { createHash } from "node:crypto"
import path from "node:path"
import z from "zod"

export const configScaffold = [
  "node_modules",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "bun.lock",
  "yarn.lock",
  ".gitignore",
  "agent-manager.json",
].join("\n")
const sum = (value: string) => createHash("sha256").update(value).digest("hex")
export const operationalPolicies = {
  "config-scaffold": {
    scope: "config",
    file: ".gitignore",
    omission: "regenerate-exact-config-scaffold",
    bytes: Buffer.byteLength(configScaffold),
    digest: sum(configScaffold),
  },
  "storage-migration": {
    scope: "storage",
    file: "migration",
    omission: "regenerate-completed-storage-marker",
    bytes: 1,
    digest: sum("2"),
  },
  "telemetry-identity": {
    scope: "data",
    file: "telemetry-id",
    omission: "privacy-reset-telemetry-identity",
    bytes: 36,
  },
  "legacy-diagnostics": { scope: "log", file: "dev.log", omission: "omit-sensitive-diagnostics" },
  "effect-diagnostics": { scope: "log", file: "opencode.log", omission: "omit-sensitive-diagnostics" },
  "ripgrep-cache": {
    scope: "bin",
    file: "ripgrep-15.1.0-x86_64-pc-windows-msvc.zip",
    omission: "redownload-pinned-utility-cache",
    bytes: 1810687,
    digest: "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a",
  },
  "ripgrep-executable": {
    scope: "bin",
    file: "rg.exe",
    omission: "redownload-pinned-utility-cache",
    bytes: 4266496,
    digest: "decdd4992f3f1b9a5ef9898f1b40ab16886d579d6516b4efd3d5eaa19364e408",
  },
} as const
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value) && !/[\0\r\n]/.test(value))
const key = (value: string) => (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value))
export const operationalEntry = z
  .object({
    namespace: z.union([z.literal("primary"), digest]),
    data: absolute,
    root: absolute,
    role: z.enum([
      "config-scaffold",
      "storage-migration",
      "telemetry-identity",
      "legacy-diagnostics",
      "effect-diagnostics",
      "ripgrep-cache",
      "ripgrep-executable",
    ]),
    source: absolute,
    dev: z.string().regex(/^\d+$/),
    ino: z.string().regex(/^\d+$/),
    bytes: z.number().int().safe().nonnegative().max(2_147_483_648),
    digest,
    omission: z.enum([
      "regenerate-exact-config-scaffold",
      "regenerate-completed-storage-marker",
      "privacy-reset-telemetry-identity",
      "omit-sensitive-diagnostics",
      "redownload-pinned-utility-cache",
    ]),
    rawBytesPreserved: z.literal(false),
    activation: z.literal("inert"),
  })
  .strict()
  .superRefine((value, ctx) => {
    const policy = operationalPolicies[value.role]
    if (
      value.omission !== policy.omission ||
      key(value.source) !== key(path.join(value.root, policy.file)) ||
      ("bytes" in policy && value.bytes !== policy.bytes) ||
      ("digest" in policy && value.digest !== policy.digest)
    )
      ctx.addIssue({ code: "custom", message: "Operational entry differs from its finite shipped policy" })
  })
export const operational = z
  .object({
    format: z.literal("raya.operational-omission-evidence"),
    version: z.literal(1),
    activation: z.literal("inert"),
    entries: z.array(operationalEntry).max(2000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      Buffer.byteLength(JSON.stringify(value)) > 2_097_152 ||
      new Set(value.entries.map((item) => key(item.source))).size !== value.entries.length
    )
      ctx.addIssue({ code: "custom", message: "Operational inventory exceeds bounds or repeats a source" })
  })
export const operationalPolicy = operationalEntry.safeExtend({
  kind: z.literal("operational-policy"),
  component: z.literal("operational"),
  componentDigest: digest,
})
export const operationalDigest = (value: z.output<typeof operational>) => sum(JSON.stringify(value))
