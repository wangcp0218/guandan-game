import assert from 'node:assert/strict';
import test from 'node:test';
import { Card, PatternType, Rank, Suit } from '../../../shared/types';
import { findBestPlay, generateLegalPlays } from './ai';
import { declarePatterns, identifyPattern, validWildSubstitutions } from './patterns';
import { canBeat } from './compare';
import type { AiDecisionContext } from './llmAi';

function cards(specs: Array<[Suit, Rank]>): Card[] {
  return specs.map(([suit, rank], index) => ({ id: index + 1, suit, rank }));
}

test('wildcards cannot supply a joker in pairs, triples, full houses or king bombs', () => {
  for (const joker of [Rank.SmallJoker, Rank.BigJoker]) {
    const illegalHands = [
      cards([[Suit.Heart, Rank.Two], [Suit.Spade, joker]]),
      cards([[Suit.Heart, Rank.Two], [Suit.Spade, joker], [Suit.Spade, joker]]),
      cards([[Suit.Heart, Rank.Two], [Suit.Spade, joker],
        [Suit.Spade, Rank.Three], [Suit.Club, Rank.Three], [Suit.Diamond, Rank.Three]]),
      cards([[Suit.Heart, Rank.Two], [Suit.Spade, Rank.SmallJoker],
        [Suit.Spade, Rank.SmallJoker], [Suit.Heart, Rank.BigJoker]]),
      cards([[Suit.Heart, Rank.Two], [Suit.Heart, Rank.Two],
        [Suit.Spade, Rank.SmallJoker], [Suit.Heart, Rank.BigJoker]]),
    ];
    for (const hand of illegalHands) {
      assert.equal(identifyPattern(hand, Rank.Two), null);
      assert.deepEqual(declarePatterns(hand, Rank.Two), []);
      assert.ok(!generateLegalPlays(hand, Rank.Two).some(play => play.cards.length === hand.length));
    }
    const wild = cards([[Suit.Heart, Rank.Two]]);
    assert.equal(validWildSubstitutions(wild, [{ ...wild[0], rank: joker }], Rank.Two), false);
    const legalHand = cards([
      [Suit.Heart, Rank.Two], [Suit.Spade, Rank.Three], [Suit.Club, Rank.Three],
      [Suit.Spade, joker], [Suit.Spade, joker],
    ]);
    assert.ok(declarePatterns(legalHand, Rank.Two).some(play => play.type === PatternType.TriplePair));
    assert.ok(generateLegalPlays(legalHand, Rank.Two).some(play => play.type === PatternType.TriplePair));
  }
});

test('wildcard straight retains ordinary declarations even with all-spade naturals', () => {
  const hand = cards([
    [Suit.Heart, Rank.Two], [Suit.Spade, Rank.Three],
    [Suit.Spade, Rank.Four], [Suit.Spade, Rank.Five], [Suit.Spade, Rank.Six],
  ]);
  const generated = generateLegalPlays(hand, Rank.Two).filter(play => play.cards.length === 5);
  for (const declaration of declarePatterns(hand, Rank.Two)) {
    assert.ok(generated.some(play => play.type === declaration.type && play.rank === declaration.rank));
  }
  for (const play of generated.filter(play => play.type === PatternType.Straight)) {
    const resolved = play.cards.map(card => play.substitutions?.find(item => item.id === card.id) || card);
    assert.ok(declarePatterns(resolved, -1).some(item => item.type === play.type && item.rank === play.rank));
  }
  const natural = cards([
    [Suit.Spade, Rank.Three], [Suit.Spade, Rank.Four], [Suit.Spade, Rank.Five],
    [Suit.Spade, Rank.Six], [Suit.Spade, Rank.Seven],
  ]);
  assert.ok(!generateLegalPlays(natural, Rank.Two).some(play => play.type === PatternType.Straight));
});

test('leading two intact bombs does not dismantle either bomb', () => {
  const hand = cards([
    [Suit.Spade, Rank.Three], [Suit.Heart, Rank.Three],
    [Suit.Club, Rank.Three], [Suit.Diamond, Rank.Three],
    [Suit.Spade, Rank.Nine], [Suit.Heart, Rank.Nine],
    [Suit.Club, Rank.Nine], [Suit.Diamond, Rank.Nine],
  ]);
  const play = findBestPlay(hand, null, true, Rank.Two);
  assert.equal(play?.type, PatternType.Bomb4);
  assert.equal(play?.rank, Rank.Three);
});

test('blocking spends the smaller sufficient bomb, but a full-hand finish wins', () => {
  const hand = cards([
    [Suit.Spade, Rank.Three], [Suit.Heart, Rank.Three],
    [Suit.Club, Rank.Three], [Suit.Diamond, Rank.Three],
    [Suit.Spade, Rank.Nine], [Suit.Heart, Rank.Nine],
    [Suit.Club, Rank.Nine], [Suit.Diamond, Rank.Nine],
    [Suit.Spade, Rank.Nine], [Suit.Heart, Rank.Nine], [Suit.Spade, Rank.Seven],
  ]);
  const context: AiDecisionContext = {
    selfSeatIndex: 0, partnerSeatIndex: 2, lastPlayPlayerIndex: 1,
    roundNumber: 1, teamLevels: [2, 2], leadingTeam: 0, recentActions: [],
    players: [
      { seatIndex: 0, cardCount: hand.length, finishRank: null, relation: 'self' },
      { seatIndex: 1, cardCount: 2, finishRank: null, relation: 'opponent' },
      { seatIndex: 2, cardCount: 10, finishRank: null, relation: 'partner' },
      { seatIndex: 3, cardCount: 10, finishRank: null, relation: 'opponent' },
    ],
  };
  const last = { type: PatternType.Single, rank: Rank.BigJoker, length: 1,
    cards: [{ id: 99, suit: Suit.Heart, rank: Rank.BigJoker }] };
  const play = findBestPlay(hand, last, false, Rank.Two, context)!;
  assert.equal(play.type, PatternType.Bomb4);
  assert.equal(play.rank, Rank.Three);
  assert.ok(canBeat(play, last, Rank.Two));
  const six = hand.filter(card => card.rank === Rank.Nine);
  assert.equal(findBestPlay(six, last, false, Rank.Two, context)?.type, PatternType.Bomb6);
  const opposingBomb = { ...last, type: PatternType.Bomb5, rank: Rank.Ace, length: 5 };
  assert.equal(findBestPlay(hand, opposingBomb, false, Rank.Two, context)?.type, PatternType.Bomb6);
});

