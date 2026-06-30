import { Card, Rank, Suit } from '../../../shared/types';
import { isJoker } from './card';

export function getLevelDelta(partnerRank: number): number {
  if (partnerRank === 2) return 3;
  if (partnerRank === 3) return 2;
  return 1;
}

export function determineTribute(
  teamARanks: { playerId: string; rank: number }[],
  teamBRanks: { playerId: string; rank: number }[]
): { tributeFrom: string; tributeTo: string } | null {
  const teamAWin = teamARanks.some(r => r.rank === 1);
  if (teamAWin) {
    const lastPlace = teamBRanks.find(r => r.rank === 4)!;
    const firstPlace = teamARanks.find(r => r.rank === 1)!;
    return { tributeFrom: lastPlace.playerId, tributeTo: firstPlace.playerId };
  }
  const lastPlace = teamARanks.find(r => r.rank === 4)!;
  const firstPlace = teamBRanks.find(r => r.rank === 1)!;
  return { tributeFrom: lastPlace.playerId, tributeTo: firstPlace.playerId };
}

export function canResistTribute(hand: Card[], currentLevel: number): boolean {
  const bigJokers = hand.filter(c => c.rank === Rank.BigJoker).length;
  return bigJokers >= 2;
}

export function selectTributeCard(hand: Card[], currentLevel: number): Card | null {
  if (hand.length === 0) return null;

  const bigJokers = hand.filter(c => c.rank === Rank.BigJoker);
  if (bigJokers.length >= 2) return null;

  let card = hand[0];
  for (const c of hand) {
    if (c.rank < card.rank) card = c;
    else if (c.rank === card.rank) {
      const suitOrder = [Suit.Club, Suit.Diamond, Suit.Spade, Suit.Heart];
      if (suitOrder.indexOf(c.suit) < suitOrder.indexOf(card.suit)) card = c;
    }
  }
  return card;
}

export function selectReturnTributeCard(hand: Card[], currentLevel: number): Card | null {
  if (hand.length === 0) return null;
  let card = hand[0];
  for (const c of hand) {
    if (c.rank > card.rank && c.rank < Rank.SmallJoker) card = c;
    else if (c.rank === card.rank) {
      const suitOrder = [Suit.Diamond, Suit.Club, Suit.Spade, Suit.Heart];
      if (suitOrder.indexOf(c.suit) < suitOrder.indexOf(card.suit)) card = c;
    }
  }
  return card;
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
