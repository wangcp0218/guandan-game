import { GameRoom } from './GameRoom';
import { AiModelSelection, RoomInfo } from '../../../shared/types';
import { DEFAULT_AI_SELECTION } from '../engine/llmAi';

export class RoomManager {
  private rooms: Map<string, GameRoom> = new Map();

  createRoom(
    name: string,
    ownerId: string,
    password: string = '',
    aiModelSelection: AiModelSelection = DEFAULT_AI_SELECTION,
    aiUseLLM: boolean = false,
  ): GameRoom {
    const room = new GameRoom(name, ownerId, password, aiModelSelection, aiUseLLM);
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
      .filter(r => r.getHumanPlayerCount() > 0)
      .map(r => r.toRoomInfo());
  }
}
