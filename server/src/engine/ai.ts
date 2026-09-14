import { AiModelSelection, Card, CardPattern, PatternType, Rank, Suit } from '../../../shared/types';
import { effectiveRank, isJoker } from './card';
import {
  isWildCard, validWildSubstitutions,
} from './patterns';
import { canBeat, isBombPattern } from './compare';
import { llmFindBestPlay } from './llmAi';
import type { AiDecisionContext } from './llmAi';
import { analyzeDecision, analysisKey, buildPublicKnowledge } from './aiAnalysis';
import type { DecisionAnalysis } from './aiAnalysis';

const MAX_LLM_CANDIDATES = 160;

function getRankCounts(hand: Card[]): Map<number, Card[]> {
  const map = new Map<number, Card[]>();
  for (const c of hand) {
    const list = map.get(c.rank) || [];
    list.push(c);
    map.set(c.rank, list);
  }
  return map;
}

function generateSingles(hand: Card[]): Card[][] {
  return hand.map(c => [c]);
}

function combinations<T>(items: T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (size < 0 || size > items.length) return [];
  const result: T[][] = [];
  const visit = (start: number, selected: T[]) => {
    if (selected.length === size) {
      result.push([...selected]);
      return;
    }
    for (let index = start; index <= items.length - (size - selected.length); index++) {
      selected.push(items[index]);
      visit(index + 1, selected);
      selected.pop();
    }
  };
  visit(0, []);
  return result;
}

function rankRuns(length: 2 | 3 | 5): Rank[][] {
  const runs: Rank[][] = [[
    Rank.Ace,
    ...Array.from({ length: length - 1 }, (_, index) => (Rank.Two + index) as Rank),
  ]];
  for (let start = Rank.Two; start + length - 1 <= Rank.Ace; start++) {
    runs.push(Array.from({ length }, (_, index) => (start + index) as Rank));
  }
  return runs;
}

interface TargetGroup {
  rank: Rank;
  count: number;
  suit?: Suit;
}

/**
 * Enumerate physical ways to fill fixed rank groups. 逢人配 may replace a
 * missing ordinary card, including one which is otherwise available; keeping
 * those alternatives lets the scorer choose the least damaging decomposition.
 */
function generateGroupedPatterns(
  regulars: Card[],
  wilds: Card[],
  groups: TargetGroup[],
  type: PatternType,
  patternRank: Rank,
  add: (pattern: CardPattern) => void,
) {
  const visit = (
    groupIndex: number,
    cards: Card[],
    substitutionTargets: Array<{ rank: Rank; suit: Suit }>,
  ) => {
    if (groupIndex === groups.length) {
      for (const selectedWilds of combinations(wilds, substitutionTargets.length)) {
        add({
          type,
          rank: patternRank,
          length: cards.length + selectedWilds.length,
          cards: [...cards, ...selectedWilds],
          substitutions: selectedWilds.map((card, index) => ({
            ...card,
            ...substitutionTargets[index],
          })),
        });
      }
      return;
    }
    const group = groups[groupIndex];
    const candidates = regulars.filter(card =>
      card.rank === group.rank && (group.suit === undefined || card.suit === group.suit)
    );
    const minimumNatural = group.rank > Rank.Ace
      ? group.count
      : Math.max(0, group.count - (wilds.length - substitutionTargets.length));
    const maximumNatural = Math.min(group.count, candidates.length);
    for (let naturalCount = minimumNatural; naturalCount <= maximumNatural; naturalCount++) {
      const missing = group.count - naturalCount;
      if (substitutionTargets.length + missing > wilds.length) continue;
      for (const selected of combinations(candidates, naturalCount)) {
        const resolvedSuit = group.suit ?? Suit.Spade;
        visit(
          groupIndex + 1,
          [...cards, ...selected],
          [...substitutionTargets, ...Array.from({ length: missing }, () => ({
            rank: group.rank,
            suit: resolvedSuit,
          }))],
        );
      }
    }
  };
  visit(0, [], []);
}

