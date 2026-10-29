import { randomUUID } from "node:crypto"
import { readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

/** Publish generated text atomically; failed staging files remain available for diagnosis. */
export async function write(file: string, source: string) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`)
  const bytes = Buffer.from(source, "utf8")
  await writeFile(temp, bytes, { flag: "wx" })
  await rename(temp, file)
  if (!(await readFile(file)).equals(bytes))
    throw new Error(`Generated file readback differs after publishing: ${file}`)
}
