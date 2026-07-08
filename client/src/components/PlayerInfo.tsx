import React from 'react';
import { PlayerInfo as PlayerInfoType, Card } from '../sharedTypes';
import CardComponent from './CardComponent';

interface Props {
  player: PlayerInfoType;
  position: 'top' | 'left' | 'right' | 'bottom';
  isCurrent: boolean;
  isMe: boolean;
  isPartner: boolean;
}

const TEAM_COLORS = {
  mine: '#4a90d9',
  partner: '#357abd',
  opponent: '#e74c3c',
};

export default function PlayerInfoComponent({ player, position, isCurrent, isMe, isPartner }: Props) {
  const bgColor = isMe ? TEAM_COLORS.mine : isPartner ? TEAM_COLORS.partner : TEAM_COLORS.opponent;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 4,
      padding: '8px 16px',
      borderRadius: 12,
      background: isCurrent ? 'rgba(230,180,34,0.25)' : 'rgba(255,255,255,0.05)',
      border: isCurrent ? '2px solid #e6b422' : isPartner ? '2px solid #4a90d9' : '1px solid rgba(255,255,255,0.1)',
      minWidth: 110,
      transition: 'all 0.3s',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{
          width: 32, height: 32, borderRadius: '50%',
          background: bgColor,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 14, fontWeight: 700, color: '#fff',
        }}>
          {player.name.charAt(0)}
        </div>
        {isPartner && (
          <span style={{
            fontSize: 10,
            color: '#4a90d9',
            background: 'rgba(74,144,217,0.15)',
            padding: '1px 5px',
            borderRadius: 4,
            fontWeight: 600,
          }}>队友</span>
        )}
        {!isMe && !isPartner && (
          <span style={{
            fontSize: 10,
            color: '#e74c3c',
            background: 'rgba(231,76,60,0.15)',
            padding: '1px 5px',
            borderRadius: 4,
            fontWeight: 600,
          }}>对手</span>
        )}
      </div>
      <span style={{ fontSize: 13, fontWeight: 600, textAlign: 'center' }}>
        {player.name} {isMe ? '(我)' : ''}
      </span>
      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
        Lv.{player.level} | {player.cardCount}张
      </span>
    </div>
  );
}
