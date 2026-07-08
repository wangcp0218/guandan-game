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
  const dims = {
    sm: { w: 36, h: 50, fs: 12, corner: 8, cornerSuit: 7 },
    md: { w: 52, h: 72, fs: 16, corner: 11, cornerSuit: 9 },
    lg: { w: 64, h: 88, fs: 20, corner: 14, cornerSuit: 11 },
  };
  const { w, h, fs, corner, cornerSuit } = dims[size];
  const isRed = RED_SUITS.has(card.suit);
  const color = isRed ? '#d32f2f' : '#333';
  const display = RANK_DISPLAY[card.rank] || '?';
  const suitSymbol = SUIT_SYMBOLS[card.suit] || '';
  const isJoker = card.rank === Rank.SmallJoker || card.rank === Rank.BigJoker;

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

  const bg = isLevelCard
    ? 'linear-gradient(135deg, #fff9c4, #fff176)'
    : card.rank === Rank.BigJoker
    ? 'linear-gradient(135deg, #ffcdd2, #ef9a9a)'
    : card.rank === Rank.SmallJoker
    ? 'linear-gradient(135deg, #e1bee7, #ce93d8)'
    : '#fff';

  return (
    <div
      onClick={onClick}
      style={{
        width: w,
        height: h,
        borderRadius: 6,
        background: bg,
        border: selected ? '3px solid #e6b422' : '1px solid #ddd',
        boxShadow: selected ? '0 0 0 3px rgba(230,180,34,0.3), 0 4px 8px rgba(0,0,0,0.3)' : '0 2px 4px rgba(0,0,0,0.15)',
        display: 'flex',
        flexDirection: 'column',
        cursor: onClick ? 'pointer' : 'default',
        transform: selected ? 'translateY(-8px)' : 'none',
        transition: 'all 0.15s ease',
        flexShrink: 0,
        position: 'relative',
        userSelect: 'none',
        overflow: 'hidden',
      }}
    >
      {/* Top-left corner: rank + suit (always visible even when overlapped) */}
      <div style={{
        position: 'absolute',
        top: 2,
        left: 3,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        lineHeight: 1,
        gap: 0,
      }}>
        <span style={{ fontSize: corner, fontWeight: 700, color, lineHeight: 1 }}>{display}</span>
        {!isJoker && <span style={{ fontSize: cornerSuit, color, lineHeight: 1, marginTop: 1 }}>{suitSymbol}</span>}
      </div>

      {/* Center: large suit symbol (visible when card is fully shown) */}
      {!isJoker && (
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 4,
        }}>
          <span style={{ fontSize: fs * 1.1, color: color, opacity: 0.85, lineHeight: 1 }}>{suitSymbol}</span>
        </div>
      )}
      {isJoker && (
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 4,
        }}>
          <span style={{ fontSize: fs, fontWeight: 700, color, lineHeight: 1 }}>王</span>
        </div>
      )}

      {/* Bottom-right corner: rank + suit (rotated, like real cards) */}
      <div style={{
        position: 'absolute',
        bottom: 2,
        right: 3,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        lineHeight: 1,
        transform: 'rotate(180deg)',
        gap: 0,
      }}>
        <span style={{ fontSize: corner, fontWeight: 700, color, lineHeight: 1 }}>{display}</span>
        {!isJoker && <span style={{ fontSize: cornerSuit, color, lineHeight: 1, marginTop: 1 }}>{suitSymbol}</span>}
      </div>
    </div>
  );
}
