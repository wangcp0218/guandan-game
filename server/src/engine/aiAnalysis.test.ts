import { strategyBrief, STRATEGY_GUIDE } from './aiStrategy';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Card, CardPattern, PatternType, Rank, Suit } from '../../../shared/types';
import { createDeck } from './card';
import { findBestPlay, generateLegalPlays, findSmartPlay, enforceTeamStrategy, finalizeAiDecision, limitModelCandidates, removeWastefulWildRealizations, groundStrategyPlan, pruneOpeningWildLeads } from './ai';
import type { DecisionAnalysis } from './aiAnalysis';
import {
  analyzeDecision, analyzeEndgameRoutes, analysisKey, buildPublicKnowledge, buildTeamRoutes, buildTeamPlan, createTurnEstimator, forecastTrick, forecastTwoTricks, twoTrickExitGain, twoTrickGain,
  rollout, sampleHiddenHands, sampleHiddenHandsWeighted, enumerateHiddenHands, publicControlEvidence,
  behaviorConsistencyWeight, inferSeatBeliefs, decisionTempo, resourceCost, tailControlCost, improvesTrickRoute,
} from './aiAnalysis';
import { llmFindBestPlay, parseDecisionCheck, parseStrategyPlan } from './llmAi';
import type { AiDecisionContext, AiRecentAction } from './llmAi';
import { GameRoom } from '../services/GameRoom';
import { getAiTelemetrySnapshot, resetAiTelemetry } from './aiTelemetry';

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

test('weighted hidden sampling stays legal and treats passes as soft evidence', () => {
  const deck = createDeck();
  const hands = [[deck[0]], [deck[1]], [deck[2]], [deck[3]]];
  const context = contextFor(hands);
  context.actionHistory!.push({ seatIndex: 1, action: 'pass' });
  const knowledge = buildPublicKnowledge(hands[0], context)!;
  const sampled = sampleHiddenHandsWeighted(hands[0], context, knowledge, Rank.Two, () => 0.5)!;
  assert.deepEqual(sampled.map(cards => cards.length), [1, 1, 1, 1]);
  assert.equal(new Set(sampled.flat().map(card => card.id)).size, 4);
});

test('public control proof accounts for bombs and wildcard-assisted bombs', () => {
  const deck = createDeck();
  const self = [deck.find(card => card.rank === Rank.BigJoker)!];
  const context = contextFor([self, [], [], []]);
  const play = generateLegalPlays(self, Rank.Two)[0];
  assert.equal(publicControlEvidence(play, self, Rank.Two, context)?.unbeatable, true);

  const lateHands = [[deck[1]], [deck[2]], [deck[3]], [deck[4]]];
  const lateContext = contextFor(lateHands);
  const low = generateLegalPlays(lateHands[0], Rank.Two)[0];
  assert.equal(publicControlEvidence(low, lateHands[0], Rank.Two, lateContext)?.unbeatable, false);
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

test('publicly unbeatable pair is retained on a calm lead, including model proposals', () => {
  const deck = createDeck();
  const pick = (rank: Rank, suit: Suit) => deck.find(c => c.rank === rank && c.suit === suit)!;
  const hand = [pick(Rank.Three, Suit.Spade), pick(Rank.Three, Suit.Club),
    pick(Rank.King, Suit.Spade), pick(Rank.King, Suit.Club), pick(Rank.Seven, Suit.Diamond)];
  const unseen = [Rank.Four, Rank.Five, Rank.Six, Rank.Eight, Rank.Nine, Rank.Ten, Rank.Queen]
    .flatMap(rank => [Suit.Heart, Suit.Club, Suit.Diamond].map(suit => pick(rank, suit)));
  const context = contextFor([hand, unseen.slice(0, 7), unseen.slice(7, 14), unseen.slice(14)]);
  const plays = generateLegalPlays(hand, Rank.Two);
  const kings = plays.find(play => play.type === PatternType.Pair && play.rank === Rank.King)!;
  assert.equal(publicControlEvidence(kings, hand, Rank.Two, context)?.unbeatable, true);
  assert.equal(findBestPlay(hand, null, true, Rank.Two, context)?.rank, Rank.Three);
  assert.equal(enforceTeamStrategy(kings, plays, hand, null, true, Rank.Two, context)?.rank, Rank.Three);
});

test('short hand probes with a recapture and exit, but never feeds a reported single', () => {
  const deck = createDeck();
  const pick = (rank: Rank, suit: Suit) => deck.find(c => c.rank === rank && c.suit === suit)!;
  const hand = [pick(Rank.Three, Suit.Spade), pick(Rank.BigJoker, Suit.Heart),
    pick(Rank.Eight, Suit.Spade), pick(Rank.Eight, Suit.Club)];
  const unseen = [Rank.Four, Rank.Five, Rank.Six, Rank.Nine, Rank.Ten, Rank.Queen, Rank.King]
    .flatMap(rank => [Suit.Heart, Suit.Club, Suit.Diamond].map(suit => pick(rank, suit)));
  const context = contextFor([hand, unseen.slice(0, 7), unseen.slice(7, 14), unseen.slice(14)]);
  const plays = generateLegalPlays(hand, Rank.Two);
  const probe = plays.find(p => p.type === PatternType.Single && p.rank === Rank.Three)!;
  const big = plays.find(p => p.type === PatternType.Single && p.rank === Rank.BigJoker)!;
  const route = analyzeEndgameRoutes(hand, plays, Rank.Two, context)[analysisKey(probe)];
  assert.equal(route.intent, 'probe_then_recapture');
  assert.equal(route.controlProven, true);
  assert.equal(route.recapture?.rank, Rank.BigJoker);
  assert.equal(route.exit?.type, PatternType.Pair);
  assert.equal(findBestPlay(hand, null, true, Rank.Two, context)?.rank, Rank.Three);
  assert.equal(enforceTeamStrategy(big, plays, hand, null, true, Rank.Two, context)?.rank, Rank.Three);

  const danger = contextFor([hand, unseen.slice(0, 7), unseen.slice(7, 14), unseen.slice(14, 15)]);
  assert.equal(analyzeEndgameRoutes(hand, plays, Rank.Two, danger)[analysisKey(probe)], undefined);
  assert.equal(findBestPlay(hand, null, true, Rank.Two, danger)?.type, PatternType.Pair);

  const noMemory = { ...context, actionHistory: undefined };
  const uncertain = analyzeEndgameRoutes(hand, plays, Rank.Two, noMemory)[analysisKey(probe)];
  assert.equal(uncertain.controlProven, false);
  assert.match(uncertain.caveat, /可能/);
  const options = buildTeamRoutes(hand, plays, plays, null, Rank.Two, noMemory, {}, generateLegalPlays);
  const planned = options.find(r => r.goal === 'probe_then_recapture')!;
  assert.equal(planned.controlProven, false);
  assert.ok(planned.recapture);
});

test('proven control followed by a whole-hand exit takes priority in the endgame', () => {
  const deck = createDeck();
  const hand = [deck.find(c => c.rank === Rank.BigJoker)!,
    ...deck.filter(c => c.rank === Rank.Three).slice(0, 2)];
  const unseen = deck.filter(c => [Rank.Five, Rank.Seven, Rank.Nine].includes(c.rank)
    && [Suit.Spade, Suit.Club, Suit.Diamond].includes(c.suit)).slice(0, 9);
  const context = contextFor([hand, unseen.slice(0, 3), unseen.slice(3, 6), unseen.slice(6)]);
  const play = findBestPlay(hand, null, true, Rank.Two, context)!;
  assert.equal(play.rank, Rank.BigJoker);
  const plays = generateLegalPlays(hand, Rank.Two);
  const route = analyzeEndgameRoutes(hand, plays, Rank.Two, context)[analysisKey(play)];
  assert.equal(route.intent, 'control_then_finish');
  assert.equal(route.exit?.type, PatternType.Pair);
  const team = buildTeamRoutes(hand, plays, plays, null, Rank.Two, context, {}, generateLegalPlays);
  const control = team.find(r => r.goal === 'control_then_finish')!;
  assert.equal(control.actionKey, analysisKey(play));
  assert.deepEqual(control.exit, route.exit);
  assert.equal(control.controlProven, true);
});

test('four lucky simulations do not authorize overtaking partner; substantial paired evidence can', () => {
  const hand = rankedHand([14, 7]);
  const plays = generateLegalPlays(hand, 2);
  const high = plays.find(p => p.rank === Rank.Ace)!;
  const last: CardPattern = { type: PatternType.Single, rank: Rank.King, length: 1,
    cards: [{ id: 99, suit: Suit.Spade, rank: Rank.King }] };
  const context = contextFor([hand, [], [], []]);
  context.lastPlayPlayerIndex = 2;
  context.players.forEach(player => { if (player.relation === 'opponent') player.cardCount = 8; });
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
  assert.equal(finalizeAiDecision(null, plays, hand, last, false, 2, context, analysis), high,
    'team evidence may replace model PASS even without a reported opponent');
  analysis.candidates[analysisKey(high)].simulation!.meanReward = -0.5;
  analysis.passSimulation!.meanReward = 0.5;
  context.lastPlayPlayerIndex = 1;
  assert.equal(finalizeAiDecision(high, plays, hand, last, false, 2, context, analysis), null,
    'the same comparison may replace model play with PASS');
  analysis.passSimulation!.samples = 4;
  assert.equal(finalizeAiDecision(high, plays, hand, last, false, 2, context, analysis), high,
    'unmatched samples cannot override the model');
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
  const originalHistory = JSON.stringify(context.actionHistory);
  const visits: Array<[number, boolean]> = [];
  const result = rollout(hands, null, last, 2, context, (hand, trick, free, level, state) => {
    visits.push([state.selfSeatIndex, free]);
    assert.ok(buildPublicKnowledge(hand, state), 'memory remains consistent from each seat');
    assert.deepEqual(state.actionHistory!.slice(0, context.actionHistory!.length), context.actionHistory);
    assert.equal(state.actionHistory!.at(-1)?.action, 'pass');
    assert.equal(state.actionHistory!.length, context.actionHistory!.length + visits.length);
    assert.equal(state.recentActions.at(-1)?.action, 'pass');
    return findBestPlay(hand, trick, free, level, state);
  }, performance.now() + 1000);
  assert.deepEqual(visits, [[1, false], [0, true]]);
  assert.deepEqual(result, { reward: 1, win: true, doubleWin: true });
  assert.equal(hands[0].length, 1, 'simulation must not mutate the caller hand');
  assert.equal(JSON.stringify(context.actionHistory), originalHistory, 'simulation must not mutate live history');
});

test('paired one-cycle forecast distinguishes feeding a finishing partner from feeding the next opponent', () => {
  const deck = createDeck();
  const take = (rank: Rank) => deck.find(c => c.rank === rank)!;
  const hands = [[take(3), take(7)], [take(5)], [take(8)], [take(9), take(10)]];
  const context = contextFor(hands);
  context.publicTransfers = hands.flatMap((cards, seat) => seat === 0 ? []
    : cards.map(card => ({ card, fromSeat: 0, toSeat: seat })));
  const leads = generateLegalPlays(hands[0], 2);
  const f = forecastTrick(hands[0], leads, null, 2, context, generateLegalPlays, Infinity, () => 0.5)!;
  const low = f[analysisKey(leads.find(p => p.rank === 3)!)];
  const high = f[analysisKey(leads.find(p => p.rank === 7)!)];
  assert.equal(low.enemyExit, 1);
  assert.equal(high.allyExit, 1);
  assert.equal(high.samples, low.samples);
  assert.equal(f.PASS, undefined);
  context.lastPlayPlayerIndex = 1;
  context.passCount = 2;
  const pass = forecastTrick(hands[0], [], leads[0], 2, context, generateLegalPlays, Infinity)!.PASS;
  assert.equal(pass.teamAhead, 0);
  assert.equal(pass.enemyExit, 0, 'closing the trick gives the original leader initiative, without another response');
});

test('forecast allows the intervening opponent to block a one-card partner', () => {
  const deck = createDeck();
  const card = (rank: Rank) => deck.find(c => c.rank === rank)!;
  const hands = [[card(3), card(11)], [card(5), card(14)], [card(10)], [card(7), card(8)]];
  const context = contextFor(hands);
  context.publicTransfers = hands.flatMap((cards, seat) => seat === 0 ? []
    : cards.map(card => ({ card, fromSeat: 0, toSeat: seat })));
  const lead = generateLegalPlays(hands[0], 2).find(p => p.rank === 3)!;
  const forecast = forecastTrick(hands[0], [lead], null, 2, context, generateLegalPlays, Infinity)!;
  assert.equal(forecast[analysisKey(lead)].allyExit, 0, 'the opponent can cover the feed with the ace');
});

test('the model may defer to a partner only while the partner can still answer', async t => {
  const deck = createDeck();
  const take = (rank: Rank, n: number) => deck.filter(c => c.rank === rank).slice(0, n);
  const hand = [...take(4, 4), ...take(7, 3), ...take(9, 2), ...take(13, 1)];
  const last: CardPattern = { type: PatternType.Triple, rank: Rank.Ace, cards: take(14, 3), length: 3 };
  const oldKey = process.env.LOCAL_LLM_API_KEY;
  process.env.LOCAL_LLM_API_KEY = 'fixture';
  t.after(() => {
    if (oldKey === undefined) delete process.env.LOCAL_LLM_API_KEY;
    else process.env.LOCAL_LLM_API_KEY = oldKey;
  });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: {
    content: JSON.stringify({ action_id: 'PASS', decision_check: { goal: 'hold_control',
      resource_use: 'preserve', worst_reply: '对手续领', why_not_lower_cost: '保留炸弹' } }),
  } }] }));
  for (const seat of [1, 3]) {
    const partner = (seat + 2) % 4;
    const ctx: AiDecisionContext = { selfSeatIndex: seat, partnerSeatIndex: partner, lastPlayPlayerIndex: 0,
      teamLevels: [2, 2], roundNumber: 1, leadingTeam: 0, passCount: seat - 1,
      recentActions: [{ action: 'play', seatIndex: 0, pattern: last }],
      players: [0, 1, 2, 3].map(i => ({ seatIndex: i, cardCount: i === 0 ? 5 : i === seat ? hand.length : 14,
        finishRank: null, relation: i === seat ? 'self' : i === partner ? 'partner' : 'opponent' })) };
    for (let i = 1; i < seat; i++) ctx.recentActions.push({ seatIndex: i, action: 'pass' });
    const action = await findSmartPlay(hand, last, false, 2, ctx, { provider: 'local', model: 'Qwen3.8-27' });
    assert.equal(action?.type, seat === 3 ? PatternType.Bomb4 : undefined);
  }
});

