import { GameRoom } from './GameRoom';
import { RoomInfo } from '../../../shared/types';

export class RoomManager {
  private rooms: Map<string, GameRoom> = new Map();

  createRoom(name: string, password: string = ''): GameRoom {
    const room = new GameRoom(name, password);
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
