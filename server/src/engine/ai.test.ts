import assert from 'node:assert/strict';
import test from 'node:test';
import { Card, PatternType, Rank, Suit } from '../../../shared/types';
import {
  compressCandidatesForModel, enforceTeamStrategy, findBestPlay, generateLegalPlays, limitModelCandidates,
  isForcedAiDecision, opponentControlStreak, reliablyBetterSimulation, roundStake, scorePass, scorePlay,
  shouldUseLlmForDecision,
} from './ai';
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

test('model candidates merge equivalent physical choices without losing declared strategies', () => {
  const hand = cards([
    [Suit.Spade, Rank.Nine], [Suit.Heart, Rank.Nine],
    [Suit.Club, Rank.Nine], [Suit.Diamond, Rank.Nine],
    [Suit.Spade, Rank.Ace], [Suit.Heart, Rank.Ace],
  ]);
  const legal = generateLegalPlays(hand, Rank.Two);
  const compressed = compressCandidatesForModel(legal, Rank.Two);
  const ninePairs = compressed.plays
    .map((play, index) => ({ play, count: compressed.equivalentCounts[index] }))
    .filter(item => item.play.type === PatternType.Pair && item.play.rank === Rank.Nine);

  assert.equal(ninePairs.length, 1);
  assert.equal(ninePairs[0].count, 6);
  assert.ok(compressed.plays.some(play => play.type === PatternType.Pair && play.rank === Rank.Ace));
  assert.ok(compressed.plays.some(play => play.type === PatternType.Bomb4 && play.rank === Rank.Nine));
});

