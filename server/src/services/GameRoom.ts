import { v4 as uuidv4 } from 'uuid';
import {
  Card, GamePhase, GameState, PlayerInfo, CardPattern, PatternType,
  RoundResult, Rank, Suit, ChatMessage,
} from '../../../shared/types';
import { createDeck, shuffleDeck, dealCards, sortCards, isJoker } from '../engine/card';
import { identifyPattern, isValidPlay } from '../engine/patterns';
import { canBeat, canFreePlay, isBombPattern } from '../engine/compare';
import { getTeam, getLevelDelta, determineTribute, selectTributeCard, selectReturnTributeCard } from '../engine/rules';
import { findBestPlay, findBestTribute } from '../engine/ai';

const MAX_PLAYERS = 4;
const TURN_TIMEOUT = 30000;

export class GameRoom {
  id: string;
  name: string;
  password: string;
  players: { id: string; name: string; level: number; socket: any; isAI: boolean }[] = [];
  state: GameState | null = null;
  hands: Map<string, Card[]> = new Map();
  rankings: { playerId: string; rank: number }[] = [];
  currentLevel: number = Rank.Two;
  turnTimer: ReturnType<typeof setTimeout> | null = null;
  roundNumber: number = 0;
  aiCount: number = 0;

  constructor(name: string, password: string = '', aiCount: number = 0) {
    this.id = uuidv4();
    this.name = name;
    this.password = password;
    this.aiCount = aiCount;
  }

  addPlayer(id: string, name: string, level: number, socket: any, isAI: boolean = false): number {
    const existingIdx = this.players.findIndex(p => p.id === id);
    if (existingIdx >= 0) {
      const existing = this.players[existingIdx];
      existing.name = name;
      existing.level = level;
      existing.socket = socket;
      existing.isAI = isAI;
      if (!this.state || this.state.phase === GamePhase.Waiting) {
        this.syncWaitingState();
      }
      return existingIdx;
    }

    if (this.players.length >= MAX_PLAYERS) return -1;
    const idx = this.players.length;
    this.players.push({ id, name, level, socket, isAI });
    if (!this.state || this.state.phase === GamePhase.Waiting) {
      this.syncWaitingState();
    }
    return idx;
  }

  removePlayer(id: string) {
    this.players = this.players.filter(p => p.id !== id);
    if (!this.state || this.state.phase === GamePhase.Waiting) {
      this.syncWaitingState();
    }
  }

  getPlayerCount(): number {
    return this.players.length;
  }

  getHumanPlayerCount(): number {
    return this.players.filter(p => !p.isAI).length;
  }

  hasPlayer(id: string): boolean {
    return this.players.some(p => p.id === id);
  }

  clearPlayers() {
    this.players = [];
    this.hands.clear();
    this.rankings = [];
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    this.state = null;
  }

  canStart(): boolean {
    return this.players.length === MAX_PLAYERS;
  }

  fillWithAI() {
    const needed = MAX_PLAYERS - this.players.length;
    const aiNames = ['AI小明', 'AI小红', 'AI小刚', 'AI小亮'];
    for (let i = 0; i < Math.min(needed, this.aiCount); i++) {
      const aiId = `ai_${this.id}_${i}`;
      this.addPlayer(aiId, aiNames[i] || `AI${i+1}`, this.currentLevel, null, true);
    }
    this.aiCount = 0;
    if (!this.state || this.state.phase === GamePhase.Waiting) {
      this.syncWaitingState();
    }
  }

  getHintCards(playerId: string): Card[] {
    if (!this.state || this.state.phase !== GamePhase.Playing) return [];
    const playerIdx = this.players.findIndex(p => p.id === playerId);
    if (playerIdx !== this.state.currentPlayerIndex) return [];
    const hand = this.hands.get(playerId) || [];
    const isFreePlay = canFreePlay(this.state.lastPlay, this.state.passCount);
    const pattern = findBestPlay(hand, this.state.lastPlay, isFreePlay, this.state.currentLevel);
    if (!pattern) return [];
    return pattern.cards;
  }

  startGame() {
    this.roundNumber++;
    const deck = shuffleDeck(createDeck());
    const dealt = dealCards(deck, MAX_PLAYERS);
    this.hands.clear();
    this.rankings = [];

    for (let i = 0; i < MAX_PLAYERS; i++) {
      const player = this.players[i];
      this.hands.set(player.id, sortCards(dealt[i], this.currentLevel));
    }

    this.state = {
      roomId: this.id,
      phase: GamePhase.Waiting,
      currentLevel: this.currentLevel,
      players: this.players.map((p, i) => ({
        id: p.id,
        name: p.name,
        level: p.level,
        seatIndex: i,
        cardCount: this.hands.get(p.id)?.length || 0,
        isReady: p.isAI,
        isOnline: true,
      })),
      currentPlayerIndex: 0,
      lastPlay: null,
      lastPlayPlayerIndex: -1,
      passCount: 0,
      tributeTo: null,
      tributeCard: null,
      returnTributeCards: null,
      redHeartIndex: -1,
      roundNumber: this.roundNumber,
    };

    this.emitHands();
    this.startPlayingPhase();
  }

