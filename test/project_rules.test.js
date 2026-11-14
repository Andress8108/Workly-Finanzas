import assert from 'node:assert/strict';
import test from 'node:test';
import { validateProjectDates } from '../src/utils/project_rules.js';

const now = new Date('2026-06-15T12:00:00.000Z');

test('rejects project start dates that are today or earlier when creating', () => {
  assert.equal(
    validateProjectDates(new Date('2026-06-15T00:00:00.000Z'), null, {
      requireFutureDates: true,
      now,
    }),
    'La fecha de inicio debe ser posterior a hoy',
  );
});

test('rejects a project end date that is not in the future when creating', () => {
  assert.equal(
    validateProjectDates(
      new Date('2026-06-16T00:00:00.000Z'),
      new Date('2026-06-15T00:00:00.000Z'),
      { requireFutureDates: true, now },
    ),
    'La fecha de fin debe ser posterior a hoy',
  );
});

test('accepts future project dates and keeps historical edits valid', () => {
  assert.equal(
    validateProjectDates(
      new Date('2026-06-16T00:00:00.000Z'),
      new Date('2026-06-17T00:00:00.000Z'),
      { requireFutureDates: true, now },
    ),
    null,
  );
  assert.equal(
    validateProjectDates(
      new Date('2020-06-15T00:00:00.000Z'),
      new Date('2021-06-15T00:00:00.000Z'),
    ),
    null,
  );
});
