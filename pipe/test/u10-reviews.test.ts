import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addExternalVote, approvedReviewModel, getReview, lastVerdict, quorum, refreshReviews, submitReview } from '../src/review.ts';
import { parsePolicy } from '../src/policy.ts';
import { Store } from '../src/store.ts';
import { runGit } from '../src/disk.ts';

test('review git ends an unresponsive process group at its deadline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-review-deadline-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const pidFile = join(root, 'git.pid');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n[ "$1" = warm ] && exit 0\necho $$ > "${pidFile}"\ntrap '' TERM\nwhile :; do /bin/sleep 1; done\n`);
  chmodSync(join(bin, 'git'), 0o755);
  // macOS may scan a new executable on its first run, which can take seconds under load: run it once first, so the
  // deadline below measures git, not the scan.
  execFileSync(join(bin, 'git'), ['warm']);
  const started = Date.now();
  // The deadline leaves a loaded machine time to start the shell and record its pid before the group is killed.
  await assert.rejects(runGit(root, ['status'], { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    undefined, undefined, { timeoutMs: 2_000 }), /timed out/);
  assert.ok(Date.now() - started < 10_000, 'the command ended after the kill grace');
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('the last verdict object controls a seat, including an invalid last answer', () => {
  const head = 'a'.repeat(40);
  const text = `first {"verdict":"APPROVE","head":"${head}"}\nlast {"verdict":"REVISE","head":"${head.slice(0, 12)}"}`;
  assert.deepEqual(lastVerdict(text, head), { verdict: 'REVISE' });
  assert.deepEqual(lastVerdict(`${text}\n{"verdict":"APPROVE","head":"deadbeef"}`, head), { reason: 'another head' });
  assert.deepEqual(lastVerdict(`broken {"text":"unfinished\n{"verdict":"APPROVE","head":"${head}"}`, head), { verdict: 'APPROVE' });
});

test('quorum needs both an OpenAI and an Anthropic approval from fresh contexts; Google is an optional extra', () => {
  const revision = 'a'.repeat(40), briefSha256 = 'b'.repeat(64);
  const models: Record<string, string> = { openai: 'gpt-6.1-sol', anthropic: 'claude-opus-5-5', google: 'gemini-3.8-flash-high' };
  const vote = (family: string, verdict: string, context: string) => ({ family, verdict, context, revision, briefSha256, requestedModel: models[family]!, reportedModel: models[family]! });
  const builders = [{ family: 'openai', context: 'builder' }];
  assert.equal(quorum([vote('openai', 'APPROVE', 'review-1'), vote('anthropic', 'APPROVE', 'review-2')], builders, revision, briefSha256).approved, true);
  assert.equal(quorum([vote('openai', 'APPROVE', 'review-1'), vote('anthropic', 'REVISE', 'review-2')], builders, revision, briefSha256).approved, false);
  assert.equal(quorum([vote('openai', 'APPROVE', 'review-1'), vote('anthropic', 'APPROVE', 'review-2')],
    [...builders, { family: 'anthropic', context: 'builder-2' }], revision, briefSha256).approved, true);
  assert.equal(quorum([vote('openai', 'APPROVE', 'review-1'), vote('anthropic', 'APPROVE', 'builder-2')],
    [...builders, { family: 'anthropic', context: 'builder-2' }], revision, briefSha256).approved, false);
  // Every revision is approved by both an OpenAI and an Anthropic seat.
  assert.equal(quorum([vote('openai', 'APPROVE', 'review-1'), vote('google', 'APPROVE', 'review-3')], builders, revision, briefSha256).approved, false,
    'OpenAI and Google without Anthropic is not approval');
  assert.equal(quorum([vote('anthropic', 'APPROVE', 'review-2'), vote('google', 'APPROVE', 'review-3')], builders, revision, briefSha256).approved, false,
    'Anthropic and Google without OpenAI is not approval');
  assert.equal(quorum([vote('openai', 'APPROVE', 'review-1'), vote('anthropic', 'APPROVE', 'review-2'), vote('google', 'REVISE', 'review-3')],
    builders, revision, briefSha256).approved, true, 'a Google vote is optional: OpenAI and Anthropic approving is approval');
  assert.equal(quorum([vote('openai', 'APPROVE', 'review-1'), { ...vote('anthropic', 'APPROVE', 'review-2'), revision: 'c'.repeat(40) }],
    builders, revision, briefSha256).approved, false);
});

test('a filtered review head is refused before checkout or any seat', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-review-filter-')), repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'reviewed.ts'), 'export const reviewed = true;\n');
  writeFileSync(join(repo, '.gitattributes'), '*.ts filter=x\n');
  const marker = join(root, 'smudge-ran'), smudge = join(root, 'smudge.sh');
  writeFileSync(smudge, `#!/bin/sh\ntouch "${marker}"\ncat\n`); chmodSync(smudge, 0o755);
  git('config', 'filter.x.smudge', `"${smudge}"`);
  git('add', '-A'); git('commit', '-q', '-m', 'filtered head');
  const store = new Store(join(root, 'record.sqlite'));
  const policy = parsePolicy({ codex: { models: { 'gpt-6.1-sol': 'default' }, efforts: ['low'] } });
  await assert.rejects(submitReview(store, policy, join(root, 'worktrees'), { requester: 'unit', reason: 'check code',
    repo, head: git('rev-parse', 'HEAD'), brief: 'Check the commit.',
    seats: [{ provider: 'codex', model: 'gpt-6.1-sol', effort: 'low' }] }), /filter.*reviewed\.ts/);
  assert.equal(existsSync(marker), false);
  assert.equal(git('worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length, 1);
  assert.equal((store.runningReviews()[0] as { seats: unknown[] }).seats.length, 0);
  store.close();
});

test('a review persists its seats, diff, and reserved contexts, then removes its detached worktree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-review-unit-')), repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'README.md'), 'committed\n'); git('add', '-A'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'reviewed.ts'), 'export const reviewed = true;\n');
  writeFileSync(join(repo, 'z-large.txt'), `${'x'.repeat(210 * 1024)}\n`);
  git('add', '-A'); git('commit', '-q', '-m', 'head');
  const head = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'README.md'), 'requester edits\n');
  const bin = join(root, 'bin'); mkdirSync(bin);
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const mark = join(root, 'git-started');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" worktree add "*) touch "${mark}"; sleep 0.3 ;; *" worktree remove "*) sleep 0.3 ;; esac\nexec "${realGit}" "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const path = join(root, 'record.sqlite'), store = new Store(path);
  const policy = parsePolicy({ codex: { models: { 'gpt-6.1-sol': 'default' }, efforts: ['low'] } });
  const pending = submitReview(store, policy, join(root, 'worktrees'), { requester: 'unit', reason: 'check code', repo, head, base,
    brief: 'Check the commit.\n', seats: [{ provider: 'codex', model: 'gpt-6.1-sol', effort: 'low' }] },
    { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` });
  assert.ok(pending instanceof Promise, 'submission returns before git finishes');
  assert.equal(existsSync(mark), false, 'the git worktree has not started before submission returns');
  const review = await pending;
  assert.ok(existsSync(mark), 'review git uses the supplied environment');
  assert.equal(review.state, 'running');
  assert.equal(review.seats.length, 1);
  const request = store.get(review.seats[0]!.requestId)!;
  assert.equal(request.mutating, false);
  assert.equal(request.project, 'review');
  assert.match(request.prompt, /\+export const reviewed = true;/);
  assert.match(request.prompt, /BEGIN DIFF/);
  assert.match(request.prompt, /DIFF CUT AFTER 200 KiB; changed files:/);
  assert.match(request.prompt, /z-large\.txt/);
  assert.notEqual(request.cwd, repo);
  assert.equal(execFileSync('git', ['-C', request.cwd!, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), head);
  store.close();
  const reopened = new Store(path);
  assert.equal(getReview(reopened, review.id)?.seats[0]?.requestId, request.id);
  reopened.fail(request.id, 'seat failed');
  refreshReviews(reopened, () => {}, { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` });
  const during = { family: 'google', verdict: 'APPROVE', context: 'during-cleanup', requestedModel: 'gemini-3.8-flash-high',
    reportedModel: 'gemini-3.8-flash-high', observedAt: new Date().toISOString(), revision: head, briefSha256: review.briefSha256 };
  addExternalVote(reopened, review.id, during);
  for (let i = 0; i < 100 && getReview(reopened, review.id)?.state !== 'finished'; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(getReview(reopened, review.id)?.state, 'finished');
  assert.equal(getReview(reopened, review.id)?.seats[0]?.reason, 'seat failed');
  assert.ok(getReview(reopened, review.id)?.receipt.votes.some((entry) => entry.context === 'during-cleanup'));
  assert.equal(git('worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length, 1);
  const vote = { family: 'google', verdict: 'APPROVE', context: 'external-session', requestedModel: 'gemini-3.8-flash-high',
    reportedModel: 'gemini-3.8-flash-high', observedAt: new Date().toISOString(), revision: head, briefSha256: review.briefSha256 };
  assert.throws(() => addExternalVote(reopened, review.id, { ...vote, context: `pipe-request-${request.id}` }), /context/);
  assert.equal(addExternalVote(reopened, review.id, vote)?.receipt.votes[0]?.external, true);
  assert.throws(() => addExternalVote(reopened, review.id, { ...vote, revision: 'a'.repeat(40) }), /revision/);
  assert.throws(() => addExternalVote(reopened, review.id, { ...vote, observedAt: '2025-02-30T01:00:00Z' }), /observedAt/);
  // A family named like an object's own property is refused as any other unknown family, never a crash (a 500).
  assert.throws(() => addExternalVote(reopened, review.id, { ...vote, family: 'constructor', context: 'odd-family' }),
    (e: Error) => e.name === 'ReviewError' && /not an approved review model/.test(e.message));
  // The list is explicit: a newer model is refused, and the refusal does not say newer ones are accepted.
  assert.throws(() => addExternalVote(reopened, review.id, { ...vote, family: 'anthropic', context: 'newer-opus',
    requestedModel: 'opus', reportedModel: 'claude-opus-6' }), (e: Error) => /not an approved review model/.test(e.message) && !/above|newer/.test(e.message));
  const emptyPath = join(root, 'worktrees', 'review-empty');
  git('worktree', 'add', '--detach', emptyPath, head);
  reopened.insertReview('empty', 'running', { ...getReview(reopened, review.id), worktree: emptyPath, seats: [] });
  refreshReviews(reopened, () => {});
  for (let i = 0; i < 100 && getReview(reopened, 'empty')?.state !== 'finished'; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(getReview(reopened, 'empty')?.state, 'finished');
  assert.equal(git('worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length, 1);
  reopened.close();
});

test('a diff over 4 MiB is cut to 200 KiB and a stat-only file list, never a second full patch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-review-huge-')), repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'README.md'), 'committed\n'); git('add', '-A'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'huge.txt'), `${'y'.repeat(99)}\n`.repeat(50 * 1024));   // 5 MiB: past the 4 MiB diff cap
  git('add', '-A'); git('commit', '-q', '-m', 'head');
  const head = git('rev-parse', 'HEAD');
  const store = new Store(join(root, 'record.sqlite'));
  const policy = parsePolicy({ codex: { models: { 'gpt-6.1-sol': 'default' }, efforts: ['low'] } });
  const review = await submitReview(store, policy, join(root, 'worktrees'), { requester: 'unit', reason: 'check code', repo, head, base,
    brief: 'Check the commit.\n', seats: [{ provider: 'codex', model: 'gpt-6.1-sol', effort: 'low' }] });
  const prompt = store.get(review.seats[0]!.requestId)!.prompt;
  assert.match(prompt, /DIFF CUT AFTER 200 KiB; changed files:\nhuge\.txt \| 51200 \++\n 1 file changed, 51200 insertions\(\+\)\nEND DIFF\n/);
  assert.ok(Buffer.byteLength(prompt) < 210 * 1024, `prompt holds ${Buffer.byteLength(prompt)} bytes`);
  store.close();
});

