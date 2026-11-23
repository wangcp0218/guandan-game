import assert from 'node:assert/strict';
import test from 'node:test';
import { GameRoom } from '../services/GameRoom';
import { createDeck } from './card';
import { generateLegalPlays, findBestPlay } from './ai';
import { identifyPattern } from './patterns';
import { canBeat } from './compare';
import { Card, GamePhase } from '../../../shared/types';

test('hint without a legal response auto-passes once and starts the next turn', () => {
  const room = new GameRoom('hint-pass', 'p0');
  for (let i = 0; i < 4; i++) room.addPlayer(`p${i}`, `P${i}`, 2, null);
  const deck = createDeck();
  try {
    room.startGame();
    room.state!.currentPlayerIndex = 0;
    room.state!.lastPlay = identifyPattern([deck.find(c => c.rank === 16)!], 2)!;
    room.state!.lastPlayPlayerIndex = 3;
    room.hands.set('p0', [deck.find(c => c.rank === 3)!]);
    const previousTimer = room.turnTimer;
    assert.deepEqual(room.requestHint('p0'), { cards: [], passed: true });
    assert.equal(room.state!.currentPlayerIndex, 1);
    assert.equal(room.state!.passCount, 1);
    assert.ok(room.turnTimer && room.turnTimer !== previousTimer);
    assert.ok(room.state!.actionDeadline! > Date.now());
    assert.equal(room.requestHint('p0'), null);
    assert.equal(room.state!.passCount, 1);
  } finally { room.clearPlayers(); }
});

test('hint preserves legal responses and never auto-passes a lead or invalid request', () => {
  const room = new GameRoom('hint-guards', 'p0');
  for (let i = 0; i < 4; i++) room.addPlayer(`p${i}`, `P${i}`, 2, null);
  const deck = createDeck();
  try {
    assert.equal(room.requestHint('p0'), null);
    room.startGame();
    room.state!.currentPlayerIndex = 0;
    const hand = [deck.find(c => c.rank === 4)!];
    room.hands.set('p0', hand);
    assert.deepEqual(room.requestHint('p0'), { cards: hand, passed: false });
    room.state!.lastPlay = identifyPattern([deck.find(c => c.rank === 3)!], 2)!;
    room.state!.lastPlayPlayerIndex = 3;
    assert.deepEqual(room.requestHint('p0'), { cards: hand, passed: false });
    assert.equal(room.requestHint('p1'), null);
    assert.equal(room.requestHint('spectator'), null);
    assert.equal(room.state!.currentPlayerIndex, 0);
    assert.equal(room.state!.passCount, 0);
    room.state!.phase = GamePhase.RoundEnd;
    assert.equal(room.requestHint('p0'), null);
  } finally { room.clearPlayers(); }
});

test('hint cycles every physical response including four tens and wraps', () => {
  const room = new GameRoom('hint-test', 'p0');
  for (let i = 0; i < 4; i++) room.addPlayer(`p${i}`, `P${i}`, 2, null);
  const deck = createDeck();
  const take = (rank: number, count: number) => deck.filter(c => c.rank === rank).slice(0, count);
  const hand = [...take(16, 1), ...take(2, 1), ...take(13, 1), ...take(12, 2),
    ...take(11, 1), ...take(10, 4), ...take(8, 3), ...take(7, 3),
    ...take(6, 2), ...take(5, 5), ...take(4, 2), ...take(3, 2)];
  try {
    room.startGame();
    room.state!.currentPlayerIndex = 0;
    room.hands.set('p0', hand);
    const last = identifyPattern([...take(11, 2), ...take(12, 2), ...take(13, 2)], 2)!;
    room.state!.lastPlay = last;
    const key = (cards: Card[]) => cards.map(c => c.id).sort((a, b) => a - b).join(',');
    const expected = new Set(generateLegalPlays(hand, 2).filter(p => canBeat(p, last, 2)).map(p => key(p.cards)));
    const seen = new Set<string>();
    let selection: Card[] = [];
    for (let i = 0; i < expected.size; i++) {
      selection = room.getHintCards('p0', selection.map(c => c.id));
      assert.ok(!seen.has(key(selection)));
      seen.add(key(selection));
    }
    assert.deepEqual(seen, expected);
    assert.ok(seen.has(key(take(10, 4))));
    assert.equal(key(room.getHintCards('p0', selection.map(c => c.id))), [...seen][0]);
  } finally { room.clearPlayers(); }
});

test('follow with a lower triple retaining the higher triple as potential recapture', () => {
  const deck = createDeck();
  const hand = [4, 14].flatMap(rank => deck.filter(c => c.rank === rank).slice(0, 3));
  const last = identifyPattern(deck.filter(c => c.rank === 3).slice(0, 3), 2)!;
  const result = findBestPlay(hand, last, false, 2)!;
  assert.equal(result.rank, 4);
  assert.equal(result.cards.length, 3);
});

test('leading hint does not break a bomb for the longest straight', () => {
  const room = new GameRoom('hint-lead', 'p0');
  for (let i = 0; i < 4; i++) room.addPlayer(`p${i}`, `P${i}`, 2, null);
  const deck = createDeck();
  const take = (rank: number, count: number) => deck.filter(c => c.rank === rank).slice(0, count);
  const hand = [...take(4, 1), ...take(5, 1), ...take(6, 1), ...take(7, 1), ...take(8, 1),
    ...take(9, 4), ...take(13, 1)];
  try {
    room.startGame();
    room.state!.currentPlayerIndex = 0;
    room.hands.set('p0', hand);
    const hint = room.getHintCards('p0', []);
    assert.ok(hint.length > 0);
    assert.ok(!hint.some(card => card.rank === 9),
      `first hint broke the four-nines bomb: ${hint.map(card => card.rank).join(',')}`);
  } finally { room.clearPlayers(); }
});
