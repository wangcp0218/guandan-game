import React from 'react';
import { Card, Suit, Rank } from '../sharedTypes';

const SUIT_SYMBOLS: Record<Suit, string> = {
  [Suit.Spade]: '♠',
  [Suit.Heart]: '♥',
  [Suit.Club]: '♣',
  [Suit.Diamond]: '♦',
};

const RANK_DISPLAY: Partial<Record<Rank, string>> = {
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
  [Rank.SmallJoker]: '小',
  [Rank.BigJoker]: '大',
};

const RED_SUITS = new Set([Suit.Heart, Suit.Diamond]);

interface Props {
  card: Card;
  selected?: boolean;
  onClick?: () => void;
  faceDown?: boolean;
  size?: 'sm' | 'md' | 'lg';
  isLevelCard?: boolean;
}

export default function CardComponent({ card, selected, onClick, faceDown, size = 'md', isLevelCard }: Props) {
  const dims = { sm: { w: 36, h: 50, fs: 12 }, md: { w: 52, h: 72, fs: 16 }, lg: { w: 64, h: 88, fs: 20 } };
  const { w, h, fs } = dims[size];
  const isRed = RED_SUITS.has(card.suit);
  const color = isRed ? '#d32f2f' : '#333';
  const display = RANK_DISPLAY[card.rank] || '?';
  const suitSymbol = SUIT_SYMBOLS[card.suit] || '';

  if (faceDown) {
    return (
      <div style={{
        width: w, height: h,
        borderRadius: 6,
        background: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
        border: '2px solid #1e40af',
        boxShadow: selected ? '0 0 0 3px #e6b422' : '0 2px 4px rgba(0,0,0,0.2)',
        flexShrink: 0,
      }} />
    );
  }

  return (
    <div
      onClick={onClick}
      style={{
        width: w,
        height: h,
        borderRadius: 6,
        background: '#fff',
        border: selected ? '3px solid #e6b422' : '1px solid #ddd',
        boxShadow: selected ? '0 0 0 3px rgba(230,180,34,0.3), 0 4px 8px rgba(0,0,0,0.3)' : '0 2px 4px rgba(0,0,0,0.15)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: onClick ? 'pointer' : 'default',
        transform: selected ? 'translateY(-8px)' : 'none',
        transition: 'all 0.15s ease',
        flexShrink: 0,
        position: 'relative',
        userSelect: 'none',
        ...(isLevelCard ? { background: 'linear-gradient(135deg, #fff9c4, #fff176)' } : {}),
        ...(card.rank === Rank.BigJoker ? { background: 'linear-gradient(135deg, #ffcdd2, #ef9a9a)' } : {}),
        ...(card.rank === Rank.SmallJoker ? { background: 'linear-gradient(135deg, #e1bee7, #ce93d8)' } : {}),
      }}
    >
      <span style={{ fontSize: fs, fontWeight: 700, color, lineHeight: 1 }}>{display}</span>
      {card.rank < Rank.SmallJoker && (
        <span style={{ fontSize: fs * 0.6, color, lineHeight: 1 }}>{suitSymbol}</span>
      )}
    </div>
  );
}