test('an interrupted setup accounts for every requested seat before finishing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-review-restart-'));
  const store = new Store(join(root, 'record.sqlite'));
  const requestedSeats = [{ provider: 'codex', model: 'gpt-6.1-sol', effort: 'low' },
    { provider: 'claude', model: 'opus', effort: 'high' }];
  store.insertReview('interrupted', 'running', { repo: root, head: 'a'.repeat(40), briefSha256: 'b'.repeat(64),
    worktree: join(root, 'absent'), seats: [], requestedSeats, receipt: { builders: [], votes: [] } });
  refreshReviews(store, () => {});
  for (let i = 0; i < 50 && getReview(store, 'interrupted')?.state !== 'finished'; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const review = getReview(store, 'interrupted')!;
  assert.equal(review.state, 'finished');
  assert.deepEqual(review.seats.map((seat) => [seat.provider, seat.model, seat.effort, seat.status]),
    requestedSeats.map((seat) => [seat.provider, seat.model, seat.effort, 'failed']));
  assert.ok(review.seats.every((seat) => seat.reason));
  store.close();
});

test('worktree removal retries, then records the tenth failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-review-cleanup-')), repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'README.md'), 'hello\n'); git('add', '-A'); git('commit', '-q', '-m', 'head');
  const head = git('rev-parse', 'HEAD'), worktree = join(root, 'worktree');
  git('worktree', 'add', '--detach', worktree, head);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const block = join(bin, 'block'), count = join(bin, 'count'); writeFileSync(block, '');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" worktree remove "*) if [ -e "${block}" ]; then printf x >> "${count}"; echo blocked >&2; exit 128; fi ;; esac\nexec "${realGit}" "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
  const store = new Store(join(root, 'record.sqlite'));
  store.insertReview('retry', 'running', { repo, head, briefSha256: 'b'.repeat(64), worktree, seats: [],
    receipt: { builders: [], votes: [] } });
  const logs: string[] = [];
  for (let i = 0; i < 2; i++) {
    refreshReviews(store, (where) => logs.push(where), env);
    for (let j = 0; j < 100 && readFileSync(count, { flag: 'a+' }).length <= i; j++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(getReview(store, 'retry')?.state, 'running');
  }
  rmSync(block);
  for (let i = 0; i < 100 && getReview(store, 'retry')?.state !== 'finished'; i++) {
    refreshReviews(store, (where) => logs.push(where), env);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(getReview(store, 'retry')?.state, 'finished');
  assert.equal(getReview(store, 'retry')?.cleanup, undefined);
  assert.equal(existsSync(worktree), false);
  assert.equal(logs.length, 1, 'only the first failed removal is logged before success');
  const left = join(root, 'left'); git('worktree', 'add', '--detach', left, head); writeFileSync(block, '');
  store.insertReview('give-up', 'running', { repo, head, briefSha256: 'b'.repeat(64), worktree: left, seats: [],
    receipt: { builders: [], votes: [] } });
  const logged: string[] = [];
  for (let i = 0; i < 500 && getReview(store, 'give-up')?.state !== 'finished'; i++) {
    refreshReviews(store, (where) => logged.push(where), env);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(getReview(store, 'give-up')?.state, 'finished');
  assert.match(getReview(store, 'give-up')?.cleanup ?? '', /remov/i);
  assert.equal(existsSync(left), true);
  assert.equal(logged.length, 2, 'only the first and tenth failures are logged');
  store.close();
});

test('annotated tag objects cannot be submitted as review head or base', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-review-tag-')), repo = join(root, 'repo'); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'README.md'), 'hello\n'); git('add', '-A'); git('commit', '-q', '-m', 'head');
  const head = git('rev-parse', 'HEAD'); git('tag', '-a', 'tag', '-m', 'tag', head);
  const tag = git('rev-parse', 'tag');
  const store = new Store(join(root, 'record.sqlite'));
  const policy = parsePolicy({ codex: { models: { 'gpt-6.1-sol': 'default' }, efforts: ['low'] } });
  const input = { requester: 'unit', reason: 'check code', repo, head, brief: 'Check.',
    seats: [{ provider: 'codex', model: 'gpt-6.1-sol', effort: 'low' }] };
  for (const over of [{ head: tag }, { base: tag }])
    await assert.rejects(submitReview(store, policy, join(root, 'worktrees'), { ...input, ...over }), /commit/);
  assert.equal(store.runningReviews().length, 0);
  store.close();
});

