# pipe

pipe is a small local service that runs LLM work on **your own** Claude and Codex subscriptions. You send it a
request. It picks one of your accounts with room, runs the job through that provider's official CLI with that
account's own login, and returns the result with a record of what happened.

It is for one person's own accounts on one machine. It is not a way to share or resell subscriptions, and it never
falls back to paid APIs.

## What it does

- **It queues instead of failing.** A busy or limited account makes a request wait for one with room.
- **It never picks a model for you.** Every request names a model and an effort, and says why.
- **It keeps a record.** Every request and attempt is stored in a local SQLite file: which account ran it, on which
  model, how it ended, and where any changed files are.
- **It gives each account its own login.** Each account uses its own login folder, never the one your interactive CLI
  uses.

## Requirements

- macOS or Linux. It is developed on macOS, and its whole suite is run on Ubuntu before each release.
- The record (`storePath`) on a file system with hard links, such as APFS or ext4: its single-owner lock uses them.
- Node.js 22.18 or later. pipe runs its TypeScript directly and uses the built-in `node:sqlite`. It has no runtime
  dependencies.
- git, for work that changes files.
- The official CLIs for the providers you use:
  - `claude` (Claude Code), signed in with a Claude subscription;
  - `codex` (Codex CLI), signed in with a ChatGPT subscription.
- Claude Code's sandbox must be available, because Claude work that changes files runs inside it.

## Install

```bash
git clone https://github.com/wrkdog/huntaway.git
cd huntaway/pipe
npm ci   # dev tools only: TypeScript and Node's types, for the typecheck and tests
```

## Set up accounts

1. **Give each account its own login folder.** pipe refuses a CLI's default folder (`~/.claude`, `~/.codex`) so that
   jobs never share state with your own sessions. For example:

   ```bash
   mkdir -p ~/pipe-logins/claude-a ~/pipe-logins/codex-a
   CLAUDE_CONFIG_DIR=~/pipe-logins/claude-a claude auth login
   CODEX_HOME=~/pipe-logins/codex-a codex login
   ```