export function generateLegalPlays(
  hand: Card[],
  currentLevel: number
): CardPattern[] {
  const wilds = hand.filter(card => isWildCard(card, currentLevel));
  const regulars = hand.filter(card => !isWildCard(card, currentLevel));
  const patterns: CardPattern[] = [];
  const seen = new Set<string>();

  const add = (pattern: CardPattern) => {
    if (!validWildSubstitutions(pattern.cards, pattern.substitutions || [], currentLevel)) return;
    const ids = pattern.cards.map(card => card.id).sort((a, b) => a - b);
    const key = `${pattern.type}:${pattern.rank}:${ids.join(',')}`;
    if (new Set(ids).size !== ids.length || seen.has(key)) return;
    seen.add(key);
    patterns.push(pattern);
  };

  for (const cards of generateSingles(hand)) {
    add({ type: PatternType.Single, rank: cards[0].rank, length: 1, cards });
  }

  // Same-rank groups. Pairs may be made from jokers; larger groups may not.
  for (let rank = Rank.Two; rank <= Rank.BigJoker; rank++) {
    generateGroupedPatterns(regulars, wilds, [{ rank, count: 2 }], PatternType.Pair, rank, add);
    if (rank <= Rank.Ace) {
      generateGroupedPatterns(regulars, wilds, [{ rank, count: 3 }], PatternType.Triple, rank, add);
      for (let size = 4; size <= 10; size++) {
        generateGroupedPatterns(
          regulars, wilds, [{ rank, count: size }],
          `bomb${size}` as PatternType, rank, add,
        );
      }
    }
  }

  for (let tripleRank = Rank.Two; tripleRank <= Rank.Ace; tripleRank++) {
    for (let pairRank = Rank.Two; pairRank <= Rank.BigJoker; pairRank++) {
      if (tripleRank === pairRank) continue;
      generateGroupedPatterns(regulars, wilds, [
        { rank: tripleRank, count: 3 },
        { rank: pairRank, count: 2 },
      ], PatternType.TriplePair, tripleRank, add);
    }
  }

  for (const run of rankRuns(5)) {
    const groups = run.map(rank => ({ rank, count: 1 }));
    generateGroupedPatterns(regulars, wilds, groups, PatternType.Straight, run[run.length - 1], pattern => {
      const substitutions = pattern.substitutions || [];
      const resolved = pattern.cards.map(card => substitutions.find(item => item.id === card.id) || card);
      if (resolved.every(card => card.suit === resolved[0].suit)) {
        // A wildcard can deliberately take another suit to declare an ordinary
        // straight. Natural straight flushes cannot be downgraded this way.
        if (substitutions.length === 0) return;
        pattern.substitutions = substitutions.map((card, index) => index === 0
          ? { ...card, suit: resolved[0].suit === Suit.Spade ? Suit.Heart : Suit.Spade }
          : card);
      }
      add(pattern);
    });
    for (const suit of [Suit.Spade, Suit.Heart, Suit.Club, Suit.Diamond]) {
      generateGroupedPatterns(
        regulars, wilds, run.map(rank => ({ rank, count: 1, suit })),
        PatternType.FlushStraight, run[run.length - 1], add,
      );
    }
  }

  for (const run of rankRuns(3)) {
    generateGroupedPatterns(
      regulars, wilds, run.map(rank => ({ rank, count: 2 })),
      PatternType.ConsecutivePair, run[run.length - 1], add,
    );
  }
  for (const run of rankRuns(2)) {
    generateGroupedPatterns(
      regulars, wilds, run.map(rank => ({ rank, count: 3 })),
      PatternType.Plane, run[run.length - 1], add,
    );
  }

  const jokers = hand.filter(isJoker);
  if (jokers.length === 4) {
    add({ type: PatternType.KingBomb, rank: Rank.BigJoker, length: 4, cards: jokers });
  }

  return patterns;
}