test('endgame uses balanced complete samples and labels exhausted/incomplete runs', async () => {
  const deck = createDeck();
  const hands = [[deck[0], deck[1]], [deck[2], deck[3]], [deck[4], deck[5]], [deck[6], deck[7]]];
  const context = contextFor(hands);
  const plays = generateLegalPlays(hands[0], 2);
  const analysis = await analyzeDecision(hands[0], plays, plays, null, 2, context, findBestPlay,
    { budgetMs: 2000, maxSamples: 4, random: () => 0.5, generateReplies: generateLegalPlays });
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
  resetAiTelemetry();
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
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      action_id: 0,
      decision_check: { goal: 'direct_finish', resource_use: 'spend_justified', worst_reply: '无', why_not_lower_cost: '直接走完' },
    }) } }] }) } as Response;
  }) as typeof fetch;
  try {
    await llmFindBestPlay(hands[0], plays, null, true, 2, context,
      { provider: 'deepseek', model: 'deepseek-v4-flash' }, analysis);
    assert.equal(input.recent_action_history.length, 12);
    assert.equal(input.public_memory.played_cards, undefined);
    assert.ok(input.public_memory.unseen_cards);
    assert.equal(input.played_by_seat.length, 4);
    assert.ok(input.played_by_seat.every((player: any) => player.cards.length > 0));
    assert.deepEqual(input.local_analysis.hand_turns, { turns: 1, exact: true });
    assert.equal(input.team_plan.goal, 'finish_self');
    assert.ok(requestBody.messages[0].content.includes(STRATEGY_GUIDE));
    assert.equal(input.strategy_framework.framework_version, 'whole-hand-v2');
    assert.equal(input.strategy_framework.priority_order[0], 'direct_finish');
    assert.ok(input.strategy_framework.mandatory_comparison.includes('lower_resource_action'));
    const route = input.team_routes.find((item: any) => item.goal === 'finish_self');
    assert.equal(route.action_id, 0);
    assert.deepEqual(input.legal_actions[route.action_id].analysis.remainingTurns, analysis.candidates[analysisKey(plays[0])].remainingTurns);
    assert.deepEqual(input.legal_actions[route.action_id].analysis.continuation, analysis.candidates[analysisKey(plays[0])].continuation);
    assert.ok(input.team_routes.every((item: any) => Number.isInteger(item.action_id) && item.action_id >= 0));

    assert.equal(input.legal_actions[0].analysis.remainingTurns.turns, 0);
    assert.equal(input.candidate_coverage.model_actions, plays.length);
    assert.equal(input.candidate_coverage.represented_equivalent_actions, plays.length);
    assert.equal(input.hand_combinations.same_as_legal_actions, true);
    assert.equal(input.legal_actions[0].equivalent_variants, 1);
    assert.equal(input.legal_actions[0].cost.uses_aces, undefined);
    assert.equal(input.legal_actions[0].cost.uses_bomb, undefined);
    assert.equal(typeof input.public_inference.unseen_controls, 'string');
    assert.ok(input.public_memory.publicly_known_cards.every((p: any) => p.cards === ''));
    assert.equal(input.sampled_hands, undefined);
    assert.equal(requestBody.max_tokens, 4096);
    assert.ok(requestBody.messages[1].content.includes('下一步，32字内'));
    assert.ok(requestBody.messages[1].content.includes('20字内'));
    assert.ok(requestBody.messages[1].content.includes('decision_check'));
    assert.ok(requestBody.messages[1].content.includes('direct_finish、block_opponent、help_partner、own_route、organize、hold_control'));
    assert.deepEqual(requestBody.thinking, { type: 'disabled' });
    assert.equal(requestBody.reasoning_effort, undefined);
    assert.equal(requestBody.temperature, undefined);
    assert.deepEqual(requestBody.response_format, { type: 'json_object' });
    assert.ok(requestBody.messages[0].content.length < 2500);
    const telemetry = getAiTelemetrySnapshot();
    assert.equal(telemetry.modelCalls, 1);
    assert.equal(telemetry.modelOutcomes.success, 1);
    assert.ok(telemetry.promptCharacters > 0);
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
    aiStrategyMemory: Map<string, any>;
    recordAiAction(action: AiRecentAction): void;
    getAiDecisionContext(seat: number): AiDecisionContext;
  };
  internals.publicActionHistory = context.actionHistory!;
  const memory = { next: '先试探再收牌', reconsiderWhen: '对手报单', afterAction: 1, executed: 'PASS' };
  internals.aiStrategyMemory.set('p0', memory);
  internals.aiStrategyMemory.set('p1', { ...memory, next: '保留对子' });
  assert.equal(internals.getAiDecisionContext(0).strategyMemory?.next, memory.next);
  assert.equal(internals.getAiDecisionContext(1).strategyMemory?.next, '保留对子');
  assert.equal(internals.getAiDecisionContext(2).strategyMemory, undefined);
  internals.publicActionHistory = [...internals.publicActionHistory];
  internals.recordAiAction({ seatIndex: 0, action: 'pass' });
  assert.equal(internals.getAiDecisionContext(0).strategyMemory, undefined);
  assert.ok(internals.getAiDecisionContext(1).strategyMemory);
  internals.publicActionHistory = context.actionHistory!;

  // Deliberately make private hands disagree: they must not be consulted.
  room.hands.set('p1', deck.slice(0, 20));
  assert.deepEqual(internals.getAiDecisionContext(0).players.map(p => p.cardCount), [1, 1, 1, 1]);
  assert.equal(internals.getAiDecisionContext(0).actionHistory!.length, 104);
  try {
    room.startGame();
    const next = internals.getAiDecisionContext(0);
    assert.deepEqual(next.actionHistory, []);
    assert.equal(internals.aiStrategyMemory.size, 0);
    assert.deepEqual(next.players.map(p => p.cardCount), [27, 27, 27, 27]);
  } finally {
    if (room.turnTimer) clearTimeout(room.turnTimer);
  }
});


test('unified decision lets paired team outcomes override reported-maximum preference', () => {
  const hand = rankedHand([Rank.Ace, Rank.BigJoker, Rank.Seven]);
  const plays = generateLegalPlays(hand, Rank.Two).filter(p => p.type === PatternType.Single
    && [Rank.Ace, Rank.BigJoker].includes(p.rank));
  const ace = plays.find(p => p.rank === Rank.Ace)!;
  const joker = plays.find(p => p.rank === Rank.BigJoker)!;
  const last: CardPattern = { type: PatternType.Single, rank: Rank.King, length: 1,
    cards: [{ id: 99, rank: Rank.King, suit: Suit.Spade }] };
  const context = contextFor([hand, [], [], []]);
  context.lastPlayPlayerIndex = 3;
  context.players[1].cardCount = 1;
  const sample = (meanReward: number) => ({ samples: 16, meanReward, winRate: 0.5, doubleWinRate: 0 });
  const analysis: DecisionAnalysis = {
    handTurns: { turns: 3, exact: true },
    candidates: {
      [analysisKey(ace)]: { remainingTurns: { turns: 2, exact: true }, simulation: sample(0.8) },
      [analysisKey(joker)]: { remainingTurns: { turns: 2, exact: true }, simulation: sample(-0.4) },
    }, passSimulation: sample(-0.8), simulation: { samples: 16, elapsedMs: 0, status: 'sampled' },
  };
  assert.equal(finalizeAiDecision(joker, plays, hand, last, false, Rank.Two, context, analysis), ace);
  analysis.candidates[analysisKey(ace)].simulation!.samples = 2;
  assert.equal(finalizeAiDecision(ace, plays, hand, last, false, Rank.Two, context, analysis), joker,
    'insufficient evidence keeps reported-maximum protection');
});


test('endgame response branches expose an opponent finishing after a probe', () => {
  const deck = createDeck();
  const take = (rank: Rank, count = 1) => deck.filter(c => c.rank === rank).slice(0, count);
  const hands = [[...take(Rank.Three), ...take(Rank.King, 2)], take(Rank.Four), take(Rank.Five), take(Rank.Six)];
  const context = contextFor(hands);
  const probe = generateLegalPlays(hands[0], Rank.Two).find(p => p.rank === Rank.Three)!;
  const passive = (hand: Card[], last: CardPattern | null, free: boolean, level: number) =>
    free ? generateLegalPlays(hand, level).sort((a, b) => b.cards.length - a.cards.length)[0] : null;
  const deadline = performance.now() + 1000;
  const baseline = rollout(hands, probe, null, Rank.Two, context, passive, deadline)!;
  const control = rollout(hands, probe, null, Rank.Two, context, passive, deadline,
    { mode: 'control', generate: generateLegalPlays })!;
  const hold = rollout(hands, probe, null, Rank.Two, context, passive, deadline,
    { mode: 'hold', generate: generateLegalPlays })!;
  assert.equal(baseline.win, true);
  assert.equal(control.win, false, 'active reply finishes before the probing player can recapture');
  assert.deepEqual(hold, control, 'even a conservative opponent takes an immediate finish');
});


