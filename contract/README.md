# Huntaway status contract, version 1

What Huntaway reports to a front end (a dashboard, or your own tools) about **your own machines** and the **local
runs** placed on them. `huntaway status --json` emits this shape.

- **Schema:** [`huntaway-status.schema.json`](huntaway-status.schema.json) (JSON Schema 2020-12).
- **Samples:** [`fixtures/`](fixtures/), every one marked `"source": "fixture"`. A front end must never show fixture
  data as real.

## Rules

1. **Codes, not words.** Huntaway emits stable machine codes; the front end owns every label and translation.
2. **Aliases, never hosts.** A machine is its owner's short name for it: letters, digits, spaces, `_` and `-`, at
   most 32 characters, starting with a letter or digit and not ending with a space, so never a dotted hostname or an
   address (for example `Studio` or `My Mac mini`). Huntaway never puts a hostname, address, username or path it read
   from the system or the Router into a snapshot: an alias is only the name the owner chose. The pattern is anchored
   to the whole string: a validator whose `$` also matches before a trailing newline (Python's `re`, including
   schema-driven validators such as `jsonschema`, which apply `pattern` with `re.search`) must add its own full-match
   check. A run's `worker` is the alias its owner gave the machine it ran on.
3. **No content.** No prompt, answer, file name or file content appears. A run is its state and times only.
4. **Freshness is the front end's call.** Every snapshot carries `asOf`. When it goes stale, show "Status unknown";
   never guess a state from an old snapshot.

## Subscription rooms

`plenty`, `some`, `low`, `none` and `unknown`, as the schema describes, and (added 2026-09-30, minor change) `credits`:
the plan's allowance is spent, but the account keeps working on credits the fleet reports usable (Codex since
2026-09-29); `resetsAt` is when the plan's allowance returns.

- **Which window decides.** Only the windows that are spent decide, so `resetsAt` is the last of *their* resets. For
  example, a spent 5-hour window next to a weekly window at 60% gives the 5-hour reset. Codex can also refuse ordinary
  use before any percent reads 0 (a lagging reading); then the tightest window decides, the same way.
- **When credits count.** Every deciding window must be observed (not stale, not the fleet's own `exhausted` hold) and
  carry credits that are `usable`, with no spend control reached, and either unlimited or a positive balance. Otherwise
  the room is `none`.
- **Known limit.** How big the balance is does not change the room: one credit left shows `credits`, the same as
  sixty thousand.
- **Room codes a front end doesn't know** (this one and any added later): show them as `low`. The work may go on, on
  something limited.

## Run states

(Added 2026-09-30, minor change: `failed` and `uncertain`. Front ends that don't know a code map it by `status`.)

| `code` | `status` | Meaning (the front end words it) |
|---|---|---|
| `waiting_owner_ok` | `waiting` | Waiting for the owner's OK on their own device (Slack card). |
| `waiting_local_host` | `waiting` | Waiting for the machine in `worker` (e.g. "Waiting for your Studio"). |
| `running` | `active` | Running on `worker`. |
| `done` | `ended` | Finished on `worker`. |
| `cancelled` | `ended` | Stopped. |
| `declined` | `ended` | The owner tapped Cancel on the Run card. |
| `expired_not_run` | `ended` | Never ran; its request expired. |
| `failed` | `ended` | It ran and failed; nothing was answered. You can send it again. |
| `uncertain` | `ended` | It may have run (the answer was lost or the machine went away). Check before sending again; never retried automatically. |

`status` is a coarse bucket so an older front end degrades gracefully if a code is added later. `placement` is
`local` or `cloud`; `placedBy` says which setting decided (`conversation`, `folder`, `channel`, `default`); no model
ever chooses placement. `confirmUrl` is the deep link to the owner's own confirmation card.

## Subscription room

`room` turns real headroom into words: `plenty` (50% or more left), `some` (20–49%), `low` (1–19%), `none` (0% or
exhausted), `unknown` (the vendor offers no reading today, e.g. `gemini`). `resetsAt` is when it refills (UTC), or
`null` when unknown.

## Changing this contract

Adding an optional field or a new `code` is a minor change (front ends must ignore unknown fields and map an
unknown `code` by its `status`). Removing or renaming anything bumps `schemaVersion`.

## Standalone installs

A machine installed without the Router (`install-local.sh --standalone --alias NAME`) reports itself only:

- `machines` has exactly one entry: this machine, `online: true`, with `lastSeenAt` and the snapshot's `asOf` both
  the moment of the reading.
- `subscriptions` is `[]`, meaning **not tracked here** (there is no reading of subscription room without the
  Router), never "has none". Show it as "No reading".
- `alias` is always the owner's name for the machine; a standalone install without one refuses `status --json`
  rather than inventing a label.
