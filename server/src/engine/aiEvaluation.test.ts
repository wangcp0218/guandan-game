import assert from 'node:assert/strict';
import test from 'node:test';
import { Rank } from '../../../shared/types';
import { createDeck } from './card';
import { findBestPlay } from './ai';
import { seededRandom, simulateEvaluationRound } from './aiEvaluation';

test('seeded evaluation RNG is reproducible', () => {
  const left = seededRandom(42);
  const right = seededRandom(42);
  assert.deepEqual(
    Array.from({ length: 5 }, () => left()),
    Array.from({ length: 5 }, () => right()),
  );
});

test('evaluation round completes without exposing hidden hands to policies', () => {
  const deck = createDeck();
  const hands = [[deck[0]], [deck[1]], [deck[2]], [deck[3]]];
  const result = simulateEvaluationRound(
    hands, Rank.Two, [findBestPlay, findBestPlay, findBestPlay, findBestPlay],
  );
  assert.ok(result.steps > 0);
  assert.ok(result.winnerTeam === 0 || result.winnerTeam === 1);
  assert.ok([2, 3, 4].includes(result.partnerRank));
});
