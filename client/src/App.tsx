import { Routes, Route, Navigate } from 'react-router-dom';
import { useSocket } from './hooks/useSocket';
import Login from './pages/Login';
import Lobby from './pages/Lobby';
import GameRoom from './pages/GameRoom';

export default function App() {
  const { socket, connected } = useSocket();

  return (
    <Routes>
      <Route path="/" element={<Login />} />
      <Route path="/lobby" element={<Lobby />} />
      <Route path="/game/:roomId" element={<GameRoom />} />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}
