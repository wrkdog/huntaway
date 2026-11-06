# U4 probe captures (2026-09-24, a development Mac)

These are official status surfaces only, captured by `capture_u4.py` (a copy is kept here).
Identity values are replaced before anything is written: email, orgId, orgName, account ids,
directories and UUIDs. Nothing raw was printed or stored.

| File | Command | CLI | Account |
| --- | --- | --- | --- |
| `claude-version` | `claude --version` | 2.1.280 | — |
| `claude-auth-status.signed-in` | `claude auth status` | 2.1.280 | a Claude login (the default folder) |
| `claude-auth-status.signed-out` | `claude auth status`, empty `CLAUDE_CONFIG_DIR` | 2.1.280 | none; exit 1, JSON on stdout |
| `claude-usage.signed-in` | `claude -p /usage --output-format json …` (the router's argv) | 2.1.280 | the same Claude login |
| `claude-usage.offline` | the same, behind a dead HTTPS proxy | 2.1.280 | the same Claude login; **identical to online, see finding 1** |
| `codex-version` | `codex --version` | 0.156.1 | — |
| `codex-login-status.signed-in` | `codex login status` | 0.156.1 | a Codex login; stderr "Logged in using ChatGPT", exit 0 |
| `codex-login-status.signed-out` | `codex login status`, empty `CODEX_HOME` | 0.156.1 | none; stderr "Not logged in", exit 1 |
| `codex-app-server.signed-in` | app-server: initialize, `account/read`, `account/rateLimits/read`, `model/list` | 0.156.1 | the same Codex login |
| `codex-app-server.signed-out` | the same, empty `CODEX_HOME` | 0.156.1 | rateLimits: error -32600 "authentication required" |
| `codex-app-server.offline` | the same, behind a dead HTTPS proxy | 0.156.1 | rateLimits: error -32603 "failed to fetch … wham/usage"; `account/read` and `model/list` still answer |

## Findings

1. **Claude's `/usage` silently serves its last cached reading when the service is
   unreachable.** Tested on a third Claude login with all outbound IP denied by `sandbox-exec`; the
   same profile makes `curl` fail at once. The steps, in order:
   - denied: 11% (the cache);
   - online: 12% (fetched, and the cache is updated);
   - denied again: 12% (the new cache).

   Every run exited 0, with `is_error: false` and identical format. So a `/usage` reading
   proves a fresh measurement only if the service was reachable in the same probe. Otherwise
   it is of unknown age: under rule 8 it is unknown, not fresh (L11). The current router takes
   the output as a fresh HIGH-confidence reading (worker `quota.ts`, `slash_usage`).
2. **Codex separates offline from signed out.**
   - `account/read` and `model/list` are local, so they answer offline and signed out.
   - `account/rateLimits/read` needs the network. It fails with -32603 when offline, and with
     -32600 "authentication required" when signed out.
3. **Codex 0.156.1:** `account/read` has no top-level account id (only
   `workspaceRouting.chatgptAccountId`). `account/rateLimits/read` still carries a top-level
   `accountId`, and that is what the worker hashes. Checks:
   - the fingerprints of all three Codex slots are identical under 0.153.4 and 0.156.1, and
     match the configured values (43faa67c, c9d04ce6, becdac6b);
   - `codex exec --help` lists the same flags as 0.153.4, `--ignore-user-config` included.

   So the release's CLI upgrade keeps the slots routable.
4. **`model/list`** on 0.156.1 lists 7 models: gpt-6-astra, gpt-6-sol, gpt-6-luna,
   gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna and gpt-5.5. It needs no login. Claude's CLI has
   no model-list command. For Claude, the pipe's policy is the only list, and an id outside it
   is unknown.
5. **Claude `auth status`** writes JSON to stdout even when signed out (exit 1).
   `authMethod` "none" means signed out, not offline, because the command is local.

**One placeholder for one login.** In `codex-app-server.signed-in`, `rateLimits.accountId` carries
the same placeholder as `account/read`'s `workspaceRouting.chatgptAccountId`, `<chatgptAccountId>`.
The real values are equal: on all three logins they hash to the same fingerprint. The probe
checks that they agree, so that readings belong to their login.
