import path from "node:path"
import { lstat } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { check } from "../control/frames"
import { directory, image, normalize } from "../control/identity"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const ref = z
  .object({
    path: z.string().min(1).max(4096),
    bytes: z.number().int().min(0).max(65536),
    sha256: hash,
    tuple: z.string().min(1).max(256),
  })
  .strict()
const source = z
  .object({
    id: hash,
    path: z.string().min(1).max(4096),
    relative: z.string().min(1).max(4096),
    sha256: hash,
    bytes: z.number().int().positive().max(33554432),
    kind: z.enum(["image", "audio", "video"]),
    tuple: z.string().min(1).max(256),
    ignore: ref.nullable(),
  })
  .strict()

function pattern(value: string) {
  const parts = []
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (char === "*") {
      parts.push(".*")
      continue
    }
    if (char === "?") {
      parts.push(".")
      continue
    }
    if (char === "[") {
      const end = value.indexOf("]", index + 1)
      check(end > index + 1, "Unsupported media exclusion pattern")
      const content = value.slice(index + 1, end)
      check(!content.includes("\\") && !content.includes("["), "Unsupported media exclusion pattern")
      parts.push("[" + (content.startsWith("!") ? "^" + content.slice(1) : content) + "]")
      index = end
      continue
    }
    parts.push(char.replace(/[\\^$+?.()|{}\[\]]/g, "\\$&"))
  }
  return new RegExp("^" + parts.join("") + "$", "i")
}

async function exclusion(root: string, name: string) {
  const target = path.join(root, ".rayaignore")
  const exists = await lstat(target).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return false
      throw err
    },
  )
  if (!exists) return null
  const held = await image(target, 65536)
  const text = new TextDecoder("utf-8", { fatal: true }).decode(held.raw)
  for (const line of text.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("#"))) {
    const value = line.trim().toLowerCase()
    check(
      !(value.endsWith("/") ? name.toLowerCase().startsWith(value) : pattern(value).test(name)),
      "Selected media is excluded by .rayaignore",
    )
  }
  return { path: target, bytes: held.raw.length, sha256: held.digest, tuple: held.tuple }
}

function relative(root: string, file: string) {
  check(path.isAbsolute(root) && path.isAbsolute(file), "Explicit absolute media source and root required")
  const name = path.relative(root, file).replace(/\\/g, "/")
  check(name && !name.startsWith("../") && !path.isAbsolute(name), "Selected media escapes its approved source root")
  const reserved =
    /^(?:system|archive|\.git|health|medical|private|sensitive|credentials?|secrets?|tokens?|passwords?|output|outputs|dist|build|node_modules)$/i
  const devices = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
  const secrets = /(?:^|[-_.])(?:credentials?|secrets?|tokens?|passwords?|api[-_]?keys?)(?:$|[-_.])/i
  check(
    name
      .split("/")
      .every(
        (part) =>
          part &&
          ![".", ".."].includes(part) &&
          !/[<>:"|?*\x00-\x1f]/.test(part) &&
          !/[ .]$/.test(part) &&
          !part.startsWith(".") &&
          !reserved.test(path.parse(part).name) &&
          !secrets.test(path.parse(part).name) &&
          !devices.test(part.split(".")[0]),
      ),
    "Restricted media source path",
  )
  return name
}

function kind(file: string, raw: Buffer) {
  const ext = path.extname(file).toLowerCase()
  if (ext === ".png") {
    check(raw.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "Selected PNG signature differs")
    return "image" as const
  }
  if ([".jpg", ".jpeg"].includes(ext)) {
    check(raw[0] === 255 && raw[1] === 216 && raw[2] === 255, "Selected JPEG signature differs")
    return "image" as const
  }
  if (ext === ".wav") {
    check(
      raw.subarray(0, 4).toString("ascii") === "RIFF" && raw.subarray(8, 12).toString("ascii") === "WAVE",
      "Selected WAV signature differs",
    )
    return "audio" as const
  }
  if (ext === ".avi") {
    check(
      raw.subarray(0, 4).toString("ascii") === "RIFF" && raw.subarray(8, 12).toString("ascii") === "AVI ",
      "Selected AVI signature differs",
    )
    return "video" as const
  }
  check(
    ext === ".mp4" && raw.subarray(4, 8).toString("ascii") === "ftyp",
    "Only explicitly selected PNG, JPEG, WAV, AVI or MP4 files are supported",
  )
  return "video" as const
}

/** Inspect exactly one user-selected file. No directory enumeration or device capture. */
export async function select(root: string, file: string) {
  const name = relative(root, file)
  check(
    [".png", ".jpg", ".jpeg", ".wav", ".avi", ".mp4"].includes(path.extname(file).toLowerCase()),
    "Only explicitly selected PNG, JPEG, WAV, AVI or MP4 files are supported",
  )
  await directory(root)
  await directory(path.dirname(file))
  check(normalize(path.join(root, name)) === normalize(file), "Selected media source differs from its root")
  const ignore = await exclusion(root, name)
  const held = await image(file, 33554432)
  const value = source.parse({
    id: held.digest,
    path: path.resolve(file),
    relative: name,
    sha256: held.digest,
    bytes: held.raw.length,
    kind: kind(file, held.raw),
    tuple: held.tuple,
    ignore,
  })
  check(
    isDeepStrictEqual(await exclusion(root, name), ignore),
    "Media source exclusion policy changed during selection",
  )
  return Object.freeze(value)
}

/** Fresh bytes, file identity and existing exclusion policy must still match explicit approval. */
export async function verify(root: string, input: unknown) {
  const value = source.parse(input)
  const current = await select(root, value.path)
  check(isDeepStrictEqual(current, value), "Selected media source or exclusion policy changed; review again")
  return current
}
