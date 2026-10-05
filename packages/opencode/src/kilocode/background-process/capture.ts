import path from "node:path"
import { readFile, rename } from "node:fs/promises"
import z from "zod"
import { canonical, image } from "../daemon/ownership"
import { watch } from "../daemon/exit"

const Image = z
  .object({ birth: z.string().regex(/^\d+$/), executable: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict()
export type Witness = z.infer<typeof Image>
const Ready = Image.extend({ version: z.literal(1), token: z.uuid(), pid: z.number().int().positive() }).strict()
const Retired = z
  .object({
    version: z.literal(1),
    token: z.uuid(),
    proof: z.literal("windows-job"),
    pid: z.number().int().positive(),
    birth: z.string(),
    controller: z.number().int().positive(),
    parentBirth: z.string(),
    empty: z.literal(true),
    forced: z.boolean(),
    code: z.number().int().nonnegative(),
  })
  .strict()

async function read(file: string) {
  const text = await readFile(file, "utf8")
  if (text.length > 16384) throw new Error("Background capture evidence exceeded limit")
  return JSON.parse(text) as unknown
}

/** A natural exact supervisor exit and retained native job handle proof are both mandatory. */
export async function retire(input: { pid: number; token: string; control: string; witness: Witness }) {
  const control = await canonical(input.control)
  const declared =
    process.platform === "win32" ? path.normalize(input.control).toLowerCase() : path.normalize(input.control)
  if (control !== declared) throw new Error("Background control root changed")
  const expected = Image.parse(input.witness)
  const actual = await image(input.pid)
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("Background native supervisor identity changed")
  const ready = Ready.parse(await read(`${control}.ready`))
  if (ready.token !== input.token) throw new Error("Background command admission identity changed")
  const observer = await watch(input.pid, expected.birth, 10000)
  const request = crypto.randomUUID()
  try {
    await Bun.write(`${control}.capture`, JSON.stringify({ version: 1, token: input.token, request }))
    const exited = await observer.done
    if (exited.code !== 0) throw new Error("Background supervisor did not complete clean native retirement")
    const native = Retired.parse(await read(`${control}.retired`))
    if (
      native.token !== input.token ||
      native.controller !== input.pid ||
      native.parentBirth !== expected.birth ||
      native.pid !== ready.pid ||
      native.birth !== ready.birth ||
      native.forced ||
      native.code !== 0
    )
      throw new Error("Background native tree retirement is forced or mismatched")
    const receipt = Object.freeze({
      version: 1 as const,
      request,
      token: input.token,
      supervisor: Object.freeze({ pid: input.pid, ...expected, exit: exited.code }),
      native: Object.freeze(native),
      forced: false as const,
      portableCaptureAuthorized: false as const,
    })
    const temp = `${control}.capture-closed.tmp`
    await Bun.write(temp, JSON.stringify(receipt))
    await rename(temp, `${control}.capture-closed`)
    return receipt
  } catch (err) {
    await Bun.write(
      `${control}.capture-uncertain`,
      JSON.stringify({
        version: 1,
        request,
        token: input.token,
        pid: input.pid,
        reason: err instanceof Error ? err.message : String(err),
        portableCaptureAuthorized: false,
      }),
    )
    throw err
  } finally {
    await observer.close()
  }
}