test('team routes compare feeding mixed singles, seat interception, takeover and holding', () => {
  const deck = createDeck();
  const take = (rank: Rank, n = 1) => deck.filter(c => c.rank === rank).slice(0, n);
  const hands = [[...take(Rank.Three, 2), ...take(Rank.Ace)], take(Rank.Four),
    [...take(Rank.Five), ...take(Rank.Seven)], take(Rank.Six)];
  const context = contextFor(hands);
  context.publicTransfers = hands[2].map(card => ({ fromSeat: 1, toSeat: 2, card }));
  const plays = generateLegalPlays(hands[0], Rank.Two);
  const leadRoutes = buildTeamRoutes(hands[0], plays, plays, null, Rank.Two, context, {}, generateLegalPlays);
  const feeds = leadRoutes.filter(route => route.goal === 'feed_partner');
  assert.equal(feeds.length, 1, 'known mixed singles must not be treated as a pair');
  assert.equal(plays.find(play => analysisKey(play) === feeds[0].actionKey)?.type, PatternType.Single);
  assert.deepEqual(feeds[0].interceptSeats, [1], 'the opponent before the partner can finish first');
  assert.ok(leadRoutes.some(route => route.goal === 'finish_self'));
  const last = generateLegalPlays(take(Rank.King), Rank.Two)[0];
  const replies = plays.filter(play => play.type === PatternType.Single && play.rank === Rank.Ace);
  const followRoutes = buildTeamRoutes(hands[0], plays, replies, last, Rank.Two, context, {}, generateLegalPlays);
  assert.ok(followRoutes.some(route => route.goal === 'hold_control' && route.actionKey === null));
  const takeover = followRoutes.find(route => route.goal === 'takeover_change')!;
  assert.equal(takeover.actionKey, analysisKey(replies[0]));
  assert.equal(takeover.nextLead?.rank, Rank.Three, 'taking control retains a real disjoint feed');
  const unknown = buildTeamRoutes(hands[0], plays, plays, null, Rank.Two,
    { ...context, publicTransfers: [] }, {}, generateLegalPlays);
  assert.equal(unknown.filter(route => route.goal === 'feed_partner').length, 2,
    'unknown two-card partner gets single and pair alternatives');
});


test('behavior inference distinguishes cheap passes, protected groups and teammate passes', () => {
  const deck = createDeck();
  const take = (rank: Rank, n = 1) => deck.filter(c => c.rank === rank).slice(0, n);
  const hands = [take(Rank.Three), take(Rank.Four), [...take(Rank.Ten), ...take(Rank.Five)], take(Rank.Six)];
  const context = contextFor(hands);
  const lead = generateLegalPlays(take(Rank.Seven), Rank.Two)[0];
  context.actionHistory = [{ seatIndex: 1, action: 'play', pattern: lead }, { seatIndex: 2, action: 'pass' }];
  const loose = behaviorConsistencyWeight(hands, context, Rank.Two);
  const protectedHands = hands.map(cards => [...cards]);
  protectedHands[2] = take(Rank.Ten, 2);
  assert.ok(loose < behaviorConsistencyWeight(protectedHands, context, Rank.Two),
    'a pass is less surprising when beating would split a pair');
  context.actionHistory[0].seatIndex = 0;
  assert.equal(behaviorConsistencyWeight(hands, context, Rank.Two), 1, 'passing partner is not negative evidence');
  context.actionHistory = [{ seatIndex: 2, action: 'play', pattern: generateLegalPlays(take(Rank.Ten).map(c => ({ ...c, id: 999 })), Rank.Two)[0] }];
  assert.ok(behaviorConsistencyWeight(hands, context, Rank.Two) < 1, 'unnecessary group splitting is soft evidence');
  assert.ok(loose > 0, 'a pass never rules a holding out');
});

test('seat beliefs respect public transfers and distinguish two singles from a pair', () => {
  const deck = createDeck();
  const take = (rank: Rank, n = 1) => deck.filter(c => c.rank === rank).slice(0, n);
  for (const partner of [[...take(Rank.Five), ...take(Rank.Seven)], take(Rank.Five, 2)]) {
    const hands = [take(Rank.Three), take(Rank.Four), partner, take(Rank.Six)];
    const context = contextFor(hands);
    context.publicTransfers = partner.map(card => ({ fromSeat: 1, toSeat: 2, card }));
    const beliefs = inferSeatBeliefs(hands[0], context, Rank.Two, performance.now() + 1000, () => 0.5);
    const belief = beliefs.find(item => item.seat === 2)!;
    assert.equal(belief.samples, 16);
    assert.equal(belief.pairProbability, partner[0].rank === partner[1].rank ? 1 : 0);
    assert.ok(!beliefs.some(item => item.seat === 0), 'no redundant inference of our own known hand');
  }
});


test('bomb continuation exposes the lost straight and guards calm waste, but allows urgent defence', async () => {
  const hand = rankedHand([3, 3, 3, 3, 13, 13, 7, 7, 4, 5, 6]);
  const plays = generateLegalPlays(hand, Rank.Two);
  const bomb = plays.find(play => play.type === PatternType.Bomb4)!;
  const analysis = await analyzeDecision(hand, plays, [bomb], null, Rank.Two, undefined, findBestPlay,
    { budgetMs: 200 });
  assert.equal(analysis.handTurns.turns, 3);
  assert.equal(analysis.candidates[analysisKey(bomb)].remainingTurns.turns, 5);
  assert.deepEqual(analysis.candidates[analysisKey(bomb)].continuation,
    { extraTurns: 3, exact: true, largestRemainingGroup: 2, tailControlCost: 0 });
  const context = contextFor([hand, [], [], []]);
  context.lastPlayPlayerIndex = 1;
  context.players.forEach(p => { if (p.relation !== 'self') p.cardCount = 8; });
  const last = generateLegalPlays(rankedHand([Rank.BigJoker]), Rank.Two)[0];
  assert.equal(enforceTeamStrategy(bomb, [bomb], hand, last, false, Rank.Two, context, analysis), null);
  context.players[2].finishRank = 1;
  assert.equal(enforceTeamStrategy(bomb, [bomb], hand, last, false, Rank.Two, context, analysis), null,
    'a finished partner alone does not justify destroying the exit');
  context.players[1].cardCount = 5;
  assert.equal(enforceTeamStrategy(bomb, [bomb], hand, last, false, Rank.Two, context, analysis), bomb,
    'five cards may be a full-house finish, so defence remains available');
  context.players[1].cardCount = 2;
  assert.equal(enforceTeamStrategy(bomb, [bomb], hand, last, false, Rank.Two, context, analysis), bomb);
});


test('partner head changes the objective and unmeasured PASS cannot ignore a local interception', () => {
  const hand = rankedHand([Rank.BigJoker, Rank.Three, Rank.Four]);
  const plays = generateLegalPlays(hand, Rank.Two);
  const joker = plays.find(play => play.rank === Rank.BigJoker)!;
  const last = generateLegalPlays(rankedHand([Rank.King]), Rank.Two)[0];
  const context = contextFor([hand, [], [], []]);
  context.lastPlayPlayerIndex = 1;
  context.players[1].cardCount = 4;
  context.players[2].finishRank = 1;
  context.players[3].cardCount = 8;
  assert.equal(buildTeamPlan(hand, plays, context).goal, 'finish_self');
  assert.equal(finalizeAiDecision(null, [joker], hand, last, false, Rank.Two, context, undefined, joker), joker);
  assert.equal(finalizeAiDecision(null, [joker], hand, last, false, Rank.Two, context, undefined, null), null,
    'no interception is invented when local policy also passes');
  context.players[2].finishRank = null;
  assert.equal(finalizeAiDecision(null, [joker], hand, last, false, Rank.Two, context, undefined, joker), null,
    'normal midgame model PASS is preserved');
  context.players[2].finishRank = 1;
  context.players[1].finishRank = 2;
  context.players[1].cardCount = 0;
  assert.match(buildTeamPlan(hand, plays, context).reason, /争三游/);
  assert.equal(finalizeAiDecision(null, [joker], hand, last, false, Rank.Two, context, undefined, joker), null,
    'cannot pretend an already finished opponent is still about to finish');
});


test('repeated enemy leads spend a loose joker with a group exit; teammate and calm passes remain', () => {
  const hand = rankedHand([Rank.BigJoker, 3, 3, 3, 5]);
  const joker = generateLegalPlays(hand, 2).find(p => p.rank === Rank.BigJoker)!;
  const last = generateLegalPlays(rankedHand([Rank.Two]), 2)[0];
  const context = contextFor([hand, [], [], []]);
  context.lastPlayPlayerIndex = 1;
  context.players.forEach(p => { if (p.relation !== 'self') p.cardCount = 12; });
  context.actionHistory = [{ seatIndex: 1, action: 'play', pattern: last },
    { seatIndex: 0, action: 'pass' }, { seatIndex: 1, action: 'play', pattern: last }];
  assert.equal(finalizeAiDecision(null, [joker], hand, last, false, 2, context, undefined, null), joker);
  context.actionHistory = context.actionHistory.slice(-1);
  assert.equal(finalizeAiDecision(null, [joker], hand, last, false, 2, context, undefined, null), null);
  context.lastPlayPlayerIndex = 2;
  assert.equal(finalizeAiDecision(null, [joker], hand, last, false, 2, context, undefined, joker), null);
});

test('last response to a reported single cannot save a bomb until after the opponent finishes', () => {
  const hand = rankedHand([4, 4, 4, 4, 6, 7]);
  const bomb = generateLegalPlays(hand, 2).find(p => p.type === PatternType.Bomb4)!;
  const last = generateLegalPlays(rankedHand([Rank.King, Rank.King]), 2).find(p => p.type === PatternType.Pair)!;
  const context = contextFor([hand, [], [], []]);
  context.lastPlayPlayerIndex = 1;
  context.passCount = 2;
  context.players.forEach(p => { if (p.relation !== 'self') p.cardCount = p.seatIndex === 1 ? 1 : 8; });
  assert.equal(finalizeAiDecision(null, [bomb], hand, last, false, 2, context, undefined, null), bomb);
  context.players[1].finishRank = 1;
  assert.equal(finalizeAiDecision(null, [bomb], hand, last, false, 2, context, undefined, null), null);
});


test('model tempo remembers repeated passes beyond recent history and uses table progress', () => {
  const context = contextFor([rankedHand([3]), [], [], []]);
  context.players.forEach(p => { p.cardCount = p.seatIndex === 1 ? 8 : 26; });
  context.lastPlayPlayerIndex = 1;
  const pattern = generateLegalPlays(rankedHand([Rank.Ace]), 2)[0];
  context.actionHistory = Array.from({ length: 6 }, () => [
    { seatIndex: 1, action: 'play' as const, pattern },
    { seatIndex: 0, action: 'pass' as const },
    { seatIndex: 2, action: 'pass' as const },
    { seatIndex: 3, action: 'pass' as const },
  ]).flat();
  context.recentActions = context.actionHistory.slice(-12);
  assert.equal(decisionTempo(context).consecutiveLeaderPlays, 6);
  assert.equal(decisionTempo(context).ownPassesDuringStreak, 6);
  assert.equal(decisionTempo(context).stage, '中盘');
  context.players[1].cardCount = 1;
  assert.equal(decisionTempo(context).stage, '残局');
});

test('urgent interception may split a rank group with bounded whole-hand cost', async () => {
  const hand = rankedHand([11, 11, 3, 3, 3, 5]);
  hand.filter(c => c.rank === 11).forEach(c => { c.suit = Suit.Spade; });
  const all = generateLegalPlays(hand, 11);
  const single = all.find(p => p.type === PatternType.Single && p.rank === 11)!;
  const last = generateLegalPlays(rankedHand([10]), 11)[0];
  const context = contextFor([hand, [], [], []]);
  context.lastPlayPlayerIndex = 1;
  context.players.forEach(p => { if (p.relation !== 'self') p.cardCount = 8; });
  context.players[1].cardCount = 2;
  context.actionHistory = [];
  const analysis = await analyzeDecision(hand, all, [single], last, 11, undefined, findBestPlay, { budgetMs: 200 });
  assert.ok(analysis.candidates[analysisKey(single)].continuation!.extraTurns <= 2);
  assert.equal(finalizeAiDecision(null, [single], hand, last, false, 11, context, analysis, null), single);
  context.players[1].cardCount = 8;
  assert.equal(finalizeAiDecision(null, [single], hand, last, false, 11, context, analysis, null), null);
  context.lastPlayPlayerIndex = 2;
  context.players[2].cardCount = 1;
  assert.equal(finalizeAiDecision(null, [single], hand, last, false, 11, context, analysis, null), null);
});

