import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { PROVIDERS, type Provider } from './policy.ts';

export type AccountConfig = {
  id: string;
  provider: Provider;
  loginDir: string;
  fingerprint: string;
  maxConcurrency: number;
  preference?: number;
  enabled: boolean;
  displayName?: string;
};

export class AccountConfigError extends Error {
  override name = 'AccountConfigError';
}

// Each provider CLI's own login folder, used by the owner's interactive sessions.
const DEFAULT_LOGIN_DIRS: Record<Provider, string> = {
  claude: join(homedir(), '.claude'), codex: join(homedir(), '.codex'), gemini: join(homedir(), '.gemini'),
};

export function validateAccounts(
  accounts: readonly AccountConfig[],
  options: { defaultLoginDirs?: Partial<Record<Provider, string>> } = {},
): void {
  const defaults = new Map<string, Provider>();
  for (const provider of PROVIDERS) {
    const dir = options.defaultLoginDirs?.[provider] ?? DEFAULT_LOGIN_DIRS[provider];
    const key = existingFolderKey(dir);
    if (key !== null) defaults.set(`${provider}\0${key}`, provider);
  }
  const ids = new Set<string>();
  const pins = new Map<string, string>();
  const folders = new Map<string, string>();
  for (const a of accounts) {
    const fail = (why: string) => new AccountConfigError(`account "${a.id}": ${why}`);
    if (typeof a.id !== 'string' || a.id.trim() === '') throw new AccountConfigError('an account has no id');
    if (ids.has(a.id)) throw fail('the id is used twice');
    ids.add(a.id);
    if (!(PROVIDERS as readonly string[]).includes(a.provider)) throw fail(`unknown provider "${a.provider}"`);
    if (typeof a.fingerprint !== 'string' || a.fingerprint.trim() === '') throw fail('no pinned login (fingerprint)');
    if (!Number.isInteger(a.maxConcurrency) || a.maxConcurrency < 1) throw fail(`maxConcurrency must be a whole number of at least 1, not ${a.maxConcurrency}`);
    if (a.preference !== undefined && (!Number.isInteger(a.preference) || a.preference < 0 || a.preference > 100)) throw fail('preference must be a whole number from 0 to 100');
    if (typeof a.enabled !== 'boolean') throw fail('enabled must be true or false');
    const shown = a.displayName;
    if (shown !== undefined && (typeof shown !== 'string' || shown === '' || shown !== shown.trim() || [...shown].length > 40
      || /[\p{Cc}\p{Cf}\p{Cs}\p{Cn}\p{Zl}\p{Zp}]/u.test(shown))) {
      throw fail('displayName must be 1 to 40 characters, without surrounding spaces or control, format or separator characters');
    }

    // A fingerprint is the first 8 hex digits of sha256 of the login's stable id: Claude's
    // orgId (or its email when there is no org), Codex's chatgptAccountId. One person may use
    // the same identity with several providers, so a pin is unique within its provider.
    const pin = `${a.provider}\0${a.fingerprint}`;
    const pinnedBy = pins.get(pin);
    if (pinnedBy !== undefined) throw fail(`pins the same ${a.provider} login as "${pinnedBy}"`);
    pins.set(pin, a.id);

    if (typeof a.loginDir !== 'string' || !isAbsolute(a.loginDir)) throw fail(`loginDir must be an absolute path, not "${a.loginDir}"`);
    const folder = folderKey(a.loginDir, fail);
    if (defaults.has(`${a.provider}\0${folder}`)) throw fail(`loginDir ${a.loginDir} is the ${a.provider} CLI's default login folder; give the account its own`);
    const usedBy = folders.get(folder);
    if (usedBy !== undefined) throw fail(`loginDir ${a.loginDir} is the same folder as "${usedBy}"'s`);
    folders.set(folder, a.id);
  }
  // Cards and health name an account by its displayName or id, and logs and the full record by its id: every id is
  // unique whatever its case, and a displayName is nobody else's id or displayName (compared after NFKC, lowercased).
  const key = (name: string) => name.normalize('NFKC').toLowerCase();
  const owner = new Map<string, string>();
  for (const a of accounts) {
    const other = owner.get(key(a.id));
    if (other !== undefined) throw new AccountConfigError(`account "${a.id}": its id is also account "${other}"'s, whatever the case`);
    owner.set(key(a.id), a.id);
  }
  for (const a of accounts) {
    if (a.displayName === undefined) continue;
    const other = owner.get(key(a.displayName));
    if (other !== undefined && other !== a.id) throw new AccountConfigError(`account "${a.id}": its displayName is also account "${other}"'s name`);
    owner.set(key(a.displayName), a.id);
  }
}

function existingFolderKey(dir: string): string | null {
  try { return folderKey(dir, (why) => new Error(why)); } catch { return null; }
}

// Device and inode name the real folder, whatever path reaches it: symlinks, "..", and
// letter case on case-insensitive disks all resolve to the same pair.
function folderKey(dir: string, fail: (why: string) => Error): string {
  let st;
  try {
    st = statSync(dir, { bigint: true });
  } catch (e) {
    throw fail(`loginDir ${dir} cannot be read (${(e as NodeJS.ErrnoException).code ?? String(e)}); create it before adding the account`);
  }
  if (!st.isDirectory()) throw fail(`loginDir ${dir} is not a folder`);
  // Some network file systems report 0 for these; fall back to the resolved path there.
  if (st.dev === 0n || st.ino === 0n) return `path:${realpathSync(dir)}`;
  return `inode:${st.dev}:${st.ino}`;
}
