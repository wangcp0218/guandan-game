import { Card, Rank, Suit } from '../../../shared/types';
import { effectiveRank } from './card';

export function getLevelDelta(partnerRank: number): number {
  if (partnerRank === 2) return 3;
  if (partnerRank === 3) return 2;
  return 1;
}

export function canResistTribute(hand: Card[]): boolean {
  const bigJokers = hand.filter(c => c.rank === Rank.BigJoker).length;
  return bigJokers >= 2;
}

export function selectTributeCard(hand: Card[], currentLevel: number): Card | null {
  const eligible = hand.filter(card => !(card.rank === currentLevel && card.suit === Suit.Heart));
  if (eligible.length === 0) return null;
  return eligible.reduce((highest, card) =>
    effectiveRank(card.rank, currentLevel) > effectiveRank(highest.rank, currentLevel) ? card : highest
  );
}

export function selectReturnTributeCard(hand: Card[], currentLevel: number): Card | null {
  const eligible = hand.filter(card => isValidReturnTributeCard(card, currentLevel));
  if (eligible.length === 0) return null;

  // Prefer a low singleton so automatic returns do not needlessly split a pair or bomb.
  const rankCounts = new Map<Rank, number>();
  for (const card of hand) rankCounts.set(card.rank, (rankCounts.get(card.rank) || 0) + 1);
  return eligible.reduce((best, card) => {
    const bestBreaksGroup = (rankCounts.get(best.rank) || 0) > 1;
    const cardBreaksGroup = (rankCounts.get(card.rank) || 0) > 1;
    if (bestBreaksGroup !== cardBreaksGroup) return cardBreaksGroup ? best : card;
    return effectiveRank(card.rank, currentLevel) < effectiveRank(best.rank, currentLevel) ? card : best;
  });
}

export function isValidReturnTributeCard(card: Card, currentLevel: number): boolean {
  return effectiveRank(card.rank, currentLevel) <= Rank.Ten;
}

export function getNextLevel(currentLevel: number, partnerRank: number): number {
  const delta = getLevelDelta(partnerRank);
  return Math.min(currentLevel + delta, Rank.Ace);
}

export enum Team {
  TeamA = 0,
  TeamB = 1,
}

export function getTeam(seatIndex: number): Team {
  return seatIndex % 2 === 0 ? Team.TeamA : Team.TeamB;
}
