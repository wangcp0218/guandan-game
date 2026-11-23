import { useEffect, useState } from 'react';
import { PlayerInfo as PlayerInfoType } from '../sharedTypes';
import './PlayerInfo.css';
import PlayerAvatar from './PlayerAvatar';

interface Props {
  player: PlayerInfoType;
  position: 'top' | 'left' | 'right' | 'bottom';
  isCurrent: boolean;
  isMe: boolean;
  isPartner: boolean;
  secondsLeft?: number | null;
}

const TEAM_COLORS = {
  mine: '#4a90d9',
  partner: '#357abd',
  opponent: '#e74c3c',
};

export default function PlayerInfoComponent({ player, position, isCurrent, isMe, isPartner }: Props) {
  const reported = player.reportedCardCount !== undefined && player.cardCount > 0;
  const bgColor = isMe ? TEAM_COLORS.mine : isPartner ? TEAM_COLORS.partner : TEAM_COLORS.opponent;
  const reportCount = player.reportedCardCount;
  const hasReport = reportCount !== undefined && player.cardCount > 0;
  const warningLevel = hasReport ? (player.cardCount <= 6 ? 'critical' : 'low') : null;
  const [announcement, setAnnouncement] = useState<{ playerId: string; count: number } | null>(null);

  useEffect(() => {
    if (!hasReport || reportCount === undefined) {
      setAnnouncement(null);
      return;
    }
    setAnnouncement({ playerId: player.id, count: reportCount });
    const timer = window.setTimeout(() => setAnnouncement(null), 3200);
    return () => window.clearTimeout(timer);
  }, [player.id, reportCount, hasReport]);

  const showAnnouncement = hasReport && announcement?.playerId === player.id
    && announcement.count === reportCount;

  return (
    <div className={`player-info${isCurrent ? ' is-current' : ''}${reported ? ' has-card-report' : ''}`} style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 4,
      padding: '8px 16px',
      borderRadius: 12,
      background: isCurrent ? 'rgba(230,180,34,0.25)' : 'rgba(255,255,255,0.05)',
      border: isCurrent ? '2px solid #e6b422' : '1px solid rgba(255,255,255,0.1)',
      minWidth: 110,
      transition: 'all 0.3s',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{
          width: 32, height: 32, borderRadius: '50%',
          background: bgColor,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 14, fontWeight: 700, color: '#fff',
        }}>
          <PlayerAvatar player={player} />
        </div>
        {isMe && (
          <span style={{
            fontSize: 10,
            color: '#8bc8ff',
            background: 'rgba(74,144,217,0.2)',
            padding: '1px 5px',
            borderRadius: 4,
            fontWeight: 600,
          }}>自己</span>
        )}
        {isPartner && (
          <span style={{
            fontSize: 10,
            color: '#4a90d9',
            background: 'rgba(74,144,217,0.15)',
            padding: '1px 5px',
            borderRadius: 4,
            fontWeight: 600,
          }}>队友</span>
        )}
        {!isMe && !isPartner && (
          <span style={{
            fontSize: 10,
            color: '#e74c3c',
            background: 'rgba(231,76,60,0.15)',
            padding: '1px 5px',
            borderRadius: 4,
            fontWeight: 600,
          }}>对手</span>
        )}
      </div>
      <span style={{ fontSize: 13, fontWeight: 600, textAlign: 'center' }}>
        {player.name} {isMe ? '(我)' : ''}
      </span>
      {reported && <strong className={`card-report-badge${player.cardCount <= 2 ? ' is-urgent' : ''}`}>
        {player.cardCount === 1 ? '报单' : player.cardCount === 2 ? '报双' : '已报牌'} · 剩 {player.cardCount} 张
      </strong>}
      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
        Lv.{player.level} | {player.cardCount === 0 ? '已出完' : player.reportedCardCount !== undefined ? `剩余${player.cardCount}张` : '未报牌'}
      </span>
      {warningLevel && (
        <aside className={`card-count-badge card-count-badge--${warningLevel}`} aria-label={`剩余${player.cardCount}张牌`}>
          <strong>{player.cardCount}</strong> 张
        </aside>
      )}
      {showAnnouncement && (
        <aside
          key={`${player.id}-${reportCount}`}
          className={`card-count-report card-count-report--${warningLevel}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="card-count-report-label">报牌</span>
          <span>只剩 <strong>{announcement.count}</strong> 张了！</span>
        </aside>
      )}
    </div>
  );
}
