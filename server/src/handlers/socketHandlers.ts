import { Server, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { RoomManager } from '../services/RoomManager';
import { GameRoom } from '../services/GameRoom';
import { createUser, findUserByUsername, findUserById, saveGameRecord } from '../db/database';
import { fetchAvailableAiModels, normalizeAiSelection } from '../engine/llmAi';
import type { AiProvider } from '../../../shared/types';

const JWT_SECRET = 'oowsp-game-server-secret-2024';
const roomManager = new RoomManager();

interface AuthSocket extends Socket {
  userId?: string;
  username?: string;
  currentRoomId?: string;
}

export function setupSocketHandlers(io: Server) {
  io.on('connection', (socket: AuthSocket) => {
    console.log(`Client connected: ${socket.id}`);

    socket.on('login', async (data: { username: string; password: string }) => {
      try {
        const user = findUserByUsername(data.username);
        if (!user) {
          socket.emit('login_error', { message: '用户不存在' });
          return;
        }
        const valid = bcrypt.compareSync(data.password, user.password_hash);
        if (!valid) {
          socket.emit('login_error', { message: '密码错误' });
          return;
        }
        const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
        socket.userId = user.id;
        socket.username = user.username;
        socket.emit('login_success', { token, userId: user.id, username: user.username, level: user.level });
      } catch (e: any) {
        socket.emit('login_error', { message: e.message });
      }
    });

    socket.on('register', async (data: { username: string; password: string }) => {
      try {
        const existing = findUserByUsername(data.username);
        if (existing) {
          socket.emit('register_error', { message: '用户名已存在' });
          return;
        }
        const hash = bcrypt.hashSync(data.password, 10);
        const id = createUser(data.username, hash);
        const token = jwt.sign({ userId: id, username: data.username }, JWT_SECRET, { expiresIn: '24h' });
        socket.userId = id;
        socket.username = data.username;
        socket.emit('register_success', { token, userId: id, username: data.username, level: 2 });
      } catch (e: any) {
        socket.emit('register_error', { message: e.message });
      }
    });

    socket.on('auth_token', (data: { token: string }) => {
      try {
        const decoded: any = jwt.verify(data.token, JWT_SECRET);
        socket.userId = decoded.userId;
        socket.username = decoded.username;
        const user = findUserById(decoded.userId);
        socket.emit('auth_success', { userId: user.id, username: user.username, level: user.level });
      } catch (e) {
        socket.emit('auth_error', { message: 'Token无效' });
      }
    });

    socket.on('get_ai_models', async (data: { provider?: AiProvider; requestId?: number }) => {
      const provider: AiProvider = data.provider === 'local' ? 'local' : 'deepseek';
      if (!socket.userId) {
        socket.emit('ai_models_result', {
          provider,
          requestId: data.requestId,
          models: [],
          error: '请先登录',
        });
        return;
      }
      try {
        const models = await fetchAvailableAiModels(provider);
        socket.emit('ai_models_result', { provider, requestId: data.requestId, models });
      } catch (error: any) {
        console.warn(`[AI models] ${provider}: ${error?.message || 'request failed'}`);
        socket.emit('ai_models_result', {
          provider,
          requestId: data.requestId,
          models: [],
          error: '无法获取模型列表，请检查服务配置',
        });
      }
    });

    socket.on('create_room', (data: { name: string; password?: string; aiProvider?: AiProvider; aiModel?: string; maxRounds?: number; maxMinutes?: number; tripleDoublePenalty?: boolean }) => {
      if (!socket.userId) {
        socket.emit('error', { message: '请先登录' });
        return;
      }
      const aiModelSelection = normalizeAiSelection(data.aiProvider, data.aiModel);
      if (!aiModelSelection.model) {
        socket.emit('error', { message: '请选择 AI 模型' });
        return;
      }
      const room = roomManager.createRoom(data.name, socket.userId, data.password || '', aiModelSelection);
      const bounded = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10000 ? value : 0;
      room.competition = { maxRounds: bounded(data.maxRounds), maxMinutes: bounded(data.maxMinutes), tripleDoublePenalty: data.tripleDoublePenalty === true };
      socket.emit('room_created', room.toRoomInfo());
      socket.emit('room_list', roomManager.getRoomList());
    });

    socket.on('join_room', (data: { roomId: string; password?: string }) => {
      if (!socket.userId) {
        socket.emit('error', { message: '请先登录' });
        return;
      }

      if (socket.currentRoomId === data.roomId) {
        const currentRoom = roomManager.getRoom(data.roomId);
        if (currentRoom) {
          if (currentRoom.hasSpectator(socket.userId)) {
            socket.emit('error', { message: '当前正在观战，不能作为玩家加入' });
            return;
          }
          const user = findUserById(socket.userId);
          const idx = currentRoom.addPlayer(socket.userId, socket.username || 'Player', user?.level || 2, socket);
          socket.emit('room_joined', { room: currentRoom.toRoomInfo(), seatIndex: idx });
          if (!currentRoom.state || currentRoom.state.phase === 'waiting') {
            currentRoom.syncWaitingState();
          } else {
            currentRoom.broadcastState();
          }
        }
        return;
      }

      if (socket.currentRoomId) {
        handleLeaveRoom(socket, io);
      }

      const room = roomManager.getRoom(data.roomId);
      if (!room) {
        socket.emit('error', { message: '房间不存在' });
        return;
      }
      if (room.password && room.password !== (data.password || '')) {
        socket.emit('error', { message: '房间密码错误' });
        return;
      }

      const user = findUserById(socket.userId);
      const alreadyInRoom = room.hasPlayer(socket.userId);
      const idx = room.addPlayer(socket.userId, socket.username || 'Player', user?.level || 2, socket);
      if (idx < 0) {
        socket.emit('error', { message: '房间已满' });
        return;
      }

      socket.join(room.id);
      socket.currentRoomId = room.id;

      socket.emit('room_joined', { room: room.toRoomInfo(), seatIndex: idx });
      if (!alreadyInRoom && (!room.state || room.state.phase === 'waiting')) {
        io.to(room.id).emit('player_joined', {
          playerId: socket.userId,
          playerName: socket.username,
          seatIndex: idx,
        });
      }

      // Keep the room in the seating phase until the host explicitly starts.
      room.syncWaitingState();
    });

    socket.on('join_spectator', (data: { roomId: string; password?: string }) => {
      if (!socket.userId) {
        socket.emit('error', { message: '请先登录' });
        return;
      }
      if (socket.currentRoomId && socket.currentRoomId !== data.roomId) {
        handleLeaveRoom(socket, io);
      }
      const room = roomManager.getRoom(data.roomId);
      if (!room) {
        socket.emit('error', { message: '房间不存在' });
        return;
      }
      if (room.password && room.password !== (data.password || '')) {
        socket.emit('error', { message: '房间密码错误' });
        return;
      }
      const result = room.addSpectator(socket.userId, socket.username || '观战者', socket);
      if (!result.success) {
        socket.emit('error', { message: result.error });
        return;
      }
      socket.join(room.id);
      socket.currentRoomId = room.id;
      socket.emit('spectator_joined', { room: room.toRoomInfo() });
      io.emit('room_list', roomManager.getRoomList());
    });

    socket.on('move_player_seat', (data: { playerId?: string; targetSeatIndex?: number }) => {
      if (!socket.userId || !socket.currentRoomId || !data.playerId || !Number.isInteger(data.targetSeatIndex)) return;
      const room = roomManager.getRoom(socket.currentRoomId);
      if (!room) return;
      const result = room.movePlayerToSeat(socket.userId, data.playerId, data.targetSeatIndex as number);
      if (!result.success) socket.emit('error', { message: result.error });
    });

    socket.on('start_room', () => {
      if (!socket.userId || !socket.currentRoomId) return;
      const room = roomManager.getRoom(socket.currentRoomId);
      if (!room) return;
      const result = room.startByOwner(socket.userId);
      if (!result.success) socket.emit('error', { message: result.error });
      else io.emit('room_list', roomManager.getRoomList());
    });

    socket.on('kick_spectator', (data: { spectatorId?: string }) => {
      if (!socket.userId || !socket.currentRoomId || !data.spectatorId) return;
      const room = roomManager.getRoom(socket.currentRoomId);
      if (!room) return;
      const result = room.removeSpectatorByOwner(socket.userId, data.spectatorId);
      if (!result.success) {
        socket.emit('error', { message: result.error });
        return;
      }
      result.socket?.leave(room.id);
      if (result.socket) result.socket.currentRoomId = undefined;
      result.socket?.emit('spectator_removed');
      io.emit('room_list', roomManager.getRoomList());
    });

    socket.on('leave_room', () => {
      handleLeaveRoom(socket, io);
    });

    socket.on('room_list', () => {
      socket.emit('room_list', roomManager.getRoomList());
    });

    socket.on('hint', () => {
      if (!socket.userId || !socket.currentRoomId) return;
      const room = roomManager.getRoom(socket.currentRoomId);
      if (!room) return;
      const cards = room.getHintCards(socket.userId);
      socket.emit('hint_result', { cards });
    });

    socket.on('declare_play', (data: { cards: any[] }, reply: any) => {
      if (typeof reply !== 'function') return;
      const room = socket.currentRoomId && roomManager.getRoom(socket.currentRoomId);
      reply(room && socket.userId ? room.getPlayDeclarations(socket.userId, data.cards) : []);
    });

    socket.on('play_cards', (data: { cards: any[]; declaration?: any }) => {
      if (!socket.userId || !socket.currentRoomId) return;
      const room = roomManager.getRoom(socket.currentRoomId);
      if (!room) return;
      const result = room.playCards(socket.userId, data.cards, data.declaration);
      if (!result.success) {
        socket.emit('error', { message: result.error });
      }
    });

    socket.on('pass', () => {
      if (!socket.userId || !socket.currentRoomId) return;
      const room = roomManager.getRoom(socket.currentRoomId);
      if (!room) return;
      const result = room.playCards(socket.userId, []);
      if (!result.success) {
        socket.emit('error', { message: result.error });
      }
    });

    socket.on('request_my_cards', () => {
      if (!socket.userId || !socket.currentRoomId) return;
      const room = roomManager.getRoom(socket.currentRoomId);
      if (!room) return;
      socket.emit('your_cards', room.getHand(socket.userId));
    });

    socket.on('start_next_round', () => {
      if (!socket.userId || !socket.currentRoomId) return;
      const room = roomManager.getRoom(socket.currentRoomId);
      if (!room) return;
      const result = room.startNextRound(socket.userId);
      if (!result.success) socket.emit('error', { message: result.error });
    });

    socket.on('return_tribute', (data: { card?: any }) => {
      if (!socket.userId || !socket.currentRoomId || !data.card) return;
      const room = roomManager.getRoom(socket.currentRoomId);
      if (!room) return;
      const result = room.returnTribute(socket.userId, data.card);
      if (!result.success) socket.emit('error', { message: result.error });
    });


    socket.on('disconnect', () => {
      handleLeaveRoom(socket, io);
      console.log(`Client disconnected: ${socket.id}`);
    });
  });
}

function handleLeaveRoom(socket: AuthSocket, io: Server) {
  if (!socket.userId || !socket.currentRoomId) return;

  const room = roomManager.getRoom(socket.currentRoomId);
  if (room) {
    if (room.hasSpectator(socket.userId)) {
      room.removeSpectator(socket.userId);
      socket.leave(socket.currentRoomId);
      io.emit('room_list', roomManager.getRoomList());
      socket.currentRoomId = undefined;
      return;
    }
    room.removePlayer(socket.userId);
    socket.leave(socket.currentRoomId);
    io.to(socket.currentRoomId).emit('player_left', {
      playerId: socket.userId,
      playerName: socket.username,
    });

    if (room.getHumanPlayerCount() === 0) {
      for (const spectatorSocket of room.removeAllSpectators()) {
        spectatorSocket.leave(socket.currentRoomId);
        spectatorSocket.currentRoomId = undefined;
        spectatorSocket.emit('spectator_removed');
      }
      room.clearPlayers();
      roomManager.removeRoom(socket.currentRoomId);
    }
    io.emit('room_list', roomManager.getRoomList());
  }
  socket.currentRoomId = undefined;
}
