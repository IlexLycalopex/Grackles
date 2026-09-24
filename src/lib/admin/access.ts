import type { MemberRole } from '../database.types';

/**
 * The access grid's Apply button, as a list of calls.
 *
 * Every cell is a select named `cell:<workspace>:<user>`. The browser sends
 * all of them, so this compares what came back with what is true now and keeps
 * only the ones that differ — a cell nobody touched is never written, and a
 * cell that is disabled (a project's only owner) is not sent at all, which
 * reads as unchanged.
 *
 * Order matters because of the last-owner guard. Handing a project from one
 * owner to another in a single Apply means promoting the new owner before the
 * old one is demoted or removed, or the database refuses the demotion. So:
 * everything that adds an owner first, then other additions and changes, then
 * demotions of owners, then removals.
 */

export type Change =
  | { kind: 'add'; workspace: string; user: string; role: MemberRole }
  | { kind: 'role'; workspace: string; user: string; role: MemberRole; was: MemberRole }
  | { kind: 'remove'; workspace: string; user: string; was: MemberRole };

const ROLES: readonly MemberRole[] = ['viewer', 'editor', 'owner'];

export const cellName = (workspace: string, user: string) => `cell:${workspace}:${user}`;
const key = (workspace: string, user: string) => `${workspace}:${user}`;

/** `current` maps "workspace:user" to a role; absence means not a member. */
export function planAccessChanges(
  current: Map<string, MemberRole>,
  submitted: Iterable<[string, string]>
): Change[] {
  const changes: Change[] = [];

  for (const [name, raw] of submitted) {
    const m = /^cell:([^:]+):([^:]+)$/.exec(name);
    if (!m) continue;
    const [, workspace, user] = m;
    const want = raw === '' ? null : (ROLES.includes(raw as MemberRole) ? (raw as MemberRole) : undefined);
    if (want === undefined) continue; // Not a role: ignored rather than guessed at.
    const was = current.get(key(workspace, user)) ?? null;
    if (want === was) continue;

    if (was === null) changes.push({ kind: 'add', workspace, user, role: want! });
    else if (want === null) changes.push({ kind: 'remove', workspace, user, was });
    else changes.push({ kind: 'role', workspace, user, role: want, was });
  }

  const rank = (c: Change) => {
    if (c.kind !== 'remove' && c.role === 'owner') return 0;
    if (c.kind === 'add') return 1;
    if (c.kind === 'role' && c.was !== 'owner') return 1;
    if (c.kind === 'role') return 2;
    return 3;
  };
  return changes.sort((a, b) => rank(a) - rank(b));
}

export const accessKey = key;
