import { CardPattern, PatternType, Rank } from '../../../shared/types';
import { effectiveRank, isJoker } from './card';
import { isBomb, isKingBomb, isFlushStraight } from './patterns';

const bombPatterns = new Set([
  PatternType.Bomb4, PatternType.Bomb5, PatternType.Bomb6,
  PatternType.Bomb7, PatternType.Bomb8, PatternType.KingBomb,
  PatternType.FlushStraight,
]);

export function isBombPattern(pattern: CardPattern): boolean {
  return bombPatterns.has(pattern.type);
}

function bombPower(pattern: CardPattern, currentLevel: number): number {
  if (pattern.type === PatternType.KingBomb) return 9999;
  if (pattern.type === PatternType.FlushStraight) {
    const er = effectiveRank(pattern.rank, currentLevel);
    return 9000 + er;
  }
  const bombNum = parseInt(pattern.type.replace('bomb', ''), 10);
  return bombNum * 1000 + effectiveRank(pattern.rank, currentLevel);
}

function normalPower(pattern: CardPattern, currentLevel: number): number {
  return pattern.length * 100 + effectiveRank(pattern.rank, currentLevel);
}

export function canBeat(
  newPattern: CardPattern,
  lastPattern: CardPattern | null,
  currentLevel: number
): boolean {
  if (!lastPattern) return true;

  const newIsBomb = isBombPattern(newPattern);
  const lastIsBomb = isBombPattern(lastPattern);

  if (newPattern.type === PatternType.KingBomb) return true;

  if (newIsBomb && !lastIsBomb) return true;

  if (!newIsBomb && lastIsBomb) return false;

  if (newIsBomb && lastIsBomb) {
    return bombPower(newPattern, currentLevel) > bombPower(lastPattern, currentLevel);
  }

  if (newPattern.type !== lastPattern.type) return false;
  if (newPattern.length !== lastPattern.length) return false;

  return normalPower(newPattern, currentLevel) > normalPower(lastPattern, currentLevel);
}

export function canFreePlay(lastPattern: CardPattern | null, passCount: number): boolean {
  if (!lastPattern) return true;
  if (passCount >= 3) return true;
  return false;
}
