import React from 'react';
import { Card } from '../sharedTypes';
import CardComponent from './CardComponent';

interface Props {
  cards: Card[];
  selectedIds: Set<number>;
  onToggle: (id: number) => void;
  currentLevel: number;
}

export default function HandCards({ cards, selectedIds, onToggle, currentLevel }: Props) {
  const MAX_VISIBLE = 20;
  const overlap = cards.length > MAX_VISIBLE ? 10 : 28;

  return (
    <div style={{
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'flex-end',
      padding: '0 40px',
      flexWrap: 'nowrap',
      overflow: 'visible',
    }}>
      {cards.map((card, i) => {
        const isLevelCard = card.rank === currentLevel;
        return (
          <div
            key={card.id}
            style={{
              marginLeft: i === 0 ? 0 : -overlap,
              zIndex: i,
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
    </div>
  );
}
