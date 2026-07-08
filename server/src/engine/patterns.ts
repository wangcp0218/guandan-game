import { Card, Suit, Rank, CardPattern, PatternType } from '../../../shared/types';
import { effectiveRank, isJoker } from './card';

export { CardPattern, PatternType, Suit, Rank };

export function isSingle(cards: Card[]): boolean {
  return cards.length === 1;
}

export function isPair(cards: Card[]): boolean {
  return cards.length === 2 && cards[0].rank === cards[1].rank;
}

export function isTriple(cards: Card[]): boolean {
  return cards.length === 3
    && cards[0].rank === cards[1].rank
    && cards[1].rank === cards[2].rank;
}

export function isTriplePair(cards: Card[]): boolean {
  if (cards.length !== 5) return false;
  const ranks = cards.map(c => c.rank).sort((a, b) => a - b);
  const countMap = new Map<number, number>();
  for (const r of ranks) countMap.set(r, (countMap.get(r) || 0) + 1);
  let triple: number | null = null;
  let pair: number | null = null;
  for (const [rank, count] of countMap) {
    if (count === 3) {
      if (triple !== null) return false;
      triple = rank;
    } else if (count === 2) {
      if (pair !== null) return false;
      pair = rank;
    } else return false;
  }
  return triple !== null && pair !== null;
}

export function isStraight(cards: Card[]): boolean {
  if (cards.length < 5) return false;
  for (const c of cards) {
    if (c.rank === Rank.Two || isJoker(c)) return false;
  }
  const sorted = [...cards].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].rank !== sorted[i - 1].rank + 1) return false;
  }
  return true;
}

export function isConsecutivePair(cards: Card[]): boolean {
  if (cards.length < 6 || cards.length % 2 !== 0) return false;
  const pairCount = cards.length / 2;
  if (pairCount < 3) return false;

  for (const c of cards) {
    if (c.rank === Rank.Two || isJoker(c)) return false;
  }

  const rankCount = new Map<number, number>();
  for (const c of cards) {
    rankCount.set(c.rank, (rankCount.get(c.rank) || 0) + 1);
  }

  const ranks: number[] = [];
  for (const [rank, count] of rankCount) {
    if (count !== 2) return false;
    ranks.push(rank);
  }

  if (ranks.length !== pairCount) return false;
  ranks.sort((a, b) => a - b);
  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i] !== ranks[i - 1] + 1) return false;
  }
  return true;
}

export function isPlane(cards: Card[]): boolean {
  if (cards.length < 6 || cards.length % 3 !== 0) return false;
  const tripleCount = cards.length / 3;
  if (tripleCount < 2) return false;

  for (const c of cards) {
    if (c.rank === Rank.Two || isJoker(c)) return false;
  }

  const rankCount = new Map<number, number>();
  for (const c of cards) {
    rankCount.set(c.rank, (rankCount.get(c.rank) || 0) + 1);
  }

  const triples: number[] = [];
  for (const [rank, count] of rankCount) {
    if (count !== 3) return false;
    triples.push(rank);
  }

  if (triples.length !== tripleCount) return false;
  triples.sort((a, b) => a - b);
  for (let i = 1; i < triples.length; i++) {
    if (triples[i] !== triples[i - 1] + 1) return false;
  }
  return true;
}

export function isPlaneWings(cards: Card[]): boolean {
  const tripleCount = Math.floor(cards.length / 5);
  if (cards.length < 10 || cards.length % 5 !== 0) return false;
  if (tripleCount < 2) return false;

  for (const c of cards) {
    if (c.rank === Rank.Two || isJoker(c)) return false;
  }

  const rankCount = new Map<number, number>();
  for (const c of cards) {
    rankCount.set(c.rank, (rankCount.get(c.rank) || 0) + 1);
  }

  const triples: number[] = [];
  const pairs: number[] = [];

  for (const [rank, count] of rankCount) {
    if (count === 3) triples.push(rank);
    else if (count === 2) pairs.push(rank);
    else return false;
  }

  if (triples.length !== tripleCount || pairs.length !== tripleCount) return false;

  triples.sort((a, b) => a - b);
  for (let i = 1; i < triples.length; i++) {
    if (triples[i] !== triples[i - 1] + 1) return false;
  }
  return true;
}

export function isBomb(cards: Card[]): boolean {
  if (cards.length < 4 || cards.length > 8) return false;
  const rank = cards[0].rank;
  return cards.every(c => c.rank === rank);
}

export function isKingBomb(cards: Card[]): boolean {
  if (cards.length !== 4) return false;
  const jokerCount = cards.filter(c => isJoker(c)).length;
  return jokerCount === 4;
}

export function isFlushStraight(cards: Card[]): boolean {
  if (cards.length !== 5) return false;
  for (const c of cards) {
    if (c.rank === Rank.Two || isJoker(c)) return false;
  }
  const suit = cards[0].suit;
  if (!cards.every(c => c.suit === suit)) return false;

  const sorted = [...cards].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].rank !== sorted[i - 1].rank + 1) return false;
  }
  return true;
}

