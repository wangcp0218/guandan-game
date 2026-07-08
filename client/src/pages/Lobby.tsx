import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore, useGameStore } from '../stores/gameStore';
import { getSocket } from '../hooks/useSocket';
import { RoomInfo } from '../sharedTypes';

export default function Lobby() {
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoinPass, setShowJoinPass] = useState<string | null>(null);
  const [roomName, setRoomName] = useState('');
  const [roomPass, setRoomPass] = useState('');
  const [joinPass, setJoinPass] = useState('');
  const [info, setInfo] = useState('');
  const [aiCount, setAiCount] = useState(0);
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

    const onError = (data: { message: string }) => {
      setInfo(data.message);
    };
    socket.on('error', onError);

    const onRoomCreated = (data: RoomInfo) => {
      navigate(`/game/${data.id}`);
    };
    socket.on('room_created', onRoomCreated);

    return () => {
      socket.off('room_list', onRoomList);
      socket.off('room_joined', onRoomJoined);
      socket.off('error', onError);
      socket.off('room_created', onRoomCreated);
    };
  }, []);

  const createRoom = () => {
    if (!roomName.trim()) {
      setInfo('请输入房间名称');
      return;
    }
    const socket = getSocket();
    socket?.emit('create_room', { name: roomName, password: roomPass, aiCount });
  };

  const joinRoom = (roomId: string) => {
    const socket = getSocket();
    socket?.emit('join_room', { roomId });
  };

  const joinRoomWithPass = () => {
    if (!showJoinPass) return;
    const socket = getSocket();
    socket?.emit('join_room', { roomId: showJoinPass, password: joinPass });
    setShowJoinPass(null);
    setJoinPass('');
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
          <button className="btn-primary" style={styles.createBtn} onClick={() => setShowCreate(true)}>
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', whiteSpace: 'nowrap' }}>AI对手:</span>
                  {[0, 1, 2, 3].map(n => (
                    <button
                      key={n}
                      onClick={() => setAiCount(n)}
                      style={{
                        flex: 1,
                        padding: '6px 4px',
                        fontSize: 12,
                        borderRadius: 6,
                        border: 'none',
                        cursor: 'pointer',
                        background: aiCount === n ? '#e6b422' : 'rgba(255,255,255,0.1)',
                        color: aiCount === n ? '#333' : 'rgba(255,255,255,0.5)',
                        fontWeight: aiCount === n ? 700 : 400,
                      }}
                    >
                      {n}个
                    </button>
                  ))}
                </div>
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
                  <button className="btn-secondary" onClick={() => setShowJoinPass(null)}>取消</button>
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
                    {room.hasPassword ? '🔒 ' : ''}等级{room.level} | {room.playerCount}人/{room.maxPlayers}人{room.aiCount > 0 ? ` | AIx${room.aiCount}` : ''}
                  </span>
                </div>
                <button
                  className="btn-primary"
                  style={{ padding: '6px 16px', fontSize: 12 }}
                  onClick={() => {
                    if (room.hasPassword) {
                      setShowJoinPass(room.id);
                    } else {
                      joinRoom(room.id);
                    }
                  }}
                >
                  加入
                </button>
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
    background: '#1a4a2e',
    borderRadius: 14,
    padding: 24,
    width: 320,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
  },
  input: {
    width: '100%',
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
