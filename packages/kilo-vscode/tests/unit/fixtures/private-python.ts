import path from "node:path"
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises"

/** Real disposable interpreter: unrelated packaging workers must not supply this test's ownership. */
export async function interpreter(dir: string) {
  const home = "D:/Raya/Services/Packaging/Python/3.12.14"
  const root = path.join(dir, "python")
  await mkdir(root)
  for (const name of (await readdir(home)).filter((name) => name.endsWith(".dll") || name === "python.exe"))
    await copyFile(path.join(home, name), path.join(root, name))
  await writeFile(
    path.join(root, "pyvenv.cfg"),
    `home = ${home}\ninclude-system-site-packages = false\nversion = 3.12.14\n`,
  )
  return path.join(root, "python.exe")
}
