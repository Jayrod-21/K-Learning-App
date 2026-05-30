# TESTS

> Source of truth for `/testcheck`. Every suite below is part of what
> "passes its tests" means for Korean Master. Add suites when you add a
> check that should run before declaring work done; remove only when the
> check moves to a different mechanism (CI, /fixpass, etc.).
>
> Lives next to the client because the client is where the suites run
> from. The project-root `TESTS.md` is a thin pointer to this file —
> when the server lane gets its own test suites, they will be added
> here (the resolver walks upward, so the file's position in
> `Repository/client/` is still discoverable from any subdirectory).

## Suites

- name: client-lint
  cmd: cd "Repository/client" && npm run lint
  must_pass: true

- name: client-build
  cmd: cd "Repository/client" && npm run build
  must_pass: true

- name: client-unit
  cmd: cd "Repository/client" && npm test
  must_pass: true

- name: server-typecheck
  cmd: cd "Repository/server" && npx tsc --noEmit
  must_pass: false

- name: server-tests
  cmd: cd "Repository/server" && npm test --silent --if-present
  must_pass: false

## Pass criteria

- Every `must_pass: true` suite exits 0.
- No `TODO(...)` left without a ticket or pass reference (e.g. `TODO(B7)`).
- No `any` in TypeScript outside generated files.

## Notes

- The server suites are `must_pass: false` until the server lane is
  re-engaged in Pass 3 — flipping them to `true` is part of the Pass 3
  exit criteria.
- `client-build` invokes `tsc -b && vite build`, so a strict-mode TS
  failure flunks the suite.
- `/testcheck --only client-lint,client-build` is the fast loop while
  iterating on a Pass.
- All `cmd` lines run from the project root (`/root/Jared/9b. Korean
  Master -- OVERNIGHT/`). The `cd "Repository/client"` prefix keeps
  the commands portable when the resolver invokes them from anywhere
  under the project tree.
