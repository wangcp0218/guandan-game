import { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { useAuthStore, useGameStore } from '../stores/gameStore';
import { getSocket } from '../hooks/useSocket';
import { GameState, GamePhase, Card, CardPattern, PlayerInfo as PlayerInfoType, RoundResult, SpectatorHands } from '../sharedTypes';
import HandCards from '../components/HandCards';
import PlayerInfoComponent from '../components/PlayerInfo';
import PlayArea, { PlayerAction } from '../components/PlayArea';

import SpectatorHand from '../components/SpectatorHand';
import CardComponent from '../components/CardComponent';

type InviteRelation = 'partner' | 'opponent';

export default function GameRoom() {
  const patternName = (type: string) => ({ single: '单张', pair: '对子', triple: '三张', triple_pair: '三带二', straight: '顺子', consecutive_pair: '三连对', plane: '二连三', flush_straight: '同花顺', king_bomb: '四王炸' }[type] || type.replace('bomb', '炸弹·'));
  const { roomId } = useParams<{ roomId: string }>();
  const [searchParams] = useSearchParams();
  const spectatorMode = searchParams.get('spectator') === '1';
  const inviteInviterId = searchParams.get('inviter');
  const requiresRelationChoice = searchParams.get('invite') === '1' && !!inviteInviterId && !spectatorMode;
  const navigate = useNavigate();
  const location = useLocation();
  const { userId, isLoggedIn, logout } = useAuthStore();
  const {
    gameState, setGameState, mySeatIndex, setMySeatIndex,
    myCards, setMyCards, selectedCardIds, toggleCardSelection, toggleCardStackSelection, clearSelection,
    roundResult, setRoundResult, reset,
  } = useGameStore();

  const [landscapeMode, setLandscapeMode] = useState(() => {
    try { return localStorage.getItem('guandan-landscape') === '1'; } catch { return false; }
  });
  const toggleLandscape = () => {
    const next = !landscapeMode;
    setLandscapeMode(next);
    try { localStorage.setItem('guandan-landscape', next ? '1' : '0'); } catch { /* Storage is optional. */ }
  };

  const [playerActions, setPlayerActions] = useState<Record<string, PlayerAction>>({});
  const [errorMsg, setErrorMsg] = useState('');
  const [reportNotice, setReportNotice] = useState('');
  const [waiting, setWaiting] = useState(!gameState || gameState.phase === 'waiting');
  const [selectedSeatPlayerId, setSelectedSeatPlayerId] = useState<string | null>(null);
  const [spectatorHands, setSpectatorHands] = useState<SpectatorHands>({});
  const [tributeNotice, setTributeNotice] = useState('');
  const [declarations, setDeclarations] = useState<CardPattern[]>([]);
  const [spectatorDialogOpen, setSpectatorDialogOpen] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  const [actionSecondsLeft, setActionSecondsLeft] = useState<number | null>(null);
  const [inviteNotice, setInviteNotice] = useState('');
  const [joinPassword, setJoinPassword] = useState('');
  const [joinPasswordError, setJoinPasswordError] = useState('');
  const [passwordPromptOpen, setPasswordPromptOpen] = useState(false);
  const [preferredRelation, setPreferredRelation] = useState<InviteRelation | null>(null);
  const [relationPromptOpen, setRelationPromptOpen] = useState(requiresRelationChoice);
  const [relationError, setRelationError] = useState('');

  const buildShareUrl = () => {
    const url = new URL(`game/${encodeURIComponent(roomId || '')}`, new URL(import.meta.env.BASE_URL, window.location.origin));
    url.searchParams.set('invite', '1');
    if (waiting && userId) url.searchParams.set('inviter', userId);
    if (!waiting) url.searchParams.set('spectator', '1');
    return url.toString();
  };

  const copyInviteLink = async (url: string) => {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(url);
  };

  const handleShareRoom = async () => {
    const url = buildShareUrl();
    const shareData = {
      title: waiting ? '加入我的掼蛋牌局' : '观看我的掼蛋牌局',
      text: waiting ? '点击链接登录后加入房间，房主开局时会自动补 AI。' : '点击链接登录后进入房间观战。',
      url,
    };
    try {
      if (navigator.share) {
        await navigator.share(shareData);
        setInviteNotice('邀请已打开，可以发送给朋友');
      } else {
        await copyInviteLink(url);
        setInviteNotice('邀请链接已复制');
      }
    } catch (error: any) {
      if (error?.name === 'AbortError') return;
      try {
        await copyInviteLink(url);
        setInviteNotice('邀请链接已复制');
      } catch {
        setInviteNotice(`复制失败，请分享当前地址：${url}`);
      }
    }
  };

  const submitRoomPassword = () => {
    if (!joinPassword.trim()) {
      setJoinPasswordError('请输入房间密码');
      return;
    }
    setJoinPasswordError('');
    getSocket()?.emit(spectatorMode ? 'join_spectator' : 'join_room', {
      roomId,
      password: joinPassword,
      inviterId: preferredRelation ? inviteInviterId : undefined,
      preferredRelation: preferredRelation || undefined,
    });
  };

  const chooseInviteRelation = (relation: InviteRelation) => {
    setRelationError('');
    setPreferredRelation(relation);
    setRelationPromptOpen(false);
  };

  useEffect(() => {
    const socket = getSocket();
    if (!socket || !isLoggedIn) return;
    let audio: AudioContext | undefined;
    const unlockSound = () => {
      try {
        audio ??= new AudioContext();
        void audio.resume().catch(() => {});
      } catch { /* Visual reports remain available if audio is unsupported. */ }
    };
    const onReport = ({ playerId, count }: { playerId: string; count: number }) => {
      if (count <= 0) return;
      const player = useGameStore.getState().gameState?.players.find(p => p.id === playerId);
      setReportNotice(`${player?.name || '玩家'}${count === 1 ? '报单' : count === 2 ? '报双' : '报牌'}：剩余 ${count} 张`);
      if (!audio || audio.state !== 'running') return;
      const now = audio.currentTime;
      [660, 880].forEach((frequency, index) => {
        const tone = audio!.createOscillator();
        const volume = audio!.createGain();
        const start = now + index * 0.17;
        tone.frequency.value = frequency;
        volume.gain.setValueAtTime(0, start);
        volume.gain.linearRampToValueAtTime(0.12, start + 0.015);
        volume.gain.exponentialRampToValueAtTime(0.001, start + 0.14);
        tone.connect(volume);
        volume.connect(audio!.destination);
        tone.start(start);
        tone.stop(start + 0.15);
      });
    };
    const clearReport = () => setReportNotice('');
    window.addEventListener('pointerdown', unlockSound);
    window.addEventListener('keydown', unlockSound);
    socket.on('card_count_report', onReport);
    socket.on('game_started', clearReport);
    return () => {
      window.removeEventListener('pointerdown', unlockSound);
      window.removeEventListener('keydown', unlockSound);
      socket.off('card_count_report', onReport);
      socket.off('game_started', clearReport);
      if (audio) void audio.close().catch(() => {});
    };
  }, [roomId, spectatorMode, isLoggedIn]);

  useEffect(() => {
    if (!reportNotice) return;
    const timer = window.setTimeout(() => setReportNotice(''), 5000);
    return () => window.clearTimeout(timer);
  }, [reportNotice]);

  useEffect(() => {
    if (!inviteNotice) return;
    const timer = window.setTimeout(() => setInviteNotice(''), 5000);
    return () => window.clearTimeout(timer);
  }, [inviteNotice]);

  useEffect(() => {
    const deadline = gameState?.actionDeadline;
    const hasTimedAction = gameState?.phase === GamePhase.Playing
      || gameState?.phase === GamePhase.ReturnTribute;
    if (!deadline || !hasTimedAction) {
      setActionSecondsLeft(null);
      return;
    }

    const updateCountdown = () => {
      setActionSecondsLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    };
    updateCountdown();
    const timer = window.setInterval(updateCountdown, 250);
    return () => window.clearInterval(timer);
  }, [gameState?.actionDeadline, gameState?.phase]);

  useEffect(() => {
    if (!isLoggedIn) {
      const next = `${location.pathname}${location.search}`;
      navigate(`/?next=${encodeURIComponent(next)}`);
      return;
    }

    const socket = getSocket();
    if (!socket) return;

    if (!requiresRelationChoice || preferredRelation) {
      socket.emit(spectatorMode ? 'join_spectator' : 'join_room', {
        roomId,
        inviterId: preferredRelation ? inviteInviterId : undefined,
        preferredRelation: preferredRelation || undefined,
      });
    }

    const onGameState = (state: GameState) => {
      setPasswordPromptOpen(false);
      setRelationPromptOpen(false);
      setJoinPasswordError('');
      setGameState(state);
      setDeclarations([]);
      setWaiting(state.phase === 'waiting');
      if (state.phase !== 'round_end' && state.phase !== 'game_over') {
        setRoundResult(null);
        setReplayOpen(false);
      }
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
      if (data.message === '房间密码错误') {
        setPasswordPromptOpen(true);
        setJoinPasswordError(current => current ? '密码错误，请重试' : '该房间需要密码');
        return;
      }
      if (preferredRelation && (data.message.includes('邀请人') || data.message.includes('座位')
        || data.message.includes('选择阵营') || data.message.includes('邀请信息'))) {
        setRelationError(data.message);
        setRelationPromptOpen(true);
        return;
      }
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
  }, [roomId, spectatorMode, isLoggedIn, userId, location.pathname, location.search,
    requiresRelationChoice, inviteInviterId, preferredRelation]);

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
    <div className={`game-viewport${landscapeMode ? ' prefer-landscape' : ''}`}>
    <div className={`game-room${waiting ? ' is-waiting' : ''}${isSpectator ? ' is-spectator' : ''}`} style={styles.container}>
      {reportNotice && <div className="card-report-notice" role="status" aria-live="polite">{reportNotice}</div>}
      {inviteNotice && <div style={styles.inviteNotice} role="status" aria-live="polite">{inviteNotice}</div>}
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
          {actionSecondsLeft !== null && (
            <div className="duel-turn-countdown" aria-label={`本回合剩余 ${actionSecondsLeft} 秒`}>
              倒计时 <strong>{actionSecondsLeft}</strong> 秒
            </div>
          )}
        </div>
        <div className="game-top-actions">
          {!isSpectator && gameState?.phase !== 'round_end' && (
            <div className={`game-turn-status${isMyTurn ? ' is-my-turn' : ''}${gameState?.phase === 'return_tribute' ? ' is-tribute' : ''}${errorMsg ? ' has-error' : ''}`}>
              <span className="game-turn-message">{turnMessage}</span>
              {errorMsg && <span className="game-turn-error">{errorMsg}</span>}
            </div>
          )}
          <button type="button" className="spectator-menu" onClick={() => setSpectatorDialogOpen(true)}>
            观战 {gameState?.spectators.length || 0}
          </button>
          <div className="room-exit-actions">
            <button type="button" className="btn-secondary" onClick={handleShareRoom}>
              {waiting ? '邀请朋友' : '分享观战'}
            </button>
            <button type="button" className="btn-secondary orientation-toggle"
              aria-pressed={landscapeMode} onClick={toggleLandscape}>
              {landscapeMode ? '竖屏' : '横屏'}
            </button>
            <button
              className="btn-danger"
              onClick={handleLeaveRoom}
            >
              <span className="desktop-action-label">退出房间</span>
              <span className="mobile-action-label">Exit</span>
            </button>
            <button
              className="btn-secondary"
              onClick={handleLogout}
            >
              <span className="desktop-action-label">退出登录</span>
              <span className="mobile-action-label">Logout</span>
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

        {/* Portrait rows follow: left opponent, partner, right opponent, self. */}
        {([3, 2, 1] as const).map(positionIndex => {
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
        <div className={`game-center-play-area${!waiting && gameState?.phase === GamePhase.Playing ? ' is-personal-play-area' : ''}`}>
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
                    出牌<span className="play-card-count"> ({selectedCardIds.size}张)</span>
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={() => { getSocket()?.emit('hint', { currentCardIds: [...selectedCardIds] }); }}
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

        {passwordPromptOpen && (
          <div style={styles.modal}>
            <div style={{ ...styles.modalContent, width: 'min(360px, calc(100vw - 32px))' }}>
              <h3 style={{ marginBottom: 10 }}>输入房间密码</h3>
              <p style={{ marginBottom: 14, color: 'rgba(255,255,255,.72)', fontSize: 13 }}>
                {spectatorMode ? '输入密码后进入观战' : '输入密码后加入朋友的牌局'}
              </p>
              <input
                autoFocus
                type="password"
                value={joinPassword}
                onChange={event => setJoinPassword(event.target.value)}
                onKeyDown={event => event.key === 'Enter' && submitRoomPassword()}
                placeholder="房间密码"
                style={{ width: '100%', marginBottom: 10 }}
              />
              {joinPasswordError && <p style={{ color: '#ff8b8b', fontSize: 13, marginBottom: 10 }}>{joinPasswordError}</p>}
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                <button type="button" className="btn-primary" onClick={submitRoomPassword}>进入房间</button>
                <button type="button" className="btn-secondary" onClick={() => navigate('/lobby')}>返回大厅</button>
              </div>
            </div>
          </div>
        )}

        {relationPromptOpen && (
          <div style={styles.modal}>
            <div style={{ ...styles.modalContent, width: 'min(390px, calc(100vw - 32px))' }}>
              <h3 style={{ marginBottom: 10 }}>选择和朋友的阵营</h3>
              <p style={{ marginBottom: 14, color: 'rgba(255,255,255,.72)', fontSize: 13 }}>
                掼蛋中坐在邀请人对面就是同队，左右邻座是对手。
              </p>
              {relationError && <p style={{ color: '#ff8b8b', fontSize: 13, marginBottom: 12 }}>{relationError}</p>}
              <div style={{ display: 'grid', gap: 10 }}>
                <button type="button" className="btn-primary" onClick={() => chooseInviteRelation('partner')}>
                  和邀请人同队（坐对家）
                </button>
                <button type="button" className="btn-secondary" onClick={() => chooseInviteRelation('opponent')}>
                  作为邀请人的对手（坐左右）
                </button>
                <button type="button" className="btn-secondary" onClick={() => navigate('/lobby')}>返回大厅</button>
              </div>
            </div>
          </div>
        )}

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
                  const unfinished = r.rank === 4 && roundResult.rankings.filter(entry => entry.rank === 4).length > 1;
                  return `${p?.name || '?'} ${unfinished ? '未出完' : `第${r.rank}名`}`;
                }).join(' | ')}
              </p>
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', marginBottom: 16 }}>
                胜方升 {roundResult.winnerLevelDelta} 级
                {roundResult.levelPenalty ? `，触发地方规则退${roundResult.levelPenalty}级` : ''}
                {roundResult.endReason ? `；${roundResult.endReason}` : ''}
              </p>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 12, flexWrap: 'wrap' }}>
                <button
                  className="btn-primary"
                  onClick={() => {
                    setRoundResult(null);
                    setReplayOpen(false);
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
                <button
                  className="btn-secondary"
                  onClick={() => setReplayOpen(value => !value)}
                  aria-expanded={replayOpen}
                  style={{ padding: '10px 24px', fontSize: 15 }}
                >
                  {replayOpen ? '收起复盘' : '复盘'}
                </button>
              </div>
              {replayOpen && (
                <div style={{
                  marginTop: 16,
                  maxHeight: '40dvh',
                  overflowY: 'auto',
                  textAlign: 'left',
                  fontSize: 14,
                  lineHeight: 1.8,
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                }}>
                  {roundResult.replay?.length
                    ? roundResult.replay.join('\n')
                    : '本局暂无复盘记录'}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
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
  inviteNotice: {
    position: 'fixed',
    top: 12,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 260,
    maxWidth: 'min(560px, calc(100vw - 24px))',
    padding: '9px 16px',
    borderRadius: 9,
    background: 'rgba(11, 50, 31, .96)',
    border: '1px solid rgba(255, 214, 107, .55)',
    color: '#ffe09a',
    fontSize: 13,
    overflowWrap: 'anywhere',
  },
};
