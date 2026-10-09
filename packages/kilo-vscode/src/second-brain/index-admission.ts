import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { command } from "./control/command"
import { check } from "./control/frames"
import { directory, environment, image } from "./control/identity"
import { interpreter } from "./managed/catalog"
import type { Descriptor } from "./managed/descriptor"

const gib = 1073741824
const schema = z
  .object({
    format: z.literal("raya.memory.index.resources"),
    version: z.literal(1),
    physical: z.number().int().safe().positive(),
    free: z.number().int().safe().nonnegative(),
    commit: z.number().int().safe().positive(),
    available: z.number().int().safe().nonnegative(),
  })
  .strict()
const probe = `import ctypes,json,os
from ctypes import wintypes
if os.name != 'nt': raise RuntimeError('Windows index admission required')
class Memory(ctypes.Structure):
    _fields_=[('length',wintypes.DWORD),('load',wintypes.DWORD),('physical',ctypes.c_uint64),('free',ctypes.c_uint64),('commit',ctypes.c_uint64),('available',ctypes.c_uint64),('virtual',ctypes.c_uint64),('unused',ctypes.c_uint64),('extended',ctypes.c_uint64)]
row=Memory()
row.length=ctypes.sizeof(row)
api=ctypes.WinDLL('kernel32',use_last_error=True).GlobalMemoryStatusEx
api.argtypes=[ctypes.POINTER(Memory)]
api.restype=wintypes.BOOL
if not api(ctypes.byref(row)): raise ctypes.WinError(ctypes.get_last_error())
print(json.dumps(dict(format='raya.memory.index.resources',version=1,physical=row.physical,free=row.free,commit=row.commit,available=row.available),separators=(',',':')))
`

export class IndexUnavailable extends Error {
  constructor(free: number, available: number) {
    super(
      `Memory indexing needs at least 10 GiB free RAM and 5 GiB free commit. Available: ${(free / gib).toFixed(2)} GiB RAM and ${(available / gib).toFixed(2)} GiB commit. The saved note remains pending indexing; free memory before trying again.`,
    )
    this.name = "IndexUnavailable"
  }
}

/** Validate the actual native sample against the unchanged cold model and OS reserves. */
export function resources(raw: string) {
  check(Buffer.byteLength(raw, "utf8") <= 1024, "Memory index resource sample exceeded its bound")
  const row = schema.parse(JSON.parse(raw))
  check(row.free <= row.physical && row.available <= row.commit, "Memory index resource sample is inconsistent")
  if (row.free < 10 * gib || row.available < 5 * gib) throw new IndexUnavailable(row.free, row.available)
  return Object.freeze(row)
}

/** Read only: no model calls, settings changes, request publication or service launch. */
export async function admission(python: Descriptor["python"]) {
  check(process.platform === "win32", "Windows Memory index admission required")
  check(python.sha256 === interpreter, "Reviewed Memory index interpreter required")
  await directory(path.dirname(python.path))
  const held = await image(python.path, 16777216)
  check(held.raw.length === python.bytes && held.digest === python.sha256, "Memory index interpreter differs")
  const result = await command(
    python.path,
    ["-I", "-S", "-B", "-c", probe],
    { cwd: path.dirname(python.path), env: environment() },
    5000,
    1024,
  )
  check(result.stderr.length === 0, "Memory index resource observation reported a failure")
  check(isDeepStrictEqual(await image(python.path, 16777216), held), "Memory index interpreter changed")
  return resources(result.stdout)
}
