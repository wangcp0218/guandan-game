import assert from 'node:assert/strict';
import test from 'node:test';
import { Card, CardPattern, PatternType, Rank, Suit } from '../../../shared/types';
import { createDeck } from './card';
import { findBestPlay, generateLegalPlays, findSmartPlay, enforceTeamStrategy, stratifyCandidates } from './ai';
import type { DecisionAnalysis } from './aiAnalysis';
import {
  analyzeDecision, analysisKey, buildPublicKnowledge, createTurnEstimator,
  rollout, sampleHiddenHands, enumerateHiddenHands,
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

test('stratification retains a low-ranked bomb among many singles', () => {
  const hand = rankedHand([3, 3, 3, 3, 4, 5, 6, 7, 8, 9]);
  const all = generateLegalPlays(hand, 2);
  const singles = all.filter(p => p.type === PatternType.Single);
  const bomb = all.find(p => p.type === PatternType.Bomb4)!;
  const selected = stratifyCandidates([...singles, bomb], hand, 2, 4);
  assert.ok(selected.includes(bomb));
  assert.equal(selected.length, 4);
  assert.ok(selected.every(p => all.includes(p)));
  assert.deepEqual(selected, stratifyCandidates([...singles, bomb], hand, 2, 4));
});

test('small hidden deal enumeration covers every allocation and respects cap', () => {
  const deck = createDeck();
  const hands = [[deck[0]], [deck[1]], [deck[2]], [deck[3]]];
  const context = contextFor(hands);
  const knowledge = buildPublicKnowledge(hands[0], context)!;
  const deals = enumerateHiddenHands(hands[0], context, knowledge)!;
  assert.equal(deals.length, 6);
  assert.equal(new Set(deals.map(d => d.map(h => h.map(c => c.id).join(',')).join('|'))).size, 6);
  for (const deal of deals) {
    assert.deepEqual(deal[0], hands[0]);
    assert.equal(new Set(deal.flat().map(c => c.id)).size, 4);
  }
  assert.equal(enumerateHiddenHands(hands[0], context, knowledge, 5), null);
});

test('final policy rejects overtaking partner and prioritizes a direct finish', () => {
  const hand = rankedHand([14, 16, 3]);
  const candidates = generateLegalPlays(hand, 2);
  const context = contextFor([hand, [], [], []]);
  context.lastPlayPlayerIndex = 2;
  const last: CardPattern = { type: PatternType.Single, rank: Rank.King, length: 1,
    cards: [{ id: 99, suit: Suit.Spade, rank: Rank.King }] };
  const large = candidates.find(p => p.rank === Rank.BigJoker)!;
  assert.equal(enforceTeamStrategy(large, candidates, hand, last, false, 2, context), null);
  const finishHand = [hand[1]];
  const finishPlays = generateLegalPlays(finishHand, 2);
  assert.equal(enforceTeamStrategy(null, finishPlays, finishHand, last, false, 2, context)?.rank, Rank.BigJoker);
});

test('final policy chooses smaller equivalent pairs but does not break a bomb', () => {
  const hand = rankedHand([3, 3, 13, 13, 7]);
  const plays = generateLegalPlays(hand, 2);
  const high = plays.find(p => p.type === PatternType.Pair && p.rank === Rank.King)!;
  assert.equal(enforceTeamStrategy(high, plays, hand, null, true, 2)?.rank, Rank.Three);
  const bombHand = rankedHand([3, 3, 3, 3, 13, 13, 7]);
  const bombPlays = generateLegalPlays(bombHand, 2);
  const intact = bombPlays.find(p => p.type === PatternType.Pair && p.rank === Rank.King)!;
  assert.equal(enforceTeamStrategy(intact, bombPlays, bombHand, null, true, 2)?.rank, Rank.King);
});

test('four lucky simulations do not authorize overtaking partner; substantial paired evidence can', () => {
  const hand = rankedHand([14, 7]);
  const plays = generateLegalPlays(hand, 2);
  const high = plays.find(p => p.rank === Rank.Ace)!;
  const last: CardPattern = { type: PatternType.Single, rank: Rank.King, length: 1,
    cards: [{ id: 99, suit: Suit.Spade, rank: Rank.King }] };
  const context = contextFor([hand, [], [], []]);
  context.lastPlayPlayerIndex = 2;
  context.players[1].cardCount = 2;
  const analysis: DecisionAnalysis = {
    handTurns: { turns: 2, exact: true },
    candidates: { [analysisKey(high)]: { remainingTurns: { turns: 1, exact: true },
      simulation: { samples: 4, meanReward: 1, winRate: 1, doubleWinRate: 1 } } },
    passSimulation: { samples: 4, meanReward: 0, winRate: 0.5, doubleWinRate: 0 },
    simulation: { samples: 4, elapsedMs: 10, status: 'sampled' },
  };
  assert.equal(enforceTeamStrategy(high, plays, hand, last, false, 2, context, analysis), null);
  analysis.candidates[analysisKey(high)].simulation!.samples = 8;
  analysis.passSimulation!.samples = 8;
  assert.equal(enforceTeamStrategy(high, plays, hand, last, false, 2, context, analysis), high);
});

test('public memory allows a necessary single interception but not overtaking an unbeatable partner', () => {
  const deck = createDeck();
  const hands = [[deck[53], deck[1]], [deck[52]], [deck[2]], [deck[3]]];
  const context = contextFor(hands);
  context.lastPlayPlayerIndex = 2;
  const plays = generateLegalPlays(hands[0], 2);
  const big = plays.find(p => p.rank === Rank.BigJoker)!;
  const last: CardPattern = { type: PatternType.Single, rank: Rank.Ace, cards: [], length: 1 };
  assert.equal(enforceTeamStrategy(big, plays, hands[0], last, false, 2, context), big);
  const unbeatable = { ...last, rank: Rank.SmallJoker };
  assert.equal(enforceTeamStrategy(big, plays, hands[0], unbeatable, false, 2, context), null);
});

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
  let requestBody: any;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    requestBody = body;
    input = JSON.parse(body.messages[1].content.split('\n')[1]);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"action_id":0}' } }] }) } as Response;
  }) as typeof fetch;
  try {
    await llmFindBestPlay(hands[0], plays, null, true, 2, context, undefined, analysis);
    assert.equal(input.recent_action_history.length, 12);
    assert.equal(input.public_memory.played_cards, undefined);
    assert.ok(input.public_memory.unseen_cards);
    assert.equal(input.played_by_seat.length, 4);
    assert.ok(input.played_by_seat.every((player: any) => player.cards.length > 0));
    assert.deepEqual(input.local_analysis.hand_turns, { turns: 1, exact: true });
    assert.equal(input.legal_action_member_schema[10], 'analysis');
    assert.equal(input.legal_actions[0][1][0][10].remainingTurns.turns, 0);
    assert.equal(input.candidate_coverage.model_actions, plays.length);
    assert.equal(input.candidate_coverage.represented_equivalent_actions, plays.length);
    assert.equal(input.hand_combinations.same_as_legal_actions, true);
    assert.equal(input.legal_actions[0][1][0][4], 1);
    assert.equal(typeof input.public_inference.unseen_controls, 'string');
    assert.ok(input.public_memory.publicly_known_cards.every((p: any) => p.cards === ''));
    assert.equal(input.sampled_hands, undefined);
    assert.equal(requestBody.max_tokens, 192);
    assert.ok(requestBody.messages[0].content.length < 2500);
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
