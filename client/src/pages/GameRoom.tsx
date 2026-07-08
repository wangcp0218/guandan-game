import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuthStore, useGameStore } from '../stores/gameStore';
import { getSocket } from '../hooks/useSocket';
import { GameState, Card, PlayerInfo as PlayerInfoType, ChatMessage, RoundResult } from '../sharedTypes';
import HandCards from '../components/HandCards';
import CardComponent from '../components/CardComponent';
import PlayerInfoComponent from '../components/PlayerInfo';
import PlayArea from '../components/PlayArea';
import Chat from '../components/Chat';

const SEAT_POSITIONS = [
  { top: '15%', left: '50%', label: 'top' },
  { top: '50%', left: '10%', label: 'left' },
  { top: '50%', right: '10%', label: 'right' },
  { bottom: '18%', left: '50%', label: 'bottom' },
];

export default function GameRoom() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const { userId, isLoggedIn, logout } = useAuthStore();
  const {
    gameState, setGameState, mySeatIndex, setMySeatIndex,
    myCards, setMyCards, selectedCardIds, toggleCardSelection, clearSelection,
    messages, addMessage, roundResult, setRoundResult, reset,
  } = useGameStore();

  const [playHistory, setPlayHistory] = useState<{ playerId: string; playerName: string; pattern: any }[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [waiting, setWaiting] = useState(true);

  useEffect(() => {
    if (!isLoggedIn) {
      navigate('/');
      return;
    }

    const socket = getSocket();
    if (!socket) return;

    socket.emit('join_room', { roomId });

    const onGameState = (state: GameState) => {
      setGameState(state);
      setWaiting(state.phase === 'waiting');

      const myPlayer = state.players.find(p => p.id === userId);
      if (myPlayer) {
        setMySeatIndex(myPlayer.seatIndex);
      }
    };
    socket.on('game_state', onGameState);

    const onGameStarted = (state: GameState) => {
      setGameState(state);
      setWaiting(state.phase === 'waiting');
    };
    socket.on('game_started', onGameStarted);

    const onMyCards = (cards: Card[]) => {
      setMyCards(cards);
    };
    socket.on('your_cards', onMyCards);

    const onPlayerPlayed = (data: { playerId: string; playerName: string; pattern: any }) => {
      setPlayHistory(prev => [...prev, data]);
    };
    socket.on('player_played', onPlayerPlayed);

    const onPlayerPass = (data: { playerId: string }) => {
      // handled via game_state update
    };
    socket.on('player_pass', onPlayerPass);

    const onPlayerFinish = (data: { playerId: string; playerName: string; rank: number }) => {
      // handled via game_state
    };
    socket.on('player_finish', onPlayerFinish);

    const onRoundEnd = (result: RoundResult) => {
      setRoundResult(result);
    };
    socket.on('round_end', onRoundEnd);

    const onChat = (msg: ChatMessage) => {
      addMessage(msg);
    };
    socket.on('chat', onChat);

    const onError = (data: { message: string }) => {
      setErrorMsg(data.message);
      setTimeout(() => setErrorMsg(''), 3000);
    };
    socket.on('error', onError);

    const onPlayerJoined = (data: any) => {
      // refresh state
    };
    socket.on('player_joined', onPlayerJoined);

    const onHintResult = (data: { cards: Card[] }) => {
      clearSelection();
      for (const c of data.cards) {
        toggleCardSelection(c.id);
      }
    };
    socket.on('hint_result', onHintResult);

    return () => {
      socket.off('game_state', onGameState);
      socket.off('game_started', onGameStarted);
      socket.off('your_cards', onMyCards);
      socket.off('player_played', onPlayerPlayed);
      socket.off('player_pass', onPlayerPass);
      socket.off('player_finish', onPlayerFinish);
      socket.off('round_end', onRoundEnd);
      socket.off('chat', onChat);
      socket.off('error', onError);
      socket.off('player_joined', onPlayerJoined);
      socket.off('hint_result', onHintResult);
    };
  }, [roomId]);

  useEffect(() => {
    if (!gameState || !userId) return;

    const socket = getSocket();
    if (!socket) return;

    const loadInterval = setInterval(() => {
      const myPlayer = gameState.players.find(p => p.id === userId);
      if (myPlayer && myCards.length === 0) {
        socket.emit('request_my_cards', { roomId: gameState.roomId });
      }
    }, 500);

    return () => clearInterval(loadInterval);
  }, [gameState?.roomId, myCards.length]);

  const handlePlay = () => {
    if (selectedCardIds.size === 0) {
      handlePass();
      return;
    }

    const selected = myCards.filter(c => selectedCardIds.has(c.id));
    const socket = getSocket();
    socket?.emit('play_cards', { cards: selected });
    clearSelection();
  };

  const handlePass = () => {
    const socket = getSocket();
    socket?.emit('pass');
    clearSelection();
  };

  const handleChat = (content: string) => {
    const socket = getSocket();
    socket?.emit('chat', { content });
  };

  const handleLeaveRoom = () => {
    getSocket()?.emit('leave_room');
    reset();
    navigate('/lobby');
  };

  const handleLogout = () => {
    getSocket()?.emit('leave_room');
    reset();
    logout();
    navigate('/');
  };

  const isMyTurn = gameState?.currentPlayerIndex === mySeatIndex && gameState?.phase === 'playing';
  const currentLevel = gameState?.currentLevel || 2;

  const getPlayerForPosition = (posIdx: number): PlayerInfoType | null => {
    if (!gameState || mySeatIndex < 0) return null;
    const seatIdx = (mySeatIndex + posIdx) % 4;
    return gameState.players[seatIdx] || null;
  };

  return (
    <div style={styles.container}>
      <div style={styles.table}>
        {/* Top player */}
        <div style={{ ...styles.playerSpot, top: SEAT_POSITIONS[2].top, left: SEAT_POSITIONS[2].left, transform: 'translate(-50%, -50%)' }}>
          {getPlayerForPosition(2) && (
            <PlayerInfoComponent
              player={getPlayerForPosition(2)!}
              position="top"
              isCurrent={gameState?.currentPlayerIndex === (mySeatIndex + 2) % 4}
              isMe={getPlayerForPosition(2)!.id === userId}
              isPartner={getPlayerForPosition(2)!.id !== userId}
            />
          )}
        </div>

        {/* Left player */}
        <div style={{ ...styles.playerSpot, top: SEAT_POSITIONS[1].top, left: SEAT_POSITIONS[1].left, transform: 'translate(-50%, -50%)' }}>
          {getPlayerForPosition(1) && (
            <PlayerInfoComponent
              player={getPlayerForPosition(1)!}
              position="left"
              isCurrent={gameState?.currentPlayerIndex === (mySeatIndex + 1) % 4}
              isMe={getPlayerForPosition(1)!.id === userId}
              isPartner={false}
            />
          )}
        </div>

        {/* Right player */}
        <div style={{ ...styles.playerSpot, top: SEAT_POSITIONS[2].top, right: SEAT_POSITIONS[2].right, transform: 'translate(50%, -50%)' }}>
          {getPlayerForPosition(3) && (
            <PlayerInfoComponent
              player={getPlayerForPosition(3)!}
              position="right"
              isCurrent={gameState?.currentPlayerIndex === (mySeatIndex + 3) % 4}
              isMe={getPlayerForPosition(3)!.id === userId}
              isPartner={false}
            />
          )}
        </div>

        {/* Center - play area */}
        <div style={styles.centerArea}>
          {waiting ? (
            <div style={styles.waiting}>
              <p style={{ fontSize: 18, color: '#e6b422' }}>等待玩家加入...</p>
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>
                {gameState?.players.filter(p => p.isOnline || p.id).length || 0}/4 人
              </p>
            </div>
          ) : (
            <div style={{ textAlign: 'center' }}>
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', marginBottom: 8 }}>
                等级 {currentLevel}
              </p>
              <PlayArea lastPlay={gameState?.lastPlay || null} playHistory={playHistory} />
            </div>
          )}
        </div>

        {/* Bottom - my hand cards */}
        <div style={styles.bottomArea}>
          <div style={styles.actions}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{
                fontSize: 12,
                color: isMyTurn ? '#e6b422' : 'rgba(255,255,255,0.4)',
                fontWeight: 600,
              }}>
                {isMyTurn ? '轮到你了!' : '等待中...'}
              </span>
              {errorMsg && (
                <span style={{ color: '#ff6b6b', fontSize: 12 }}>{errorMsg}</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn-primary"
                onClick={handlePlay}
                disabled={!isMyTurn}
                style={{
                  opacity: isMyTurn ? 1 : 0.4,
                  padding: '8px 24px',
                  fontSize: 14,
                  fontWeight: 700,
                }}
              >
                出牌 ({selectedCardIds.size}张)
              </button>
              <button
                className="btn-secondary"
                onClick={() => { getSocket()?.emit('hint'); }}
                disabled={!isMyTurn}
                style={{
                  opacity: isMyTurn ? 1 : 0.3,
                  padding: '8px 16px',
                  fontSize: 14,
                  background: 'rgba(230,180,34,0.2)',
                  color: '#e6b422',
                  border: '1px solid rgba(230,180,34,0.4)',
                }}
              >
                提示
              </button>
              <button
                className="btn-secondary"
                onClick={handlePass}
                disabled={!isMyTurn || !gameState?.lastPlay}
                style={{
                  opacity: isMyTurn ? 1 : 0.3,
                  padding: '8px 20px',
                  fontSize: 14,
                }}
              >
                不出
              </button>
              <button
                className="btn-danger"
                onClick={handleLeaveRoom}
                style={{ padding: '8px 16px', fontSize: 12 }}
              >
                退出房间
              </button>
              <button
                className="btn-secondary"
                onClick={handleLogout}
                style={{ padding: '8px 16px', fontSize: 12 }}
              >
                退出登录
              </button>
            </div>
          </div>
          <HandCards
            cards={myCards}
            selectedIds={selectedCardIds}
            onToggle={toggleCardSelection}
            currentLevel={currentLevel}
          />
        </div>

        {/* Chat panel */}
        <div style={{
          position: 'absolute',
          right: 16,
          top: '50%',
          transform: 'translateY(-50%)',
          height: 300,
        }}>
          <Chat messages={messages} onSend={handleChat} />
        </div>

        {/* Round result modal */}
        {roundResult && (
          <div style={styles.modal}>
            <div style={styles.modalContent}>
              <h2 style={{ color: '#e6b422', marginBottom: 16 }}>
                本轮结束 - {roundResult.winnerTeam === mySeatIndex % 2 ? '你赢了!' : '你输了'}
              </h2>
              <p style={{ marginBottom: 8 }}>
                排名: {roundResult.rankings.map(r => {
                  const p = gameState?.players.find(pl => pl.id === r.playerId);
                  return `${p?.name || '?'} 第${r.rank}名`;
                }).join(' | ')}
              </p>
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', marginBottom: 16 }}>
                胜方升 {roundResult.winnerLevelDelta} 级
              </p>
              <button
                className="btn-primary"
                onClick={() => {
                  setRoundResult(null);
                  const socket = getSocket();
                  socket?.emit('start_next_round', { roomId });
                }}
                style={{ padding: '10px 30px', fontSize: 15 }}
              >
                下一局
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100vh',
    background: 'radial-gradient(ellipse at center, #1a6b42 0%, #0a4a2e 60%, #063318 100%)',
    overflow: 'hidden',
  },
  table: {
    position: 'relative',
    width: '100%',
    height: '100%',
  },
  playerSpot: {
    position: 'absolute',
  },
  centerArea: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
  },
  waiting: {
    textAlign: 'center',
  },
  bottomArea: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: '0 20px 12px',
  },
  actions: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  modal: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 200,
  },
  modalContent: {
    background: '#1a4a2e',
    borderRadius: 16,
    padding: 32,
    textAlign: 'center',
    boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
    border: '1px solid rgba(255,255,255,0.1)',
  },
};
