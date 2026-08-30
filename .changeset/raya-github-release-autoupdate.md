---
"raya": minor
---

Distribute and auto-update Raya from GitHub Releases. Pushing a `raya-vX.Y.Z` tag now builds platform VSIXes and publishes them as a Release, and the extension periodically checks the configured repository for a newer release and offers to download and install the matching build. Configure it under the new `raya.update.*` settings, or run "Raya: Check for Updates" on demand.
