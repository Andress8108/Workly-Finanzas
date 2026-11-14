import assert from 'node:assert/strict';
import test from 'node:test';
import { getAvailableBudget } from '../src/utils/budget_rules.js';

test('available budget excludes both purchases and approved reservations', () => {
  assert.equal(
    getAvailableBudget({ budget: 5_000_000, spent: 0, reservedBudget: 1_500_000 }),
    3_500_000,
  );
});

test('available budget never reports a negative amount', () => {
  assert.equal(
    getAvailableBudget({ budget: 5_000_000, spent: 4_000_000, reservedBudget: 2_000_000 }),
    0,
  );
});
