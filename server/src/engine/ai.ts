import { AiModelSelection, Card, CardPattern, PatternType, Rank, Suit } from '../../../shared/types';
import { effectiveRank, sortCards, isJoker } from './card';
import {
  identifyPattern, isBomb, isKingBomb, isFlushStraight,
  isStraight, isConsecutivePair, isPlane,
  isTriplePair, isWildCard,
} from './patterns';
import { canBeat, isBombPattern } from './compare';
import { llmFindBestPlay } from './llmAi';
import type { AiDecisionContext } from './llmAi';

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

function generatePairs(rankCounts: Map<number, Card[]>): Card[][] {
  const result: Card[][] = [];
  for (const [rank, cards] of rankCounts) {
    if (cards.length >= 2) {
      result.push(cards.slice(0, 2));
    }
  }
  return result;
}

function generateTriples(rankCounts: Map<number, Card[]>): Card[][] {
  const result: Card[][] = [];
  for (const [rank, cards] of rankCounts) {
    if (cards.length >= 3) {
      result.push(cards.slice(0, 3));
    }
  }
  return result;
}

function generateTriplePairs(rankCounts: Map<number, Card[]>, hand: Card[]): Card[][] {
  const result: Card[][] = [];
  const triples = Array.from(rankCounts.entries()).filter(([, cs]) => cs.length >= 3);
  const pairs = Array.from(rankCounts.entries()).filter(([, cs]) => cs.length >= 2);

  for (const [tRank, tCards] of triples) {
    for (const [pRank, pCards] of pairs) {
      if (tRank !== pRank) {
        result.push([...tCards.slice(0, 3), ...pCards.slice(0, 2)]);
      } else if (tCards.length >= 5) {
        result.push([...tCards.slice(0, 3), ...tCards.slice(3, 5)]);
      }
    }
  }
  return result;
}

function buildRankRuns(minLength: number): Rank[][] {
  const runs: Rank[][] = [];
  for (let start = 1; start <= Rank.Ace - minLength + 1; start++) {
    for (let length = minLength; start + length - 1 <= Rank.Ace; length++) {
      runs.push(Array.from({ length }, (_, index) => {
        const value = start + index;
        return value === 1 ? Rank.Ace : value as Rank;
      }));
    }
  }
  return runs;
}

function generateStraights(hand: Card[]): Card[][] {
  const result: Card[][] = [];
  const rankCounts = getRankCounts(hand);
  for (const run of buildRankRuns(5)) {
    if (run.every(rank => (rankCounts.get(rank)?.length || 0) > 0)) {
      result.push(run.map(rank => rankCounts.get(rank)![0]));
    }
  }
  return result;
}

function generateConsecutivePairs(rankCounts: Map<number, Card[]>): Card[][] {
  const result: Card[][] = [];
  for (const run of buildRankRuns(3).filter(candidate => candidate.length === 3)) {
    if (run.every(rank => (rankCounts.get(rank)?.length || 0) >= 2)) {
      result.push(run.flatMap(rank => rankCounts.get(rank)!.slice(0, 2)));
    }
  }
  return result;
}

function generatePlanes(rankCounts: Map<number, Card[]>): Card[][] {
  const result: Card[][] = [];
  for (const run of buildRankRuns(2).filter(run => run.length === 2)) {
    if (run.every(rank => (rankCounts.get(rank)?.length || 0) >= 3)) {
      result.push(run.flatMap(rank => rankCounts.get(rank)!.slice(0, 3)));
    }
  }
  return result;
}


function generateBombs(rankCounts: Map<number, Card[]>): Card[][] {
  const result: Card[][] = [];
  for (const [rank, cards] of rankCounts) {
    if (cards.length >= 4) {
      for (let n = 4; n <= cards.length; n++) {
        result.push(cards.slice(0, n));
      }
    }
  }

  const allCards = Array.from(rankCounts.values()).flat();
  const jokers = allCards.filter(c => isJoker(c));
  if (jokers.length >= 4) {
    for (let n = 4; n <= jokers.length; n += 2) {
      result.push(jokers.slice(0, n));
    }
    result.push(jokers.slice(0, 4));
  }
  return result;
}

