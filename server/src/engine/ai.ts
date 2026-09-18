import { AiModelSelection, Card, CardPattern, PatternType, Rank, Suit } from '../../../shared/types';
import { effectiveRank, isJoker } from './card';
import {
  isWildCard, validWildSubstitutions,
} from './patterns';
import { canBeat, isBombPattern } from './compare';
import { llmFindBestPlay } from './llmAi';
import type { AiDecisionContext } from './llmAi';
import { analyzeDecision, analysisKey, buildPublicKnowledge, createTurnEstimator, publicControlEvidence } from './aiAnalysis';
import type { DecisionAnalysis, SampleResult } from './aiAnalysis';

function getRankCounts(hand: Card[]): Map<number, Card[]> {
  const map = new Map<number, Card[]>();
  for (const c of hand) {
    const list = map.get(c.rank) || [];
    list.push(c);
    map.set(c.rank, list);
  }
  return map;
}

function generateSingles(hand: Card[]): Card[][] {
  return hand.map(c => [c]);
}

function combinations<T>(items: T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (size < 0 || size > items.length) return [];
  const result: T[][] = [];
  const visit = (start: number, selected: T[]) => {
    if (selected.length === size) {
      result.push([...selected]);
      return;
    }
    for (let index = start; index <= items.length - (size - selected.length); index++) {
      selected.push(items[index]);
      visit(index + 1, selected);
      selected.pop();
    }
  };
  visit(0, []);
  return result;
}

function rankRuns(length: 2 | 3 | 5): Rank[][] {
  const runs: Rank[][] = [[
    Rank.Ace,
    ...Array.from({ length: length - 1 }, (_, index) => (Rank.Two + index) as Rank),
  ]];
  for (let start = Rank.Two; start + length - 1 <= Rank.Ace; start++) {
    runs.push(Array.from({ length }, (_, index) => (start + index) as Rank));
  }
  return runs;
}

interface TargetGroup {
  rank: Rank;
  count: number;
  suit?: Suit;
}

/**
 * Enumerate physical ways to fill fixed rank groups. 逢人配 may replace a
 * missing ordinary card, including one which is otherwise available; keeping
 * those alternatives lets the scorer choose the least damaging decomposition.
 */
function generateGroupedPatterns(
  regulars: Card[],
  wilds: Card[],
  groups: TargetGroup[],
  type: PatternType,
  patternRank: Rank,
  add: (pattern: CardPattern) => void,
) {
  const visit = (
    groupIndex: number,
    cards: Card[],
    substitutionTargets: Array<{ rank: Rank; suit: Suit }>,
  ) => {
    if (groupIndex === groups.length) {
      for (const selectedWilds of combinations(wilds, substitutionTargets.length)) {
        add({
          type,
          rank: patternRank,
          length: cards.length + selectedWilds.length,
          cards: [...cards, ...selectedWilds],
          substitutions: selectedWilds.map((card, index) => ({
            ...card,
            ...substitutionTargets[index],
          })),
        });
      }
      return;
    }
    const group = groups[groupIndex];
    const candidates = regulars.filter(card =>
      card.rank === group.rank && (group.suit === undefined || card.suit === group.suit)
    );
    const minimumNatural = group.rank > Rank.Ace
      ? group.count
      : Math.max(0, group.count - (wilds.length - substitutionTargets.length));
    const maximumNatural = Math.min(group.count, candidates.length);
    for (let naturalCount = minimumNatural; naturalCount <= maximumNatural; naturalCount++) {
      const missing = group.count - naturalCount;
      if (substitutionTargets.length + missing > wilds.length) continue;
      for (const selected of combinations(candidates, naturalCount)) {
        const resolvedSuit = group.suit ?? Suit.Spade;
        visit(
          groupIndex + 1,
          [...cards, ...selected],
          [...substitutionTargets, ...Array.from({ length: missing }, () => ({
            rank: group.rank,
            suit: resolvedSuit,
          }))],
        );
      }
    }
  };
  visit(0, [], []);
}

