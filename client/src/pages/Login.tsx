import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/gameStore';
import { getSocket } from '../hooks/useSocket';
import { GIT_VERSION } from '../buildInfo';

export default function Login() {
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const { setAuth, isLoggedIn } = useAuthStore();

  useEffect(() => {
    if (isLoggedIn) navigate('/lobby');
  }, [isLoggedIn]);

  const handleSubmit = () => {
    if (!username || !password) {
      setError('请输入用户名和密码');
      return;
    }
    setError('');
    const socket = getSocket();
    if (!socket) {
      setError('无法连接服务器');
      return;
    }

    const event = tab === 'login' ? 'login' : 'register';
    const successEvent = tab === 'login' ? 'login_success' : 'register_success';
    const errorEvent = tab === 'login' ? 'login_error' : 'register_error';

    socket.once(successEvent, (data: any) => {
      setAuth(data.userId, data.username, data.token, data.level || 2);
      navigate('/lobby');
    });

    socket.once(errorEvent, (data: any) => {
      setError(data.message || '操作失败');
    });

    socket.emit(event, { username, password });
  };

  return (
    <div className="login-page" style={styles.container}>
      <div className="login-card" style={styles.card}>
        <h1 style={styles.title}>掼 蛋</h1>
        <p style={styles.subtitle}>在线对战</p>

        <div style={styles.tabs}>
          <button
            style={{ ...styles.tab, ...(tab === 'login' ? styles.tabActive : {}) }}
            onClick={() => setTab('login')}
          >
            登录
          </button>
          <button
            style={{ ...styles.tab, ...(tab === 'register' ? styles.tabActive : {}) }}
            onClick={() => setTab('register')}
          >
            注册
          </button>
        </div>

        <div style={styles.form}>
          <input
            type="text"
            placeholder="用户名"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            style={styles.input}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          />
          <input
            type="password"
            placeholder="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={styles.input}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          />
          {error && <p style={styles.error}>{error}</p>}
          <button className="btn-primary" onClick={handleSubmit} style={styles.btn}>
            {tab === 'login' ? '登 录' : '注 册'}
          </button>
        </div>
      </div>
      <span style={styles.version}>版本 {GIT_VERSION}</span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'linear-gradient(135deg, #0a4a2e 0%, #1a6b42 50%, #0d3b1e 100%)',
  },
  card: {
    background: 'rgba(255,255,255,0.08)',
    backdropFilter: 'blur(20px)',
    borderRadius: 20,
    padding: '40px',
    width: 360,
    boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
  },
  title: {
    fontSize: 42,
    textAlign: 'center',
    color: '#e6b422',
    marginBottom: 4,
    letterSpacing: 12,
  },
  subtitle: {
    fontSize: 14,
    textAlign: 'center',
    color: 'rgba(255,255,255,0.5)',
    marginBottom: 28,
  },
  tabs: {
    display: 'flex',
    gap: 8,
    marginBottom: 20,
  },
  tab: {
    flex: 1,
    padding: '8px',
    background: 'rgba(255,255,255,0.06)',
    color: 'rgba(255,255,255,0.5)',
    borderRadius: 8,
    fontSize: 14,
  },
  tabActive: {
    background: 'rgba(230,180,34,0.2)',
    color: '#e6b422',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  input: {
    width: '100%',
  },
  error: {
    color: '#ff6b6b',
    fontSize: 13,
    textAlign: 'center',
  },
  btn: {
    width: '100%',
    padding: '12px',
    fontSize: 16,
    marginTop: 8,
    borderRadius: 8,
    background: '#e6b422',
    color: '#333',
  },
  version: {
    position: 'fixed',
    right: 12,
    bottom: 10,
    color: 'rgba(255,255,255,0.45)',
    fontSize: 11,
  },
};