test('late wild bomb yields to a proven ordinary lock that preserves the exit', async () => {
  const deck = createDeck();
  const take = (rank: Rank, n = 1) => deck.filter(c => c.rank === rank).slice(0, n);
  const hand = [...deck.filter(c => c.rank === 11 && [Suit.Spade, Suit.Heart].includes(c.suit)),
    ...take(12, 2), ...take(13, 2), ...take(3)];
  const context = contextFor([hand, [...take(14), ...take(8)], [], []]);
  context.lastPlayPlayerIndex = 1;
  context.players[2].finishRank = 1;
  context.players[3].finishRank = 2;
  const last = generateLegalPlays(take(7), 11)[0];
  const all = generateLegalPlays(hand, 11);
  const bomb = all.find(p => p.type === PatternType.Bomb4 && p.rank === 11)!;
  const single = all.find(p => p.type === PatternType.Single && p.rank === 11 && p.cards[0].suit === Suit.Spade)!;
  const queen = all.find(p => p.type === PatternType.Single && p.rank === 12)!;
  const analysis = await analyzeDecision(hand, all, [bomb, single, queen], last, 11, undefined, findBestPlay, { budgetMs: 200 });
  assert.equal(publicControlEvidence(single, hand, 11, context)?.unbeatable, true);
  assert.ok(analysis.candidates[analysisKey(single)].remainingTurns.turns
    < analysis.candidates[analysisKey(bomb)].remainingTurns.turns);
  assert.equal(enforceTeamStrategy(bomb, [bomb, single, queen], hand, last, false, 11, context, analysis), single);
  assert.equal(enforceTeamStrategy(bomb, [bomb, single, queen], hand, last, false, 11,
    { ...context, actionHistory: undefined }, analysis), bomb, 'no lock without public evidence');
  const result = (meanReward: number) => ({ meanReward, samples: 16, winRate: 0.5, doubleWinRate: 0 });
  analysis.candidates[analysisKey(bomb)].simulation = result(0.8);
  analysis.candidates[analysisKey(single)].simulation = result(0);
  assert.equal(enforceTeamStrategy(bomb, [bomb, single, queen], hand, last, false, 11, context, analysis), bomb,
    'material paired team outcome still wins over the structure preference');
  context.lastPlayPlayerIndex = 2;
  assert.equal(enforceTeamStrategy(bomb, [bomb, single, queen], hand, last, false, 11, context, undefined), null,
    'the new substitution does not authorize stealing a teammate trick');
});

test('strategy memory reaches only its decision; corrected actions discard the proposed plan', async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-only';
  const hand = rankedHand([3, 3, 3]);
  const all = generateLegalPlays(hand, 2);
  const context = contextFor([hand, [], [], []]);
  context.strategyMemory = { next: '先试探', reconsiderWhen: '对手报单', afterAction: 0, executed: 'PASS' };
  let requestedInput: any;
  let rawResult: any = { action_id: 0,
    decision_check: { goal: 'direct_finish', resource_use: 'none', worst_reply: '无', why_not_lower_cost: '直接走完' },
    strategy_plan: { next: '保留控制张', reconsider_when: '对手报单' } };
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    requestedInput = JSON.parse(body.messages[1].content.split('\n')[1]);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(rawResult) } }] }) } as Response;
  }) as typeof fetch;
  try {
    let received: any;
    await llmFindBestPlay(hand, all, null, true, 2, context,
      { provider: 'deepseek', model: 'deepseek-flash' }, undefined, [], all, [], p => { received = p; });
    assert.deepEqual(requestedInput.strategy_memory, context.strategyMemory);
    assert.equal((received as any).next, '保留控制张');
    assert.equal(parseStrategyPlan({ next: 'x' }), undefined);
    assert.equal(parseStrategyPlan({ next: 'x'.repeat(100), reconsider_when: 'y' })?.next.length, 80);
    // Invalid free-lead PASS must never publish a plan.
    rawResult.action_id = 'PASS' as any;
    received = undefined;
    await llmFindBestPlay(hand, all, null, true, 2, context,
      { provider: 'deepseek', model: 'deepseek-flash' }, undefined, [], all, [], p => { received = p; });
    assert.equal(received, undefined);
    // Index zero is the full-hand finish after sorting. Index one is a
    // legal partial play which the finish guard must replace.
    rawResult.action_id = 1;
    await findSmartPlay(hand, null, true, 2, undefined,
      { provider: 'deepseek', model: 'deepseek-flash' }, p => { received = p; });
    assert.equal(received, undefined);
    rawResult.action_id = 0;
    await findSmartPlay(hand, null, true, 2, undefined,
      { provider: 'deepseek', model: 'deepseek-flash' }, p => { received = p; });
    assert.equal(received, undefined, 'a finished hand has no next-hand plan');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  }
});

test('live-context model decisions require a truthful compact strategy check', async () => {
  assert.deepEqual(parseDecisionCheck({ goal: 'organize', resource_use: 'preserve',
    worst_reply: '对手接管', why_not_lower_cost: '已是最低资源' }), {
    goal: 'organize', resourceUse: 'preserve', worstReply: '对手接管', whyNotLowerCost: '已是最低资源',
  });
  assert.equal(parseDecisionCheck({ goal: 'invented', resource_use: 'preserve',
    worst_reply: 'x', why_not_lower_cost: 'y' }), undefined);

  const previousFetch = globalThis.fetch;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-only';
  const ace = rankedHand([Rank.Ace]);
  const plays = generateLegalPlays(ace, Rank.Two);
  const context: AiDecisionContext = {
    selfSeatIndex: 0, partnerSeatIndex: 2, lastPlayPlayerIndex: -1,
    roundNumber: 1, teamLevels: [2, 2], leadingTeam: 0, passCount: 0,
    actionHistory: [], recentActions: [],
    players: [0, 1, 2, 3].map(seat => ({ seatIndex: seat, cardCount: seat ? 27 : 1,
      finishRank: null, relation: seat === 0 ? 'self' : seat === 2 ? 'partner' : 'opponent' })),
  };
  let response: any = { action_id: 0 };
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(response) } }],
  }))) as typeof fetch;
  try {
    assert.equal(await llmFindBestPlay(ace, plays, null, true, Rank.Two, context,
      { provider: 'deepseek', model: 'deepseek-flash' }), undefined,
    'missing audit is rejected when a real table context is present');
    response = { action_id: 0, decision_check: { goal: 'direct_finish', resource_use: 'preserve',
      worst_reply: '无', why_not_lower_cost: '直接走完' } };
    assert.equal(await llmFindBestPlay(ace, plays, null, true, Rank.Two, context,
      { provider: 'deepseek', model: 'deepseek-flash' }), undefined,
    'claiming preservation while spending an ace is rejected');
    response.decision_check.resource_use = 'spend_justified';
    assert.equal(await llmFindBestPlay(ace, plays, null, true, Rank.Two, context,
      { provider: 'deepseek', model: 'deepseek-flash' }), plays[0]);

    const bombHand = rankedHand([Rank.Three, Rank.Three, Rank.Three, Rank.Three]);
    const bomb = generateLegalPlays(bombHand, Rank.Two)
      .find(play => play.type === PatternType.Bomb4)!;
    context.players[0].cardCount = bombHand.length;
    response = { action_id: 0, decision_check: { goal: 'direct_finish', resource_use: 'preserve',
      worst_reply: '无', why_not_lower_cost: '直接走完' } };
    assert.equal(await llmFindBestPlay(bombHand, [bomb], null, true, Rank.Two, context,
      { provider: 'deepseek', model: 'deepseek-flash' }), undefined,
    'playing an intact bomb is itself a control-resource spend');
    response.decision_check.resource_use = 'spend_justified';
    assert.equal(await llmFindBestPlay(bombHand, [bomb], null, true, Rank.Two, context,
      { provider: 'deepseek', model: 'deepseek-flash' }), bomb);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  }
});

test('failed-model fallback unloads groups before loose jokers, without disabling interception or finish', async () => {
  const oldFetch = globalThis.fetch;
  const names = ['DEEPSEEK_API_KEY', 'LOCAL_LLM_API_KEY'] as const;
  const old = names.map(name => process.env[name]);
  process.env.DEEPSEEK_API_KEY = process.env.LOCAL_LLM_API_KEY = 'test-only';
  globalThis.fetch = (async () => new Response('', { status: 503 })) as typeof fetch;
  const deck = createDeck();
  const take = (rank: Rank, n = 1) => deck.filter(c => c.rank === rank).slice(0, n);
  // Physical cards from the reviewed 17-card position (suits affect straights).
  const hand = [52, 107, 58, 43, 85, 44, 73, 86, 2, 82, 28, 41, 95, 88, 47, 67, 42]
    .map(id => deck.find(c => c.id === id)!);
  try {
    for (const cards of [hand, hand.filter(c => c.rank !== Rank.SmallJoker)]) {
      const result = await findSmartPlay(cards, null, true, Rank.Two);
      assert.equal(result?.type, PatternType.ConsecutivePair);
      assert.equal(result?.rank, Rank.Eight);
    }
    const joker = take(Rank.BigJoker);
    const exitHand = [...joker, ...take(3, 3)];
    const levelSingle = generateLegalPlays(take(2), Rank.Two)[0];
    const interception = await findSmartPlay(exitHand, levelSingle, false, Rank.Two);
    assert.equal(interception?.rank, Rank.BigJoker, 'following an opponent still uses control to get back in');
    const finish = await findSmartPlay(joker, null, true, Rank.Two);
    assert.equal(finish?.rank, Rank.BigJoker, 'direct finish never hoards a joker');
    const allJokers = await findSmartPlay([...joker, ...take(Rank.SmallJoker)], null, true, Rank.Two);
    assert.ok(allJokers && allJokers.cards.every(c => c.rank >= Rank.SmallJoker),
      'when only jokers remain they still get played');
  } finally {
    globalThis.fetch = oldFetch;
    names.forEach((name, i) => {
      if (old[i] === undefined) delete process.env[name];
      else process.env[name] = old[i];
    });
  }
});


test('protect a one-play exit unless interception is urgent or publicly secure', async () => {
  const deck = createDeck();
  const take = (rank: Rank, n = 1) => deck.filter(c => c.rank === rank).slice(0, n);
  const hand = [...take(10, 3), ...take(6, 2)];
  const all = generateLegalPlays(hand, 5);
  const ten = all.find(p => p.type === PatternType.Single && p.rank === 10)!;
  const last = generateLegalPlays(take(7), 5)[0];
  const context = contextFor([hand, [...take(8), ...take(9), ...take(11)], [], [...take(Rank.BigJoker), ...take(12), ...take(13)]]);
  context.lastPlayPlayerIndex = 1;
  context.players[2].finishRank = 1;
  const analysis = await analyzeDecision(hand, all, [ten], last, 5, undefined, findBestPlay, { budgetMs: 100 });
  assert.equal(analysis.handTurns.turns, 1);
  assert.equal(finalizeAiDecision(ten, [ten], hand, last, false, 5, context, analysis), null);
  context.players[1].cardCount = 1;
  assert.equal(finalizeAiDecision(ten, [ten], hand, last, false, 5, context, analysis), ten,
    'do not freeze the whole hand while an opponent is about to finish');
  context.players[1].cardCount = 0;
  context.players[1].finishRank = 2;
  assert.equal(finalizeAiDecision(ten, [ten], hand, last, false, 5, context, analysis), ten,
    'denying catch-wind is still allowed');

  const safe = contextFor([hand, [...take(8), ...take(9), ...take(2)], [], []]);
  safe.lastPlayPlayerIndex = 1;
  safe.players[2].finishRank = 1;
  safe.players[3].finishRank = 2;
  assert.equal(publicControlEvidence(ten, hand, 5, safe)?.unbeatable, true);
  assert.equal(finalizeAiDecision(ten, [ten], hand, last, false, 5, safe, analysis), ten);
});

