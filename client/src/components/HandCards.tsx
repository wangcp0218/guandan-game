import React from 'react';
import { Card, Rank } from '../sharedTypes';
import CardComponent from './CardComponent';

interface Props {
  cards: Card[];
  selectedIds: Set<number>;
  onToggle: (id: number) => void;
  currentLevel: number;
}

export default function HandCards({ cards, selectedIds, onToggle, currentLevel }: Props) {
  if (cards.length === 0) return null;

  const groups: Card[][] = [];
  for (const card of cards) {
    const last = groups[groups.length - 1];
    if (!last || last[0].rank !== card.rank) {
      groups.push([card]);
    } else {
      last.push(card);
    }
  }

  const CARD_W = 52;
  const CARD_OVERLAP = 20;
  const GROUP_GAP = 10;
  const totalWidth = groups.reduce((sum, g) => sum + CARD_W + (g.length - 1) * (CARD_W - CARD_OVERLAP), 0) + (groups.length - 1) * GROUP_GAP;
  const maxWidth = window.innerWidth - 80;
  let overlap = CARD_OVERLAP;
  let gap = GROUP_GAP;
  if (totalWidth > maxWidth) {
    overlap = Math.max(14, CARD_OVERLAP - Math.ceil((totalWidth - maxWidth) / cards.length));
  }

  return (
    <div style={{
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'flex-end',
      padding: '0 20px',
      flexWrap: 'nowrap',
      overflow: 'visible',
    }}>
      {groups.map((group, gi) => (
        <div
          key={gi}
          style={{
            display: 'flex',
            marginLeft: gi === 0 ? 0 : gap,
            position: 'relative',
          }}
        >
          {group.map((card, ci) => {
            const isLevelCard = card.rank === currentLevel;
            return (
              <div
                key={card.id}
                style={{
                  marginLeft: ci === 0 ? 0 : -overlap,
                  zIndex: gi * 100 + ci,
                }}
              >
                <CardComponent
                  card={card}
                  selected={selectedIds.has(card.id)}
                  onClick={() => onToggle(card.id)}
                  isLevelCard={isLevelCard}
                  size="md"
                />
              </div>
            );
          })}
          {group.length > 1 && (
            <span style={{
              position: 'absolute',
              bottom: -16,
              left: '50%',
              transform: 'translateX(-50%)',
              fontSize: 10,
              color: 'rgba(255,255,255,0.4)',
              whiteSpace: 'nowrap',
            }}>
              x{group.length}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
