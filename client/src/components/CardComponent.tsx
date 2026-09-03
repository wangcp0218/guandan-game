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
  size?: 'sm' | 'md' | 'lg' | 'hand';
  isLevelCard?: boolean;
}

interface CardDimensions {
  w: React.CSSProperties['width'];
  h: React.CSSProperties['height'];
  center: React.CSSProperties['fontSize'];
  corner: React.CSSProperties['fontSize'];
  cornerSuit: React.CSSProperties['fontSize'];
}

export default function CardComponent({ card, selected, onClick, faceDown, size = 'md', isLevelCard }: Props) {
  const dims: Record<NonNullable<Props['size']>, CardDimensions> = {
    sm: { w: 36, h: 50, center: 13, corner: 8, cornerSuit: 7 },
    md: { w: 52, h: 72, center: 18, corner: 11, cornerSuit: 9 },
    lg: { w: 64, h: 88, center: 22, corner: 14, cornerSuit: 11 },
    hand: {
      w: 'var(--hand-card-width)',
      h: 'var(--hand-card-height)',
      center: 'var(--hand-card-center-size)',
      corner: 'var(--hand-card-rank-size)',
      cornerSuit: 'var(--hand-card-suit-size)',
    },
  };
  const { w, h, center, corner, cornerSuit } = dims[size];
  const isHandCard = size === 'hand';
  const isRed = RED_SUITS.has(card.suit);
  const color = isRed ? '#c52c22' : '#15131a';
  const display = RANK_DISPLAY[card.rank] || '?';
  const suitSymbol = SUIT_SYMBOLS[card.suit] || '';
  const isJoker = card.rank === Rank.SmallJoker || card.rank === Rank.BigJoker;
  const jokerName = card.rank === Rank.BigJoker ? '大王' : '小王';

  if (faceDown) {
    return (
      <div
        className={`playing-card playing-card--${size} playing-card--back`}
        style={{ width: w, height: h }}
      />
    );
  }

  const background = isLevelCard
    ? 'linear-gradient(145deg, #fffdf1 0%, #fff5c7 100%)'
    : isJoker
      ? 'linear-gradient(145deg, #fffdfb 0%, #f5f0ea 100%)'
      : 'linear-gradient(145deg, #ffffff 0%, #f4f4f2 100%)';

  return (
    <div
      className={`playing-card playing-card--${size}${selected ? ' is-selected' : ''}${isLevelCard ? ' is-level-card' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      aria-pressed={onClick ? !!selected : undefined}
      aria-label={`${isJoker ? jokerName : `${display}${suitSymbol}`}${isLevelCard ? '，级牌' : ''}`}
      style={{
        width: w,
        height: h,
        background,
        cursor: onClick ? 'pointer' : 'default',
        color,
      }}
    >
      <div className={`card-corner${isHandCard ? ' card-corner--hand' : ''}`}>
        {isJoker && isHandCard ? (
          <span className="joker-corner" style={{ fontSize: corner, color }}>
            {jokerName}
          </span>
        ) : (
          <>
            <span className="card-rank" style={{ fontSize: corner }}>{display}</span>
            {!isJoker && <span className="card-corner-suit" style={{ fontSize: cornerSuit }}>{suitSymbol}</span>}
          </>
        )}
      </div>

      <div
        className={`card-center${isJoker ? ' card-center--joker' : ''}`}
        style={isJoker ? { color } : undefined}
      >
        {isJoker ? (
          <span className="joker-face">
            <span style={{ fontSize: center }}>{card.rank === Rank.BigJoker ? '★' : '☆'}</span>
            <span className="joker-name">{jokerName}</span>
          </span>
        ) : (
          <span style={{ fontSize: center }}>{suitSymbol}</span>
        )}
      </div>

      {!isHandCard && (
        <div className="card-corner card-corner--bottom">
          <span className="card-rank" style={{ fontSize: corner }}>{display}</span>
          {!isJoker && <span className="card-corner-suit" style={{ fontSize: cornerSuit }}>{suitSymbol}</span>}
        </div>
      )}

      {isHandCard && isLevelCard && <span className="level-card-badge">级牌</span>}
    </div>
  );
}
