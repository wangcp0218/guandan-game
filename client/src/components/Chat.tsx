import React, { useState } from 'react';
import { ChatMessage, SpectatorInfo } from '../sharedTypes';

interface Props {
  messages: ChatMessage[];
  onSend: (content: string) => void;
  spectators?: SpectatorInfo[];
  canManageSpectators?: boolean;
  onKickSpectator?: (spectatorId: string) => void;
}

export default function Chat({ messages, onSend, spectators = [], canManageSpectators = false, onKickSpectator }: Props) {
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
        display: 'flex',
        justifyContent: 'space-between',
      }}>
        <span>聊天</span>
        <span>观战 {spectators.length}</span>
      </div>
      {spectators.length > 0 && (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 4,
          padding: '6px 8px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          maxHeight: 54,
          overflowY: 'auto',
        }}>
          {spectators.map(spectator => (
            <span key={spectator.id} style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 5px',
              borderRadius: 4,
              background: 'rgba(230,180,34,0.12)',
              color: '#e7c660',
              fontSize: 11,
            }}>
              {spectator.name}
              {canManageSpectators && onKickSpectator && (
                <button
                  type="button"
                  onClick={() => onKickSpectator(spectator.id)}
                  aria-label={`剔除观察者 ${spectator.name}`}
                  style={{
                    padding: '0 3px',
                    borderRadius: 3,
                    background: 'rgba(211,47,47,.8)',
                    color: '#fff',
                    fontSize: 10,
                    lineHeight: 1.4,
                  }}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}
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
