import { CardPattern } from '../sharedTypes';
import CardComponent from './CardComponent';

export type PlayerAction =
  | { type: 'play'; pattern: CardPattern }
  | { type: 'pass' };

interface Props {
  action?: PlayerAction;
  position: 'top' | 'left' | 'right' | 'bottom';
}

export default function PlayArea({ action, position }: Props) {
  if (!action) return null;

  if (action.type === 'pass') {
    return (
      <div className={`seat-action-pass seat-action-pass--${position}`}>
        不出
      </div>
    );
  }

  return (
    <div className={`seat-action-cards seat-action-cards--${position}`}>
      {action.pattern.substitutions?.length ? <span style={{ position: 'absolute', bottom: '100%', color: '#ffe487', whiteSpace: 'nowrap', fontSize: 13 }}>逢人配→{action.pattern.substitutions.map(card => `${({ S: '♠', H: '♥', C: '♣', D: '♦' })[card.suit]}${card.rank}`).join('、')}</span> : null}
      {action.pattern.cards.map((card, index) => (
        <div
          className="seat-action-card"
          key={card.id}
          style={{ marginLeft: index === 0 ? 0 : 'calc(var(--game-card-width) * -0.24)', zIndex: index + 1 }}
        >
          <CardComponent card={card} size="table" />
        </div>
      ))}
    </div>
  );
}
