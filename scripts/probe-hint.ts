import { GameRoom } from '../server/src/services/GameRoom';
import { createDeck, shuffleDeck, sortCards } from '../server/src/engine/card';
import { identifyPattern } from '../server/src/engine/patterns';
import { generateLegalPlays, findBestPlay, orderHintPlays } from '../server/src/engine/ai';
import { canBeat } from '../server/src/engine/compare';
import { Card, Rank } from '../shared/types';

const deck = createDeck();
const take = (rank: number, count: number) => deck.filter(c => c.rank === rank).slice(0, count);
const label = (cards: Card[]) => cards.map(c => c.rank === Rank.BigJoker ? '大' : c.rank === Rank.SmallJoker ? '小' : `${c.rank}`).join(' ');
const key = (cards: Card[]) => cards.map(c => c.id).sort((a, b) => a - b).join(',');

function makeRoom(hand: Card[], lastCards: Card[] | null) {
  const room = new GameRoom('probe', 'p0');
  for (let i = 0; i < 4; i++) room.addPlayer(`p${i}`, `P${i}`, 2, null);
  room.startGame();
  room.state!.currentPlayerIndex = 0;
  room.hands.set('p0', hand);
  room.state!.lastPlay = lastCards ? identifyPattern(lastCards, 2) : null;
  return room;
}

// 场景1：自由出牌，4-9 六连顺会拆9炸弹
{
  const hand = [...take(4, 1), ...take(5, 1), ...take(6, 1), ...take(7, 1), ...take(8, 1), ...take(9, 4), ...take(13, 1)];
  const room = makeRoom(hand, null);
  const best = findBestPlay(hand, null, true, 2);
  console.log('[lead] findBestPlay:', best ? label(best.cards) : 'null');
  let selection: Card[] = [];
  for (let i = 0; i < 6; i++) {
    selection = room.getHintCards('p0', selection.map(c => c.id));
    console.log(`  hint${i + 1}: ${label(selection)}`);
  }
  room.clearPlayers();
}

// 场景2：跟对3，dump 全部候选确认是否只有一个
{
  const hand = [...take(5, 2), ...take(4, 1), ...take(2, 1), ...take(13, 1), ...take(14, 1)];
  const last = identifyPattern(take(3, 2), 2)!;
  const all = generateLegalPlays(hand, 2).filter(p => canBeat(p, last, 2));
  const seen = new Set<string>();
  for (const p of all) {
    const k = key(p.cards);
    if (seen.has(k)) continue;
    seen.add(k);
    console.log('[follow pair3] candidate:', label(p.cards), `type=${p.type}`);
  }
  const room = makeRoom(hand, take(3, 2));
  let selection: Card[] = [];
  for (let i = 0; i < 4; i++) {
    selection = room.getHintCards('p0', selection.map(c => c.id));
    console.log(`  hint${i + 1}: ${label(selection)}`);
  }
  room.clearPlayers();
}

// 契约模糊测试：首提示 vs findBestPlay 首选（跟牌与自由两类）
{
  let mismatch = 0, total = 0, noBest = 0;
  for (let seed = 0; seed < 300; seed++) {
    const shuffled = shuffleDeck(createDeck());
    const hand = sortCards(shuffled.slice(0, 8 + (seed % 20)), 2);
    const all = generateLegalPlays(hand, 2);
    const lead = seed % 2 === 0;
    let last: Card[] | null = null;
    if (!lead) {
      const pool = all.filter(p => p.cards.length <= 5 && !p.cards.some(c => c.rank === 2));
      if (pool.length === 0) continue;
      last = pool[seed % pool.length].cards;
    }
    const lastPattern = last ? identifyPattern(last, 2) : null;
    const best = findBestPlay(hand, lastPattern, lead, 2);
    if (!best) { noBest++; continue; }
    const plays = lastPattern ? all.filter(p => canBeat(p, lastPattern, 2)) : all;
    const ordered = orderHintPlays(plays, hand, 2, lead, all);
    total++;
    if (key(ordered[0].cards) !== key(best.cards)) {
      mismatch++;
      if (mismatch <= 3) {
        console.log(`[fuzz mismatch seed=${seed}] hint=${label(ordered[0].cards)} best=${label(best.cards)} lead=${lead}`);
      }
    }
  }
  console.log(`[fuzz] total=${total} mismatch=${mismatch} noBest=${noBest}`);
}
