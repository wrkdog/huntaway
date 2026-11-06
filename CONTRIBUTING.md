# Contributing

Thank you for helping. You don't need any account beyond GitHub.

## Getting started

```sh
git clone https://github.com/wrkdog/huntaway.git
cd huntaway
npm test          # the huntaway command: Node 22.18 or later; there is nothing to install
cd pipe
npm ci            # the Pipe's dev tools only: TypeScript and Node's types
npm test && npm run typecheck
```

The tests never call a real API or a real provider CLI: they use local stand-ins. Before each release, the whole
suite is run on Ubuntu, where it passes.

On macOS, a few of the Pipe's tests depend on the host's file-protection features or SSH setup, and they are known to
fail there. In this release that is 19 failures reported by `npm test` (18 tests and the suite that holds 14 of them), all in
these four files:

- `pipe/test/pipe59-native-artifact-admission.lead.test.ts`: protected-folder admission (14 tests, plus their suite);
- `pipe/test/pipe59-native-observer.lead.test.ts`: one test;
- `pipe/test/pipe59-owner-user-observer.lead.test.ts`: one test;
- `pipe/test/u11-remote.test.ts`: remote install (two tests).

A failure anywhere else, or a different count in these files, is worth reporting.

## The rules every change keeps

- **Honest outcomes.** A finished run is `done`; `failed`, `declined` or `cancelled` when it certainly didn't run
  (refused, unreachable, or stopped before it was sent); or `uncertain` when it may have run. Never guess towards
  "didn't run".
- **The `huntaway` command never resends** a question on the owner's behalf.
- **The `huntaway` command keeps no question or answer text on disk,** and no key anywhere but the request header.
- **Plain, fixed error words:** never a path, a server's text or the question.
- **The Pipe runs only the official CLIs, each with its own account's login,** and never falls back to paid APIs.
- **No runtime dependencies.**
- **Tests first.** Every change comes with tests, and `npm test` passes on Node 22.18 and later (apart from the
  known macOS failures above).

## How to propose a change

For anything larger than a small fix, open an issue first so we can agree on the shape. Then send a pull request
with its tests. Report security issues privately, as in [SECURITY.md](SECURITY.md).

By contributing, you agree that your contribution is licensed under the Apache License 2.0, like the rest of the
project. A change to `openclaw/` is also licensed under MIT-0, so the skill can be published on ClawHub.
