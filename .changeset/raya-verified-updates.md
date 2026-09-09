---
"raya": patch
---

Require an exact supported-platform update asset and verify its declared size and SHA-256 digest before installation. Stage downloads separately, clean up after failures, and keep private update credentials off redirected download requests.

Check the downloaded VSIX's publisher, extension identity, version, and target platform before installation.

Remember pending installations across extension restarts and offer reload guidance when the requested version is not yet running.
