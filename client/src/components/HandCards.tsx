import React from 'react';
import { Card } from '../sharedTypes';
import CardComponent from './CardComponent';

interface Props {
  cards: Card[];
  selectedIds: Set<number>;
  onToggle: (id: number) => void;
  onToggleStack: (ids: number[]) => void;
  currentLevel: number;
}

function stackOffset(index: number) {
  if (index === 0) return '0px';
  return `calc(${Array.from({ length: index }, () => 'var(--hand-stack-rise)').join(' + ')})`;
}

export default function HandCards({ cards, selectedIds, onToggle, onToggleStack, currentLevel }: Props) {
  if (cards.length === 0) return null;

  const groups: Card[][] = [];
  for (const card of cards) {
    const last = groups[groups.length - 1];
    if (!last || last[0].rank !== card.rank) groups.push([card]);
    else last.push(card);
  }

  const maxStack = Math.max(...groups.map(group => group.length));
  const stackHeight = maxStack > 1
    ? `calc(var(--hand-card-height) + ${Array.from({ length: maxStack - 1 }, () => 'var(--hand-stack-rise)').join(' + ')})`
    : 'var(--hand-card-height)';

  return (
    <div
      className="hand-cards"
      style={{ height: stackHeight } as React.CSSProperties}
      aria-label={`手牌，共 ${cards.length} 张`}
    >
      {groups.map((group, groupIndex) => (
        <div
          className="hand-card-group"
          key={`${group[0].rank}-${groupIndex}`}
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
                  zIndex: selected ? 100 : group.length - cardIndex,
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
