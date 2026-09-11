import { Card, CardPattern } from '../../../shared/types';
import { createDeck } from './card';
import { canBeat } from './compare';
import type { AiDecisionContext } from './llmAi';

export type ChoosePlay = (
  hand: Card[], last: CardPattern | null, free: boolean, level: number,
  context: AiDecisionContext,
) => CardPattern | null;

export interface TurnEstimate {
  turns: number;
  exact: boolean;
}

export interface SampleResult {
  samples: number;
  winRate: number;
  doubleWinRate: number;
  /** Signed expected upgrade reward, -1 to 1. Not a calibrated win probability. */
  meanReward: number;
}

export interface DecisionAnalysis {
  handTurns: TurnEstimate;
  candidates: Record<string, { remainingTurns: TurnEstimate; simulation?: SampleResult }>;
  passSimulation?: SampleResult;
  simulation: { status: string; samples: number; elapsedMs: number };
}

export function analysisKey(play: CardPattern): string {
  return `${play.type}:${play.rank}:${play.cards.map(card => card.id).sort((a, b) => a - b).join(',')}`;
}

export interface PublicKnowledge {
  played: Card[];
  unseen: Card[];
  knownBySeat: Card[][];
}

/** Never accepts other players' real hands. Cards are removed by physical ID,
 * so a played wildcard removes the heart level card, not its declared rank. */
export function buildPublicKnowledge(hand: Card[], context: AiDecisionContext): PublicKnowledge | null {
  if (!context.actionHistory) return null;
  const deck = createDeck();
  const byId = new Map(deck.map(card => [card.id, card]));
  const seen = new Set<number>();
  const validCard = (card: Card) => {
    const actual = byId.get(card.id);
    return actual?.rank === card.rank && actual?.suit === card.suit;
  };
  for (const card of hand) {
    if (!validCard(card) || seen.has(card.id)) return null;
    seen.add(card.id);
  }
  const played: Card[] = [];
  for (const action of context.actionHistory) {
    if (action.action !== 'play') continue;
    if (!action.pattern) return null;
    for (const card of action.pattern.cards) {
      if (!validCard(card) || seen.has(card.id)) return null;
      seen.add(card.id);
      played.push(card);
    }
  }
  const unseen = deck.filter(card => !seen.has(card.id));
  const knownBySeat: Card[][] = Array.from({ length: 4 }, () => []);
  const owners = new Map<number, number>();
  for (const transfer of context.publicTransfers || []) {
    if (!validCard(transfer.card) || transfer.toSeat < 0 || transfer.toSeat > 3) return null;
    owners.set(transfer.card.id, transfer.toSeat);
  }
  for (const card of unseen) {
    const seat = owners.get(card.id);
    if (seat !== undefined) {
      if (seat === context.selfSeatIndex) return null;
      knownBySeat[seat].push(card);
    }
  }
  return { played, unseen, knownBySeat };
}

/** Uniform hidden-hand samples constrained by public counts and transfers.
 * A pass is NOT proof that a player cannot beat the trick. */
export function sampleHiddenHands(
  hand: Card[], context: AiDecisionContext, knowledge: PublicKnowledge,
  random: () => number = Math.random,
): Card[][] | null {
  if (context.players.length !== 4 || new Set(context.players.map(p => p.seatIndex)).size !== 4) return null;
  const hands = knowledge.knownBySeat.map(cards => [...cards]);
  const assigned = new Set(hands.flat().map(card => card.id));
  const pool = knowledge.unseen.filter(card => !assigned.has(card.id));
  for (let index = pool.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [pool[index], pool[other]] = [pool[other], pool[index]];
  }
  hands[context.selfSeatIndex] = [...hand];
  let offset = 0;
  for (const player of context.players) {
    if (player.seatIndex < 0 || player.seatIndex > 3 || !Number.isInteger(player.cardCount)) return null;
    if (player.seatIndex === context.selfSeatIndex) {
      if (player.cardCount !== hand.length) return null;
      continue;
    }
    if (player.finishRank !== null && player.cardCount !== 0) return null;
    const need = player.cardCount - hands[player.seatIndex].length;
    if (need < 0 || offset + need > pool.length) return null;
    hands[player.seatIndex].push(...pool.slice(offset, offset + need));
    offset += need;
  }
  return offset === pool.length ? hands : null;
}

function bitCount(mask: number): number {
  let count = 0;
  while (mask) { mask &= mask - 1; count++; }
  return count;
}

/** Exact cover of physical card subsets. Every legal group is a possible one
 * turn; no opponent is modelled here. When bounded search expires, returns a
 * valid upper bound explicitly labelled inexact. */
