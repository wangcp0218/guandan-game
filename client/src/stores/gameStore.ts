import { create } from 'zustand';
import { GameState, RoomInfo, ChatMessage, RoundResult, Card, GamePhase } from '../sharedTypes';

interface AuthState {
  userId: string | null;
  username: string | null;
  token: string | null;
  level: number;
  isLoggedIn: boolean;
  setAuth: (userId: string, username: string, token: string, level: number) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  userId: null,
  username: null,
  token: null,
  level: 2,
  isLoggedIn: false,
  setAuth: (userId, username, token, level) =>
    set({ userId, username, token, level, isLoggedIn: true }),
  logout: () => set({ userId: null, username: null, token: null, level: 2, isLoggedIn: false }),
}));

interface GameStore {
  gameState: GameState | null;
  roomInfo: RoomInfo | null;
  mySeatIndex: number;
  myCards: Card[];
  selectedCardIds: Set<number>;
  messages: ChatMessage[];
  roundResult: RoundResult | null;

  setGameState: (state: GameState) => void;
  setRoomInfo: (info: RoomInfo) => void;
  setMySeatIndex: (idx: number) => void;
  setMyCards: (cards: Card[]) => void;
  toggleCardSelection: (cardId: number) => void;
  toggleCardStackSelection: (cardIds: number[]) => void;
  clearSelection: () => void;
  addMessage: (msg: ChatMessage) => void;
  setRoundResult: (result: RoundResult | null) => void;
  reset: () => void;
}

export const useGameStore = create<GameStore>((set) => ({
  gameState: null,
  roomInfo: null,
  mySeatIndex: -1,
  myCards: [],
  selectedCardIds: new Set(),
  messages: [],
  roundResult: null,

  setGameState: (state) => set({ gameState: state }),
  setRoomInfo: (info) => set({ roomInfo: info }),
  setMySeatIndex: (idx) => set({ mySeatIndex: idx }),
  setMyCards: (cards) => set({ myCards: cards }),
  toggleCardSelection: (cardId) =>
    set((s) => {
      const next = new Set(s.selectedCardIds);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return { selectedCardIds: next };
    }),
  toggleCardStackSelection: (cardIds) =>
    set((s) => {
      const next = new Set(s.selectedCardIds);
      const allSelected = cardIds.every((cardId) => next.has(cardId));
      for (const cardId of cardIds) {
        if (allSelected) next.delete(cardId);
        else next.add(cardId);
      }
      return { selectedCardIds: next };
    }),
  clearSelection: () => set({ selectedCardIds: new Set() }),
  addMessage: (msg) =>
    set((s) => ({ messages: [...s.messages.slice(-100), msg] })),
  setRoundResult: (result) => set({ roundResult: result }),
  reset: () =>
    set({
      gameState: null,
      roomInfo: null,
      mySeatIndex: -1,
      myCards: [],
      selectedCardIds: new Set(),
      messages: [],
      roundResult: null,
    }),
}));