2. **Write a config.** Create the folders for pipe's data, then copy `config.example.json` and fill it in with
   absolute paths:

   ```bash
   mkdir -p ~/pipe-data/worktrees ~/pipe-data/work
   cp config.example.json ~/pipe-data/config.json
   ```

   Then edit `~/pipe-data/config.json` to match the example below. Every path must be absolute.

   ```json
   {
     "accounts": [
       { "id": "claude-a", "provider": "claude", "loginDir": "/absolute/path/to/pipe-logins/claude-a",
         "fingerprint": "00000000", "maxConcurrency": 2, "enabled": true },
       { "id": "codex-a", "provider": "codex", "loginDir": "/absolute/path/to/pipe-logins/codex-a",
         "fingerprint": "00000000", "maxConcurrency": 2, "enabled": true }
     ],
     "policy": {
       "claude": { "models": { "opus": "default", "fable": "hard" }, "efforts": ["low", "medium", "high", "xhigh", "max"] },
       "codex": { "models": { "gpt-6.1-sol": "default", "gpt-6-astra": "hard" }, "efforts": ["low", "medium", "high", "xhigh", "max", "ultra"] }
     },
     "storePath": "/absolute/path/to/pipe-data/pipe.sqlite",
     "worktreeRoot": "/absolute/path/to/pipe-data/worktrees",
     "workDir": "/absolute/path/to/pipe-data/work",
     "cli": { "claude": "claude", "codex": "codex" },
     "tokenFile": "/absolute/path/to/pipe-data/pipe.token",
     "port": 8123
   }
   ```

   - **`accounts`:**
     - `id` is your own name for the account.
     - `fingerprint` pins the login the folder must be signed in to. It is an 8-character hash: the first 8 hex
       characters of the SHA-256 of the login's id. If a folder reports any other login, the account is
       unavailable.
       - **Claude:** the id is the organization id that `claude auth status` reports, or the email if there is
         none. This prints the fingerprint for a signed-in folder:

         ```bash
         CLAUDE_CONFIG_DIR=~/pipe-logins/claude-a claude auth status | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d);console.log(require("node:crypto").createHash("sha256").update(s.orgId||s.email).digest("hex").slice(0,8))})'
         ```

       - **Codex:** the id is the ChatGPT account id, which only Codex's app-server reports. Start with a
         placeholder such as `00000000`, then copy the fingerprint `accounts` shows (step 3). `accounts` also
         confirms the Claude values.
     - `maxConcurrency` limits how many jobs run on the account at once.
     - `preference` (optional, a whole number from 0 to 100, default 0) chooses which account of a provider is
       used first. Among accounts with room, a higher preference is used first, whatever its load or headroom.
       Credit room still comes after every account with ordinary room. A pin ignores it.
   - **`policy`** lists the models and efforts each provider may run. It marks exactly one model per provider as
     `default`; the others are `hard`, kept for hard problems. Match it to what your CLIs offer: the `models`
     command shows the policy and Codex's official model list. Claude publishes no model list.
   - **`storePath`** is the record, **`worktreeRoot`** holds the worktrees for changing work, and **`workDir`** is where
     read-only jobs start when a request names no folder.
     Point `worktreeRoot` at a folder on a volume used only for Pipe work, for example
     `/absolute/path/to/work-volume/worktrees`. On macOS, turn Spotlight off for that volume, create
     `.metadata_never_index` and `.fseventsd/no_log` at its root, and exclude it from backups.
     Pipe never creates missing parents of `worktreeRoot` and refuses to start while its parent
     is missing (for example, an unmounted volume); configure the service manager to restart it.
     Only the final `worktreeRoot` folder is created on demand.
     Optionally set **`worktreeVolumeMarker`** to a plain file name such as `".pipe-work-volume"`
     and create that regular file in the parent of `worktreeRoot`. Startup and runtime checks require
     it to exist and refuse symlinks; this prevents a stale mount folder on the boot disk from receiving work.
     If a check finds a remounted device, a missing parent or a missing configured marker, Pipe logs once,
     drains running work and exits **75** (EX_TEMPFAIL). Configure the service manager to restart non-zero
     exits; startup retries refuse a still-missing parent or marker. A normal `pipe drain` still exits 0.
     A missing final root with its parent present, an unresponsive volume or a changed canonical path
     alone holds work without requesting a restart.
     When moving, list the old root in **`previousWorktreeRoots`**, for example
     `"previousWorktreeRoots": ["/absolute/path/to/old-volume/worktrees"]`. Pipe creates new worktrees only
     under `worktreeRoot`; old roots remain eligible for the same retention, safe saving and removal,
     listing and `pipe worktrees reset` operations. Keep each old volume mounted and its root configured
     until that root is empty, then remove its entry. Previous roots must be distinct absolute paths;
     none may overlap `worktreeRoot`, another previous root, `tmpRoot` or an explicitly configured `workDir`.
     None may equal or contain the store folder, store file, HOME or the defaulted `workDir`; roots below
     HOME or beside the store file are allowed. Aliases are checked through the nearest existing ancestor.
     Startup seals the canonical roots and protected locations; prune and saves reuse that proof. The
     canonical current root is cached for the process. Each prune pass processes current-root work first,
     then checks every previous root once with abortable reads. Missing roots are skipped for that pass;
     roots that return are validated again before admission. A standalone prune resolves previous roots
     once per pass and shares its proof with saves; standalone saves need location-bound proof to admit
     previous roots. Completion saves under the current root make no previous-root filesystem calls.
     Hang protection applies once a hang has been seen: while scans are pending, no further volume scan
     starts. Prune rechecks the gate per current-root candidate; previous-root candidates stay held for
     the rest of a pass that observed the gate.
     This protects in-process previous-volume reads before current work. A Git child (for example,
     `git worktree list`) may still stat other worktrees; the save deadline bounds that child.
     Case, firmlink and Unicode differences are not detected; string comparison fails safe by retaining
     work whose root membership cannot be proved. Unavailable or ignored previous roots appear in
     `unavailablePreviousRoots` with retained-record counts, and ignored roots include a `reason`;
     their records are skipped quietly. Other unresolvable or escaping paths remain `outside worktreeRoot`.
     Housekeeping pressure tiers measure and apply only on `worktreeRoot`'s volume (`st_dev`);
     on an APFS volume with a quota, the operating system's `statfs` reports the container's free space against that quota, so the tiers follow whichever is tighter;
     `report.tier` and `report.keepHours` describe that volume. Candidates on other or unproven volumes
     use normal configured retention without a 15-minute floor; a kept entry includes its applied
     `keepHours` when that differs from `report.keepHours`.
   - **`tmpRoot`** holds one scratch folder per attempt (default: `tmp` beside `storePath`). The pipe removes each
     folder after its attempt and clears folders of recorded ended attempts on restart.
   - **`worktreeKeepHours`** keeps finished changing worktrees for that many hours (default 72); after that, the pipe
     saves uncommitted work on the request branch and removes the worktree. **`pruneIntervalMs`** sets how often it
     checks (default 3,600,000). Use `pipe worktrees` to inspect them and `pipe prune` to run a pass now.
   - **`housekeeping`** defaults to `{ "batch": 100, "saveTimeoutMs": 120000, "removeTimeoutMs": 600000 }`. Passes process at most
     `batch` worktrees, least recently attempted first (never attempted first), then by finish time, and yield for dispatchable queued jobs. Each item's asynchronous scans and
     save share its save deadline; setup `statfs`, candidate `existsSync`, and synchronous stat calls are bounded only by the OS. A scan error releases
     that item. A deadline is `hung volume` only when the pending filesystem operation itself has been outstanding
     longer than `min(30000, floor(saveTimeoutMs / 2))` milliseconds (`saveTimeoutMs` must be at least 2000); it consumes no save strike and uses the non-strike delay ladder. A shorter pending
     operation is an ordinary save-timeout strike with backoff. After the first hang the pass touches no more of
     the volume, reports in-memory counts and `worktreeCount: null`, and later passes report `hung volume` without
     volume access until every abandoned scan settles and every unproven Git group is gone. This gate applies to the prune pass.
     The 30-second pressure check and `housekeepingStatus` also skip `worktreeDisk` while the gate is set;
     space is then unknown. Status exposes `gate.entries` and the oldest entry’s monotonic `gate.oldestAgeMs` (null when empty).
     Prune’s own Git calls, including its saves, prove group closure after normal success or failure and closed stdio;
     surviving groups receive SIGTERM, then SIGKILL escalation and proof within five seconds.
     A pass never returns before runGit's rejection; an unproven group ends the pass and pauses
     later passes until it is proven gone. A timer probes only `kill(-pgid, 0)` and clears the gate on ESRCH alone,
     before setup `statfs` can run again. Even a short abandoned scan blocks further scans in its pass;
     the item whose short scan timed out still consumes its ordinary timeout strike. All hung outcomes
     use kind `deferred`, reason `hung volume`; stored `partial-removal` and `retention` states stay visible. Removal has its own `removeTimeoutMs` limit and, once
     started, ignores the save deadline, Stop and drain. Pipe durably records `removing` with its time first;
     later passes never save a partial removal, reporting `partial-removal`: inspect; it may hold the
     only copy of late work. Reset does not clear this removal intent. Only exit code 128, without a signal
     or timeout, can clear the intent, after a deadline-bounded check proves the `.git` file, admin directory and
     admin `gitdir` file intact and every path in the pre-removal pinned `ls-files -z --cached` snapshot still exists;
     it backs off and the next eligible pass saves normally. Free volume space below
     15%, 8% and 3% caps retention at 12 h, 2 h and 15 minutes respectively. The 15-minute floor applies only to
     tier-shortened retention; configured `worktreeKeepHours` is honoured as given, including 0, and tiers never
     lengthen it. Worsening pressure triggers another pass, checked every 30 seconds,
     with five minutes between pressure starts and one pass at a time. Optional `tiers` replaces the thresholds:
     entries are `{ "below": 0.15, "keepHours": 12, "name": "pressure" }` (shares are fractions).
     Before saving, Pipe estimates each untracked non-ignored or modified tracked blob at size × 1.01 + 4,096 bytes.
     Every blob and tree is rounded to the destination common-directory volume’s `statfs` block size (at least 4,096 bytes).
     The estimate adds the current pinned index size (zero if absent), `62 + raw path name length` bytes per new index entry, rounded up to 8, and 1 MiB Git overhead. Each distinct
     ancestor directory of a changed or new path additionally costs a base 4,096 bytes plus its tree entries:
     28 + raw name length bytes per entry (40 + raw name length for SHA-256 repositories), rounded as one tree.
     Each ancestor is `lstat`-checked before descent or enumeration; missing or non-directory ancestors cost only
     the base allocation, since their removal rewrites a parent already counted. A tracked blob replaced by a directory
     counts as a deleted blob plus its new descendants and trees. Symlinks are never enumerated.
     Counts run under the item deadline; a failed count defers capacity, and a Git timeout spends a timeout strike. Saving requires that much free space plus
     `max(minFreeGb, 1)` GiB on Git's common-directory volume. The 1 GiB floor is a margin that absorbs misestimates and competing allocations, not a guarantee. Unknown space or a shortfall keeps kind `deferred-capacity` with no save.
     Unchanged `needs-archive` and `locked` items skip the batch gate until their 24 h retry using a persisted fingerprint of the pinned admin HEAD file,
     the top folder and `.git` file mtimes and sizes, and admin lock presence and mtime. For a branch the admin HEAD
     holds a ref, so new commits are caught by the 24 h retry. The common-directory cache holds only fulfilled values per owner per pass; failed lookups can retry, and every item awaits under its own signal. Unlock or another fingerprint change permits an immediate try.
     Resolving deep content inside a parked worktree takes effect at the 24 h retry, or at once with `reset`.
     Non-strike `unsaved` and `deferred-capacity` keeps persist a delay count: 1 min, 1 h, 6 h, then 24 h,
     checked before the batch gate. Removal and receipt failures also back off. A committed save clears save strikes before final classification,
     retaining the delay count until the whole save succeeds; a successful save or reset clears both; each processed workspace persists `lastAttemptAt`. Two save timeouts, deterministic Git failures or
     folder-walk EACCES/EPERM/ENOENT
     strikes mark a workspace `unsaveable`; ENOSPC, index locks and EBUSY do not consume strikes. An unsaveable
     worktree is kept without another scan until `pipe worktrees reset <id>` clears its strikes and backoff
     (authenticated `POST /v1/worktrees/<id>/reset`). Saves exclude nested repositories, refused `.gitmodules`
     symlinks and ignored `.scratch/**/pytest-tmp-*` / `pytest-cache`, recording the excluded path count.
   - **`housekeeping.regenerable`** may add exact disposable directory names to the baseline in `src/classify.ts`;
     it cannot remove baseline rules. Pipe lists ignored content with the repository's own ignore rules and
     `git ls-files -z --others --ignored --exclude-standard --directory`. An ignored entry may disappear only when
     the ignored directory itself, or an ignored ancestor directory, has an allowlisted name or matches the
     `.scratch` pytest rule. An ignored file in a tracked `build/` (such as `build/.env.production`) does not qualify
     merely because `build` is allowlisted. Non-ignored pytest scratch is saved normally. An ignored `node_modules/` tree qualifies; root `notes.txt` does not.
     Collapsed directory entries unconfirmed by `check-ignore` are re-listed without `--directory`;
     only non-regenerable or still-unconfirmed children keep the folder. At every walk depth, names that do not
     round-trip through UTF-8 keep the folder as `needs-archive` before a traversal path is built. Git pathname lists and
     `check-ignore` input/output remain bytes. Classification and saving use the same environment and ignore
     inputs; removal has no per-run `core.excludesFile`. Only saved worktrees without nested repositories or
     other ignored content are removed. Everything else stays.
     Each `kept[].reason` is human-readable text, unchanged for existing cases (for example,
     `repository folder missing <path>` or `a path uses a clean filter; save it by hand`).
     The separate `kept[].kind` class is `retention`, `unsaved`, `unsaveable`, `needs-archive`, `orphan`, `running`,
     `locked`, `deferred`, `deferred-capacity` or `partial-removal`; counts use `kind`, never reason text. There is no `detail` field.
     `needs-archive` means nested repositories or non-regenerable ignored content is kept.
     Health serves counts cached from the last pass plus a current space reading (unknown while the gate is set), with no worktree-root enumeration.
     `prune()` returns the in-flight pass when one is already running. `/v1/worktrees` calculates `dueAt`
     using tier-adjusted retention. Open requests are listed as `running`, failed items as `unsaved`.
     Completion saves run under one aggregate `saveTimeoutMs`.
   - **`housekeeping.archiveRoot`** is refused at startup: "archiving is not available in this version; remove
     housekeeping.archiveRoot". `housekeeping.archiveTimeoutMs` is also refused at startup. This version performs
     no archiving or quarantine, and has no archive timeout,
     archive backoff or archive receipts. Orphans are kept with kind `orphan`.
   - **`housekeeping.keepRecordsDays`** (default 90, from 32 to 3660) is how long ended requests and finished reviews
     stay in the record. Each housekeeping pass deletes up to 1,000 older ones in all, with their attempts and admission
     keys, while the clock is current. It skips the pass, and logs why once, while an outcome journal, failed-stop marker
     or outcome file from a stop waits for the next restart to replay it. It keeps anything still needed: a running
     review or one whose worktree could not be removed, with its seats; a request with an open attempt; a worktree the
     prune has not removed; the saved start of an open request; an attempt whose scratch folder exists, or every attempt
     while `tmpRoot` is missing; and every request while a review, its seats, a saved start or an open request cannot be
     read (also logged once). A lane's next review round continues from its highest round, kept in `lane_rounds` after
     the reviews themselves go. After that, `GET /v1/requests/<id>`, reviews and their receipts, and a reused
     idempotency key no longer find them; `/v1/stats` reads at most 31 days back.
   - **`housekeeping.logMaxMb`** (default 10, from 0 to 1024; 0 is off) caps the log file the service writes to through
     stdout or stderr, such as launchd's `StandardErrorPath`. Past the cap, each housekeeping pass trims it in place to
     its newest lines from a line start (at most half the cap), after one line saying so. Keeping the newest lines needs a
     descriptor it can read, as launchd's is; if it can only write, the trim keeps just that one line. The service never
     learns the file's name, so it keeps no rotated copy. The file must be opened for append, as launchd does, and written by the service
     alone; set 0 for a log other processes also write.
   - **`reviewGitTimeoutMs`** defaults to 120,000 milliseconds for review git operations; review
     worktree creation retains its independent 120,000 ms limit.
   - **`minFreeGb`** pauses new attempts when any data folder is below that many free GB (default 5; 0 disables the
     guard). Queued requests resume when space returns.
   - **`cli`** is each provider's command, resolved on `PATH` or given as an absolute path.
   - **`tokenFile`** holds the access token. pipe creates it, readable only by you, the first time it starts.
   - **`port`** is the local HTTP port. pipe listens on `127.0.0.1` only.
   - **`hostAlias`** optionally labels this executor, matching `^[A-Za-z][A-Za-z0-9-]{0,31}$` (for example `my-mac`). Missing or malformed values become `null`, never an inferred hostname. Each claim records the alias in dispatch evidence; cards preserve each attempt's executor and health shows the current service alias.
   - **Optional:** `pinWaitMs` sets how long a pinned request waits for an unavailable account (default 5 minutes).
     `maxAttempts` and `retryBackoffMs` tune retries.