test('last responder can split a ready pair cheaply against repeated opponent leads', async () => {
  const hand = rankedHand([5, 5]);
  const candidates = generateLegalPlays(hand, Rank.Two).filter(p => p.type === PatternType.Single);
  const last = generateLegalPlays([{ id: 10, rank: Rank.Four, suit: Suit.Diamond }], Rank.Two)[0];
  const context = contextFor([hand, rankedHand([3, 6, 7, 8, 9, 10, 11]), [], rankedHand([3, 6, 12])]);
  context.players[2].finishRank = 1;
  context.lastPlayPlayerIndex = 1;
  context.passCount = 1;
  context.actionHistory = [{ seatIndex: 1, action: 'play', pattern: last },
    { seatIndex: 3, action: 'pass' }, { seatIndex: 0, action: 'pass' },
    { seatIndex: 1, action: 'play', pattern: last }, { seatIndex: 3, action: 'pass' }];
  const analysis = await analyzeDecision(hand, generateLegalPlays(hand, Rank.Two), candidates, last,
    Rank.Two, undefined, findBestPlay, { budgetMs: 100 });
  assert.equal(finalizeAiDecision(candidates[0], candidates, hand, last, false, Rank.Two, context, analysis)?.rank, Rank.Five);
  assert.equal(finalizeAiDecision(null, candidates, hand, last, false, Rank.Two, context, analysis)?.rank, Rank.Five);
  context.passCount = 0;
  assert.equal(finalizeAiDecision(candidates[0], candidates, hand, last, false, Rank.Two, context, analysis), null);
});


test('short free-lead probes survive the weakest-card guard but follow economy remains', () => {
  const hand = rankedHand([2, 6, 7, 8]);
  const plays = generateLegalPlays(hand, 5);
  const eight = plays.find(p => p.rank === 8)!;
  assert.equal(enforceTeamStrategy(eight, plays, hand, null, true, 5), eight);
  const last = generateLegalPlays(rankedHand([3]), 5)[0];
  const legal = plays.filter(p => p.rank > 3);
  assert.equal(enforceTeamStrategy(eight, legal, hand, last, false, 5)?.rank, 6,
    'ordinary following still conserves the stronger card');
  const context = contextFor([hand, [], [], []]);
  context.players[1].cardCount = 1;
  const two = plays.find(p => p.rank === 2)!;
  assert.equal(enforceTeamStrategy(two, plays, hand, null, true, 5, context), eight,
    'reported-next-player defence still runs first');
});


test('team takeover compares a proven own exit with partner progress without sharing hands', () => {
  const deck = createDeck();
  const take = (rank: Rank, n = 1) => deck.filter(c => c.rank === rank).slice(0, n);
  const hand = [...take(Rank.BigJoker), ...take(3, 3)];
  const sixes = take(6, 2);
  const context = contextFor([hand, [...take(4, 2), sixes[0]],
    [...take(12, 2), ...take(7, 2), ...take(8)], [sixes[1], ...take(10, 2)]]);
  context.lastPlayPlayerIndex = 2;
  const last = generateLegalPlays(take(5), 2)[0];
  context.actionHistory = context.actionHistory!.filter(a => !a.pattern?.cards.some(c => c.id === last.cards[0].id));
  context.actionHistory.push({ seatIndex: 2, action: 'play', pattern: last });
  const all = generateLegalPlays(hand, 2);
  const joker = all.find(p => p.rank === Rank.BigJoker)!;
  assert.equal(publicControlEvidence(joker, hand, 2, context)?.unbeatable, true);
  assert.equal(enforceTeamStrategy(joker, [joker], hand, last, false, 2, context), joker);
  assert.equal(findBestPlay(hand, last, false, 2, context)?.rank, Rank.BigJoker,
    'local and final policies agree about the concrete takeover');
  assert.equal(enforceTeamStrategy(joker, [joker], hand, last, false, 2,
    { ...context, actionHistory: undefined }), null, 'uncertain control cannot steal the near-finished partner lead');
  context.players[2].cardCount = 3;
  assert.equal(enforceTeamStrategy(joker, [joker], hand, last, false, 2, context), null,
    'do not overtake when partner is already at least as close by public count');
  context.players[2].cardCount = 2;
  assert.equal(enforceTeamStrategy(joker, [joker], hand, last, false, 2, context), null);
});


test('candidate cap retains a low-ranked strategic representative without exceeding the limit', () => {
  const plays: CardPattern[] = Array.from({ length: 100 }, (_, id) => ({
    type: PatternType.Single, rank: Rank.Three, length: 1,
    cards: [{ id, rank: Rank.Three, suit: Suit.Spade }],
  }));
  const preferred = plays[99];
  const compressed = { plays, equivalentCounts: plays.map((_, i) => i + 1) };
  const result = limitModelCandidates(compressed, 12, new Set([analysisKey(preferred)]));
  assert.equal(result.plays.length, 12);
  assert.ok(result.plays.includes(plays[0]), 'preserve the local top choice too');
  assert.ok(result.plays.includes(preferred), 'retain the strategic alternative before truncation');
  assert.equal(result.equivalentCounts[result.plays.indexOf(preferred)], 100);
});


test('unmeasured route selection preserves ordering rather than rewarding card count', () => {
  const hand = rankedHand([3, 3, 3, 7, 8, 9]);
  const plays = generateLegalPlays(hand, 2);
  const single = plays.find(p => p.type === PatternType.Single && p.rank === 7)!;
  const triple = plays.find(p => p.type === PatternType.Triple)!;
  const context = contextFor([hand, [], [], []]);
  const routes = buildTeamRoutes(hand, plays, [single, triple], null, 2, context, {});
  assert.equal(routes.find(r => r.goal === 'finish_self')?.actionKey, analysisKey(single));
  const measured = buildTeamRoutes(hand, plays, [single, triple], null, 2, context, {
    [analysisKey(single)]: { remainingTurns: { turns: 3, exact: true } },
    [analysisKey(triple)]: { remainingTurns: { turns: 2, exact: true } },
  });
  assert.equal(measured.find(r => r.goal === 'finish_self')?.actionKey, analysisKey(triple));
});

test('reviewed opening preserves both heart-level wildcards when natural cards make the same straight', () => {
  const deck = createDeck();
  const hand = [66,80,69,19,73,11,91,37,14,68,57,96,17,71,59,44,63,9,76,22,102,7,61,75,10,23,104]
    .map(id => deck.find(c => c.id === id)!);
  const proposed: CardPattern = {
    type: PatternType.Straight, rank: Rank.Five, length: 5,
    cards: [66,80,69,19,73].map(id => hand.find(c => c.id === id)!),
    substitutions: [{ id: 19, rank: Rank.Three, suit: Suit.Spade }, { id: 73, rank: Rank.Five, suit: Suit.Spade }],
  };
  const context = contextFor([hand, [], [], []]);
  context.players.forEach(p => { p.cardCount = 27; });
  context.actionHistory = [];
  context.recentActions = [];
  const all = generateLegalPlays(hand, Rank.Eight);
  const result = finalizeAiDecision(proposed, all, hand, null, true, Rank.Eight, context)!;
  assert.equal(result.type, PatternType.Straight);
  assert.equal(result.rank, Rank.Five);
  assert.equal(result.cards.length, 5);
  assert.ok(result.cards.every(c => c.rank !== Rank.Eight || c.suit !== Suit.Heart),
    'same-strength natural lead keeps both wildcards');
  for (const rank of [Rank.King, Rank.Jack]) {
    assert.ok(result.cards.every(c => c.rank !== rank), 'does not dismantle a natural bomb');
  }
  const lowPairs = all.find(p => p.type === PatternType.ConsecutivePair && p.rank === 4
    && p.cards.filter(c => c.rank === 8 && c.suit === Suit.Heart).length === 2)!;
  assert.ok(lowPairs);
  assert.ok(!pruneOpeningWildLeads(all, hand, 8, context).includes(lowPairs),
    'do not ask the model to choose a resource-wasting opening in the first place');
  const protectedPairs = enforceTeamStrategy(lowPairs, all, hand, null, true, 8, context)!;
  assert.equal(protectedPairs.type, PatternType.ConsecutivePair);
  assert.ok(protectedPairs.rank >= lowPairs.rank);
  assert.ok(protectedPairs.cards.every(c => c.rank !== 8 || c.suit !== Suit.Heart));
  context.players[1].cardCount = 2;
  assert.equal(enforceTeamStrategy(proposed, [proposed], hand, null, true, Rank.Eight, context), proposed,
    'opening conservation must not govern reported endgames');
  assert.equal(enforceTeamStrategy(proposed, [proposed], proposed.cards, null, true, Rank.Eight, context), proposed,
    'a whole-hand finish still takes precedence');
  context.players[1].cardCount = 27;
  context.lastPlayPlayerIndex = 1;
  const last: CardPattern = { type: PatternType.Straight, rank: Rank.Four, length: 5, cards: [] };
  assert.equal(enforceTeamStrategy(proposed, [proposed], hand, last, false, Rank.Eight, context), proposed,
    'the change does not ban spending wildcards to follow');
});


test('grounded memory references only surviving cards and never a fabricated control', () => {
  const hand = rankedHand([3, 3, 3, Rank.BigJoker]);
  const all = generateLegalPlays(hand, 2);
  const joker = all.find(p => p.rank === Rank.BigJoker)!;
  const memory = groundStrategyPlan(hand, all, joker)!;
  assert.match(memory.next, /triple/);
  assert.doesNotMatch(memory.next, /king_bomb/);
  assert.equal(groundStrategyPlan(joker.cards, [joker], joker), undefined);
});

test('wildcard dominance requires the same declaration and all original natural cards', () => {
  const deck = createDeck();
  const hand = [66,80,69,19,73,11,91,37,14,68,57,96,17,71,59,44,63,9,76,22,102,7,61,75,10,23,104]
    .map(id => deck.find(c => c.id === id)!);
  const all = generateLegalPlays(hand, 8);
  const waste = all.find(p => p.type === PatternType.Straight && p.rank === 5
    && [66,80,69,19,73].every(id => p.cards.some(c => c.id === id)))!;
  assert.ok(waste);
  const filtered = removeWastefulWildRealizations(all, 8);
  assert.ok(!filtered.includes(waste));
  assert.ok(filtered.some(p => p.type === PatternType.Straight && p.rank === 5
    && p.cards.every(c => c.rank !== 8 || c.suit !== Suit.Heart)));
  assert.deepEqual(removeWastefulWildRealizations([waste], 8), [waste],
    'keep wildcard actions that have no equivalent natural alternative');
});


test('policy priority explains finish and defence overrides without changing selected actions', () => {
  const hand = rankedHand([3, 3, 3]);
  const plays = generateLegalPlays(hand, 2);
  const changes: any[] = [];
  const finished = finalizeAiDecision(null, plays, hand, null, true, 2, undefined, undefined, undefined,
    notes => changes.push(...notes));
  assert.equal(finished?.cards.length, 3);
  assert.deepEqual(changes.map(c => c.rule), ['finish']);
  assert.equal(changes[0].from, 'PASS');

  const singles = rankedHand([14, 3, 7]);
  const legal = generateLegalPlays(singles, 3);
  const ace = legal.find(p => p.type === PatternType.Single && p.rank === 14)!;
  const level = legal.find(p => p.type === PatternType.Single && p.rank === 3)!;
  const context = contextFor([singles, [], [], []]);
  context.players[1].cardCount = 1;
  const defence: any[] = [];
  const final = finalizeAiDecision(ace, legal, singles, null, true, 3, context, undefined, undefined,
    notes => defence.push(...notes));
  assert.equal(final, level);
  assert.ok(defence.some(c => c.rule === 'reported_defence'));
  assert.ok(defence.every(c => c.from !== c.to));
  const unchanged: any[] = [];
  assert.equal(finalizeAiDecision(level, legal, singles, null, true, 3, context, undefined, undefined,
    notes => unchanged.push(...notes)), level);
  assert.equal(unchanged.length, 0, 'do not invent corrections for an unchanged model decision');
});


test('reported-count defence keeps the block without dismantling its natural bomb', () => {
  const hand = rankedHand([10,10,13,13,13,13,3]);
  const all = generateLegalPlays(hand, 2);
  const tens = all.find(p=>p.type===PatternType.Pair && p.rank===10)!;
  const kings = all.find(p=>p.type===PatternType.Pair && p.rank===13)!;
  const bomb = all.find(p=>p.type===PatternType.Bomb4 && p.rank===13)!;
  const ctx = contextFor([hand, [], [], []]);ctx.players[1].cardCount=2;
  assert.equal(enforceTeamStrategy(tens, all, hand, null, true, 2, ctx), bomb);
  assert.equal(enforceTeamStrategy(tens, [tens,kings], hand, null, true, 2, ctx), kings,
    'without an intact alternative, reported defence is still enforced');
  ctx.players[1].cardCount=3;
  assert.equal(enforceTeamStrategy(tens, all, hand, null, true, 2, ctx), tens,
    'normal leads do not get escalated to bombs');
});


