# Exact d6c control predecessor

The inert gzip file contains the original verified control bridge from d6c9a455a1a9022b82e058ad69fe1a93118d5441. Its uncompressed SHA-256 is `0c75ad3254fb85a0a187a6dfd69ebf3774ceaeb322eaa793a4e7de1b40993c85`. The bootstrap regression rechecks this hash, then loads it only in an isolated disposable child to reproduce its entries import failure. It sends no control operation, grants no authority, and publishes no notes. Compression timestamp is zero.