test('model candidate limit keeps every represented pattern family', () => {
  const hand = cards([
    [Suit.Heart, Rank.Two],
    [Suit.Spade, Rank.Three], [Suit.Heart, Rank.Three],
    [Suit.Club, Rank.Three], [Suit.Diamond, Rank.Three],
    [Suit.Spade, Rank.Four], [Suit.Heart, Rank.Four], [Suit.Club, Rank.Four],
    [Suit.Spade, Rank.Five], [Suit.Heart, Rank.Five],
    [Suit.Spade, Rank.Six], [Suit.Heart, Rank.Six],
    [Suit.Spade, Rank.Seven], [Suit.Heart, Rank.Seven],
  ]);
  const compressed = compressCandidatesForModel(generateLegalPlays(hand, Rank.Two), Rank.Two);
  const typeCount = new Set(compressed.plays.map(play => play.type)).size;
  const limited = limitModelCandidates(compressed, Math.max(12, typeCount));
  assert.ok(limited.plays.length <= Math.max(12, typeCount));
  assert.deepEqual(
    new Set(limited.plays.map(play => play.type)),
    new Set(compressed.plays.map(play => play.type)),
  );
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

function fourPlayerContext(overrides: Partial<AiDecisionContext>): AiDecisionContext {
  return {
    selfSeatIndex: 0,
    partnerSeatIndex: 2,
    lastPlayPlayerIndex: 0,
    roundNumber: 1,
    teamLevels: [Rank.Two, Rank.Two],
    leadingTeam: 0,
    players: [
      { seatIndex: 0, cardCount: 9, finishRank: null, relation: 'self' },
      { seatIndex: 1, cardCount: 8, finishRank: null, relation: 'opponent' },
      { seatIndex: 2, cardCount: 12, finishRank: null, relation: 'partner' },
      { seatIndex: 3, cardCount: 8, finishRank: null, relation: 'opponent' },
    ],
    recentActions: [],
    ...overrides,
  };
}

test('roundStake follows the match score: trailing fights harder, a big lead conserves', () => {
  assert.equal(roundStake(undefined), 1);
  const neutral = roundStake(fourPlayerContext({}));
  assert.ok(neutral >= 1 && neutral < 1.1, 'round 1 is near neutral');
  const trailing = fourPlayerContext({ teamLevels: [Rank.Two, Rank.Ten], leadingTeam: 1 });
  const winning = fourPlayerContext({ teamLevels: [Rank.Ten, Rank.Two], leadingTeam: 0 });
  assert.ok(roundStake(trailing) > 1.1, 'trailing by several levels escalates urgency');
  assert.ok(roundStake(winning) < 1, 'a comfortable lead plays conservatively');
  const defending = fourPlayerContext({ teamLevels: [Rank.Queen, Rank.King], leadingTeam: 0 });
  assert.ok(roundStake(defending) > 1, 'defending the table against a near-Ace opponent escalates');
  assert.ok(roundStake(fourPlayerContext({ roundNumber: 5 })) > neutral,
    'later rounds of a finite match escalate slightly');
});

test('scorePlay prices bombs cheaper when the team trails', () => {
  const hand = cards([
    [Suit.Spade, Rank.Three], [Suit.Heart, Rank.Three],
    [Suit.Club, Rank.Three], [Suit.Diamond, Rank.Three],
    [Suit.Spade, Rank.Five],
  ]);
  const bomb = generateLegalPlays(hand, Rank.Two).find(play =>
    play.type === PatternType.Bomb4 && play.cards.length === 4)!;
  const trailing = fourPlayerContext({ teamLevels: [Rank.Two, Rank.Ten], leadingTeam: 1 });
  const winning = fourPlayerContext({ teamLevels: [Rank.Ten, Rank.Two], leadingTeam: 0 });
  assert.ok(scorePlay(bomb, hand, Rank.Two, true, trailing)
    > scorePlay(bomb, hand, Rank.Two, true, winning));
});

test('urgency never spends a larger sufficient bomb before a smaller one', () => {
  const hand = cards([
    [Suit.Spade, Rank.Ace], [Suit.Heart, Rank.Ace],
    [Suit.Club, Rank.Ace], [Suit.Diamond, Rank.Ace],
    [Suit.Spade, Rank.Three], [Suit.Heart, Rank.Three],
    [Suit.Club, Rank.Three], [Suit.Diamond, Rank.Three], [Suit.Spade, Rank.Three],
    [Suit.Spade, Rank.Eight],
  ]);
  const last = {
    type: PatternType.Single,
    cards: [{ id: 999, suit: Suit.Spade, rank: Rank.SmallJoker }],
    rank: Rank.SmallJoker,
    length: 1,
  };
  const trailing = fourPlayerContext({ teamLevels: [Rank.Two, Rank.Ace], leadingTeam: 1 });
  const play = findBestPlay(hand, last, false, Rank.Two, trailing);
  assert.equal(play?.type, PatternType.Bomb4);
  assert.equal(play?.rank, Rank.Ace);
});

test('following with one playable action is still strategic because pass is legal', () => {
  assert.equal(isForcedAiDecision(0, false), true);
  assert.equal(isForcedAiDecision(1, true), true);
  assert.equal(isForcedAiDecision(1, false), false);
  assert.equal(isForcedAiDecision(4, false), false);
});

test('PASS has an explicit situational score instead of a fixed zero threshold', () => {
  const hand = cards([[Suit.Spade, Rank.Three], [Suit.Heart, Rank.Two]]);
  const last = { type: PatternType.Single, cards: [{ id: 99, suit: Suit.Spade, rank: Rank.King }],
    rank: Rank.King, length: 1 };
  const calm = fourPlayerContext({ lastPlayPlayerIndex: 1 });
  const urgent = fourPlayerContext({
    lastPlayPlayerIndex: 1,
    players: calm.players.map(player => player.seatIndex === 1 ? { ...player, cardCount: 2 } : player),
  });
  assert.ok(scorePass(hand, last, Rank.Two, calm) > scorePass(hand, last, Rank.Two, urgent));
});

test('opening single play contests an opponent with the weakest loose natural single', () => {
  const hand = cards([
    [Suit.Spade, Rank.Three], [Suit.Heart, Rank.Three],
    [Suit.Spade, Rank.Four], [Suit.Heart, Rank.Four],
    [Suit.Spade, Rank.Five], [Suit.Heart, Rank.Five],
    [Suit.Spade, Rank.Six], [Suit.Heart, Rank.Six],
    [Suit.Spade, Rank.King],
    [Suit.Spade, Rank.Two],
    [Suit.Spade, Rank.SmallJoker],
    [Suit.Spade, Rank.BigJoker],
  ]);
  const last = {
    type: PatternType.Single,
    cards: [{ id: 99, suit: Suit.Spade, rank: Rank.Queen }],
    rank: Rank.Queen,
    length: 1,
  };
  const base = fourPlayerContext({ lastPlayPlayerIndex: 1 });
  const context = fourPlayerContext({
    lastPlayPlayerIndex: 1,
    players: base.players.map(player => player.seatIndex === 0
      ? { ...player, cardCount: hand.length }
      : player.seatIndex === 1 ? { ...player, cardCount: 18 } : player),
  });

  const play = findBestPlay(hand, last, false, Rank.Three, context);
  assert.equal(play?.type, PatternType.Single);
  assert.equal(play?.rank, Rank.King);

  const legal = generateLegalPlays(hand, Rank.Three).filter(candidate =>
    canBeat(candidate, last, Rank.Three));
  const guarded = enforceTeamStrategy(
    null, legal, hand, last, false, Rank.Three, context,
  );
  assert.equal(guarded?.rank, Rank.King, 'an LLM PASS receives the same loose-single guard');
});

test('single PASS guard still protects a partner lead, pairs, wildcards and jokers', () => {
  const singles = cards([
    [Suit.Spade, Rank.King], [Suit.Spade, Rank.SmallJoker], [Suit.Spade, Rank.BigJoker],
  ]);
  const last = {
    type: PatternType.Single,
    cards: [{ id: 99, suit: Suit.Spade, rank: Rank.Queen }],
    rank: Rank.Queen,
    length: 1,
  };
  const partnerContext = fourPlayerContext({ lastPlayPlayerIndex: 2 });
  assert.equal(findBestPlay(singles, last, false, Rank.Three, partnerContext), null);

  const pairHand = cards([
    [Suit.Spade, Rank.King], [Suit.Heart, Rank.King],
    [Suit.Spade, Rank.SmallJoker], [Suit.Spade, Rank.BigJoker],
  ]);
  const opponentContext = fourPlayerContext({ lastPlayPlayerIndex: 1 });
  const legal = generateLegalPlays(pairHand, Rank.Three).filter(candidate =>
    canBeat(candidate, last, Rank.Three));
  assert.equal(enforceTeamStrategy(
    null, legal, pairHand, last, false, Rank.Three, opponentContext,
  ), null);
});

test('opponent consecutive control creates pressure to beat a low single', () => {
  const hand = cards([
    [Suit.Spade, Rank.Ace], [Suit.Heart, Rank.Ace],
    [Suit.Spade, Rank.SmallJoker], [Suit.Heart, Rank.BigJoker],
  ]);
  const previous = { type: PatternType.Single, cards: [{ id: 90, suit: Suit.Spade, rank: Rank.Three }],
    rank: Rank.Three, length: 1 };
  const last = { type: PatternType.Single, cards: [{ id: 91, suit: Suit.Spade, rank: Rank.Four }],
    rank: Rank.Four, length: 1 };
  const neutral = fourPlayerContext({ lastPlayPlayerIndex: 1 });
  const longHandPlayers = neutral.players.map(player => player.seatIndex === 1
    ? { ...player, cardCount: 18 } : player);
  const base = fourPlayerContext({ lastPlayPlayerIndex: 1, players: longHandPlayers });
  const controlled = fourPlayerContext({
    lastPlayPlayerIndex: 1,
    players: longHandPlayers,
    actionHistory: [
      { seatIndex: 1, action: 'play', pattern: previous },
      { seatIndex: 2, action: 'pass' },
      { seatIndex: 3, action: 'pass' },
      { seatIndex: 0, action: 'pass' },
      { seatIndex: 1, action: 'play', pattern: last },
    ],
  });
  assert.equal(opponentControlStreak(controlled), 2);
  assert.ok(scorePass(hand, last, Rank.Two, controlled) < scorePass(hand, last, Rank.Two, base));
  assert.equal(findBestPlay(hand, last, false, Rank.Two, base), null);
  assert.ok(findBestPlay(hand, last, false, Rank.Two, controlled));
});

test('partner lead remains protected despite a repeated public control streak', () => {
  const hand = cards([[Suit.Spade, Rank.SmallJoker], [Suit.Heart, Rank.BigJoker]]);
  const last = { type: PatternType.Single, cards: [{ id: 91, suit: Suit.Spade, rank: Rank.Four }],
    rank: Rank.Four, length: 1 };
  const context = fourPlayerContext({
    lastPlayPlayerIndex: 2,
    actionHistory: [
      { seatIndex: 2, action: 'play', pattern: last },
      { seatIndex: 3, action: 'pass' },
      { seatIndex: 0, action: 'pass' },
      { seatIndex: 1, action: 'pass' },
      { seatIndex: 2, action: 'play', pattern: last },
    ],
  });
  assert.equal(findBestPlay(hand, last, false, Rank.Two, context), null);
});

test('lead scoring feeds a reported partner and respects reported opponents', () => {
  const hand = cards([[Suit.Spade, Rank.Three], [Suit.Spade, Rank.Four]]);
  const single = generateLegalPlays(hand, Rank.Two).find(play => play.rank === Rank.Three)!;
  const calm = fourPlayerContext({});
  const partnerReported = fourPlayerContext({
    players: calm.players.map(player => player.seatIndex === 2
      ? { ...player, cardCount: 1 } : player),
  });
  const opponentReported = fourPlayerContext({
    players: calm.players.map(player => player.seatIndex === 3
      ? { ...player, cardCount: 1 } : player),
  });
  assert.ok(scorePlay(single, hand, Rank.Two, true, partnerReported)
    > scorePlay(single, hand, Rank.Two, true, calm));
  assert.ok(scorePlay(single, hand, Rank.Two, true, opponentReported)
    < scorePlay(single, hand, Rank.Two, true, calm));
});

test('simulation fallback requires matched samples and a conservative margin', () => {
  const baseline = { samples: 16, meanReward: 0.1, winRate: 0.5, doubleWinRate: 0.1 };
  assert.equal(reliablyBetterSimulation(
    { ...baseline, meanReward: 0.2 }, baseline,
  ), false);
  assert.equal(reliablyBetterSimulation(
    { ...baseline, meanReward: 0.5 }, baseline,
  ), true);
  assert.equal(reliablyBetterSimulation(
    { ...baseline, samples: 4, meanReward: 1 }, { ...baseline, samples: 4 },
  ), false);
});

test('model-call gate keeps strategic leads and endgames but skips routine follows', () => {
  const hand = cards([
    [Suit.Spade, Rank.Three], [Suit.Heart, Rank.Three],
    [Suit.Spade, Rank.Four], [Suit.Heart, Rank.Four],
    [Suit.Spade, Rank.Five], [Suit.Heart, Rank.Five],
    [Suit.Spade, Rank.Seven], [Suit.Spade, Rank.Nine], [Suit.Spade, Rank.Jack],
  ]);
  const all = generateLegalPlays(hand, Rank.Two);
  const context = fourPlayerContext({});
  assert.equal(shouldUseLlmForDecision(hand, all, null, true, Rank.Two, context), true);

  const last = {
    type: PatternType.Single,
    cards: [{ id: 999, suit: Suit.Spade, rank: Rank.Six }],
    rank: Rank.Six,
    length: 1,
  };
  const responses = all.filter(play => canBeat(play, last, Rank.Two));
  assert.equal(shouldUseLlmForDecision(hand, responses, last, false, Rank.Two, context), false);

  const endgame = fourPlayerContext({
    players: context.players.map(player => player.seatIndex === 1
      ? { ...player, cardCount: 2 } : player),
  });
  assert.equal(shouldUseLlmForDecision(hand, responses, last, false, Rank.Two, endgame), true);
});

test('a trailing team under threat spends the bomb; a calm lead preserves structure', () => {
  const hand = cards([
    [Suit.Spade, Rank.Three], [Suit.Heart, Rank.Three],
    [Suit.Club, Rank.Three], [Suit.Diamond, Rank.Three],
    [Suit.Spade, Rank.Eight], [Suit.Heart, Rank.Nine],
    [Suit.Club, Rank.Ten], [Suit.Diamond, Rank.Jack], [Suit.Spade, Rank.Queen],
  ]);
  // Opponent at 5 cards is an urgent threat; trailing by levels: spend the bomb.
  const underThreat = fourPlayerContext({
    teamLevels: [Rank.Two, Rank.Ten], leadingTeam: 1,
    players: [
      { seatIndex: 0, cardCount: 9, finishRank: null, relation: 'self' },
      { seatIndex: 1, cardCount: 5, finishRank: null, relation: 'opponent' },
      { seatIndex: 2, cardCount: 7, finishRank: null, relation: 'partner' },
      { seatIndex: 3, cardCount: 8, finishRank: null, relation: 'opponent' },
    ],
  });
  const trailingPlay = findBestPlay(hand, null, true, Rank.Two, underThreat);
  assert.equal(trailingPlay?.type, PatternType.Bomb4);

  // No immediate threat and a clear lead: keep the bomb, lead the straight.
  const calm = fourPlayerContext({
    teamLevels: [Rank.Ten, Rank.Two], leadingTeam: 0,
    players: [
      { seatIndex: 0, cardCount: 9, finishRank: null, relation: 'self' },
      { seatIndex: 1, cardCount: 6, finishRank: null, relation: 'opponent' },
      { seatIndex: 2, cardCount: 7, finishRank: null, relation: 'partner' },
      { seatIndex: 3, cardCount: 8, finishRank: null, relation: 'opponent' },
    ],
  });
  const calmPlay = findBestPlay(hand, null, true, Rank.Two, calm);
  assert.notEqual(calmPlay?.type, PatternType.Bomb4);
  assert.equal(calmPlay?.type, PatternType.Straight);
});

test('plays the largest single when the clockwise next player has one card', () => {
  const hand = cards([
    [Suit.Spade, Rank.Three],
    [Suit.Spade, Rank.Ace],
    [Suit.Spade, Rank.BigJoker],
  ]);
  const context = fourPlayerContext({
    players: [
      { seatIndex: 0, cardCount: hand.length, finishRank: null, relation: 'self' },
      { seatIndex: 1, cardCount: 1, finishRank: null, relation: 'opponent' },
      { seatIndex: 2, cardCount: 8, finishRank: null, relation: 'partner' },
      { seatIndex: 3, cardCount: 8, finishRank: null, relation: 'opponent' },
    ],
  });

  const play = findBestPlay(hand, null, true, Rank.Two, context);
  assert.equal(play?.type, PatternType.Single);
  assert.equal(play?.rank, Rank.BigJoker);
});

test('plays the largest legal pair when the clockwise next player has two cards', () => {
  const hand = cards([
    [Suit.Spade, Rank.King], [Suit.Heart, Rank.King],
    [Suit.Spade, Rank.Ace], [Suit.Heart, Rank.Ace],
  ]);
  const last = {
    type: PatternType.Pair,
    cards: cards([[Suit.Club, Rank.Queen], [Suit.Diamond, Rank.Queen]]),
    rank: Rank.Queen,
    length: 2,
  };
  const context = fourPlayerContext({
    lastPlayPlayerIndex: 3,
    players: [
      { seatIndex: 0, cardCount: hand.length, finishRank: null, relation: 'self' },
      { seatIndex: 1, cardCount: 2, finishRank: null, relation: 'opponent' },
      { seatIndex: 2, cardCount: 8, finishRank: null, relation: 'partner' },
      { seatIndex: 3, cardCount: 8, finishRank: null, relation: 'opponent' },
    ],
  });

  const play = findBestPlay(hand, last, false, Rank.Two, context);
  assert.equal(play?.type, PatternType.Pair);
  assert.equal(play?.rank, Rank.Ace);
});
