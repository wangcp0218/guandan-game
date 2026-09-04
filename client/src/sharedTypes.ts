export enum Suit {
  Spade = 'S',
  Heart = 'H',
  Club = 'C',
  Diamond = 'D',
}

export enum Rank {
  Two = 2,
  Three = 3,
  Four = 4,
  Five = 5,
  Six = 6,
  Seven = 7,
  Eight = 8,
  Nine = 9,
  Ten = 10,
  Jack = 11,
  Queen = 12,
  King = 13,
  Ace = 14,
  SmallJoker = 15,
  BigJoker = 16,
}

export interface Card {
  id: number;
  suit: Suit;
  rank: Rank;
}

export enum PatternType {
  Single = 'single',
  Pair = 'pair',
  Triple = 'triple',
  TriplePair = 'triple_pair',
  Straight = 'straight',
  ConsecutivePair = 'consecutive_pair',
  Plane = 'plane',
  PlaneWings = 'plane_wings',
  Bomb4 = 'bomb4',
  Bomb5 = 'bomb5',
  Bomb6 = 'bomb6',
  Bomb7 = 'bomb7',
  Bomb8 = 'bomb8',
  KingBomb = 'king_bomb',
  FlushStraight = 'flush_straight',
}

export interface CardPattern {
  type: PatternType;
  cards: Card[];
  rank: Rank;
  length: number;
}

export enum GamePhase {
  Waiting = 'waiting',
  Tribute = 'tribute',
  ReturnTribute = 'return_tribute',
  Playing = 'playing',
  RoundEnd = 'round_end',
  GameOver = 'game_over',
}

export interface PlayerInfo {
  id: string;
  name: string;
  level: number;
  seatIndex: number;
  cardCount: number;
  isReady: boolean;
  isOnline: boolean;
}

export interface SpectatorInfo {
  id: string;
  name: string;
}

export type AiProvider = 'deepseek' | 'local';

export interface AiModelSelection {
  provider: AiProvider;
  model: string;
}

export interface RoomInfo {
  id: string;
  name: string;
  ownerId: string;
  roomCode: string;
  phase: GamePhase;
  spectatorCount: number;
  playerCount: number;
  maxPlayers: number;
  level: number;
  hasPassword: boolean;
  aiCount: number;
  aiProvider: AiProvider;
  aiModel: string;
}

export interface GameState {
  roomId: string;
  ownerId: string;
  spectators: SpectatorInfo[];
  phase: GamePhase;
  currentLevel: number;
  teamLevels: [number, number];
  leadingTeam: 0 | 1;
  players: PlayerInfo[];
  currentPlayerIndex: number;
  lastPlay: CardPattern | null;
  lastPlayPlayerIndex: number;
  passCount: number;
  tributeTo: number | null;
  tributeCard: Card | null;
  returnTributeCards: Card[] | null;
  redHeartIndex: number;
  roundNumber: number;
}

export interface PlayRequest {
  playerId: string;
  cards: Card[];
  patternType?: PatternType;
}

export interface TributeRequest {
  playerId: string;
  card: Card;
}

export interface ReturnTributeRequest {
  playerId: string;
  cards: Card[];
}

export interface RoundResult {
  rankings: { playerId: string; rank: number }[];
  winnerTeam: number;
  loserTeam: number;
  winnerLevelDelta: number;
}

export interface ChatMessage {
  playerId: string;
  playerName: string;
  content: string;
  timestamp: number;
}