3. **Start it and read what each folder reports.** `serve` runs in the foreground, so start it in one terminal and
   leave it running:

   ```bash
   node src/cli.ts serve --config /absolute/path/to/pipe-data/config.json
   ```

   In a second terminal:

   ```bash
   node src/cli.ts accounts --config /absolute/path/to/pipe-data/config.json
   ```

   `accounts` shows each account's identity (with its observed `fingerprint`), allowance and availability. Put each
   observed fingerprint into the config, then stop `serve` (Ctrl-C) and start it again.

## Use it

### The command line

`pipe --help`, `pipe help` and `<command> --help` (or `-h`) print usage without
reading configuration or acting. Unknown flags and extra positional arguments exit 2.
`--dry-run` previews `prune`, `drain`, `cancel`, `submit`, `review`, `review-vote`,
`recover`, `serve`, `remote install` and `lease take/renew/release` without executing them. HTTP previews are
JSON `{method,path,body}`; an absent body is `null`. Local operations report
`method: null`, `path: null`, their `operation` and arguments in `body`. Previews
may read configuration, a review brief or stdin, but never read the token file.

Every client command takes `--config` and reads the port and token file from it. Alternatively, set `PIPE_URL`
and `PIPE_TOKEN` in the environment. A shell function saves typing; it works in zsh and bash:

```bash
pipe() { node /path/to/pipe/src/cli.ts "$@" --config /absolute/path/to/pipe-data/config.json; }
pipe accounts                  # each account's login, allowance and availability
pipe models                    # the policy, and Codex's official model list
pipe submit < request.json     # prints {"request":{"id":"…","state":"queued",…}}
pipe list [--state S] [--requester R] # newest 500 matching requests, no prompt or result
pipe card <id>                 # content-free card with attempt hosts and save state
pipe stats --since 2026-10-13   # content-free per-UTC-day velocity statistics, kept on your machine
pipe status <id>               # one look at a request
pipe status <id> --selection   # narrow durable account/attempt/model/allowance receipt
pipe wait <id>                 # waits until completed, failed, cancelled or start_mismatch
pipe cancel <id> --by <name>   # cancels it, and records who did
pipe drain                     # finishes running jobs, then stops the service
```

### External account leases

Long-running sessions outside Pipe can reserve account load with `pipe lease take <account> --holder <h> --ttl <s> [--purpose <p>]`,
`pipe lease renew <id> [--ttl <s>]`, `pipe lease release <id>` and `pipe leases`. Renew defaults to 300 seconds.
The authenticated HTTP equivalents are `POST /v1/leases` with `{holder,account,ttlSeconds,purpose?}`,
`POST /v1/leases/:id/renew` with `{ttlSeconds}`, `POST /v1/leases/:id/release` and `GET /v1/leases`.
Take/renew/release return `{lease}`; listing returns `{leases}`. TTLs are integers from 60 to 3600 seconds.
Holders use 1–80 ASCII letters, digits, spaces or `._:@()/-`; purposes allow up to 200 Unicode code points without controls, format characters (including bidi controls), or lone surrogates.
Accounts must be configured and enabled. At most `maxConcurrency - 1` leases may be active per account;
exceeding that returns 409 `lease_limit`, keeping one slot for Pipe jobs. Take also checks jobs plus leases against
`maxConcurrency` atomically and returns 409 `account_full` when full. Renew returns 409 `account_unavailable`
if the account is disabled or its leases exceed a lowered cap. Leases count alongside jobs in placement;
`pipe accounts` keeps `running` jobs-only and adds `leases` with holder, purpose, start/expiry and initial headroom
(null when unknown). Account lease listings are null while Pipe's clock is uncertain. Lease routes work during drain.
Pipe has one owner bearer token: any bearer client can renew or release any lease; the holder label grants no ownership.

