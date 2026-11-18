# Image pin review

This review reads commit `4135ab4`. It reads `deploy/start-api.mjs`, `deploy/start-api.test.mjs`, and `deploy/Dockerfile`. It also reads the server import path and the pin strings in the compiler wrapper and guest template. The pin files at worktree commit `e7d6aa6` match commit `4135ab4`. This review did not edit that tree.

## Result

No concrete issue.

The process entry reads five pin files from `/app/pins`. The exported root argument is for a test only. The image command runs that entry. The entry then imports the bundled server. The image writes the source revision, both digest files, the frontend reference, and the guest-builder reference before that command runs.

A conflicting operator value, a symlink, a hard link, a short file, a file over 512 bytes, and a malformed pin all fail closed. The digest result is the first 64 hex characters. The returned values omit service credentials. The failure text is `Image configuration rejected`.

The guest-builder reference matches the guest template. The frontend reference matches the compiler wrapper. The image hashes the wrapper file at the wrapper path into the wrapper pin. The entry sets that same path. Readiness still compares the native executable bytes with `ENGINE_SHA256`.

## Tests

`node --test deploy/start-api.test.mjs` passed 2 tests and failed 0. Node was v24.10.0.

A separate filesystem probe accepted the committed guest-builder reference and the committed frontend reference. It rejected a conflicting guest-builder value, a raw digest line, and an uppercase digest. It also rejected an unseparated extra digest, a leading backslash, a symlink, a hard link, and a pin file above 512 bytes. The returned values omitted the service credential. The failure stack omitted that credential and the digest path.

`process.loadEnvFile` kept an existing pin value. A direct real file path makes the entry guard match. The image command names `/app/deploy/start-api.mjs`.

## Limits

This review did not build an image. It did not run the API server, a compiler, a prover, a network client, a wallet, or a chain transaction. It did not edit the corpus, predicates, budgets, or gates.
