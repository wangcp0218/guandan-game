import { Card, Suit, Rank } from '../../../shared/types';

export { Suit, Rank, Card };

const ALL_SUITS = [Suit.Spade, Suit.Heart, Suit.Club, Suit.Diamond];

export function createDeck(): Card[] {
  const deck: Card[] = [];
  let id = 0;

  for (let deckIdx = 0; deckIdx < 2; deckIdx++) {
    for (const suit of ALL_SUITS) {
      for (let rank = Rank.Two; rank <= Rank.Ace; rank++) {
        deck.push({ id: id++, suit, rank });
      }
    }
    deck.push({ id: id++, suit: Suit.Spade, rank: Rank.SmallJoker });
    deck.push({ id: id++, suit: Suit.Heart, rank: Rank.BigJoker });
  }

  return deck;
}

export function shuffleDeck(deck: Card[]): Card[] {
  const arr = [...deck];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function dealCards(deck: Card[], playerCount: number): Card[][] {
  const hands: Card[][] = Array.from({ length: playerCount }, () => []);
  for (let i = 0; i < deck.length; i++) {
    hands[i % playerCount].push(deck[i]);
  }
  return hands;
}

export function effectiveRank(rank: Rank, currentLevel: number): number {
  const levelRank = currentLevel as Rank;
  if (rank === Rank.SmallJoker) return 100;
  if (rank === Rank.BigJoker) return 101;
  if (rank === levelRank) return 99;
  if (rank === Rank.Ace) return 14;
  if (rank === Rank.Two && levelRank !== Rank.Two) return 2;
  return rank;
}

export function sortCards(cards: Card[], currentLevel: number): Card[] {
  return [...cards].sort((a, b) => {
    const ea = effectiveRank(a.rank, currentLevel);
    const eb = effectiveRank(b.rank, currentLevel);
    if (ea !== eb) return eb - ea;
    const suitOrder: Record<Suit, number> = {
      [Suit.Spade]: 4,
      [Suit.Heart]: 3,
      [Suit.Club]: 2,
      [Suit.Diamond]: 1,
    };
    return (suitOrder[b.suit] || 0) - (suitOrder[a.suit] || 0);
  });
}

export function isLevelCard(card: Card, currentLevel: number): boolean {
  return card.rank === (currentLevel as Rank);
}

export function isRedHeart(card: Card): boolean {
  return card.suit === Suit.Heart;
}

export function cardDisplayName(card: Card): string {
  const suitNames: Record<Suit, string> = {
    [Suit.Spade]: '♠',
    [Suit.Heart]: '♥',
    [Suit.Club]: '♣',
    [Suit.Diamond]: '♦',
  };
  const rankNames: Partial<Record<Rank, string>> = {
    [Rank.Two]: '2',
    [Rank.Three]: '3',
    [Rank.Four]: '4',
    [Rank.Five]: '5',
    [Rank.Six]: '6',
    [Rank.Seven]: '7',
    [Rank.Eight]: '8',
    [Rank.Nine]: '9',
    [Rank.Ten]: '10',
    [Rank.Jack]: 'J',
    [Rank.Queen]: 'Q',
    [Rank.King]: 'K',
    [Rank.Ace]: 'A',
    [Rank.SmallJoker]: '小王',
    [Rank.BigJoker]: '大王',
  };
  return `${suitNames[card.suit] || ''}${rankNames[card.rank] || card.rank}`;
}

export function isJoker(card: Card): boolean {
  return card.rank === Rank.SmallJoker || card.rank === Rank.BigJoker;
}