A launcher takes a lease, renews every TTL/3, then releases on exit. Failed renewals retry until the lease's own expiry;
only HTTP 404, HTTP 410 or reaching that expiry stops the lane. The example uses `curl` to distinguish HTTP status,
with `jq`, `PIPE_URL`/`PIPE_TOKEN`
and `CLAUDE_CONFIG_DIR` already set to the configured account's login folder:

```bash
ttl=300
receipt=$(pipe lease take claude-a --holder 'my lane lead' --ttl "$ttl" \
  --purpose 'lane lead') || exit 1
lease=$(jq -er '.lease.id' <<<"$receipt") || exit 1
lease_expiry() {
  jq -er '.lease.expiresAt | capture("^(?<s>[^.]+)(?<f>\\.[0-9]+)Z$") |
    ((.s + "Z" | fromdateiso8601) + (.f | tonumber)) | ceil'
}
expires=$(lease_expiry <<<"$receipt") || exit 1
lane= heartbeat=
cleanup() {
  trap - EXIT INT TERM
  [ -z "$heartbeat" ] || { kill "$heartbeat" 2>/dev/null; wait "$heartbeat" 2>/dev/null; }
  [ -z "$lane" ] || { kill "$lane" 2>/dev/null; wait "$lane" 2>/dev/null; }
  pipe lease release "$lease" >/dev/null || :
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
claude -p < lane-prompt.txt &
lane=$!
(
  sleep "$((ttl / 3))"
  while kill -0 "$lane" 2>/dev/null; do
    remaining=$((expires - $(date +%s)))
    [ "$remaining" -gt 0 ] || { kill "$lane"; exit 1; }
    reply=$(curl -sS --max-time "$remaining" -w '\n%{http_code}' \
      -H "Authorization: Bearer $PIPE_TOKEN" -H 'Content-Type: application/json' \
      -d "{\"ttlSeconds\":$ttl}" "${PIPE_URL%/}/v1/leases/$lease/renew") || reply=
    status=${reply##*$'\n'}
    delay=2
    case "$status" in
      200) next=$(lease_expiry <<<"${reply%$'\n'*}") && { expires=$next; delay=$((ttl / 3)); } ;;
      404|410) kill "$lane"; exit 1 ;;
    esac
    remaining=$((expires - $(date +%s)))
    [ "$remaining" -gt 0 ] || { kill "$lane"; exit 1; }
    [ "$delay" -le "$remaining" ] || delay=$remaining
    sleep "$delay"
  done
) &
heartbeat=$!
wait "$lane"
lane_status=$?
lane=
exit "$lane_status"
```

An expired lease cannot be renewed once a sweep has marked it. Every successful sweep marks expired leases,
starting at the first tick at or after expiry that successfully sweeps. Renewal needs a fresh heartbeat.
Renewal requires `now <= expires_at - LEASE_TICK_MS` (the tick interval, 1,000 ms by default); inside the final
tick it returns 410 `lease_inactive`. Take a new lease before restarting
the session. Take and renew return 400 `invalid_request` (`ttlSeconds must be at least 3 ticks`) when the
requested TTL is under three configured ticks. For any TTL of at least three ticks,
TTL − tick ≥ 2·TTL/3, so a launcher renewing every TTL/3 always has a second attempt inside the window.
Take and renew also require a successful sweep since service start,
no older than `max(LEASE_HEARTBEAT_MAX_AGE_MS (30,000 ms), 2 × tickMs)`; otherwise they return 503
`clock_unavailable`. The last successful sweep is tracked in memory and starts unknown after restart. Failed
or skipped sweeps and unrelated clock writes cannot refresh it. Every **successful** clock-current tick sweeps and
stamps the heartbeat, even with no expired leases and during drain. Renewal also refuses 503 when the clock is
behind its high-water mark or `now < renewed_at`.

Startup warns, without refusing to start, when `3 × tickMs > 60,000`, naming the refused TTLs.
If the operator restarts the service with a larger `tickMs`, an existing lease's routine renew can start
returning 400. A launcher must treat that 400 as "take a new lease with a longer TTL", not as fatal.
If `3 × tickMs` is above 3,600,000 ms, every allowed TTL is refused and leases cannot be used.
The TTL-tick check runs before the lease lookup, so with a slow tick a short TTL gets 400 even for an
unknown or released lease id.

Listings omit expired leases, but capacity keeps swept-expired rows as load for `LEASE_GRACE_MS` (60 seconds)
after expiry. Unswept rows retain load until swept. While the clock is uncertain, capacity counts unreleased
leases plus swept-expired rows whose expiry plus grace is later than the store's high-water mark. Reads never
stamp the clock. Explicit release frees load immediately and is idempotent. An uncertain clock skips the sweep;
a failed sweep logs `lease sweep` and the rest of the tick still runs. Released and expired records remain for
seven days; lease housekeeping runs independently of worktree pruning.

Known limit of these advisory load leases: a backward clock step landing after the last successful sweep
and before `expires_at − tick` can let a live holder renew a lease that a read already showed as gone. For example,
with a sweep at 58.5 seconds, an expiry read at 60 seconds and a rollback to 58.75 seconds, renewal still succeeds.
Placement never under-counts: every unreleased row always counts, including an unswept expired lease. Only the
active listing flickers. The larger heartbeat freshness window tolerates slow or skipped ticks and widens only
this harmless limit; the renewal-window margin remains one tick.

Worktree creation gets five minutes for jobs; synchronous review submission has a two-minute limit. A job setup that times out with its process group proved gone and nothing left behind is re-queued once after the back-off; a second setup timeout fails the request. The single retry fires only when `git worktree add` stalls before writing the worktree's `.git` file. A timeout during checkout keeps the partial worktree without retry, so most of the gain under load comes from the 300 s job limit. Review setup timeouts return 503 `setup_timeout`, with no inline cleanup; the periodic refresh cleans up.

If the service stops without recording how an attempt ended, `serve` refuses to start again until you settle it.
`pipe recover` lists the unsettled attempts. Settle each with `pipe recover --attempt <id> --outcome '<json>'`, or with
`pipe recover --attempt <id> --give-up`, which records that its outcome is unknown.

A request is a JSON object:

```json
{"requester":"my-session","project":"demo","kind":"chat","provider":"codex","model":"gpt-6.1-sol","effort":"low",
 "reason":"a one-word check needs only low effort","prompt":"Reply with the single word: ok","mutating":false,
 "priority":"interactive"}
```

Within one account preference, optional `"placement":"ordinary_headroom"` chooses the eligible account with the
greatest ordinary subscription headroom, then least load, then account ID. Headroom is the **bottleneck remaining fraction**
across applicable allowance buckets, not absolute or transferable tokens. This mode excludes synthetic
credit room, including Codex's 0.05 credit value. Omit it to keep ordinary-before-credit, least-load-first
placement under the existing credit policy. Other values (including null) are invalid. An explicit `pin`
still restricts selection to that account; it cannot promote credit, unknown, stale or unavailable room.

Authenticated `GET /v1/requests/:id/status` (CLI `status <id> --selection`; separate flag, no value) returns `{status:{id,state,selection,attempts}}`.
Each attempt contains `attemptId`, slot `accountId` (never a login), `provider`, `requestedModel`, nullable
`reportedModel`, `selectedAt`, and nullable `allowance`. Queued jobs have `selection:null`; previous attempts
remain in order. Running/terminal jobs select their latest original attempt, or null if none exists. Automatic
admission refusals also have null selection, even when earlier attempts remain in history.
The claim persists this binding before execution. Allowance is a narrow `claim_verdict` snapshot:
`{provenance,headroom,basis,evaluatedAt,observedAt:null}`, where basis is `ordinary` or `credits`.
`selectedAt` dates the claim; `evaluatedAt` dates the verdict, not the underlying provider observation.
Legacy/missing or invalid snapshots remain null; status never joins the current account view. The endpoint
excludes prompts, results, dispatch internals, credentials and fingerprints. Ordinary status/wait keep
their existing full request response. Status reads use a snapshot without taking the writer slot.

