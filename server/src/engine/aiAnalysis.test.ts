import assert from 'node:assert/strict';
import test from 'node:test';
import { Card, CardPattern, PatternType, Rank, Suit } from '../../../shared/types';
import { createDeck } from './card';
import { findBestPlay, generateLegalPlays, findSmartPlay } from './ai';
import {
  analyzeDecision, analysisKey, buildPublicKnowledge, createTurnEstimator,
  rollout, sampleHiddenHands,
} from './aiAnalysis';
import { llmFindBestPlay } from './llmAi';
import type { AiDecisionContext, AiRecentAction } from './llmAi';
import { GameRoom } from '../services/GameRoom';

function contextFor(hands: Card[][]): AiDecisionContext {
  const held = new Set(hands.flat().map(card => card.id));
  const discarded = createDeck().filter(card => !held.has(card.id));
  const actionHistory: AiRecentAction[] = [];
  let offset = 0;
  for (let seat = 0; seat < 4; seat++) {
    for (const card of discarded.slice(offset, offset + 27 - hands[seat].length)) {
      actionHistory.push({ seatIndex: seat, action: 'play', pattern: {
        cards: [card], rank: card.rank, type: PatternType.Single, length: 1,
      } });
    }
    offset += 27 - hands[seat].length;
  }
  return {
    selfSeatIndex: 0, partnerSeatIndex: 2, lastPlayPlayerIndex: -1,
    roundNumber: 1, teamLevels: [2, 2], leadingTeam: 0, passCount: 0,
    actionHistory, recentActions: actionHistory.slice(-12),
    players: hands.map((hand, seat) => ({
      seatIndex: seat, cardCount: hand.length, finishRank: null,
      relation: seat === 0 ? 'self' : seat === 2 ? 'partner' : 'opponent',
    })),
  };
}

function rankedHand(ranks: Rank[]): Card[] {
  return ranks.map((rank, id) => ({ id, rank, suit: [Suit.Spade, Suit.Heart, Suit.Club, Suit.Diamond][id % 4] }));
}

test('complete public memory counts physical wildcard and pins public transfers only', () => {
  const deck = createDeck();
  const hands = [[deck[0]], [deck[1], deck[2]], [deck[3]], [deck[4]]];
  const context = contextFor(hands);
  const wildAction = context.actionHistory!.find(action => action.pattern!.cards[0].id === 13)!;
  wildAction.pattern!.substitutions = [{ ...deck[13], rank: Rank.Ace, suit: Suit.Club }];
  context.publicTransfers = [{ fromSeat: 2, toSeat: 1, card: deck[1] }];
  const memory = buildPublicKnowledge(hands[0], context)!;
  assert.equal(memory.played.length, 103);
  assert.ok(memory.played.some(card => card.id === 13 && card.rank === Rank.Two));
  assert.deepEqual(memory.unseen.map(card => card.id), [1, 2, 3, 4]);
  const sample = sampleHiddenHands(hands[0], context, memory, () => 0.5)!;
  assert.deepEqual(sample.map(cards => cards.length), [1, 2, 1, 1]);
  assert.ok(sample[1].some(card => card.id === 1));
  assert.equal(new Set(sample.flat().map(card => card.id)).size, 5);
  assert.equal(buildPublicKnowledge(hands[0], { ...context, actionHistory: undefined }), null);
  assert.equal(sampleHiddenHands(hands[0], {
    ...context, players: context.players.map(p => ({ ...p, cardCount: p.cardCount + 1 })),
  }, memory), null);
});

test('returned tribute ownership overrides earlier transfer; passes do not eliminate cards', () => {
  const deck = createDeck();
  const hands = [[deck[0]], [deck[1]], [deck[2]], [deck[3]]];
  const context = contextFor(hands);
  context.publicTransfers = [
    { fromSeat: 1, toSeat: 2, card: deck[1] },
    { fromSeat: 2, toSeat: 1, card: deck[1] },
  ];
  context.actionHistory!.push({ seatIndex: 1, action: 'pass' });
  const memory = buildPublicKnowledge(hands[0], context)!;
  assert.deepEqual(memory.knownBySeat[1], [deck[1]]);
  assert.deepEqual(memory.knownBySeat[2], []);
});

test('exact hand decomposition finds two full houses instead of greedy extra moves', () => {
  const hand = rankedHand([3, 3, 3, 4, 4, 4, 5, 5, 6, 6]);
  const plays = generateLegalPlays(hand, 2);
  const estimator = createTurnEstimator(hand, plays, performance.now() + 1000);
  assert.deepEqual(estimator.whole(), { turns: 2, exact: true });
  const fullHouse = plays.find(play => play.type === PatternType.TriplePair && play.rank === Rank.Three
    && play.cards.filter(card => card.rank === Rank.Five).length === 2)!;
  assert.deepEqual(estimator.after(fullHouse), { turns: 1, exact: true });
  const bounded = createTurnEstimator(hand, plays, 0);
  assert.equal(bounded.whole().exact, false);
  assert.ok(bounded.whole().turns >= 2 && bounded.whole().turns <= hand.length);
  assert.deepEqual(createTurnEstimator([], [], 0).whole(), { turns: 0, exact: true });
});

