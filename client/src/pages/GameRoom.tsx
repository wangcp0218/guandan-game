import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuthStore, useGameStore } from '../stores/gameStore';
import { getSocket } from '../hooks/useSocket';
import { GameState, Card, CardPattern, PlayerInfo as PlayerInfoType, ChatMessage, RoundResult } from '../sharedTypes';
import HandCards from '../components/HandCards';
import PlayerInfoComponent from '../components/PlayerInfo';
import PlayArea, { PlayerAction } from '../components/PlayArea';
import Chat from '../components/Chat';

export default function GameRoom() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const { userId, isLoggedIn, logout } = useAuthStore();
  const {
    gameState, setGameState, mySeatIndex, setMySeatIndex,
    myCards, setMyCards, selectedCardIds, toggleCardSelection, clearSelection,
    messages, addMessage, roundResult, setRoundResult, reset,
  } = useGameStore();

  const [playerActions, setPlayerActions] = useState<Record<string, PlayerAction>>({});
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

      setPlayerActions(previous => {
        if (!state.lastPlay || state.lastPlayPlayerIndex < 0 || state.passCount >= 3) return {};
        const lastPlayer = state.players[state.lastPlayPlayerIndex];
        if (!lastPlayer || previous[lastPlayer.id]?.type === 'play') return previous;
        return {
          ...previous,
          [lastPlayer.id]: { type: 'play', pattern: state.lastPlay },
        };
      });

      const myPlayer = state.players.find(p => p.id === userId);
      if (myPlayer) {
        setMySeatIndex(myPlayer.seatIndex);
      }
    };
    socket.on('game_state', onGameState);

    const onGameStarted = (state: GameState) => {
      setGameState(state);
      setWaiting(state.phase === 'waiting');
      setPlayerActions({});
    };
    socket.on('game_started', onGameStarted);

    const onMyCards = (cards: Card[]) => {
      setMyCards(cards);
    };
    socket.on('your_cards', onMyCards);

    const onPlayerPlayed = (data: { playerId: string; playerName: string; pattern: CardPattern }) => {
      setPlayerActions(previous => ({
        ...previous,
        [data.playerId]: { type: 'play', pattern: data.pattern },
      }));
    };
    socket.on('player_played', onPlayerPlayed);

    const onPlayerPass = (data: { playerId: string }) => {
      setPlayerActions(previous => ({
        ...previous,
        [data.playerId]: { type: 'pass' },
      }));
    };
    socket.on('player_pass', onPlayerPass);

    const onPlayerFinish = (data: { playerId: string; playerName: string; rank: number }) => {
      // handled via game_state
    };
    socket.on('player_finish', onPlayerFinish);

    const onRoundEnd = (result: RoundResult) => {
      setRoundResult(result);
      setPlayerActions({});
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
        <div className="room-exit-actions">
          <button
            className="btn-danger"
            onClick={handleLeaveRoom}
          >
            退出房间
          </button>
          <button
            className="btn-secondary"
            onClick={handleLogout}
          >
            退出登录
          </button>
        </div>

        {/* Top — 对家 (partner) */}
        <div style={{ position: 'absolute', top: '8%', left: '50%', transform: 'translateX(-50%)' }}>
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

        {/* Left — 对手 */}
        <div style={{ position: 'absolute', top: '45%', left: '3%', transform: 'translateY(-50%)' }}>
          {getPlayerForPosition(3) && (
            <PlayerInfoComponent
              player={getPlayerForPosition(3)!}
              position="left"
              isCurrent={gameState?.currentPlayerIndex === (mySeatIndex + 3) % 4}
              isMe={getPlayerForPosition(3)!.id === userId}
              isPartner={false}
            />
          )}
        </div>

        {/* Right — 对手 */}
        <div style={{ position: 'absolute', top: '45%', right: '3%', transform: 'translateY(-50%)' }}>
          {getPlayerForPosition(1) && (
            <PlayerInfoComponent
              player={getPlayerForPosition(1)!}
              position="right"
              isCurrent={gameState?.currentPlayerIndex === (mySeatIndex + 1) % 4}
              isMe={getPlayerForPosition(1)!.id === userId}
              isPartner={false}
            />
          )}
        </div>

        {/* Each player's latest action stays near their seat for clear ownership. */}
        {([1, 2, 3] as const).map(positionIndex => {
          const player = getPlayerForPosition(positionIndex);
          const position = positionIndex === 1 ? 'right' : positionIndex === 2 ? 'top' : 'left';
          return player ? (
            <div key={position} style={styles[`${position}Action`]}>
              <PlayArea action={playerActions[player.id]} position={position} />
            </div>
          ) : null;
        })}

        {/* Bottom-left — myself */}
        <div className="self-player-seat">
          {getPlayerForPosition(0) && (
            <PlayerInfoComponent
              player={getPlayerForPosition(0)!}
              position="bottom"
              isCurrent={gameState?.currentPlayerIndex === mySeatIndex}
              isMe
              isPartner={false}
            />
          )}
        </div>

        {/* Center - play area */}
        <div className="game-center-play-area">
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
              {getPlayerForPosition(0) && (
                <PlayArea
                  action={playerActions[getPlayerForPosition(0)!.id]}
                  position="bottom"
                />
              )}
            </div>
          )}
        </div>

        {/* Bottom - my hand cards */}
        <div style={styles.bottomArea}>
          <div className="game-action-bar">
            <div className="game-turn-status">
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
            <div className="game-play-actions">
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
            </div>
            <div className="game-action-spacer" aria-hidden="true" />
          </div>
          <HandCards
            cards={myCards}
            selectedIds={selectedCardIds}
            onToggle={toggleCardSelection}
            currentLevel={currentLevel}
          />
        </div>

        {/* Chat panel */}
        <div className="game-chat-panel">
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
  topAction: {
    position: 'absolute',
    top: '21%',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 10,
  },
  leftAction: {
    position: 'absolute',
    top: '39%',
    left: '15%',
    transform: 'translateY(-50%)',
    zIndex: 10,
  },
  rightAction: {
    position: 'absolute',
    top: '39%',
    right: '20%',
    transform: 'translateY(-50%)',
    zIndex: 10,
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