  getHand(playerId: string): Card[] {
    return [...(this.hands.get(playerId) || [])];
  }

  syncWaitingState() {
    this.state = {
      roomId: this.id,
      phase: GamePhase.Waiting,
      currentLevel: this.currentLevel,
      players: this.players.map((p, i) => ({
        id: p.id,
        name: p.name,
        level: p.level,
        seatIndex: i,
        cardCount: this.hands.get(p.id)?.length || 0,
        isReady: p.isAI,
        isOnline: true,
      })),
      currentPlayerIndex: 0,
      lastPlay: null,
      lastPlayPlayerIndex: -1,
      passCount: 0,
      tributeTo: null,
      tributeCard: null,
      returnTributeCards: null,
      redHeartIndex: -1,
      roundNumber: this.roundNumber,
    };

    this.broadcastState();
  }

  private startPlayingPhase() {
    if (!this.state) return;
    this.state.phase = GamePhase.Playing;
    this.broadcastState();
    this.startTurn();
  }

  private startTurn() {
    if (!this.state) return;
    if (this.turnTimer) clearTimeout(this.turnTimer);

    const currentPlayer = this.players[this.state.currentPlayerIndex];
    if (currentPlayer.isAI) {
      this.turnTimer = setTimeout(() => this.handleTimeout(), TURN_TIMEOUT);
      setTimeout(() => this.aiPlay(), 500);
    } else {
      this.turnTimer = setTimeout(() => this.handleTimeout(), TURN_TIMEOUT);
    }
  }

  playCards(playerId: string, cards: Card[]): { success: boolean; error?: string } {
    if (!this.state || this.state.phase !== GamePhase.Playing) {
      return { success: false, error: '游戏未在进行中' };
    }

    const playerIdx = this.players.findIndex(p => p.id === playerId);
    if (playerIdx !== this.state.currentPlayerIndex) {
      return { success: false, error: '不是你的回合' };
    }

    if (this.turnTimer) { clearTimeout(this.turnTimer); this.turnTimer = null; }

    const hand = this.hands.get(playerId) || [];
    if (cards.length === 0) {
      return this.handlePass(playerId);
    }

    const handCardIds = new Set(hand.map(c => c.id));
    for (const c of cards) {
      if (!handCardIds.has(c.id)) {
        return { success: false, error: '手牌中没有这张牌' };
      }
    }

    const pattern = identifyPattern(cards, this.state.currentLevel);
    if (!pattern) {
      return { success: false, error: '无效的牌型' };
    }

    const isFreePlay = canFreePlay(this.state.lastPlay, this.state.passCount);
    if (!isFreePlay && this.state.lastPlay) {
      if (!canBeat(pattern, this.state.lastPlay, this.state.currentLevel)) {
        return { success: false, error: '打不过上家的牌' };
      }
    }

    for (const c of cards) {
      const idx = hand.findIndex(h => h.id === c.id);
      if (idx >= 0) hand.splice(idx, 1);
    }
    this.hands.set(playerId, hand);

    this.state.lastPlay = pattern;
    this.state.lastPlayPlayerIndex = playerIdx;
    this.state.passCount = 0;

    this.updatePlayerCardCount();
    this.broadcastEvent('player_played', {
      playerId,
      playerName: this.players[playerIdx].name,
      pattern,
    });
    this.emitHandToPlayer(playerId);

    if (hand.length === 0) {
      const rank = this.rankings.length + 1;
      this.rankings.push({ playerId, rank });
      this.broadcastEvent('player_finish', { playerId, playerName: this.players[playerIdx].name, rank });

      if (rank === 1 && this.rankings.length < MAX_PLAYERS) {
        this.state.passCount = 3;
      }

      if (this.rankings.length >= MAX_PLAYERS - 1) {
        this.endRound();
        return { success: true };
      }

      this.advanceTurn();
      this.broadcastState();
      this.startTurn();
      return { success: true };
    }

    this.advanceTurn();
    this.broadcastState();
    this.startTurn();
    return { success: true };
  }

  private handlePass(playerId: string): { success: boolean; error?: string } {
    if (!this.state) return { success: false, error: '游戏未在进行中' };

    if (this.turnTimer) { clearTimeout(this.turnTimer); this.turnTimer = null; }

    if (!this.state.lastPlay) {
      return { success: false, error: '首轮必须出牌' };
    }

    if (this.state.passCount >= 3) {
      return { success: false, error: '自由出牌阶段不能再过' };
    }

    this.state.passCount++;
    this.broadcastEvent('player_pass', { playerId });

    if (this.state.passCount >= 3) {
      this.state.lastPlay = null;
      this.state.lastPlayPlayerIndex = -1;
    }

    this.advanceTurn();
    this.broadcastState();
    this.startTurn();
    return { success: true };
  }

