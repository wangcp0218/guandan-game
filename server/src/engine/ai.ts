import { AiModelSelection, Card, CardPattern, PatternType, Rank, Suit } from '../../../shared/types';
import { effectiveRank, isJoker } from './card';
import {
  isWildCard,
} from './patterns';
import { canBeat, isBombPattern } from './compare';
import { llmFindBestPlay } from './llmAi';
import type { AiDecisionContext } from './llmAi';

const MAX_LLM_CANDIDATES = 160;

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

  // A leading single should spend the least valuable ordinary card. Keeping the
  // candidate set this way prevents an LLM from opening with a joker or level
  // card while a normal single is still available.
  if (isFreePlay && hand.length > 1) {
    const ordinarySingles = guarded.filter(play =>
      play.type === PatternType.Single
      && !isJoker(play.cards[0])
      && !isWildCard(play.cards[0], currentLevel)
    );
    if (ordinarySingles.length > 0) {
      const rankCounts = getRankCounts(hand);
      const loneSingles = ordinarySingles.filter(play =>
        (rankCounts.get(play.cards[0].rank)?.length || 0) === 1
      );
      const preferredSingles = loneSingles.length > 0 ? loneSingles : ordinarySingles;
      const lowestRank = Math.min(...preferredSingles.map(play =>
        effectiveRank(play.cards[0].rank, currentLevel)
      ));
      const allowedSingleKeys = new Set(preferredSingles
        .filter(play => effectiveRank(play.cards[0].rank, currentLevel) === lowestRank)
        .map(strategicPlayKey));
      guarded = guarded.filter(play =>
        play.type !== PatternType.Single || allowedSingleKeys.has(strategicPlayKey(play))
      );
    }
  }

  // Never spend a bomb to overtake the partner unless it immediately empties the hand.
  const partnerLed = context
    && context.lastPlayPlayerIndex >= 0
    && context.lastPlayPlayerIndex === context.partnerSeatIndex;
  if (partnerLed) {
    guarded = guarded.filter(play => !isBombPattern(play) || play.cards.length === hand.length);
  }

  return guarded;
}

/** Base7-inspired value: prefer shedding groups while preserving controls and structures. */
function scorePlay(
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

  let score = play.cards.length * 120 - effectiveRank(play.rank, currentLevel) * 2;
  if (play.cards.length > 1) score += 100;
  if ([PatternType.Straight, PatternType.TriplePair, PatternType.ConsecutivePair, PatternType.Plane].includes(play.type)) {
    score += 100;
  }

  // A card which belongs to a bomb/king bomb/flush straight or is a wildcard
  // has high option value. Penalise partial destruction, not playing it whole.
  for (const [rank, selected] of playedCounts) {
    const held = handCounts.get(rank)?.length || 0;
    if (held >= 4 && selected.length < held) score -= 650;
    else if (held === 3 && selected.length < held) score -= 80;
    else if (held === 2 && selected.length === 1) score -= 45;
  }
  if (!isBombPattern(play)) {
    score -= play.cards.filter(card => isWildCard(card, currentLevel)).length * 260;
    score -= play.cards.filter(isJoker).length * 100;
    score -= play.cards.filter(card => protectedCardIds.has(card.id)).length * 90;
  }

  if (isBombPattern(play)) {
    // Taking the trick with a bomb has the same immediate benefit regardless
    // of size. Cancel the generic shedding bonus and charge for bomb strength;
    // whole-hand finishes still take priority above. Keep leading costs finite
    // so intact bombs beat dismantling the only remaining structures.
    const tier = play.type === PatternType.KingBomb ? 8
      : play.type === PatternType.FlushStraight ? 1.5 : play.cards.length - 4;
    score -= play.cards.length * 120 + 100 + tier * 140;
    if (partnerLed) score -= 20_000;
    if (opponentLed && lastPlayer && lastPlayer.cardCount <= 14) score += 650;
    if (urgentOpponent) score += 600;
  }

  if (!isFreePlay && !isBombPattern(play)) score += 350;
  if (partnerLed) score -= 15_000;

  if (isFreePlay && context) {
    const partner = context.players.find(player => player.relation === 'partner' && player.finishRank === null);
    const opponents = context.players.filter(player => player.relation === 'opponent' && player.finishRank === null);
    if (partner?.cardCount === play.cards.length) score += 900;
    if (opponents.some(player => player.cardCount === play.cards.length)) score -= 350;
  }

  // Prefer the weakest physical realization when declarations are equivalent.
  score -= play.cards.reduce((sum, card) => sum + effectiveRank(card.rank, currentLevel), 0) / 20;
  return score;
}

