# Security

## Reporting a vulnerability

Please report it privately through GitHub: open the repository's **Security** tab and choose **Report a
vulnerability**. Don't open a public issue or pull request for it. You'll get a reply as soon as we can, and we'll
agree on disclosure with you.

## Supported versions

Only the latest commit on `main` and the latest npm and Homebrew package are supported. From source, update by pulling
and running the installer again. From a package, update with npm or Homebrew.

## How the `huntaway` command protects you

Each of these is covered by the tests named in brackets.

- **Your question and the answer are never written to disk.** The request log keeps only states, times and a keyed
  fingerprint of each question. [ask, anthropic]
- **Your API key comes from the environment or, on macOS, your keychain (normally the login keychain)
  via `huntaway key set`.** It goes only to the chosen provider's API (Anthropic or OpenAI) over HTTPS, redirects are
  refused, and it never appears in a message or a log, and Huntaway writes it to no file of its own. Huntaway's own
  tests point it at a stand-in on the same machine, which needs a test-only switch. Apart from the macOS keychain tool,
  Huntaway never passes the key to anything else. [anthropic, openai-unit, paid-key]
- **Owner-only data.** The request log, the run list and the install key can be read only by you. The installed code
  is a read-only copy. [ask, install]
- **No telemetry.** Huntaway sends nothing to us. Paid API calls go only to the chosen provider (Anthropic or OpenAI).
  It uses the Pipe only if you choose it (see the README). [anthropic, status]
- **Never retried.** A question is sent once. When Huntaway can't be sure it ran, it says so rather than guessing.
  [ask, anthropic]
- **Plain error words.** Errors never repeat a path, a server's text or your question. [ask, anthropic, status]
- **A contained install.** The installer uses no network access or sudo, writes only inside your home folder, refuses
  symbolic links on its paths, and never replaces a `huntaway` command it didn't create. [install]

## Installing from npm or Homebrew

- **The package folder is trusted as installed.** npm or Homebrew keeps the package where it installs packages. Anyone
  who can write to that folder already controls the launcher, so the checks below can't protect you from them.
- **Your own copy, checked on every run.** Huntaway runs only from your owner-only copy in
  `~/.local/share/huntaway/app`, checked against the package's checksums on every run. This is integrity, not
  authenticity: it shows the copy matches the package as npm or Homebrew installed it, not who made that package. A
  mismatch is refused, never repaired.
- **No network and no shell.** The launcher uses no network and runs no shell.

## The Pipe

The Pipe's own protections (each account's own login folder, a service that listens only on `127.0.0.1` behind one
owner-only token, a clean job environment with no API keys, bounded output treated as untrusted, prepaid subscriptions
only, and no telemetry) are described under "Security model" in [pipe/README.md](pipe/README.md).

- **Claude jobs aren't sandboxed by the Pipe.** A Claude job that changes files runs as you, inside only Claude
  Code's own sandbox, which covers its shell commands and still allows the macOS Keychain service. So such a job can
  read items in your Keychain. Give the Pipe only repositories and tasks you trust.

These protections are limits on what the code does, not a guarantee. Read the code, and report anything that falls
short of them.
