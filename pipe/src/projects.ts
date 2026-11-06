/** Optional per-project prompt additions: a context packet and a review output contract. Off when absent (u42). */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';

type ProjectFile = { path: string; maxBytes?: number };
export type Projects = Record<string, { contextPacket?: ProjectFile; review?: { outputContract?: ProjectFile } }>;
export type ProjectText = { text: string; sha256: string };
const plain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every((key) => keys.includes(key));
const fileOk = (v: unknown) => v === undefined || plain(v) && only(v, ['path', 'maxBytes']) && typeof v.path === 'string' &&
  isAbsolute(v.path) && (v.maxBytes === undefined || Number.isInteger(v.maxBytes) && (v.maxBytes as number) >= 1 && (v.maxBytes as number) <= 262_144);

export function validateProjects(projects: unknown): void {
  if (projects === undefined) return;
  if (!plain(projects)) throw new Error('projects must map project names to their settings');
  for (const [name, p] of Object.entries(projects)) {
    if (!name.trim() || !plain(p) || !only(p, ['contextPacket', 'review']) || !fileOk(p.contextPacket) ||
      p.review !== undefined && (!plain(p.review) || !only(p.review, ['outputContract']) || !fileOk(p.review.outputContract)))
      throw new Error(`projects.${name}: contextPacket and review.outputContract take an absolute path and an optional maxBytes from 1 to 262144`);
  }
}

/** Strict UTF-8 that keeps a BOM, so the text and its hash name the same bytes; undefined for bytes that are not UTF-8. */
export function strictUtf8(bytes: Uint8Array): string | undefined {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return undefined; }
}

/** Read at use, so an edit reaches the next request; refuse a missing, special, empty, oversized or non-UTF-8 file. */
function read(label: string, file: ProjectFile): ProjectText | { error: string } {
  const max = file.maxBytes ?? 65_536, what = `${label} ${file.path}`, buffer = Buffer.alloc(max + 1);
  let fd: number, length = 0, n = 0;
  try { fd = openSync(file.path, constants.O_RDONLY | constants.O_NONBLOCK); }   // a FIFO cannot block the service
  catch { return { error: `${what} is missing or unreadable` }; }
  try {
    if (!fstatSync(fd).isFile()) return { error: `${what} is not a regular file` };
    // Never read past the cap, even if the file grows after fstat.
    while (length <= max && (n = readSync(fd, buffer, length, max + 1 - length, null)) > 0) length += n;
    if (length > max) return { error: `${what} exceeds its ${max}-byte cap` };
    const bytes = buffer.subarray(0, length), text = strictUtf8(bytes);
    if (text === undefined) return { error: `${what} is not valid UTF-8` };
    if (text.trim() === '') return { error: `${what} is empty or blank` };   // blank text would match any prompt's skip
    return { text, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch { return { error: `${what} is missing or unreadable` }; }
  finally { closeSync(fd); }
}

/** The project's packet or contract; undefined for a project that sets none. */
export function projectText(projects: Projects | undefined, project: unknown, kind: 'contextPacket' | 'outputContract'): ProjectText | { error: string } | undefined {
  const settings = typeof project === 'string' && projects && Object.hasOwn(projects, project) ? projects[project]! : undefined;
  const file = kind === 'contextPacket' ? settings?.contextPacket : settings?.review?.outputContract;
  return file && read(`${kind === 'contextPacket' ? 'context packet' : 'output contract'} for project ${project}`, file);
}

/** The packet goes before the prompt under a fixed header, once: a caller whose own text holds it already gets no copy
 * (pass an empty `caller` to always add it, as for text sent with the call). */
export const withPacket = (prompt: string, project: string, packet: ProjectText, caller = prompt): string => caller.includes(packet.text) ? prompt :
  `Project context for ${project.replace(/\s+/g, ' ')}, SHA-256 ${packet.sha256}: background for the request after END PROJECT CONTEXT.\n` +
  `BEGIN PROJECT CONTEXT\n${packet.text}\nEND PROJECT CONTEXT\n\n${prompt}`;

/** Text sent with one request replaces the project's file for that request only (u42 discoverability). */
export const inlineText = (v: unknown): ProjectText | undefined => typeof v === 'string' && v.trim() !== '' && v.isWellFormed() && Buffer.byteLength(v) <= 262_144
  ? { text: v, sha256: createHash('sha256').update(v).digest('hex') } : undefined;

/** Which projects set which text: names and booleans only, never a path. */
export const configuredProjects = (projects: Projects | undefined) => Object.fromEntries(Object.entries(projects ?? {})
  .map(([name, p]) => [name, { contextPacket: p.contextPacket !== undefined, outputContract: p.review?.outputContract !== undefined }]));

/** One line pointing at the opt-in, once per project per service start, for a project that sets neither text. */
export function projectHint(projects: Projects | undefined, hinted: Set<string>, project: unknown): string | undefined {
  const name = typeof project === 'string' ? project.replace(/\s+/g, ' ').slice(0, 80) : '';
  const settings = typeof project === 'string' && projects && Object.hasOwn(projects, project) ? projects[project] : undefined;
  if (settings?.contextPacket || settings?.review?.outputContract || hinted.has(name) || hinted.size >= 1_000) return undefined;
  hinted.add(name);
  const key = `projects.${name || '<name>'}`;
  return `${name ? `Project ${name} has` : 'This request names no project (send project), so it has'} no context packet or review output ` +
    `contract: set ${key}.contextPacket and ${key}.review.outputContract in the Pipe config, or pass contextPacket / outputContract on a call ` +
    '(README: "Project context packets and review output contracts"). Shown once per project per service start.';
}
