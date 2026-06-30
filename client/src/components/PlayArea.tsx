import React from 'react';
import { CardPattern, Card, Rank, Suit } from '../sharedTypes';
import CardComponent from './CardComponent';

interface Props {
  lastPlay: CardPattern | null;
  playHistory: { playerId: string; playerName: string; pattern: CardPattern }[];
}

export default function PlayArea({ lastPlay, playHistory }: Props) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 8,
      minHeight: 120,
    }}>
      {playHistory.length > 0 && (
        <div style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          justifyContent: 'center',
        }}>
          {playHistory.slice(-2).map((h, i) => (
            <div key={i} style={{
              textAlign: 'center',
              opacity: i === playHistory.slice(-2).length - 1 ? 1 : 0.5,
            }}>
              <div style={{ display: 'flex', gap: 2, marginBottom: 4 }}>
                {h.pattern.cards.map((c, j) => (
                  <CardComponent key={j} card={c} size="sm" />
                ))}
              </div>
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
                {h.playerName} - {h.pattern.type}
              </span>
            </div>
          ))}
        </div>
      )}

      {lastPlay && (
        <div style={{
          display: 'flex',
          gap: 3,
          padding: '8px 16px',
          borderRadius: 10,
          background: 'rgba(255,255,255,0.08)',
        }}>
          {lastPlay.cards.slice(0, 8).map((c, i) => (
            <CardComponent key={i} card={c} size="md" />
          ))}
        </div>
      )}
    </div>
  );
}