export function createTurnEstimator(hand: Card[], plays: CardPattern[], deadline: number) {
  if (hand.length > 27) throw new Error('turn estimator supports at most 27 cards');
  const index = new Map(hand.map((card, i) => [card.id, i]));
  const fullMask = 2 ** hand.length - 1;
  const maskOf = (cards: Card[]) => cards.reduce((mask, card) => {
    const position = index.get(card.id);
    if (position === undefined) throw new Error('card is outside the hand');
    return mask | (1 << position);
  }, 0);
  const masks = [...new Set([...plays.map(play => maskOf(play.cards)), ...hand.map((_, i) => 1 << i)])]
    .filter(mask => mask !== 0).sort((a, b) => bitCount(b) - bitCount(a));
  const byBit = hand.map((_, i) => masks.filter(mask => (mask & (1 << i)) !== 0));
  const maxLength = masks.length ? bitCount(masks[0]) : 1;
  const memo = new Map<number, TurnEstimate>([[0, { turns: 0, exact: true }]]);
  let nodes = 0;
  const greedy = (mask: number) => {
    let turns = 0;
    for (const group of masks) {
      if ((mask & group) === group) { mask ^= group; turns++; }
      if (!mask) break;
    }
    return turns;
  };
  const solve = (mask: number): TurnEstimate => {
    const cached = memo.get(mask);
    if (cached) return cached;
    let best = greedy(mask);
    const lower = Math.ceil(bitCount(mask) / maxLength);
    if (best === lower) return { turns: best, exact: true };
    if (performance.now() >= deadline || ++nodes > 20000) return { turns: best, exact: false };
    const first = 31 - Math.clz32(mask & -mask);
    let exact = true;
    for (const group of byBit[first]) {
      if ((mask & group) !== group) continue;
      if (performance.now() >= deadline) { exact = false; break; }
      const rest = solve(mask ^ group);
      best = Math.min(best, 1 + rest.turns);
      exact = exact && rest.exact;
      if (best === lower) { exact = true; break; }
    }
    const result = { turns: best, exact };
    if (exact) memo.set(mask, result);
    return result;
  };
  return {
    whole: () => solve(fullMask),
    after: (play: CardPattern) => solve(fullMask ^ maskOf(play.cards)),
  };
}

interface Outcome { reward: number; win: boolean; doubleWin: boolean }

/** One sampled continuation. Each simulated policy sees only its own sampled
 * hand and public state, never the other sampled hands. */
export function rollout(
  initialHands: Card[][], root: CardPattern | null, last: CardPattern | null,
  level: number, context: AiDecisionContext, choose: ChoosePlay, deadline: number,
): Outcome | null {
  const hands = initialHands.map(cards => [...cards]);
  const finishes = context.players.filter(player => player.finishRank !== null)
    .sort((a, b) => a.finishRank! - b.finishRank!).map(player => player.seatIndex);
  let seat = context.selfSeatIndex;
  let winner = context.lastPlayPlayerIndex;
  let trick = last;
  let passes = context.passCount || 0;
  const nextActive = (from: number) => {
    for (let step = 1; step <= 4; step++) {
      const next = (from + step) % 4;
      if (!finishes.includes(next)) return next;
    }
    return -1;
  };
  for (let step = 0; step < 160; step++) {
    if (performance.now() >= deadline) return null;
    const simContext: AiDecisionContext = {
      ...context, actionHistory: undefined, publicTransfers: undefined, recentActions: [],
      selfSeatIndex: seat, partnerSeatIndex: (seat + 2) % 4,
      lastPlayPlayerIndex: winner, passCount: passes,
      players: hands.map((cards, i) => ({
        seatIndex: i, cardCount: cards.length,
        finishRank: finishes.includes(i) ? finishes.indexOf(i) + 1 : null,
        relation: i === seat ? 'self' : i === (seat + 2) % 4 ? 'partner' : 'opponent',
      })),
    };
    const action = step === 0 ? root : choose(hands[seat], trick, !trick, level, simContext);
    if (action) {
      if (!canBeat(action, trick, level)) return null;
      const ids = new Set(action.cards.map(card => card.id));
      if (ids.size !== action.cards.length || action.cards.some(card => !hands[seat].some(item => item.id === card.id))) return null;
      hands[seat] = hands[seat].filter(card => !ids.has(card.id));
      trick = action; winner = seat; passes = 0;
      if (!hands[seat].length) finishes.push(seat);
      if (finishes.length >= 3 || (finishes.length === 2 && finishes[0] % 2 === finishes[1] % 2)) {
        const win = finishes[0] % 2 === context.selfSeatIndex % 2;
        const partnerPlace = finishes.indexOf((finishes[0] + 2) % 4) + 1 || 4;
        const magnitude = (partnerPlace === 2 ? 3 : partnerPlace === 3 ? 2 : 1) / 3;
        return { reward: win ? magnitude : -magnitude, win, doubleWin: win && partnerPlace === 2 };
      }
      seat = nextActive(seat);
    } else {
      if (!trick) return null;
      passes++;
      const needed = 4 - finishes.length - (finishes.includes(winner) ? 0 : 1);
      if (passes >= needed) {
        const partner = (winner + 2) % 4;
        seat = finishes.includes(winner)
          ? finishes.includes(partner) ? nextActive(partner) : partner : winner;
        trick = null; winner = -1; passes = 0;
      } else seat = nextActive(seat);
    }
  }
  return null;
}