test('only approved review models vote: Opus 5.5 or Fable 5.1, Sol 6.1 or Astra, Gemini 3.8 (the list changes by a policy change)', () => {
  // An explicit allowlist; a model joins or leaves by a policy change.
  for (const [family, model] of [['anthropic', 'opus'], ['anthropic', 'fable'], ['anthropic', 'claude-opus-5-5'], ['anthropic', 'claude-fable-5-1'],
    ['anthropic', 'claude-opus-5-5-20260601'], ['anthropic', 'claude-opus-5-5[1m]'], ['anthropic', 'Claude-Opus-5-5'],
    ['anthropic', 'opus[1m]'], ['anthropic', 'claude-fable-5-1-20260901'], ['anthropic', 'claude-opus-5-5-20260601[1m]'], ['openai', 'gpt-6.1-sol'], ['openai', 'gpt-6-astra'],
    ['openai', 'gpt-6.1-sol-2026-09-01'], ['openai', 'GPT-6-Astra-2026-10-01'], ['google', 'gemini-3.8-flash-high'],
    ['anthropic', 'claude-opus-5-5-21000101'], ['openai', 'gpt-6.1-sol-1999-12-31'], ['anthropic', 'CLAUDE-OPUS-5-5[1M]'],
    ['google', 'gemini-3.8-pro'], ['google', 'gemini-3.8-flash'], ['google', 'gemini-3.8-pro-low']]) {
    assert.equal(approvedReviewModel(family!, model!), true, `${family} ${model}`);
  }
  for (const [family, model] of [['anthropic', 'sonnet'], ['anthropic', 'claude-sonnet-5'], ['anthropic', 'claude-haiku-4-5'],
    ['anthropic', 'claude-opus-5-0'], ['anthropic', 'claude-opus-4-8'], ['anthropic', 'claude-fable-5-0'], ['anthropic', 'claude-opus-5'],
    ['anthropic', 'claude-opus-5-20260401'], ['anthropic', 'claude-fable-5-20260401'], ['anthropic', 'claude-opus-5-55'],
    ['openai', 'gpt-5.5'], ['openai', 'gpt-6-mini'], ['openai', 'gpt-5-sol'], ['openai', 'gpt-6-solar'], ['openai', 'gpt-6-sol'], ['openai', 'gpt-6.1-sol-mini'], ['google', 'gemini-3.5-flash'],
    ['google', 'gemini-2.5-pro'], ['openai', 'claude-opus-5-5'], ['anthropic', 'gpt-6.1-sol'], ['xai', 'grok-5'],
    // Each family's own date form only, with a month 01-12 and a day 01-31; a context tag on Anthropic ids only, and only [1m].
    ['anthropic', 'claude-opus-5-5-99999999'], ['anthropic', 'claude-opus-5-5-20261341'], ['anthropic', 'claude-opus-5-5-2026-06-01'],
    ['anthropic', 'opus-20260601'], ['anthropic', 'claude-opus-5-5[2m]'], ['anthropic', 'claude-opus-5-5[1m]-20260601'], ['openai', 'gpt-6.1-sol-2026-0901'], ['openai', 'gpt-6.1-sol-20260901'],
    ['openai', 'gpt-6.1-sol-2026-13-01'], ['openai', 'gpt-6.1-sol[1m]'], ['google', 'gemini-3.8'], ['constructor', 'x'], ['__proto__', 'x'],
    // A character outside ASCII never stands in for one, although lowercasing maps the Kelvin sign to k.
    ['google', 'gemini-3.8-\u212Aflash'], ['google', 'gemini-3.8-flash-\u0130'], ['openai', 'gpt-6.1-\u017Fol'],
    // A lesser Gemini variant is another model, as -mini is for OpenAI.
    ['google', 'gemini-3.8-flash-lite'], ['google', 'gemini-3.8-nano'], ['google', 'gemini-3.8-.'], ['google', 'gemini-3.8-flash-high-x']]) {
    assert.equal(approvedReviewModel(family!, model!), false, `${family} ${model}`);
  }
  // A vote below the floor never counts toward a quorum.
  const revision = 'a'.repeat(40), briefSha256 = 'b'.repeat(64);
  const vote = (family: string, context: string, reportedModel: string, requestedModel = reportedModel) =>
    ({ family, verdict: 'APPROVE', context, revision, briefSha256, requestedModel, reportedModel });
  assert.equal(quorum([vote('openai', 'r-1', 'gpt-6.1-sol'), vote('anthropic', 'r-2', 'claude-sonnet-5')], [], revision, briefSha256).approved, false,
    'a Sonnet seat is not an Anthropic vote');
  assert.equal(quorum([vote('openai', 'r-1', 'unknown', 'gpt-6.1-sol'), vote('anthropic', 'r-2', 'claude-opus-5-5')], [], revision, briefSha256).approved, true,
    'an unknown reported model falls back to the requested one');
  // A dissent always counts, whatever its model: a REVISE is never dropped to let an approval through.
  assert.equal(quorum([vote('openai', 'r-1', 'gpt-6.1-sol'), vote('anthropic', 'r-2', 'claude-fable-5-1'),
    { ...vote('anthropic', 'r-3', 'claude-opus-6', 'opus'), verdict: 'REVISE' }], [], revision, briefSha256).approved, false,
    'a REVISE from a model off the list still blocks its family');
});