export function generateLegalPlays(
  hand: Card[],
  currentLevel: number
): CardPattern[] {
  const wilds = hand.filter(card => isWildCard(card, currentLevel));
  const regulars = hand.filter(card => !isWildCard(card, currentLevel));
  const patterns: CardPattern[] = [];
  const seen = new Set<string>();

  const add = (pattern: CardPattern) => {
    if (!validWildSubstitutions(pattern.cards, pattern.substitutions || [], currentLevel)) return;
    const ids = pattern.cards.map(card => card.id).sort((a, b) => a - b);
    const key = `${pattern.type}:${pattern.rank}:${ids.join(',')}`;
    if (new Set(ids).size !== ids.length || seen.has(key)) return;
    seen.add(key);
    patterns.push(pattern);
  };

  for (const cards of generateSingles(hand)) {
    add({ type: PatternType.Single, rank: cards[0].rank, length: 1, cards });
  }

  // Same-rank groups. Pairs may be made from jokers; larger groups may not.
  for (let rank = Rank.Two; rank <= Rank.BigJoker; rank++) {
    generateGroupedPatterns(regulars, wilds, [{ rank, count: 2 }], PatternType.Pair, rank, add);
    if (rank <= Rank.Ace) {
      generateGroupedPatterns(regulars, wilds, [{ rank, count: 3 }], PatternType.Triple, rank, add);
      for (let size = 4; size <= 10; size++) {
        generateGroupedPatterns(
          regulars, wilds, [{ rank, count: size }],
          `bomb${size}` as PatternType, rank, add,
        );
      }
    }
  }

  for (let tripleRank = Rank.Two; tripleRank <= Rank.Ace; tripleRank++) {
    for (let pairRank = Rank.Two; pairRank <= Rank.BigJoker; pairRank++) {
      if (tripleRank === pairRank) continue;
      generateGroupedPatterns(regulars, wilds, [
        { rank: tripleRank, count: 3 },
        { rank: pairRank, count: 2 },
      ], PatternType.TriplePair, tripleRank, add);
    }
  }

  for (const run of rankRuns(5)) {
    const groups = run.map(rank => ({ rank, count: 1 }));
    generateGroupedPatterns(regulars, wilds, groups, PatternType.Straight, run[run.length - 1], pattern => {
      const substitutions = pattern.substitutions || [];
      const resolved = pattern.cards.map(card => substitutions.find(item => item.id === card.id) || card);
      if (resolved.every(card => card.suit === resolved[0].suit)) {
        // A wildcard can deliberately take another suit to declare an ordinary
        // straight. Natural straight flushes cannot be downgraded this way.
        if (substitutions.length === 0) return;
        pattern.substitutions = substitutions.map((card, index) => index === 0
          ? { ...card, suit: resolved[0].suit === Suit.Spade ? Suit.Heart : Suit.Spade }
          : card);
      }
      add(pattern);
    });
    for (const suit of [Suit.Spade, Suit.Heart, Suit.Club, Suit.Diamond]) {
      generateGroupedPatterns(
        regulars, wilds, run.map(rank => ({ rank, count: 1, suit })),
        PatternType.FlushStraight, run[run.length - 1], add,
      );
    }
  }

  for (const run of rankRuns(3)) {
    generateGroupedPatterns(
      regulars, wilds, run.map(rank => ({ rank, count: 2 })),
      PatternType.ConsecutivePair, run[run.length - 1], add,
    );
  }
  for (const run of rankRuns(2)) {
    generateGroupedPatterns(
      regulars, wilds, run.map(rank => ({ rank, count: 3 })),
      PatternType.Plane, run[run.length - 1], add,
    );
  }

  const jokers = hand.filter(isJoker);
  if (jokers.length === 4) {
    add({ type: PatternType.KingBomb, rank: Rank.BigJoker, length: 4, cards: jokers });
  }

  return patterns;
}

function strategicPlayKey(play: CardPattern): string {
  const cards = play.cards
    .map(card => `${card.suit}${card.rank}`)
    .sort()
    .join(',');
  return `${play.type}:${play.rank}:${play.length}:${cards}`;
}