test('decomposition can use wildcard combinations', () => {
  const hand = rankedHand([2, 3, 3, 4, 4, 4]);
  hand[0].suit = Suit.Heart;
  const estimator = createTurnEstimator(hand, generateLegalPlays(hand, 2), performance.now() + 1000);
  assert.deepEqual(estimator.whole(), { turns: 1, exact: true });
});

test('rollout applies catch-wind and stops when one team finishes first and second', () => {
  const deck = createDeck();
  const hands = [[deck[1]], [deck[2]], [], [deck[3]]];
  const context = contextFor(hands);
  context.players[2].finishRank = 1;
  context.lastPlayPlayerIndex = 2;
  context.passCount = 1;
  const last: CardPattern = { type: PatternType.Single, rank: Rank.BigJoker,
    cards: [deck[53]], length: 1 };
  const visits: Array<[number, boolean]> = [];
  const result = rollout(hands, null, last, 2, context, (hand, trick, free, level, state) => {
    visits.push([state.selfSeatIndex, free]);
    return findBestPlay(hand, trick, free, level, state);
  }, performance.now() + 1000);
  assert.deepEqual(visits, [[1, false], [0, true]]);
  assert.deepEqual(result, { reward: 1, win: true, doubleWin: true });
  assert.equal(hands[0].length, 1, 'simulation must not mutate the caller hand');
});

test('endgame uses balanced complete samples and labels exhausted/incomplete runs', async () => {
  const deck = createDeck();
  const hands = [[deck[0], deck[1]], [deck[2], deck[3]], [deck[4], deck[5]], [deck[6], deck[7]]];
  const context = contextFor(hands);
  const plays = generateLegalPlays(hands[0], 2);
  const analysis = await analyzeDecision(hands[0], plays, plays, null, 2, context, findBestPlay,
    { budgetMs: 2000, maxSamples: 4, random: () => 0.5 });
  assert.equal(analysis.simulation.samples, 4);
  for (const play of plays) {
    const result = analysis.candidates[analysisKey(play)].simulation!;
    assert.equal(result.samples, 4);
    assert.ok(result.winRate >= 0 && result.winRate <= 1);
  }
  const expired = await analyzeDecision(hands[0], plays, plays, null, 2, context, findBestPlay,
    { budgetMs: 0 });
  assert.equal(expired.simulation.samples, 0);
  const missing = await analyzeDecision(hands[0], plays, plays, null, 2,
    { ...context, actionHistory: undefined }, findBestPlay);
  assert.equal(missing.simulation.status, 'incomplete_public_history');
});

test('LLM input contains complete public memory and local analysis, not sampled hands', async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-only';
  const deck = createDeck();
  const hands = [[deck[0]], [deck[1]], [deck[2]], [deck[3]]];
  const context = contextFor(hands);
  const plays = generateLegalPlays(hands[0], 2);
  const analysis = await analyzeDecision(hands[0], plays, plays, null, 2, context, findBestPlay,
    { budgetMs: 0 });
  let input: any;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    input = JSON.parse(body.messages[1].content.split('\n')[1]);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"action_id":0}' } }] }) } as Response;
  }) as typeof fetch;
  try {
    await llmFindBestPlay(hands[0], plays, null, true, 2, context, undefined, analysis);
    assert.equal(input.action_history.length, 104);
    assert.ok(input.public_memory.played_cards);
    assert.ok(input.public_memory.unseen_cards);
    assert.deepEqual(input.local_analysis.hand_turns, { turns: 1, exact: true });
    assert.equal(input.legal_actions[0].analysis.remainingTurns.turns, 0);
    assert.ok(input.public_memory.publicly_known_cards.every((p: any) => p.cards === ''));
    assert.equal(input.sampled_hands, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  }
});

test('unavailable model falls back to a legal analyzed move', async () => {
  const hand = rankedHand([3, 3, 3, 4, 4, 4, 5, 5, 6, 6]);
  const result = await findSmartPlay(hand, null, true, 2, undefined, { provider: 'local', model: '' });
  assert.ok(result);
  assert.equal(result.type, PatternType.TriplePair, 'prefer two full houses to three or more moves');
  assert.ok(generateLegalPlays(hand, 2).some(play => analysisKey(play) === analysisKey(result)));
});

test('room AI context derives counts from public history and clears memory next round', () => {
  const room = new GameRoom('analysis-test', 'p0');
  for (let seat = 0; seat < 4; seat++) room.addPlayer(`p${seat}`, `P${seat}`, 2, null);
  const deck = createDeck();
  const hands = [[deck[0]], [deck[1]], [deck[2]], [deck[3]]];
  const context = contextFor(hands);
  const internals = room as unknown as {
    publicActionHistory: AiRecentAction[];
    getAiDecisionContext(seat: number): AiDecisionContext;
  };
  internals.publicActionHistory = context.actionHistory!;
  // Deliberately make private hands disagree: they must not be consulted.
  room.hands.set('p1', deck.slice(0, 20));
  assert.deepEqual(internals.getAiDecisionContext(0).players.map(p => p.cardCount), [1, 1, 1, 1]);
  assert.equal(internals.getAiDecisionContext(0).actionHistory!.length, 104);
  try {
    room.startGame();
    const next = internals.getAiDecisionContext(0);
    assert.deepEqual(next.actionHistory, []);
    assert.deepEqual(next.players.map(p => p.cardCount), [27, 27, 27, 27]);
  } finally {
    if (room.turnTimer) clearTimeout(room.turnTimer);
  }
});