export function generateLegalPlays(
  hand: Card[],
  currentLevel: number
): CardPattern[] {
  const rankCounts = getRankCounts(hand);
  const allCombos: Card[][] = [];
  const wilds = hand.filter(card => isWildCard(card, currentLevel));
  for (const [rank, group] of rankCounts) {
    if (rank > Rank.Ace || rank === currentLevel) continue;
    for (let count = 1; count <= wilds.length; count++) {
      for (let natural = 2; natural <= group.length; natural++) {
        if (natural + count >= 4) allCombos.push([...group.slice(0, natural), ...wilds.slice(0, count)]);
      }
    }
  }

  allCombos.push(...generateSingles(hand));
  allCombos.push(...generatePairs(rankCounts));
  allCombos.push(...generateTriples(rankCounts));
  allCombos.push(...generateTriplePairs(rankCounts, hand));
  allCombos.push(...generateConsecutivePairs(rankCounts));
  allCombos.push(...generatePlanes(rankCounts));
  allCombos.push(...generateBombs(rankCounts));
  allCombos.push(...generateStraights(hand));

  const extra: Card[][] = [];
  for (const combo of allCombos) {
    if (isKingBomb(combo)) {
      extra.push(combo);
    }
    if (isFlushStraight(combo)) {
      extra.push(combo);
    }
  }
  allCombos.push(...extra);

  const patterns: CardPattern[] = [];
  const seen = new Set<string>();

  for (const combo of allCombos) {
    const pattern = identifyPattern(combo, currentLevel);
    if (pattern) {
      const key = `${pattern.type}_${combo.map(c => c.id).sort().join(',')}`;
      if (!seen.has(key)) {
        seen.add(key);
        patterns.push(pattern);
      }
    }
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

function chooseGuardedFreePlayFallback(
  plays: CardPattern[],
  hand: Card[],
  currentLevel: number,
): CardPattern | null {
  const handCounts = getRankCounts(hand);
  const doesNotBreakBomb = (play: CardPattern) => {
    const playedCounts = getRankCounts(play.cards);
    return Array.from(playedCounts.entries()).every(([rank, cards]) => {
      const heldCount = handCounts.get(rank)?.length || 0;
      return heldCount < 4 || cards.length === heldCount;
    });
  };
  const combinations = plays.filter(play =>
    play.cards.length > 1 && !isBombPattern(play) && doesNotBreakBomb(play)
  );
  if (combinations.length > 0) {
    return combinations.reduce((best, play) => {
      if (play.cards.length !== best.cards.length) {
        return play.cards.length > best.cards.length ? play : best;
      }
      return effectiveRank(play.rank, currentLevel) < effectiveRank(best.rank, currentLevel)
        ? play
        : best;
    });
  }

  const singles = plays.filter(play =>
    play.type === PatternType.Single && !isJoker(play.cards[0])
  );
  if (singles.length > 0) {
    return singles.reduce((best, play) =>
      effectiveRank(play.cards[0].rank, currentLevel) < effectiveRank(best.cards[0].rank, currentLevel)
        ? play
        : best
    );
  }

  const nonBombs = plays.filter(play => !isBombPattern(play));
  if (nonBombs.length > 0) {
    return nonBombs.reduce((best, play) => play.cards.length > best.cards.length ? play : best);
  }
  return plays[0] || null;
}

function orderFreePlayCandidates(
  plays: CardPattern[],
  hand: Card[],
  currentLevel: number,
): CardPattern[] {
  const handCounts = getRankCounts(hand);
  const score = (play: CardPattern) => {
    if (play.cards.length === hand.length) return 100_000;
    if (isBombPattern(play)) return 0;
    const playedCounts = getRankCounts(play.cards);
    const breaksBomb = Array.from(playedCounts.entries()).some(([rank, cards]) => {
      const heldCount = handCounts.get(rank)?.length || 0;
      return heldCount >= 4 && cards.length < heldCount;
    });
    if (play.cards.length > 1) {
      return (breaksBomb ? 2_000 : 10_000) + play.cards.length * 100
        - effectiveRank(play.rank, currentLevel);
    }
    return 1_000 - effectiveRank(play.cards[0].rank, currentLevel);
  };
  return [...plays].sort((a, b) => score(b) - score(a));
}

export function findBestPlay(
  hand: Card[],
  lastPattern: CardPattern | null,
  isFreePlay: boolean,
  currentLevel: number
): CardPattern | null {
  let legalPlays = generateLegalPlays(hand, currentLevel);

  if (!isFreePlay && lastPattern) {
    legalPlays = legalPlays.filter(p => canBeat(p, lastPattern, currentLevel));
  }

  if (legalPlays.length === 0) return null;

  if (isFreePlay || !lastPattern) {
    return chooseGuardedFreePlayFallback(legalPlays, hand, currentLevel);
  }

  if (!isFreePlay && lastPattern) {
    const sameType = legalPlays.filter(p =>
      p.type === lastPattern.type && p.length === lastPattern.length && !isBombPattern(p)
    );
    if (sameType.length > 0) {
      return sameType.reduce((a, b) => a.rank < b.rank ? a : b);
    }

    const smallBombs = legalPlays.filter(p => isBombPattern(p) && p.type !== PatternType.KingBomb);
    if (smallBombs.length > 0) {
      return smallBombs.reduce((a, b) => a.rank < b.rank ? a : b);
    }
  }

  return legalPlays.reduce((a, b) => {
    if (isBombPattern(a) && !isBombPattern(b)) return a;
    if (!isBombPattern(a) && isBombPattern(b)) return b;
    return a.cards.length < b.cards.length ? a : b;
  });
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
  const ruleResult = findBestPlay(hand, lastPattern, isFreePlay, currentLevel);
  let legalPlays = generateLegalPlays(hand, currentLevel);
  if (!isFreePlay && lastPattern) {
    legalPlays = legalPlays.filter(play => canBeat(play, lastPattern, currentLevel));
  }
  legalPlays = dedupeStrategicPlays(legalPlays);
  legalPlays = applyStrategicGuards(legalPlays, hand, currentLevel, isFreePlay, context);
  if (isFreePlay) {
    legalPlays = orderFreePlayCandidates(legalPlays, hand, currentLevel);
  }

  const guardedRuleResult = ruleResult && legalPlays.some(play =>
    strategicPlayKey(play) === strategicPlayKey(ruleResult)
  ) ? ruleResult : null;
  const fallbackResult = guardedRuleResult
    || (isFreePlay ? chooseGuardedFreePlayFallback(legalPlays, hand, currentLevel) : null);

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