test('takeover routes retain a concrete feed and distinguish guaranteed control from a cheap response', () => {
  const deck = createDeck();
  const take = (rank: Rank,n=1) => deck.filter(c=>c.rank===rank).slice(0,n);
  const hand=[...take(16),...take(12),...take(3,2)];
  const ctx=contextFor([hand,[...take(13,2),...take(7)],take(5,2),[...take(11,2),...take(9)]]);
  ctx.lastPlayPlayerIndex=1;
  const all=generateLegalPlays(hand,2),last=generateLegalPlays(take(10),2)[0];
  const replies=all.filter(p=>p.type===PatternType.Single&&p.rank>=12);
  const route=buildTeamRoutes(hand,all,replies,last,2,ctx,{},generateLegalPlays).find(r=>r.goal==='takeover_change')!;
  assert.equal(replies.find(p=>analysisKey(p)===route.actionKey)?.rank,16);
  assert.equal(route.controlProven,true);
  assert.ok(route.nextLead);
  const uncertain=buildTeamRoutes(hand,all,replies,last,2,{...ctx,actionHistory:undefined},{},generateLegalPlays)
    .find(r=>r.goal==='takeover_change')!;
  assert.equal(uncertain.controlProven,false);
});

test('tail resource cost preserves a last control without penalizing an actual one-play exit', () => {
  const hand=rankedHand([14,3,4,6,7]);
  const all=generateLegalPlays(hand,2),ace=all.find(p=>p.rank===14)!;
  assert.equal(tailControlCost(hand,ace,all,2),320);
  assert.equal(resourceCost(hand,ace,2).remaining_high_cards,0);
  const grouped=rankedHand([14,3,3,3]);
  const plays=generateLegalPlays(grouped,2),high=plays.find(p=>p.rank===14)!;
  assert.equal(tailControlCost(grouped,high,plays,2),0,'taking control and leaving a triple is productive');
  const withControl=rankedHand([14,16,3,4]);
  const options=generateLegalPlays(withControl,2);
  assert.equal(tailControlCost(withControl,options.find(p=>p.rank===14)!,options,2),0);
  const bombs=rankedHand([11,11,11,11,13,13,13,13,12,12]);
  const combos=generateLegalPlays(bombs,2);
  const group=combos.find(p=>p.type===PatternType.ConsecutivePair&&p.rank===13)!;
  assert.equal(resourceCost(bombs,group,2).broken_natural_bombs.length,2);
});

test('intact ordinary interception does not require an uninterrupted streak or absent simulations', () => {
  const hand=rankedHand([2,2,3,3,3,12,13]);
  hand.filter(c=>c.rank===2).forEach(c=>{c.suit=Suit.Spade});
  const all=generateLegalPlays(hand,2),pair=all.find(p=>p.type===PatternType.Pair&&p.rank===2)!;
  const last:CardPattern={type:PatternType.Pair,rank:13,length:2,cards:[]};
  const ctx=contextFor([hand,[],[],[]]);
  ctx.lastPlayPlayerIndex=1;
  ctx.players.forEach(p=>{if(p.relation!=='self')p.cardCount=10});
  ctx.players[1].cardCount=4;
  const sample=(samples:number,meanReward:number)=>({samples,meanReward,winRate:0,doubleWinRate:0});
  const analysis:DecisionAnalysis={handTurns:{turns:4,exact:true},
    candidates:{[analysisKey(pair)]:{remainingTurns:{turns:3,exact:true},simulation:sample(4,0)}},
    passSimulation:sample(4,1),simulation:{status:'sampled',samples:4,elapsedMs:0}};
  assert.equal(finalizeAiDecision(null,[pair],hand,last,false,2,ctx,analysis,null),pair,
    'four lucky PASS samples must not disable a structurally cheap interception');
  analysis.passSimulation=sample(16,1);
  analysis.candidates[analysisKey(pair)].simulation=sample(16,0);
  assert.equal(finalizeAiDecision(null,[pair],hand,last,false,2,ctx,analysis,null),null,
    'substantial paired evidence for PASS remains respected');
  ctx.lastPlayPlayerIndex=2;
  assert.equal(finalizeAiDecision(null,[pair],hand,last,false,2,ctx,undefined,null),null,
    'do not steal the teammate lead');
});

test('repeated leads with three to five cards trigger an intact bomb defence before report-single', () => {
  const hand=rankedHand([4,4,4,4,7,9]);
  const bomb=generateLegalPlays(hand,2).find(p=>p.type===PatternType.Bomb4)!;
  const last:CardPattern={type:PatternType.TriplePair,rank:5,length:5,cards:[]};
  const ctx=contextFor([hand,[],[],[]]);ctx.lastPlayPlayerIndex=1;
  ctx.players.forEach(p=>{if(p.relation!=='self')p.cardCount=12});
  ctx.players[1].cardCount=4;
  ctx.actionHistory=[{seatIndex:1,action:'play',pattern:last},{seatIndex:0,action:'pass'},
    {seatIndex:1,action:'play',pattern:last}];
  assert.equal(finalizeAiDecision(null,[bomb],hand,last,false,2,ctx,undefined,null),bomb);
  ctx.players[1].cardCount=12;
  assert.equal(finalizeAiDecision(null,[bomb],hand,last,false,2,ctx,undefined,null),null,
    'do not spend bombs on a calm large hand with no ordinary continuation');
});

test('deny a double win with a secure productive block, across levels and only under finishing pressure', () => {
  const deck = createDeck();
  for (const level of [Rank.Two, Rank.Six, Rank.Ace]) {
    const group = deck.filter(c => c.rank === level);
    const hand = [...group.filter(c => c.suit !== Suit.Heart).slice(0, 4),
      ...group.filter(c => c.suit === Suit.Heart),
      ...[11, 10, 8, 5].map(rank => deck.find(c => c.rank === rank)!)];
    const enemy = deck.filter(c => c.rank === Rank.King).slice(0, 4);
    const ally = deck.filter(c => c.rank === Rank.Four).slice(0, 7);
    const ctx = contextFor([hand, enemy, ally, []]);
    ctx.lastPlayPlayerIndex = 1;
    ctx.players[3].finishRank = 1;
    const last: CardPattern = { type: PatternType.Bomb4, rank: Rank.Nine, length: 4, cards: [] };
    const all = generateLegalPlays(hand, level);
    const replies = all.filter(p => [PatternType.Bomb4, PatternType.Bomb5, PatternType.Bomb6].includes(p.type)
      && p.rank === level);
    const estimator = createTurnEstimator(hand, all, Infinity);
    const analysis: DecisionAnalysis = { handTurns: estimator.whole(), candidates: {},
      simulation: { status: 'not_endgame', elapsedMs: 0, samples: 0 } };
    for (const p of replies) analysis.candidates[analysisKey(p)] = { remainingTurns: estimator.after(p) };
    const result = finalizeAiDecision(null, replies, hand, last, false, level, ctx, analysis, null);
    assert.equal(result?.type, PatternType.Bomb4);
    assert.ok(result!.cards.every(c => c.suit !== Suit.Heart), 'retain both wildcards');
    assert.equal(publicControlEvidence(result!, hand, level, ctx)?.bombPossible, true);
    assert.equal(publicControlEvidence(result!, hand, level, ctx, enemy.length)?.bombPossible, false);
    ctx.players[3].finishRank = null;
    assert.equal(finalizeAiDecision(null, replies, hand, last, false, level, ctx, analysis, null), null);
  }
});


test('whole-hand strategy briefing generalizes natural level assets across all thirteen levels', () => {
  const deck=createDeck();
  for(let level=Rank.Two;level<=Rank.Ace;level++){
    const hand=[...deck.filter(c=>c.rank===level&&c.suit!==Suit.Heart).slice(0,3),
      ...deck.filter(c=>c.rank===level&&c.suit===Suit.Heart)];
    const brief=strategyBrief(hand,level);
    assert.equal(brief.natural_level_cards,3);
    assert.equal(brief.wildcards,2);
    assert.equal(brief.level_group_options.pair,true);
    assert.equal(brief.level_group_options.triple,true);
    const short=strategyBrief(hand.slice(0,1),level);
    assert.equal(short.level_group_options.pair,false);
    assert.equal(short.level_group_options.triple,false);
  }
});

test('residual control comparison preserves a probe instead of spending both jokers as wings at every level', async () => {
  const deck = createDeck();
  for (let level = Rank.Two; level <= Rank.Ace; level++) {
    const rank: Rank = level === Rank.Nine ? Rank.Eight : Rank.Nine;
    const low: Rank = level === Rank.Three ? Rank.Four : Rank.Three;
    const hand: Card[] = [
      ...deck.filter(c => c.rank === Rank.BigJoker),
      deck.find(c => c.rank === level && c.suit === Suit.Diamond)!,
      deck.find(c => c.rank === level && c.suit === Suit.Heart)!,
      ...deck.filter(c => c.rank === rank).slice(0, 2),
      deck.find(c => c.rank === low)!,
    ];
    const all = generateLegalPlays(hand, level);
    const waste: CardPattern = all.find(p => p.type === PatternType.TriplePair && p.rank === rank
      && p.cards.filter(c => c.rank === Rank.BigJoker).length === 2)!;
    assert.ok(waste);
    assert.equal(tailControlCost(hand, waste, all, level), 160,
      'a level singleton cannot stand in for the pair of jokers spent');
    const analysis = await analyzeDecision(hand, all, all, null, level, undefined, findBestPlay, { budgetMs: 100 });
    let corrections: any[] = [];
    const selected: CardPattern = finalizeAiDecision(waste, all, hand, null, true, level, undefined, analysis,
      undefined, values => { corrections = values; })!;
    assert.ok(corrections.some(c => c.rule === 'continuation'));
    assert.ok(selected.cards.every(c => c.rank !== Rank.BigJoker));
    assert.equal(analysis.candidates[analysisKey(selected)].continuation?.tailControlCost, 0);
    const used = new Set(selected.cards.map(c => c.id));
    const plan = groundStrategyPlan(hand, all, selected, analysis)!;
    assert.ok(plan.next);
    assert.equal(hand.filter(c => !used.has(c.id) && c.rank === Rank.BigJoker).length, 2);
  }
});

test('one-ply reply risk sees a whole-hand enemy response using public cards, without claiming certainty of outcome', async () => {
  const deck = createDeck();
  const take = (rank: Rank, n: number) => deck.filter(c => c.rank === rank).slice(0, n);
  const hand = [...take(Rank.BigJoker, 2), ...take(Rank.Nine, 2),
    deck.find(c => c.rank === Rank.Two && c.suit === Suit.Heart)!,
    deck.find(c => c.rank === Rank.Two && c.suit === Suit.Diamond)!, ...take(Rank.Seven, 1)];
  const enemy = [...take(Rank.King, 3), ...deck.filter(c => c.rank === Rank.Four).slice(0, 2)];
  const ctx = contextFor([hand, enemy, [], []]);
  ctx.players[2].finishRank = 1;
  ctx.players[3].finishRank = 2;
  const all = generateLegalPlays(hand, Rank.Two);
  const waste = all.find(p => p.type === PatternType.TriplePair && p.cards.some(c => c.rank === Rank.BigJoker))!;
  const probe = all.find(p => p.type === PatternType.Single && p.rank === Rank.Seven)!;
  const analysis = await analyzeDecision(hand, all, [waste, probe], null, Rank.Two, ctx, findBestPlay,
    { budgetMs: 300, maxSamples: 0, generateReplies: generateLegalPlays, random: () => 0.5 });
  assert.deepEqual(analysis.candidates[analysisKey(waste)].replyFinishRisk, { samples: 8, rate: 1 });
  assert.deepEqual(analysis.candidates[analysisKey(probe)].replyFinishRisk, { samples: 8, rate: 0 });
  const expired = await analyzeDecision(hand, all, [waste], null, Rank.Two, ctx, findBestPlay,
    { budgetMs: 0, generateReplies: generateLegalPlays });
  assert.equal(expired.candidates[analysisKey(waste)].replyFinishRisk, undefined,
    'an unmeasured risk must not be presented as zero');
});

