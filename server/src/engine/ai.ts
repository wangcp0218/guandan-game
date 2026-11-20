import { AiModelSelection, Card, CardPattern, PatternType, Rank, Suit } from '../../../shared/types';
import { effectiveRank, isJoker } from './card';
import {
  isWildCard, validWildSubstitutions,
} from './patterns';
import { canBeat, isBombPattern } from './compare';
import { llmFindBestPlay, normalizeAiSelection, DEFAULT_AI_SELECTION, LOCAL_AI_MODEL, HW_AI_MODEL } from './llmAi';
import type { AiDecisionContext, AiStrategyPlan } from './llmAi';
import { analyzeDecision, analyzeEndgameRoutes, analysisKey, buildPublicKnowledge, buildTeamPlan, buildTeamRoutes, createTurnEstimator, forecastTrick, enforceReportedNextPlayerMaximum, passPosition, publicControlEvidence, rankBombChanges, resourceCost, tailControlCost } from './aiAnalysis';
import type { DecisionAnalysis, SampleResult, TeamPlan, PublicKnowledge } from './aiAnalysis';

export { enforceReportedNextPlayerMaximum, passPosition } from './aiAnalysis';

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
  teamPlan?: TeamPlan,
): number {
  if (play.cards.length === hand.length) return 1_000_000;

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
  for (const bomb of rankBombChanges(hand, play)) {
    if (bomb.playedAsBomb && !bomb.after) continue;
    score -= 650;
  }
  // Attachments do not strengthen a full house. Price the control pair
  // separately from its triple rank, including declared wildcard substitutes.
  if (play.type === PatternType.TriplePair) {
    const substitutions = new Map((play.substitutions || []).map(card => [card.id, card]));
    const declared = new Map<Rank, number>();
    for (const card of play.cards) {
      const rank = (substitutions.get(card.id) || card).rank;
      declared.set(rank, (declared.get(rank) || 0) + 1);
    }
    const pairRank = [...declared].find(([, count]) => count === 2)?.[0];
    if (pairRank !== undefined) score -= pairRank >= Rank.SmallJoker ? 360
      : pairRank === currentLevel ? 240 : pairRank === Rank.Ace ? 100 : pairRank === Rank.King ? 60 : 0;
  }

  // A-2-3 / 2-3-4 pairs are low tricks even though level/A pairs are controls.
  if (play.type === PatternType.ConsecutivePair && play.rank <= Rank.Four) {
    score -= play.cards.reduce((cost, card) => cost + (card.rank === currentLevel ? 160
      : card.rank === Rank.Ace ? 80 : 0), 0);
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
    if (partnerLed) score -= 1000;
    if (opponentLed && lastPlayer && lastPlayer.cardCount <= 14) score += 650 * stake;
    if (urgentOpponent) score += 600 * stake;
  }

  if (!isFreePlay && !isBombPattern(play)) score += 350 * stake;
  if (partnerLed) score -= 500;

  if (isFreePlay && context) {
    const plan = teamPlan ?? buildTeamPlan(hand, [], context);
    const opponents = context.players.filter(player => player.relation === 'opponent' && player.finishRank === null);
    if (opponents.some(player => player.cardCount === play.cards.length)) score -= 350;

    // Shape the lead for a reported partner, not merely for an exact whole-hand
    // match. Lower leads remain preferable through the generic rank cost.
    if (plan.goal === 'feed_partner' && play.type === plan.feedType) score += 520 * stake;
    const nextSeat = (context.selfSeatIndex + 1) % 4;
    for (const opponent of opponents) {
      const exposesReportedShape = opponent.cardCount === 1 && play.type === PatternType.Single
        || opponent.cardCount === 2 && play.type === PatternType.Pair;
      if (exposesReportedShape) score -= opponent.seatIndex === nextSeat ? 900 : 260;
    }
  }

  if (context && (play.type === PatternType.Single || play.type === PatternType.Pair)) {
    const evidence = publicControlEvidence(play, hand, currentLevel, context);
    // A known control is valuable to retain, not a reason to open high in a
    // calm position. Spend it to contest a trick or meet an urgent threat.
    if (evidence?.unbeatable) score += isFreePlay ? (urgentOpponent ? 260 : 0) : 420;
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

/** A concrete low-cost takeover exception for the middle game, where paired
 * rollout evidence is usually unavailable. Preserve a teammate near finishing. */
function productivePartnerTakeover(
  play: CardPattern, hand: Card[], allPlays: CardPattern[], last: CardPattern | null,
  level: number, context?: AiDecisionContext,
): boolean {
  if (!context || !last || context.lastPlayPlayerIndex !== context.partnerSeatIndex) return false;
  const partner = context.players.find(player => player.relation === 'partner');
  if (!partner || partner.finishRank !== null || partner.cardCount < 3 || passPosition(context).closesTrick) return false;
  if (![PatternType.Single, PatternType.Pair].includes(play.type) || isBombPattern(last)
    || effectiveRank(last.rank, level) > Rank.Ten
    || effectiveRank(play.rank, level) < effectiveRank(Rank.Ace, level)) return false;
  if (context.players.some(player => player.relation === 'opponent' && player.finishRank === null
    && player.cardCount <= 2)) return false;
  const counts = getRankCounts(hand);
  if (play.cards.some(card => isWildCard(card, level)
    || (counts.get(card.rank)?.length || 0) !== play.cards.length)) return false;
  const used = new Set(play.cards.map(card => card.id));
  const remaining = hand.length - used.size;
  // A near-finished partner is protected unless public cards prove that
  // our takeover holds and our shorter remaining hand is a single legal exit.
  // No actual teammate hand or private plan is consulted.
  if (partner.cardCount <= 5 && (remaining >= partner.cardCount
    || publicControlEvidence(play, hand, level, context)?.unbeatable !== true)) return false;
  // The retained group must actually exist and use no card spent taking over.
  return remaining >= 3 && allPlays.some(exit => exit.cards.length === remaining
    && exit.cards.every(card => !used.has(card.id)));
}

function scoreTeamPlan(
  play: CardPattern, hand: Card[], allPlays: CardPattern[], level: number,
  free: boolean, plan: TeamPlan, context?: AiDecisionContext,
  memory: PublicKnowledge | null = null,
): number {
  if (!context || play.cards.length === hand.length) return 0;
  const used = new Set(play.cards.map(card => card.id));
  const remaining = hand.filter(card => !used.has(card.id));
  let score = 0;
  if (!free) {
    const last = [...(context.actionHistory || context.recentActions)].reverse()
      .find(action => action.action === 'play')?.pattern || null;
    if (productivePartnerTakeover(play, hand, allPlays, last, level, context)) score += 1100;
    else if (context.lastPlayPlayerIndex !== context.partnerSeatIndex
      && !isBombPattern(play) && effectiveRank(play.rank, level) >= effectiveRank(Rank.Ace, level)
      && remaining.length >= 3 && allPlays.some(exit => exit.cards.length === remaining.length
        && exit.cards.every(card => !used.has(card.id)))) score += 220;
  }
  if (plan.goal === 'finish_self') {
    score += play.cards.length * 20;
  } else if (plan.goal === 'block_opponent') {
    if (!free && context.lastPlayPlayerIndex === plan.threatSeat) score += 120;
  } else if (plan.goal === 'feed_partner') {
    const feed = allPlays.find(candidate => candidate.type === plan.feedType
      && effectiveRank(candidate.rank, level) < Rank.Queen
      && candidate.cards.every(card => !used.has(card.id)));
    const opponentLed = context.players.some(p => p.seatIndex === context.lastPlayPlayerIndex
      && p.relation === 'opponent');
    // Taking control only helps the plan if a suitable low lead remains.
    if (!free && opponentLed && feed && (isBombPattern(play)
      || effectiveRank(play.rank, level) >= effectiveRank(Rank.Ace, level))) score += 180;
    if (free && play.type === plan.feedType && memory) {
      const partner = memory.knownBySeat[context.partnerSeatIndex];
      if (partner.length === play.length && partner.every(card => card.rank === partner[0].rank)) {
        score += effectiveRank(partner[0].rank, level) > effectiveRank(play.rank, level) ? 150 : -520;
      }
    }
  }
  // Public memory: retain an appropriate control against a reported opponent.
  // No bomb guarantee is implied; a high unseen single may still beat it.
  if (memory && [PatternType.Single, PatternType.Pair].includes(play.type)) {
    const reported = context.players.some(p => p.relation === 'opponent'
      && p.finishRank === null && p.cardCount === play.length);
    if (reported) {
      const retained = allPlays.some(candidate => candidate.type === play.type
        && candidate.cards.every(card => !used.has(card.id))
        && memory.unseen.every(card => effectiveRank(card.rank, level) <= effectiveRank(candidate.rank, level)));
      if (retained && remaining.length > 0) score += 100;
    }
  }
  return score;
}

export interface CompressedAiCandidates {
  plays: CardPattern[];
  /** Number of equivalent physical choices represented by each model action. */
  equivalentCounts: number[];
}

const MODEL_ACTION_LIMIT = 24;

/** Bound prompt size without deleting an entire strategic family. Input is
 * already heuristic-ordered; round-robin selection preserves representatives
 * from every pattern type before taking deeper alternatives. */
export function limitModelCandidates(
  compressed: CompressedAiCandidates, limit = MODEL_ACTION_LIMIT,
  preferredKeys: ReadonlySet<string> = new Set(),
): CompressedAiCandidates {
  if (compressed.plays.length <= limit) return compressed;
  const buckets = new Map<PatternType, number[]>();
  compressed.plays.forEach((play, index) => {
    const bucket = buckets.get(play.type) || [];
    bucket.push(index);
    buckets.set(play.type, bucket);
  });
  const selected = new Set<number>([0]);
  for (const [index, play] of compressed.plays.entries()) {
    if (selected.size >= limit) break;
    if (preferredKeys.has(analysisKey(play))) selected.add(index);
  }
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
export function pruneOpeningWildLeads(
  plays: CardPattern[], hand: Card[], level: number, context?: AiDecisionContext,
): CardPattern[] {
  if (hand.length < 20 || !context || context.players.some(p => p.finishRank !== null || p.cardCount < 20)
    || (context.actionHistory || context.recentActions).filter(a => a.action === 'play').length > 4) return plays;
  const held = getRankCounts(hand);
  const natural = plays.filter(p => !isBombPattern(p) && !p.cards.some(c => isWildCard(c, level))
    && p.cards.every(c => (held.get(c.rank)?.length || 0) < 4
      || p.cards.filter(x => x.rank === c.rank).length === held.get(c.rank)!.length));
  return plays.filter(p => isBombPattern(p) || !p.cards.some(c => isWildCard(c, level))
    || !natural.some(n => n.type === p.type && n.length === p.length && (n.rank === p.rank || canBeat(n, p, level))
      && n.cards.every(c => p.cards.some(x => x.id === c.id)
        || effectiveRank(c.rank, level) < effectiveRank(Rank.Ace, level))));
}

export function removeWastefulWildRealizations(plays: CardPattern[], level: number): CardPattern[] {
  const groups = new Map<string, CardPattern[]>();
  const keyOf = (play: CardPattern) => {
    const resolved = play.cards.map(card => play.substitutions?.find(s => s.id === card.id) || card);
    const ranks = resolved.map(c => c.rank).sort((a,b) => a-b).join(',');
    const suit = play.type === PatternType.FlushStraight ? resolved[0]?.suit : '';
    return `${play.type}:${play.rank}:${play.length}:${ranks}:${suit}`;
  };
  for (const play of plays) {
    const key = keyOf(play);
    const group = groups.get(key) || [];
    group.push(play);
    groups.set(key, group);
  }
  return plays.filter(play => {
    const wilds = play.cards.filter(c => isWildCard(c, level)).length;
    if (!wilds) return true;
    const natural = play.cards.filter(c => !isWildCard(c, level));
    // Same declaration, and every original natural card is retained in the
    // replacement. Its remaining hand exchanges ordinary cards for flexible
    // wildcards, rather than sacrificing a different natural group.
    return !groups.get(keyOf(play))!.some(other =>
      other.cards.filter(c => isWildCard(c, level)).length < wilds
      && natural.every(card => other.cards.some(c => c.id === card.id)));
  });
}

export function compressCandidatesForModel(
  ordered: CardPattern[],
  currentLevel: number,
  allPlays: CardPattern[] = ordered,
): CompressedAiCandidates {
  const groups = new Map<string, { play: CardPattern; count: number }>();
  const flushes = allPlays.filter(p => p.type === PatternType.FlushStraight && !p.substitutions?.length);
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
    const retainsFlush = flushes.some(flush => flush.cards.every(c => !play.cards.some(used => used.id === c.id)));
    const key = `${play.type}:${play.rank}:${play.length}:${declaredRanks}:w${wildcardCount}:s${flushSuit}:f${+retainsFlush}`;
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
  const residualDamage = (remaining: Card[], available: CardPattern[]) => {
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
    return damage;
  };
  // PASS retains the current structure. Measure damage relative to that same
  // baseline instead of charging only the play for already stranded cards.
  const baselineDamage = residualDamage(hand, groups);
  for (const play of plays) {
    const used = new Set(play.cards.map(card => card.id));
    const remaining = hand.filter(card => !used.has(card.id));
    const available = groups.filter(group => group.cards.every(card => !used.has(card.id)));
    const after = analysis?.candidates[analysisKey(play)]?.remainingTurns ?? estimator.after(play);
    // Approximate partitions carry less weight than fully searched partitions.
    const weight = whole.exact && after.exact ? 420 : 240;
    scores.set(play, weight * (whole.turns - after.turns - 1)
      - residualDamage(remaining, available) + baselineDamage);
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
  evaluatedScores?: Map<CardPattern, number>,
): CardPattern[] {
  const wholeHandPlays = allPlays ?? generateLegalPlays(hand, currentLevel);
  const teamPlan = analysis?.teamPlan ?? buildTeamPlan(hand, wholeHandPlays, context);
  const endgameRoutes = isFreePlay ? analyzeEndgameRoutes(hand, wholeHandPlays, currentLevel, context) : {};
  const memory = context ? buildPublicKnowledge(hand, context) : null;
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
    hand, plays, wholeHandPlays, currentLevel, analysis,
  );
  const counts = getRankCounts(hand);
  const sequenceIds = new Set(wholeHandPlays
    .filter(play => [PatternType.Straight, PatternType.FlushStraight,
      PatternType.ConsecutivePair, PatternType.Plane].includes(play.type))
    .flatMap(play => play.cards.map(card => card.id)));
  const opponentLed = !isFreePlay && context?.players.some(player =>
    player.seatIndex === context.lastPlayPlayerIndex && player.relation === 'opponent');
  const scores = evaluatedScores ?? new Map<CardPattern, number>();
  for (const play of plays) {
    const card = play.cards[0];
    // A loose singleton is useful to shed, but a unique rank in a sequence
    // is not a loose card. This preference never bypasses structure or PASS.
    const looseBonus = opponentLed && play.type === PatternType.Single
      && counts.get(card.rank)?.length === 1 && !isJoker(card)
      && !isWildCard(card, currentLevel) && !sequenceIds.has(card.id) ? 80 : 0;
    let structureScore = structure.get(play) || 0;
    // An isolated joker always removes one partition when led. That is not
    // progress towards regaining the lead to unload the rest of the hand.
    // Discount that bookkeeping bonus and price the lost future recapture.
    // This is a finite preference: follows, reported threats and a one-play
    // exit retain their usual value, and paired simulation can still override.
    if (isFreePlay && play.type === PatternType.Single && isJoker(card)
      && !context?.players.some(p => p.relation === 'opponent' && p.finishRank === null && p.cardCount <= 2)
      && wholeHandPlays.some(group => !isBombPattern(group) && group.cards.length >= 3
        && group.cards.every(c => c.id !== card.id))
      && !wholeHandPlays.some(exit => exit.cards.length === hand.length - 1
        && exit.cards.every(c => c.id !== card.id))) {
      structureScore = Math.min(0, structureScore) - 240;
    }
    const after = analysis?.candidates[analysisKey(play)];
    // Winning a bomb trick is less useful when every remaining lead is small
    // and fragmented. Keep this finite so urgent defence can still outweigh it.
    const strandedAfterBomb = !isFreePlay && isBombPattern(play)
      && after?.continuation?.exact && after.continuation.extraTurns >= 1
      && after.continuation.largestRemainingGroup <= 2 && after.remainingTurns.turns >= 3 ? 180 : 0;
    const urgent = context?.players.some(p => p.finishRank === null
      && ((p.relation === 'opponent' && p.cardCount <= 5) || (p.relation === 'partner' && p.cardCount <= 2)));
    const tailCost = urgent && !isFreePlay ? 0 : (after?.continuation?.tailControlCost
      ?? tailControlCost(hand, play, wholeHandPlays, currentLevel));
    const replyRisk = after?.replyFinishRisk;
    const replyCost = replyRisk && replyRisk.samples >= 8 ? 240 * replyRisk.rate : 0;
    scores.set(play, scorePlay(play, hand, currentLevel, isFreePlay, context, protectedCardIds, teamPlan)
      + recaptureBonus(play) + structureScore + looseBonus - strandedAfterBomb - tailCost - replyCost
      + (endgameRoutes[analysisKey(play)]?.score || 0)
      + scoreTeamPlan(play, hand, wholeHandPlays, currentLevel, isFreePlay, teamPlan, context, memory));
  }
  return [...plays].sort((a, b) => scores.get(b)! - scores.get(a)!);
}

function enforceNextPlayerReport(
  proposed: CardPattern | null, candidates: CardPattern[], level: number,
  context?: AiDecisionContext, hand?: Card[],
): CardPattern | null {
  if (!context) return proposed;
  const nextPlayer = context.players.find(p => p.seatIndex === (context.selfSeatIndex + 1) % 4);
  if (!nextPlayer || nextPlayer.finishRank !== null) return proposed;
  const maximum = enforceReportedNextPlayerMaximum(proposed, candidates, nextPlayer.cardCount, level);
  if (!maximum || !hand || maximum === proposed) return maximum;
  const held = getRankCounts(hand);
  const splitRank = maximum.cards.find(c => (held.get(c.rank)?.length || 0) >= 4)?.rank;
  if (splitRank === undefined) return maximum;
  // Against one/two remaining cards an intact bomb also blocks that reported
  // shape. Compare that legal declaration before dismantling its rank group.
  // The final evidence/structure checks still evaluate the replacement.
  const intact = candidates.filter(p => isBombPattern(p)
    && p.cards.every(c => c.rank === splitRank && !isWildCard(c, level))
    && p.cards.length === held.get(splitRank)!.length);
  return intact.sort((a,b) => canBeat(a,b,level) ? 1 : canBeat(b,a,level) ? -1 : 0)[0] || maximum;
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
  allPlays: CardPattern[] = generateLegalPlays(hand, currentLevel),
): CardPattern | null {
  let legalPlays = allPlays;

  if (!isFreePlay && lastPattern) {
    legalPlays = legalPlays.filter(p => canBeat(p, lastPattern, currentLevel));
  }

  if (legalPlays.length === 0) return null;
  legalPlays = dedupeStrategicPlays(legalPlays);
  const scores = new Map<CardPattern, number>();
  const ordered = orderCandidates(legalPlays, hand, currentLevel, isFreePlay, context, undefined, allPlays, scores);
  const proposed = enforceNextPlayerReport(ordered[0], legalPlays, currentLevel, context, hand);
  if (!isFreePlay && context) {
    // The rollout policy uses this entry point too. Finite partner preferences
    // must not make simulated teammates steal tricks without a concrete plan.
    if (proposed && proposed.cards.length !== hand.length && lastPattern
      && context.lastPlayPlayerIndex === context.partnerSeatIndex
      && !blocksReportedSingle(proposed, lastPattern, hand, currentLevel, context)
      && !productivePartnerTakeover(proposed, hand, allPlays, lastPattern, currentLevel, context)) return null;
    const passScore = scorePass(hand, lastPattern, currentLevel, context);
    if (!proposed || scores.get(proposed)! <= passScore) return null;
  }
  return proposed;
}

/** Preference order for the human hint UI: the rule-based AI's scoring applied
 *  to the caller's candidate list without room context. The first entry is the
 *  play the heuristic itself would choose; later entries walk progressively
 *  weaker options. Every candidate stays in the list, including bombs. */
export function orderHintPlays(
  plays: CardPattern[],
  hand: Card[],
  currentLevel: number,
  isFreePlay: boolean,
  allPlays?: CardPattern[],
): CardPattern[] {
  if (plays.length === 0) return [];
  return orderCandidates(plays, hand, currentLevel, isFreePlay, undefined, undefined, allPlays);
}

export function scorePass(
  hand: Card[], last: CardPattern | null, level: number, context: AiDecisionContext,
): number {
  const lastPlayer = context.players.find(player => player.seatIndex === context.lastPlayPlayerIndex);
  if (lastPlayer?.relation === 'partner') return passPosition(context).closesTrick ? 760 : 600;
  // Defensive fallback for incomplete/synthetic contexts: never pass on a
  // trick attributed to ourselves.
  if (lastPlayer?.relation === 'self') return -10_000;
  if (!last) return Number.NEGATIVE_INFINITY;
  const position = passPosition(context);
  const nextPlayer = context.players.find(player => player.seatIndex === position.responders[0]);
  const nextLeader = context.players.find(player => player.seatIndex === position.nextLead);
  let score = 250 + Math.min(150, effectiveRank(last.rank, level) * 6);
  if ((lastPlayer?.cardCount ?? 27) > 10) score += 70;
  if (lastPlayer?.finishRank === null && lastPlayer.cardCount <= 5) {
    score -= (lastPlayer.cardCount <= 1 ? 420 : lastPlayer.cardCount <= 3 ? 220 : 140) * roundStake(context);
  }
  if (position.closesTrick && nextLeader?.relation === 'opponent') {
    score -= (nextLeader.cardCount <= 3 ? 240 : 100) * roundStake(context);
  } else if (position.closesTrick && nextLeader?.relation === 'partner') score += 180;
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

  // Passing a level single also gives up the chance to change the lead shape.
  // Spend a loose joker when there are groups to release or a reported partner
  // to feed. Do not treat a joker pair/king bomb as a disposable single, and
  // do not assume that taking this trick guarantees consecutive control.
  const looseJoker = hand.some(card => isJoker(card) && counts.get(card.rank)?.length === 1);
  const partner = context.players.find(player => player.relation === 'partner' && player.finishRank === null);
  const groupedRanks = [...counts.entries()].filter(([rank, cards]) =>
    rank < Rank.SmallJoker && cards.length >= 2).length;
  const canFeedPartner = partner && (partner.cardCount === 1
    ? hand.some(card => !isJoker(card) && !isWildCard(card, level)
      && effectiveRank(card.rank, level) < Rank.Queen && counts.get(card.rank)?.length === 1)
    : partner.cardCount === 2 && [...counts.entries()].some(([rank, cards]) =>
      cards.length === 2 && effectiveRank(rank, level) < Rank.Queen));
  if (lastPlayer?.relation === 'opponent' && last.type === PatternType.Single
    && last.rank === level && looseJoker && (groupedRanks >= 2 || canFeedPartner)) {
    score -= 250 * roundStake(context);
  }
  return score;
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
  return reliablyBetterSimulation(result, other);
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

// Higher priority rules run before lower ones. Each rule's conditions retain
// its defence/team exceptions; paired evidence only selects guarded actions.
export const AI_POLICY_PRIORITY = {
  finish: 1000, opening_resource: 900, ready_exit: 800, bomb_structure: 790,
  reported_defence: 780, partner_cooperation: 770, proven_control: 760,
  economy: 100, continuation: 90, urgent_interception: 780, deny_double_win: 780, paired_outcome: 50, team_trick: 45, team_baseline: 45, last_defender: 780,
} as const;
export interface AiPolicyCorrection {
  rule: keyof typeof AI_POLICY_PRIORITY;
  priority: number;
  from: string;
  to: string;
}
function policyAction(play: CardPattern | null): string {
  return play ? `${play.type}:${play.rank}:${play.cards.length}` : 'PASS';
}

/** Finite price for the control resources spent by a physical action. */
function controlResourceCost(play: CardPattern, hand: Card[], level: number): number {
  const cost = resourceCost(hand, play, level);
  const bombCost = !isBombPattern(play) ? 0
    : play.type === PatternType.KingBomb ? 24
      : play.type === PatternType.FlushStraight ? 14
        : 10 + Math.max(0, play.length - 4) * 2;
  return play.cards.reduce((sum, card) => sum
    + (isJoker(card) ? 6
      : isWildCard(card, level) ? 6
        : card.rank === level ? 4
          : card.rank === Rank.Ace ? 2 : 0), 0)
    + cost.broken_natural_bombs.length * 8 + cost.weakened_natural_bombs.length * 3 + bombCost;
}

function canContestWithReadyExit(
  play: CardPattern, level: number, context: AiDecisionContext, analysis?: DecisionAnalysis,
): boolean {
  const leader = context.players.find(player => player.seatIndex === context.lastPlayPlayerIndex);
  return analysis?.handTurns.exact === true && analysis.handTurns.turns === 1
    && leader?.relation === 'opponent' && leader.finishRank === null && leader.cardCount <= 8
    && (play.type === PatternType.Single || play.type === PatternType.Pair)
    && play.cards.every(card => card.rank < Rank.Ace && card.rank !== level)
    && analysis.candidates[analysisKey(play)]?.remainingTurns.turns === 1
    && passPosition(context).closesTrick && opponentControlStreak(context) >= 2
    && !reliablyBetterSimulation(analysis.passSimulation, analysis.candidates[analysisKey(play)]?.simulation);
}

/** Enforced for both LLM replies and local fallback; explanations alone cannot
 * authorize overtaking the partner or spending a stronger equivalent group. */
export function enforceTeamStrategy(
  proposed: CardPattern | null, candidates: CardPattern[], hand: Card[],
  last: CardPattern | null, free: boolean, level: number,
  context?: AiDecisionContext, analysis?: DecisionAnalysis,
  onCorrection?: (correction: AiPolicyCorrection) => void,
  fullLeadOptions?: CardPattern[],
): CardPattern | null {
  const changed = (from: CardPattern | null, to: CardPattern | null, rule: AiPolicyCorrection['rule']) => {
    if (onCorrection && from !== to && (from ? analysisKey(from) : 'PASS') !== (to ? analysisKey(to) : 'PASS')) {
      onCorrection?.({ rule, priority: AI_POLICY_PRIORITY[rule], from: policyAction(from), to: policyAction(to) });
    }
    return to;
  };
  const finish = candidates.find(play => play.cards.length === hand.length);
  if (finish) return changed(proposed, finish, 'finish');
  if (!proposed) {
    return null;
  }
  // Do not break a ready-to-finish hand merely to win one uncertain trick.
  // Catch-wind denial and an opponent about to finish remain valid reasons.
  // Opening ordinary leads must not spend wildcards for a declaration that
  // natural cards can make at identical strength. Model choice bypasses the
  // heuristic resource price, so compare physical realizations here too.
  const opening = free && hand.length >= 20 && context
    && context.players.every(p => p.finishRank === null && p.cardCount >= 20)
    && (context.actionHistory || context.recentActions).filter(a => a.action === 'play').length <= 4;
  if (opening && !isBombPattern(proposed) && proposed.cards.some(c => isWildCard(c, level))) {
    const naturalHand = hand.filter(c => !isWildCard(c, level));
    const held = getRankCounts(hand);
    const natural = generateLegalPlays(naturalHand, level).filter(play =>
      play.type === proposed!.type && play.length === proposed!.length
      && (play.rank === proposed!.rank || canBeat(play, proposed!, level))
      && play.cards.every(card => proposed!.cards.some(c => c.id === card.id)
        || (effectiveRank(card.rank, level) < effectiveRank(Rank.Ace, level)))
      && play.cards.every(card => (held.get(card.rank)?.length || 0) < 4
        || play.cards.filter(c => c.rank === card.rank).length === held.get(card.rank)!.length));
    const equal = natural.filter(p => p.rank === proposed!.rank);
    const replacement = orderCandidates(equal.length ? equal : natural, hand, level, free, context, analysis)[0];
    if (replacement && !materiallyBetterSimulation(proposed, replacement, analysis)) {
      proposed = changed(proposed, replacement, 'opening_resource')!;
    }
  }
  // Compare residual partitions before spending a bomb on a calm free lead,
  // including midgame. Ordinary high groups keep the narrower opening rule.
  const calmBombLead = free && context && isBombPattern(proposed)
    && !context.players.some(player => player.finishRank === null
      && ((player.relation === 'opponent' && player.cardCount <= 5)
        || (player.relation === 'partner' && player.cardCount <= 2)));
  if (opening || calmBombLead) {
    const proposedCost = controlResourceCost(proposed, hand, level);
    const proposedAfter = analysis?.candidates[analysisKey(proposed)]?.remainingTurns;
    if (proposedCost >= 4 && proposedAfter) {
      const protectedIds = isBombPattern(proposed)
        ? new Set(proposed.cards.map(card => card.id)) : undefined;
      const conservesControl = (play: CardPattern) => !isBombPattern(play)
        && (protectedIds || play.cards.length >= proposed!.cards.length)
        && (!protectedIds || play.cards.every(card => !protectedIds.has(card.id)))
        && !play.cards.some(card => isWildCard(card, level) || isJoker(card))
        && controlResourceCost(play, hand, level) <= proposedCost - 4;
      const alternatives = candidates.filter(play => conservesControl(play)
        && analysis?.candidates[analysisKey(play)]?.remainingTurns.turns !== undefined
        && analysis.candidates[analysisKey(play)].remainingTurns.turns <= proposedAfter.turns);
      let replacement = orderCandidates(alternatives, hand, level, true, context, analysis)[0];
      // The shortlist bounds the model prompt. A calm lead can still preserve
      // a bomb if a legal ordinary route was omitted by compression or capping.
      if (!replacement && calmBombLead && fullLeadOptions && analysis?.simulation.samples === 0) {
        const deadline = performance.now() + 30;
        const estimator = createTurnEstimator(hand, fullLeadOptions, deadline);
        const ordinary = fullLeadOptions.filter(play => !isBombPattern(play))
          .sort((a, b) => b.cards.length - a.cards.length);
        for (const play of ordinary) {
          if (performance.now() >= deadline) break;
          if (conservesControl(play) && estimator.after(play).turns <= proposedAfter.turns) {
            replacement = play;
            break;
          }
        }
      }
      if (replacement && !materiallyBetterSimulation(proposed, replacement, analysis)) {
        if (protectedIds) return changed(proposed, replacement, 'opening_resource');
        proposed = changed(proposed, replacement, 'opening_resource')!;
      }
    }
  }
  const leader = context?.players.find(p => p.seatIndex === context.lastPlayPlayerIndex);
  const catchesOpponent = context && leader?.finishRank != null
    && context.players.some(p => p.seatIndex === passPosition(context).nextLead && p.relation === 'opponent');
  const immediateThreat = context?.players.some(p => p.relation === 'opponent'
    && p.finishRank === null && p.cardCount <= 2);
  if (!free && context && analysis?.handTurns.exact && analysis.handTurns.turns === 1
    && !immediateThreat && !catchesOpponent
    && !canContestWithReadyExit(proposed, level, context, analysis)
    && publicControlEvidence(proposed, hand, level, context)?.unbeatable !== true
    && !materiallyBetterSimulation(proposed, null, analysis)) return changed(proposed, null, 'ready_exit');
  const continuation = analysis?.candidates[analysisKey(proposed)]?.continuation;
  // The cost belongs to the actual remaining hand, whether the proposed
  // response spends a bomb whole or consumes its cards as an ordinary group.
  if (!free && last && context && analysis && !catchesOpponent
    && !context.players.some(player => player.finishRank === null
      && ((player.relation === 'opponent' && player.cardCount <= 5)
        || (player.relation === 'partner' && player.cardCount <= 2)))
    && opponentControlStreak(context) < 2
    && !materiallyBetterSimulation(proposed, null, analysis)) {
    if (isBombPattern(proposed) && continuation?.exact && continuation.extraTurns >= 2) {
      return changed(proposed, null, 'bomb_structure');
    }
    const remaining = analysis.candidates[analysisKey(proposed)]?.remainingTurns;
    const forecast = analysis.trickForecast?.[analysisKey(proposed)];
    const pass = analysis.trickForecast?.PASS;
    const exitGain = forecast && pass && (forecast.allyExit - pass.allyExit + pass.enemyExit - forecast.enemyExit >= 0.5);
    if (!isBombPattern(proposed) && resourceCost(hand, proposed, level).broken_natural_bombs.length
      && !(remaining && remaining.turns <= 2) && !exitGain
      && !publicControlEvidence(proposed, hand, level, context)?.unbeatable) {
      const original = proposed;
      const originalCost = controlResourceCost(original, hand, level);
      const intact = candidates.filter(play => !isBombPattern(play)
        && (!remaining?.exact || !analysis.candidates[analysisKey(play)]?.remainingTurns.exact
          || analysis.candidates[analysisKey(play)].remainingTurns.turns <= remaining.turns)
        && !resourceCost(hand, play, level).broken_natural_bombs.length
        && controlResourceCost(play, hand, level) < originalCost
        && !materiallyBetterSimulation(original, play, analysis));
      const replacement = orderCandidates(intact, hand, level, false, context, analysis)[0];
      if (!replacement) return changed(proposed, null, 'bomb_structure');
      proposed = changed(proposed, replacement, 'bomb_structure')!;
    }
  }
  const reportAdjusted = enforceNextPlayerReport(proposed, candidates, level, context, hand);
  if (!reportAdjusted) return null;
  // Reported-count interception is a strong prior, not a legality rule.
  // A paired team-outcome comparison can justify retaining a smaller control.
  if (!materiallyBetterSimulation(proposed, reportAdjusted, analysis)) {
    proposed = changed(proposed, reportAdjusted, 'reported_defence')!;
  }
  const partnerLed = !free && last && context
    && context.lastPlayPlayerIndex === context.partnerSeatIndex;
  if (partnerLed && last) {
    if (!blocksReportedSingle(proposed, last, hand, level, context)
      && !materiallyBetterSimulation(proposed, null, analysis)
      && !productivePartnerTakeover(proposed, hand, generateLegalPlays(hand, level), last, level, context)) {
      return changed(proposed, null, 'partner_cooperation');
    }
  }
  // Compare the actual residual hand across shapes, not just bomb size.
  // A public-card lock preserves the interception, including after a player
  // finishes; rank completion alone must not disable resource conservation.
  if (!free && last && isBombPattern(proposed) && analysis) {
    const bombTurns = analysis.candidates[analysisKey(proposed)]?.remainingTurns;
    const controls = candidates.filter(play => {
      const after = analysis.candidates[analysisKey(play)]?.remainingTurns;
      return !isBombPattern(play) && canBeat(play, last, level)
        && bombTurns?.exact && after?.exact && after.turns < bombTurns.turns
        && publicControlEvidence(play, hand, level, context)?.unbeatable === true
        && !materiallyBetterSimulation(proposed, play, analysis);
    });
    if (controls.length) {
      const control = orderCandidates(controls, hand, level, false, context, analysis)[0];
      // Re-apply partner/report protections to the actual replacement.
      const guarded = enforceTeamStrategy(control, candidates, hand, last, free, level, context, analysis);
      if (guarded && !isBombPattern(guarded)
        && publicControlEvidence(guarded, hand, level, context)?.unbeatable === true) return changed(proposed, guarded, 'proven_control');
    }
  }
  // With only a few low singles left and no recapture card, a higher probe
  // is not equivalent to the smallest lead. Keep the selected probe; do not
  // relax conservation for joker controls, pairs or existing grouped exits.
  if (free && hand.length <= 5 && proposed.type === PatternType.Single
    && effectiveRank(proposed.rank, level) < Rank.Queen
    && hand.every(card => effectiveRank(card.rank, level) < Rank.Queen)
    && !generateLegalPlays(hand, level).some(play => play.cards.length > 1)) return proposed;
  const alternatives = candidates.filter(play => play.cards.length === proposed.cards.length
    && (play.type === proposed.type || (isBombPattern(play) && isBombPattern(proposed)))
    && (canBeat(proposed, play, level)
      || (play.type === PatternType.TriplePair && proposed.type === PatternType.TriplePair
        && play.rank === proposed.rank && play !== proposed))
    && (free || canBeat(play, last, level)));
  const ordered = orderCandidates([...alternatives, proposed], hand, level, free, context, analysis);
  for (const lower of ordered) {
    if (lower === proposed) break;
    const lowerTurns = analysis?.candidates[analysisKey(lower)]?.remainingTurns;
    const proposedTurns = analysis?.candidates[analysisKey(proposed)]?.remainingTurns;
    if (lowerTurns && proposedTurns && lowerTurns.turns > proposedTurns.turns) continue;
    if (rankBombChanges(hand, lower).some(b => !b.playedAsBomb && b.after < 4)
      && !rankBombChanges(hand, proposed).some(b => !b.playedAsBomb && b.after < 4)) continue;
    if (materiallyBetterSimulation(proposed, lower, analysis)
      || blocksReportedSingle(proposed, lower, hand, level, context)
      || (!free && publicControlEvidence(proposed, hand, level, context)?.unbeatable === true
        && publicControlEvidence(lower, hand, level, context)?.unbeatable !== true)) continue;
    // Do not weaken an interception of the partner's trick back into a pass.
    if (partnerLed && last && !blocksReportedSingle(lower, last, hand, level, context)
      && !materiallyBetterSimulation(lower, null, analysis)
      && !productivePartnerTakeover(lower, hand, generateLegalPlays(hand, level), last, level, context)) continue;
    const adjusted = enforceNextPlayerReport(lower, candidates, level, context, hand);
    return changed(proposed, materiallyBetterSimulation(lower, adjusted, analysis) ? lower : adjusted, 'economy');
  }
  return proposed;
}

/** One final comparison for both model replies and fallback, including PASS.
 * Only compare complete paired samples; an unmeasured action keeps its prior.
 * Compare the actual guarded action, so a later preference cannot undo evidence. */
export function finalizeAiDecision(
  proposed: CardPattern | null, candidates: CardPattern[], hand: Card[],
  last: CardPattern | null, free: boolean, level: number,
  context?: AiDecisionContext, analysis?: DecisionAnalysis, ruleFallback?: CardPattern | null,
  onCorrections?: (corrections: AiPolicyCorrection[]) => void,
  fullLeadOptions?: CardPattern[],
): CardPattern | null {
  let recent: AiPolicyCorrection[] = [];
  const guard = (play: CardPattern | null) => {
    recent = [];
    return enforceTeamStrategy(play, candidates, hand, last, free, level, context, analysis,
      onCorrections ? correction => { recent.push(correction); } : undefined, fullLeadOptions);
  };
  let selected = guard(proposed);
  let accepted = recent;
  const complete = () => { onCorrections?.(accepted); return selected; };

  // A model PASS still needs to respect public tempo. Merely having rollout
  // samples is not evidence that passing is better than the actual response.
  // Prefer an intact ordinary response with a real group left to lead; spend
  // bombs only through the local defence policy or a last reported-single stop.
  const leader = context?.players.find(player => player.seatIndex === context.lastPlayPlayerIndex);
  if (!selected && !free && context && last
    && leader?.relation === 'opponent' && leader.finishRank === null) {
    const repeated = opponentControlStreak(context) >= 2;
    const urgent = leader.cardCount <= 2;
    const finishPressure = repeated && leader.cardCount <= 5;
    // Once the opponents have first place, only this leader can complete
    // their double win. Compare replies against that seat's public capacity.
    // Require a secure block which also completes one of our own hand groups.
    const denyingDouble = leader.cardCount <= 5 && context.players.some(player =>
      player.relation === 'opponent' && player.finishRank === 1);
    const secureBlocks = denyingDouble && analysis?.handTurns.exact ? candidates.filter(play => {
      const after = analysis.candidates[analysisKey(play)]?.remainingTurns;
      if (!after?.exact || after.turns >= analysis.handTurns.turns) return false;
      const proof = publicControlEvidence(play, hand, level, context, leader.cardCount);
      return proof && (isBombPattern(play) ? !proof.bombPossible : proof.unbeatable);
    }) : [];
    const secureBlock = secureBlocks.sort((a, b) =>
      controlResourceCost(a, hand, level) - controlResourceCost(b, hand, level))[0];
    const ordinaryContest = leader.cardCount <= 12 && hand.length >= leader.cardCount + 3
      && [PatternType.Single, PatternType.Pair].includes(last.type);
    const partnerHead = context.players.some(player => player.relation === 'partner' && player.finishRank === 1);
    if (secureBlock || repeated || urgent || ordinaryContest || (partnerHead && leader.cardCount <= 5)) {
      const allPlays = generateLegalPlays(hand, level);
      const counts = getRankCounts(hand);
      const ordinary = candidates.filter(play => {
        const continuation = analysis?.candidates[analysisKey(play)]?.continuation;
        // Rank groups are not the whole-hand plan: splitting a pair can leave
        // a straight/full house intact. Allow a measured, bounded cost under
        // immediate pressure, while retaining the normal conservation filter.
        const boundedSplit = urgent && continuation?.exact && continuation.extraTurns <= 2;
        return !isBombPattern(play)
          && (!(ordinaryContest && !repeated && !urgent && !partnerHead) || !play.cards.some(isJoker))
          && play.cards.every(card => !isWildCard(card, level)
            && (boundedSplit || (counts.get(card.rank)?.length || 0)
              === play.cards.filter(c => c.rank === card.rank).length))
          && allPlays.some(group => group.cards.length >= 3
            && group.cards.every(card => !play.cards.some(used => used.id === card.id)));
      });
      const fallback = ruleFallback === undefined ? findBestPlay(hand, last, free, level, context, allPlays) : ruleFallback;
      const readyExitReplies = candidates.filter(play => canContestWithReadyExit(play, level, context, analysis));
      const ordinaryReplies = ordinary.length ? ordinary : readyExitReplies;
      let response: CardPattern | null = secureBlock ?? (ordinaryReplies.length
        ? orderCandidates(ordinaryReplies, hand, level, false, context, analysis, allPlays)[0] : null);
      if (!response && (urgent || partnerHead)) response = fallback;
      if (!response && finishPressure) {
        // An intact ordinary bomb can change the lead shape before a
        // three-to-five-card opponent gets its final lead. Do not dismantle a
        // larger rank group or spend wildcard resources for this prior.
        response = candidates.filter(play => isBombPattern(play)
          && play.cards.every(card => !isWildCard(card, level)
            && play.cards.filter(c => c.rank === card.rank).length === counts.get(card.rank)?.length))
          .sort((a,b) => canBeat(a,b,level) ? 1 : canBeat(b,a,level) ? -1 : 0)[0] || null;
      }
      if (!response && leader.cardCount === 1 && passPosition(context).closesTrick) {
        response = [...candidates].sort((a, b) => canBeat(a, b, level) ? 1 : canBeat(b, a, level) ? -1 : 0)[0] || null;
      }
      if (response && candidates.some(play => analysisKey(play) === analysisKey(response))
        && !reliablyBetterSimulation(analysis?.passSimulation, analysis?.candidates[analysisKey(response)]?.simulation)) {
        const result = guard(response);
        if (result && (response !== secureBlock || result.cards.length === hand.length
          || secureBlocks.some(play => analysisKey(play) === analysisKey(result)))) {
          const rule = secureBlock === response ? 'deny_double_win' : 'urgent_interception';
          accepted = [...accepted, { rule, priority: AI_POLICY_PRIORITY[rule],
            from: policyAction(selected), to: policyAction(response) }, ...recent];
          selected = result;
        }
      }
    }
  }
  if (selected?.cards.length === hand.length || !analysis) return complete();
  const resultOf = (play: CardPattern | null) => play
    ? analysis.candidates[analysisKey(play)]?.simulation : analysis.passSimulation;
  // Reconcile a model's lead with the real residual position before persisting
  // any plan. This finite prior never substitutes a passive action for an
  // interception, a proven lock or a measured superior team outcome.
  if (free && selected && hand.length <= 12
    && publicControlEvidence(selected, hand, level, context)?.unbeatable !== true
    && !analysis.candidates[analysisKey(selected)]?.endgameRoute?.controlProven) {
    const before = analysis.candidates[analysisKey(selected)];
    const canPlanOwnExit = context && !context.players.some(p =>
      p.relation !== 'self' && p.finishRank === null && p.cardCount <= 2);

    const cost = (play: CardPattern) => {
      const value = analysis.candidates[analysisKey(play)];
      return (value?.continuation?.tailControlCost || 0)
        + (value?.replyFinishRisk ? value.replyFinishRisk.rate * 240 : 0);
    };
    const compareExit = canPlanOwnExit && before && !before.endgameRoute && before.remainingTurns.turns >= 2
      && candidates.some(play => analysis.candidates[analysisKey(play)]?.endgameRoute?.sameShapeControl);
    if (before?.remainingTurns.exact && (compareExit || (before.continuation?.tailControlCost || 0) >= 160)) {
      for (const alternative of orderCandidates(candidates, hand, level, free, context, analysis)) {
        const after = analysis.candidates[analysisKey(alternative)];
        const route = after?.endgameRoute;
        const betterExit = compareExit && route?.sameShapeControl && route.exit && route.exit.length > 1
          && after.remainingTurns.turns <= before.remainingTurns.turns && cost(alternative) <= cost(selected);
        if (!after?.remainingTurns.exact || after.remainingTurns.turns > before.remainingTurns.turns + 1
          || (!betterExit && cost(selected) - cost(alternative) < 160)
          || (before.replyFinishRisk && (!after.replyFinishRisk
            || after.replyFinishRisk.rate > before.replyFinishRisk.rate))
          || materiallyBetterSimulation(selected, alternative, analysis)) continue;
        const guarded = guard(alternative);
        // A protection that changes this alternative invalidates the measured
        // continuation. Keep the original decision rather than mix two plans.
        if (!guarded || analysisKey(guarded) !== analysisKey(alternative)) continue;
        accepted = [...accepted, { rule: 'continuation', priority: AI_POLICY_PRIORITY.continuation,
          from: policyAction(selected), to: policyAction(alternative) }, ...recent];
        selected = guarded;
        break;
      }
    }
  }
  // Compare the outcomes of actual guarded actions, not their pre-guard scores.
  // Keep the original baseline fixed: several marginal gains cannot chain into
  // an override, and a corrected action cannot hide a better later alternative.
  const baseline = resultOf(selected);
  const alternatives: Array<CardPattern | null> = [...candidates];
  if (!free) alternatives.push(null);
  for (const alternative of alternatives) {
    if (!reliablyBetterSimulation(resultOf(alternative), baseline)) continue;
    const guarded = guard(alternative);
    const result = resultOf(guarded);
    if (reliablyBetterSimulation(result, baseline)
      && (!resultOf(selected) || result!.meanReward > resultOf(selected)!.meanReward)) {
      accepted = [{ rule: 'paired_outcome', priority: AI_POLICY_PRIORITY.paired_outcome,
        from: policyAction(proposed), to: policyAction(alternative) }, ...recent];
      selected = guarded;
    }
  }
  return complete();
}

export function groundStrategyPlan(
  hand: Card[], allPlays: CardPattern[], executed: CardPattern | null, analysis?: DecisionAnalysis,
): AiStrategyPlan | undefined {
  const used = new Set(executed?.cards.map(c => c.id) || []);
  const remaining = hand.length - used.size;
  if (!remaining) return undefined;
  const available = allPlays.filter(p => p.cards.every(c => !used.has(c.id)));
  const route = analysis?.candidates[executed ? analysisKey(executed) : '']?.endgameRoute;
  const team = analysis?.teamRoutes?.find(r => r.actionKey === (executed ? analysisKey(executed) : null)
    && r.nextLead);
  const shape = route?.recapture || route?.exit || team?.nextLead;
  const next = (shape && available.find(p => p.type === shape.type && p.rank === shape.rank && p.length === shape.length))
    || available.find(p => p.cards.length === remaining);
  return {
    next: next ? `保留的后续候选：${next.type}，声明点数${next.rank}，${next.cards.length}张；须先取得适合牌权`
      : `余牌${remaining}张，重新比较完整组合与回手；尚无已验证的连续收尾路线`,
    reconsiderWhen: '每次公开出牌后重验；对手报牌、名次或牌型变化时重规划，不能假定必能回手',
  };
}

export interface AiDecisionTrace {
  source: 'primary' | 'backup' | 'local' | 'forced';
  routes?: string[];
  model?: string;
  corrected: boolean;
  corrections?: AiPolicyCorrection[];
  trickSamples?: number;
  rankBombChanges?: ReturnType<typeof rankBombChanges>;
  remainingTurns?: DecisionAnalysis['handTurns'];
}

export interface DecisionOptions {
  useModel?: boolean;
  onLocalReady?: (action: CardPattern | null) => void;
}

export async function findSmartPlay(
  hand: Card[],
  lastPattern: CardPattern | null,
  isFreePlay: boolean,
  currentLevel: number,
  context?: AiDecisionContext,
  selection?: AiModelSelection,
  onPlan?: (plan: AiStrategyPlan) => void,
  onDecision?: (trace: AiDecisionTrace) => void,
  options: DecisionOptions = {},
): Promise<CardPattern | null> {
  const allPlays = generateLegalPlays(hand, currentLevel);
  const ruleResult = findBestPlay(hand, lastPattern, isFreePlay, currentLevel, context, allPlays);
  let legalPlays = allPlays;
  if (!isFreePlay && lastPattern) {
    legalPlays = legalPlays.filter(play => canBeat(play, lastPattern, currentLevel));
  }
  legalPlays = dedupeStrategicPlays(removeWastefulWildRealizations(legalPlays, currentLevel));
  if (isFreePlay) legalPlays = pruneOpeningWildLeads(legalPlays, hand, currentLevel, context);
  // Skip strategic analysis only when there is genuinely no choice. During a
  // follow, PASS is also legal and even one playable bomb is a real decision.
  if (isForcedAiDecision(legalPlays.length, isFreePlay)) {
    onDecision?.({ source: 'forced', corrected: false });
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
  const safeRuleResult = ruleResult && legalPlays.some(play => analysisKey(play) === analysisKey(ruleResult))
    ? ruleResult : legalPlays[0] || null;
  const completeCompressed = compressCandidatesForModel(
    orderCandidates(legalPlays, hand, currentLevel, isFreePlay, context, undefined, allPlays),
    currentLevel, allPlays,
  );
  const routeKeys = new Set(buildTeamRoutes(hand, allPlays, completeCompressed.plays,
    isFreePlay ? null : lastPattern, currentLevel, context, {}, generateLegalPlays)
    .flatMap(route => route.actionKey ? [route.actionKey] : []));
  const largeDeal = context && (hand.length > 10 || context.players.reduce((n, seat) => n + seat.cardCount, 0) > 24);
  const earlyForecast = largeDeal ? forecastTrick(hand, completeCompressed.plays, isFreePlay ? null : lastPattern,
    currentLevel, context, generateLegalPlays, performance.now() + 150) : undefined;
  if (earlyForecast && completeCompressed.plays.length > MODEL_ACTION_LIMIT) {
    // Preserve alternatives with observed finish/denial potential before the
    // prompt cap. Local ordering breaks ties between physical realizations.
    const routes = completeCompressed.plays.map(play => ({ play, f: earlyForecast[analysisKey(play)] }));
    for (const goal of ['allyExit', 'enemyExit'] as const) {
      const sorted = [...routes].sort((a,b) => goal === 'allyExit'
        ? b.f.allyExit - a.f.allyExit : a.f.enemyExit - b.f.enemyExit);
      if (sorted[0].f[goal] !== sorted[sorted.length - 1].f[goal]) routeKeys.add(analysisKey(sorted[0].play));
    }
  }
  const compressed = limitModelCandidates(completeCompressed, MODEL_ACTION_LIMIT, routeKeys);
  legalPlays = retainNextPlayerReportMaximum(
    compressed.plays, completeLegalPlays, currentLevel, context,
  );
  let equivalentCounts = legalPlays.map(play => {
    const index = compressed.plays.indexOf(play);
    return index >= 0 ? compressed.equivalentCounts[index] : 1;
  });
  const equivalentCountByPlay = new Map(legalPlays.map((play, index) => [play, equivalentCounts[index]]));
  if (safeRuleResult && !legalPlays.some(play => analysisKey(play) === analysisKey(safeRuleResult))) {
    const replacement = legalPlays.findIndex(play => play.type === safeRuleResult.type && play.rank === safeRuleResult.rank);
    if (replacement >= 0) legalPlays[replacement] = safeRuleResult;
    else legalPlays.push(safeRuleResult);
    equivalentCountByPlay.set(safeRuleResult, 1);
  }
  const handCombinations = isFreePlay ? compressed : limitModelCandidates(compressCandidatesForModel(
    orderCandidates(dedupeStrategicPlays(allPlays), hand, currentLevel, true, context, undefined, allPlays),
    currentLevel,
  ));
  const analysis = await analyzeDecision(
    hand, allPlays, legalPlays, isFreePlay ? null : lastPattern,
    currentLevel, context, findBestPlay, { generateReplies: generateLegalPlays },
  );
  if (context && analysis.simulation.samples < 8) {
    analysis.trickForecast = largeDeal ? earlyForecast : forecastTrick(hand, legalPlays, isFreePlay ? null : lastPattern,
      currentLevel, context, generateLegalPlays, performance.now() + 150);
  }
  legalPlays = orderCandidates(legalPlays, hand, currentLevel, isFreePlay, context, analysis, allPlays);
  equivalentCounts = legalPlays.map(play => equivalentCountByPlay.get(play) || 1);
  const fallbackResult = (isFreePlay || ruleResult) ? legalPlays[0] || ruleResult : null;
  let corrections: AiPolicyCorrection[] = [];
  const routeGoals = (play: CardPattern | null) => (analysis.teamRoutes || [])
    .filter(route => route.actionKey === (play ? analysisKey(play) : null)).map(route => route.goal);
  const key = (p: CardPattern | null) => p ? analysisKey(p) : 'PASS';
  const executedEvidence = (play: CardPattern | null) => ({
    rankBombChanges: play ? rankBombChanges(hand, play) : undefined,
    remainingTurns: play ? analysis.candidates[key(play)]?.remainingTurns : analysis.handTurns,
  });
  const finalize = (play: CardPattern | null) => finalizeAiDecision(play, legalPlays, hand, lastPattern,
    isFreePlay, currentLevel, context, analysis, ruleResult, notes => { corrections = notes; },
    isFreePlay ? allPlays : undefined);
  const teamProspect = (p: CardPattern | null) => {
    const f = analysis.trickForecast?.[key(p)];
    if (!f) return -Infinity;
    const partner = context?.players.find(seat => seat.relation === 'partner');
    return 3 * (f.allyExit - f.enemyExit) + f.teamAhead
      + (partner && partner.cardCount > 0 && partner.cardCount <= 5 ? 0.5 * f.partnerAhead : 0);
  };
  const value = (p: CardPattern | null) => {
    const turns = p ? analysis.candidates[key(p)]?.remainingTurns.turns : analysis.handTurns.turns;
    if (turns === undefined) return -Infinity;
    return teamProspect(p) - 0.6 * turns - (p ? 0.1 * controlResourceCost(p, hand, currentLevel) : 0);
  };
  // A one-cycle model is strongest on observable near-term consequences.
  // Changing only the predicted trick leader is insufficient evidence to
  // dismantle a better partition or spend another control resource.
  const improvesRoute = (before: CardPattern | null, after: CardPattern | null) => {
    const a = analysis.trickForecast?.[key(before)], b = analysis.trickForecast?.[key(after)];
    if (!a || !b) return false;
    if (b.allyExit - a.allyExit + a.enemyExit - b.enemyExit >= 0.5) return true;
    const remaining = (p: CardPattern | null) => p ? analysis.candidates[key(p)]?.remainingTurns : analysis.handTurns;
    const left = remaining(before), right = remaining(after);
    const cost = (p: CardPattern | null) => p ? controlResourceCost(p, hand, currentLevel) : 0;
    return !!left?.exact && !!right?.exact && right.turns <= left.turns && cost(after) <= cost(before)
      && b.teamAhead === 1 && a.teamAhead <= 0.25 && b.enemyExit <= a.enemyExit;
  };
  const pool: Array<CardPattern | null> = isFreePlay ? [...legalPlays] : [...legalPlays, null];
  const challenger = analysis.trickForecast && pool.sort((a,b) => value(b) - value(a))[0];
  const decide = (proposal: CardPattern | null) => {
    const accepted = finalize(proposal);
    if (accepted?.cards.length === hand.length || challenger === undefined
      || !Number.isFinite(value(accepted)) || value(challenger) < value(accepted) + 0.8) return accepted;
    const notes = corrections;
    const alternative = finalize(challenger);
    if (value(alternative) >= value(accepted) + 0.8
      && teamProspect(alternative) >= teamProspect(accepted) + 0.5 && improvesRoute(accepted, alternative)) {
      corrections = [...notes, { rule: 'team_trick', priority: AI_POLICY_PRIORITY.team_trick,
        from: policyAction(accepted), to: policyAction(alternative) }];
      return alternative;
    }
    corrections = notes;
    return accepted;
  };
  const local = decide(fallbackResult);
  const localNotes = corrections;
  options.onLocalReady?.(local);

  // Compare the two actions that would actually be played, including PASS.
  // Full-game evidence takes precedence over a one-cycle estimate. When the
  // estimates are close the model retains discretion about the route.
  const localOverride = (modelPlay: CardPattern | null): AiPolicyCorrection['rule'] | undefined => {
    if (!context || key(local) === key(modelPlay) || modelPlay?.cards.length === hand.length) return;
    const result = (p: CardPattern | null) => p ? analysis.candidates[key(p)]?.simulation : analysis.passSimulation;
    if (reliablyBetterSimulation(result(modelPlay), result(local))) return;
    if (reliablyBetterSimulation(result(local), result(modelPlay))) return 'team_baseline';
    const entry = modelPlay && analysis.candidates[key(modelPlay)];
    if (entry?.endgameRoute?.controlProven) return;
    if (!modelPlay && local && !isFreePlay && lastPattern) {
      const position = passPosition(context, lastPattern);
      const next = context.players.find(p => p.seatIndex === position.nextLead);
      if (!position.partnerMayRespond && next?.relation === 'opponent' && next.cardCount <= 5
        && next.finishRank === null) return 'last_defender';
    }
    const localTurns = local && analysis.candidates[key(local)]?.remainingTurns;
    const modelTurns = entry?.remainingTurns;
    const savedControl = local && modelPlay
      ? controlResourceCost(modelPlay, hand, currentLevel) - controlResourceCost(local, hand, currentLevel) : 0;
    const betterPartition = localTurns?.exact && modelTurns?.exact && localTurns.turns < modelTurns.turns && savedControl >= 0;
    // In a quiet lead, an expensive extra turn needs a concrete tactical purpose.
    if (betterPartition && modelPlay && isFreePlay && savedControl > 0
      && analysis.handTurns.exact && modelTurns.turns >= analysis.handTurns.turns
      && !context.players.some(p => p.relation !== 'self' && p.finishRank === null && p.cardCount <= 5)
      && publicControlEvidence(modelPlay, hand, currentLevel, context)?.unbeatable !== true) return 'continuation';
    const localValue = value(local), modelValue = value(modelPlay);
    if (Number.isFinite(localValue) && Number.isFinite(modelValue)) {
      return localValue >= modelValue + 0.8 && teamProspect(local) >= teamProspect(modelPlay) ? 'team_baseline' : undefined;
    }
    // Without shared tactical evidence, only count an exact partition loss;
    // never equate missing simulation data with a zero win rate.
    return betterPartition ? 'team_baseline' : undefined;
  };

  const primary = normalizeAiSelection(
    (selection ?? DEFAULT_AI_SELECTION).provider, (selection ?? DEFAULT_AI_SELECTION).model,
  );
  const models = [primary, { provider: 'fueternal' as const, model: HW_AI_MODEL },
    { provider: 'local' as const, model: LOCAL_AI_MODEL }, normalizeAiSelection('deepseek', '')]
    .filter((model, index, all) => all.findIndex(other => other.provider === model.provider) === index);
  // Three 20s attempts fit inside the 90s turn watchdog.
  for (const model of options.useModel === false ? [] : models) {
    try {
      const llmResult = await llmFindBestPlay(
        hand,
        legalPlays,
        lastPattern,
        isFreePlay,
        currentLevel,
        context,
        model,
        analysis,
        equivalentCounts,
        handCombinations.plays,
        handCombinations.equivalentCounts,
        undefined,
      );
      // undefined means the model was unavailable/invalid; null is an intentional pass.
      if (llmResult !== undefined) {
        let final = decide(llmResult);
        const override = localOverride(final);
        if (override) {
          corrections = [...corrections, { rule: override, priority: AI_POLICY_PRIORITY[override],
            from: policyAction(final), to: policyAction(local) }];
          final = local;
        }
        // Rebuild from the executed action even when a guard changed it or the
        // model omitted a plan. Model prose is never evidence of retained cards.
        const grounded = groundStrategyPlan(hand, allPlays, final, analysis);
        if (grounded) onPlan?.(grounded);
        onDecision?.({ ...executedEvidence(final), source: model === primary ? 'primary' : 'backup', model: model.model, routes: routeGoals(final), corrections,
          trickSamples: analysis.trickForecast?.[key(final)]?.samples,
          corrected: (final ? analysisKey(final) : 'PASS') !== (llmResult ? analysisKey(llmResult) : 'PASS') });
        return final;
      }
    } catch {}
  }

  const final = local;
  corrections = localNotes;
  const grounded = groundStrategyPlan(hand, allPlays, final, analysis);
  if (grounded) onPlan?.(grounded);
  onDecision?.({ ...executedEvidence(final), source: 'local', routes: routeGoals(final), corrections,
    trickSamples: analysis.trickForecast?.[key(final)]?.samples, corrected:
    (final ? analysisKey(final) : 'PASS') !== (fallbackResult ? analysisKey(fallbackResult) : 'PASS') });
  return final;
}

export function isForcedAiDecision(playableCount: number, isFreePlay: boolean): boolean {
  return playableCount === 0 || (isFreePlay && playableCount === 1);
}

/** Every non-forced decision deserves analysis, including one response vs PASS. */
export function shouldUseLlmForDecision(
  _hand: Card[], legalPlays: CardPattern[], _lastPattern: CardPattern | null,
  isFreePlay: boolean, _currentLevel: number, _context?: AiDecisionContext,
): boolean {
  return !isForcedAiDecision(legalPlays.length, isFreePlay);
}
