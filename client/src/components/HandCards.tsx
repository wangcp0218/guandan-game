import React from 'react';
import { Card, Rank, Suit } from '../sharedTypes';
import CardComponent from './CardComponent';

interface Props {
  cards: Card[];
  selectedIds: Set<number>;
  onToggle: (id: number) => void;
  onToggleStack: (ids: number[]) => void;
  currentLevel: number;
  /** Portrait phones group jokers, level cards, then the four suits. */
  groupBySuit?: boolean;
}

function stackOffset(index: number) {
  if (index === 0) return '0px';
  return `calc(${Array.from({ length: index }, () => 'var(--hand-stack-rise)').join(' + ')})`;
}

export default function HandCards({ cards, selectedIds, onToggle, onToggleStack, currentLevel, groupBySuit = false }: Props) {
  if (cards.length === 0) return null;

  const groupKey = (card: Card) => {
    if (groupBySuit && (card.rank === Rank.BigJoker || card.rank === Rank.SmallJoker)) return 'jokers';
    if (groupBySuit && card.rank === currentLevel) return 'level';
    if (card.rank === Rank.BigJoker || card.rank === Rank.SmallJoker) return `joker-${card.rank}`;
    return groupBySuit ? `suit-${card.suit}` : `rank-${card.rank}`;
  };
  const suitOrder: Record<Suit, number> = {
    [Suit.Spade]: 4,
    [Suit.Heart]: 3,
    [Suit.Club]: 2,
    [Suit.Diamond]: 1,
  };
  const displayedCards = groupBySuit
    ? [...cards].sort((a, b) => {
      const groupOrder = (card: Card) => {
        if (card.rank === Rank.BigJoker || card.rank === Rank.SmallJoker) return 6;
        if (card.rank === currentLevel) return 5;
        return suitOrder[card.suit];
      };
      const orderDiff = groupOrder(b) - groupOrder(a);
      if (orderDiff) return orderDiff;
      const bothJokers = [a, b].every(card => card.rank === Rank.BigJoker || card.rank === Rank.SmallJoker);
      if (bothJokers) return b.rank - a.rank || b.id - a.id;
      return suitOrder[b.suit] - suitOrder[a.suit] || b.rank - a.rank || b.id - a.id;
    })
    : cards;

  const groups: Card[][] = [];
  for (const card of displayedCards) {
    const last = groups[groups.length - 1];
    if (!last || groupKey(last[0]) !== groupKey(card)) groups.push([card]);
    else last.push(card);
  }

  const maxStack = Math.max(...groups.map(group => group.length));
  // Compress only the overlap distance when one suit is unusually large, so
  // the complete portrait hand remains visible.
  const compactStackRise = Math.max(2, Math.min(10, Math.floor(68 / Math.max(1, maxStack - 1))));
  const stackHeight = maxStack > 1
    ? `calc(var(--hand-card-height) + ${Array.from({ length: maxStack - 1 }, () => 'var(--hand-stack-rise)').join(' + ')})`
    : 'var(--hand-card-height)';

  return (
    <div
      className="hand-cards"
      style={{
        height: stackHeight,
        ...(groupBySuit ? { '--hand-stack-rise': `${compactStackRise}px` } : {}),
      } as React.CSSProperties}
      aria-label={`手牌，共 ${cards.length} 张`}
    >
      {groups.map((group, groupIndex) => (
        <div
          className="hand-card-group"
          key={`${groupKey(group[0])}-${groupIndex}`}
          style={{
            zIndex: groupIndex + 1,
            flexBasis: groupIndex === groups.length - 1
              ? 'var(--hand-card-width)'
              : 'var(--hand-column-step)',
            minWidth: groupIndex === groups.length - 1
              ? 'var(--hand-card-width)'
              : 'var(--hand-column-min)',
          }}
        >
          {group.map((card, cardIndex) => {
            const selected = selectedIds.has(card.id);
            return (
              <div
                className="hand-card-slot"
                key={card.id}
                style={{
                  bottom: stackOffset(cardIndex),
                  // Keep a selected card inside its original stack layer. Raising its
                  // wrapper above the entire stack hides the middle cards in 3+ stacks.
                  zIndex: group.length - cardIndex,
                }}
              >
                <CardComponent
                  card={card}
                  selected={selected}
                  onClick={() => onToggle(card.id)}
                  onContextMenu={() => onToggleStack(group.map(({ id }) => id))}
                  isLevelCard={card.rank === currentLevel}
                  size="hand"
                />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