test('calm opening preserves triple aces when an equally efficient large natural lead exists', () => {
  const hand = rankedHand([
    Rank.Ace, Rank.Ace, Rank.Ace, Rank.Seven, Rank.Seven,
    Rank.Three, Rank.Four, Rank.Five, Rank.Six, Rank.Seven,
    Rank.Eight, Rank.Eight, Rank.Nine, Rank.Nine, Rank.Ten, Rank.Ten,
    Rank.Jack, Rank.Jack, Rank.Queen, Rank.Queen,
  ]);
  const candidates = generateLegalPlays(hand, Rank.Two);
  const aces = candidates.find(play => play.type === PatternType.TriplePair && play.rank === Rank.Ace)!;
  const straight = candidates.find(play => play.type === PatternType.Straight && play.rank === Rank.Seven)!;
  assert.ok(aces && straight);
  const context: AiDecisionContext = {
    selfSeatIndex: 0, partnerSeatIndex: 2, lastPlayPlayerIndex: -1,
    roundNumber: 1, teamLevels: [2, 2], leadingTeam: 0, passCount: 0,
    actionHistory: [], recentActions: [],
    players: [0, 1, 2, 3].map(seat => ({ seatIndex: seat, cardCount: seat ? 27 : hand.length,
      finishRank: null, relation: seat === 0 ? 'self' : seat === 2 ? 'partner' : 'opponent' })),
  };
  const analysis: DecisionAnalysis = {
    handTurns: { turns: 5, exact: true },
    candidates: {
      [analysisKey(aces)]: { remainingTurns: { turns: 4, exact: false } },
      [analysisKey(straight)]: { remainingTurns: { turns: 4, exact: false } },
    },
    simulation: { status: 'not_endgame', samples: 0, elapsedMs: 0 },
  };
  let corrections: any[] = [];
  const preserved = enforceTeamStrategy(aces, candidates, hand, null, true, Rank.Two, context, analysis,
    correction => corrections.push(correction))!;
  assert.equal(analysisKey(preserved), analysisKey(straight));
  assert.ok(corrections.some(correction => correction.rule === 'opening_resource'));

  analysis.candidates[analysisKey(straight)].remainingTurns.turns = 5;
  corrections = [];
  const efficient = enforceTeamStrategy(aces, candidates, hand, null, true, Rank.Two, context, analysis,
    correction => corrections.push(correction))!;
  assert.equal(efficient.type, PatternType.TriplePair);
  assert.equal(efficient.rank, Rank.Ace,
    'a high group remains legal when it uniquely improves the residual partition');
});

test('calm opening preserves a flush straight when a disjoint ordinary route is equally efficient', () => {
  const deck = createDeck();
  const take = (rank: Rank, suit: Suit) => deck.find(card => card.rank === rank && card.suit === suit)!;
  const flushCards = [Rank.Three, Rank.Four, Rank.Five, Rank.Six, Rank.Seven]
    .map(rank => take(rank, Suit.Spade));
  const ordinaryCards = [
    take(Rank.Eight, Suit.Heart), take(Rank.Nine, Suit.Club), take(Rank.Ten, Suit.Diamond),
    take(Rank.Jack, Suit.Heart), take(Rank.Queen, Suit.Club),
  ];
  const extras = [
    take(Rank.Three, Suit.Heart), take(Rank.Three, Suit.Club),
    take(Rank.Four, Suit.Heart), take(Rank.Four, Suit.Club),
    take(Rank.Five, Suit.Heart), take(Rank.Five, Suit.Club),
    take(Rank.Six, Suit.Heart), take(Rank.Six, Suit.Club),
    take(Rank.King, Suit.Heart), take(Rank.Ace, Suit.Club),
  ];
  const hand = [...flushCards, ...ordinaryCards, ...extras];
  const candidates = generateLegalPlays(hand, Rank.Two);
  const flush = candidates.find(play => play.type === PatternType.FlushStraight
    && flushCards.every(card => play.cards.some(used => used.id === card.id)))!;
  const ordinary = candidates.find(play => play.type === PatternType.Straight && play.rank === Rank.Queen
    && ordinaryCards.every(card => play.cards.some(used => used.id === card.id)))!;
  assert.ok(flush && ordinary);
  const context: AiDecisionContext = {
    selfSeatIndex: 0, partnerSeatIndex: 2, lastPlayPlayerIndex: -1,
    roundNumber: 1, teamLevels: [2, 2], leadingTeam: 0, passCount: 0,
    actionHistory: [], recentActions: [],
    players: [0, 1, 2, 3].map(seat => ({ seatIndex: seat, cardCount: seat ? 27 : hand.length,
      finishRank: null, relation: seat === 0 ? 'self' : seat === 2 ? 'partner' : 'opponent' })),
  };
  const analysis: DecisionAnalysis = {
    handTurns: { turns: 5, exact: true },
    candidates: {
      [analysisKey(flush)]: { remainingTurns: { turns: 4, exact: false } },
      [analysisKey(ordinary)]: { remainingTurns: { turns: 4, exact: false } },
    },
    simulation: { status: 'not_endgame', samples: 0, elapsedMs: 0 },
  };
  let corrections: any[] = [];
  const preserved = enforceTeamStrategy(flush, candidates, hand, null, true, Rank.Two, context, analysis,
    correction => corrections.push(correction))!;
  assert.equal(analysisKey(preserved), analysisKey(ordinary));
  assert.ok(corrections.some(correction => correction.rule === 'opening_resource'));

  context.players[1].cardCount = 17;
  assert.equal(enforceTeamStrategy(flush, candidates, hand, null, true, Rank.Two, context, analysis), ordinary,
    'the same resource comparison applies to a calm midgame lead');
  context.players[1].cardCount = 5;
  assert.equal(enforceTeamStrategy(flush, candidates, hand, null, true, Rank.Two, context, analysis), flush,
    'respect closeout pressure');
  context.players[1].cardCount = 17;
  analysis.candidates[analysisKey(ordinary)].remainingTurns.turns = 5;
  corrections = [];
  const efficient = enforceTeamStrategy(flush, candidates, hand, null, true, Rank.Two, context, analysis,
    correction => corrections.push(correction))!;
  assert.equal(analysisKey(efficient), analysisKey(flush),
    'the guard does not ban a flush straight that uniquely improves the partition');
});

test('calm midgame lead can find a bomb-preserving singleton outside the model shortlist', () => {
  const hand = rankedHand([14, 12, 11, 11, 10, 10, 10, 10, 7, 3, 3, 3, 3, 2, 2, 2, 2]);
  hand[0].suit = Suit.Heart;
  const plays = generateLegalPlays(hand, Rank.Ace);
  const bomb = plays.find(play => play.type === PatternType.Bomb4 && play.rank === Rank.Two
    && !play.substitutions?.length)!;
  const context = contextFor([hand, [], [], []]);
  context.players.forEach(p => { if (p.relation !== 'self') p.cardCount = 22; });
  const analysis: DecisionAnalysis = {
    handTurns: { turns: 5, exact: true },
    candidates: { [analysisKey(bomb)]: { remainingTurns: { turns: 4, exact: true } } },
    simulation: { status: 'not_endgame', samples: 0, elapsedMs: 0 },
  };
  const selected = finalizeAiDecision(bomb, [bomb], hand, null, true, Rank.Ace, context, analysis,
    undefined, undefined, plays);
  assert.equal(selected?.type, PatternType.Single);
  assert.equal(selected?.rank, Rank.Seven);
});

test('cost of a follow distinguishes losing a rank bomb, retaining four, and playing the bomb', async () => {
  const deck = createDeck();
  for (const level of [Rank.Three, Rank.King]) {
    const group = deck.filter(c => c.rank === level && c.suit !== Suit.Heart);
    const rest = [...deck.filter(c => c.rank === 4).slice(0, 2),
      ...[5, 7, 9, 11, 14, 16].map(rank => deck.find(c => c.rank === rank)!)];
    const hand = [...group.slice(0, 4), ...rest];
    const options = generateLegalPlays(hand, level);
    const house = options.find(p => p.type === PatternType.TriplePair && p.rank === level)!;
    const bomb = options.find(p => p.type === PatternType.Bomb4 && p.rank === level)!;
    const single = options.find(p => p.type === PatternType.Single && p.rank === level)!;
    assert.deepEqual(resourceCost(hand, house, level).broken_natural_bombs, [level]);
    assert.deepEqual(resourceCost(hand, bomb, level).broken_natural_bombs, []);
    const weakened = resourceCost([...hand, group[4]], single, level);
    assert.deepEqual(weakened.broken_natural_bombs, []);
    assert.deepEqual(weakened.remaining_rank_bombs, [{ rank: level, count: 4 }]);
    const ctx = contextFor([hand, [], [], []]);
    ctx.players.forEach(p => { if (p.relation !== 'self') p.cardCount = 18; });
    ctx.lastPlayPlayerIndex = 1;
    ctx.actionHistory = undefined;
    ctx.recentActions = [];
    const last = { ...house, rank: Rank.Queen, cards: [] };
    const replies = [house, bomb];
    const analysis = await analyzeDecision(hand, options, replies, last, level, undefined, findBestPlay);
    assert.equal(finalizeAiDecision(house, replies, hand, last, false, level, ctx, analysis), null);
    ctx.players[1].cardCount = 1;
    assert.ok(finalizeAiDecision(house, replies, hand, last, false, level, ctx, analysis));
  }
});

test('a same-strength unseen control makes a grouped-exit probe conditional', async () => {
  const deck = createDeck();
  const take = (rank: Rank, n: number) => deck.filter(c => c.rank === rank).slice(0, n);
  const hand = [...take(5, 3), ...take(8, 2), ...take(9, 1), ...take(Rank.Ace, 1)];
  // No higher ordinary card remains. Another ace can take the lead first.
  const unseen = [3, 4, 6, 7, 10, 11, 13].flatMap(rank => take(rank, 2));
  unseen.push(deck.filter(c => c.rank === Rank.Ace)[1]);
  const ctx = contextFor([hand, unseen.slice(0, 5), unseen.slice(5, 10), unseen.slice(10)]);
  const all = generateLegalPlays(hand, Rank.Two);
  const ace = all.find(p => p.type === PatternType.Single && p.rank === Rank.Ace)!;
  assert.equal(publicControlEvidence(ace, hand, Rank.Two, ctx)?.unbeatable, true);
  const probe = all.find(p => p.type === PatternType.Single && p.rank === 9)!;
  const house = all.find(p => p.type === PatternType.TriplePair)!;
  const analysis = await analyzeDecision(hand, all, all, null, Rank.Two, ctx, findBestPlay, { maxSamples: 0 });
  const route = analysis.candidates[analysisKey(probe)].endgameRoute!;
  assert.equal(route.sameShapeControl, true);
  assert.equal(route.controlProven, false);
  assert.equal(route.exit?.type, PatternType.TriplePair);
  assert.equal(finalizeAiDecision(house, all, hand, null, true, Rank.Two, ctx, analysis)?.rank, probe.rank);
});

