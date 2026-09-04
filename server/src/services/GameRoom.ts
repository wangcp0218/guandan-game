import { v4 as uuidv4 } from 'uuid';
import {
  Card, GamePhase, GameState, PlayerInfo, CardPattern, PatternType,
  RoundResult, Rank, Suit, ChatMessage, AiModelSelection, SpectatorInfo, SpectatorHands, TributeExchange,
} from '../../../shared/types';
import { createDeck, shuffleDeck, dealCards, sortCards, isJoker, effectiveRank } from '../engine/card';
import { identifyPattern, isValidPlay } from '../engine/patterns';
import { canBeat, canFreePlay, isBombPattern } from '../engine/compare';
import { getTeam, getLevelDelta, canResistTribute, selectTributeCard, selectReturnTributeCard, isValidReturnTributeCard } from '../engine/rules';
import { findBestPlay, findSmartPlay } from '../engine/ai';
import type { AiDecisionContext, AiRecentAction } from '../engine/llmAi';
import { DEFAULT_AI_SELECTION } from '../engine/llmAi';

const MAX_PLAYERS = 4;
const TURN_TIMEOUT = 30000;

export class GameRoom {
  id: string;
  name: string;
  password: string;
  ownerId: string;
  players: { id: string; name: string; level: number; socket: any; isAI: boolean }[] = [];
  private seatAssignments: Array<string | null> = Array(MAX_PLAYERS).fill(null);
  private spectators: Map<string, { id: string; name: string; socket: any }> = new Map();
  state: GameState | null = null;
  hands: Map<string, Card[]> = new Map();
  rankings: { playerId: string; rank: number }[] = [];
  currentLevel: number = Rank.Two;
  turnTimer: ReturnType<typeof setTimeout> | null = null;
  recentActions: AiRecentAction[] = [];
  roundNumber: number = 0;
  teamLevels: [Rank, Rank] = [Rank.Two, Rank.Two];
  leadingTeam: 0 | 1 = 0;
  aiModelSelection: AiModelSelection;

  constructor(
    name: string,
    ownerId: string,
    password: string = '',
    aiModelSelection: AiModelSelection = DEFAULT_AI_SELECTION,
  ) {
    this.id = uuidv4();
    this.name = name;
    this.password = password;
    this.aiModelSelection = aiModelSelection;
    this.ownerId = ownerId;
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
      return this.seatAssignments.indexOf(id);
    }