export function isWildCard(card: Card, currentLevel: number): boolean {
  return card.rank === (currentLevel as Rank) && card.suit === Suit.Heart;
}

function tryStraightWithWilds(
  regulars: Card[],
  wildCount: number,
  totalLength: number,
  currentLevel: number
): CardPattern | null {
  if (totalLength < 5) return null;

  const rankSet = new Set<number>();
  for (const c of regulars) {
    if (c.rank === Rank.Two || isJoker(c)) return null;
    rankSet.add(c.rank);
  }

  const ranks = Array.from(rankSet).sort((a, b) => a - b);
  const minRank = ranks[0];
  const maxRank = ranks[ranks.length - 1];

  for (let start = minRank; start <= maxRank + 1; start++) {
    const end = start + totalLength - 1;
    if (end > Rank.Ace) continue;

    let gaps = 0;
    let ok = true;
    for (let r = start; r <= end; r++) {
      if (!rankSet.has(r)) gaps++;
    }
    if (gaps === wildCount && gaps > 0) {
      const allCards = [...regulars, ...Array(wildCount).fill(null).map(() => ({
        id: -1, suit: Suit.Heart, rank: currentLevel as Rank,
      }))];
      return { type: PatternType.Straight, cards: allCards, rank: end as Rank, length: totalLength };
    }
  }
  return null;
}

function tryConsecutivePairWithWilds(
  regulars: Card[],
  wildCount: number,
  totalLength: number,
  currentLevel: number
): CardPattern | null {
  if (totalLength < 6 || totalLength % 2 !== 0) return null;
  const pairCount = totalLength / 2;
  if (pairCount < 3) return null;

  for (const c of regulars) {
    if (c.rank === Rank.Two || isJoker(c)) return null;
  }

  const rankCount = new Map<number, number>();
  for (const c of regulars) rankCount.set(c.rank, (rankCount.get(c.rank) || 0) + 1);
  const ranks = Array.from(rankCount.keys()).sort((a, b) => a - b);

  if (ranks.length === 0) return null;

  for (let start = ranks[0]; start <= ranks[ranks.length - 1] + 1; start++) {
    const end = start + pairCount - 1;
    if (end > Rank.Ace) continue;

    let needed = 0;
    let ok = true;
    for (let r = start; r <= end; r++) {
      const have = rankCount.get(r) || 0;
      if (have > 2) { ok = false; break; }
      needed += Math.max(0, 2 - have);
    }
    if (ok && needed === wildCount && needed > 0) {
      const allCards = [...regulars, ...Array(wildCount).fill(null).map(() => ({
        id: -1, suit: Suit.Heart, rank: currentLevel as Rank,
      }))];
      return { type: PatternType.ConsecutivePair, cards: allCards, rank: end as Rank, length: totalLength };
    }
  }
  return null;
}

function tryTriplePairWithWilds(
  regulars: Card[],
  wildCount: number,
  currentLevel: number
): CardPattern | null {
  if (regulars.length + wildCount !== 5) return null;

  const rankCount = new Map<number, number>();
  for (const c of regulars) rankCount.set(c.rank, (rankCount.get(c.rank) || 0) + 1);

  for (const [tripleRank, count] of rankCount.entries()) {
    const extraFromTriple = Math.max(0, count - 3);
    const neededForTriple = Math.max(0, 3 - count);
    const remainingWilds = wildCount - neededForTriple;

    if (remainingWilds < 0) continue;

    for (const [pairRank, pairCount] of rankCount.entries()) {
      if (pairRank === tripleRank) {
        const availAfterTriple = extraFromTriple;
        if (availAfterTriple + remainingWilds >= 2) {
          const allCards = [...regulars, ...Array(wildCount).fill(null).map(() => ({
            id: -1, suit: Suit.Heart, rank: currentLevel as Rank,
          }))];
          return { type: PatternType.TriplePair, cards: allCards, rank: tripleRank as Rank, length: 5 };
        }
      } else {
        if (pairCount + remainingWilds >= 2) {
          const allCards = [...regulars, ...Array(wildCount).fill(null).map(() => ({
            id: -1, suit: Suit.Heart, rank: currentLevel as Rank,
          }))];
          return { type: PatternType.TriplePair, cards: allCards, rank: tripleRank as Rank, length: 5 };
        }
      }
    }
  }

  for (const [tripleRank] of rankCount.entries()) {
    const neededForTriple = Math.max(0, 3 - rankCount.get(tripleRank)!);
    if (neededForTriple === 0) continue;
    const remaining = wildCount - neededForTriple;
    if (remaining >= 0 && remaining + (rankCount.get(tripleRank)! > 3 ? rankCount.get(tripleRank)! - 3 : 0) >= 2) {
      const allCards = [...regulars, ...Array(wildCount).fill(null).map(() => ({
        id: -1, suit: Suit.Heart, rank: currentLevel as Rank,
      }))];
      return { type: PatternType.TriplePair, cards: allCards, rank: tripleRank as Rank, length: 5 };
    }
  }

  return null;
}

