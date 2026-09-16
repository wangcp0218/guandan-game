import { Card, CardPattern, Rank } from '../../../shared/types';
import { createDeck, dealCards } from './card';
import { canBeat } from './compare';
import type { ChoosePlay } from './aiAnalysis';
import type { AiDecisionContext, AiRecentAction } from './llmAi';

export interface EvaluationRound {
  winnerTeam: 0 | 1;
  partnerRank: number;
  rewardForTeam0: number;
  steps: number;
}

export interface EvaluationSummary {
  deals: number;
  pairedRounds: number;
  candidateMeanReward: number;
  candidateMeanLevelDelta: number;
  candidateWinRate: number;
  candidateDoubleWinRate: number;
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

export function shuffledDeal(seed: number): Card[][] {
  const random = seededRandom(seed);
  const deck = createDeck();
  for (let index = deck.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [deck[index], deck[other]] = [deck[other], deck[index]];
  }
  return dealCards(deck, 4);
}

/** Complete one no-tribute round. Each policy receives only its own hand and
 * public history; the harness never passes another seat's cards in context. */
export function simulateEvaluationRound(
  initialHands: Card[][], level: Rank, strategies: [ChoosePlay, ChoosePlay, ChoosePlay, ChoosePlay],
  maxSteps = 800,
): EvaluationRound {
  const hands = initialHands.map(cards => [...cards]);
  const history: AiRecentAction[] = [];
  const finishes: number[] = [];
  let seat = 0;
  let trick: CardPattern | null = null;
  let trickWinner = -1;
  let passes = 0;
  const isFinished = (candidate: number) => finishes.includes(candidate);
  const nextActive = (from: number) => {
    for (let offset = 1; offset <= 4; offset++) {
      const candidate = (from + offset) % 4;
      if (!isFinished(candidate)) return candidate;
    }
    throw new Error('evaluation round has no active player');
  };
  const contextFor = (self: number): AiDecisionContext => ({
    selfSeatIndex: self,
    partnerSeatIndex: (self + 2) % 4,
    lastPlayPlayerIndex: trickWinner,
    roundNumber: 1,
    teamLevels: [level, level],
    leadingTeam: 0,
    players: hands.map((cards, index) => ({
      seatIndex: index,
      cardCount: cards.length,
      finishRank: isFinished(index) ? finishes.indexOf(index) + 1 : null,
      relation: index === self ? 'self' : index === (self + 2) % 4 ? 'partner' : 'opponent',
    })),
    recentActions: history.slice(-12),
    actionHistory: [...history],
    passCount: passes,
    publicTransfers: [],
  });

  for (let step = 1; step <= maxSteps; step++) {
    const action = strategies[seat](hands[seat], trick, !trick, level, contextFor(seat));
    if (action) {
      if (!canBeat(action, trick, level)) throw new Error(`strategy returned illegal pattern at step ${step}`);
      const ids = new Set(action.cards.map(card => card.id));
      if (ids.size !== action.cards.length
        || action.cards.some(card => !hands[seat].some(held => held.id === card.id))) {
        throw new Error(`strategy returned cards outside its hand at step ${step}`);
      }
      hands[seat] = hands[seat].filter(card => !ids.has(card.id));
      history.push({ seatIndex: seat, action: 'play', pattern: action });
      trick = action;
      trickWinner = seat;
      passes = 0;
      if (hands[seat].length === 0) finishes.push(seat);
      const doubleWin = finishes.length === 2 && finishes[0] % 2 === finishes[1] % 2;
      if (doubleWin || finishes.length >= 3) {
        const winnerTeam = finishes[0] % 2 as 0 | 1;
        const partnerSeat = (finishes[0] + 2) % 4;
        const partnerRank = finishes.indexOf(partnerSeat) + 1 || 4;
        const magnitude = (partnerRank === 2 ? 3 : partnerRank === 3 ? 2 : 1) / 3;
        return {
          winnerTeam, partnerRank,
          rewardForTeam0: winnerTeam === 0 ? magnitude : -magnitude,
          steps: step,
        };
      }
      seat = nextActive(seat);
      continue;
    }
    if (!trick) throw new Error(`strategy passed a free lead at step ${step}`);
    history.push({ seatIndex: seat, action: 'pass' });
    passes++;
    const needed = 4 - finishes.length - (isFinished(trickWinner) ? 0 : 1);
    if (passes >= needed) {
      const partner = (trickWinner + 2) % 4;
      seat = isFinished(trickWinner)
        ? isFinished(partner) ? nextActive(partner) : partner
        : trickWinner;
      trick = null;
      trickWinner = -1;
      passes = 0;
    } else {
      seat = nextActive(seat);
    }
  }
  throw new Error(`evaluation round exceeded ${maxSteps} actions`);
}

/** Paired-seat evaluation cancels deal advantage: each strategy plays both
 * partnerships on the same deal. Reward is always from the candidate's view. */
export function evaluateStrategies(
  candidate: ChoosePlay, baseline: ChoosePlay,
  options: { deals?: number; seed?: number; level?: Rank } = {},
): EvaluationSummary {
  const deals = Math.max(1, options.deals ?? 20);
  const level = options.level ?? Rank.Two;
  let reward = 0;
  let wins = 0;
  let doubles = 0;
  for (let index = 0; index < deals; index++) {
    const hands = shuffledDeal((options.seed ?? 1) + index);
    const asTeam0 = simulateEvaluationRound(
      hands, level, [candidate, baseline, candidate, baseline],
    );
    const asTeam1 = simulateEvaluationRound(
      hands, level, [baseline, candidate, baseline, candidate],
    );
    const outcomes = [
      { reward: asTeam0.rewardForTeam0, won: asTeam0.winnerTeam === 0, double: asTeam0.partnerRank === 2 },
      { reward: -asTeam1.rewardForTeam0, won: asTeam1.winnerTeam === 1, double: asTeam1.partnerRank === 2 },
    ];
    for (const outcome of outcomes) {
      reward += outcome.reward;
      wins += Number(outcome.won);
      doubles += Number(outcome.won && outcome.double);
    }
  }
  const pairedRounds = deals * 2;
  return {
    deals,
    pairedRounds,
    candidateMeanReward: reward / pairedRounds,
    candidateMeanLevelDelta: reward * 3 / pairedRounds,
    candidateWinRate: wins / pairedRounds,
    candidateDoubleWinRate: doubles / pairedRounds,
  };
}
