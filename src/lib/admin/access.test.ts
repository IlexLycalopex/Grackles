import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planAccessChanges, cellName, accessKey } from './access.ts';
import type { MemberRole } from '../database.types';

const LP = 'lp';
const CP = 'cp';
const JAMIE = 'jamie';
const NICK = 'nick';

const now = new Map<string, MemberRole>([
  [accessKey(LP, JAMIE), 'owner'],
  [accessKey(LP, NICK), 'editor'],
  [accessKey(CP, JAMIE), 'owner'],
]);

test('untouched cells produce nothing', () => {
  const sent: [string, string][] = [
    [cellName(LP, NICK), 'editor'],
    [cellName(CP, NICK), ''],
  ];
  assert.deepEqual(planAccessChanges(now, sent), []);
});

test('an empty cell given a role is an addition', () => {
  assert.deepEqual(planAccessChanges(now, [[cellName(CP, NICK), 'viewer']]), [
    { kind: 'add', workspace: CP, user: NICK, role: 'viewer' },
  ]);
});

test('a role cleared is a removal', () => {
  assert.deepEqual(planAccessChanges(now, [[cellName(LP, NICK), '']]), [
    { kind: 'remove', workspace: LP, user: NICK, was: 'editor' },
  ]);
});

test('handing over ownership promotes before it demotes', () => {
  const plan = planAccessChanges(now, [
    [cellName(LP, JAMIE), 'editor'],
    [cellName(LP, NICK), 'owner'],
  ]);
  assert.deepEqual(plan.map(c => `${c.kind}:${c.user}`), ['role:nick', 'role:jamie']);
});

test('removals come last', () => {
  const plan = planAccessChanges(now, [
    [cellName(LP, NICK), ''],
    [cellName(CP, NICK), 'editor'],
  ]);
  assert.deepEqual(plan.map(c => c.kind), ['add', 'remove']);
});

test('anything that is not a cell or not a role is ignored', () => {
  assert.deepEqual(planAccessChanges(now, [['action', 'access'], [cellName(CP, NICK), 'admin']]), []);
});