The opt-in automatic scratch profile (for tools that submit throwaway jobs and let the Pipe choose the route)
uses `provider:codex`, `model:gpt-6.1-sol`, `effort:high`, `placement:ordinary_headroom`, no pin,
and `automatic:{fallback:{provider:"claude",model:"opus",effort:"high",reason:"explicit fallback reason"},reviewReserve:0.1}`.
Both routes must pass policy. The existing planner and claim transaction admit one original ID immediately,
or terminally refuse exhausted/busy/unknown/reserve conditions with a known reset or null. Busy/unknown
Codex does not authorize Claude. The 10% floor is rechecked at claim/retry and supervised
through existing owned-runner stop/retention; periodic observations cannot reserve tokens or prevent overshoot.
`pipe capabilities` advertises `pipe-auto-v1`. Automatic full status includes the same-snapshot request and
selection, plus a separately evaluated current allowance or null. Its historical allowance includes the
retained reading time and verified/cache source; old missing observations stay null. Automatic intent
advances the record to version 3 so older engines refuse it. Ordinary-only records remain version 2.

| Field | Meaning |
| --- | --- |
| `requester`, `project` | Who is asking, and for what. Queue turns are shared fairly between requesters. |
| `kind` | `chat` for an answer, `code` for work in a repository, or `computer`. |
| `provider`, `model`, `effort` | Required choices, checked against `policy`. |
| `reason` | Why this model and effort fit the task; the record keeps it. |
| `prompt` | The whole brief. The request body may be at most 1 MiB. |
| `mutating` | `true` if the job may change files. It then needs `cwd`. |
| `priority` | `interactive` (the default) or `background`. Background work that has waited 30 minutes becomes interactive. |
| `cwd` | Optional for read-only work: an absolute folder where the job starts. |
| `pin`, `exclude` | Optional: run only on one account, or never on the listed ones. |

When a request ends, `request.result` holds the answer. A failure has `request.error.kind` and
`request.error.message`. While it waits, `request.waiting.reason` says why.

### Starting from an exact commit

Changing repository requests may optionally include `expectedStartCommit` in `pipe submit` JSON,
HTTP `POST /v1/requests`, or MCP `pipe_submit`. It must name the full lowercase hash of a retained,
clean Pipe-saved workspace's branch head in the authorized cwd repository, with its completed/closed
job receipt. Pipe verifies the effective Git root is that source, stores the binding, and rechecks it
before claim and before branching at the exact commit. `workspace.startCommit` records the actual origin. Missing or changed proof refuses, with no fallback.
Omitting the field keeps starting from the cwd's HEAD at execution time.

Alternatively, `pinnedStartCommit` requires the source cwd's HEAD at worktree creation to equal a full
lowercase 40- or 64-hex commit hash. It is changing-only, requires an existing absolute cwd, and cannot
be combined with `expectedStartCommit`. With `requireCleanStart: true`, staged, unstaged or untracked
source changes also refuse the job. Omission or false permits source dirt; it is never copied into the
new workspace. A mismatch ends as `start_mismatch` before workspace creation or worker startup, with
both requested and observed hashes in the full status error. It never retries. After the check, Pipe
branches from the pinned object even if catalog HEAD moves. Created workspaces report
`workspace.startCommit`; refused jobs keep `workspace: null`. Cards expose the fixed error kind and
finish time without the error message. Records containing pins require a version-4-capable engine.

### Admission keys and replay

`POST /v1/requests` (`pipe submit`) and `POST /v1/reviews` accept an optional non-empty
`idempotencyKey`. Keyless dedupe is opt-in by version: without an explicit key, the
caller must send `evidenceVersion` or `policyVersion` to enable it. With neither version and
no key, each call creates a new request or review, with no admission binding, reuse or conflict.
Explicit-key behavior is unchanged. For versioned keyless calls, Pipe hashes the JSON tuple `[repository, head, base, families,
briefSha256, evidenceVersion, policyVersion]`: repository falls back to repo/cwd or null,
head/base are lowercase full commit IDs or null, families are sorted unique provider families,
the brief is the submit prompt or review brief, and omitted versions are `unversioned`.
Keys are separate for requests and reviews and persist across restart. Explicit keys retain
their original binding. Keyless resends use the current execution's state and body fingerprint:

| Current execution | Same tuple and body | Same tuple, different non-tuple input |
| --- | --- | --- |
| Queued, running or completed | Reuse original ID/receipt | HTTP 409 `idempotency_conflict` |
| Setup-failed review with an active native child | Reuse original ID/receipt | HTTP 409 `idempotency_conflict` |
| Terminal failure, cancellation or setup failure after active work closes | New execution + `predecessorId` | New execution + `predecessorId` |
| No binding for the tuple | New execution | New execution |

A finished review with failed or invalid seats is a failed execution; a usable completed
review may have an APPROVE, REVISE or REJECT verdict. A setup-failed review stays reusable
while any native child is queued/running or has an open attempt; replacement is allowed only after that work closes. A cancelled request with
an open attempt is still closing and retains its binding until that attempt ends. Native child
records determine eligibility; cached native seat status is a projection only. Closed children
do not remain active before refresh updates that projection. A running review with submitted
seats and no active native child requires replacement, even with approved quorum
while worktree cleanup is pending.
Replacement atomically moves the key to the
new execution and retains the old record, attempts and receipt. A full-match replay still reuses the original if its
cwd has disappeared. New admissions validate cwd and saved-source proof before effects.
Conflicts also precede checkout and dispatch.
Review identity includes effective packet/contract hashes and inline versus configured packet
insertion. Review placement is excluded: execution keeps the first placement, while a replay
response reports the placement sent on that replay.

Submit and review replies add `admissionKey`, `dispatchClass`, `predecessorId` and `reuse`.
`predecessorId` names the failed execution replaced under the same computed key, when present;
replacement has `reuse: null` and borrows no review votes. Stored originals and
native review children retain their original class and GET returns `reuse: null`. Only the replay
response has class `repeat` and `reuse: {requestId, verdict, timeSavedMs}`. `requestId` names the
original request or review; submit verdict is null. Review verdict is APPROVE for approving
quorum, otherwise a recorded REJECT/REVISE, or null. Time saved is the original measured
creation-to-completion interval only for usable completed work; pending, failed, cancelled and
unusable review outcomes report null. It is never the elapsed time since replay.

`first` means no prior decision in scope. Requests scope history by repository/head/family and
prompt hash: a completed predecessor with unchanged base/evidence/policy permits `confirm`;
other predecessors produce `reassess`. Reviews scope by repository/head/family: a changed brief
after approval with unchanged base/evidence/policy is `confirm`; other prior decisions are
`reassess`. A new head starts `first`. For keyed rows, `GET /v1/requests` (`pipe list`) includes admission key,
stored class, predecessor ID (null when absent) and null reuse without prompts or results;
legacy unkeyed rows have no admission fields. The combined request and held-review list is limited to 500
rows, with requester filtering applied before limiting. Request/review GET retains the recorded predecessor ID.

The review capacity hook is off by default. With `E6_CAPACITY_HOOK: true`, configure a positive
integer `landing_rank_bound`. A review's positive integer `landing_rank` above that bound holds
its original ID without checkout or seats. List and review GET expose `queued-for-capacity`;
list rows for held reviews have null sequence/account IDs. External votes are refused while held.
Replaying the identical body with an explicit key or version at/below the bound (or omitting rank)
releases it once; advisory rank is excluded from identity. Turning the hook off lets periodic refresh release retained setup once, using
the accepted prompt and original placement. During drain or Stop, new review creation and every
review replay return HTTP 503 `admission_paused`; existing holds and private setup are retained.
A refresh-triggered release whose preparation is already in progress may still create its
checkout and seats during drain; its admission is already in progress.
The pause check precedes conflict lookup and Git preflight and is
repeated in the admission transaction. With the hook off, rank is ignored.

### Reviews

