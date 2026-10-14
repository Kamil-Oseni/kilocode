# Exact 90c predecessor fixture

These inert gzip files preserve the original `capture.py`, `entries.py`, and `index.py` bytes from commit `90c612ae09f9611b0294d6d3681e25e2c04fa717`, at `packages/kilo-vscode/script/memory/service/`. They were extracted from that trusted Git object once and checked against the admitted 90c module hashes. Compression uses gzip level 9 with timestamp zero.

The runtime-upgrade test decompresses and rechecks these exact hashes, then writes the bytes only into its disposable previous-source directory to obtain actual native file metadata. It never imports or executes these old modules. Tests therefore do not require Git history or network access. Production upgrade admission still uses the complete exact catalog and native identity checks.

| Fixture | Uncompressed bytes | Uncompressed SHA-256 |
|---|---|---|
| `capture.py.gz` | 22937 | `b059c9bb84a176c86e5ff7b7e35b1470cba30fdfec5fb7dcdef4d829298b0dfe` |
| `entries.py.gz` | 8705 | `20b59cdc4a4ea3b5124ee81c0950ffbb6429ba05dcd6f0ac8d9d8656c2a13472` |

| `index.py.gz` | 53830 | `0bd829a079d6de51f1c8b6d80d3e466d8b093ed9e0b5862a6216db2566e1aa73` |
