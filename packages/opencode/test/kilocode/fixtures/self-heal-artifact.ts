import { ZipWriter, Uint8ArrayWriter, TextReader } from "@zip.js/zip.js"
import { hash, identity, type Build } from "@/kilocode/self-heal/build-input"

export async function archive(input: Build, mode: "valid" | "source" | "binary" | "target" | "duplicate" = "valid") {
  const writer = new ZipWriter(new Uint8ArrayWriter())
  const binary = "fixture CLI bytes"
  await writer.add(
    "extension/package.json",
    new TextReader(JSON.stringify({ name: "raya", publisher: "eden", version: input.extension })),
  )
  await writer.add(
    "extension.vsixmanifest",
    new TextReader(
      `<?xml version="1.0"?><PackageManifest><Metadata><Identity Id="raya" Publisher="eden" Version="${input.extension}" TargetPlatform="${mode === "target" ? "different" : input.target}" /></Metadata></PackageManifest>`,
    ),
  )
  await writer.add(
    "extension/dist/raya-build.json",
    new TextReader(
      JSON.stringify({
        ...identity(input),
        ...(mode === "source" ? { source: "wrong" } : {}),
        binary: { digest: hash(binary), size: binary.length },
      }),
    ),
  )
  await writer.add(
    `extension/bin/${input.target.startsWith("win32-") ? "kilo.exe" : "kilo"}`,
    new TextReader(mode === "binary" ? "changed bytes" : binary),
  )
  if (mode === "duplicate") await writer.add("extension/PACKAGE.json", new TextReader("{}"))
  await Bun.write(input.output, await writer.close())
}
