import os from "node:os"
import path from "node:path"
import { realpath } from "node:fs/promises"
import { NativeProcess } from "./process-host"
import { digest } from "./file-digest"
import { assertImage, discover, recoverPending, registry, withImage } from "./source-offline"

type Pin = Readonly<{ executable: string; digest: string }>
type Observation = Awaited<ReturnType<typeof discover>>[number]
type Input = Omit<Parameters<typeof withImage>[0], "helper" | "registry">
const key = (value: string) => value.toLowerCase()
const same = (left: Observation, right: Observation) =>
  key(left.path) === key(right.path) &&
  left.exists === right.exists &&
  key(left.ancestor.path) === key(right.ancestor.path) &&
  left.ancestor.volume === right.ancestor.volume &&
  left.ancestor.index === right.ancestor.index

async function canonical(file: string): Promise<string> {
  return realpath(file).catch(async (err: unknown) => {
    if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT" || path.dirname(file) === file) throw err
    return path.join(await canonical(path.dirname(file)), path.basename(file))
  })
}

/** Native observations locate defaults; only the original live Image authorizes enrollment. */
export async function select(input: { env?: NodeJS.ProcessEnv; helper?: Pin; account?: string } = {}) {
  if (process.platform !== "win32") throw new Error("Offline native platform unsupported")
  const account = input.account ?? os.userInfo().homedir
  if (!path.isAbsolute(account) || path.normalize(account) !== account || /[\0\r\n]/.test(account))
    throw new Error("Offline selection account invalid")
  const folder = path.join(account, "AppData")
  const directory = path.join(folder, ".raya-offline-recovery")
  const executable = input.helper?.executable ?? (await NativeProcess.source())
  const helper = Object.freeze(input.helper ? { ...input.helper } : { executable, digest: await digest(executable) })
  const logical = registry(input.env)
  const resolved = await canonical(logical)
  const inputs = [...new Map([logical, resolved].map((value) => [key(value), value])).values()]
  const probe = async () => {
    const observations = structuredClone(await discover(inputs, helper))
    for (const left of observations)
      for (const right of observations)
        if (key(left.path) === key(right.path) && (!same(left, right) || left.entries !== right.entries))
          throw new Error("Offline selection legacy observations differ")
    return observations
  }
  const original = await probe()
  const receipts: Awaited<ReturnType<typeof recoverPending>>[number][] = []
  const paths = new Set<string>()
  for (const observation of original) {
    if (!observation.exists || paths.has(key(observation.path))) continue
    paths.add(key(observation.path))
    receipts.push(...(await recoverPending(observation.path, helper)))
  }
  const legacy = await probe()
  if (legacy.some((value, index) => !same(value, original[index]) || value.entries !== original[index].entries))
    throw new Error("Offline selection legacy registry changed")
  const [sample, parent] = await discover([directory, folder], helper)
  if (!parent.exists || key(parent.path) !== key(folder) || key(parent.ancestor.path) !== key(folder))
    throw new Error("Offline selection requires an existing canonical account AppData directory")
  if (key(sample.path) !== key(directory))
    throw new Error("Offline selection account registry aliases another namespace")
  const initial = structuredClone(sample)
  const base = structuredClone(parent)
  const anchored = async () => {
    const [value, parent] = await discover([directory, folder], helper)
    if (!same(parent, base)) throw new Error("Offline selection original ancestor changed")
    if (key(value.path) !== key(directory))
      throw new Error("Offline selection account registry aliases another namespace")
    return structuredClone(value)
  }
  const state = { leaf: initial.exists ? initial : undefined, active: false, failed: false, count: 0 }
  const check = async () => {
    const current = await probe()
    if (current.some((value, index) => !same(value, legacy[index]) || value.entries !== legacy[index].entries))
      throw new Error("Offline selection legacy registry changed")
    const value = await anchored()
    if (!same(value, state.leaf ?? initial)) throw new Error("Offline selection account registry changed")
  }
  return Object.freeze({
    directory,
    helper,
    receipts: Object.freeze(receipts),
    withImage: async <A>(opts: Input, body: Parameters<typeof withImage<A>>[1]): Promise<A> => {
      if (state.active || state.failed || state.count >= 2) throw new Error("Offline selection image lifetime refused")
      state.active = true
      state.count++
      const selected = structuredClone(opts)
      try {
        await check()
        return await withImage({ ...selected, helper, registry: directory }, async (image) => {
          const held = assertImage(image, selected.roots)
          if (key(path.dirname(held.control)) !== key(directory))
            throw new Error("Offline selection original image registry differs")
          const current = await anchored()
          assertImage(image, selected.roots)
          if (!current.exists) throw new Error("Offline selection held registry is absent")
          if (state.leaf && !same(current, state.leaf)) throw new Error("Offline selection account registry changed")
          state.leaf = current
          const value = await body(image)
          assertImage(image, selected.roots)
          await check()
          assertImage(image, selected.roots)
          return value
        })
      } catch (err) {
        state.failed = true
        throw err
      } finally {
        state.active = false
      }
    },
  })
}