Submit an exact 40-character git commit object, an optional base commit object, a brief, and one to six Claude or Codex seats.
Each seat names a policy-approved provider, model and effort. pipe makes a clean detached worktree at the head and
runs Claude and Codex seats as read-only requests. The requester's checkout is untouched. The worktree is removed after all
seats finish; pipe never merges. A head or base naming a tag is refused.

```bash
pipe review --repo /absolute/path/to/repo --head <40-character-sha> --base <40-character-sha> \
  --brief review-brief.md --seat codex:gpt-6.1-sol:high --seat claude:opus:high \
  --reason "review this change" --repository example/repo --lane telemetry --project example-app
pipe review <review-id>
```

For ordinary subscription admission only, add `--placement ordinary_headroom` (HTTP/MCP:
`"placement":"ordinary_headroom"`). It is saved on the review and every Codex/Claude seat request;
the existing planner and claim guard exclude credit room and retain the restriction through retries
and restart. Other values are refused. Omission retains existing admission policy.

The optional `lane` field (`--lane <label>` in the CLI, `lane` in MCP `pipe_review`) is a non-empty string of
at most 80 characters. Reviews record `round`, starting at 1 for each exact repository/lane pair, including
failed setups; an omitted lane has a null round. Review reads include `lane`, `round`, and `setupFailed`.
Setup failure means preparation did not finish, including seats never submitted after interruption.

The HTTP equivalents are `POST /v1/reviews` and `GET /v1/reviews/:id`. The fixed seat prompt includes the full
head, the base diff when given, the brief verbatim and its SHA-256. It forbids edits and asks for exactly one JSON
object with `verdict` (`APPROVE`, `REVISE` or `REJECT`), `head`, `findings` (severity, file, line, summary) and
`unknowns`. A failed request or an invalid verdict is recorded in its seat and casts no vote. The review records
every requested seat before setup; an interrupted setup marks any unsubmitted seat failed with a reason. The worktree
is removed only once every seat's runner has ended, a cancelled one included. Removal is retried while the review runs.
A review reads the commits exactly as named (replace refs are ignored), and refuses a repository whose config binds
its worktrees to another checkout (`core.worktree`). Each seat sees the commit's own bytes: a file that an eol, ident or
encoding attribute would change refuses the review. After ten failures, it finishes with a top-level `cleanup` reason; votes
and the receipt remain readable during cleanup.

The receipt binds every vote to the full revision and brief hash. Only votes from contexts other than builder
contexts count. A family approves only if all of its counted votes say `APPROVE`. An approval needs both the OpenAI
and the Anthropic family approving. Only approved review models approve: Claude Opus 5.5 or Fable 5.1, and Sol 6.1 (`gpt-6.1-sol`) or
Astra (`gpt-6-astra`). The list is built in: a model joins or leaves only by a code change. A seat requested on any other model, such as Claude Sonnet 5, is refused. So is an external
vote whose reported model, or requested model when it reported `unknown`, is another. Model ids are matched
case-insensitively over ASCII. For Anthropic ids, a date comes before the `[1m]` context tag.
A seat whose alias resolved to a model off the list cannot approve: it shows as invalid, with the reason. That seat's
dissent counts whatever its model; an external vote off the list is refused, a dissent included. A building family may approve through a fresh
context.

An external reviewer can add a vote with `POST /v1/reviews/:id/votes`, or `pipe review-vote <review-id>` with one
JSON vote on stdin. The vote names its family, verdict, context, requested and reported models, ISO observation
time, full revision and brief SHA-256. External votes appear in the same receipt with `external: true`; they work
before or after local seats finish. pipe does not launch external provider sessions. A caller may validate the
receipt against its own rules.

### Project context packets and review output contracts

Two optional settings let a project give every model the same background and ask its reviewers for a richer answer.
Both are off unless configured, and they apply only to the project named; other projects see no change.

```json
"projects": {
  "example-app": {
    "contextPacket": { "path": "/absolute/path/to/CONTEXT-PACKET.md", "maxBytes": 16384 },
    "review": { "outputContract": { "path": "/absolute/path/to/REVIEW-OUTPUT-CONTRACT.md" } }
  }
}
```

- **Context packet.** For a changing job whose `project` names the project, and for every Claude and Codex seat of a
  review submitted with that `project` (`--project <name>` in the CLI, `project` over HTTP and MCP `pipe_review`), the
  service puts the file's text before the caller's text under a fixed header:
  `Project context for <project>, SHA-256 <hash>: …` then `BEGIN PROJECT CONTEXT` … `END PROJECT CONTEXT`.
  A caller whose own text already holds the exact configured packet text gets no second copy (so launchers that paste
  it do not double it), and a blank prompt is refused as before (the packet is background, not a task). Read-only jobs outside a review
  are unchanged.
- **Output contract.** In that project's Claude and Codex review seats, the file's text follows the service's own
  answer schema, between `BEGIN OUTPUT CONTRACT, SHA-256 <hash>` and `END OUTPUT CONTRACT`, with a line saying the
  contract's keys are additive to `{verdict, head, findings, unknowns}` and that the service reads only `verdict` and
  `head`. Placing it last is the point: a contract inside the brief is overridden by the schema line that follows it.
  Verdicts, the last-JSON-object rule, the receipt and the quorum are unchanged, so extra keys never change a vote.

Each file is read when it is used, so an edit reaches the next job or review without a restart. A missing, empty,
non-regular, blank, oversized (`maxBytes`, default 65,536, at most 262,144) or invalid UTF-8 file refuses the job or review
with an error that names the project and path, before anything is stored. A read stops at `maxBytes` + 1 bytes even
if the file grows meanwhile, and the text is sent exactly as read (a byte-order mark is kept), so its SHA-256 names
it. As before, a review whose seat prompt would pass the store's 1 MiB request limit fails its setup (recorded with
`setupFailed`) without submitting a seat. A malformed `projects` setting stops `serve` at startup.
A changing job records `contextPacketSha256`; a review records `project`, `contextPacketSha256` and
`outputContractSha256`, and each of its seat requests records `contextPacketSha256`, so a receipt can cite exactly
what the Claude and Codex seats saw. Clients cannot set `contextPacketSha256` themselves. Older engines ignore the new
hash field.

There are two ways to opt in, and a hint points at both:

- **Per project (durable).** The `projects` setting above applies to every matching job and review.
- **Per call.** `contextPacket` (changing jobs and reviews) and `outputContract` (reviews) take inline text on
  `POST /v1/requests`, `POST /v1/reviews`, MCP `pipe_submit` / `pipe_review`, and `pipe submit`'s JSON;
  `pipe review --context-packet <file> --output-contract <file>` reads local files as strict UTF-8 (a BOM and CRLF are
  kept). Per-call text replaces the project's file for that request only, is always added under its header, and is
  recorded by its hash like a file; it must be non-empty, well-formed and at most 262,144 UTF-8 bytes, and needs a
  Claude or Codex seat in a review. A record keeps only the hash, not whether the text came from the config or the
  call: compare it with the file's hash to tell. MCP takes text, not paths: an MCP client that read files
  for its caller would let a sandboxed agent read outside its sandbox.
- **The hint.** A changing job, or a review with a Claude or Codex seat, whose project sets neither text and that sends neither per call, gets a
  one-line `hint` field next to its result (MCP `pipe_review` and `pipe_submit` pass it on), once per project per
  service start. It never blocks or changes a request; refused and read-only requests do not use it up.
- **What is configured.** `GET /v1/capabilities` (CLI `pipe capabilities`, MCP `pipe_capabilities`) lists each
  configured project with `contextPacket` and `outputContract` booleans, never a path. A request's own status read
  shows `contextPacketSha256`; a review's shows `project`, `contextPacketSha256` and `outputContractSha256`.

### Velocity statistics (kept on your machine)

