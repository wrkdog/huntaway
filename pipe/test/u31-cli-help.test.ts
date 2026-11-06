import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cli from '../src/cli.ts';

const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
// The base has no table. After the repair, derive coverage from its public usage table.
const table = (cli as { CLI_COMMANDS?: object }).CLI_COMMANDS;
const commands = table ? Object.keys(table)
  : [...new Set([...source.matchAll(/command === '([^']+)'/g)].map(m => m[1]!))];
const changing = ['serve', 'remote', 'recover', 'submit', 'review', 'review-vote', 'drain', 'cancel', 'prune', 'lease'];
const markedChanging = Object.entries(cli.CLI_COMMANDS).filter(([, spec]) => spec[3] === 'changing').map(([command]) => command);
const preload = `import { registerHooks } from 'node:module';
const effect = value => process.stderr.write('@effect ' + JSON.stringify(value) + '\\n');
globalThis.fetch = async (url, init) => { effect({method:init.method,path:new URL(url).pathname + new URL(url).search,body:init.body ? JSON.parse(init.body) : null});
  return new Response(JSON.stringify({draining:true,drained:true,running:0,request:{state:'completed'}})); };
registerHooks({load(url, context, next) {
  if (url.endsWith('/src/service.ts')) return {format:'module',shortCircuit:true,source:
    'export const startPipe = () => { process.stderr.write("@effect service\\\\n"); throw Error("service started"); };' +
    'export const recoverFailedStop = () => { process.stderr.write("@effect store\\\\n"); throw Error("store opened"); };' +
    'export const resolveCli = x => x;'};
  return next(url, context);
}});`;
function run(args: string[], input = '{}') {
  const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, 'src/cli.ts', ...args],
    { input, encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
      NODE_NO_WARNINGS: '1', PIPE_URL: 'http://127.0.0.1:12345', PIPE_TOKEN: 'fixture' } });
  assert.equal(result.error, undefined, String(result.error));
  return { ...result, effects: result.stderr.split('\n').filter(line => line.startsWith('@effect ')) };
}
function noEffects(result: ReturnType<typeof run>) { assert.deepEqual(result.effects, [], result.stderr); }
function usage(args: string[], command?: string) {
  const r = run(args); noEffects(r); assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, ''); assert.match(r.stdout, /usage: pipe /i);
  if (command) assert.ok(r.stdout.includes(`pipe ${command}`), r.stdout);
}

test('H0 command discovery covers the incident and all local entry points', () => {
  for (const command of changing) assert.ok(commands.includes(command), command);
  assert.deepEqual(markedChanging.toSorted(), changing.toSorted());
});
for (const command of commands) {
  for (const flag of ['--help', '-h']) test(`H1 ${command} ${flag} never acts, even before required inputs`, () => {
    usage([command, flag], command);
    usage([command, '--config', '/no/such/config', '--unknown', 'stray', flag], command);
  });
  test(`H2 ${command} refuses unknown flags before config or transport`, () => {
    for (const extra of [['--unknown'], ['--unknown', '--config', '/no/such/config']]) {
      const r = run([command, ...extra]); noEffects(r); assert.equal(r.status, 2, r.stderr);
      assert.equal(r.stdout, ''); assert.match(r.stderr, /^[^\n]*unknown[^\n]*\n$/i);
    }
  });
}
test('H3 global help and nested remote install help', () => {
  for (const args of [['--help'], ['-h'], ['help'], ['help', 'prune'], ['remote', 'install', '-h'],
    ['remote', 'install', '--config', '/no/such/config', '--home', '/no/such/home', '--help'],
    ['cancel', 'id', '--by', 'operator', '-h']]) usage(args);
});
test('H4 unknown commands, stray positionals and missing flag values are usage errors', () => {
  for (const args of [['missing'], ['--unknown'], ['help', '--unknown'], ['help', 'missing'], ['help', 'prune', 'stray'], ['prune', 'stray'], ['cancel', 'id', 'stray'], ['status', 'id', 'stray'],
    ['review', 'id', 'stray'], ['remote', 'other'], ['remote', 'install', 'stray'], ['serve', 'stray'],
    ['gemini-models', 'stray'], ['prune', '--config'], ['prune', '--config', '--x'], ['cancel', 'id', '--by'], ['wait', 'id', '--reconnect-seconds']]) {
    const r = run(args); noEffects(r); assert.equal(r.status, 2, `${args}: ${r.stderr}`);
    assert.equal(r.stdout, ''); assert.match(r.stderr, /^[^\n]+\n$/);
  }
});