function strategicPlayKey(play: CardPattern): string {
  const cards = play.cards
    .map(card => `${card.suit}${card.rank}`)
    .sort()
    .join(',');
  return `${play.type}:${play.rank}:${play.length}:${cards}`;
}

function dedupeStrategicPlays(plays: CardPattern[]): CardPattern[] {
  const seen = new Set<string>();
  return plays.filter(play => {
    const key = strategicPlayKey(play);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function applyStrategicGuards(
  plays: CardPattern[],
  hand: Card[],
  currentLevel: number,
  isFreePlay: boolean,
  context?: AiDecisionContext,
): CardPattern[] {
  let guarded = plays;

  // Preserve 逢人配 instead of wasting it as a single. The only exception is an
  // urgent block when an opponent has one card and no safer legal play exists.
  if (hand.length > 1) {
    const withoutWildSingles = guarded.filter(play => !(
      play.type === PatternType.Single && isWildCard(play.cards[0], currentLevel)
    ));
    const opponentReportedSingle = context?.players.some(player =>
      player.relation === 'opponent' && player.finishRank === null && player.cardCount === 1
    ) || false;
    if (withoutWildSingles.length > 0 || !opponentReportedSingle) {
      guarded = withoutWildSingles;
    }
  }

  // Keep larger singles and partner-overtaking actions available for analysis.
  // The final policy enforces cooperation and low-first with evidence-based exceptions.

  return guarded;
}

/**
 * Round-level urgency multiplier, 1.0 = neutral. Above 1 the AI fights harder
 * this hand (trailing on levels, defending the table against a near-Ace
 * opponent, later rounds of a finite match); below 1 a comfortable lead plays
 * conservatively. Drives bomb willingness and blocking urgency so decisions
 * follow the match score, not just the cards. Uses only public context.
 */
export function roundStake(context?: AiDecisionContext): number {
  if (!context) return 1;
  const ourTeam = context.selfSeatIndex % 2;
  const gap = context.teamLevels[ourTeam] - context.teamLevels[1 - ourTeam];
  const leading = context.leadingTeam === ourTeam;
  const opponentNearAce = context.teamLevels[1 - ourTeam] >= Rank.Ace - 2;
  let stake = 1;
  if (gap < 0) stake += Math.min(3, -gap) * 0.12;
  else if (leading && gap >= 2) stake -= Math.min(2, gap) * 0.05;
  if (leading && opponentNearAce) stake += 0.15;
  stake += Math.min(4, Math.max(0, context.roundNumber - 1)) * 0.02;
  return stake;
}

/** Base7-inspired value: prefer shedding groups while preserving controls and structures. */
export function scorePlay(
  play: CardPattern,
  hand: Card[],
  currentLevel: number,
  isFreePlay: boolean,
  context?: AiDecisionContext,
  protectedCardIds: ReadonlySet<number> = new Set(),
): number {
  if (play.cards.length === hand.length) return 1_000_000;
  const handCounts = getRankCounts(hand);
  const playedCounts = getRankCounts(play.cards);
  const lastPlayer = context?.players.find(player => player.seatIndex === context.lastPlayPlayerIndex);
  const partnerLed = lastPlayer?.relation === 'partner';
  const opponentLed = lastPlayer?.relation === 'opponent';
  const urgentOpponent = context?.players.some(player =>
    player.relation === 'opponent' && player.finishRank === null && player.cardCount <= 5
  ) || false;

  const sequence = [PatternType.Straight, PatternType.ConsecutivePair, PatternType.Plane,
    PatternType.FlushStraight].includes(play.type);
  const stake = roundStake(context);
  let score = play.cards.length * 120 - (sequence ? play.rank : effectiveRank(play.rank, currentLevel)) * 6;
  if (play.cards.length > 1) score += 100;
  if ([PatternType.Straight, PatternType.TriplePair, PatternType.ConsecutivePair, PatternType.Plane].includes(play.type)) {
    score += 100;
  }

  // A card which belongs to a bomb/king bomb/flush straight or is a wildcard
  // has high option value. Penalise partial destruction, not playing it whole.
  for (const [rank, selected] of playedCounts) {
    const held = handCounts.get(rank)?.length || 0;
    if (held >= 4 && selected.length < held) score -= 650;
    else if (held === 3 && selected.length < held) score -= 80;
    else if (held === 2 && selected.length === 1) score -= 45;
  }
  if (!isBombPattern(play)) {
    const late = hand.length <= 10 || context?.players.some(p => p.finishRank === null && p.cardCount <= 5);
    score -= play.cards.filter(card => isWildCard(card, currentLevel)).length * (late ? 90 : 260);
    score -= play.cards.filter(isJoker).length * (late ? 35 : 100);
    score -= play.cards.filter(card => protectedCardIds.has(card.id)).length * 90;
  }

  if (isBombPattern(play)) {
    // Taking the trick with a bomb has the same immediate benefit regardless
    // of size. Cancel the generic shedding bonus and charge for bomb strength;
    // whole-hand finishes still take priority above. Keep leading costs finite
    // so intact bombs beat dismantling the only remaining structures. The cost
    // scales inversely with the round stake: a trailing team spends bombs to
    // take control, a leading team hoards them for defense.
    const tier = play.type === PatternType.KingBomb ? 8
      : play.type === PatternType.FlushStraight ? 1.5 : play.cards.length - 4;
    // Urgency decides whether a bomb is worth spending, but must never make a
    // larger sufficient bomb cheaper than a smaller one. Cancel the generic
    // shedding reward unconditionally and only discount part of the tier cost.
    score -= play.cards.length * 120 + 100;
    score -= tier * (100 + 40 * (2 - stake));
    // Apply match urgency equally to every bomb so it affects the bomb/pass
    // decision without reversing the ordering between sufficient bombs.
    score += (stake - 1) * 400;
    if (partnerLed) score -= 20_000;
    if (opponentLed && lastPlayer && lastPlayer.cardCount <= 14) score += 650 * stake;
    if (urgentOpponent) score += 600 * stake;
  }

  if (!isFreePlay && !isBombPattern(play)) score += 350 * stake;
  if (partnerLed) score -= 15_000;

  if (isFreePlay && context) {
    const partner = context.players.find(player => player.relation === 'partner' && player.finishRank === null);
    const opponents = context.players.filter(player => player.relation === 'opponent' && player.finishRank === null);
    if (partner?.cardCount === play.cards.length) score += 900 * stake;
    if (opponents.some(player => player.cardCount === play.cards.length)) score -= 350;
  }

  // Round-outcome shaping from finish ranks: partner already first means our
  // own finish is worth a 双上 (+3), so shed aggressively; an opponent already
  // first means the other opponent's rank decides the upgrade we concede, so
  // block their tricks harder.
  const partnerHead = context?.players.some(player =>
    player.relation === 'partner' && player.finishRank === 1);
  const opponentHead = context?.players.some(player =>
    player.relation === 'opponent' && player.finishRank === 1);
  if (partnerHead && !isBombPattern(play)) score += play.cards.length * 25;
  if (opponentHead && lastPlayer?.relation === 'opponent') score += 400 * stake;

  // Prefer the weakest physical realization when declarations are equivalent.
  score -= play.cards.reduce((sum, card) => sum + effectiveRank(card.rank, currentLevel), 0) / 20;
  return score;
}

/** Deterministic round-robin representation; never invents or removes legality. */
export function stratifyCandidates(plays: CardPattern[], hand: Card[], level: number, limit = 160): CardPattern[] {
  const counts = getRankCounts(hand);
  const buckets = new Map<string, CardPattern[]>();
  for (const play of plays) {
    const used = getRankCounts(play.cards);
    const splits = [...used].some(([rank, cards]) => (counts.get(rank)?.length || 0) > cards.length);
    const bombSplit = [...used].some(([rank, cards]) => (counts.get(rank)?.length || 0) >= 4
      && (counts.get(rank)?.length || 0) > cards.length);
    const key = `${play.type}:${play.cards.some(c => isWildCard(c, level))}:${splits}:${bombSplit}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(play);
  }
  const result: CardPattern[] = [];
  for (let row = 0; result.length < limit; row++) {
    let added = false;
    for (const bucket of buckets.values()) {
      if (bucket[row] && result.length < limit) { result.push(bucket[row]); added = true; }
    }
    if (!added) break;
  }
  return result;
}

function orderCandidates(
  plays: CardPattern[],
  hand: Card[],
  currentLevel: number,
  isFreePlay: boolean,
  context?: AiDecisionContext,
  analysis?: DecisionAnalysis,
): CardPattern[] {
  // Evaluate retained same-type controls for every candidate before truncating
  // the model input. A higher disjoint play is potential recapture, not proof
  // that it can beat an opponent's unknown response.
  const controls = new Map<string, CardPattern[]>();
  for (const play of plays) {
    const key = `${play.type}:${play.length}`;
    const group = controls.get(key) || [];
    group.push(play);
    controls.set(key, group);
  }
  for (const group of controls.values()) group.sort((a, b) =>
    canBeat(a, b, currentLevel) ? -1 : canBeat(b, a, currentLevel) ? 1 : 0);
  const recaptureBonus = (play: CardPattern) => {
    const used = new Set(play.cards.map(card => card.id));
    const retained = controls.get(`${play.type}:${play.length}`)?.find(control =>
      canBeat(control, play, currentLevel) && control.cards.every(card => !used.has(card.id)));
    if (!retained) return 0;
    const strength = effectiveRank(retained.rank, currentLevel);
    // Low reserve cards are weak evidence of recapture; even A is not a lock.
    return strength >= effectiveRank(Rank.Ace, currentLevel) ? 75 : 20;
  };
  const protectedCardIds = new Set(plays
    .filter(play => play.type === PatternType.FlushStraight || play.type === PatternType.KingBomb)
    .flatMap(play => play.cards.map(card => card.id)));
  const scores = new Map(plays.map(play => [
    play,
    scorePlay(play, hand, currentLevel, isFreePlay, context, protectedCardIds) + recaptureBonus(play)
      + (analysis?.candidates[analysisKey(play)]
        ? 180 * (analysis.handTurns.turns - analysis.candidates[analysisKey(play)].remainingTurns.turns - 1)
        : 0),
  ]));
  return [...plays].sort((a, b) => scores.get(b)! - scores.get(a)!);
}

export function findBestPlay(
  hand: Card[],
  lastPattern: CardPattern | null,
  isFreePlay: boolean,
  currentLevel: number,
  context?: AiDecisionContext,
): CardPattern | null {
  let legalPlays = generateLegalPlays(hand, currentLevel);

  if (!isFreePlay && lastPattern) {
    legalPlays = legalPlays.filter(p => canBeat(p, lastPattern, currentLevel));
  }

  if (legalPlays.length === 0) return null;
  legalPlays = dedupeStrategicPlays(legalPlays);
  const ordered = orderCandidates(legalPlays, hand, currentLevel, isFreePlay, context);
  if (!isFreePlay && context) {
    const lastPlayer = context.players.find(player => player.seatIndex === context.lastPlayPlayerIndex);
    const passScore = lastPlayer?.relation === 'partner'
      ? 100_000
      : lastPlayer?.cardCount !== undefined && lastPlayer.cardCount <= 3 ? -10_000 : 0;
    if (scorePlay(ordered[0], hand, currentLevel, false, context) <= passScore) return null;
  }
  return ordered[0] || null;
}

export function findBestTribute(hand: Card[], currentLevel: number): Card {
  let best = hand[0];
  let bestScore = Infinity;

  for (const c of hand) {
    let score = c.rank * 10;
    if (isJoker(c)) score += 1000;
    if (c.rank === (currentLevel as Rank)) score += 500;
    if (c.rank >= Rank.Ace) score += 100;

    const rankCount = hand.filter(h => h.rank === c.rank).length;
    if (rankCount >= 3) score += 200;
    if (rankCount === 1) score -= 50;

    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }

  return best;
}

function materiallyBetterSimulation(
  play: CardPattern, alternative: CardPattern | null, analysis?: DecisionAnalysis,
): boolean {
  const result = analysis?.candidates[analysisKey(play)]?.simulation;
  const other = alternative
    ? analysis?.candidates[analysisKey(alternative)]?.simulation : analysis?.passSimulation;
  // Small samples and marginal differences must not override team cooperation
  // or spending the weakest sufficient card. A sampled 100% is not proof.
  return !!result && !!other && result.samples >= 8 && result.samples === other.samples
    && result.meanReward - other.meanReward >= 0.25;
}

/** Publicly provable interception of a reported single: the weaker card can be
 * overtaken, while no unseen single can beat the proposed card. No hidden hands. */
function blocksReportedSingle(
  play: CardPattern, weaker: CardPattern, hand: Card[], level: number,
  context?: AiDecisionContext,
): boolean {
  if (play.type !== PatternType.Single || weaker.type !== PatternType.Single || !context
    || !context.players.some(p => p.relation === 'opponent' && p.finishRank === null && p.cardCount === 1)) return false;
  const memory = buildPublicKnowledge(hand, context);
  if (!memory) return false;
  return memory.unseen.some(card => effectiveRank(card.rank, level) > effectiveRank(weaker.rank, level))
    && memory.unseen.every(card => effectiveRank(card.rank, level) <= effectiveRank(play.rank, level));
}

/** Enforced for both LLM replies and local fallback; explanations alone cannot
 * authorize overtaking the partner or spending a stronger equivalent group. */
export function enforceTeamStrategy(
  proposed: CardPattern | null, candidates: CardPattern[], hand: Card[],
  last: CardPattern | null, free: boolean, level: number,
  context?: AiDecisionContext, analysis?: DecisionAnalysis,
): CardPattern | null {
  const finish = candidates.find(play => play.cards.length === hand.length);
  if (finish) return finish;
  if (!proposed) return null;
  const partnerLed = !free && last && context
    && context.lastPlayPlayerIndex === context.partnerSeatIndex;
  if (partnerLed && last) {
    const urgent = context?.players.some(p => p.relation === 'opponent'
      && p.finishRank === null && p.cardCount <= 5);
    if (!blocksReportedSingle(proposed, last, hand, level, context)
      && !(urgent && materiallyBetterSimulation(proposed, null, analysis))) return null;
  }
  const alternatives = candidates.filter(play => play.cards.length === proposed.cards.length
    && (play.type === proposed.type || (isBombPattern(play) && isBombPattern(proposed)))
    && canBeat(proposed, play, level)
    && (free || canBeat(play, last, level)));
  const ordered = orderCandidates([...alternatives, proposed], hand, level, free, context, analysis);
  for (const lower of ordered) {
    if (lower === proposed) break;
    const lowerTurns = analysis?.candidates[analysisKey(lower)]?.remainingTurns;
    const proposedTurns = analysis?.candidates[analysisKey(proposed)]?.remainingTurns;
    if (lowerTurns && proposedTurns && lowerTurns.turns > proposedTurns.turns) continue;
    if (materiallyBetterSimulation(proposed, lower, analysis)
      || blocksReportedSingle(proposed, lower, hand, level, context)) continue;
    // Do not weaken an interception of the partner's trick back into a pass.
    if (partnerLed && last && !blocksReportedSingle(lower, last, hand, level, context)
      && !materiallyBetterSimulation(lower, null, analysis)) continue;
    return lower;
  }
  return proposed;
}

export async function findSmartPlay(
  hand: Card[],
  lastPattern: CardPattern | null,
  isFreePlay: boolean,
  currentLevel: number,
  context?: AiDecisionContext,
  selection?: AiModelSelection,
): Promise<CardPattern | null> {
  const ruleResult = findBestPlay(hand, lastPattern, isFreePlay, currentLevel, context);
  const allPlays = generateLegalPlays(hand, currentLevel);
  let legalPlays = allPlays;
  if (!isFreePlay && lastPattern) {
    legalPlays = legalPlays.filter(play => canBeat(play, lastPattern, currentLevel));
  }
  legalPlays = dedupeStrategicPlays(legalPlays);
  // Skip strategic analysis only when there is genuinely no choice. During a
  // follow, PASS is also legal and even one playable bomb is a real decision.
  if (isForcedAiDecision(legalPlays.length, isFreePlay)) {
    return enforceTeamStrategy(
      ruleResult, legalPlays, hand, lastPattern, isFreePlay, currentLevel, context,
    );
  }
  // The hint system keeps the exhaustive list. The LLM receives the strongest
  // Base7-ranked slice so a combinatorial hand cannot overflow its context.
  legalPlays = stratifyCandidates(
    orderCandidates(legalPlays, hand, currentLevel, isFreePlay, context), hand, currentLevel, MAX_LLM_CANDIDATES);
  const analysis = await analyzeDecision(
    hand, allPlays, legalPlays, isFreePlay ? null : lastPattern,
    currentLevel, context, findBestPlay,
  );
  legalPlays = orderCandidates(legalPlays, hand, currentLevel, isFreePlay, context, analysis);
  let fallbackResult = (isFreePlay || ruleResult) ? legalPlays[0] || ruleResult : null;
  // Do not let one lucky hidden-hand sample override the baseline. Compare
  // paired, completed simulations only, retaining baseline preference on ties.
  if (analysis.simulation.samples >= 4) {
    const simulated = legalPlays.filter(play => analysis.candidates[analysisKey(play)]?.simulation);
    simulated.sort((a, b) => analysis.candidates[analysisKey(b)].simulation!.meanReward
      - analysis.candidates[analysisKey(a)].simulation!.meanReward);
    if (simulated.length) {
      fallbackResult = simulated[0];
      const best = analysis.candidates[analysisKey(simulated[0])].simulation!;
      if (analysis.passSimulation && (analysis.passSimulation.meanReward > best.meanReward
        || (!ruleResult && analysis.passSimulation.meanReward === best.meanReward))) fallbackResult = null;
    }
  }

  try {
    const llmResult = await llmFindBestPlay(
      hand,
      legalPlays,
      lastPattern,
      isFreePlay,
      currentLevel,
      context,
      selection,
      analysis,
    );
    // undefined means the model was unavailable/invalid; null is an intentional pass.
    if (llmResult !== undefined) return enforceTeamStrategy(
      llmResult, legalPlays, hand, lastPattern, isFreePlay, currentLevel, context, analysis,
    );
  } catch {}

  return enforceTeamStrategy(
    fallbackResult, legalPlays, hand, lastPattern, isFreePlay, currentLevel, context, analysis,
  );
}

export function isForcedAiDecision(playableCount: number, isFreePlay: boolean): boolean {
  return playableCount === 0 || (isFreePlay && playableCount === 1);
}

export function findBestReturnTribute(hand: Card[]): Card {
  let best = hand[0];
  let bestScore = 0;

  for (const c of hand) {
    let score = c.rank * 10;
    if (isJoker(c)) score -= 1000;

    const rankCount = hand.filter(h => h.rank === c.rank).length;
    if (rankCount === 1) score += 100;
    if (rankCount >= 4) score -= 200;

    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  return best;
}
