import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

let globalSocket: Socket | null = null;

export function getSocket(): Socket | null {
  return globalSocket;
}

export function useSocket() {
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (globalSocket) {
      socketRef.current = globalSocket;
      setConnected(globalSocket.connected);
      return;
    }

    const socket = io(window.location.origin, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    socket.on('connect', () => {
      setConnected(true);
      globalSocket = socket;
    });

    socket.on('disconnect', () => setConnected(false));

    socketRef.current = socket;
    globalSocket = socket;

    return () => {
      // don't disconnect on unmount to keep socket alive
    };
  }, []);

  return {
    socket: socketRef.current,
    connected,
  };
}