test('H5 every changing command previews its actual HTTP request or explicitly local operation', t => {
  const root = mkdtempSync(join(tmpdir(), 'cli-help-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, 'config.json'), brief = join(root, 'brief.txt'), home = join(root, 'remote-home');
  mkdirSync(home);
  writeFileSync(config, JSON.stringify({ storePath: join(root, 'store.sqlite'), tokenFile: join(root, 'missing-token'), port: 12345 }));
  writeFileSync(brief, 'Review this exact change.');
  const cases: [string[], unknown, string?][] = [
    [['lease', 'take', 'a', '--holder', 'lane lead', '--ttl', '60'], { method: 'POST', path: '/v1/leases', body: { account: 'a', holder: 'lane lead', ttlSeconds: 60 } }],
    [['lease', 'renew', 'a/b'], { method: 'POST', path: '/v1/leases/a%2Fb/renew', body: { ttlSeconds: 300 } }],
    [['lease', 'release', 'a/b'], { method: 'POST', path: '/v1/leases/a%2Fb/release', body: null }],
    [['prune'], { method: 'POST', path: '/v1/worktrees/prune', body: null }],
    [['drain'], { method: 'POST', path: '/v1/drain?wait=500', body: null }],
    [['cancel', 'a/b', '--by', 'operator'], { method: 'POST', path: '/v1/requests/a%2Fb/cancel', body: { by: 'operator' } }],
    [['submit'], { method: 'POST', path: '/v1/requests', body: { prompt: 'fixture' } }, '{"prompt":"fixture"}'],
    [['review-vote', 'r/a'], { method: 'POST', path: '/v1/reviews/r%2Fa/votes', body: { verdict: 'approve' } }, '{"verdict":"approve"}'],
    [['review', '--repo', root, '--head', 'HEAD', '--brief', brief], { method: 'POST', path: '/v1/reviews', body:
      { requester: 'local', reason: 'review requested', repo: root, head: 'HEAD', brief: 'Review this exact change.', seats: [], builders: [], priority: 'background' } }],
    [['recover'], null], [['recover', '--attempt', 'a', '--give-up'], null], [['serve'], null],
    [['remote', 'install', '--home', home, '--node', process.execPath], null],
  ];
  assert.deepEqual([...new Set(cases.map(([args]) => args[0]))].toSorted(), markedChanging.toSorted());
  for (const command of markedChanging) for (const [args, expected, input] of cases.filter(([args]) => args[0] === command)) {
    const before = readdirSync(root, { recursive: true }).toSorted();
    if (expected === null) {
      const r = run([...args, '--config', config, '--dry-run']); noEffects(r); assert.equal(r.status, 0, r.stderr);
      const preview = JSON.parse(r.stdout); assert.equal(preview.method, null); assert.equal(preview.path, null);
      assert.equal(preview.operation, args[0] === 'remote' ? 'remote install' : args[0]);
      assert.ok(preview.body); assert.ok(!r.stdout.includes('fixture'), 'preview contains no token');
      assert.equal(existsSync(join(root, 'missing-token')), false, 'dry-run never creates the config token');
      assert.deepEqual(readdirSync(home, { recursive: true }), [], 'remote home stays empty');
      assert.deepEqual(readdirSync(root, { recursive: true }).toSorted(), before, 'local dry-run creates no files');
      continue;
    }
    const r = run([...args, '--dry-run'], input); noEffects(r); assert.equal(r.status, 0, `${args}: ${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), expected);
    assert.deepEqual(readdirSync(root, { recursive: true }).toSorted(), before, 'HTTP dry-run creates no files');
    const normal = run(args, input); assert.equal(normal.status, 0, normal.stderr);
    assert.deepEqual(normal.effects, [`@effect ${JSON.stringify(expected)}`]);
  }
  assert.deepEqual(run(['prune']).effects, ['@effect {"method":"POST","path":"/v1/worktrees/prune","body":null}']);
});

for (const args of [['help', '--config', 'x'], ['help', 'prune', '--config', 'x'], ['help', '--config', 'x', 'prune']]) {
  test(`H6 wrapper help ignores config without reading it: ${args.join(' ')}`, () => usage(args, args.includes('prune') ? 'prune' : undefined));
}
test('H7 help config remains bounded and help flags win even as option values', () => {
  for (const args of [['help', '--config'], ['help', '--config', 'x', '--config', 'y']]) {
    const r = run(args); noEffects(r); assert.equal(r.status, 2, r.stderr); assert.equal(r.stdout, '');
  }
  for (const flag of ['--help', '-h']) {
    usage(['list', '--requester', flag], 'list');
    usage(['cancel', 'id', '--by', flag], 'cancel');
    usage(['review', '--reason', flag], 'review');
  }
  const r = run(['help']); assert.match(r.stdout, /--help.*-h.*anywhere/i);
});
for (const command of ['list', 'cancel', 'review']) test(`H8 ${command} preserves dash-prefixed values in the intercepted request`, t => {
  const root = mkdtempSync(join(tmpdir(), 'cli-help-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const brief = join(root, 'brief.txt'); writeFileSync(brief, 'Review this exact change.');
  const cases: Record<string, [string[], unknown]> = {
    list: [['list', '--requester', '-alice'], { method: 'GET', path: '/v1/requests?requester=-alice', body: null }],
    cancel: [['cancel', 'a/b', '--by', '-alice'], { method: 'POST', path: '/v1/requests/a%2Fb/cancel', body: { by: '-alice' } }],
    review: [['review', '--repo', root, '--head', 'HEAD', '--brief', brief, '--reason', '- check safety'],
      { method: 'POST', path: '/v1/reviews', body: { requester: 'local', reason: '- check safety', repo: root, head: 'HEAD',
        brief: 'Review this exact change.', seats: [], builders: [], priority: 'background' } }],
  };
  const [args, expected] = cases[command]!;
  const r = run(args); assert.equal(r.status, 0, r.stderr); assert.deepEqual(r.effects, [`@effect ${JSON.stringify(expected)}`]);
});
test('H9 repeated config matches base first-value selection; other flags still reject repeats', t => {
  const root = mkdtempSync(join(tmpdir(), 'cli-help-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, 'config.json'); writeFileSync(config, '{}');
  const r = run(['prune', '--config', config, '--config', join(root, 'missing.json')]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.effects, ['@effect {"method":"POST","path":"/v1/worktrees/prune","body":null}']);
  for (const args of [['list', '--requester', 'a', '--requester', 'b'], ['cancel', 'id', '--by', 'a', '--by', 'b']]) {
    const repeated = run(args); noEffects(repeated); assert.equal(repeated.status, 2); assert.match(repeated.stderr, /repeated/);
  }
});