`pipe stats --since YYYY-MM-DD` returns the same JSON as `GET /v1/stats?since=YYYY-MM-DD`. The date is required,
inclusive, and must be a real calendar date no more than 31 days before the service's current UTC day
(invalid or older dates return HTTP 400). Days with submissions appear in
ascending UTC order, grouped by submission day. Counts include changing build requests and reviews, including
queued or failed work. Wait samples run from submission to the first attempt; unstarted builds have no sample.
Line samples are insertions plus deletions from saved builds. Median averages the middle pair for even samples;
P90 uses nearest rank. Missing samples and a missing maximum round are null; missing counts are zero.
Stored rounds and diff counts must be integers from zero through 2^53−1. Unsafe samples, including line totals
above that bound, are omitted for that measure without losing the record's other counts.

```json
{"days":[{"day":"2026-10-14","builds":{"count":1,"waitMedianSec":0.5,"waitP90Sec":0.5,"linesMedian":3,"linesP90":3},"reviews":{"count":2,"approved":1,"revise":1,"setupFailed":0,"seatFailed":0,"roundMax":2}}]}
```

`approved` counts recorded approving quorums; `revise` counts reviews with a REVISE vote. `setupFailed` counts
failed preparation, including historical never-submitted placeholders and seats failed by submission cleanup.
New seats record `setupCancelled` explicitly; the submission-failed reason is a fallback only for older seats
without that marker, so an operator cancellation using the same prose does not imply failed preparation.
`seatFailed` counts reviews with a submitted seat that failed, excluding every setup-failed review.
Stats contain no prompt, result, brief, or path. Build selection uses a date-range partial index without
parsing request bodies at read time. The review repository/lane expression index still parses the review body
on writes; changing it to stored columns requires a separate schema migration.
The first start with these indexes builds them inside the startup transaction, scanning existing request and
review bodies once. This can delay startup for a large store; later starts reuse the indexes.

Saved workspaces record `workspace.diff = { files, insertions, deletions }` from the owned start commit to the
saved commit. Binary files count as one file and zero lines; `no_changes` records three zeros. A failed measurement
leaves the diff absent without failing the save. Job cards expose only these three counts as `saved.diff`, or null
when unknown. Old saved builds without measurements contribute no line sample.
Legacy `no_changes` builds without a stored diff show zeros on their cards, but contribute no stats line sample;
new `no_changes` builds store zeros and contribute a zero sample.

### MCP

`node src/mcp.ts` is a stdio MCP server with `pipe_submit`, `pipe_status`, `pipe_wait`, `pipe_cancel`,
`pipe_card`, `pipe_list`, `pipe_accounts`, `pipe_models`, `pipe_capabilities`, `pipe_review` and `pipe_review_status`. It needs `PIPE_URL` and `PIPE_TOKEN`. To keep the token out of your MCP client's
config, start the server with a small launcher that reads the token file:

```bash
#!/bin/sh
export PIPE_URL=http://127.0.0.1:8123
PIPE_TOKEN="$(cat /absolute/path/to/pipe-data/pipe.token)"; export PIPE_TOKEN
exec node /path/to/pipe/src/mcp.ts
```

Then register it for every folder, for example with `claude mcp add --scope user pipe -- /path/to/pipe-mcp`. Without
`--scope user`, Claude Code registers it for the current folder only, and `huntaway ask --engine pipe` doesn't find it
when `HUNTAWAY_PIPE_CMD` is unset. For a server registered for one folder only, or when Claude Code's config lives
elsewhere (`CLAUDE_CONFIG_DIR`), set `HUNTAWAY_PIPE_CMD` to a JSON array with the `pipe-mcp` command instead.

- Set `requester` and `project` in `pipe_submit` yourself. Otherwise the server records `mcp` and `default`.
- `pipe_submit` accepts optional `placement: "ordinary_headroom"` for ordinary subscription admission, excluding credit room. Omission keeps existing spreading and credit policy; this is not a full-run billing guarantee.
- `pipe_status` with `{ "id": "original-job-id", "selection": true }` reads the existing content-free selection receipt. Omitted or false `selection` returns the record and its result with the prompt replaced by `promptBytes` and `promptSha256`, unless `includePrompt: true`; `pipe_wait` does the same.
- `pipe_card` with `{ "id": "original-job-id" }` (CLI `pipe card <id>`) reads current state, attempt account aliases, recorded executor `host` (null for older attempts) and save state. `startCommit` is the recorded workspace base or null; `saved.commit` is present only for `saved`, so `no_changes` retains its base through `startCommit`. Test/review/backup proof is null. Neither narrow tool includes prompt, result, credentials, fingerprints or internal saved-source paths.
- `pipe_list` accepts optional string `state` and `requester` filters and returns exactly the content-free `GET /v1/requests` body, like CLI `pipe list`. Both filters apply before the newest-first 500-row cap; the complete list is returned without MCP truncation.
- `pipe_wait` waits 60 seconds by default and 600 at most, so call it again while a job runs.

### Use it from another Mac

With pipe running on this Mac, install its SSH entry point:

```bash
pipe remote install --config /path/to/config.json
```

The command prints JSON containing an `mcp` object. Paste that object into the other Mac's MCP client settings and
replace `<this host>` with this Mac's SSH host name. The client connects with `ssh -T` and runs
`<home>/.local/share/pipe/pipe-mcp` here by its absolute path. The service still listens only on `127.0.0.1`;
the token stays on this Mac, and jobs run here. SSH must already be configured for the other Mac to log in.

The installer keeps the launcher, small MCP client, and owner-only token copy under `~/.local/share/pipe`.
It does not create `~/.local/bin`. macOS can deny SSH sessions access to external volumes, so the launcher does not
depend on the repository's location. It uses the absolute path of the current Node; use
`--node /absolute/path/to/node` if needed. Run the install again after upgrading pipe to refresh the client copy and
launcher.