function tryPlaneWithWilds(
  regulars: Card[],
  wildCount: number,
  totalLength: number,
  currentLevel: number
): CardPattern | null {
  if (totalLength < 6 || totalLength % 3 !== 0) return null;
  const tripleCount = totalLength / 3;
  if (tripleCount < 2) return null;

  for (const c of regulars) {
    if (c.rank === Rank.Two || isJoker(c)) return null;
  }

  const rankCount = new Map<number, number>();
  for (const c of regulars) rankCount.set(c.rank, (rankCount.get(c.rank) || 0) + 1);
  const ranks = Array.from(rankCount.keys()).sort((a, b) => a - b);
  if (ranks.length === 0) return null;

  for (let start = ranks[0]; start <= ranks[ranks.length - 1] + 1; start++) {
    const end = start + tripleCount - 1;
    if (end > Rank.Ace) continue;

    let needed = 0;
    for (let r = start; r <= end; r++) {
      const have = rankCount.get(r) || 0;
      if (have > 3) return null;
      needed += Math.max(0, 3 - have);
    }
    if (needed === wildCount && needed > 0) {
      const allCards = [...regulars, ...Array(wildCount).fill(null).map(() => ({
        id: -1, suit: Suit.Heart, rank: currentLevel as Rank,
      }))];
      return { type: PatternType.Plane, cards: allCards, rank: end as Rank, length: totalLength };
    }
  }
  return null;
}

export function identifyPattern(
  cards: Card[],
  currentLevel: number,
  wildCards: Card[] = []
): CardPattern | null {
  if (cards.length === 0) return null;

  const allCards = [...cards];
  const wilds = allCards.filter(c => isWildCard(c, currentLevel));
  const regulars = allCards.filter(c => !isWildCard(c, currentLevel));

  if (isKingBomb(allCards)) {
    return { type: PatternType.KingBomb, cards: allCards, rank: Rank.BigJoker, length: 4 };
  }

  if (isFlushStraight(allCards)) {
    const sorted = [...allCards].sort((a, b) => b.rank - a.rank);
    return { type: PatternType.FlushStraight, cards: allCards, rank: sorted[0].rank, length: 5 };
  }

  if (cards.length >= 4 && cards.length <= 8 && isBomb(allCards)) {
    const bombType = `bomb${cards.length}` as PatternType;
    return { type: bombType, cards: allCards, rank: allCards[0].rank, length: cards.length };
  }

  if (isSingle(allCards)) {
    return { type: PatternType.Single, cards: allCards, rank: allCards[0].rank, length: 1 };
  }

  if (isPair(allCards)) {
    return { type: PatternType.Pair, cards: allCards, rank: allCards[0].rank, length: 2 };
  }

  if (isTriple(allCards)) {
    return { type: PatternType.Triple, cards: allCards, rank: allCards[0].rank, length: 3 };
  }

  if (isTriplePair(allCards)) {
    const tripleCard = allCards.find(c =>
      allCards.filter(x => x.rank === c.rank).length === 3
    );
    return { type: PatternType.TriplePair, cards: allCards, rank: tripleCard!.rank, length: 5 };
  }

  if (isStraight(allCards)) {
    const sorted = [...allCards].sort((a, b) => b.rank - a.rank);
    return { type: PatternType.Straight, cards: allCards, rank: sorted[0].rank, length: cards.length };
  }

  if (isConsecutivePair(allCards)) {
    const rankCount = new Map<number, number>();
    for (const c of allCards) rankCount.set(c.rank, (rankCount.get(c.rank) || 0) + 1);
    const ranks = Array.from(rankCount.keys()).sort((a, b) => b - a);
    return { type: PatternType.ConsecutivePair, cards: allCards, rank: ranks[0], length: cards.length };
  }

  if (isPlane(allCards)) {
    const rankCount = new Map<number, number>();
    for (const c of allCards) rankCount.set(c.rank, (rankCount.get(c.rank) || 0) + 1);
    const ranks = Array.from(rankCount.keys()).sort((a, b) => b - a);
    return { type: PatternType.Plane, cards: allCards, rank: ranks[0], length: cards.length };
  }

  if (isPlaneWings(allCards)) {
    const rankCount = new Map<number, number>();
    for (const c of allCards) rankCount.set(c.rank, (rankCount.get(c.rank) || 0) + 1);
    const triples = Array.from(rankCount.entries()).filter(([, c]) => c === 3).map(([r]) => r);
    triples.sort((a, b) => b - a);
    return { type: PatternType.PlaneWings, cards: allCards, rank: triples[0], length: cards.length };
  }

  if (wilds.length > 0) {
    const totalLen = regulars.length + wilds.length;
    return tryStraightWithWilds(regulars, wilds.length, totalLen, currentLevel)
      || tryConsecutivePairWithWilds(regulars, wilds.length, totalLen, currentLevel)
      || tryTriplePairWithWilds(regulars, wilds.length, currentLevel)
      || tryPlaneWithWilds(regulars, wilds.length, totalLen, currentLevel);
  }

  return null;
}

export function isValidPlay(
  cards: Card[],
  currentLevel: number,
  wildCards: Card[] = []
): boolean {
  return identifyPattern(cards, currentLevel, wildCards) !== null;
}
