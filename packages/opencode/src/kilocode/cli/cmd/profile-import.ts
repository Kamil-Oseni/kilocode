import { cmd } from "../../../cli/cmd/cmd"

export const ProfileImportCommand = cmd({
  command: "profile-import <archive> <target>",
  describe: "import an encrypted profile into a fresh inactive container using private stdin",
  builder: (cli) =>
    cli
      .option("mapping", { type: "string", demandOption: true })
      .option("sha256", { type: "string", demandOption: true }),
  handler: () => {
    process.exitCode = 1
    process.stderr.write("Place profile-import first, before global options, to use its isolated importer.\n")
  },
})
