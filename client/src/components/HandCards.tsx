import React, { useEffect, useRef } from 'react';
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
  arrangedGroups?: CardPattern[];
}

function stackOffset(index: number) {
  if (index === 0) return '0px';
  return `calc(${Array.from({ length: index }, () => 'var(--hand-stack-rise)').join(' + ')})`;
}

const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP_PX = 10;
const SUPPRESS_CLICK_MS = 600;

export default function HandCards({ cards, selectedIds, onToggle, onToggleStack, currentLevel, groupBySuit = false }: Props) {
  // Touch long-press selects the whole stack; desktop keeps right-click. Hooks
  // must run before the empty-hand early return below.
  const longPress = useRef<{
    timer?: number;
    x: number;
    y: number;
    suppressUntil: number;
    cardId: number;
    pointerType: string;
  }>({ x: 0, y: 0, suppressUntil: 0, cardId: -1, pointerType: '' });

  const clearLongPress = () => {
    if (longPress.current.timer !== undefined) {
      clearTimeout(longPress.current.timer);
      longPress.current.timer = undefined;
    }
  };
  useEffect(() => clearLongPress, []);

  const startLongPress = (event: React.PointerEvent, group: Card[], cardId: number) => {
    const state = longPress.current;
    state.suppressUntil = 0;
    state.pointerType = event.pointerType;
    if (event.pointerType === 'mouse') return;
    state.x = event.clientX;
    state.y = event.clientY;
    state.cardId = cardId;
    clearLongPress();
    state.timer = window.setTimeout(() => {
      state.timer = undefined;
      state.suppressUntil = Date.now() + SUPPRESS_CLICK_MS;
      onToggleStack(group.map(({ id }) => id));
    }, LONG_PRESS_MS);
  };
  const moveLongPress = (event: React.PointerEvent) => {
    const state = longPress.current;
    if (state.timer === undefined) return;
    if (Math.hypot(event.clientX - state.x, event.clientY - state.y) > LONG_PRESS_SLOP_PX) clearLongPress();
  };
  const toggleSingle = (cardId: number) => {
    const state = longPress.current;
    if (Date.now() < state.suppressUntil && state.cardId === cardId) return;
    onToggle(cardId);
  };
  const toggleStack = (group: Card[]) => {
    // Android fires contextmenu during a touch long-press; the pointer timer
    // already toggled the stack, so only mouse right-click acts here.
    const type = longPress.current.pointerType;
    if (type === 'touch' || type === 'pen') return;
    onToggleStack(group.map(({ id }) => id));
  };

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

  const groups: Card[][] = arrangedGroups ? arrangedGroups.map(pattern => {
    const rank = (card: Card) => {
      const resolved = pattern.substitutions?.find(item => item.id === card.id)?.rank ?? card.rank;
      return pattern.rank === 5 && resolved === Rank.Ace ? 1 : resolved;
    };
    return [...pattern.cards].sort((a, b) => {
      if (pattern.type === 'triple_pair') {
        const main = Number(rank(b) === pattern.rank) - Number(rank(a) === pattern.rank);
        if (main) return main;
      }
      return rank(a) - rank(b) || suitOrder[b.suit] - suitOrder[a.suit] || a.id - b.id;
    });
  }) : [];
  for (const card of arrangedGroups ? [] : displayedCards) {
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
      className={`hand-cards${arrangedGroups ? ' is-arranged' : ''}${dragging ? ' is-dragging' : ''}`}
      onPointerDown={startGesture}
      onPointerMove={moveGesture}
      onPointerUp={event => { moveGesture(event); finishGesture(event); }}
      onPointerCancel={finishGesture}
      onLostPointerCapture={finishGesture}
      onClickCapture={event => { if (suppressPointerClick.current && event.detail > 0) { event.preventDefault(); event.stopPropagation(); suppressPointerClick.current = false; } }}
      style={{
        height: stackHeight,
        '--hand-group-count': groups.length,
        '--hand-stack-count': Math.max(1, maxStack - 1),
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
                className={`hand-card-slot${cardIndex > 0 ? ' is-stacked' : ''}`}
                key={card.id}
                data-card-id={card.id}
                data-hit-order={groupIndex * 100 + group.length - cardIndex}
                style={{
                  bottom: stackOffset(cardIndex),
                  // Keep a selected card inside its original stack layer. Raising its
                  // wrapper above the entire stack hides the middle cards in 3+ stacks.
                  zIndex: group.length - cardIndex,
                }}
                onPointerDown={event => startLongPress(event, group, card.id)}
                onPointerMove={moveLongPress}
                onPointerUp={clearLongPress}
                onPointerCancel={clearLongPress}
              >
                <CardComponent
                  card={card}
                  selected={selected}
                  onClick={() => toggleSingle(card.id)}
                  onContextMenu={() => toggleStack(group)}
                  isLevelCard={card.rank === currentLevel}
                  size="hand"
                />
              </div>
            );
          })}
          {arrangedGroups && <span className="hand-group-label">
            {({ single: '单张', pair: '对子', triple: '三张', triple_pair: '三带二', straight: '顺子', consecutive_pair: '三连对', plane: '二连三', flush_straight: '同花顺', king_bomb: '四王炸' } as Record<string, string>)[arrangedGroups[groupIndex].type]
              || `${group.length}炸`}
          </span>}
        </div>
      ))}
    </div>
  );
}
