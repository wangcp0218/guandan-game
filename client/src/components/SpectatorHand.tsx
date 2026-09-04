import { Card } from '../sharedTypes';
import CardComponent from './CardComponent';

interface Props {
  cards: Card[];
  playerName: string;
  position: 'top' | 'left' | 'right' | 'bottom';
  currentLevel: number;
}

export default function SpectatorHand({ cards, playerName, position, currentLevel }: Props) {
  return (
    <div className={`spectator-hand spectator-hand--${position}`} aria-label={`${playerName}的手牌，共${cards.length}张`}>
      <div className="spectator-hand-label">{playerName} · {cards.length}张</div>
      <div className="spectator-hand-cards">
        {cards.map(card => (
          <div className="spectator-hand-card" key={card.id}>
            <CardComponent
              card={card}
              size="sm"
              isLevelCard={card.rank === currentLevel}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