test('GPT-6.1 Sol replaces Sol 6.0 on the approved review models for OpenAI, by explicit name', () => {
  for (const model of ['gpt-6.1-sol', 'GPT-6.1-SOL', 'gpt-6.1-sol-2026-09-29', 'gpt-6-astra']) {
    assert.equal(approvedReviewModel('openai', model), true, `openai ${model}`);
  }
  // No further use of Sol 6.0.
  for (const model of ['gpt-6-sol', 'gpt-6-sol-2026-09-01', 'gpt-6.1-astra', 'gpt-6.2-sol', 'gpt-6.10-sol', 'gpt-6.1', 'gpt-6.1-sol-mini', 'gpt-6.1-sol-2026-13-01']) {
    assert.equal(approvedReviewModel('openai', model), false, `openai ${model}`);
  }
});

test('a seat on a model the policy allows but review does not is refused, and a stored quorum is recomputed on read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-review-models-')), repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'lead@example.invalid'); git('config', 'user.name', 'Lead');
  writeFileSync(join(repo, 'a.txt'), 'a\n'); git('add', '-A'); git('commit', '-q', '-m', 'a');
  const store = new Store(join(root, 'store.sqlite'));
  try {
    const policy = parsePolicy({ claude: { models: { sonnet: 'default', opus: 'hard' }, efforts: ['high'] } });
    await assert.rejects(submitReview(store, policy, join(root, 'worktrees'), { requester: 'lead', reason: 'check', repo, head: git('rev-parse', 'HEAD'),
      brief: 'Check it.\n', seats: [{ provider: 'claude', model: 'sonnet', effort: 'high' }] }), /not an approved review model/);
    // A receipt saved under the earlier any-two-families rule: OpenAI and Google approving, stored as approved.
    const review = await submitReview(store, policy, join(root, 'worktrees'), { requester: 'lead', reason: 'check', repo,
      head: git('rev-parse', 'HEAD'), brief: 'Check it.\n', seats: [{ provider: 'claude', model: 'opus', effort: 'high' }] });
    const saved = store.review(review.id) as { receipt: Record<string, unknown> };
    const old = (family: string, model: string) => ({ family, verdict: 'APPROVE', context: `old-${family}`, requestedModel: model,
      reportedModel: model, observedAt: new Date().toISOString(), revision: review.head, briefSha256: review.briefSha256, external: true });
    saved.receipt.votes = [old('openai', 'gpt-6.1-sol'), old('google', 'gemini-3.8-flash-high')];
    saved.receipt.quorum = { approved: true, votingFamilies: ['google', 'openai'], approvingFamilies: ['google', 'openai'] };
    store.updateReview(review.id, 'running', saved);
    assert.equal(getReview(store, review.id)!.receipt.quorum.approved, false, 'read under today\'s rule');
  } finally { store.close(); }
});
