import React from 'react';
import { PlayerInfo as PlayerInfoType, Card } from '../sharedTypes';
import CardComponent from './CardComponent';

interface Props {
  player: PlayerInfoType;
  position: 'top' | 'left' | 'right' | 'bottom';
  isCurrent: boolean;
  isMe: boolean;
}

const POS_COLORS: Record<string, string> = {
  top: '#3498db',
  left: '#e74c3c',
  right: '#2ecc71',
  bottom: '#f39c12',
};

export default function PlayerInfoComponent({ player, position, isCurrent, isMe }: Props) {
  const color = POS_COLORS[position] || '#fff';

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 4,
      padding: '8px 16px',
      borderRadius: 12,
      background: isCurrent ? 'rgba(230,180,34,0.2)' : 'rgba(255,255,255,0.05)',
      border: isCurrent ? '2px solid #e6b422' : '1px solid rgba(255,255,255,0.1)',
      minWidth: 100,
      transition: 'all 0.3s',
    }}>
      <div style={{
        width: 32, height: 32, borderRadius: '50%',
        background: color,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 14, fontWeight: 700, color: '#fff',
      }}>
        {player.name.charAt(0)}
      </div>
      <span style={{ fontSize: 13, fontWeight: 600 }}>
        {player.name} {isMe ? '(我)' : ''}
      </span>
      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
        Lv.{player.level} | {player.cardCount}张
      </span>
    </div>
  );
}
