import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCigar, cigarSlug, type CigarValues } from './cigar.ts';

/**
 * The coherence rules between a cigar's status and its dates.
 *
 * These are worth testing because they are stated twice — here and as CHECK
 * constraints on `cl_cigars` — and the two halves have different jobs. The
 * database's copy is the guarantee; this one exists so a mistake comes back as
 * a sentence instead of a 23514, and a sentence that never fires is a sentence
 * nobody notices has stopped matching the rule beside it.
 *
 * The wishlist is what makes them worth testing *now*: every one of these was
 * written when there were two statuses, and the interesting cases are the ones
 * where "not smoked" and "in the humidor" have stopped being the same thing.
 */
const form = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

const ok = (fields: Record<string, string>): CigarValues => {
  const r = readCigar(form(fields));
  assert.equal(r.ok, true, r.ok ? '' : `refused: ${r.error}`);
  return r.ok ? r.values : (undefined as never);
};

const refused = (fields: Record<string, string>): string => {
  const r = readCigar(form(fields));
  assert.equal(r.ok, false, 'expected a refusal');
  return r.ok ? (undefined as never) : r.error;
};

test('a wishlist entry needs nothing but a name', () => {
  const values = ok({ status: 'wishlist', name: 'Serie D No. 4' });
  assert.equal(values.status, 'wishlist');
  assert.equal(values.date_acquired, null);
  assert.equal(values.date_smoked, null);
  assert.equal(values.quantity, 1);
});

test('a wishlist entry may want more than one', () => {
  assert.equal(ok({ status: 'wishlist', name: 'X', quantity: '3' }).quantity, 3);
});

test('a wishlist entry cannot carry a date acquired', () => {
  // Having it is what the humidor is, so this is a move somebody half-made
  // rather than a state the app should store.
  const error = refused({ status: 'wishlist', name: 'X', date_acquired: '2026-08-14' });
  assert.match(error, /humidor/);
});

test('a wishlist entry cannot carry a date smoked', () => {
  // The rule this replaced only spoke about the humidor, so a wishlist entry
  // with a smoked date went straight through it.
  refused({ status: 'wishlist', name: 'X', date_smoked: '2026-08-14' });
});

test('a humidor entry still cannot carry a date smoked', () => {
  refused({ status: 'humidor', name: 'X', date_smoked: '2026-08-14' });
});

test('a smoked entry still needs its date', () => {
  refused({ status: 'smoked', name: 'X' });
  assert.equal(ok({ status: 'smoked', name: 'X', date_smoked: '2026-08-14' }).date_smoked, '2026-08-14');
});

test('an unrecognised status falls back to smoked rather than being written', () => {
  // `choice()` falls back rather than refusing, so the fallback has to be one
  // the database will accept — and then the smoked rules apply to it.
  refused({ status: 'someday', name: 'X' });
  assert.equal(ok({ status: 'someday', name: 'X', date_smoked: '2026-08-14' }).status, 'smoked');
});

test('a wishlist entry is slugged with the day it was wished for', () => {
  const values = ok({ status: 'wishlist', name: 'Serie D No. 4', brand: 'Partagás' });
  // Neither date is set, so the slug falls through to today's — which is what
  // keeps two wishes for the same cigar from colliding on the unique index.
  assert.equal(cigarSlug(values, '2026-08-17'), '2026-08-17-partagas-serie-d-no-4');
});
