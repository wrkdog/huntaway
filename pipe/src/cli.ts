/** Small local client and service launcher. */
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requestJson, requestJsonReconnecting } from './client.ts';
import { recoverFailedStop, resolveCli, startPipe, type PipeConfig } from './service.ts';
import { geminiModels } from './agy.ts';
import { validateArgonModels } from './agy-chat.ts';
import { validPlacement, validLeaseTtl, type NewRequest, type AttemptOutcome } from './store.ts';
import { validLane, validSince } from './telemetry.ts';
import { strictUtf8 } from './projects.ts';

type FileConfig = Omit<PipeConfig, 'token'> & { tokenFile: string; url?: string };

/** Read the local checkout release without hooks, filters or inherited git configuration. */
export function releaseVersion(dir: string): string | null {
  try {
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    const git = (args: string[]) => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', dir, ...args],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env });
    const [top = '', commit = ''] = git(['rev-parse', '--show-toplevel', '--verify', 'HEAD^{commit}']).trim().split('\n');
    const at = statSync(dir, { bigint: true }), root = statSync(top, { bigint: true });
    if (at.dev !== root.dev || at.ino !== root.ino || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) return null;
    if (git(['ls-files', '-z', '--stage']).split('\0').some((entry) => entry.startsWith('160000 '))) return null;
    const filters = new Set(git(['config', '--list', '--name-only', '-z']).split('\0')
      .flatMap((key) => /^filter\.(.*)\.(?:clean|smudge|process|required)$/isu.exec(key)?.[1] ?? []));
    if ([...filters].some((name) => !name || /[=\uFFFD]/u.test(name))) return null;
    const off = [...filters].flatMap((name) => ['-c', `filter.${name}.clean=`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`]);
    return git([...off, 'status', '--porcelain', '--untracked-files=no']).trim().length > 0 ? `${commit}-dirty` : commit;
  } catch {
    return null;
  }
}

/** serve's settings: the release is read from the pipe's own checkout; a config file cannot set it (READ-CONTRACT-01). */
export function serveSettings(file: FileConfig, repoDir: string): Omit<PipeConfig, 'token'> {
  const { tokenFile: _tokenFile, url: _url, version: _version, ...settings } = file;
  return { ...settings, version: releaseVersion(repoDir) };
}

/** EX_TEMPFAIL lets a service manager restart after a proven work-volume loss. */
export const serveExitCode = (restartReason: string | undefined): number => restartReason === undefined ? 0 : 75;

/** Wait through bounded drain requests until the service confirms completion. */
export async function drainClient(url: string, secret: string, pollMs = 500): Promise<{ draining: true; drained: true }> {
  const wait = Number.isInteger(pollMs) ? Math.max(1, Math.min(pollMs, 30_000)) : 500;
  for (;;) {
    let status: { draining?: boolean; drained?: boolean; running?: number };
    try {
      status = await requestJson(url, secret, 'POST', `/v1/drain?wait=${wait}`) as typeof status;
    } catch (e) {
      if (e instanceof TypeError) throw new Error('serviceGone: service stopped before drain was confirmed');
      throw e;
    }
    if (status.draining !== true || typeof status.drained !== 'boolean') throw new Error('drain status is unavailable');
    if (!Number.isInteger(status.running) || status.running! < 0) throw new Error('drain running count is unavailable');
    if (status.drained) return { draining: true, drained: true };
    process.stderr.write(`pipe draining: ${status.running} running\n`);
  }
}
export const CLI_COMMANDS = {
  serve: ['--config <file> [--dry-run]', undefined, undefined, 'changing'],
  recover: ['--config <file> [--attempt <id>] [--outcome <json>] [--give-up] [--dry-run]', undefined, undefined, 'changing'],
  remote: ['install --config <file> [--home <dir>] [--node <path>] [--dry-run]', undefined, undefined, 'changing'],
  'gemini-models': ['--config <file>'],
  submit: ['[--dry-run]', '/v1/requests', 'POST', 'changing'],
  review: ['[<id>] [--repo <dir>] [--head <ref>] [--brief <file>] [--base <ref>] [--repository <name>] [--project <name>] [--context-packet <file>] [--output-contract <file>] [--seat <provider:model:effort>] [--builder <family:context>] [--reason <text>] [--priority <priority>] [--lane <label>] [--placement <placement>] [--dry-run]', '/v1/reviews', undefined, 'changing'],
  'review-vote': ['<id> [--dry-run]', '/v1/reviews/{id}/votes', 'POST', 'changing'],
  stats: ['--since <date>', '/v1/stats'],
  list: ['[--state <state>] [--requester <name>]', '/v1/requests'],
  card: ['<id>', '/v1/cards/{id}'],
  status: ['<id> [--selection]', '/v1/requests/{id}'],
  wait: ['<id> [--reconnect-seconds <seconds>]', '/v1/requests/{id}'],
  cancel: ['<id> [--by <actor>] [--dry-run]', '/v1/requests/{id}/cancel', 'POST', 'changing'],
  lease: ['(take <account> --holder <h> --ttl <s> [--purpose <p>] | renew <id> [--ttl <s>] | release <id>) [--dry-run]', '/v1/leases', 'POST', 'changing'],
  ...Object.fromEntries(['capabilities', 'accounts', 'models', 'worktrees', 'leases'].map(command => [command, ['', `/v1/${command}`]])),
  // Listing is read-only; the nested reset entry carries its own mutation and preview contract.
  worktrees: Object.assign(['[reset <id>] [--dry-run]', '/v1/worktrees'], {
    reset: ['<id> [--dry-run]', '/v1/worktrees/{id}/reset', 'POST', 'changing'],
  }),
  prune: ['[--dry-run]', '/v1/worktrees/prune', 'POST', 'changing'],
  drain: ['[--dry-run]', '/v1/drain?wait=500', 'POST', 'changing'],
};
const options = new Map<string, string[]>();
let leaseAction: string | undefined;
const arg = (name: string): string | undefined => options.get(name)?.[0];
const usageError = (message: string): never => { process.exitCode = 2; throw new Error(message.replace(/[\r\n]/g, ' ')); };
function argumentsFor(command: string, syntax: string): string | undefined {
  const flags = new Map([...`${syntax} [--config <file>]`.matchAll(/(--[\w-]+)( <[^>]+>)?/g)].map(m => [m[1]!, !!m[2]]));
  const positional: string[] = [];
  for (let i = 3; i < process.argv.length; i++) {
    const value = process.argv[i]!;
    if (!value.startsWith('-')) { positional.push(value); continue; }
    if (!flags.has(value)) usageError(`unknown ${command} flag: ${value}`);
    if (options.has(value) && !['--seat', '--builder', '--config'].includes(value)) usageError(`repeated ${command} flag: ${value}`);
    const supplied = flags.get(value) ? (process.argv[i + 1]?.startsWith('--') === false ? process.argv[++i]! : usageError(`${value} needs a value`)) : '';
    options.set(value, [...options.get(value) ?? [], supplied]);
  }
  if (positional.length > (command === 'lease' || command === 'worktrees' ? 2 : /^(?:\[?<id>|install)/.test(syntax) ? 1 : 0)) usageError(`unexpected ${command} argument: ${positional.at(-1)}`);
  if (command === 'lease') {
    leaseAction = positional[0];
    if (!leaseAction || !['take', 'renew', 'release'].includes(leaseAction) || !positional[1]) usageError('use lease take <account>, lease renew <id> or lease release <id>');
    for (const flag of options.keys()) if (!['--config', '--dry-run', ...(leaseAction === 'take' ? ['--holder', '--ttl', '--purpose'] : leaseAction === 'renew' ? ['--ttl'] : [])].includes(flag)) usageError(`unknown lease ${leaseAction} flag: ${flag}`);
    if (leaseAction === 'take' && !arg('--holder')) usageError('lease take needs --holder <h>');
    if (leaseAction !== 'release' && !validLeaseTtl(Number(arg('--ttl') ?? (leaseAction === 'renew' ? 300 : NaN)))) usageError('--ttl must be an integer from 60 to 3600');
    return positional[1];
  }
  if (syntax.startsWith('<id>') && !positional[0]) usageError(`${command} needs an id`);
  if (command === 'remote' && positional[0] !== 'install') usageError('use remote install --config <file> [--home <dir>] [--node <path>]');
  if (command === 'worktrees' && positional.length) { if (positional.length !== 2 || positional[0] !== 'reset') usageError('use worktrees reset <id>'); return positional[1]; }
  return positional[0];
}
function token(path: string, create: boolean): string {
  if (create) {
    try { writeFileSync(path, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
  if ((statSync(path).mode & 0o077) !== 0) throw new Error('tokenFile must be owner-only (0600)');
  return readFileSync(path, 'utf8').trim();
}

const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";

function refuseOtherWriters(folder: string, mode: number): void {
  const writers = [mode & 0o020 ? 'group' : '', mode & 0o002 ? 'world' : ''].filter(Boolean);
  if (writers.length) throw new Error(`remote install refuses a ${writers.join(' and ')}-writable directory: ${folder}`);
}

const aclWriteRights = new Set(['write', 'append', 'add_file', 'add_subdirectory', 'delete', 'delete_child', 'writeattr', 'writeextattr', 'writesecurity', 'chown']);
const aclRights = new Set([...aclWriteRights, 'read', 'execute', 'readattr', 'readextattr', 'readsecurity', 'list', 'search', 'file_inherit', 'directory_inherit', 'limit_inherit', 'only_inherit']);

function refuseOtherAclAccess(folder: string, privateFolder: boolean): void {
  const unsafe = () => new Error(`remote install refuses a directory whose access control list grants others access or cannot be verified: ${folder}`);
  let output: string;
  try { output = execFileSync('/bin/ls', [process.platform === 'darwin' ? '-lde' : '-ld', folder], { encoding: 'utf8' }); }
  catch { throw unsafe(); }
  const lines = output.trimEnd().split('\n');
  const mode = lines[0]?.match(/^d[rwxStTs-]{9}([+@.]?)[ \t]+/);
  if (!mode || !lines[0]?.endsWith(folder)) throw unsafe();
  if (process.platform !== 'darwin') {
    if (mode[1] === '+' || lines.length !== 1 || mode[1] === '@') throw unsafe();
    return;
  }
  if (mode[1] !== '+' && mode[1] !== '@' && mode[1] !== '') throw unsafe();
  if (mode[1] === '+' && lines.length === 1) throw unsafe();
  for (const line of lines.slice(1)) {
    const entry = line.match(/^\s*\d+:\s+\S+(?:\s+inherited)?\s+(allow|deny)\s+([a-z_,]+)(?:\s+inherited)?\s*$/);
    if (!entry) throw unsafe();
    const rights = entry[2]!.split(',');
    if (rights.some((right) => !aclRights.has(right))) throw unsafe();
    if (entry[1] === 'allow' && (privateFolder || rights.some((right) => aclWriteRights.has(right)))) throw unsafe();
  }
}

function ownedDirectory(folder: string, mode?: number, create = false, privateFolder = false): boolean {
  const owner = process.getuid?.();
  if (owner === undefined) throw new Error('remote install needs a local user id');
  if (!lstatSync(folder, { throwIfNoEntry: false })) {
    if (!create) return false;
    mkdirSync(folder, { mode: mode ?? 0o755 });
  }
  const entry = lstatSync(folder);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`remote install needs a real directory, not a symlink: ${folder}`);
  if (entry.uid !== owner) throw new Error(`remote install needs a directory owned by this user: ${folder}`);
  refuseOtherWriters(folder, entry.mode);
  const fd = openSync(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isDirectory() || opened.uid !== owner) throw new Error(`remote install needs a directory owned by this user: ${folder}`);
    refuseOtherWriters(folder, opened.mode);
    refuseOtherAclAccess(folder, privateFolder);
    if (create && mode !== undefined) fchmodSync(fd, mode);
  } finally { closeSync(fd); }
  return true;
}

function replaceFile(destination: string, contents: string | Buffer, mode: number): void {
  const fresh = `${destination}.${process.pid}.${randomBytes(8).toString('hex')}`;
  let fd: number | undefined;
  try {
    fd = openSync(fresh, 'wx', mode);
    writeFileSync(fd, contents);
    fchmodSync(fd, mode);
    closeSync(fd);
    fd = undefined;
    renameSync(fresh, destination);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(fresh); } catch { /* No fresh file to remove. */ }
    throw error;
  }
}

function installRemote(file: FileConfig | undefined): void {
  if (!file) throw new Error('remote install needs --config <file>');
  const port = file.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('remote install needs a fixed port from 1 to 65535');
  if (typeof file.tokenFile !== 'string' || !file.tokenFile) throw new Error('remote install needs tokenFile in the config');
  const node = arg('--node') ?? process.execPath;
  if (!isAbsolute(node)) throw new Error('--node must be an absolute path');
  const home = realpathSync(resolve(arg('--home') ?? homedir()));
  const source = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)));
  const mcp = source('mcp.ts'), client = source('client.ts');
  const version = createHash('sha256').update(mcp).update(client).digest('hex');
  const local = join(home, '.local'), userShare = join(local, 'share'), share = join(userShare, 'pipe');
  const installed = join(share, version);
  const launcher = join(share, 'pipe-mcp'), tokenCopy = join(share, 'token');
  const secret = token(file.tokenFile, false);
  const folders: [string, number?][] = [[local], [userShare], [share, 0o700], [installed, 0o700]];
  ownedDirectory(home);
  for (const [folder] of folders) if (!ownedDirectory(folder, undefined, false, folder === share || folder === installed)) break;
  for (const [folder, mode] of folders) ownedDirectory(folder, mode, true, folder === share || folder === installed);
  replaceFile(join(installed, 'mcp.ts'), mcp, 0o600);
  replaceFile(join(installed, 'client.ts'), client, 0o600);
  replaceFile(tokenCopy, `${secret}\n`, 0o600);
  replaceFile(launcher, `#!/bin/sh\nPATH=/usr/bin:/bin\nexport PATH\nPIPE_URL=${shellQuote(`http://127.0.0.1:${port}`)}\nPIPE_TOKEN=$(/bin/cat ${shellQuote(tokenCopy)})\nexport PIPE_URL PIPE_TOKEN\nexec ${shellQuote(node)} ${shellQuote(join(installed, 'mcp.ts'))}\n`, 0o755);
  process.stdout.write(`${JSON.stringify({ installed, launcher, mcp: { command: 'ssh', args: ['-T', '<this host>', shellQuote(launcher)] } })}\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2), help = argv[0] === 'help', configAt = argv.indexOf('--config');
  if (help && configAt > 0 && argv[configAt + 1] !== undefined) argv.splice(configAt, 2);
  const command = help ? argv[1] ?? 'help' : argv[0] ?? 'help';
  const spec = Object.hasOwn(CLI_COMMANDS, command) ? CLI_COMMANDS[command as keyof typeof CLI_COMMANDS] : undefined;
  if (help && (argv.length > (spec ? 2 : 1) || (!spec && command !== 'help')) && !process.argv.some(v => v === '--help' || v === '-h')) usageError('unknown help argument');
  if (process.argv.slice(2).some(v => v === '--help' || v === '-h') || help || command === 'help') return void process.stdout.write(
    (spec ? `Usage: pipe ${command} ${spec[0]} [--config <file>] [--help | -h]\n` : `Usage: pipe <command> [options]\nCommands: ${Object.keys(CLI_COMMANDS).join(', ')}\n`)
    + '--help or -h anywhere prints help, including in place of an option value.\n');
  if (!spec) return usageError(`unknown command: ${command}`);
  const id = argumentsFor(command, spec[0]!), dryRun = options.has('--dry-run');
  const file: FileConfig | undefined = arg('--config') ? JSON.parse(readFileSync(resolve(arg('--config')!), 'utf8')) : undefined;
  if (file) validateArgonModels(file);
  const preview = (method: string | null, path: string | null, body: unknown, operation?: string) =>
    process.stdout.write(`${JSON.stringify({ method, path, body: body ?? null, ...(operation ? { operation } : {}) })}\n`);
  if (['serve', 'remote', 'recover'].includes(command) && !file) throw new Error(`${command} needs --config <file>`);
  if (dryRun && ['serve', 'remote'].includes(command)) return void preview(null, null,
    { config: arg('--config'), ...(command === 'remote' ? { home: arg('--home') ?? homedir(), node: arg('--node') ?? process.execPath } : {}) }, command === 'remote' ? 'remote install' : command);
  if (command === 'gemini-models') {
    if (!file?.gemini) throw new Error('Gemini is not configured');
    const env = file.env ?? process.env, cli = resolveCli({ claude: file.gemini.cli }, env).claude;
    if (!cli) throw new Error('Gemini AGY CLI is not executable');
    process.stdout.write((await geminiModels({ ...file.gemini, cli }, env)).join('\n') + '\n');
    return;
  }
  if (command === 'remote') return installRemote(file);
  if (command === 'serve') {
    const pipe = await startPipe({ ...serveSettings(file!, dirname(dirname(fileURLToPath(import.meta.url)))), token: token(file!.tokenFile, true) });
    process.stderr.write(`pipe listening at ${pipe.url}\n`);
    return new Promise<void>((resolveStop) => {
      let finishing = false;
      const stop = () => {
        if (finishing) return;
        finishing = true;
        process.off('SIGINT', stop); process.off('SIGTERM', stop);
        pipe.stop().catch((e: unknown) => { process.stderr.write(`pipe stop failed: ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; }).finally(resolveStop);
      };
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
      void pipe.drained.then(() => { process.exitCode = serveExitCode(pipe.restartReason()); setTimeout(stop, 100); });
    });
  }
  if (command === 'recover') {
    const id = arg('--attempt'), supplied = arg('--outcome'), giveUp = options.has('--give-up');
    if ((supplied && giveUp) || (!!id !== !!(supplied || giveUp))) throw new Error('recover needs --attempt <id> with either --outcome <json> or --give-up');
    const outcome = supplied ? JSON.parse(supplied) as AttemptOutcome : undefined;
    if (dryRun) return void preview(null, null, { storePath: file!.storePath, attempt: id, outcome: outcome ?? null }, command);
    return void process.stdout.write(`${JSON.stringify({ unresolvedAttempts: recoverFailedStop(file!.storePath, id, outcome) })}\n`);
  }
  const dispatchSpec = command === 'worktrees' && id ? CLI_COMMANDS.worktrees.reset : spec;
  let method = dispatchSpec[2] ?? 'GET', path = dispatchSpec[1]!.replace('{id}', encodeURIComponent(id ?? '')), body: unknown;
  if (command === 'lease') {
    if (leaseAction === 'take') body = { account: id, holder: arg('--holder'), ttlSeconds: Number(arg('--ttl')), ...(arg('--purpose') === undefined ? {} : { purpose: arg('--purpose') }) };
    else { path += `/${encodeURIComponent(id!)}/${leaseAction}`; if (leaseAction === 'renew') body = { ttlSeconds: Number(arg('--ttl') ?? 300) }; }
  } else if (command === 'submit' || command === 'review-vote') {
    body = JSON.parse(readFileSync(0, 'utf8'));
    if (command === 'submit' && !validPlacement((body as NewRequest)?.placement)) throw new Error('placement must be ordinary_headroom when given');
  } else if (command === 'review') {
    if (id) path += `/${encodeURIComponent(id)}`;
    else {
      const lane = arg('--lane'), placement = arg('--placement');
      if (!validLane(lane)) throw new Error('--lane needs a non-empty label of at most 80 characters');
      if (!validPlacement(placement)) throw new Error('--placement must be ordinary_headroom when given');
      const repo = arg('--repo'), head = arg('--head'), briefFile = arg('--brief');
      if (!repo || !head || !briefFile) throw new Error('review needs --repo, --head and --brief');
      const records = (flag: string, names: string[], pattern: RegExp) => (options.get(flag) ?? []).map(value => {
        const parts = pattern.exec(value);
        if (!parts) throw new Error(`${flag} needs ${names.join(':')}`);
        return Object.fromEntries(names.map((name, index) => [name, parts[index + 1]]));
      });
      method = 'POST';
      body = { requester: 'local', reason: arg('--reason') ?? 'review requested', repo, head,
        brief: readFileSync(resolve(briefFile), 'utf8'),
        seats: records('--seat', ['provider', 'model', 'effort'], /^([^:]+):([^:]+):([^:]+)$/s),
        builders: records('--builder', ['family', 'context'], /^([^:]+):(.+)$/s),
        ...Object.fromEntries(['--base', '--repository', '--project', '--placement', '--lane'].filter(key => ['--base', '--repository', '--project'].includes(key) ? !!arg(key) : arg(key) !== undefined).map(key => [key.slice(2), arg(key)])),
        ...Object.fromEntries([['--context-packet', 'contextPacket'], ['--output-contract', 'outputContract']].filter(([flag]) => arg(flag!))
          .map(([flag, key]) => [key, strictUtf8(readFileSync(resolve(arg(flag!)!))) ?? usageError(`${flag} must name a UTF-8 text file`)])),
        priority: arg('--priority') ?? 'background' };
    }
  } else if (command === 'stats') {
    if (!validSince(arg('--since'))) throw new Error('stats needs --since YYYY-MM-DD, exactly once');
    path += `?since=${encodeURIComponent(arg('--since')!)}`;
  } else if (command === 'list') {
    const query = new URLSearchParams([...options].filter(([key]) => key === '--state' || key === '--requester').map(([key, values]) => [key.slice(2), values[0]!]));
    if (query.size) path += `?${query}`;
  } else if (command === 'status' && options.has('--selection')) path += '/status';
  else if (command === 'cancel' && arg('--by') !== undefined) body = { by: arg('--by') };
  if (dryRun) return void preview(method, path, body);
  const url = process.env.PIPE_URL ?? file?.url ?? (file?.port ? `http://127.0.0.1:${file.port}` : undefined);
  const secret = process.env.PIPE_TOKEN ?? (file ? token(file.tokenFile, false) : undefined);
  if (!url || !secret) throw new Error('set PIPE_URL and PIPE_TOKEN, or pass --config with a fixed port and tokenFile');
  if (command === 'drain') { process.stdout.write(`${JSON.stringify(await drainClient(url, secret))}\n`); return; }
  if (command === 'wait') {
    const seconds = Number(arg('--reconnect-seconds') ?? 600);
    if (!Number.isFinite(seconds * 1000) || seconds < 0)
      throw new Error('--reconnect-seconds must be a nonnegative number');
    for (;;) {
      const value = await requestJsonReconnecting(url, secret, path, seconds * 1000) as { request?: { state?: string } };
      if (['completed', 'failed', 'cancelled', 'start_mismatch'].includes(value.request?.state ?? '')) { process.stdout.write(`${JSON.stringify(value)}\n`); break; }
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
  } else process.stdout.write(`${JSON.stringify(await requestJson(url, secret, method, path, body))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((e) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exitCode ??= 1; });
}
