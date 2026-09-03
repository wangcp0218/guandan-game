import { GameRoom } from './GameRoom';
import { AiModelSelection, RoomInfo } from '../../../shared/types';
import { DEFAULT_AI_SELECTION } from '../engine/llmAi';

export class RoomManager {
  private rooms: Map<string, GameRoom> = new Map();

  createRoom(
    name: string,
    password: string = '',
    aiCount: number = 0,
    aiModelSelection: AiModelSelection = DEFAULT_AI_SELECTION,
  ): GameRoom {
    const room = new GameRoom(name, password, aiCount, aiModelSelection);
    this.rooms.set(room.id, room);
    return room;
  }

  getRoom(id: string): GameRoom | undefined {
    return this.rooms.get(id);
  }

  removeRoom(id: string) {
    this.rooms.delete(id);
  }

  getRoomList(): RoomInfo[] {
    return Array.from(this.rooms.values())
      .filter(r => r.getPlayerCount() < 4)
      .map(r => r.toRoomInfo());
  }
}