function dedupeStrategicPlays(plays: CardPattern[]): CardPattern[] {
  const seen = new Set<string>();
  return plays.filter(play => {
    const key = strategicPlayKey(play);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function applyStrategicGuards(
  plays: CardPattern[],
  hand: Card[],
  currentLevel: number,
  isFreePlay: boolean,
  context?: AiDecisionContext,
): CardPattern[] {
  let guarded = plays;

  // Preserve 逢人配 instead of wasting it as a single. The only exception is an
  // urgent block when an opponent has one card and no safer legal play exists.
  if (hand.length > 1) {
    const withoutWildSingles = guarded.filter(play => !(
      play.type === PatternType.Single && isWildCard(play.cards[0], currentLevel)
    ));
    const opponentReportedSingle = context?.players.some(player =>
      player.relation === 'opponent' && player.finishRank === null && player.cardCount === 1
    ) || false;
    if (withoutWildSingles.length > 0 || !opponentReportedSingle) {
      guarded = withoutWildSingles;
    }
  }

  // Keep larger singles and partner-overtaking actions available for analysis.
  // The final policy enforces cooperation and low-first with evidence-based exceptions.

  return guarded;
}

/**
 * Round-level urgency multiplier, 1.0 = neutral. Above 1 the AI fights harder
 * this hand (trailing on levels, defending the table against a near-Ace
 * opponent, later rounds of a finite match); below 1 a comfortable lead plays
 * conservatively. Drives bomb willingness and blocking urgency so decisions
 * follow the match score, not just the cards. Uses only public context.
 */
export function roundStake(context?: AiDecisionContext): number {
  if (!context) return 1;
  const ourTeam = context.selfSeatIndex % 2;
  const gap = context.teamLevels[ourTeam] - context.teamLevels[1 - ourTeam];
  const leading = context.leadingTeam === ourTeam;
  const opponentNearAce = context.teamLevels[1 - ourTeam] >= Rank.Ace - 2;
  let stake = 1;
  if (gap < 0) stake += Math.min(3, -gap) * 0.12;
  else if (leading && gap >= 2) stake -= Math.min(2, gap) * 0.05;
  if (leading && opponentNearAce) stake += 0.15;
  stake += Math.min(4, Math.max(0, context.roundNumber - 1)) * 0.02;
  return stake;
}

/** Base7-inspired value: prefer shedding groups while preserving controls and structures. */
export function scorePlay(
  play: CardPattern,
  hand: Card[],
  currentLevel: number,
  isFreePlay: boolean,
  context?: AiDecisionContext,
  protectedCardIds: ReadonlySet<number> = new Set(),
): number {
  if (play.cards.length === hand.length) return 1_000_000;
  const handCounts = getRankCounts(hand);
  const playedCounts = getRankCounts(play.cards);
  const lastPlayer = context?.players.find(player => player.seatIndex === context.lastPlayPlayerIndex);
  const partnerLed = lastPlayer?.relation === 'partner';
  const opponentLed = lastPlayer?.relation === 'opponent';
  const urgentOpponent = context?.players.some(player =>
    player.relation === 'opponent' && player.finishRank === null && player.cardCount <= 5
  ) || false;

  const sequence = [PatternType.Straight, PatternType.ConsecutivePair, PatternType.Plane,
    PatternType.FlushStraight].includes(play.type);
  const stake = roundStake(context);
  // effectiveRank deliberately jumps level cards/jokers to 99/100/101 for
  // legality comparison. Reusing that discontinuous scale as a resource cost
  // charged a joker roughly 600 points and then charged it again below. Keep a
  // compact strategic order here; explicit wildcard/joker costs retain their
  // option value without making them practically unplayable.
  const strategicRank = play.rank === currentLevel ? 15
    : play.rank === Rank.SmallJoker ? 16
      : play.rank === Rank.BigJoker ? 17 : play.rank;
  const sheddingValue = isFreePlay ? 30 : 120;
  let score = play.cards.length * sheddingValue - (sequence ? play.rank : strategicRank) * 6;
  if (play.cards.length > 1) score += 100;
  if ([PatternType.Straight, PatternType.TriplePair, PatternType.ConsecutivePair, PatternType.Plane].includes(play.type)) {
    score += 100;
  }

  // A card which belongs to a bomb/king bomb/flush straight or is a wildcard
  // has high option value. Penalise partial destruction, not playing it whole.
  for (const [rank, selected] of playedCounts) {
    const held = handCounts.get(rank)?.length || 0;
    if (held >= 4 && selected.length < held) score -= 650;
    // Ordinary group damage is measured from the remaining combinations in
    // orderCandidates, rather than charging every split the same fixed price.
  }
  if (!isBombPattern(play)) {
    const late = hand.length <= 10 || context?.players.some(p => p.finishRank === null && p.cardCount <= 5);
    score -= play.cards.filter(card => isWildCard(card, currentLevel)).length * (late ? 90 : 260);
    score -= play.cards.filter(isJoker).length * (late ? 35 : 100);
    score -= play.cards.filter(card => protectedCardIds.has(card.id)).length * 90;
  }

  if (isBombPattern(play)) {
    // Taking the trick with a bomb has the same immediate benefit regardless
    // of size. Cancel the generic shedding bonus and charge for bomb strength;
    // whole-hand finishes still take priority above. Keep leading costs finite
    // so intact bombs beat dismantling the only remaining structures. The cost
    // scales inversely with the round stake: a trailing team spends bombs to
    // take control, a leading team hoards them for defense.
    const tier = play.type === PatternType.KingBomb ? 8
      : play.type === PatternType.FlushStraight ? 1.5 : play.cards.length - 4;
    // Urgency decides whether a bomb is worth spending, but must never make a
    // larger sufficient bomb cheaper than a smaller one. Cancel the generic
    // shedding reward unconditionally and only discount part of the tier cost.
    score -= play.cards.length * sheddingValue + 100;
    score -= tier * (100 + 40 * (2 - stake));
    // Apply match urgency equally to every bomb so it affects the bomb/pass
    // decision without reversing the ordering between sufficient bombs.
    score += (stake - 1) * 400;
    if (partnerLed) score -= 20_000;
    if (opponentLed && lastPlayer && lastPlayer.cardCount <= 14) score += 650 * stake;
    if (urgentOpponent) score += 600 * stake;
  }

  if (!isFreePlay && !isBombPattern(play)) score += 350 * stake;
  if (partnerLed) score -= 15_000;

  if (isFreePlay && context) {
    const partner = context.players.find(player => player.relation === 'partner' && player.finishRank === null);
    const opponents = context.players.filter(player => player.relation === 'opponent' && player.finishRank === null);
    if (partner?.cardCount === play.cards.length) score += 900 * stake;
    if (opponents.some(player => player.cardCount === play.cards.length)) score -= 350;

    // Shape the lead for a reported partner, not merely for an exact whole-hand
    // match. Lower leads remain preferable through the generic rank cost.
    if (partner?.cardCount === 1 && play.type === PatternType.Single) score += 520 * stake;
    if (partner?.cardCount === 2 && play.type === PatternType.Pair) score += 520 * stake;
    const nextSeat = (context.selfSeatIndex + 1) % 4;
    for (const opponent of opponents) {
      const exposesReportedShape = opponent.cardCount === 1 && play.type === PatternType.Single
        || opponent.cardCount === 2 && play.type === PatternType.Pair;
      if (exposesReportedShape) score -= opponent.seatIndex === nextSeat ? 900 : 260;
    }
  }

  if (context && (play.type === PatternType.Single || play.type === PatternType.Pair)) {
    const evidence = publicControlEvidence(play, hand, currentLevel, context);
    if (evidence?.unbeatable) score += isFreePlay ? 260 : 420;
  }

  // Round-outcome shaping from finish ranks: partner already first means our
  // own finish is worth a 双上 (+3), so shed aggressively; an opponent already
  // first means the other opponent's rank decides the upgrade we concede, so
  // block their tricks harder.
  const partnerHead = context?.players.some(player =>
    player.relation === 'partner' && player.finishRank === 1);
  const opponentHead = context?.players.some(player =>
    player.relation === 'opponent' && player.finishRank === 1);
  if (partnerHead && !isBombPattern(play)) score += play.cards.length * 25;
  if (opponentHead && lastPlayer?.relation === 'opponent') score += 400 * stake;

  // Prefer the weakest physical realization when declarations are equivalent.
  score -= play.cards.reduce((sum, card) => sum + effectiveRank(card.rank, currentLevel), 0) / 20;
  return score;
}

export interface CompressedAiCandidates {
  plays: CardPattern[];
  /** Number of equivalent physical choices represented by each model action. */
  equivalentCounts: number[];
}

const MODEL_ACTION_LIMIT = 96;

/** Bound prompt size without deleting an entire strategic family. Input is
 * already heuristic-ordered; round-robin selection preserves representatives
 * from every pattern type before taking deeper alternatives. */
export function limitModelCandidates(
  compressed: CompressedAiCandidates, limit = MODEL_ACTION_LIMIT,
): CompressedAiCandidates {
  if (compressed.plays.length <= limit) return compressed;
  const buckets = new Map<PatternType, number[]>();
  compressed.plays.forEach((play, index) => {
    const bucket = buckets.get(play.type) || [];
    bucket.push(index);
    buckets.set(play.type, bucket);
  });
  const selected = new Set<number>([0]);
  for (let row = 0; selected.size < limit; row++) {
    let added = false;
    for (const bucket of buckets.values()) {
      const index = bucket[row];
      if (index !== undefined && selected.size < limit) {
        selected.add(index);
        added = true;
      }
    }
    if (!added) break;
  }
  const indices = [...selected].sort((left, right) => left - right);
  return {
    plays: indices.map(index => compressed.plays[index]),
    equivalentCounts: indices.map(index => compressed.equivalentCounts[index]),
  };
}

/**
 * Preserve every distinct declared strategy while merging choices which differ
 * only by equivalent physical cards. Because input is already Base7 ordered,
 * the retained representative is the least damaging concrete realization.
 */
export function compressCandidatesForModel(
  ordered: CardPattern[],
  currentLevel: number,
): CompressedAiCandidates {
  const groups = new Map<string, { play: CardPattern; count: number }>();
  for (const play of ordered) {
    const substitutions = new Map((play.substitutions || []).map(card => [card.id, card]));
    const resolvedCounts = new Map<number, number>();
    for (const card of play.cards) {
      const resolved = substitutions.get(card.id) || card;
      resolvedCounts.set(resolved.rank, (resolvedCounts.get(resolved.rank) || 0) + 1);
    }
    const declaredRanks = [...resolvedCounts]
      .sort(([left], [right]) => left - right)
      .map(([rank, count]) => `${rank}x${count}`)
      .join(',');
    const wildcardCount = play.cards.filter(card => isWildCard(card, currentLevel)).length;
    const flushSuit = play.type === PatternType.FlushStraight
      ? (substitutions.get(play.cards[0]?.id) || play.cards[0])?.suit || ''
      : '';
    const key = `${play.type}:${play.rank}:${play.length}:${declaredRanks}:w${wildcardCount}:s${flushSuit}`;
    const existing = groups.get(key);
    if (existing) existing.count++;
    else groups.set(key, { play, count: 1 });
  }
  const values = [...groups.values()];
  return {
    plays: values.map(value => value.play),
    equivalentCounts: values.map(value => value.count),
  };
}

/** Compare whole-hand routes, not just the number of cards shed now.
 * Reuse physical candidates: a residual combination must use no played cards.
 * The bounded estimator is an approximation when its search budget expires. */
export function remainingStructureScores(
  hand: Card[], plays: CardPattern[], allPlays: CardPattern[], level: number,
  analysis?: DecisionAnalysis,
): Map<CardPattern, number> {
  const estimator = createTurnEstimator(hand, allPlays, performance.now() + 4);
  const whole = analysis?.handTurns ?? estimator.whole();
  const counts = getRankCounts(hand);
  const groups = allPlays.filter(play => play.cards.length > 1);
  const scores = new Map<CardPattern, number>();
  for (const play of plays) {
    const used = new Set(play.cards.map(card => card.id));
    const remaining = hand.filter(card => !used.has(card.id));
    const available = groups.filter(group => group.cards.every(card => !used.has(card.id)));
    const groupedIds = new Set(available.flatMap(group => group.cards.map(card => card.id)));
    const residualCounts = getRankCounts(remaining);
    let damage = 0;
    for (const [rank, cards] of residualCounts) {
      // High singles/pairs are controls; low isolated cards are liabilities.
      if (effectiveRank(rank, level) >= Rank.Queen) continue;
      const split = cards.length < (counts.get(rank)?.length || 0);
      if (cards.length === 1 && !groupedIds.has(cards[0].id)) {
        damage += split ? 160 : 55;
      } else if (cards.length === 2 && !available.some(group =>
        group.cards.length > 2 && cards.every(card => group.cards.some(c => c.id === card.id)))) {
        damage += split ? 65 : 25;
      }
    }
    const after = analysis?.candidates[analysisKey(play)]?.remainingTurns ?? estimator.after(play);
    // Approximate partitions carry less weight than fully searched partitions.
    const weight = whole.exact && after.exact ? 420 : 240;
    scores.set(play, weight * (whole.turns - after.turns - 1) - damage);
  }
  return scores;
}

function orderCandidates(
  plays: CardPattern[],
  hand: Card[],
  currentLevel: number,
  isFreePlay: boolean,
  context?: AiDecisionContext,
  analysis?: DecisionAnalysis,
  allPlays?: CardPattern[],
): CardPattern[] {
  // Evaluate retained same-type controls for every candidate before truncating
  // the model input. A higher disjoint play is potential recapture, not proof
  // that it can beat an opponent's unknown response.
  const controls = new Map<string, CardPattern[]>();
  for (const play of plays) {
    const key = `${play.type}:${play.length}`;
    const group = controls.get(key) || [];
    group.push(play);
    controls.set(key, group);
  }
  for (const group of controls.values()) group.sort((a, b) =>
    canBeat(a, b, currentLevel) ? -1 : canBeat(b, a, currentLevel) ? 1 : 0);
  const recaptureBonus = (play: CardPattern) => {
    const used = new Set(play.cards.map(card => card.id));
    const retained = controls.get(`${play.type}:${play.length}`)?.find(control =>
      canBeat(control, play, currentLevel) && control.cards.every(card => !used.has(card.id)));
    if (!retained) return 0;
    const strength = effectiveRank(retained.rank, currentLevel);
    // Low reserve cards are weak evidence of recapture; even A is not a lock.
    return strength >= effectiveRank(Rank.Ace, currentLevel) ? 75 : 20;
  };
  const protectedCardIds = new Set(plays
    .filter(play => play.type === PatternType.FlushStraight || play.type === PatternType.KingBomb)
    .flatMap(play => play.cards.map(card => card.id)));
  const structure = remainingStructureScores(
    hand, plays, allPlays ?? generateLegalPlays(hand, currentLevel), currentLevel, analysis,
  );
  const scores = new Map(plays.map(play => [
    play,
    scorePlay(play, hand, currentLevel, isFreePlay, context, protectedCardIds) + recaptureBonus(play)
      + (structure.get(play) || 0),
  ]));
  return [...plays].sort((a, b) => scores.get(b)! - scores.get(a)!);
}

/**
 * Guandan endgame defence against the clockwise next player: once the AI has
 * decided to play the reported shape, it must use its strongest legal one.
 * This deliberately does not force a single/pair lead or turn a PASS into a
 * play; it only replaces a chosen single/pair with the largest equivalent.
 */
export function enforceReportedNextPlayerMaximum(
  proposed: CardPattern | null,
  candidates: CardPattern[],
  nextPlayerCardCount: number,
  level: number,
): CardPattern | null {
  if (!proposed) return proposed;
  const requiredType = nextPlayerCardCount === 1
    ? PatternType.Single
    : nextPlayerCardCount === 2
      ? PatternType.Pair
      : null;
  if (requiredType === null || proposed.type !== requiredType) return proposed;

  const sameType = candidates.filter(play => play.type === requiredType);
  return sameType.reduce((strongest, play) =>
    canBeat(play, strongest, level) ? play : strongest, proposed);
}

function enforceNextPlayerReport(
  proposed: CardPattern | null,
  candidates: CardPattern[],
  level: number,
  context?: AiDecisionContext,
): CardPattern | null {
  if (!context) return proposed;
  const nextSeatIndex = (context.selfSeatIndex + 1) % 4;
  const nextPlayer = context.players.find(player => player.seatIndex === nextSeatIndex);
  if (!nextPlayer || nextPlayer.finishRank !== null) return proposed;
  return enforceReportedNextPlayerMaximum(proposed, candidates, nextPlayer.cardCount, level);
}

function retainNextPlayerReportMaximum(
  selected: CardPattern[],
  allCandidates: CardPattern[],
  level: number,
  context?: AiDecisionContext,
): CardPattern[] {
  if (!context || selected.length === 0) return selected;
  const nextSeatIndex = (context.selfSeatIndex + 1) % 4;
  const nextPlayer = context.players.find(player => player.seatIndex === nextSeatIndex);
  const requiredType = nextPlayer?.finishRank === null && nextPlayer.cardCount === 1
    ? PatternType.Single
    : nextPlayer?.finishRank === null && nextPlayer.cardCount === 2
      ? PatternType.Pair
      : null;
  if (requiredType === null) return selected;
  const matching = allCandidates.filter(play => play.type === requiredType);
  if (matching.length === 0) return selected;
  const strongest = matching.reduce((best, play) => canBeat(play, best, level) ? play : best);
  if (selected.includes(strongest)) return selected;
  return [...selected.slice(0, -1), strongest];
}

export function findBestPlay(
  hand: Card[],
  lastPattern: CardPattern | null,
  isFreePlay: boolean,
  currentLevel: number,
  context?: AiDecisionContext,
): CardPattern | null {
  const allPlays = generateLegalPlays(hand, currentLevel);
  let legalPlays = allPlays;

  if (!isFreePlay && lastPattern) {
    legalPlays = legalPlays.filter(p => canBeat(p, lastPattern, currentLevel));
  }

  if (legalPlays.length === 0) return null;
  legalPlays = dedupeStrategicPlays(legalPlays);
  const ordered = orderCandidates(legalPlays, hand, currentLevel, isFreePlay, context, undefined, allPlays);
  if (!isFreePlay && context) {
    const singleResponse = preferredOpponentSingleResponse(
      legalPlays, hand, lastPattern, currentLevel, context,
    );
    if (singleResponse) return singleResponse;
    const passScore = scorePass(hand, lastPattern, currentLevel, context);
    if (scorePlay(ordered[0], hand, currentLevel, false, context) <= passScore) return null;
  }
  return enforceNextPlayerReport(ordered[0] || null, legalPlays, currentLevel, context);
}

export function scorePass(
  hand: Card[], last: CardPattern | null, level: number, context: AiDecisionContext,
): number {
  const lastPlayer = context.players.find(player => player.seatIndex === context.lastPlayPlayerIndex);
  if (lastPlayer?.relation === 'partner') return 100_000;
  // Defensive fallback for incomplete/synthetic contexts: never pass on a
  // trick attributed to ourselves.
  if (lastPlayer?.relation === 'self') return -10_000;
  if (lastPlayer?.cardCount !== undefined && lastPlayer.cardCount <= 3) return -10_000;
  if (!last) return Number.NEGATIVE_INFINITY;
  const nextPlayer = context.players.find(player =>
    player.seatIndex === (context.selfSeatIndex + 1) % 4 && player.finishRank === null);
  let score = 250 + Math.min(150, effectiveRank(last.rank, level) * 6);
  if ((lastPlayer?.cardCount ?? 27) > 10) score += 70;
  if ((lastPlayer?.cardCount ?? 27) <= 5) score -= 260 * roundStake(context);
  const controlStreak = opponentControlStreak(context);
  if (lastPlayer?.relation === 'opponent' && controlStreak > 1) {
    score -= Math.min(3, controlStreak - 1) * 140 * roundStake(context);
  }
  if (nextPlayer?.relation === 'partner' && nextPlayer.cardCount <= 5) score += 90;
  if (nextPlayer?.relation === 'opponent' && nextPlayer.cardCount <= 5) score -= 140;
  // Holding fragile resources is valuable even when their immediate response is legal.
  const counts = getRankCounts(hand);
  if ([...counts.values()].some(cards => cards.length >= 4)) score += 35;
  if (hand.some(card => isWildCard(card, level))) score += 35;
  return score;
}

/**
 * Do not routinely yield an opponent's single while holding a natural loose
 * card that can beat it. Use the weakest sufficient loose single, preserving
 * pairs, level wildcards and jokers. If a short hand has already broken down
 * entirely into distinct singletons, its weakest sufficient control is also
 * allowed so those controls are not stranded at the end.
 */
function preferredOpponentSingleResponse(
  candidates: CardPattern[], hand: Card[], last: CardPattern | null, level: number,
  context?: AiDecisionContext,
): CardPattern | null {
  if (!context || !last || last.type !== PatternType.Single) return null;
  const lastPlayer = context.players.find(player => player.seatIndex === context.lastPlayPlayerIndex);
  if (lastPlayer?.relation !== 'opponent') return null;
  const counts = getRankCounts(hand);
  const singles = candidates.filter(play => play.type === PatternType.Single);
  if (singles.length === 0) return null;
  const looseNaturals = singles.filter(play => {
    const card = play.cards[0];
    return counts.get(card.rank)?.length === 1
      && !isWildCard(card, level)
      && !isJoker(card);
  });
  const preferred = looseNaturals.length > 0
    ? looseNaturals
    : hand.length <= 5 && [...counts.values()].every(cards => cards.length === 1)
      ? singles
      : [];
  if (preferred.length === 0) return null;
  return preferred.reduce((weakest, play) => canBeat(weakest, play, level) ? play : weakest);
}

/** Number of uninterrupted plays by the current trick leader, separated only
 * by passes. This is public tempo evidence, not hidden-card inference. */
export function opponentControlStreak(context: AiDecisionContext): number {
  const leader = context.lastPlayPlayerIndex;
  if (leader < 0) return 0;
  const history = context.actionHistory || context.recentActions;
  let streak = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    const action = history[index];
    if (action.action === 'pass') continue;
    if (action.seatIndex !== leader) break;
    streak++;
  }
  return streak;
}

function materiallyBetterSimulation(
  play: CardPattern, alternative: CardPattern | null, analysis?: DecisionAnalysis,
): boolean {
  const result = analysis?.candidates[analysisKey(play)]?.simulation;
  const other = alternative
    ? analysis?.candidates[analysisKey(alternative)]?.simulation : analysis?.passSimulation;
  // Small samples and marginal differences must not override team cooperation
  // or spending the weakest sufficient card. A sampled 100% is not proof.
  return !!result && !!other && result.samples >= 8 && result.samples === other.samples
    && result.meanReward - other.meanReward >= 0.25;
}

export function reliablyBetterSimulation(
  result: SampleResult | undefined, baseline: SampleResult | undefined,
): boolean {
  if (!result || !baseline || result.samples !== baseline.samples || result.samples < 8) return false;
  // Rewards lie in [-1, 1]. Without paired variance samples, use a shrinking
  // conservative margin rather than trusting the largest small-sample mean.
  const requiredMargin = Math.max(0.18, 0.8 / Math.sqrt(result.samples));
  return result.meanReward - baseline.meanReward >= requiredMargin;
}

/** Publicly provable interception of a reported single: the weaker card can be
 * overtaken, while no unseen single can beat the proposed card. No hidden hands. */
function blocksReportedSingle(
  play: CardPattern, weaker: CardPattern, hand: Card[], level: number,
  context?: AiDecisionContext,
): boolean {
  if (play.type !== PatternType.Single || weaker.type !== PatternType.Single || !context
    || !context.players.some(p => p.relation === 'opponent' && p.finishRank === null && p.cardCount === 1)) return false;
  const memory = buildPublicKnowledge(hand, context);
  if (!memory) return false;
  return memory.unseen.some(card => effectiveRank(card.rank, level) > effectiveRank(weaker.rank, level))
    && memory.unseen.every(card => effectiveRank(card.rank, level) <= effectiveRank(play.rank, level));
}

/** Enforced for both LLM replies and local fallback; explanations alone cannot
 * authorize overtaking the partner or spending a stronger equivalent group. */
export function enforceTeamStrategy(
  proposed: CardPattern | null, candidates: CardPattern[], hand: Card[],
  last: CardPattern | null, free: boolean, level: number,
  context?: AiDecisionContext, analysis?: DecisionAnalysis,
): CardPattern | null {
  const finish = candidates.find(play => play.cards.length === hand.length);
  if (finish) return finish;
  if (!proposed) {
    return free ? null : preferredOpponentSingleResponse(candidates, hand, last, level, context);
  }
  const reportAdjusted = enforceNextPlayerReport(proposed, candidates, level, context);
  if (!reportAdjusted) return null;
  proposed = reportAdjusted;
  const partnerLed = !free && last && context
    && context.lastPlayPlayerIndex === context.partnerSeatIndex;
  if (partnerLed && last) {
    const urgent = context?.players.some(p => p.relation === 'opponent'
      && p.finishRank === null && p.cardCount <= 5);
    if (!blocksReportedSingle(proposed, last, hand, level, context)
      && !(urgent && materiallyBetterSimulation(proposed, null, analysis))) return null;
  }
  const alternatives = candidates.filter(play => play.cards.length === proposed.cards.length
    && (play.type === proposed.type || (isBombPattern(play) && isBombPattern(proposed)))
    && canBeat(proposed, play, level)
    && (free || canBeat(play, last, level)));
  const ordered = orderCandidates([...alternatives, proposed], hand, level, free, context, analysis);
  for (const lower of ordered) {
    if (lower === proposed) break;
    const lowerTurns = analysis?.candidates[analysisKey(lower)]?.remainingTurns;
    const proposedTurns = analysis?.candidates[analysisKey(proposed)]?.remainingTurns;
    if (lowerTurns && proposedTurns && lowerTurns.turns > proposedTurns.turns) continue;
    if (materiallyBetterSimulation(proposed, lower, analysis)
      || blocksReportedSingle(proposed, lower, hand, level, context)) continue;
    // Do not weaken an interception of the partner's trick back into a pass.
    if (partnerLed && last && !blocksReportedSingle(lower, last, hand, level, context)
      && !materiallyBetterSimulation(lower, null, analysis)) continue;
    return lower;
  }
  return proposed;
}

export async function findSmartPlay(
  hand: Card[],
  lastPattern: CardPattern | null,
  isFreePlay: boolean,
  currentLevel: number,
  context?: AiDecisionContext,
  selection?: AiModelSelection,
): Promise<CardPattern | null> {
  const ruleResult = findBestPlay(hand, lastPattern, isFreePlay, currentLevel, context);
  const allPlays = generateLegalPlays(hand, currentLevel);
  let legalPlays = allPlays;
  if (!isFreePlay && lastPattern) {
    legalPlays = legalPlays.filter(play => canBeat(play, lastPattern, currentLevel));
  }
  legalPlays = dedupeStrategicPlays(legalPlays);
  // Skip strategic analysis only when there is genuinely no choice. During a
  // follow, PASS is also legal and even one playable bomb is a real decision.
  if (isForcedAiDecision(legalPlays.length, isFreePlay)) {
    return enforceTeamStrategy(
      ruleResult, legalPlays, hand, lastPattern, isFreePlay, currentLevel, context,
    );
  }
  if (!shouldUseLlmForDecision(
    hand, legalPlays, lastPattern, isFreePlay, currentLevel, context,
  )) {
    return enforceTeamStrategy(
      ruleResult, legalPlays, hand, lastPattern, isFreePlay, currentLevel, context,
    );
  }
  // The hint system keeps every physical action. The model sees every distinct
  // declared strategy, with equivalent deck-copy/suit choices compressed.
  const completeLegalPlays = legalPlays;
  const compressed = limitModelCandidates(compressCandidatesForModel(
    orderCandidates(legalPlays, hand, currentLevel, isFreePlay, context, undefined, allPlays),
    currentLevel,
  ));
  legalPlays = retainNextPlayerReportMaximum(
    compressed.plays, completeLegalPlays, currentLevel, context,
  );
  let equivalentCounts = legalPlays.map(play => {
    const index = compressed.plays.indexOf(play);
    return index >= 0 ? compressed.equivalentCounts[index] : 1;
  });
  const equivalentCountByPlay = new Map(legalPlays.map((play, index) => [play, equivalentCounts[index]]));
  const handCombinations = isFreePlay ? compressed : limitModelCandidates(compressCandidatesForModel(
    orderCandidates(dedupeStrategicPlays(allPlays), hand, currentLevel, true, context),
    currentLevel,
  ));
  const analysis = await analyzeDecision(
    hand, allPlays, legalPlays, isFreePlay ? null : lastPattern,
    currentLevel, context, findBestPlay,
  );
  legalPlays = orderCandidates(legalPlays, hand, currentLevel, isFreePlay, context, analysis, allPlays);
  equivalentCounts = legalPlays.map(play => equivalentCountByPlay.get(play) || 1);
  let fallbackResult = (isFreePlay || ruleResult) ? legalPlays[0] || ruleResult : null;
  // Do not let one lucky hidden-hand sample override the baseline. Compare
  // paired, completed simulations only, retaining baseline preference on ties.
  if (analysis.simulation.samples >= 8) {
    const simulated = legalPlays.filter(play => analysis.candidates[analysisKey(play)]?.simulation);
    simulated.sort((a, b) => analysis.candidates[analysisKey(b)].simulation!.meanReward
      - analysis.candidates[analysisKey(a)].simulation!.meanReward);
    if (simulated.length) {
      const best = analysis.candidates[analysisKey(simulated[0])].simulation!;
      const baseline = ruleResult
        ? analysis.candidates[analysisKey(ruleResult)]?.simulation
        : analysis.passSimulation;
      if (reliablyBetterSimulation(best, baseline)) fallbackResult = simulated[0];
      const selected = fallbackResult
        ? analysis.candidates[analysisKey(fallbackResult)]?.simulation
        : analysis.passSimulation;
      if (reliablyBetterSimulation(analysis.passSimulation, selected)) fallbackResult = null;
    }
  }

  try {
    const llmResult = await llmFindBestPlay(
      hand,
      legalPlays,
      lastPattern,
      isFreePlay,
      currentLevel,
      context,
      selection,
      analysis,
      equivalentCounts,
      handCombinations.plays,
      handCombinations.equivalentCounts,
    );
    // undefined means the model was unavailable/invalid; null is an intentional pass.
    if (llmResult !== undefined) return enforceTeamStrategy(
      llmResult, legalPlays, hand, lastPattern, isFreePlay, currentLevel, context, analysis,
    );
  } catch {}

  return enforceTeamStrategy(
    fallbackResult, legalPlays, hand, lastPattern, isFreePlay, currentLevel, context, analysis,
  );
}

export function isForcedAiDecision(playableCount: number, isFreePlay: boolean): boolean {
  return playableCount === 0 || (isFreePlay && playableCount === 1);
}

/**
 * Spend a model call only where long-range judgement can plausibly change the
 * deterministic result. Routine follows remain local; leads, endgames and
 * consequential bomb decisions retain model analysis.
 */
export function shouldUseLlmForDecision(
  hand: Card[], legalPlays: CardPattern[], lastPattern: CardPattern | null,
  isFreePlay: boolean, currentLevel: number, context?: AiDecisionContext,
): boolean {
  if (isForcedAiDecision(legalPlays.length, isFreePlay)) return false;
  // Preserve analyzed fallback behaviour for library callers without a room
  // context; production room decisions always provide public context.
  if (!context) return true;
  const activePlayers = context.players.filter(player => player.finishRank === null);
  const minimumCards = Math.min(...activePlayers.map(player => player.cardCount));
  if (hand.length <= 8 || minimumCards <= 5) return true;

  const hasDirectFinish = legalPlays.some(play => play.cards.length === hand.length);
  if (hasDirectFinish) return true;
  if (isFreePlay) {
    // Multiple lead shapes define the hand's route; rank-only choices inside a
    // single shape are handled well by deterministic low-first scoring.
    return new Set(legalPlays.map(play => play.type)).size > 1;
  }

  const lastPlayer = context.players.find(player => player.seatIndex === context.lastPlayPlayerIndex);
  if (lastPlayer?.relation === 'partner') return false;
  if (lastPattern && isBombPattern(lastPattern)) return true;
  const bombs = legalPlays.filter(isBombPattern);
  const ordinary = legalPlays.filter(play => !isBombPattern(play));
  if (bombs.length > 0 && ordinary.length === 0) {
    const levelGap = context.teamLevels[context.selfSeatIndex % 2]
      - context.teamLevels[1 - context.selfSeatIndex % 2];
    return levelGap < 0 || (lastPlayer?.cardCount ?? 27) <= 10;
  }

  // A forced choice between consuming and preserving 逢人配 is strategically
  // meaningful; ordinary same-type minimum follows stay local.
  const usesWildcard = (play: CardPattern) => play.cards.some(card => isWildCard(card, currentLevel));
  return legalPlays.some(usesWildcard) && legalPlays.some(play => !usesWildcard(play));
}