    if (this.players.length >= MAX_PLAYERS) return -1;
    this.players.push({ id, name, level, socket, isAI });
    const seatIndex = this.seatAssignments.findIndex(seat => seat === null);
    if (seatIndex >= 0) this.seatAssignments[seatIndex] = id;
    if (!this.state || this.state.phase === GamePhase.Waiting) {
      this.syncWaitingState();
    }
    return seatIndex;
  }

  removePlayer(id: string) {
    const isWaiting = !this.state || this.state.phase === GamePhase.Waiting;
    this.players = this.players.filter(p => p.id !== id);
    if (isWaiting) {
      const seatIndex = this.seatAssignments.indexOf(id);
      if (seatIndex >= 0) this.seatAssignments[seatIndex] = null;
      if (this.ownerId === id) {
        this.ownerId = this.players.find(player => !player.isAI)?.id || '';
      }
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

  hasSpectator(id: string): boolean {
    return this.spectators.has(id);
  }

  addSpectator(id: string, name: string, socket: any): { success: boolean; error?: string } {
    if (!this.state || this.state.phase === GamePhase.Waiting) {
      return { success: false, error: '牌局尚未开始，不能观战' };
    }
    if (this.hasPlayer(id)) return { success: false, error: '你已在牌局中' };
    this.spectators.set(id, { id, name, socket });
    this.broadcastState();
    return { success: true };
  }

  removeSpectator(id: string) {
    if (!this.spectators.delete(id)) return;
    this.broadcastState();
  }

  removeAllSpectators(): any[] {
    const sockets = Array.from(this.spectators.values(), spectator => spectator.socket).filter(Boolean);
    this.spectators.clear();
    return sockets;
  }

  removeSpectatorByOwner(ownerId: string, spectatorId: string): { success: boolean; error?: string; socket?: any } {
    if (ownerId !== this.ownerId) return { success: false, error: '只有房主可以剔除观察者' };
    const spectator = this.spectators.get(spectatorId);
    if (!spectator) return { success: false, error: '观察者已离开' };
    this.spectators.delete(spectatorId);
    this.broadcastState();
    return { success: true, socket: spectator.socket };
  }

  clearPlayers() {
    this.players = [];
    this.seatAssignments = Array(MAX_PLAYERS).fill(null);
    this.spectators.clear();
    this.hands.clear();
    this.rankings = [];
    this.recentActions = [];
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    this.state = null;
  }

  canStart(): boolean {
    return this.players.length === MAX_PLAYERS;
  }

  movePlayerToSeat(ownerId: string, playerId: string, targetSeatIndex: number): { success: boolean; error?: string } {
    if (!this.state || this.state.phase !== GamePhase.Waiting) {
      return { success: false, error: '牌局已开始，不能调整座位' };
    }
    if (ownerId !== this.ownerId) return { success: false, error: '只有房主可以排座' };
    if (!Number.isInteger(targetSeatIndex) || targetSeatIndex < 0 || targetSeatIndex >= MAX_PLAYERS) {
      return { success: false, error: '无效座位' };
    }
    const sourceSeatIndex = this.seatAssignments.indexOf(playerId);
    if (sourceSeatIndex < 0) return { success: false, error: '玩家不在房间中' };
    const targetPlayerId = this.seatAssignments[targetSeatIndex];
    this.seatAssignments[targetSeatIndex] = playerId;
    this.seatAssignments[sourceSeatIndex] = targetPlayerId;
    this.syncWaitingState();
    return { success: true };
  }

  startByOwner(ownerId: string): { success: boolean; error?: string } {
    if (!this.state || this.state.phase !== GamePhase.Waiting) {
      return { success: false, error: '牌局已经开始' };
    }
    if (ownerId !== this.ownerId) return { success: false, error: '只有房主可以开始牌局' };
    this.fillWithAI();
    if (!this.canStart()) return { success: false, error: '人数不足，无法开始牌局' };
    this.lockSeatsForGame();
    this.startGame();
    return { success: true };
  }

  fillWithAI() {
    const needed = MAX_PLAYERS - this.players.length;
    const aiNames = ['AI小明', 'AI小红', 'AI小刚', 'AI小亮'];
    for (let i = 0; i < needed; i++) {
      const aiId = `ai_${this.id}_${i}`;
      this.addPlayer(aiId, aiNames[i] || `AI${i+1}`, this.currentLevel, null, true);
    }
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
    this.lockSeatsForGame();
    const previousRankings = this.roundNumber > 0 ? [...this.rankings] : [];
    this.roundNumber++;
    const deck = shuffleDeck(createDeck());
    const dealt = dealCards(deck, MAX_PLAYERS);
    this.hands.clear();
    this.rankings = [];
    this.recentActions = [];

    for (let i = 0; i < MAX_PLAYERS; i++) {
      const player = this.players[i];
      this.hands.set(player.id, sortCards(dealt[i], this.currentLevel));
    }

    this.state = {
      roomId: this.id,
      ownerId: this.ownerId,
      spectators: this.getSpectatorList(),
      phase: GamePhase.Waiting,
      currentLevel: this.currentLevel,
      teamLevels: [...this.teamLevels],
      leadingTeam: this.leadingTeam,
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
      tributeExchanges: [],
      tributeResisted: false,
      tributeLeadPlayerId: null,
      redHeartIndex: -1,
      roundNumber: this.roundNumber,
    };

    this.emitHands();
    if (previousRankings.length === MAX_PLAYERS) {
      this.startTributePhase(previousRankings);
    } else {
      this.startPlayingPhase(0);
    }
  }

  getHand(playerId: string): Card[] {
    return [...(this.hands.get(playerId) || [])];
  }

  syncWaitingState() {
    this.state = {
      roomId: this.id,
      ownerId: this.ownerId,
      spectators: this.getSpectatorList(),
      phase: GamePhase.Waiting,
      currentLevel: this.currentLevel,
      teamLevels: [...this.teamLevels],
      leadingTeam: this.leadingTeam,
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        level: p.level,
        seatIndex: this.seatAssignments.indexOf(p.id),
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
      tributeExchanges: [],
      tributeResisted: false,
      tributeLeadPlayerId: null,
      redHeartIndex: -1,
      roundNumber: this.roundNumber,
    };

    this.broadcastState();
  }

  private lockSeatsForGame() {
    const orderedPlayers = this.seatAssignments
      .map(playerId => this.players.find(player => player.id === playerId) || null)
      .filter((player): player is { id: string; name: string; level: number; socket: any; isAI: boolean } => player !== null);
    if (orderedPlayers.length === MAX_PLAYERS) this.players = orderedPlayers;
  }

  private startPlayingPhase(leadPlayerIndex: number = 0) {
    if (!this.state) return;
    this.state.phase = GamePhase.Playing;
    this.state.currentPlayerIndex = leadPlayerIndex;
    this.broadcastState();
    this.startTurn();
  }

  private startTributePhase(previousRankings: { playerId: string; rank: number }[]) {
    if (!this.state) return;
    const first = previousRankings.find(item => item.rank === 1);
    const second = previousRankings.find(item => item.rank === 2);
    const third = previousRankings.find(item => item.rank === 3);
    const last = previousRankings.find(item => item.rank === 4);
    if (!first || !second || !third || !last) {
      this.startPlayingPhase(0);
      return;
    }

    const firstSeat = this.players.findIndex(player => player.id === first.playerId);
    const firstTeam = getTeam(firstSeat);
    const isDoubleDown = getTeam(this.players.findIndex(player => player.id === second.playerId)) === firstTeam;
    const contributors = isDoubleDown ? [third, last] : [last];
    const contributorHands = contributors.flatMap(item => this.hands.get(item.playerId) || []);

    this.state.phase = GamePhase.Tribute;
    this.state.tributeResisted = canResistTribute(contributorHands);
    this.state.tributeLeadPlayerId = this.state.tributeResisted ? first.playerId : null;

    if (this.state.tributeResisted) {
      this.state.currentPlayerIndex = firstSeat;
      this.broadcastEvent('tribute_resisted', {
        playerIds: contributors.map(item => item.playerId),
        leadPlayerId: first.playerId,
      });
      this.startPlayingPhase(firstSeat);
      return;
    }

    const tributeCards = contributors.map(contributor => ({
      contributor,
      card: selectTributeCard(this.hands.get(contributor.playerId) || [], this.currentLevel),
    }));
    if (tributeCards.some(item => !item.card)) {
      this.startPlayingPhase(firstSeat);
      return;
    }

    let pairings: Array<{ fromPlayerId: string; toPlayerId: string; card: Card }>;
    if (!isDoubleDown) {
      pairings = [{ fromPlayerId: last.playerId, toPlayerId: first.playerId, card: tributeCards[0].card! }];
    } else {
      const [left, right] = tributeCards as [
        { contributor: { playerId: string; rank: number }; card: Card },
        { contributor: { playerId: string; rank: number }; card: Card },
      ];
      const leftRank = effectiveRank(left.card.rank, this.currentLevel);
      const rightRank = effectiveRank(right.card.rank, this.currentLevel);
      let larger = left;
      let smaller = right;
      if (rightRank > leftRank) {
        larger = right;
        smaller = left;
      } else if (rightRank === leftRank) {
        // When both tribute cards have the same point, the upper winner's next seat
        // contributes to the upper winner; the other contributor goes to second place.
        const preferredSeat = (firstSeat + 1) % MAX_PLAYERS;
        if (this.players.findIndex(player => player.id === right.contributor.playerId) === preferredSeat) {
          larger = right;
          smaller = left;
        }
      }
      pairings = [
        { fromPlayerId: larger.contributor.playerId, toPlayerId: first.playerId, card: larger.card },
        { fromPlayerId: smaller.contributor.playerId, toPlayerId: second.playerId, card: smaller.card },
      ];
    }

    this.state.tributeLeadPlayerId = pairings[0].fromPlayerId;
    this.state.tributeExchanges = pairings.map(pairing => ({
      fromPlayerId: pairing.fromPlayerId,
      toPlayerId: pairing.toPlayerId,
      tributeCard: pairing.card,
      returnCard: null,
    }));
    this.state.tributeTo = this.players.findIndex(player => player.id === pairings[0].toPlayerId);
    this.state.tributeCard = pairings[0].card;

    for (const exchange of this.state.tributeExchanges) {
      this.transferCard(exchange.fromPlayerId, exchange.toPlayerId, exchange.tributeCard);
    }
    this.state.phase = GamePhase.ReturnTribute;
    this.updatePlayerCardCount();
    this.emitHands();
    this.broadcastEvent('tribute_given', { exchanges: this.state.tributeExchanges });
    this.advanceReturnTribute();
  }

  returnTribute(playerId: string, card: Card): { success: boolean; error?: string } {
    if (!this.state || this.state.phase !== GamePhase.ReturnTribute) {
      return { success: false, error: '当前不在还贡阶段' };
    }
    const exchange = this.state.tributeExchanges.find(item => item.returnCard === null);
    if (!exchange || exchange.toPlayerId !== playerId) {
      return { success: false, error: '还没有轮到你还贡' };
    }
    const hand = this.hands.get(playerId) || [];
    const actualCard = hand.find(item => item.id === card?.id);
    if (!actualCard) return { success: false, error: '手牌中没有这张牌' };
    if (!isValidReturnTributeCard(actualCard, this.currentLevel)) {
      return { success: false, error: '还贡只能选择牌点不超过10的牌，级牌不能还贡' };
    }

    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    this.finishReturnTribute(exchange, actualCard);
    return { success: true };
  }

  private advanceReturnTribute() {
    if (!this.state || this.state.phase !== GamePhase.ReturnTribute) return;
    const exchange = this.state.tributeExchanges.find(item => item.returnCard === null);
    if (!exchange) {
      this.completeTribute();
      return;
    }

    const recipientIndex = this.players.findIndex(player => player.id === exchange.toPlayerId);
    const recipient = this.players[recipientIndex];
    this.state.currentPlayerIndex = recipientIndex;
    this.broadcastState();
    if (recipient.isAI) {
      setTimeout(() => this.autoReturnTribute(exchange), 350);
    } else {
      this.turnTimer = setTimeout(() => this.autoReturnTribute(exchange), TURN_TIMEOUT);
    }
  }

  private autoReturnTribute(exchange: TributeExchange) {
    if (!this.state || this.state.phase !== GamePhase.ReturnTribute || exchange.returnCard !== null) return;
    const card = selectReturnTributeCard(this.hands.get(exchange.toPlayerId) || [], this.currentLevel);
    if (!card) {
      // A legal deck should always provide a return card. Fall back to the lowest
      // non-joker card so an exceptionally distributed deck cannot deadlock a room.
      const fallback = [...(this.hands.get(exchange.toPlayerId) || [])]
        .filter(item => !isJoker(item))
        .sort((a, b) => effectiveRank(a.rank, this.currentLevel) - effectiveRank(b.rank, this.currentLevel))[0];
      if (!fallback) return;
      this.finishReturnTribute(exchange, fallback);
      return;
    }
    this.finishReturnTribute(exchange, card);
  }

  private finishReturnTribute(exchange: TributeExchange, card: Card) {
    if (!this.state) return;
    exchange.returnCard = card;
    this.transferCard(exchange.toPlayerId, exchange.fromPlayerId, card);
    this.state.returnTributeCards = this.state.tributeExchanges
      .map(item => item.returnCard)
      .filter((item): item is Card => item !== null);
    this.updatePlayerCardCount();
    this.emitHands();
    this.broadcastEvent('tribute_returned', {
      fromPlayerId: exchange.toPlayerId,
      toPlayerId: exchange.fromPlayerId,
      card,
    });
    this.advanceReturnTribute();
  }

  private completeTribute() {
    if (!this.state) return;
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    const leadIndex = Math.max(0, this.players.findIndex(player => player.id === this.state!.tributeLeadPlayerId));
    this.emitHands();
    this.startPlayingPhase(leadIndex);
  }

  private transferCard(fromPlayerId: string, toPlayerId: string, card: Card) {
    const fromHand = this.hands.get(fromPlayerId) || [];
    const cardIndex = fromHand.findIndex(item => item.id === card.id);
    if (cardIndex < 0) return;
    const [transferred] = fromHand.splice(cardIndex, 1);
    this.hands.set(fromPlayerId, sortCards(fromHand, this.currentLevel));
    this.hands.set(toPlayerId, sortCards([...(this.hands.get(toPlayerId) || []), transferred], this.currentLevel));
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
    this.recordAiAction({
      seatIndex: playerIdx,
      action: 'play',
      pattern,
    });

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

      if (this.rankings.length >= MAX_PLAYERS) {
        this.endRound();
        return { success: true };
      }

      // A finished player cannot take another turn, so the next active player leads freely.
      this.clearCurrentTrick();
      this.advanceTurn();
      this.broadcastState();
      this.startTurn();
      return { success: true };
    }

    // Let the final remaining player play out every card without beating their own last play.
    if (this.getActivePlayerCount() === 1) {
      this.clearCurrentTrick();
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

    this.state.passCount++;
    const playerIdx = this.players.findIndex(player => player.id === playerId);
    this.recordAiAction({
      seatIndex: playerIdx,
      action: 'pass',
    });
    this.broadcastEvent('player_pass', { playerId });

    if (this.state.passCount >= this.getPassesNeededToClearTrick()) {
      this.clearCurrentTrick();
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

  private getActivePlayerCount(): number {
    return MAX_PLAYERS - this.rankings.length;
  }

  private getPassesNeededToClearTrick(): number {
    return Math.max(1, this.getActivePlayerCount() - 1);
  }

  private clearCurrentTrick() {
    if (!this.state) return;
    this.state.lastPlay = null;
    this.state.lastPlayPlayerIndex = -1;
    this.state.passCount = 0;
  }

  private recordAiAction(action: AiRecentAction) {
    this.recentActions = [...this.recentActions.slice(-11), action];
  }

  private getAiDecisionContext(playerIdx: number): AiDecisionContext {
    const partnerSeatIndex = (playerIdx + 2) % MAX_PLAYERS;
    return {
      selfSeatIndex: playerIdx,
      partnerSeatIndex,
      lastPlayPlayerIndex: this.state?.lastPlayPlayerIndex ?? -1,
      players: this.players.map((player, seatIndex) => ({
        seatIndex,
        cardCount: this.hands.get(player.id)?.length || 0,
        finishRank: this.rankings.find(item => item.playerId === player.id)?.rank || null,
        relation: seatIndex === playerIdx
          ? 'self'
          : seatIndex === partnerSeatIndex
            ? 'partner'
            : 'opponent',
      })),
      recentActions: [...this.recentActions],
    };
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

    this.teamLevels[winnerTeam] = Math.min(Rank.Ace, this.teamLevels[winnerTeam] + delta) as Rank;
    this.leadingTeam = winnerTeam as 0 | 1;
    this.currentLevel = this.teamLevels[winnerTeam];
    this.state.currentLevel = this.currentLevel;

    this.state.phase = GamePhase.RoundEnd;
    this.broadcastEvent('round_end', result);
    this.broadcastState();
  }

  startNextRound(requesterId: string): { success: boolean; error?: string } {
    if (!this.state || this.state.phase !== GamePhase.RoundEnd) {
      return { success: false, error: '当前不能开始下一局' };
    }
    if (!this.hasPlayer(requesterId)) {
      return { success: false, error: '只有牌局中的玩家可以开始下一局' };
    }
    this.startGame();
    return { success: true };
  }

  private async aiPlay() {
    if (!this.state) return;
    try {
      const expectedState = this.state;
      const playerIdx = this.state.currentPlayerIndex;
      const player = this.players[playerIdx];
      const hand = this.hands.get(player.id) || [];

      const isFreePlay = canFreePlay(this.state.lastPlay, this.state.passCount);
      const pattern = await findSmartPlay(
        hand,
        this.state.lastPlay,
        isFreePlay,
        this.state.currentLevel,
        this.getAiDecisionContext(playerIdx),
        this.aiModelSelection,
      );

      // Ignore a delayed model response if the round or active player changed.
      if (
        !this.state ||
        this.state !== expectedState ||
        this.state.phase !== GamePhase.Playing ||
        this.state.currentPlayerIndex !== playerIdx ||
        this.players[playerIdx]?.id !== player.id
      ) {
        return;
      }

      if (pattern) {
        this.playCards(player.id, pattern.cards);
      } else {
        if (this.state.lastPlay) {
          this.handlePass(player.id);
        } else {
          const fallback = findBestPlay(hand, null, true, this.state.currentLevel);
          if (fallback) this.playCards(player.id, fallback.cards);
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
          const fallback = findBestPlay(hand, null, true, this.state.currentLevel);
          if (fallback) {
            try { this.playCards(player.id, fallback.cards); } catch {}
          }
        }
      }
    }
  }

  private handleTimeout() {
    if (!this.state) return;
    const player = this.players[this.state.currentPlayerIndex];
    if (!this.state.lastPlay) {
      const hand = this.hands.get(player.id) || [];
      const fallback = findBestPlay(hand, null, true, this.state.currentLevel);
      if (fallback) this.playCards(player.id, fallback.cards);
      else this.handlePass(player.id);
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
    this.state.spectators = this.getSpectatorList();
    this.state.teamLevels = [...this.teamLevels];
    this.state.leadingTeam = this.leadingTeam;
    this.emitToAll('game_state', this.state);
    this.emitSpectatorHands();
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
    for (const spectator of this.spectators.values()) {
      if (spectator.socket) {
        try { spectator.socket.emit(event, data); } catch (e) {}
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

  private emitSpectatorHands() {
    if (this.spectators.size === 0) return;
    const hands: SpectatorHands = {};
    for (const player of this.players) {
      hands[player.id] = this.getHand(player.id);
    }
    for (const spectator of this.spectators.values()) {
      if (!spectator.socket) continue;
      try { spectator.socket.emit('spectator_hands', hands); } catch (e) {}
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
      ownerId: this.ownerId,
      roomCode: this.id.slice(0, 8).toUpperCase(),
      phase: this.state?.phase || GamePhase.Waiting,
      spectatorCount: this.spectators.size,
      playerCount: this.players.filter(p => !p.isAI).length,
      maxPlayers: MAX_PLAYERS,
      level: this.currentLevel,
      hasPassword: !!this.password,
      aiCount: this.players.filter(p => p.isAI).length,
      aiProvider: this.aiModelSelection.provider,
      aiModel: this.aiModelSelection.model,
    };
  }

  private getSpectatorList(): SpectatorInfo[] {
    return Array.from(this.spectators.values(), spectator => ({
      id: spectator.id,
      name: spectator.name,
    }));
  }
}