See [Security model](#security-model) for the install path's trust boundary.

## Run it as a service (optional)

On macOS, launchd can start it as below. On Linux, run `serve` under your own service manager instead, for example a
systemd user service.

To start pipe at login and restart it after a crash, add a LaunchAgent at
`~/Library/LaunchAgents/com.example.pipe.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.example.pipe</string>
  <key>ProgramArguments</key><array>
    <string>/opt/homebrew/bin/node</string><string>/path/to/pipe/src/cli.ts</string>
    <string>serve</string><string>--config</string><string>/absolute/path/to/pipe-data/config.json</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardErrorPath</key><string>/absolute/path/to/logs/pipe.log</string>
</dict></plist>
```

- Load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.pipe.plist`.
- Keep the log path on your home disk: launchd may be unable to open files on an external volume.
- launchd starts services with a minimal `PATH`. Give `cli` absolute paths, and put the folders of `node`, `claude`,
  `codex` and `git` in the plist's `EnvironmentVariables` `PATH`. A config `env`, if set, replaces the whole
  environment that pipe passes to the CLIs, so don't use it just for `PATH`.
- To upgrade, run `pipe drain` (the shell function above) first. It lets running jobs finish, then stops the service without a restart. Then
  start it again with `launchctl kickstart gui/$(id -u)/com.example.pipe`.

## What it promises

- **Before a job starts, a busy or limited account makes the request wait rather than fail.** The request waits for an
  account with room.
- **A limit the provider stops reporting stops counting after three readings over thirty minutes.** A job's own
  limit on it stays in force until its reset, or, if it stated none, for the resetless wait (thirty minutes).
- **Once it has started, a limit can still end it.** Work that changes files fails and is never re-run, so inspect its
  worktree before you resubmit. If sign-in or a limit fails before any tool call and the worktree is untouched, the
  changing request waits and runs again. Read-only work waits again; both kinds fail after 20 such failures.
- **The job runs on the model you chose, or it fails.** A mismatch is never recorded as a success.
- **Work that changes files runs in its own git worktree of `cwd`'s repository**, on a `pipe/…` branch. The record's
  `workspace` names the path, the branch and the commit. The builder usually leaves its changes uncommitted. The
  pipe's own git commands have deadlines, stop with the attempt, and run no repository hooks or fsmonitor; the job's
  CLI still runs in the worktree normally.
  - A finished request's worktree is kept for `worktreeKeepHours` (72 by default). Then any uncommitted work is
    committed on its branch, and the worktree folder is removed; the branch stays.
    Saves use one `git add -A` with the status call's `.` and literal exclusion pathspecs, keeping pathspec magic enabled. Tracked files under ignored directories are staged, ignored untracked files are not added, and excluded roots stay out; non-regenerable ignored untracked content still keeps the folder as `needs-archive`.
  - **Ignored content keeps the folder unless it is regenerable.** The ignored directory itself or an ignored
    ancestor must have an allowlisted name (or match the `.scratch` pytest rule). Ignored `node_modules/` qualifies;
    `notes.txt` and `build/.env.production` in a tracked `build/` do not. Nested repositories always keep the folder, including `.hg`, `.svn`, `.sl`, `.bzr`, `_darcs`,
    `.fslckout` and `_FOSSIL_` markers at any depth, even below regenerable roots.
  - **Housekeeping threat model:** retained worktrees are Pipe-owned job sandboxes. Before removal, the runner's
    process group has closure proof; `service.ts` records the runner synchronously through `onSpawn`. Tier-shortened
    retention has a 15-minute floor, bounded by configured `worktreeKeepHours`, which is honoured as given including 0.
    A non-Pipe process (an editor or a hand-started daemon) writing new ignored,
    non-regenerable files during the durable `removing` write, the final `excludedPaths` walk,
    `ls-files`, `check-ignore` and the spawn of `remove` is out of model.
    Removal without `--force` still refuses tracked changes and untracked non-ignored files at removal time,
    with `status.showUntrackedFiles=all` forced even when repository config hides them. Pinned status, add, diff
    and removal also force `core.trustctime=true` and `core.checkStat=default`, including removal's child status.
    On macOS the final walk refuses a non-empty resource fork on any regular file outside a regenerable root,
    including tracked files, keeping kind `needs-archive` with reason `resource fork on <rel path>`.
    On macOS the final walk also lists xattr names on every regular file, directory and symlink outside regenerable
    roots, using `/usr/bin/xattr` with explicit paths in batches of at most 200, the item deadline and a 1 MiB
    output cap. Only `com.apple.provenance`, `com.apple.quarantine`, `com.apple.lastuseddate#PS` and `com.apple.macl`
    are ignorable. Any other name keeps kind `needs-archive`, reason `extended attribute <name> on <rel path>`.
    A supplied batch path containing `: ` or a newline is not listable and keeps kind `needs-archive`.
    Any attribute name containing `: ` also keeps the folder. Output lines must match a supplied path followed by `: `;
    unmatched output keeps kind `needs-archive`. Non-empty stderr, even on exit 0, spawn failure, timeout or
    oversized output keeps kind `unsaved` with non-strike backoff. Attributes are not archived.
    Write exclusion cannot be enforced by permissions on a worktree volume with ownership disabled (common for external
    drives on macOS), where modes are ignored. Anything that cannot be classified as saved or regenerable is kept. Lock a worktree you
    are still using (`git worktree lock`) to keep it.
  - **Known limits:**
    - Git text conversions (`autocrlf`, `text`/`eol`, `ident` and `working-tree-encoding`) apply as Git applies them.
      Pipe can't tell a `.gitattributes` the job wrote from the owner's own, so it honours both.
    - Adversarially named extended attributes, or payloads under allow-listed names. On Darwin, a `worktreeRoot`
      containing `": "` keeps every worktree because its xattr listing paths are ambiguous.
    - Synchronous top-level `stat`/`realpath` calls on a hung volume, bounded only by the OS.
    - The out-of-model concurrent-writer gap described above.
  - The save runs no repository hook, fsmonitor or filter. A path under a clean filter keeps the worktree.
    Hidden (skip-worktree or assume-unchanged) or unmerged index entries keep every repository for a manual save.
    Submodules permit saving only with a recorded start commit and identical gitlinks in that tree, HEAD and the
    index, and UTF-8 paths to existing empty real directories beneath real parents. Missing, unreadable, populated,
    file or symlink submodule paths, or a `modules` entry in the worktree's administrative git directory, keep it.
    When neither index nor HEAD has gitlinks, no start read is needed; a committed gitlink removal is saved.
- **Each attempt has its own `TMPDIR`**, removed when the attempt ends. Keep anything that must last in the worktree.
- **A nearly full disk makes requests wait**, below `minFreeGb`.
  - A disk-full failure after that check makes read-only work, and changing work that had not yet started, wait again
    without blaming the account or spending a try. The tenth disk-full failure ends the request.
  - Changing work that may already have done something is never re-run automatically. It fails like any other
    failure, with its worktree kept for inspection.
- **Interactive requests run before background ones.**
- **Pins:**
  - A pinned request waits while its account is busy, offline or limited.
  - If the account is unavailable for another reason, such as signed out or disabled, the request fails after
    `pinWaitMs`.
- **`cwd` is where a job starts, not a boundary.** A read-only job can read any file its user account can read, so say
  in the prompt what it may read.
  - Read-only Claude jobs get only the Read, Grep and Glob tools.
  - Read-only Codex jobs run in Codex's read-only sandbox.

## Security model

- **SSH-style folder checks.** `pipe remote install` trusts processes running as you, which can change your launcher,
  shell startup files or Node binary. Like SSH's `StrictModes`, it refuses links and folders that other users can write
  from your resolved home through the installed version, including write access granted by ACLs. Its own `pipe` and
  version folders refuse any allow ACL because they hold the token. Folders above home are not checked, as with
  `StrictModes`, and `--node` is trusted as given. It does not defend against processes running as you.
- **Local service, SSH client access.** The service listens on `127.0.0.1`; `pipe remote install` makes a home-folder
  MCP launcher reachable through your existing SSH login. It opens no additional service port.
- **One token.**
  - Every request needs the bearer token from the owner-only token file.
  - The clients refuse redirects, so the token never travels to another origin.
  - Error messages never contain the token.
- **No credentials handled.** pipe never reads a provider's credentials. It points each CLI at its own login folder
  (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) and runs it.
- **Clean job environment.** A job gets an allow-listed environment: `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `TERM`
  and `LC_*`, and its own `TMPDIR`. No API keys pass through. `PIPE_ORIGIN=runner` marks it as a pipe job.
- **Bounded, untrusted output.**
  - Requests are limited to 1 MiB and responses to 8 MiB.
  - The MCP server labels provider output as untrusted data and truncates it at 64 KiB; the content-free `pipe_list` preserves the complete HTTP-bounded list.
- **Prepaid subscriptions only.** There is no API key, pay-as-you-go or purchased-credit path.
- **No telemetry; the only outside connections are the providers'.** The Pipe sends nothing to us or anyone else.
  Its own network use is a DNS lookup and up to two bare TCP connections to `api.anthropic.com:443` or
  `chatgpt.com:443`, each closed as soon as it opens and carrying no data, to tell whether the provider can be reached at all. The provider CLIs it runs talk to their own services under their
  own terms. `pipe stats` and `/v1/stats` are computed from the local record and never leave your machine.

## What it does not do

- It does not run across several machines, or accept remote workers.
- It does not share or resell accounts, and it does not buy capacity.
- It does not install or update the provider CLIs, or sign them in.
- It does not support Gemini in this release: a Gemini setting refuses to start, and a Gemini job or review seat is refused.

## Develop

`npm test` runs the tests, and `npm run typecheck` checks the types. See [CONTRIBUTING.md](../CONTRIBUTING.md).

Apache License 2.0, like the rest of Huntaway; see [LICENSE](../LICENSE). To report a security problem, see [SECURITY.md](../SECURITY.md).
