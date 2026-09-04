import { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore, useGameStore } from '../stores/gameStore';
import { getSocket } from '../hooks/useSocket';
import { GameState, Card, CardPattern, PlayerInfo as PlayerInfoType, ChatMessage, RoundResult, SpectatorHands } from '../sharedTypes';
import HandCards from '../components/HandCards';
import PlayerInfoComponent from '../components/PlayerInfo';
import PlayArea, { PlayerAction } from '../components/PlayArea';
import Chat from '../components/Chat';
import SpectatorHand from '../components/SpectatorHand';
import CardComponent from '../components/CardComponent';

export default function GameRoom() {
  const { roomId } = useParams<{ roomId: string }>();
  const [searchParams] = useSearchParams();
  const spectatorMode = searchParams.get('spectator') === '1';
  const navigate = useNavigate();
  const { userId, isLoggedIn, logout } = useAuthStore();
  const {
    gameState, setGameState, mySeatIndex, setMySeatIndex,
    myCards, setMyCards, selectedCardIds, toggleCardSelection, toggleCardStackSelection, clearSelection,
    messages, addMessage, roundResult, setRoundResult, reset,
  } = useGameStore();

  const [playerActions, setPlayerActions] = useState<Record<string, PlayerAction>>({});
  const [errorMsg, setErrorMsg] = useState('');
  const [waiting, setWaiting] = useState(true);
  const [selectedSeatPlayerId, setSelectedSeatPlayerId] = useState<string | null>(null);
  const [spectatorHands, setSpectatorHands] = useState<SpectatorHands>({});
  const [tributeNotice, setTributeNotice] = useState('');

  useEffect(() => {
    if (!isLoggedIn) {
      navigate('/');
      return;
    }

    const socket = getSocket();
    if (!socket) return;

    socket.emit(spectatorMode ? 'join_spectator' : 'join_room', { roomId });

    const onGameState = (state: GameState) => {
      setGameState(state);
      setWaiting(state.phase === 'waiting');
      if (state.phase !== 'round_end') setRoundResult(null);

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
      } else if (spectatorMode) {
        setMySeatIndex(-1);
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

    const onSpectatorHands = (hands: SpectatorHands) => {
      if (spectatorMode) setSpectatorHands(hands);
    };
    socket.on('spectator_hands', onSpectatorHands);

    const onTributeResisted = () => {
      setTributeNotice('抗贡！由上游先出牌');
      setTimeout(() => setTributeNotice(''), 3500);
    };
    socket.on('tribute_resisted', onTributeResisted);

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

    const onSpectatorRemoved = () => {
      reset();
      navigate('/lobby');
    };
    socket.on('spectator_removed', onSpectatorRemoved);

    return () => {
      socket.off('game_state', onGameState);
      socket.off('game_started', onGameStarted);
      socket.off('your_cards', onMyCards);
      socket.off('spectator_hands', onSpectatorHands);
      socket.off('tribute_resisted', onTributeResisted);
      socket.off('player_played', onPlayerPlayed);
      socket.off('player_pass', onPlayerPass);
      socket.off('player_finish', onPlayerFinish);
      socket.off('round_end', onRoundEnd);
      socket.off('chat', onChat);
      socket.off('error', onError);
      socket.off('player_joined', onPlayerJoined);
      socket.off('hint_result', onHintResult);
      socket.off('spectator_removed', onSpectatorRemoved);
    };
  }, [roomId, spectatorMode]);

  useEffect(() => {
    if (!gameState || !userId || spectatorMode) return;

    const socket = getSocket();
    if (!socket) return;

    const loadInterval = setInterval(() => {
      const myPlayer = gameState.players.find(p => p.id === userId);
      if (myPlayer && myCards.length === 0) {
        socket.emit('request_my_cards', { roomId: gameState.roomId });
      }
    }, 500);

    return () => clearInterval(loadInterval);
  }, [gameState?.roomId, myCards.length, spectatorMode]);

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

  const handleReturnTribute = () => {
    if (selectedCardIds.size !== 1) return;
    const card = myCards.find(item => selectedCardIds.has(item.id));
    if (!card) return;
    getSocket()?.emit('return_tribute', { card });
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

  const isSpectator = spectatorMode || gameState?.spectators.some(spectator => spectator.id === userId) || false;
  const displaySeatIndex = mySeatIndex >= 0 ? mySeatIndex : 0;
  const isMyTurn = !isSpectator && gameState?.currentPlayerIndex === mySeatIndex && gameState?.phase === 'playing';
  const currentLevel = gameState?.currentLevel || 2;
  const isRoomOwner = gameState?.ownerId === userId;
  const viewingTeam = displaySeatIndex % 2;
  const [teamALevel, teamBLevel] = gameState?.teamLevels || [2, 2];
  const ownLevel = viewingTeam === 0 ? teamALevel : teamBLevel;
  const opponentLevel = viewingTeam === 0 ? teamBLevel : teamALevel;
  const leadingTeam = gameState?.leadingTeam || 0;
  const ownIsLeading = leadingTeam === viewingTeam;
  const pendingTributeExchange = gameState?.tributeExchanges.find(exchange => exchange.returnCard === null) || null;
  const isMyReturnTribute = !isSpectator
    && gameState?.phase === 'return_tribute'
    && pendingTributeExchange?.toPlayerId === userId;
  const selectedReturnCard = selectedCardIds.size === 1
    ? myCards.find(card => selectedCardIds.has(card.id)) || null
    : null;
  const canReturnSelectedCard = !!selectedReturnCard
    && selectedReturnCard.rank <= 10
    && selectedReturnCard.rank !== currentLevel;
  const turnMessage = gameState?.phase === 'return_tribute'
    ? (isMyReturnTribute ? '请选择一张10及以下的牌还贡' : '等待对方还贡...')
    : (isMyTurn ? '轮到你了!' : '等待中...');

  const playerName = (playerId: string) =>
    gameState?.players.find(player => player.id === playerId)?.name || '未知玩家';

  const getPlayerForPosition = (posIdx: number): PlayerInfoType | null => {
    if (!gameState) return null;
    const seatIdx = (displaySeatIndex + posIdx) % 4;
    return gameState.players.find(player => player.seatIndex === seatIdx) || null;
  };

  const spectatorPositions = [
    { offset: 0, position: 'bottom' },
    { offset: 1, position: 'right' },
    { offset: 2, position: 'top' },
    { offset: 3, position: 'left' },
  ] as const;

  const handleSeatClick = (targetSeatIndex: number) => {
    if (!isRoomOwner || !gameState) return;
    const occupant = gameState.players.find(player => player.seatIndex === targetSeatIndex);
    if (!selectedSeatPlayerId) {
      if (occupant) setSelectedSeatPlayerId(occupant.id);
      return;
    }
    const selectedPlayer = gameState.players.find(player => player.id === selectedSeatPlayerId);
    if (selectedPlayer?.seatIndex === targetSeatIndex) {
      setSelectedSeatPlayerId(null);
      return;
    }
    getSocket()?.emit('move_player_seat', { playerId: selectedSeatPlayerId, targetSeatIndex });
    setSelectedSeatPlayerId(null);
  };

  return (
    <div className="game-room" style={styles.container}>
      <div style={styles.table}>
        <div className="duel-scoreboard" aria-label="双方当前级牌">
          <div className={`duel-score-team ${isSpectator ? (leadingTeam === 0 ? 'is-leading' : 'is-trailing') : (ownIsLeading ? 'is-leading' : 'is-trailing')}`}>
            <span>{isSpectator ? '队伍 A' : '我方'}</span>
            <strong>{isSpectator ? teamALevel : ownLevel}<em>级</em></strong>
          </div>
          <span className="duel-score-vs">VS</span>
          <div className={`duel-score-team ${isSpectator ? (leadingTeam === 1 ? 'is-leading' : 'is-trailing') : (ownIsLeading ? 'is-trailing' : 'is-leading')}`}>
            <span>{isSpectator ? '队伍 B' : '对方'}</span>
            <strong>{isSpectator ? teamBLevel : opponentLevel}<em>级</em></strong>
          </div>
          <div className="duel-score-meta">第 {gameState?.roundNumber || 0} 局 · {isSpectator ? `队伍 ${leadingTeam === 0 ? 'A' : 'B'} 在台` : `${ownIsLeading ? '我方' : '对方'}在台`}</div>
        </div>
        {!isSpectator && gameState?.phase !== 'round_end' && (
          <div className={`game-turn-status${isMyTurn ? ' is-my-turn' : ''}`}>
            <span>{turnMessage}</span>
            {errorMsg && <span className="game-turn-error">{errorMsg}</span>}
          </div>
        )}
        {tributeNotice && <div className="tribute-notice">{tributeNotice}</div>}
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
              isCurrent={gameState?.currentPlayerIndex === (displaySeatIndex + 2) % 4}
              isMe={!isSpectator && getPlayerForPosition(2)!.id === userId}
              isPartner={!isSpectator && getPlayerForPosition(2)!.id !== userId}
            />
          )}
        </div>

        {/* Left — 对手 */}
        <div style={{ position: 'absolute', top: '45%', left: '3%', transform: 'translateY(-50%)' }}>
          {getPlayerForPosition(3) && (
            <PlayerInfoComponent
              player={getPlayerForPosition(3)!}
              position="left"
              isCurrent={gameState?.currentPlayerIndex === (displaySeatIndex + 3) % 4}
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
              isCurrent={gameState?.currentPlayerIndex === (displaySeatIndex + 1) % 4}
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

        {/* Spectators receive a separate private snapshot and can inspect all four hands. */}
        {isSpectator && !waiting && spectatorPositions.map(({ offset, position }) => {
          const player = getPlayerForPosition(offset);
          return player ? (
            <SpectatorHand
              key={player.id}
              cards={spectatorHands[player.id] || []}
              playerName={player.name}
              position={position}
              currentLevel={currentLevel}
            />
          ) : null;
        })}

        {/* Bottom-left — myself */}
        <div className="self-player-seat">
          {getPlayerForPosition(0) && (
            <PlayerInfoComponent
              player={getPlayerForPosition(0)!}
              position="bottom"
              isCurrent={gameState?.currentPlayerIndex === displaySeatIndex}
              isMe={!isSpectator}
              isPartner={false}
            />
          )}
        </div>

        {/* Center - play area */}
        <div className="game-center-play-area">
          {waiting ? (
            <div className="waiting-seat-setup">
              <p className="waiting-seat-title">开局前排座</p>
              <p className="waiting-seat-help">
                {isRoomOwner ? '点击一位玩家，再点击目标座位即可交换；开始后座位锁定。' : '等待房主安排座位并开始牌局。'}
              </p>
              <div className="waiting-seat-grid">
                {[0, 1, 2, 3].map(seatIndex => {
                  const player = gameState?.players.find(item => item.seatIndex === seatIndex);
                  const isSelected = player?.id === selectedSeatPlayerId;
                  const teamLabel = seatIndex % 2 === 0 ? '队伍 A' : '队伍 B';
                  return (
                    <button
                      type="button"
                      key={seatIndex}
                      className={`waiting-seat${isSelected ? ' is-seat-selected' : ''}${player ? '' : ' is-seat-empty'}`}
                      onClick={() => handleSeatClick(seatIndex)}
                      disabled={!isRoomOwner}
                    >
                      <span>座位 {seatIndex + 1} · {teamLabel}</span>
                      <strong>{player ? player.name : '空位'}</strong>
                      <small>对家：座位 {((seatIndex + 2) % 4) + 1}</small>
                    </button>
                  );
                })}
              </div>
              {isRoomOwner && (
                <button
                  className="btn-primary waiting-start-button"
                  onClick={() => getSocket()?.emit('start_room')}
                >
                  开始牌局（自动补 AI）
                </button>
              )}
            </div>
          ) : gameState?.phase === 'return_tribute' ? (
            <div className="tribute-panel">
              <h3>进贡与还贡</h3>
              {gameState.tributeExchanges.map(exchange => (
                <div className="tribute-exchange" key={`${exchange.fromPlayerId}-${exchange.toPlayerId}`}>
                  <span>{playerName(exchange.fromPlayerId)}</span>
                  <CardComponent card={exchange.tributeCard} size="sm" isLevelCard={exchange.tributeCard.rank === currentLevel} />
                  <span className="tribute-arrow">进贡给</span>
                  <span>{playerName(exchange.toPlayerId)}</span>
                  <span className="tribute-return-label">还贡</span>
                  {exchange.returnCard
                    ? <CardComponent card={exchange.returnCard} size="sm" isLevelCard={exchange.returnCard.rank === currentLevel} />
                    : <span className="tribute-waiting">等待选择</span>}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ textAlign: 'center' }}>
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
        {!isSpectator && <div style={styles.bottomArea}>
          <div className="game-action-bar">
            <div className="game-play-actions">
              {gameState?.phase === 'return_tribute' ? (
                <button
                  className="btn-primary"
                  onClick={handleReturnTribute}
                  disabled={!isMyReturnTribute || !canReturnSelectedCard}
                  style={{ opacity: isMyReturnTribute && canReturnSelectedCard ? 1 : 0.4 }}
                >
                  {isMyReturnTribute ? `还贡 (${selectedCardIds.size}张)` : '等待还贡'}
                </button>
              ) : (
                <>
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
                </>
              )}
            </div>
          </div>
          <HandCards
            cards={myCards}
            selectedIds={selectedCardIds}
            onToggle={toggleCardSelection}
            onToggleStack={toggleCardStackSelection}
            currentLevel={currentLevel}
          />
        </div>}

        {/* Chat panel */}
        <div className="game-chat-panel">
          <Chat
            messages={messages}
            onSend={handleChat}
            spectators={gameState?.spectators || []}
            canManageSpectators={isRoomOwner && !isSpectator}
            onKickSpectator={(spectatorId) => getSocket()?.emit('kick_spectator', { spectatorId })}
          />
        </div>

        {/* Round result modal */}
        {roundResult && !isSpectator && (
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
              <div style={{ display: 'flex', justifyContent: 'center', gap: 12 }}>
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
                <button
                  className="btn-danger"
                  onClick={handleLeaveRoom}
                  style={{ padding: '10px 24px', fontSize: 15 }}
                >
                  退出房间
                </button>
              </div>
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