function orderCandidates(
  plays: CardPattern[],
  hand: Card[],
  currentLevel: number,
  isFreePlay: boolean,
  context?: AiDecisionContext,
): CardPattern[] {
  const protectedCardIds = new Set(plays
    .filter(play => play.type === PatternType.FlushStraight || play.type === PatternType.KingBomb)
    .flatMap(play => play.cards.map(card => card.id)));
  const scores = new Map(plays.map(play => [
    play,
    scorePlay(play, hand, currentLevel, isFreePlay, context, protectedCardIds),
  ]));
  return [...plays].sort((a, b) => scores.get(b)! - scores.get(a)!);
}

export function findBestPlay(
  hand: Card[],
  lastPattern: CardPattern | null,
  isFreePlay: boolean,
  currentLevel: number,
  context?: AiDecisionContext,
): CardPattern | null {
  let legalPlays = generateLegalPlays(hand, currentLevel);

  if (!isFreePlay && lastPattern) {
    legalPlays = legalPlays.filter(p => canBeat(p, lastPattern, currentLevel));
  }

  if (legalPlays.length === 0) return null;
  legalPlays = dedupeStrategicPlays(legalPlays);
  const ordered = orderCandidates(legalPlays, hand, currentLevel, isFreePlay, context);
  if (!isFreePlay && context) {
    const lastPlayer = context.players.find(player => player.seatIndex === context.lastPlayPlayerIndex);
    const passScore = lastPlayer?.relation === 'partner'
      ? 100_000
      : lastPlayer?.cardCount !== undefined && lastPlayer.cardCount <= 3 ? -10_000 : 0;
    if (scorePlay(ordered[0], hand, currentLevel, false, context) <= passScore) return null;
  }
  return ordered[0] || null;
}

export function findBestTribute(hand: Card[], currentLevel: number): Card {
  let best = hand[0];
  let bestScore = Infinity;

  for (const c of hand) {
    let score = c.rank * 10;
    if (isJoker(c)) score += 1000;
    if (c.rank === (currentLevel as Rank)) score += 500;
    if (c.rank >= Rank.Ace) score += 100;

    const rankCount = hand.filter(h => h.rank === c.rank).length;
    if (rankCount >= 3) score += 200;
    if (rankCount === 1) score -= 50;

    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }

  return best;
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
  let legalPlays = generateLegalPlays(hand, currentLevel);
  if (!isFreePlay && lastPattern) {
    legalPlays = legalPlays.filter(play => canBeat(play, lastPattern, currentLevel));
  }
  legalPlays = dedupeStrategicPlays(legalPlays);
  legalPlays = applyStrategicGuards(legalPlays, hand, currentLevel, isFreePlay, context);
  // The hint system keeps the exhaustive list. The LLM receives the strongest
  // Base7-ranked slice so a combinatorial hand cannot overflow its context.
  legalPlays = orderCandidates(legalPlays, hand, currentLevel, isFreePlay, context)
    .slice(0, MAX_LLM_CANDIDATES);

  const guardedRuleResult = ruleResult && legalPlays.some(play =>
    strategicPlayKey(play) === strategicPlayKey(ruleResult)
  ) ? ruleResult : null;
  const fallbackResult = guardedRuleResult
    || ruleResult
    || (isFreePlay ? legalPlays[0] || null : null);

  try {
    const llmResult = await llmFindBestPlay(
      hand,
      legalPlays,
      lastPattern,
      isFreePlay,
      currentLevel,
      context,
      selection,
    );
    // undefined means the model was unavailable/invalid; null is an intentional pass.
    if (llmResult !== undefined) return llmResult;
  } catch {}

  return fallbackResult;
}

export function findBestReturnTribute(hand: Card[]): Card {
  let best = hand[0];
  let bestScore = 0;

  for (const c of hand) {
    let score = c.rank * 10;
    if (isJoker(c)) score -= 1000;

    const rankCount = hand.filter(h => h.rank === c.rank).length;
    if (rankCount === 1) score += 100;
    if (rankCount >= 4) score -= 200;

    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  return best;
}