  private advanceTurn() {
    if (!this.state) return;
    let next = (this.state.currentPlayerIndex + 1) % MAX_PLAYERS;
    while (this.rankings.some(r => r.playerId === this.players[next].id)) {
      next = (next + 1) % MAX_PLAYERS;
    }
    this.state.currentPlayerIndex = next;
  }

  private endRound() {
    if (!this.state) return;

    const unranked = this.players.find(p => !this.rankings.some(r => r.playerId === p.id));
    if (unranked) {
      this.rankings.push({ playerId: unranked.id, rank: MAX_PLAYERS });
    }

    const winner = this.rankings.find(r => r.rank === 1)!;
    const winnerTeam = getTeam(this.players.findIndex(p => p.id === winner.playerId));
    const partner = this.players.find((p, i) =>
      getTeam(i) === winnerTeam && p.id !== winner.playerId
    )!;
    const partnerRank = this.rankings.find(r => r.playerId === partner.id)!.rank;
    const delta = getLevelDelta(partnerRank);

    const result: RoundResult = {
      rankings: this.rankings,
      winnerTeam,
      loserTeam: winnerTeam === 0 ? 1 : 0,
      winnerLevelDelta: delta,
    };

    if (winnerTeam === 0) {
      this.currentLevel += delta;
    }
    if (this.currentLevel > Rank.Ace) this.currentLevel = Rank.Ace;

    this.state.phase = GamePhase.RoundEnd;
    this.broadcastEvent('round_end', result);
    this.broadcastState();
    this.emitToAll('round_end', result);
  }

  startNextRound() {
    this.startGame();
  }

  private aiPlay() {
    if (!this.state) return;
    try {
      const playerIdx = this.state.currentPlayerIndex;
      const player = this.players[playerIdx];
      const hand = this.hands.get(player.id) || [];

      const isFreePlay = canFreePlay(this.state.lastPlay, this.state.passCount);
      const pattern = findBestPlay(hand, this.state.lastPlay, isFreePlay, this.state.currentLevel);

      if (pattern) {
        this.playCards(player.id, pattern.cards);
      } else {
        if (this.state.lastPlay) {
          this.handlePass(player.id);
        } else {
          const singles = hand.map(c => [c]).filter(p => identifyPattern(p, this.state!.currentLevel));
          if (singles.length > 0) {
            this.playCards(player.id, singles[0]);
          }
        }
      }
    } catch (e) {
      console.error('aiPlay error:', e);
      // Fallback: just pass or force play smallest single
      if (this.state && this.state.lastPlay) {
        try { this.handlePass(this.players[this.state.currentPlayerIndex]?.id); } catch {}
      } else if (this.state) {
        const player = this.players[this.state.currentPlayerIndex];
        const hand = this.hands.get(player?.id) || [];
        if (hand.length > 0) {
          try { this.playCards(player.id, [hand[0]]); } catch {}
        }
      }
    }
  }

  private handleTimeout() {
    if (!this.state) return;
    const player = this.players[this.state.currentPlayerIndex];
    if (!this.state.lastPlay) {
      const hand = this.hands.get(player.id) || [];
      const singles = hand.map(c => [c]).filter(p => identifyPattern(p, this.state!.currentLevel));
      if (singles.length > 0) {
        this.playCards(player.id, singles[0]);
      } else {
        this.handlePass(player.id);
      }
    } else {
      this.handlePass(player.id);
    }
  }

  private updatePlayerCardCount() {
    if (!this.state) return;
    for (const p of this.state.players) {
      p.cardCount = this.hands.get(p.id)?.length || 0;
    }
  }

  broadcastState() {
    if (!this.state) return;
    this.emitToAll('game_state', this.state);
  }

  private broadcastEvent(event: string, data: any) {
    this.emitToAll(event, data);
  }

  private emitToAll(event: string, data: any) {
    for (const p of this.players) {
      if (!p.isAI && p.socket) {
        try { p.socket.emit(event, data); } catch (e) {}
      }
    }
  }

  private emitHands() {
    for (const p of this.players) {
      if (!p.isAI) {
        this.emitHandToPlayer(p.id);
      }
    }
  }

  private emitHandToPlayer(playerId: string) {
    const player = this.players.find(p => p.id === playerId);
    if (!player || player.isAI || !player.socket) return;
    try {
      player.socket.emit('your_cards', this.getHand(playerId));
    } catch (e) {}
  }

  toRoomInfo() {
    return {
      id: this.id,
      name: this.name,
      playerCount: this.players.filter(p => !p.isAI).length,
      maxPlayers: MAX_PLAYERS,
      level: this.currentLevel,
      hasPassword: !!this.password,
      aiCount: this.aiCount + this.players.filter(p => p.isAI).length,
    };
  }
}
