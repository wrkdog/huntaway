# Huntaway

**Run Claude Code and Codex on the subscriptions you already pay for. Jobs wait in line instead of failing, every job
leaves a record, and nothing counts as reviewed until models from two different AI companies approve the exact
commit.**

Huntaway runs on your own computer, and it has two parts:

- **The Pipe** ([`pipe/`](pipe/)), a small local service. You send it work; it picks one of your accounts that has
  room, runs the job through that provider's official command-line tool (`claude` or `codex`) with that account's own
  login, and keeps a record of what happened.
- **The `huntaway` command**, which asks one question and tells you plainly what happened: it ran, it certainly didn't
  run (so you can send it again), or it may have run.

No account with us, no telemetry, nothing sent to us, and nothing to install beyond Node.js, git and the official CLIs
you already use.
Huntaway is built by the team behind [Wrk.Dog](https://wrk.dog), and it is one of the `wrkdog` working-dog tools.

## What it does

- **Pipe jobs wait instead of failing.** When your accounts are busy, a job waits in line until one has room.
- **Every job leaves a record.** Which account ran it, on which model, how it ended, and where any changed files are,
  in a local SQLite file only you can read.
- **Code reviews by two companies' models.** A review is tied to one exact commit. Nothing is approved until both an
  OpenAI model and an Anthropic model approve that same commit, and each vote is recorded with a receipt. An approval
  means two AI models found nothing blocking; it is not a security audit or a promise that the code is correct, and
  you decide what to merge.
- **Builds stay out of your way.** A job that changes code works in its own git worktree and saves its result as a
  commit on its own branch.
- **It never picks a model for you.** Every Pipe job names its model and effort, and says why.

## What it is not

- It is for **one person's own accounts on one machine**. It is not a way to share or resell subscriptions, and it is
  not a way around a provider's usage limits. Use only accounts you hold yourself, and check each provider's terms on
  multiple accounts and automated use.
- **The Pipe never falls back to paid APIs.** Each job runs on the plan you signed in with. Only if you set
  `codexCredits` in the Pipe's config do Codex credits you didn't buy (promotional ones, for example) also count as room, after ordinary
  room. (The `huntaway` command's default engine is different: it calls Anthropic's paid API with your own key, unless
  you choose `--engine pipe`.)
- **Gemini is not supported in this release.** A Gemini setting refuses to start, and a Gemini job is refused.

The Pipe only runs the official CLIs you installed and signed in to yourself, and it never handles your provider
logins. Its only other network use is a bare connection, carrying no data, to the provider's own host
(`api.anthropic.com` or `chatgpt.com`, port 443), to check it can be reached. The `huntaway` command's default engine
reads your Anthropic API key from the environment or your macOS keychain and sends it only to Anthropic.
With `--engine openai`, it reads your OpenAI API key from the environment or your macOS keychain and sends it only to OpenAI.

## Get started

**The quick way:** tell your coding assistant (Claude Code, Codex, or another that can run commands), "Read
[`SETUP-WITH-YOUR-ASSISTANT.md`](SETUP-WITH-YOUR-ASSISTANT.md) and set Huntaway up for me." It checks your computer,
tells you what Huntaway will do and asks before it changes anything. You do the sign-ins yourself. Or by hand:

1. **Set up the Pipe.** Follow [`pipe/README.md`](pipe/README.md): install it, give each account its own login folder,
   write a config and start the service. Its command line (`pipe`) and its MCP server work from there.
2. **Optionally, install the `huntaway` command** (below), on its own with an Anthropic or OpenAI API key, or pointed at the
   Pipe.

## The `huntaway` command

### What you need

- macOS or Linux (both tested; the Pipe is developed on macOS and tested on Ubuntu), with [Node.js](https://nodejs.org)
  22.18 or later and git.
- For the default engine, an Anthropic API key in `ANTHROPIC_API_KEY` or your macOS keychain, and the two
  spend caps below. Huntaway makes one free token-count call and one Messages API call per question, billed to your API account. With `--engine pipe`, questions run through the Pipe on your subscriptions
  instead.
- For `--engine openai`, an OpenAI API key in `OPENAI_API_KEY` or your macOS keychain, and the same two caps.
  Huntaway makes one free token-count call and one Responses API call per question, billed to your OpenAI account.

### Install

```sh
git clone https://github.com/wrkdog/huntaway.git
cd huntaway
sh scripts/install-local.sh --standalone --alias "My Mac"
huntaway key set anthropic         # macOS: enter your key with echo off
# On Linux, set ANTHROPIC_API_KEY in your environment.
export HUNTAWAY_MAX_USD_PER_QUESTION=1
export HUNTAWAY_MAX_USD_PER_DAY=10
huntaway doctor
```

The installer copies the current commit, read-only, to `~/.local/share/huntaway/app` and adds a `huntaway` command
to `~/.local/bin`. It uses no network and no sudo, and writes nothing outside your home folder. If `~/.local/bin`
isn't on your `PATH` (it isn't on a new Mac), the installer says so: add it, or run `~/.local/bin/huntaway`.
`--alias` is the name this machine reports as (letters, digits, spaces, `_` and `-`). `--standalone` means Huntaway
runs on its own, with your API key.

Run the installer again after `git pull` to update. `sh scripts/uninstall-local.sh` removes the command and the code
and keeps your history. Add `--purge-history` to delete the history too.

### Use

```sh
huntaway ask "What is the capital of Australia?"
echo "a private question" | huntaway ask -      # kept out of the process list other users can see
huntaway ask - < question.txt                    # and, from a file, out of your shell history too
huntaway ask -- "-5 degrees: is that cold?"      # a question starting with a dash
huntaway status                                  # this machine and its runs
huntaway status --json                           # the same, for a program
```

For `ask` with the default engine, `--model` picks the model (default `claude-sonnet-5-5`), `--max-tokens` caps the
answer (default 1024, at most 8192), and `--timeout` limits the wait in seconds (default and at most 300, Huntaway's
own cap covering the count and the unstreamed answer). The count also has its own 30-second limit.
With `--engine openai` (or `HUNTAWAY_ENGINE=openai`), the default model is `gpt-5.4`, with reasoning effort set to
`none`. OpenAI accepts `--max-tokens` from 16 to 8192 (Anthropic accepts 1 to 8192); a value outside that range
is a usage error before anything is sent. The same `--timeout` limits apply. `--family` and `--effort` are usage
errors for OpenAI.

### Paid API keys

Anthropic and OpenAI are the paid API engines in this release. Each sends your question to its provider twice:
first to count tokens (free), then to get an answer. Anthropic keeps its own records under its own terms. The Pipe
continues to use your subscriptions.

`store: false` means OpenAI doesn't store the response for later retrieval. OpenAI still keeps its own records under
its terms, including abuse-monitoring logs for up to 30 days by default.

A nonempty `ANTHROPIC_API_KEY` takes precedence. An invalid value refuses without falling back. On macOS, if the
variable is unset or empty, Huntaway reads your keychain (service `huntaway`, account `anthropic`), in the keychains
macOS searches by default (normally just the login keychain). A missing, locked or unreadable keychain refuses. On Linux, use the environment.
For OpenAI, the same rules use `OPENAI_API_KEY` and keychain account `openai`; the key goes only to OpenAI.

Run `huntaway key set anthropic` to enter a key with terminal echo off, or supply one line on stdin from a secret
manager. `huntaway key remove anthropic` removes the stored item. Huntaway never writes your API key to a file;
`huntaway key set` stores it in your default keychain, normally the login keychain. Any program running as you can read that item without a prompt:
its exposure is the same as an environment variable. Huntaway never puts it in a log, a run record, the spend ledger,
an error or a command's arguments. `huntaway doctor` reports its source, never its value.
Use `huntaway key set openai` and `huntaway key remove openai` for the OpenAI key.

Both `HUNTAWAY_MAX_USD_PER_QUESTION` and `HUNTAWAY_MAX_USD_PER_DAY` are required dollar amounts from 0.01 to 1000,
with up to two decimal places; the day cap must be at least the question cap. Both apply to the **hard worst case**:
the hard input and your output limit at the table's standard prices, including applicable surcharges. Every call
pins the standard tier. For a model with the byte bound, hard input is the smaller of its hard input limit and
2 × B + its fixed overhead. B is the larger of the exact billed JSON request body's UTF-8 byte length and the same
body's byte length with the question NFKC-normalized. Huntaway sends the question unchanged; normalization is only
for counting. Without the byte bound, hard input is the hard input limit. The counted estimate is information only.
These caps cover only Huntaway's own use on this machine, under
this `HUNTAWAY_HOME`, not your provider account as a whole. The cap grows with the question. A **10,240-byte request
body** with default `--max-tokens 1024` on `claude-sonnet-5-5` needs a per-question cap of **$0.06** (56,461
micro-dollars, rounded up to the cent), with B = 10,240 after taking the larger count. On OpenAI's default `gpt-5.4`,
the same body and output limit need a per-question cap of **$0.13** (125,760 micro-dollars, rounded up to the cent).
Doctor uses these same examples; a refusal names the cap your request needs. Larger questions need more.
Anthropic's standard table prices are $2.20 / $11 per million tokens, including the possible 10% US-residency surcharge;
the hard input limit is 1,000,000 tokens and the conservative framing overhead is 64 tokens.
OpenAI's table uses $5 / $22.50 per million tokens, the highest standard rates including the long-context premium,
even for short questions. Its hard input ceiling is the full 1,050,000-token context window, with a conservative
64-token framing overhead; output may stop at the context boundary. Its byte bound uses OpenAI's published
`o200k_base` byte-level BPE tokenizer. The
non-standard tier allowance is conservatively $25 / $112.50 per million tokens; no current public GPT-5.4
Fast/priority long-context price was confirmed. These numbers were checked on 2026-11-05 against the
[model documentation](https://developers.openai.com/api/docs/models/gpt-5.4) and
[pricing documentation](https://developers.openai.com/api/docs/pricing).

The byte-bound basis is Anthropic's [earlier published byte-level BPE tokenizer](https://github.com/anthropics/anthropic-tokenizer-typescript).
It applies NFKC normalization before encoding, which can expand text: U+FDFA grows from 3 UTF-8 bytes to 33.
Counting the normalized question in the same JSON body covers that expansion; taking the larger count also covers
text that normalization shrinks.
Anthropic hasn't published this model's tokenizer. The defences are the factor 2 margin and the post-call overrun
block: billed input above the hard input bound stops further calls to that model, even if its cost fits the
reservation. If the table is wrong or the provider ignores the pinned tier, that one call can pass a cap; it warns
and blocks the model. A missing or non-standard reported tier settles at the priority price as an overrun. The
priority allowance is conservatively $11 / $55 per million tokens because no public Sonnet 5.5 rate was confirmed.
Choose a cheaper table model when one is available, or raise the cap; a lower estimate cannot admit the request.

A price override such as `HUNTAWAY_PRICE_ANTHROPIC_CLAUDE_SONNET_5_5=12,60` can only raise table prices for a known
model. Prices are dollars per million tokens, up to six decimal places, from 0 to 1000. Doctor flags overrides and
tables checked more than 60 days ago. Missing or invalid usage retains the full reservation. A spend overrun warns
and blocks that model until a reviewed safety revision fixes its prices, limits or reader; updating an unrelated
model or installing an older release cannot clear it. An answer that was printed still exits 0.

The day is a rolling **last 24 hours**, based on UTC start times, with future-dated rows counted too. There is no
local midnight reset. The ledger trusts your system clock: moving it backwards adds rows to the window; moving it
forwards can free headroom early. A clock far in the past holds future-dated spending until it catches up. Correct
the clock to recover. The caps guard against accidents, not against their owner. `uninstall-local.sh --purge-history`
is an uninstall that deletes the whole ledger, including every overrun block. `huntaway status` and doctor show
spend; an uncertain request keeps its reservation, and concurrent questions reserve under a database lock.

Each paid question prints two lines on stderr. Before sending even the count, the first says:

```text
This question uses your paid Anthropic API key; any charge goes to that account. Huntaway first asks Anthropic to count the question (free), which sends it to Anthropic. Caps: $1.00 a question, $10.00 a day (Huntaway's own use on this machine).
```

It adds `A price override is in use.` when applicable. After counting and reserving, before the billed call, the
second looks like this for the 10,240-byte body above (the estimate and prior spend vary):

```text
At most $0.06 for this question (about $0.0175 by Anthropic's count); $0.02 of your $10.00 used in the last 24 hours.
```

“At most” rounds the hard ceiling up to cents; “about” is only an estimate; “used” excludes this question's own
reservation. If the ledger cannot be opened, read or locked in five seconds, nothing billed is sent. A failed count
also sends nothing billed. Neither call is retried, and redirects are refused.

### Through the Pipe

With the Pipe running and its MCP server registered with `claude mcp add --scope user pipe -- <command>` (see
[`pipe/README.md`](pipe/README.md), "MCP"), `huntaway ask --engine pipe "..."` runs the question on your subscriptions
through the Pipe. `--family claude|codex` chooses which (default `claude`).
The model defaults to `opus` for Claude and `gpt-6.1-sol` for Codex.
`--effort low|medium|high` sets the effort (default `medium`), and `--timeout` defaults to 600 seconds. `--max-tokens`
is for paid API engines only, and `--effort` for the Pipe only: either one with the other engine is a usage error.
To make the Pipe your default engine, set `HUNTAWAY_ENGINE=pipe`. You can also name the MCP command yourself in
`HUNTAWAY_PIPE_CMD`, as a JSON array. Huntaway never switches engines by itself.

### From OpenClaw

[`openclaw/huntaway/SKILL.md`](openclaw/huntaway/SKILL.md) is a skill for an [OpenClaw](https://openclaw.ai)
assistant: with the Pipe's MCP server added to an OpenClaw node, the assistant can hand jobs to Claude Code or Codex,
watch them and ask for reviews by two companies' models. It tells the assistant to ask you before any job that
changes code and never to push or merge. Those rules guide the assistant; they are not a lock, so connect the Pipe
only to an assistant that only you can talk to. The skill is also published on ClawHub, where every skill is under
the MIT-0 licence.

### From Claude Code (and other assistants)

[`skills/huntaway/SKILL.md`](skills/huntaway/SKILL.md) is a Claude Code skill with the same rules and tasks, for the
Pipe's MCP tools. [`SETUP-WITH-YOUR-ASSISTANT.md`](SETUP-WITH-YOUR-ASSISTANT.md) installs it on your yes. Any other
assistant can read it as its instructions.

### What each outcome means

| You see | In `status` | What it means |
|---|---|---|
| The answer | `done` | It ran and you have the answer. |
| "Nothing ran; you can send it again." | `failed` | The API refused it, or couldn't be reached. It certainly didn't run. |
| "It may have run and was not retried." | `uncertain` | The call was sent but the answer was lost (a server error, a dropped connection, the time limit). Check before sending again. |
| "Stopped before anything was sent." (you pressed Ctrl-C) | `failed`, `declined` or `cancelled` | Stopped before the call was sent. It never ran. |
| "Stopped. It may have run" (you pressed Ctrl-C) | `uncertain` | Stopped after the call was sent. |

If Huntaway itself is cut off (a crash or a power cut), the next `huntaway ask` records that run: `declined` or
`cancelled` if it was never sent, `uncertain` if it may have been. While a question is in flight, `status` shows it
as `waiting_local_host` or `running`. With the default engine, the `huntaway` command never resends a question on
its own, so it can't run twice without you knowing. (With `--engine pipe`, the Pipe may retry a job within the limits
its README describes.)

### What it keeps

In `~/.local/share/huntaway`, in files only you can read:
- the request log (`requests.db`);
- the run list (`runs.db`);
- the spend ledger (`spend.sqlite`), with start time, engine, model and safety revision, estimated and reserved
  micro-dollars, settled cost and validated tokens when available, outcome and overrun flag;
- a per-install key (`key`), used only to fingerprint questions.

The spend ledger never holds a key, question, answer or request id. Rows older than 24 hours may be pruned; overrun
rows are kept at every age. `--purge-history` removes the ledger and its side files along with the other history.
Set `HUNTAWAY_HOME` to choose another data folder (this also gives it a separate cap ledger).

Each `huntaway ask` removes up to 100 ended runs that started more than 90 days ago (a run active since then stays),
plus up to 100 runs a crash left without their request, once they too are older than that, so the files stop growing
(they do not shrink). Set `HUNTAWAY_KEEP_DAYS` (whole days, 1 to 3660; empty means 90) to keep more or less; any other
value keeps everything, with a warning. A run still in progress, or one without a time Huntaway wrote, is never
removed, and nothing is removed while either file is a link to another file or isn't yours.

The `huntaway` command itself never stores your questions or answers, only a keyed fingerprint of each question. Your
API key is read from the environment or your macOS keychain and sent only to the chosen provider's API:
Anthropic for `--engine anthropic`, OpenAI for `--engine openai`. Each keeps its own records under its own terms,
including OpenAI's records described under "Paid API keys" above. With `--engine pipe`, the Pipe's own record keeps
each job's prompt and result, and the provider CLI keeps its own history.

### If the request log needs recovery

Huntaway refuses to open its request log if an earlier run stopped part-way through creating or writing it, for
example when the power failed during your very first `ask`. It won't guess what the log held, because a guess could
hide a question that may have run. Keep every file in the folder as it is, make sure no `huntaway` is running, and
open an issue (without attaching the files).

### Status as JSON

`huntaway status --json` prints a snapshot in a small, stable shape: this machine and its runs, as codes rather than
words. The schema and examples are in the `contract/` folder.

## Known issues

- **Several `huntaway ask` runs started close together, most often on a brand-new install,** can, rarely, stop with
  "Error: the request log could not be opened". A run that stops this way has sent nothing: run that one again.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability privately, see [SECURITY.md](SECURITY.md). Please
don't open a public issue for it. For conduct, see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). `openclaw/huntaway/SKILL.md` is also offered under
MIT-0, as ClawHub requires of every skill it publishes.

## Trademarks

Huntaway is an independent project. It is not made, endorsed or supported by Anthropic or OpenAI. Anthropic, Claude,
Claude Code, OpenAI, ChatGPT and Codex are trademarks of their owners, named here only to say which tools Huntaway
runs.
