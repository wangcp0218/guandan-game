// Small helpers that survive page reloads and Socket.IO reconnects.
// Auth is persisted so a refresh does not silently log the player out; the
// active room is persisted so a dropped player can be routed back into a match.

export interface ActiveRoom {
  roomId: string;
  spectator: boolean;
}

const AUTH_KEY = 'oowsp.auth';
const ACTIVE_ROOM_KEY = 'oowsp.activeRoom';

export function readToken(): string | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    return JSON.parse(raw)?.token || null;
  } catch {
    return null;
  }
}

export function saveActiveRoom(room: ActiveRoom) {
  try {
    localStorage.setItem(ACTIVE_ROOM_KEY, JSON.stringify(room));
  } catch {}
}

export function clearActiveRoom() {
  try {
    localStorage.removeItem(ACTIVE_ROOM_KEY);
  } catch {}
}

export function readActiveRoom(): ActiveRoom | null {
  try {
    const raw = localStorage.getItem(ACTIVE_ROOM_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.roomId) {
      return { roomId: parsed.roomId, spectator: !!parsed.spectator };
    }
  } catch {}
  return null;
}