test('two-trick evidence compares identical deals through the next free lead', async () => {
  const deck = createDeck();
  const hand = [deck.find(c => c.rank === 3)!, ...deck.filter(c => c.rank === 5).slice(0, 2)];
  const others = deck.filter(c => c.rank === 9).slice(0, 6);
  const ctx = contextFor([hand, others.slice(0, 2), others.slice(2, 4), others.slice(4)]);
  const all = generateLegalPlays(hand, Rank.Two);
  const single = all.find(p => p.type === PatternType.Single && p.rank === 3)!;
  const pair = all.find(p => p.type === PatternType.Pair)!;
  const choose: Parameters<typeof forecastTwoTricks>[5] = (cards, trick, free, level, seat) => {
    if (free || (seat.selfSeatIndex === 1 && trick?.type === PatternType.Single && trick.rank === 3)) {
      return generateLegalPlays(cards, level).find(p => p.type === PatternType.Single)!;
    }
    return null;
  };
  const forecast = await forecastTwoTricks(hand, [single, pair], null, Rank.Two, ctx, choose, Infinity);
  assert.deepEqual(forecast?.[analysisKey(single)], { samples: 8, allyExit: 0, enemyExit: 1, retainedLead: 0 });
  assert.deepEqual(forecast?.[analysisKey(pair)], { samples: 8, allyExit: 1, enemyExit: 0, retainedLead: 0 });
  const before = forecast![analysisKey(single)], after = forecast![analysisKey(pair)];
  assert.ok(twoTrickExitGain(before, after) > 0);
  assert.equal(twoTrickExitGain(after, before), 0);
  assert.equal(twoTrickExitGain(before, { ...before, retainedLead: 1 }), 0);
  assert.equal(twoTrickExitGain(before, { ...after, samples: 3 }), 0);
  assert.equal(await forecastTwoTricks(hand, [single, pair], null, Rank.Two, ctx, choose, 0), undefined);
});

test('one-cycle arbitration distinguishes a costly trick from a finish or interception', () => {
  const pass = { samples: 8, teamAhead: 0, partnerAhead: 0, allyExit: 0, enemyExit: 0 };
  const joker = { ...pass, teamAhead: 1 };
  const before = { turns: 8, exact: true }, after = { turns: 7, exact: true };
  assert.equal(improvesTrickRoute(pass, joker, before, after, 0, 6), false);
  assert.equal(improvesTrickRoute(pass, joker, before, after, 0, 0), true);
  assert.equal(improvesTrickRoute(pass, joker, { ...before, exact: false }, after, 0, 0), false);
  assert.equal(improvesTrickRoute(pass, joker, before, { ...after, exact: false }, 0, 0), false);
  assert.equal(improvesTrickRoute({ ...pass, enemyExit: 0.75 }, joker, before, after, 0, 6), true);
  assert.equal(improvesTrickRoute(pass, { ...joker, allyExit: 0.75 }, before, after, 0, 6), true);
  assert.equal(improvesTrickRoute(pass, { ...joker, allyExit: 0.75, enemyExit: 0.25 }, before, after, 0, 6), false);
  assert.equal(improvesTrickRoute({ ...pass, samples: 4 }, { ...joker, samples: 4, allyExit: 1 }, before, after, 0, 6), false);
});

test('ready exit keeps the reply when matched forecasts show it prevents an enemy exit', () => {
  const hand = rankedHand([13, 13]);
  const reply = generateLegalPlays(hand, 2).find(p => p.type === PatternType.Single)!;
  const last = generateLegalPlays(rankedHand([12]), 2)[0];
  const context = contextFor([hand, [], [], []]);
  context.lastPlayPlayerIndex = 3;
  for (const player of context.players.slice(1)) player.cardCount = 5;
  const pass = { samples: 8, teamAhead: 0, partnerAhead: 0, allyExit: 0, enemyExit: 0.75 };
  const analysis: DecisionAnalysis = {
    handTurns: { turns: 1, exact: true },
    candidates: { [analysisKey(reply)]: { remainingTurns: { turns: 1, exact: true } } },
    trickForecast: { PASS: pass, [analysisKey(reply)]: { ...pass, enemyExit: 0 } },
    simulation: { status: 'sampled', samples: 0, elapsedMs: 0 },
  };
  assert.equal(enforceTeamStrategy(reply, [reply], hand, last, false, 2, context, analysis), reply);
  analysis.trickForecast![analysisKey(reply)].samples = 4;
  assert.equal(enforceTeamStrategy(reply, [reply], hand, last, false, 2, context, analysis), null);
});

test('a partition witness preserves physical cards even when the search budget expires', () => {
  const hand = rankedHand([3, 3, 3, 4, 4, 8, 9, 10, 11, 12, 15]);
  const plays = generateLegalPlays(hand, 2);
  const joker = plays.find(p => p.type === PatternType.Single && p.rank === Rank.SmallJoker)!;
  for (const deadline of [0, Infinity]) {
    const estimator = createTurnEstimator(hand, plays, deadline);
    const partition = estimator.partitionAfter(joker);
    assert.equal(partition.length, estimator.after(joker).turns);
    assert.deepEqual(partition.flatMap(p => p.cards.map(c => c.id)).sort((a,b) => a-b),
      hand.filter(c => c.id !== joker.cards[0].id).map(c => c.id).sort((a,b) => a-b));
  }
});

test('reviewed opening can reorder a low group before the joker and triple aces outside the shortlist', async () => {
  const deck = createDeck();
  const initial = [52,66,25,38,57,96,17,43,5,85,73,32,11,65,78,24,67,86,87,62,63,10,8,101,0,13,81].map(id => deck[id]);
  for (const spentJoker of [false, true]) {
    const hand = initial.filter(c => !spentJoker || c.rank !== Rank.SmallJoker);
    const plays = generateLegalPlays(hand, Rank.Two);
    const proposed = spentJoker
      ? plays.find(p => p.type === PatternType.TriplePair && p.rank === Rank.Ace && p.cards.filter(c => c.rank === 5).length === 2)!
      : plays.find(p => p.type === PatternType.Single && p.rank === Rank.SmallJoker)!;
    const ctx = contextFor([hand, [], [], []]);
    ctx.actionHistory = []; ctx.recentActions = [];
    ctx.players.forEach(p => { p.cardCount = p.relation === 'self' ? hand.length : 27; });
    const analysis = await analyzeDecision(hand, plays, [proposed], null, Rank.Two, undefined, findBestPlay);
    const originalTurns = analysis.candidates[analysisKey(proposed)].remainingTurns.turns;
    const result = finalizeAiDecision(proposed, [proposed], hand, null, true, Rank.Two, ctx, analysis,
      proposed, undefined, plays)!;
    assert.ok(result.cards.every(c => c.rank < Rank.Ace && c.rank !== Rank.Two));
    assert.ok(result.cards.every(c => !proposed.cards.some(x => x.id === c.id)));
    assert.ok(analysis.candidates[analysisKey(result)].remainingTurns.turns <= originalTurns);
    ctx.players[1].cardCount = 1;
    assert.equal(finalizeAiDecision(proposed, [proposed], hand, null, true, Rank.Two, ctx, analysis,
      proposed, undefined, plays), proposed, 'opening conservation yields to reported defence');
  }
});

test('equal-turn team leads send a partner out but respect an intervening finisher', async () => {
  const deck = createDeck();
  const take = (rank: Rank, n = 1) => deck.filter(c => c.rank === rank).slice(0, n);
  const hand = [...take(4), ...take(7, 3), ...take(12)];
  const leads = generateLegalPlays(hand, 3);
  const triple = leads.find(p => p.type === PatternType.Triple)!;
  const low = leads.find(p => p.rank === 4)!;
  for (const exposed of [false, true]) {
    const next = exposed ? take(14) : [...take(5), ...take(8), ...take(10)];
    const ctx = contextFor([hand, next, take(16), []]);
    ctx.players[3].finishRank = 1;
    ctx.publicTransfers = [...next.map(card => ({card, fromSeat: 0, toSeat: 1})),
      {card: take(16)[0], fromSeat: 0, toSeat: 2}];
    const analysis = await analyzeDecision(hand, leads, leads, null, 3, ctx, findBestPlay);
    analysis.teamLeadForecast = forecastTrick(hand, leads, null, 3, ctx, generateLegalPlays, Infinity, Math.random, true);
    const result = finalizeAiDecision(exposed ? low : triple, leads, hand, null, true, 3, ctx, analysis);
    if (exposed) assert.notEqual(result?.type, PatternType.Single, 'next opponent goes out before partner');
    else {
      assert.equal(result?.type, PatternType.Single, 'partner can finish without delaying own exit');
      // A quick partner exit cannot justify a lower expected team result.
      for (const play of leads.filter(p => p.type === PatternType.Single)) {
        const measured = analysis.candidates[analysisKey(play)].simulation;
        if (measured) measured.meanReward = -1;
      }
      const defended = finalizeAiDecision(triple, leads, hand, null, true, 3, ctx, analysis);
      assert.equal(defended?.type, PatternType.Triple);
    }
  }
});

test('quiet follow spends an ordinary single before a six-card bomb, but can still block a finisher', async () => {
  const deck = createDeck();
  const hand = [54, 0, 13, 80, 93, 39, 8, 21, 53, 28, 48, 78, 12].map(id => deck[id]);
  const level = Rank.Five, all = generateLegalPlays(hand, level);
  const bomb = all.find(p => p.type === PatternType.Bomb6)!;
  const jack = all.find(p => p.type === PatternType.Single && p.rank === Rank.Jack)!;
  const last = { ...jack, rank: Rank.Eight };
  const replies = [bomb, jack];
  const analysis = await analyzeDecision(hand, all, replies, last, level, undefined, findBestPlay);
  const ctx = contextFor([hand, [], [], []]);
  ctx.actionHistory = []; ctx.recentActions = []; ctx.lastPlayPlayerIndex = 1;
  for (const p of ctx.players.slice(1)) p.cardCount = 16;
  assert.equal(enforceTeamStrategy(bomb, replies, hand, last, false, level, ctx, analysis), jack);
  assert.equal(enforceTeamStrategy(bomb, [bomb], hand, last, false, level, ctx, analysis), null);
  ctx.players[1].cardCount = 1;
  assert.equal(enforceTeamStrategy(bomb, [bomb], hand, last, false, level, ctx, analysis), bomb);
});

test('full house economy cannot spend paired jokers to improve the residual partition', async () => {
  const deck = createDeck();
  const hand = [33, 100, 46, 106, 52, 9, 107, 42, 68, 27, 40, 84, 104, 103, 47, 45, 44].map(id => deck[id]);
  const level = Rank.Nine, all = generateLegalPlays(hand, level);
  const house = all.filter(p => p.type === PatternType.TriplePair && p.rank === 9);
  const cheap = house.find(p => p.cards.filter(c => c.rank === 3).length === 2)!;
  const jokerWings = house.find(p => p.cards.filter(c => c.rank === Rank.SmallJoker).length === 2)!;
  const last = { ...cheap, rank: Rank.Five };
  const ctx = contextFor([hand, [], [], []]);
  ctx.lastPlayPlayerIndex = 1;
  const analysis = await analyzeDecision(hand, all, [cheap, jokerWings], last, level, undefined, findBestPlay);
  assert.equal(enforceTeamStrategy(cheap, [cheap, jokerWings], hand, last, false, level, ctx, analysis), cheap);
});

test('paired nonterminal leaves compare actual exits, control and the next free lead', async () => {
  const deck = createDeck();
  const hand = [deck.find(c => c.rank === 3)!, deck.find(c => c.rank === 4)!,
    ...deck.filter(c => c.rank === 9).slice(0, 3)];
  const rest = deck.filter(c => c.rank === 6 || c.rank === 8).slice(0, 9);
  const ctx = contextFor([hand, rest.slice(0, 3), rest.slice(3, 6), rest.slice(6)]);
  const plays = generateLegalPlays(hand, 2);
  const loose = plays.find(p => p.rank === 3)!;
  const split = plays.find(p => p.type === PatternType.Pair && p.rank === 9)!;
  const forecast = await forecastTwoTricks(hand, [loose, split], null, 2, ctx,
    (cards, _trick, free) => free ? generateLegalPlays(cards, 2).find(p => p.type === PatternType.Single)! : null,
    Infinity, () => 0.5, generateLegalPlays);
  const intact = forecast![analysisKey(loose)], broken = forecast![analysisKey(split)];
  assert.equal(intact.position?.samples, 8);
  assert.equal(intact.position?.readyLead, 1);
  assert.equal(broken.position?.readyLead, 0);
  assert.equal(intact.position!.turnAdvantage - broken.position!.turnAdvantage, 1);
  assert.ok(twoTrickGain(broken, intact) > 0);
  assert.equal(twoTrickGain(intact, broken), 0);
  assert.equal(twoTrickGain(broken, { ...intact, enemyExit: 0.125 }), 0);
  assert.equal(twoTrickGain(broken, { ...intact, position: { ...intact.position!, controlBalance: -1 } }), 0);
});
