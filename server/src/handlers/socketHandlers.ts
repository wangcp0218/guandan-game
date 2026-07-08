import { Server, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { RoomManager } from '../services/RoomManager';
import { GameRoom } from '../services/GameRoom';
import { createUser, findUserByUsername, findUserById, saveGameRecord } from '../db/database';

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

    socket.on('create_room', (data: { name: string; password?: string; aiCount?: number }) => {
      if (!socket.userId) {
        socket.emit('error', { message: '请先登录' });
        return;
      }
      const room = roomManager.createRoom(data.name, data.password || '', data.aiCount || 0);
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
          const user = findUserById(socket.userId);
          const idx = currentRoom.addPlayer(socket.userId, socket.username || 'Player', user?.level || 2, socket);
          socket.emit('room_joined', { room: currentRoom.toRoomInfo(), seatIndex: idx });
          currentRoom.syncWaitingState();
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

      room.fillWithAI();

      if (room.canStart()) {
        room.startGame();
      } else {
        room.syncWaitingState();
      }
    });

    socket.on('leave_room', () => {
      handleLeaveRoom(socket, io);
    });

    socket.on('room_list', () => {
      socket.emit('room_list', roomManager.getRoomList());
    });

    socket.on('play_cards', (data: { cards: any[] }) => {
      if (!socket.userId || !socket.currentRoomId) return;
      const room = roomManager.getRoom(socket.currentRoomId);
      if (!room) return;
      const result = room.playCards(socket.userId, data.cards);
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
      if (!socket.currentRoomId) return;
      const room = roomManager.getRoom(socket.currentRoomId);
      if (!room) return;
      room.startNextRound();
    });

    socket.on('chat', (data: { content: string }) => {
      if (!socket.userId || !socket.currentRoomId) return;
      io.to(socket.currentRoomId).emit('chat', {
        playerId: socket.userId,
        playerName: socket.username,
        content: data.content,
        timestamp: Date.now(),
      });
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
    room.removePlayer(socket.userId);
    socket.leave(socket.currentRoomId);
    io.to(socket.currentRoomId).emit('player_left', {
      playerId: socket.userId,
      playerName: socket.username,
    });

    if (room.getHumanPlayerCount() === 0) {
      room.clearPlayers();
      roomManager.removeRoom(socket.currentRoomId);
    }
  }
  socket.currentRoomId = undefined;
}
