import React, { useState } from 'react';
import { ChatMessage } from '../sharedTypes';

interface Props {
  messages: ChatMessage[];
  onSend: (content: string) => void;
}

export default function Chat({ messages, onSend }: Props) {
  const [input, setInput] = useState('');

  const handleSend = () => {
    if (!input.trim()) return;
    onSend(input.trim());
    setInput('');
  };

  return (
    <div style={{
      width: 200,
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: 'rgba(0,0,0,0.2)',
      borderRadius: 12,
      overflow: 'hidden',
      border: '1px solid rgba(255,255,255,0.1)',
    }}>
      <div style={{
        padding: '8px 12px',
        fontSize: 13,
        fontWeight: 600,
        borderBottom: '1px solid rgba(255,255,255,0.1)',
        color: 'rgba(255,255,255,0.6)',
      }}>
        聊天
      </div>
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: '8px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}>
        {messages.map((m, i) => (
          <div key={i} style={{ fontSize: 12, lineHeight: 1.4 }}>
            <span style={{ color: '#e6b422', fontWeight: 600 }}>{m.playerName}: </span>
            <span style={{ color: 'rgba(255,255,255,0.8)' }}>{m.content}</span>
          </div>
        ))}
      </div>
      <div style={{
        display: 'flex',
        padding: 6,
        gap: 4,
        borderTop: '1px solid rgba(255,255,255,0.1)',
      }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="说点什么..."
          style={{
            flex: 1,
            padding: '4px 8px',
            fontSize: 12,
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 4,
            color: '#fff',
            outline: 'none',
          }}
        />
        <button
          onClick={handleSend}
          style={{
            background: '#e6b422',
            color: '#333',
            border: 'none',
            borderRadius: 4,
            padding: '4px 10px',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          发送
        </button>
      </div>
    </div>
  );
}