test('exhaustive generator includes wildcard structures and every declaration is legal', () => {
  const hand = cards([
    [Suit.Heart, Rank.Two],
    [Suit.Spade, Rank.Three], [Suit.Club, Rank.Three],
    [Suit.Spade, Rank.Four], [Suit.Club, Rank.Four],
    [Suit.Spade, Rank.Five], [Suit.Club, Rank.Five],
    [Suit.Spade, Rank.Six], [Suit.Spade, Rank.Seven],
  ]);
  const plays = generateLegalPlays(hand, Rank.Two);

  for (const type of [
    PatternType.Pair,
    PatternType.Triple,
    PatternType.TriplePair,
    PatternType.Straight,
    PatternType.ConsecutivePair,
  ]) {
    assert.ok(plays.some(play => play.type === type), `missing ${type}`);
  }
  for (const play of plays) {
    assert.ok(
      declarePatterns(play.cards, Rank.Two).some(candidate =>
        candidate.type === play.type && candidate.rank === play.rank
      ),
      `generated an invalid declaration: ${play.type}/${play.rank}`,
    );
  }
});

test('generator keeps all physical pair choices instead of only the first pair', () => {
  const hand = cards([
    [Suit.Spade, Rank.Nine], [Suit.Heart, Rank.Nine],
    [Suit.Club, Rank.Nine], [Suit.Diamond, Rank.Nine],
  ]);
  const pairs = generateLegalPlays(hand, Rank.Two).filter(play => play.type === PatternType.Pair);
  assert.equal(pairs.length, 6);
});

test('generator covers wildcard bomb, steel plate and straight flush plus king bomb', () => {
  const wildcardBomb = generateLegalPlays(cards([
    [Suit.Heart, Rank.Two],
    [Suit.Spade, Rank.Six], [Suit.Heart, Rank.Six], [Suit.Club, Rank.Six],
  ]), Rank.Two);
  assert.ok(wildcardBomb.some(play => play.type === PatternType.Bomb4 && play.rank === Rank.Six));

  const wildcardPlane = generateLegalPlays(cards([
    [Suit.Heart, Rank.Two],
    [Suit.Spade, Rank.Three], [Suit.Heart, Rank.Three], [Suit.Club, Rank.Three],
    [Suit.Spade, Rank.Four], [Suit.Club, Rank.Four],
  ]), Rank.Two);
  assert.ok(wildcardPlane.some(play => play.type === PatternType.Plane));

  const wildcardFlush = generateLegalPlays(cards([
    [Suit.Heart, Rank.Two],
    [Suit.Spade, Rank.Three], [Suit.Spade, Rank.Four],
    [Suit.Spade, Rank.Five], [Suit.Spade, Rank.Six],
  ]), Rank.Two);
  assert.ok(wildcardFlush.some(play =>
    play.type === PatternType.FlushStraight && play.rank === Rank.Seven
  ));

  const jokers = generateLegalPlays(cards([
    [Suit.Spade, Rank.SmallJoker], [Suit.Spade, Rank.SmallJoker],
    [Suit.Heart, Rank.BigJoker], [Suit.Heart, Rank.BigJoker],
  ]), Rank.Two);
  assert.ok(jokers.some(play => play.type === PatternType.KingBomb));
});

test('Base7-style fallback leads a multi-card structure instead of a high single', () => {
  const hand = cards([
    [Suit.Spade, Rank.BigJoker],
    [Suit.Spade, Rank.Three], [Suit.Heart, Rank.Three],
    [Suit.Spade, Rank.Four], [Suit.Heart, Rank.Four],
    [Suit.Spade, Rank.Five], [Suit.Heart, Rank.Five],
  ]);
  const play = findBestPlay(hand, null, true, Rank.Two);
  assert.equal(play?.type, PatternType.ConsecutivePair);
});

test('Base7-style fallback does not overtake partner unless it can finish', () => {
  const hand = cards([[Suit.Spade, Rank.Five], [Suit.Spade, Rank.Six]]);
  const last = {
    type: PatternType.Single,
    cards: [{ id: 99, suit: Suit.Spade, rank: Rank.Four }],
    rank: Rank.Four,
    length: 1,
  };
  const context: AiDecisionContext = {
    selfSeatIndex: 0,
    partnerSeatIndex: 2,
    lastPlayPlayerIndex: 2,
    roundNumber: 1,
    teamLevels: [Rank.Two, Rank.Two],
    leadingTeam: 0,
    players: [
      { seatIndex: 0, cardCount: 2, finishRank: null, relation: 'self' },
      { seatIndex: 1, cardCount: 8, finishRank: null, relation: 'opponent' },
      { seatIndex: 2, cardCount: 4, finishRank: null, relation: 'partner' },
      { seatIndex: 3, cardCount: 8, finishRank: null, relation: 'opponent' },
    ],
    recentActions: [],
  };
  assert.equal(findBestPlay(hand, last, false, Rank.Two, context), null);
});
