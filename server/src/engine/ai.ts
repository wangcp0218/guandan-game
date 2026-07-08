import { Card, CardPattern, PatternType, Rank, Suit } from '../../../shared/types';
import { effectiveRank, sortCards, isJoker } from './card';
import {
  identifyPattern, isBomb, isKingBomb, isFlushStraight,
  isStraight, isConsecutivePair, isPlane, isPlaneWings,
  isTriplePair,
} from './patterns';
import { canBeat, isBombPattern } from './compare';
import { llmFindBestPlay } from './llmAi';

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

function generateStraights(hand: Card[]): Card[][] {
  const result: Card[][] = [];
  const rankSet = new Set<number>();
  for (const c of hand) {
    if (c.rank !== Rank.Two && !isJoker(c)) {
      rankSet.add(c.rank);
    }
  }
  const ranks = Array.from(rankSet).sort((a, b) => a - b);

  for (let start = 0; start < ranks.length; start++) {
    let end = start;
    while (end + 1 < ranks.length && ranks[end + 1] === ranks[end] + 1) {
      end++;
    }
    const len = end - start + 1;
    if (len >= 5) {
      for (let l = 5; l <= len; l++) {
        const straightRanks = ranks.slice(start, start + l);
        const cards: Card[] = [];
        for (const r of straightRanks) {
          const c = hand.find(x => x.rank === r && !cards.includes(x));
          if (c) cards.push(c);
        }
        if (cards.length === l) result.push(cards);
      }
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

  allCombos.push(...generateSingles(hand));
  allCombos.push(...generatePairs(rankCounts));
  allCombos.push(...generateTriples(rankCounts));
  allCombos.push(...generateTriplePairs(rankCounts, hand));
  allCombos.push(...generateBombs(rankCounts));
  allCombos.push(...generateStraights(hand));

  for (const combo of allCombos) {
    if (isKingBomb(combo)) {
      allCombos.push(combo);
    }
    if (isFlushStraight(combo)) {
      allCombos.push(combo);
    }
  }

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

  const sorted = [...hand].sort((a, b) => a.rank - b.rank);

  if (isFreePlay || !lastPattern) {
    const singles = legalPlays.filter(p => p.type === PatternType.Single && !isJoker(p.cards[0]));
    if (singles.length > 0) {
      const minSingle = singles.reduce((a, b) =>
        a.cards[0].rank < b.cards[0].rank ? a : b
      );
      return minSingle;
    }

    const pairs = legalPlays.filter(p => p.type === PatternType.Pair && p.rank < Rank.SmallJoker);
    if (pairs.length > 0) {
      return pairs.reduce((a, b) => a.rank < b.rank ? a : b);
    }
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
  currentLevel: number
): Promise<CardPattern | null> {
  const ruleResult = findBestPlay(hand, lastPattern, isFreePlay, currentLevel);

  try {
    const llmResult = await llmFindBestPlay(hand, lastPattern, isFreePlay, currentLevel);
    if (llmResult) return llmResult;
  } catch {}

  return ruleResult;
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
