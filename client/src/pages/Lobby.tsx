import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore, useGameStore } from '../stores/gameStore';
import { getSocket } from '../hooks/useSocket';
import { AiProvider, GamePhase, RoomInfo } from '../sharedTypes';

export default function Lobby() {
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoinPass, setShowJoinPass] = useState<string | null>(null);
  const [joinAsSpectator, setJoinAsSpectator] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [roomPass, setRoomPass] = useState('');
  const [joinPass, setJoinPass] = useState('');
  const [info, setInfo] = useState('');
  const [aiProvider, setAiProvider] = useState<AiProvider>('deepseek');
  const [aiModel, setAiModel] = useState('deepseek-v4-flash');
  const [aiModels, setAiModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const modelRequestId = useRef(0);
  const navigate = useNavigate();
  const { username, isLoggedIn, token, logout } = useAuthStore();
  const { reset } = useGameStore();

  useEffect(() => {
    if (!isLoggedIn) {
      navigate('/');
      return;
    }

    const socket = getSocket();
    if (!socket) return;

    if (token) {
      socket.emit('auth_token', { token });
    }

    socket.emit('room_list');

    const onRoomList = (list: RoomInfo[]) => setRooms(list);
    socket.on('room_list', onRoomList);

    const onRoomJoined = (data: { room: RoomInfo; seatIndex: number }) => {
      navigate(`/game/${data.room.id}`);
    };

    socket.on('room_joined', onRoomJoined);

    const onSpectatorJoined = (data: { room: RoomInfo }) => {
      navigate(`/game/${data.room.id}?spectator=1`);
    };
    socket.on('spectator_joined', onSpectatorJoined);

    const onError = (data: { message: string }) => {
      setInfo(data.message);
    };
    socket.on('error', onError);

    const onRoomCreated = (data: RoomInfo) => {
      navigate(`/game/${data.id}`);
    };
    socket.on('room_created', onRoomCreated);

    const onAiModelsResult = (data: {
      provider: AiProvider;
      requestId?: number;
      models: string[];
      error?: string;
    }) => {
      if (data.requestId !== modelRequestId.current) return;
      setModelsLoading(false);
      setModelsError(data.error || '');
      setAiModels(data.models);
      if (data.models.length > 0) {
        const preferred = data.provider === 'deepseek'
          ? 'deepseek-v4-flash'
          : 'deepseek-v4-flash-0731';
        setAiModel(current => data.models.includes(current)
          ? current
          : data.models.includes(preferred) ? preferred : data.models[0]
        );
      } else {
        setAiModel('');
      }
    };
    socket.on('ai_models_result', onAiModelsResult);

    return () => {
      socket.off('room_list', onRoomList);
      socket.off('room_joined', onRoomJoined);
      socket.off('spectator_joined', onSpectatorJoined);
      socket.off('error', onError);
      socket.off('room_created', onRoomCreated);
      socket.off('ai_models_result', onAiModelsResult);
    };
  }, []);

  const loadAiModels = (provider: AiProvider) => {
    const requestId = ++modelRequestId.current;
    setModelsLoading(true);
    setModelsError('');
    setAiModels([]);
    getSocket()?.emit('get_ai_models', { provider, requestId });
  };

  const openCreateRoom = () => {
    setShowCreate(true);
    setInfo('');
    loadAiModels(aiProvider);
  };

  const [maxRounds, setMaxRounds] = useState(0);
  const [maxMinutes, setMaxMinutes] = useState(0);
  const [tripleDoublePenalty, setTripleDoublePenalty] = useState(false);

  const createRoom = () => {
    if (!roomName.trim()) {
      setInfo('请输入房间名称');
      return;
    }
    if (!aiModel) {
      setInfo('请先选择 AI 模型');
      return;
    }
    const socket = getSocket();
    socket?.emit('create_room', {
      name: roomName,
      password: roomPass,
      aiProvider,
      aiModel,
      maxRounds, maxMinutes, tripleDoublePenalty,
    });
  };

  const joinRoom = (roomId: string) => {
    const socket = getSocket();
    socket?.emit('join_room', { roomId });
  };

  const watchRoom = (roomId: string) => {
    getSocket()?.emit('join_spectator', { roomId });
  };

  const joinRoomWithPass = () => {
    if (!showJoinPass) return;
    const socket = getSocket();
    socket?.emit(joinAsSpectator ? 'join_spectator' : 'join_room', { roomId: showJoinPass, password: joinPass });
    setShowJoinPass(null);
    setJoinPass('');
    setJoinAsSpectator(false);
  };

  const refreshRooms = () => {
    getSocket()?.emit('room_list');
  };

  const handleLogout = () => {
    reset();
    logout();
    navigate('/');
  };

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div>
          <h2 style={styles.logo}>🃏 掼蛋大厅</h2>
          <span style={styles.user}>欢迎, {username}</span>
        </div>
        <div style={styles.headerActions}>
          <button className="btn-secondary" onClick={refreshRooms}>刷新</button>
          <button className="btn-danger" onClick={handleLogout}>退出登录</button>
        </div>
      </header>

      <div style={styles.content}>
        <div style={styles.left}>
          <button className="btn-primary" style={styles.createBtn} onClick={openCreateRoom}>
            + 创建房间
          </button>

          {showCreate && (
            <div style={styles.modal}>
              <div style={styles.modalContent}>
                <h3>创建房间</h3>
                <input
                  type="text"
                  placeholder="房间名称"
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  style={styles.input}
                  onKeyDown={(e) => e.key === 'Enter' && createRoom()}
                />
                <input
                  type="password"
                  placeholder="密码（可选）"
                  value={roomPass}
                  onChange={(e) => setRoomPass(e.target.value)}
                  style={styles.input}
                />
                <label style={styles.fieldLabel}>比赛最多副数（0不限）<input type="number" min="0" max="10000" value={maxRounds} onChange={e => setMaxRounds(Number(e.target.value))} /></label>
                <label style={styles.fieldLabel}>比赛分钟数（0不限，打完当前副结算）<input type="number" min="0" max="10000" value={maxMinutes} onChange={e => setMaxMinutes(Number(e.target.value))} /></label>
                <label style={styles.fieldLabel}><span><input type="checkbox" checked={tripleDoublePenalty} onChange={e => setTripleDoublePenalty(e.target.checked)} />连续三副双上退2级（地方玩法）</span></label>
                <label style={styles.fieldLabel}>
                  <span>模型提供商</span>
                  <select
                    value={aiProvider}
                    onChange={(e) => {
                      const provider = e.target.value as AiProvider;
                      setAiProvider(provider);
                      setAiModel('');
                      loadAiModels(provider);
                    }}
                    style={styles.select}
                  >
                    <option value="deepseek">DeepSeek</option>
                    <option value="local">Local (192.168.150.51)</option>
                  </select>
                </label>
                <label style={styles.fieldLabel}>
                  <span>模型</span>
                  <select
                    value={aiModel}
                    onChange={(e) => setAiModel(e.target.value)}
                    style={styles.select}
                    disabled={modelsLoading || aiModels.length === 0}
                  >
                    {modelsLoading && <option value="">正在获取模型...</option>}
                    {!modelsLoading && aiModels.length === 0 && <option value="">暂无可用模型</option>}
                    {aiModels.map(model => <option key={model} value={model}>{model}</option>)}
                  </select>
                </label>
                {modelsError && (
                  <div style={styles.modelError}>
                    <span>{modelsError}</span>
                    <button type="button" className="btn-secondary" onClick={() => loadAiModels(aiProvider)}>重试</button>
                  </div>
                )}
                {info && <p style={styles.error}>{info}</p>}
                <div style={styles.modalBtns}>
                  <button className="btn-primary" onClick={createRoom}>创建</button>
                  <button className="btn-secondary" onClick={() => { setShowCreate(false); setInfo(''); }}>取消</button>
                </div>
              </div>
            </div>
          )}

          {showJoinPass && (
            <div style={styles.modal}>
              <div style={styles.modalContent}>
                <h3>输入房间密码</h3>
                <input
                  type="password"
                  placeholder="房间密码"
                  value={joinPass}
                  onChange={(e) => setJoinPass(e.target.value)}
                  style={styles.input}
                  onKeyDown={(e) => e.key === 'Enter' && joinRoomWithPass()}
                />
                <div style={styles.modalBtns}>
                  <button className="btn-primary" onClick={joinRoomWithPass}>进入</button>
                  <button className="btn-secondary" onClick={() => { setShowJoinPass(null); setJoinAsSpectator(false); }}>取消</button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div style={styles.roomList}>
          <h3 style={styles.listTitle}>房间列表</h3>
          {rooms.length === 0 ? (
            <p style={styles.empty}>暂无房间，创建一个吧!</p>
          ) : (
            rooms.map((room) => (
              <div key={room.id} style={styles.roomItem}>
                <div style={styles.roomInfo}>
                  <span style={styles.roomName}>{room.name}</span>
                  <span style={styles.roomMeta}>
                    {room.hasPassword ? '🔒 ' : ''}等级{room.level} | {room.playerCount}人/{room.maxPlayers}人 | {room.phase === GamePhase.Waiting ? '开局自动补 AI' : room.aiCount > 0 ? `AIx${room.aiCount}` : '全真人'} | {room.aiProvider}/{room.aiModel}
                  </span>
                  {room.phase !== GamePhase.Waiting && (
                    <button
                      type="button"
                      className="room-code-watch"
                      onClick={() => {
                        if (room.hasPassword) {
                          setJoinAsSpectator(true);
                          setShowJoinPass(room.id);
                        } else {
                          watchRoom(room.id);
                        }
                      }}
                    >
                      房号 {room.roomCode} · 点击观战{room.spectatorCount > 0 ? `（${room.spectatorCount}）` : ''}
                    </button>
                  )}
                </div>
                {room.phase === GamePhase.Waiting && room.playerCount < room.maxPlayers && (
                  <button
                    className="btn-primary"
                    style={{ padding: '6px 16px', fontSize: 12 }}
                    onClick={() => {
                      if (room.hasPassword) {
                        setJoinAsSpectator(false);
                        setShowJoinPass(room.id);
                      } else {
                        joinRoom(room.id);
                      }
                    }}
                  >
                    加入
                  </button>
                )}
                {room.phase === GamePhase.Waiting && room.playerCount >= room.maxPlayers && (
                  <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>等待房主开局</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    background: 'linear-gradient(135deg, #0a4a2e 0%, #164a30 100%)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 24px',
    background: 'rgba(0,0,0,0.15)',
    borderBottom: '1px solid rgba(255,255,255,0.1)',
  },
  headerActions: {
    display: 'flex',
    gap: 10,
    alignItems: 'center',
  },
  logo: {
    fontSize: 22,
    color: '#e6b422',
    margin: 0,
  },
  user: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.6)',
    marginLeft: 12,
  },
  content: {
    flex: 1,
    display: 'flex',
    padding: 20,
    gap: 20,
    overflow: 'hidden',
  },
  left: {
    width: 200,
    flexShrink: 0,
  },
  createBtn: {
    width: '100%',
    padding: '12px',
    fontSize: 15,
    borderRadius: 10,
  },
  modal: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  modalContent: {
    maxHeight: '90vh',
    overflowY: 'auto',
    background: '#1a4a2e',
    borderRadius: 14,
    padding: 24,
    width: 380,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
  },
  input: {
    width: '100%',
  },
  fieldLabel: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    fontSize: 13,
    color: 'rgba(255,255,255,0.65)',
  },
  select: {
    width: '100%',
    padding: '9px 10px',
    border: '1px solid rgba(255,255,255,0.3)',
    borderRadius: 6,
    background: '#285c42',
    color: '#fff',
    fontSize: 13,
    outline: 'none',
  },
  modelError: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    color: '#ff9b9b',
    fontSize: 12,
  },
  modalBtns: {
    display: 'flex',
    gap: 8,
    justifyContent: 'flex-end',
  },
  roomList: {
    flex: 1,
    overflow: 'auto',
  },
  listTitle: {
    fontSize: 16,
    marginBottom: 12,
    color: 'rgba(255,255,255,0.7)',
  },
  empty: {
    textAlign: 'center',
    color: 'rgba(255,255,255,0.4)',
    padding: 40,
  },
  roomItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    background: 'rgba(255,255,255,0.06)',
    borderRadius: 10,
    padding: '12px 16px',
    marginBottom: 8,
  },
  roomInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  roomName: {
    fontSize: 15,
    fontWeight: 600,
  },
  roomMeta: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.5)',
  },
  error: {
    color: '#ff6b6b',
    fontSize: 13,
    textAlign: 'center',
  },
};
