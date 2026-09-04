import { Card, Suit, Rank, CardPattern, PatternType } from '../../../shared/types';
import { effectiveRank, isJoker } from './card';

export { CardPattern, PatternType, Suit, Rank };

export function isSingle(cards: Card[]): boolean {
  return cards.length === 1;
}

/**
 * 连牌类允许 A 作 1（A2345），也允许 2 出现在连牌中（23456）。
 * 返回连牌的比较点数；A2345 的最高点按 5 计算，而不是按 A 计算。
 */
function consecutiveHighRank(ranks: Rank[]): Rank | null {
  if (ranks.length === 0 || new Set(ranks).size !== ranks.length) return null;
  const wanted = new Set(ranks);
  for (let start = 1; start <= Rank.Ace - ranks.length + 1; start++) {
    const run = Array.from({ length: ranks.length }, (_, index) => {
      const value = start + index;
      return value === 1 ? Rank.Ace : value as Rank;
    });
    if (run.every(rank => wanted.has(rank))) return run[run.length - 1];
  }
  return null;
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
  // 掼蛋顺子固定为 5 张，不允许连出 6 张或更多。
  if (cards.length !== 5) return false;
  if (cards.some(isJoker)) return false;
  return consecutiveHighRank(cards.map(card => card.rank)) !== null;
}

export function isConsecutivePair(cards: Card[]): boolean {
  // 掼蛋的连对固定为三连对：三个连续对子，共 6 张。
  if (cards.length !== 6) return false;
  const pairCount = 3;

  if (cards.some(isJoker)) return false;

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
  return consecutiveHighRank(ranks as Rank[]) !== null;
}

export function isPlane(cards: Card[]): boolean {
  if (cards.length < 6 || cards.length % 3 !== 0) return false;
  const tripleCount = cards.length / 3;
  if (tripleCount < 2) return false;

  if (cards.some(isJoker)) return false;

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
  return consecutiveHighRank(triples as Rank[]) !== null;
}

export function isPlaneWings(cards: Card[]): boolean {
  const tripleCount = Math.floor(cards.length / 5);
  if (cards.length < 10 || cards.length % 5 !== 0) return false;
  if (tripleCount < 2) return false;

  if (cards.some(isJoker)) return false;

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

  return consecutiveHighRank(triples as Rank[]) !== null;
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
  if (cards.some(isJoker)) return false;
  const suit = cards[0].suit;
  if (!cards.every(c => c.suit === suit)) return false;
  return consecutiveHighRank(cards.map(card => card.rank)) !== null;
}

export function isWildCard(card: Card, currentLevel: number): boolean {
  return card.rank === (currentLevel as Rank) && card.suit === Suit.Heart;
}

function trySameRankWithWilds(
  regulars: Card[],
  allCards: Card[],
  size: 2 | 3,
): CardPattern | null {
  if (allCards.length !== size || regulars.length === 0 || regulars.some(isJoker)) return null;
  const rank = regulars[0].rank;
  if (!regulars.every(card => card.rank === rank)) return null;
  return {
    type: size === 2 ? PatternType.Pair : PatternType.Triple,
    cards: allCards,
    rank,
    length: size,
  };
}