export async function analyzeDecision(
  hand: Card[], allPlays: CardPattern[], candidates: CardPattern[],
  last: CardPattern | null, level: number, context: AiDecisionContext | undefined,
  choose: ChoosePlay,
  options: { budgetMs?: number; maxSamples?: number; random?: () => number } = {},
): Promise<DecisionAnalysis> {
  const start = performance.now();
  const budget = Math.max(0, options.budgetMs ?? 350);
  const deadline = start + budget;
  const estimator = createTurnEstimator(hand, allPlays, Math.min(deadline, start + 80));
  const analysis: DecisionAnalysis = {
    handTurns: estimator.whole(), candidates: {},
    simulation: { status: 'not_endgame', samples: 0, elapsedMs: 0 },
  };
  for (const play of candidates.slice(0, 40)) {
    analysis.candidates[analysisKey(play)] = { remainingTurns: estimator.after(play) };
  }
  const finish = () => {
    analysis.simulation.elapsedMs = Math.round(performance.now() - start);
    return analysis;
  };
  // Entire active deal must be small, not merely the current player's hand.
  if (!context || context.players.reduce((sum, player) => sum + player.cardCount, 0) > 24
    || hand.length > 10) return finish();
  const knowledge = buildPublicKnowledge(hand, context);
  if (!knowledge) { analysis.simulation.status = 'incomplete_public_history'; return finish(); }

  const roots: Array<CardPattern | null> = [];
  const shapes = new Set<string>();
  const structurallyOrdered = [...candidates.slice(0, 40)].sort((a, b) =>
    analysis.candidates[analysisKey(a)].remainingTurns.turns
      - analysis.candidates[analysisKey(b)].remainingTurns.turns);
  // Preserve the leading heuristic action, then diversify by type/rank.
  for (const play of [candidates[0], ...structurallyOrdered]) {
    if (!play) continue;
    const shape = `${play.type}:${play.rank}`;
    if (!shapes.has(shape)) { roots.push(play); shapes.add(shape); }
    if (roots.length >= 6) break;
  }
  if (last) roots.push(null);
  if (!roots.length) return finish();
  const totals = roots.map(() => ({ samples: 0, winRate: 0, doubleWinRate: 0, meanReward: 0 }));
  // Cache local-policy decisions by public state and that player's own sampled
  // hand. This cache never contains another player's real hand.
  const policyCache = new Map<string, CardPattern | null>();
  const policy: ChoosePlay = (cards, trick, free, currentLevel, state) => {
    const key = `${cards.map(c => c.id).sort((a, b) => a - b)}|${trick?.type}:${trick?.rank}|${state.selfSeatIndex}:${state.lastPlayPlayerIndex}|${state.players.map(p => `${p.cardCount}:${p.finishRank}`)}`;
    if (!policyCache.has(key)) policyCache.set(key, choose(cards, trick, free, currentLevel, state));
    return policyCache.get(key)!;
  };
  analysis.simulation.status = 'budget_exhausted';
  for (let sample = 0; sample < (options.maxSamples ?? 12); sample++) {
    await new Promise<void>(resolve => setImmediate(resolve));
    if (performance.now() >= deadline) break;
    const sampled = sampleHiddenHands(hand, context, knowledge, options.random);
    if (!sampled) { analysis.simulation.status = 'inconsistent_public_state'; break; }
    const results = roots.map(root => rollout(sampled, root, last, level, context, policy, deadline));
    if (results.some(result => result === null)) break;
    // Only complete paired samples count: every candidate faces the same deal.
    results.forEach((outcome, index) => {
      const total = totals[index];
      total.samples++;
      total.winRate += Number(outcome!.win);
      total.doubleWinRate += Number(outcome!.doubleWin);
      total.meanReward += outcome!.reward;
    });
    analysis.simulation.samples++;
    analysis.simulation.status = 'sampled';
  }
  roots.forEach((root, index) => {
    const total = totals[index];
    if (!total.samples) return;
    const result = { ...total, winRate: total.winRate / total.samples,
      doubleWinRate: total.doubleWinRate / total.samples, meanReward: total.meanReward / total.samples };
    if (root) analysis.candidates[analysisKey(root)].simulation = result;
    else analysis.passSimulation = result;
  });
  return finish();
}
