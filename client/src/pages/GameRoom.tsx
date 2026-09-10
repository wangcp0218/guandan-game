import { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore, useGameStore } from '../stores/gameStore';
import { getSocket } from '../hooks/useSocket';
import { GameState, Card, CardPattern, PlayerInfo as PlayerInfoType, RoundResult, SpectatorHands } from '../sharedTypes';
import HandCards from '../components/HandCards';
import PlayerInfoComponent from '../components/PlayerInfo';
import PlayArea, { PlayerAction } from '../components/PlayArea';

import SpectatorHand from '../components/SpectatorHand';
import CardComponent from '../components/CardComponent';

export default function GameRoom() {
  const patternName = (type: string) => ({ single: '单张', pair: '对子', triple: '三张', triple_pair: '三带二', straight: '顺子', consecutive_pair: '三连对', plane: '二连三', flush_straight: '同花顺', king_bomb: '四王炸' }[type] || type.replace('bomb', '炸弹·'));
  const { roomId } = useParams<{ roomId: string }>();
  const [searchParams] = useSearchParams();
  const spectatorMode = searchParams.get('spectator') === '1';
  const navigate = useNavigate();
  const { userId, isLoggedIn, logout } = useAuthStore();
  const {
    gameState, setGameState, mySeatIndex, setMySeatIndex,
    myCards, setMyCards, selectedCardIds, toggleCardSelection, toggleCardStackSelection, clearSelection,
    roundResult, setRoundResult, reset,
  } = useGameStore();

  const [playerActions, setPlayerActions] = useState<Record<string, PlayerAction>>({});
  const [errorMsg, setErrorMsg] = useState('');
  const [waiting, setWaiting] = useState(!gameState || gameState.phase === 'waiting');
  const [selectedSeatPlayerId, setSelectedSeatPlayerId] = useState<string | null>(null);
  const [spectatorHands, setSpectatorHands] = useState<SpectatorHands>({});
  const [tributeNotice, setTributeNotice] = useState('');
  const [declarations, setDeclarations] = useState<CardPattern[]>([]);
  const [spectatorDialogOpen, setSpectatorDialogOpen] = useState(false);

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
      setDeclarations([]);
      setWaiting(state.phase === 'waiting');
      if (state.phase !== 'round_end' && state.phase !== 'game_over') setRoundResult(null);
      else if (state.roundResult) setRoundResult(state.roundResult);

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
    if (selected.length > 1 && selected.some(card => card.rank === gameState?.currentLevel && card.suit === 'H')) {
      socket?.emit('declare_play', { cards: selected }, (options: CardPattern[]) => {
        if (!options.length) setErrorMsg('没有合法的逢人配组合可以出牌');
        else setDeclarations(options);
      });
      return;
    }
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
    ;
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
    <div className={`game-room${waiting ? ' is-waiting' : ''}${isSpectator ? ' is-spectator' : ''}`} style={styles.container}>
      <div className="game-table" style={styles.table}>
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
        <div className="game-top-actions">
          {!isSpectator && gameState?.phase !== 'round_end' && (
            <div className={`game-turn-status${isMyTurn ? ' is-my-turn' : ''}`}>
              <span>{turnMessage}</span>
              {errorMsg && <span className="game-turn-error">{errorMsg}</span>}
            </div>
          )}
          <button type="button" className="spectator-menu" onClick={() => setSpectatorDialogOpen(true)}>
            观战 {gameState?.spectators.length || 0}
          </button>
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
        </div>
        {tributeNotice && <div className="tribute-notice">{tributeNotice}</div>}

        {/* Top — 对家 (partner) */}
        <div className="player-seat player-seat--top">
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
        <div className="player-seat player-seat--left">
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
        <div className="player-seat player-seat--right">
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

        {/* Portrait rows follow: partner, left opponent, right opponent, self. */}
        {([2, 3, 1] as const).map(positionIndex => {
          const player = getPlayerForPosition(positionIndex);
          const position = positionIndex === 1 ? 'right' : positionIndex === 2 ? 'top' : 'left';
          return player ? (
            <div key={position} className={`played-zone played-zone--${position}`}>
              <PlayArea action={playerActions[player.id]} position={position} playerName={player.name} />
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
              {/* Desktop keeps the original personal play area.  The phone
                  layout below instead presents the current table play once,
                  in the centre of its dedicated grid cell. */}
              <div className="desktop-current-play">
                <PlayArea
                  action={getPlayerForPosition(0) ? playerActions[getPlayerForPosition(0)!.id] : undefined}
                  position="bottom"
                  playerName={getPlayerForPosition(0)?.name}
                />
              </div>
              <div className="mobile-current-play">
                <PlayArea
                  action={getPlayerForPosition(0) ? playerActions[getPlayerForPosition(0)!.id] : undefined}
                  position="bottom"
                  playerName={getPlayerForPosition(0)?.name}
                />
              </div>
            </div>
          )}
        </div>

        {/* Bottom - my hand cards */}
        {!isSpectator && <div className="game-bottom-area">
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
                    onClick={() => {
                      getSocket()?.emit('hint', { currentCardIds: [...selectedCardIds] });
                    }}
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
          <div className="hand-scroll"><HandCards
            cards={myCards}
            selectedIds={selectedCardIds}
            onToggle={toggleCardSelection}
            onToggleStack={toggleCardStackSelection}
            currentLevel={currentLevel}
          /></div>
        </div>}

        {spectatorDialogOpen && <div style={styles.modal} onClick={() => setSpectatorDialogOpen(false)}>
          <div className="spectator-dialog" style={styles.modalContent} onClick={event => event.stopPropagation()}>
            <h3>观察者列表（{gameState?.spectators.length || 0}）</h3>
            <div className="spectator-dialog-list">
              {!gameState?.spectators.length && <p>暂无观察者</p>}
              {gameState?.spectators.map(person => <div key={person.id}><span>{person.name}</span>
                {isRoomOwner && !isSpectator && <button className="btn-danger" onClick={() => getSocket()?.emit('kick_spectator', { spectatorId: person.id })}>移除</button>}
              </div>)}
            </div>
            <button className="btn-secondary" onClick={() => setSpectatorDialogOpen(false)}>关闭</button>
          </div>
        </div>}

        {/* Round result modal */}
        {declarations.length > 0 && <div style={styles.modal}><div style={{ ...styles.modalContent, maxHeight: '80vh', overflowY: 'auto' }}>
          <h3>确认逢人配替代方式</h3>
          {declarations.map(pattern => <button key={`${pattern.type}:${pattern.rank}`} className="btn-primary" style={{ display: 'block', margin: '8px auto' }} onClick={() => {
            getSocket()?.emit('play_cards', { cards: pattern.cards, declaration: { type: pattern.type, rank: pattern.rank } });
            setDeclarations([]); clearSelection();
          }}>{patternName(pattern.type)}（比较点数 {pattern.rank}）：{pattern.substitutions?.map(card => `${({ S: '♠', H: '♥', C: '♣', D: '♦' })[card.suit]}${card.rank}`).join('、')}</button>)}
          <button className="btn-secondary" onClick={() => setDeclarations([])}>取消</button>
        </div></div>}
        {roundResult && !isSpectator && (
          <div style={styles.modal}>
            <div style={styles.modalContent}>
              <h2 style={{ color: '#e6b422', marginBottom: 16 }}>
                {gameState?.phase === 'game_over' ? '比赛结束' : '本轮结束'} - {(roundResult.matchWinnerTeam ?? roundResult.winnerTeam) === mySeatIndex % 2 ? '你赢了!' : '你输了'}
              </h2>
              <p style={{ marginBottom: 8 }}>
                排名: {roundResult.rankings.map(r => {
                  const p = gameState?.players.find(pl => pl.id === r.playerId);
                  return `${p?.name || '?'} 第${r.rank}名`;
                }).join(' | ')}
              </p>
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', marginBottom: 16 }}>
                胜方升 {roundResult.winnerLevelDelta} 级
                {roundResult.levelPenalty ? `，触发地方规则退${roundResult.levelPenalty}级` : ''}
                {roundResult.endReason ? `；${roundResult.endReason}` : ''}
              </p>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 12 }}>
                <button
                  className="btn-primary"
                  onClick={() => {
                    setRoundResult(null);
                    const socket = getSocket();
                    socket?.emit('start_next_round', { roomId });
                  }}
                  style={{ padding: '10px 30px', fontSize: 15, display: gameState?.phase === 'game_over' ? 'none' : undefined }}
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