function tryStraightWithWilds(
  regulars: Card[],
  wildCount: number,
  totalLength: number,
  currentLevel: number
): CardPattern | null {
  if (totalLength !== 5) return null;

  const rankSet = new Set<number>();
  for (const c of regulars) {
    if (isJoker(c)) return null;
    rankSet.add(c.rank);
  }
  if (rankSet.size !== regulars.length) return null;

  const wheel = [Rank.Ace, Rank.Two, Rank.Three, Rank.Four, Rank.Five];
  if (Array.from(rankSet).every(rank => wheel.includes(rank as Rank))) {
    const missing = wheel.filter(rank => !rankSet.has(rank)).length;
    if (missing === wildCount && missing > 0) {
      const allCards = [...regulars, ...Array(wildCount).fill(null).map(() => ({
        id: -1, suit: Suit.Heart, rank: currentLevel as Rank,
      }))];
      return { type: PatternType.Straight, cards: allCards, rank: Rank.Five, length: totalLength };
    }
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
  // 逢人配只能补成固定 6 张的三连对，不能扩展成四连对或更长。
  if (totalLength !== 6) return null;
  const pairCount = 3;

  for (const c of regulars) {
    if (isJoker(c)) return null;
  }

  const rankCount = new Map<number, number>();
  for (const c of regulars) rankCount.set(c.rank, (rankCount.get(c.rank) || 0) + 1);
  const ranks = Array.from(rankCount.keys()).sort((a, b) => a - b);

  if (ranks.length === 0) return null;

  const wheel = [Rank.Ace, Rank.Two, Rank.Three, Rank.Four, Rank.Five];
  if (pairCount <= 5 && ranks.every(rank => wheel.includes(rank as Rank))) {
    let needed = 0;
    let ok = true;
    for (const rank of wheel.slice(0, pairCount)) {
      const have = rankCount.get(rank) || 0;
      if (have > 2) { ok = false; break; }
      needed += 2 - have;
    }
    if (ok && needed === wildCount && needed > 0) {
      const allCards = [...regulars, ...Array(wildCount).fill(null).map(() => ({
        id: -1, suit: Suit.Heart, rank: currentLevel as Rank,
      }))];
      return { type: PatternType.ConsecutivePair, cards: allCards, rank: wheel[pairCount - 1], length: totalLength };
    }
  }

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

function tryFlushStraightWithWilds(
  regulars: Card[],
  wildCount: number,
  totalLength: number,
  currentLevel: number
): CardPattern | null {
  if (regulars.length === 0 || regulars.some(card => isJoker(card))) return null;
  if (!regulars.every(card => card.suit === regulars[0].suit)) return null;
  const straight = tryStraightWithWilds(regulars, wildCount, totalLength, currentLevel);
  return straight && straight.type === PatternType.Straight
    ? { ...straight, type: PatternType.FlushStraight }
    : null;
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
    if (isJoker(c)) return null;
  }

  const rankCount = new Map<number, number>();
  for (const c of regulars) rankCount.set(c.rank, (rankCount.get(c.rank) || 0) + 1);
  const ranks = Array.from(rankCount.keys()).sort((a, b) => a - b);
  if (ranks.length === 0) return null;

  const wheel = [Rank.Ace, Rank.Two, Rank.Three, Rank.Four, Rank.Five];
  if (tripleCount <= 5 && ranks.every(rank => wheel.includes(rank as Rank))) {
    let needed = 0;
    let ok = true;
    for (const rank of wheel.slice(0, tripleCount)) {
      const have = rankCount.get(rank) || 0;
      if (have > 3) { ok = false; break; }
      needed += 3 - have;
    }
    if (ok && needed === wildCount && needed > 0) {
      const allCards = [...regulars, ...Array(wildCount).fill(null).map(() => ({
        id: -1, suit: Suit.Heart, rank: currentLevel as Rank,
      }))];
      return { type: PatternType.Plane, cards: allCards, rank: wheel[tripleCount - 1], length: totalLength };
    }
  }

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
    return { type: PatternType.FlushStraight, cards: allCards, rank: consecutiveHighRank(allCards.map(card => card.rank))!, length: 5 };
  }

  if (wilds.length > 0) {
    const flushStraight = tryFlushStraightWithWilds(regulars, wilds.length, allCards.length, currentLevel);
    if (flushStraight) return flushStraight;
  }

  if (cards.length >= 4 && cards.length <= 8) {
    if (isBomb(allCards)) {
      const bombType = `bomb${cards.length}` as PatternType;
      return { type: bombType, cards: allCards, rank: allCards[0].rank, length: cards.length };
    }
    if (wilds.length > 0) {
      const rankCount = new Map<number, number>();
      for (const c of regulars) rankCount.set(c.rank, (rankCount.get(c.rank) || 0) + 1);
      if (rankCount.size === 1 && regulars.length > 0 && !isJoker(regulars[0])) {
        const total = regulars.length + wilds.length;
        const bombType = `bomb${total}` as PatternType;
        return { type: bombType, cards: allCards, rank: regulars[0].rank, length: total };
      }
    }
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
    return { type: PatternType.Straight, cards: allCards, rank: consecutiveHighRank(allCards.map(card => card.rank))!, length: cards.length };
  }

  if (isConsecutivePair(allCards)) {
    const rankCount = new Map<number, number>();
    for (const c of allCards) rankCount.set(c.rank, (rankCount.get(c.rank) || 0) + 1);
    const ranks = Array.from(rankCount.keys()) as Rank[];
    return { type: PatternType.ConsecutivePair, cards: allCards, rank: consecutiveHighRank(ranks)!, length: cards.length };
  }

  if (isPlane(allCards)) {
    const rankCount = new Map<number, number>();
    for (const c of allCards) rankCount.set(c.rank, (rankCount.get(c.rank) || 0) + 1);
    const ranks = Array.from(rankCount.keys()) as Rank[];
    return { type: PatternType.Plane, cards: allCards, rank: consecutiveHighRank(ranks)!, length: cards.length };
  }

  if (isPlaneWings(allCards)) {
    const rankCount = new Map<number, number>();
    for (const c of allCards) rankCount.set(c.rank, (rankCount.get(c.rank) || 0) + 1);
    const triples = Array.from(rankCount.entries()).filter(([, c]) => c === 3).map(([r]) => r);
    return { type: PatternType.PlaneWings, cards: allCards, rank: consecutiveHighRank(triples as Rank[])!, length: cards.length };
  }

  if (wilds.length > 0) {
    const totalLen = regulars.length + wilds.length;
    return trySameRankWithWilds(regulars, allCards, 2)
      || trySameRankWithWilds(regulars, allCards, 3)
      || tryStraightWithWilds(regulars, wilds.length, totalLen, currentLevel)
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
