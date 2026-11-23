import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '../stores/gameStore';
import { readToken } from '../utils/session';

let globalSocket: Socket | null = null;

function createSocket(): Socket {
  const socket = io(window.location.origin, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    // Keep retrying through long network outages instead of giving up after 10s.
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    randomizationFactor: 0.5,
    timeout: 20000,
  });

  // The server keeps authentication per connection, so a reconnected socket
  // arrives unauthenticated. Re-send the stored token on every connect.
  socket.on('connect', () => {
    const token = readToken();
    if (token) socket.emit('auth_token', { token });
  });

  // A stored token may have expired; clear it so the user returns to login.
  socket.on('auth_error', () => {
    try {
      localStorage.removeItem('oowsp.auth');
    } catch {}
    useAuthStore.getState().logout();
  });

  return socket;
}

export function getSocket(): Socket {
  if (!globalSocket) globalSocket = createSocket();
  return globalSocket;
}

export function useSocket() {
  const socketRef = useRef<Socket | null>(null);
  if (!socketRef.current) socketRef.current = getSocket();
  const [connected, setConnected] = useState(socketRef.current.connected);

  useEffect(() => {
    const socket = socketRef.current!;
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    setConnected(socket.connected);
    return () => {
      // Keep the socket alive across navigation; only detach local listeners.
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, []);

  return {
    socket: socketRef.current,
    connected,
  };
}
