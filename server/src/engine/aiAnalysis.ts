import { Card, CardPattern, PatternType, Rank, Suit } from '../../../shared/types';
import { createDeck, effectiveRank } from './card';
import { canBeat, isBombPattern } from './compare';
import type { AiDecisionContext, AiRecentAction } from './llmAi';

export type ChoosePlay = (
  hand: Card[], last: CardPattern | null, free: boolean, level: number,
  context: AiDecisionContext,
) => CardPattern | null;

/** The unchanged trick after our PASS: who can still respond, or who gets
 * the next lead (including catch-wind after a finished leader). */
export function passPosition(context: AiDecisionContext, last?: CardPattern | null) {
  const active = context.players.filter(player => player.finishRank === null);
  const leader = context.players.find(player => player.seatIndex === context.lastPlayPlayerIndex);
  const needed = active.length - (leader?.finishRank === null ? 1 : 0);
  const remaining = Math.max(0, needed - (context.passCount || 0) - 1);
  const responders: number[] = [];
  for (let step = 1; step <= 4 && responders.length < remaining; step++) {
    const seat = (context.selfSeatIndex + step) % 4;
    if (seat !== context.selfSeatIndex && seat !== leader?.seatIndex
      && active.some(player => player.seatIndex === seat)) responders.push(seat);
  }
  let nextLead = leader?.seatIndex;
  if (leader && leader.finishRank !== null) {
    const partner = (leader.seatIndex + 2) % 4;
    for (let step = 0; step < 4; step++) {
      const seat = (partner + step) % 4;
      if (active.some(player => player.seatIndex === seat)) { nextLead = seat; break; }
    }
  }
  const partner = active.find(player => player.seatIndex === context.partnerSeatIndex);
  // A hand shorter than the table shape can still respond with a bomb.
  // Enough cards means possible, never that the partner holds a response.
  const partnerMayRespond = !!partner && responders.includes(partner.seatIndex)
    && (!last || (last.type !== PatternType.KingBomb && partner.cardCount >= Math.min(last.length, 4)));
  return { closesTrick: remaining === 0, responders, nextLead, partnerMayRespond };
}

/**
 * Guandan endgame defence against the clockwise next player: once the AI has
 * decided to play the reported shape, it must use its strongest legal one.
 * This deliberately does not force a single/pair lead or turn a PASS into a
 * play; it only replaces a chosen single/pair with the largest equivalent.
 */
export function enforceReportedNextPlayerMaximum(
  proposed: CardPattern | null,
  candidates: CardPattern[],
  nextPlayerCardCount: number,
  level: number,
): CardPattern | null {
  if (!proposed) return proposed;
  const requiredType = nextPlayerCardCount === 1
    ? PatternType.Single
    : nextPlayerCardCount === 2
      ? PatternType.Pair
      : null;
  if (requiredType === null || proposed.type !== requiredType) return proposed;

  const sameType = candidates.filter(play => play.type === requiredType);
  return sameType.reduce((strongest, play) =>
    canBeat(play, strongest, level) ? play : strongest, proposed);
}

/** A same-rank bomb can be played as dealt, including hearts at their printed
 * level. Substituted ranks never enter the inventory of physical cards. */
export function rankBombChanges(hand: Card[], play: CardPattern) {
  const held = rankCounts(hand);
  const spent = rankCounts(play.cards);
  return [...held].filter(([rank, count]) => rank <= Rank.Ace && count >= 4 && spent.has(rank))
    .map(([rank, before]) => ({ rank, before, after: before - spent.get(rank)!,
      playedAsBomb: play.type.startsWith('bomb') && play.rank === rank }));
}

export function resourceCost(hand: Card[], play: CardPattern, level: number) {
  const used = new Set(play.cards.map(c => c.id));
  const remaining = hand.filter(c => !used.has(c.id));
  const changes = rankBombChanges(hand, play);
  const counts = rankCounts(remaining);
  return {
    broken_natural_bombs: changes.filter(b => !b.playedAsBomb && b.after < 4).map(b => b.rank),
    weakened_natural_bombs: changes.filter(b => b.after >= 4).map(b => b.rank),
    remaining_rank_bombs: [...counts].filter(([rank, n]) => rank <= Rank.Ace && n >= 4)
      .map(([rank, count]) => ({ rank, count })),
    remaining_low_singletons: remaining.filter(c => effectiveRank(c.rank, level) < Rank.Queen
      && counts.get(c.rank) === 1).length,
    remaining_high_cards: remaining.filter(c => effectiveRank(c.rank, level) >= effectiveRank(Rank.Ace, level)).length,
    natural_level_cards_spent: play.cards.filter(c => c.rank === level && c.suit !== Suit.Heart).length,
    remaining_natural_level_cards: remaining.filter(c => c.rank === level && c.suit !== Suit.Heart).length,
  };
}

export function tailControlCost(hand: Card[], play: CardPattern, allPlays: CardPattern[], level: number): number {
  if (isBombPattern(play) || hand.length > 12 || play.cards.length === hand.length
    || !play.cards.some(c => effectiveRank(c.rank, level) >= effectiveRank(Rank.Ace, level))) return 0;
  const used = new Set(play.cards.map(c => c.id));
  const spentStrength = Math.max(...play.cards.map(c => effectiveRank(c.rank, level)));
  // A lower high card is not a replacement for the control just spent. In
  // particular, a level singleton cannot replace a pair of big jokers.
  const reserves = allPlays.filter(p => p.cards.every(c => !used.has(c.id)));
  if (reserves.some(p => isBombPattern(p)
    || ([PatternType.Single, PatternType.Pair].includes(p.type)
      && effectiveRank(p.rank, level) >= spentStrength))) return 0;
  const grouped = new Set(allPlays.filter(p => p.cards.length > 1 && p.cards.every(c => !used.has(c.id)))
    .flatMap(p => p.cards.map(c => c.id)));
  const stranded = hand.filter(c => !used.has(c.id) && !grouped.has(c.id)
    && effectiveRank(c.rank, level) < Rank.Queen).length;
  return 160 * Math.min(2, stranded);
}

export interface TurnEstimate {
  turns: number;
  exact: boolean;
}

export interface SampleResult {
  samples: number;
  winRate: number;
  doubleWinRate: number;
  /** Signed expected upgrade reward, -1 to 1. Not a calibrated win probability. */
  meanReward: number;
}

export interface DecisionAnalysis {
  trickForecast?: Record<string, TrickForecast>;
  teamPlan?: TeamPlan;
  teamRoutes?: TeamRoute[];
  seatBeliefs?: SeatBelief[];
  handTurns: TurnEstimate;
  candidates: Record<string, { remainingTurns: TurnEstimate; simulation?: SampleResult; endgameRoute?: EndgameRoute; replyFinishRisk?: { samples: number; rate: number }; continuation?: { extraTurns: number; exact: boolean; largestRemainingGroup: number; tailControlCost?: number } }>;
  passSimulation?: SampleResult;
  simulation: { status: string; samples: number; elapsedMs: number };
}

/** Position after each other active seat has had at most one response. The
 * current leader may still be beaten after this horizon. Not a win probability. */
export interface TrickForecast {
  samples: number;
  teamAhead: number;
  partnerAhead: number;
  allyExit: number;
  enemyExit: number;
}

export function forecastTrick(hand: Card[], candidates: CardPattern[], last: CardPattern | null,
  level: number, context: AiDecisionContext, generate: GenerateReplies, deadline: number,
  random: () => number = Math.random): Record<string, TrickForecast> | undefined {
  const knowledge = buildPublicKnowledge(hand, context);
  if (!knowledge || (last && !context.players.some(p => p.seatIndex === context.lastPlayPlayerIndex))) return;
  const self = context.selfSeatIndex;
  // Opponents respond to a declaration, independent of which physical
  // realization we use. Residual structure stays specific to the actual cards.
  const shape = (p: CardPattern | null) => p ? [p.type, p.rank, p.length].join(':') : 'PASS';
  const options: Array<CardPattern | null> = last ? [...candidates, null] : candidates;
  const roots = [...new Map(options.map(p => [shape(p), p])).values()];
  const totals = roots.map(() => ({ samples: 0, teamAhead: 0, partnerAhead: 0, allyExit: 0, enemyExit: 0 }));
  for (let sample = 0; sample < 8 && performance.now() < deadline; sample++) {
    const deal = sampleHiddenHandsWeighted(hand, context, knowledge, level, random, 2);
    if (!deal) break;
    // Build each seat's responses once per deal, using only that seat's hand.
    const replies = deal.map((cards, seat) => {
      if (!cards.length || seat === self) return [];
      const counts = rankCounts(cards);
      const options = generate(cards, level).map(play => {
        const heldBomb = play.cards.some(c => (counts.get(c.rank) || 0) >= 4);
        const price = (isBombPattern(play) ? 1000 + play.length * 10 : heldBomb ? 300 : 0)
          + play.cards.filter(c => c.rank === level || c.rank >= Rank.SmallJoker).length * 100
          + effectiveRank(play.rank, level);
        return { play, price };
      });
      return options.sort((a, b) => a.price - b.price).map(o => o.play);
    });
    // Opponents also see a reported hand. If they contest a feed before a
    // short rival, evaluate a blocking single/pair instead of an automatic low reply.
    const blocks = replies.map((options, seat) => {
      const next = (seat + 1) % 4;
      return [null, ...[1, 2].map(count => {
        if (next !== self && deal[next].length !== count) return null;
        const first = options.find(p => p.type === (count === 1 ? PatternType.Single : PatternType.Pair));
        return first ? enforceReportedNextPlayerMaximum(first, options, count, level) : null;
      })];
    });
    for (const [index, root] of roots.entries()) {
      const n = deal.map(cards => cards.length);
      let leader = root ? self : context.lastPlayPlayerIndex;
      let trick = root || last;
      let passes = root ? 0 : (context.passCount || 0) + 1;
      const total = totals[index];
      if (root) n[self] -= root.cards.length;
      let exit = root && !n[self] ? self : -1;
      for (let step = 1; step < 4 && exit < 0; step++) {
        if (passes >= n.filter((count, s) => count > 0 && s !== leader).length) break;
        const seat = (self + step) % 4;
        if (!n[seat]) continue;
        const beats = (p: CardPattern) => canBeat(p, trick, level);
        const finish = replies[seat].find(p => p.cards.length === n[seat] && beats(p));
        const contest = leader % 2 !== seat % 2;
        let response = finish || (contest && replies[seat].find(p => beats(p)
          && (!isBombPattern(p) || n[leader] <= 5)));
        const block = blocks[seat][n[(seat + 1) % 4]];
        if (!finish && response && block?.type === response.type && canBeat(block, response, level)) {
          response = block;
        }
        if (!response) { passes++; continue; }
        n[seat] -= response.cards.length;
        leader = seat; trick = response; passes = 0;
        if (!n[seat]) exit = seat;
      }
      if (exit >= 0) {
        if (exit % 2 === self % 2) total.allyExit++; else total.enemyExit++;
      } else if (!n[leader]) {
        // The original finishing player led the trick; award a closed pass
        // sequence to the actual catch-wind seat.
        const partner = (leader + 2) % 4;
        for (let i = 0; i < 4; i++) {
          const s = (partner + i) % 4;
          if (n[s]) { leader = s; break; }
        }
      }
      total.teamAhead += Number(leader % 2 === self % 2);
      total.partnerAhead += Number(leader === context.partnerSeatIndex);
      total.samples++;
    }
  }
  if (!totals.length || totals[0].samples < 4) return;
  const byShape = new Map(roots.map((p, i) => {
    const t = totals[i], n = t.samples;
    return [shape(p), { samples: n, teamAhead: t.teamAhead / n,
      partnerAhead: t.partnerAhead / n, allyExit: t.allyExit / n, enemyExit: t.enemyExit / n }];
  }));
  return Object.fromEntries(options.map(p => [p ? analysisKey(p) : 'PASS', byShape.get(shape(p))!]));
}

export interface EndgameRoute {
  intent: 'probe_then_recapture' | 'control_then_finish';
  recapture?: { type: PatternType; rank: Rank; length: number };
  exit?: { type: PatternType; rank: Rank; length: number };
  controlProven: boolean;
  sameShapeControl: boolean;
  score: number;
  caveat: string;
}

/** Up to three own plays on short hands; this is a route, not a game-tree
 * solution. A possible high response is never labelled guaranteed control. */
export function analyzeEndgameRoutes(
  hand: Card[], allPlays: CardPattern[], level: number, context?: AiDecisionContext,
): Record<string, EndgameRoute> {
  if (hand.length > 8 || hand.length < 2) return {};
  const bits = new Map(hand.map((card, i) => [card.id, 1 << i]));
  const maskOf = (play: CardPattern) => play.cards.reduce((mask, card) => mask | bits.get(card.id)!, 0);
  const byMask = new Map(allPlays.map(play => [maskOf(play), play]));
  const full = (1 << hand.length) - 1;
  const controls = allPlays.filter(play => [PatternType.Single, PatternType.Pair].includes(play.type)
    && effectiveRank(play.rank, level) >= effectiveRank(Rank.Ace, level));
  const evidence = new Map(controls.map(play => [play, publicControlEvidence(play, hand, level, context)]));
  const shape = (play: CardPattern) => ({ type: play.type, rank: play.rank, length: play.length });
  const routes: Record<string, EndgameRoute> = {};
  for (const play of allPlays) {
    const mask = maskOf(play);
    const exit = byMask.get(full ^ mask);
    if (exit && evidence.get(play)?.unbeatable) {
      routes[analysisKey(play)] = { intent: 'control_then_finish', exit: shape(exit),
        controlProven: true, sameShapeControl: true, score: 700, caveat: '公开未见牌无法压制控制张，获牌权后余牌可一手走完' };
    }
    // Never probe in a shape that may let an opponent finish immediately.
    if (context?.players.some(p => p.relation === 'opponent' && p.finishRank === null
      && p.cardCount === play.length)) continue;
    for (const control of controls) {
      const controlMask = maskOf(control);
      if ((mask & controlMask) || control.type !== play.type || !canBeat(control, play, level)) continue;
      const tailMask = full ^ mask ^ controlMask;
      const tail = byMask.get(tailMask);
      if (tailMask !== 0 && !tail) continue;
      const proof = evidence.get(control);
      // An equal control can answer the probe first, even though it cannot
      // beat our control once led. A guaranteed recapture rules out ties too.
      const certain = proof?.unbeatable === true && !proof.equalShapePossible;
      const route: EndgameRoute = { intent: 'probe_then_recapture', recapture: shape(control),
        exit: tail ? shape(tail) : undefined, controlProven: certain, sameShapeControl: proof?.ordinaryResponsePossible === false,
        score: certain ? 600 : proof?.ordinaryResponsePossible === false ? 200 : 180,
        caveat: certain ? '先试探；如被接，用保留的控制张回手，再走尾牌'
          : '仅为试探路线；对手先接同级或更大牌、或用炸弹，都可能使回手失败' };
      const key = analysisKey(play);
      if (!routes[key] || route.score > routes[key].score) routes[key] = route;
    }
  }
  return routes;
}

export interface TeamPlan {
  goal: 'finish_self' | 'feed_partner' | 'block_opponent' | 'organize';
  reason: string;
  feedType?: PatternType.Single | PatternType.Pair;
  threatSeat?: number;
}

/** Rebuilt from our cards and public context each turn; never assumes a
 * reported two-card hand is a pair or a pass means no legal response. */
export function buildTeamPlan(
  hand: Card[], allPlays: CardPattern[], context?: AiDecisionContext,
): TeamPlan {
  if (hand.length > 0 && allPlays.some(play => play.cards.length === hand.length)) {
    return { goal: 'finish_self', reason: '本手可直接走完' };
  }
  const partner = context?.players.find(p => p.relation === 'partner');
  const opponents = context?.players.filter(p => p.relation === 'opponent' && p.finishRank === null) || [];
  if (partner?.finishRank === 1) return { goal: 'finish_self', reason: context?.players.some(p => p.relation === 'opponent' && p.finishRank === 2)
      ? '对家已头游，二游已定；争三游'
      : '对家已头游，优先争二游形成双上；对手连续走牌时应主动争权' };
  const threat = opponents.filter(p => p.cardCount <= 2).sort((a, b) => a.cardCount - b.cardCount)[0];
  if (threat) return { goal: 'block_opponent', threatSeat: threat.seatIndex,
    reason: '对手接近走完，优先防守并保留回手' };
  if (partner?.finishRank === null && partner.cardCount <= 2) {
    return { goal: 'feed_partner',
      feedType: partner.cardCount === 1 ? PatternType.Single : PatternType.Pair,
      reason: partner.cardCount === 1 ? '争取牌权后领小单送对家'
        : '争取牌权后尝试领小对；对家两张不保证是对子' };
  }
  // A cheap two-play partition check on short hands, reusing legal actions.
  if (hand.length <= 10) {
    const bits = new Map(hand.map((card, i) => [card.id, 1 << i]));
    const masks = new Set(allPlays.map(play => play.cards.reduce((mask, card) => mask | bits.get(card.id)!, 0)));
    const full = (1 << hand.length) - 1;
    if ([...masks].some(mask => masks.has(full ^ mask))) {
      return { goal: 'finish_self', reason: '手牌可分两手，争取连续牌权；不代表必胜' };
    }
  }
  return { goal: 'organize', reason: '减少难走的牌组，保留控制牌和队友配合机会' };
}

export interface TeamRoute {
  goal: 'finish_self' | 'feed_partner' | 'takeover_change' | 'hold_control' | 'probe_then_recapture' | 'control_then_finish';
  actionKey: string | null;
  nextLead?: { type: PatternType; rank: Rank; length: number };
  recapture?: EndgameRoute['recapture'];
  exit?: EndgameRoute['exit'];
  controlProven?: boolean;
  interceptSeats: number[];
  reason: string;
  simulation?: SampleResult;
}

/** Compare concrete alternatives rather than assigning the whole turn a single
 * goal from card counts. No partner private cards are consulted. */
export function buildTeamRoutes(
  hand: Card[], allPlays: CardPattern[], candidates: CardPattern[], last: CardPattern | null,
  level: number, context: AiDecisionContext | undefined,
  estimates: DecisionAnalysis['candidates'], generate?: GenerateReplies,
): TeamRoute[] {
  if (!context) return [];
  const routes: TeamRoute[] = [];
  const self = [...candidates].sort((a, b) => {
    const left = estimates[analysisKey(a)]?.remainingTurns;
    const right = estimates[analysisKey(b)]?.remainingTurns;
    // An unmeasured action is not equivalent to shedding the most cards.
    // Before analysis, preserve the local ordering; afterwards prefer measured
    // partitions while retaining their exact/approximate flag for the model.
    if (!left && !right) return 0;
    return (left?.turns ?? Infinity) - (right?.turns ?? Infinity);
  })[0];
  if (self) routes.push({ goal: 'finish_self', actionKey: analysisKey(self), interceptSeats: [],
    reason: '比较自己先走的余牌手数和本方最终名次，不能只看本手出牌数量' });
  const endgames = analyzeEndgameRoutes(hand, allPlays, level, context);
  const intents = new Set<string>();
  for (const play of [...candidates].filter(p => endgames[analysisKey(p)])
    .sort((a, b) => endgames[analysisKey(b)].score - endgames[analysisKey(a)].score)) {
    const route = endgames[analysisKey(play)];
    if (intents.has(route.intent)) continue;
    intents.add(route.intent);
    routes.push({ goal: route.intent, actionKey: analysisKey(play),
      recapture: route.recapture, exit: route.exit, controlProven: route.controlProven,
      interceptSeats: [], reason: route.caveat });
  }
  const partner = context.players.find(p => p.relation === 'partner' && p.finishRank === null);
  if (partner && partner.cardCount <= 5) {
    const memory = buildPublicKnowledge(hand, context);
    const known = memory?.knownBySeat[partner.seatIndex] || [];
    const knownPlays = generate && known.length === partner.cardCount ? generate(known, level) : undefined;
    // Two remaining cards may be separate singles. Consider both leads unless
    // publicly known cards rule one out; wider shapes require matching count.
    const feeds = (last ? allPlays : candidates).filter(play => !isBombPattern(play)
      && (play.cards.length === partner.cardCount || play.type === PatternType.Single)
      && (!knownPlays || knownPlays.some(response => canBeat(response, play, level))))
      .sort((a, b) => effectiveRank(a.rank, level) - effectiveRank(b.rank, level));
    const shapes = new Set<PatternType>();
    for (const feed of feeds) {
      if (shapes.has(feed.type)) continue;
      shapes.add(feed.type);
      const interceptSeats = context.players.filter(p => p.relation === 'opponent'
        && p.finishRank === null && p.cardCount === feed.cards.length
        && (p.seatIndex - context.selfSeatIndex + 4) % 4
          < (partner.seatIndex - context.selfSeatIndex + 4) % 4).map(p => p.seatIndex);
      const reason = knownPlays ? '公开贡牌证实队友可接；仍须考虑中间对手拦截'
        : '队友可能接上，牌数不能证明牌型；同时比较其他送牌方式';
      if (!last) {
        const lead = candidates.find(play => analysisKey(play) === analysisKey(feed));
        if (lead) routes.push({ goal: 'feed_partner', actionKey: analysisKey(lead), interceptSeats, reason });
      } else {
        const feedIds = new Set(feed.cards.map(card => card.id));
        const costs = new Map(candidates.map(p => [p, resourceCost(hand, p, level).broken_natural_bombs.length]));
        const takeover = candidates.filter(play => !play.cards.some(card => feedIds.has(card.id)))
          .sort((a, b) => {
            const lock = (p: CardPattern) => Number(publicControlEvidence(p, hand, level, context)?.unbeatable === true);
            const resource = (p: CardPattern) => costs.get(p)!;
            return lock(b) - lock(a) || resource(a) - resource(b)
              || Number(isBombPattern(a)) - Number(isBombPattern(b))
              || effectiveRank(a.rank, level) - effectiveRank(b.rank, level);
          })[0];
        if (takeover) routes.push({ goal: 'takeover_change', actionKey: analysisKey(takeover), interceptSeats,
          nextLead: { type: feed.type, rank: feed.rank, length: feed.length },
          controlProven: publicControlEvidence(takeover, hand, level, context)?.unbeatable === true,
          reason: `接管后保留送牌；必须先获得牌权，不能假定对手不再压制。${reason}` });
      }
      if (shapes.size >= 2) break;
    }
  }
  if (last) routes.push({ goal: 'hold_control', actionKey: null, interceptSeats: [],
    reason: context.lastPlayPlayerIndex === context.partnerSeatIndex
      ? '让队友继续走，自己保留控制牌；比较是否会被对手截走'
      : '暂让牌权、保留控制牌和结构；比较对手连续出牌的代价' });
  return routes;
}

export function analysisKey(play: CardPattern): string {
  return `${play.type}:${play.rank}:${play.cards.map(card => card.id).sort((a, b) => a - b).join(',')}`;
}

export interface PublicKnowledge {
  played: Card[];
  unseen: Card[];
  knownBySeat: Card[][];
}

export interface PublicControlEvidence {
  /** True only when the aggregate unseen pool cannot contain any response. */
  unbeatable: boolean;
  /** Conservative: cards are pooled across opponents, so true is possibility, not ownership proof. */
  bombPossible: boolean;
  ordinaryResponsePossible: boolean;
  equalShapePossible: boolean;
}

const publicControlCache = new WeakMap<AiDecisionContext, Map<string, PublicControlEvidence | null>>();

function rankCounts(cards: Card[]): Map<Rank, number> {
  const counts = new Map<Rank, number>();
  for (const card of cards) counts.set(card.rank, (counts.get(card.rank) || 0) + 1);
  return counts;
}

function abstractPattern(type: PatternType, rank: Rank, length: number): CardPattern {
  return { type, rank, length, cards: [] };
}

/** Pool unseen cards conservatively. With a seat's public remaining count,
 * the proof applies only to responses by a hand of at most that size. */
export function publicControlEvidence(
  play: CardPattern, hand: Card[], level: number, context?: AiDecisionContext,
  maxReplyCards = Infinity,
): PublicControlEvidence | null {
  if (!context) return null;
  let contextCache = publicControlCache.get(context);
  if (!contextCache) {
    contextCache = new Map();
    publicControlCache.set(context, contextCache);
  }
  const cacheKey = `${level}:${hand.map(card => card.id).sort((a, b) => a - b).join(',')}:${play.type}:${play.rank}:${play.length}:${maxReplyCards}`;
  if (contextCache.has(cacheKey)) return contextCache.get(cacheKey)!;
  const knowledge = buildPublicKnowledge(hand, context);
  if (!knowledge) {
    contextCache.set(cacheKey, null);
    return null;
  }
  const counts = rankCounts(knowledge.unseen);
  const wilds = knowledge.unseen.filter(card => card.rank === level && card.suit === Suit.Heart).length;
  const canMake = (rank: Rank, size: number) => (counts.get(rank) || 0)
    - (rank === level ? wilds : 0) + (rank <= Rank.Ace ? wilds : 0) >= size;
  const possibleBombs: CardPattern[] = [];
  for (let rank = Rank.Two; rank <= Rank.Ace; rank++) {
    for (let size = 4; size <= 10; size++) {
      if (canMake(rank, size)) possibleBombs.push(abstractPattern(`bomb${size}` as PatternType, rank, size));
    }
  }
  const jokers = (counts.get(Rank.SmallJoker) || 0) + (counts.get(Rank.BigJoker) || 0);
  if (jokers === 4) possibleBombs.push(abstractPattern(PatternType.KingBomb, Rank.BigJoker, 4));
  const sequenceRanks: Rank[][] = [[Rank.Ace, Rank.Two, Rank.Three, Rank.Four, Rank.Five]];
  for (let start = Rank.Two; start <= Rank.Ten; start++) {
    sequenceRanks.push(Array.from({ length: 5 }, (_, index) => (start + index) as Rank));
  }
  for (const suit of [Suit.Spade, Suit.Heart, Suit.Club, Suit.Diamond]) {
    for (const run of sequenceRanks) {
      const missing = run.filter(rank => !knowledge.unseen.some(card =>
        card.rank === rank && card.suit === suit && !(card.rank === level && card.suit === Suit.Heart)
      )).length;
      if (missing <= wilds) {
        possibleBombs.push(abstractPattern(PatternType.FlushStraight, run[run.length - 1], 5));
      }
    }
  }
  const bombPossible = possibleBombs.some(candidate => candidate.length <= maxReplyCards && canBeat(candidate, play, level));
  let ordinaryResponse = false;
  if (play.type === PatternType.Single) {
    ordinaryResponse = knowledge.unseen.some(card =>
      effectiveRank(card.rank, level) > effectiveRank(play.rank, level));
  } else if (play.type === PatternType.Pair) {
    for (let rank = Rank.Two; rank <= Rank.BigJoker; rank++) {
      if (effectiveRank(rank, level) > effectiveRank(play.rank, level) && canMake(rank, 2)) {
        ordinaryResponse = true;
        break;
      }
    }
  } else {
    // Only singles and pairs currently receive a lock bonus. Other shapes need
    // a complete declaration feasibility proof before they can be certified.
    ordinaryResponse = true;
  }
  const ordinaryResponsePossible = ordinaryResponse && play.length <= maxReplyCards;
  const equalShapePossible = play.length <= maxReplyCards && (play.type === PatternType.Single
    ? (counts.get(play.rank) || 0) > 0 : play.type === PatternType.Pair && canMake(play.rank, 2));
  const evidence = { unbeatable: !ordinaryResponsePossible && !bombPossible, bombPossible, ordinaryResponsePossible, equalShapePossible };
  contextCache.set(cacheKey, evidence);
  return evidence;
}

/** Never accepts other players' real hands. Cards are removed by physical ID,
 * so a played wildcard removes the heart level card, not its declared rank. */
export function buildPublicKnowledge(hand: Card[], context: AiDecisionContext): PublicKnowledge | null {
  if (!context.actionHistory) return null;
  const deck = createDeck();
  const byId = new Map(deck.map(card => [card.id, card]));
  const seen = new Set<number>();
  const validCard = (card: Card) => {
    const actual = byId.get(card.id);
    return actual?.rank === card.rank && actual?.suit === card.suit;
  };
  for (const card of hand) {
    if (!validCard(card) || seen.has(card.id)) return null;
    seen.add(card.id);
  }
  const played: Card[] = [];
  for (const action of context.actionHistory) {
    if (action.action !== 'play') continue;
    if (!action.pattern) return null;
    for (const card of action.pattern.cards) {
      if (!validCard(card) || seen.has(card.id)) return null;
      seen.add(card.id);
      played.push(card);
    }
  }
  const unseen = deck.filter(card => !seen.has(card.id));
  const knownBySeat: Card[][] = Array.from({ length: 4 }, () => []);
  const owners = new Map<number, number>();
  for (const transfer of context.publicTransfers || []) {
    if (!validCard(transfer.card) || transfer.toSeat < 0 || transfer.toSeat > 3) return null;
    owners.set(transfer.card.id, transfer.toSeat);
  }
  for (const card of unseen) {
    const seat = owners.get(card.id);
    if (seat !== undefined) {
      if (seat === context.selfSeatIndex) return null;
      knownBySeat[seat].push(card);
    }
  }
  return { played, unseen, knownBySeat };
}

/** Uniform hidden-hand samples constrained by public counts and transfers.
 * A pass is NOT proof that a player cannot beat the trick. */
export function sampleHiddenHands(
  hand: Card[], context: AiDecisionContext, knowledge: PublicKnowledge,
  random: () => number = Math.random,
): Card[][] | null {
  if (context.players.length !== 4 || new Set(context.players.map(p => p.seatIndex)).size !== 4) return null;
  const hands = knowledge.knownBySeat.map(cards => [...cards]);
  const assigned = new Set(hands.flat().map(card => card.id));
  const pool = knowledge.unseen.filter(card => !assigned.has(card.id));
  for (let index = pool.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [pool[index], pool[other]] = [pool[other], pool[index]];
  }
  hands[context.selfSeatIndex] = [...hand];
  let offset = 0;
  for (const player of context.players) {
    if (player.seatIndex < 0 || player.seatIndex > 3 || !Number.isInteger(player.cardCount)) return null;
    if (player.seatIndex === context.selfSeatIndex) {
      if (player.cardCount !== hand.length) return null;
      continue;
    }
    if (player.finishRank !== null && player.cardCount !== 0) return null;
    const need = player.cardCount - hands[player.seatIndex].length;
    if (need < 0 || offset + need > pool.length) return null;
    hands[player.seatIndex].push(...pool.slice(offset, offset + need));
    offset += need;
  }
  return offset === pool.length ? hands : null;
}

/** A bounded behavioral likelihood, not a hard card constraint. */
export function behaviorConsistencyWeight(sampled: Card[][], context: AiDecisionContext, level: number): number {
  const replayHands = sampled.map(cards => [...cards]);
  for (const action of context.actionHistory || []) {
    if (action.action === 'play' && action.pattern) replayHands[action.seatIndex].push(...action.pattern.cards);
  }
  const finished = new Set(replayHands.flatMap((cards, seat) => cards.length ? [] : [seat]));
  let trick: CardPattern | null = null;
  let leader = -1;
  let passes = 0;
  let logWeight = 0;
  const wild = (card: Card) => card.rank === level && card.suit === Suit.Heart;
  for (const action of context.actionHistory || []) {
    const cards = replayHands[action.seatIndex];
    const counts = rankCounts(cards);
    if (action.action === 'play' && action.pattern) {
      // Repeated needless splits are weaker evidence for that sampled holding.
      // Never penalise a forced reply, direct finish, or preserving a high control.
      if (action.pattern.type === PatternType.Single && cards.length > 1) {
        const played = action.pattern.cards[0];
        const looseAlternative = cards.some(card => card.id !== played.id && counts.get(card.rank) === 1
          && !wild(card) && effectiveRank(card.rank, level) < effectiveRank(played.rank, level)
          && (!trick || canBeat({ type: PatternType.Single, rank: card.rank, length: 1, cards: [card] }, trick, level)));
        if ((counts.get(played.rank) || 0) >= 2 && looseAlternative) logWeight += Math.log(0.8);
      }
      const ids = new Set(action.pattern.cards.map(card => card.id));
      replayHands[action.seatIndex] = cards.filter(card => !ids.has(card.id));
      if (!replayHands[action.seatIndex].length) finished.add(action.seatIndex);
      trick = action.pattern;
      leader = action.seatIndex;
      passes = 0;
      continue;
    }
    if (!trick) continue;
    // Passing a teammate is normal. Passing the enemy is soft evidence only
    // when an inexpensive response exists; pairs, bombs and wildcards matter.
    if (leader >= 0 && leader % 2 !== action.seatIndex % 2) {
      let easyResponses = 0;
      if (trick.type === PatternType.Single) {
        for (const card of cards) {
          if (counts.get(card.rank) !== 1 || wild(card)
            || effectiveRank(card.rank, level) <= effectiveRank(trick.rank, level)) continue;
          easyResponses += effectiveRank(card.rank, level) >= effectiveRank(Rank.Ace, level) ? 0.15 : 0.45;
        }
      } else if (trick.type === PatternType.Pair) {
        for (const [rank, count] of counts) {
          if (count !== 2 || cards.some(card => card.rank === rank && wild(card))
            || effectiveRank(rank, level) <= effectiveRank(trick.rank, level)) continue;
          easyResponses += effectiveRank(rank, level) >= effectiveRank(Rank.Ace, level) ? 0.15 : 0.45;
        }
      }
      const urgency = replayHands[leader].length <= 2 ? 1.5 : 1;
      logWeight -= Math.log1p(easyResponses * urgency);
    }
    passes++;
    const needed = 4 - finished.size - (finished.has(leader) ? 0 : 1);
    if (passes >= needed) { trick = null; leader = -1; passes = 0; }
  }
  // Keep all allocations possible and prevent long histories collapsing belief.
  return Math.exp(Math.max(-6, logWeight));
}

/** Draw several public-count-consistent deals and softly prefer those which
 * better explain opponent-led passes. No deal is rejected solely for a pass. */
export function sampleHiddenHandsWeighted(
  hand: Card[], context: AiDecisionContext, knowledge: PublicKnowledge, level: number,
  random: () => number = Math.random, proposals = 4,
): Card[][] | null {
  const choices: Array<{ hands: Card[][]; weight: number }> = [];
  for (let index = 0; index < proposals; index++) {
    const hands = sampleHiddenHands(hand, context, knowledge, random);
    if (!hands) return null;
    choices.push({ hands, weight: behaviorConsistencyWeight(hands, context, level) });
  }
  const total = choices.reduce((sum, choice) => sum + choice.weight, 0);
  let pick = random() * total;
  for (const choice of choices) {
    pick -= choice.weight;
    if (pick <= 0) return choice.hands;
  }
  return choices[choices.length - 1]?.hands || null;
}

export interface SeatBelief {
  seat: number;
  samples: number;
  /** Only present for a two-card hand; estimated from public evidence. */
  pairProbability?: number;
  highControlProbability: number;
}

export function inferSeatBeliefs(
  hand: Card[], context: AiDecisionContext, level: number,
  deadline: number, random: () => number = Math.random,
): SeatBelief[] {
  const knowledge = buildPublicKnowledge(hand, context);
  if (!knowledge) return [];
  const totals = context.players.filter(p => p.relation !== 'self' && p.finishRank === null)
    .map(player => ({ player, pairs: 0, controls: 0 }));
  let samples = 0;
  for (; samples < 16 && performance.now() < deadline; samples++) {
    const deal = sampleHiddenHandsWeighted(hand, context, knowledge, level, random);
    if (!deal) break;
    for (const total of totals) {
      const cards = deal[total.player.seatIndex];
      if (cards.length === 2 && (cards[0].rank === cards[1].rank
        || (cards.every(card => card.rank <= Rank.Ace)
          && cards.some(card => card.rank === level && card.suit === Suit.Heart)))) total.pairs++;
      if (cards.some(card => effectiveRank(card.rank, level) >= effectiveRank(Rank.Ace, level))) total.controls++;
    }
  }
  if (!samples) return [];
  return totals.map(({ player, pairs, controls }) => ({ seat: player.seatIndex, samples,
    pairProbability: player.cardCount === 2 ? pairs / samples : undefined,
    highControlProbability: controls / samples }));
}

function bitCount(mask: number): number {
  let count = 0;
  while (mask) { mask &= mask - 1; count++; }
  return count;
}

/** Exhaust physical deals only when the entire constrained space fits the cap.
 * Complete deal coverage is NOT minimax: continuation still uses a policy. */
export function enumerateHiddenHands(hand: Card[], context: AiDecisionContext,
  knowledge: PublicKnowledge, cap = 256): Card[][][] | null {
  if (!sampleHiddenHands(hand, context, knowledge, () => 0)) return null;
  const hands = knowledge.knownBySeat.map(cards => [...cards]);
  hands[context.selfSeatIndex] = [...hand];
  const known = new Set(knowledge.knownBySeat.flat().map(card => card.id));
  const pool = knowledge.unseen.filter(card => !known.has(card.id));
  const seats = context.players.filter(p => p.seatIndex !== context.selfSeatIndex);
  // Count assignments before enumerating; avoid a factorial allocation storm.
  let count = 1, remaining = pool.length;
  for (const seat of seats) {
    const need = seat.cardCount - hands[seat.seatIndex].length;
    let ways = 1;
    for (let i = 1; i <= need; i++) ways = ways * (remaining - i + 1) / i;
    count *= ways; remaining -= need;
    if (count > cap) return null;
  }
  const deals: Card[][][] = [];
  const assign = (index: number, available: Card[]) => {
    if (index === seats.length) { deals.push(hands.map(cards => [...cards])); return; }
    const seat = seats[index];
    const base = [...hands[seat.seatIndex]];
    const need = seat.cardCount - base.length;
    const choose = (start: number, selected: Card[]) => {
      if (selected.length === need) {
        const ids = new Set(selected.map(c => c.id));
        hands[seat.seatIndex] = [...base, ...selected];
        assign(index + 1, available.filter(c => !ids.has(c.id)));
        hands[seat.seatIndex] = base;
        return;
      }
      for (let i = start; i <= available.length - (need - selected.length); i++) choose(i + 1, [...selected, available[i]]);
    };
    choose(0, []);
  };
  assign(0, pool);
  return deals;
}

/** Exact cover of physical card subsets. Every legal group is a possible one
 * turn; no opponent is modelled here. When bounded search expires, returns a
 * valid upper bound explicitly labelled inexact. */
export function createTurnEstimator(hand: Card[], plays: CardPattern[], deadline: number) {
  if (hand.length > 27) throw new Error('turn estimator supports at most 27 cards');
  const index = new Map(hand.map((card, i) => [card.id, i]));
  const fullMask = 2 ** hand.length - 1;
  const maskOf = (cards: Card[]) => cards.reduce((mask, card) => {
    const position = index.get(card.id);
    if (position === undefined) throw new Error('card is outside the hand');
    return mask | (1 << position);
  }, 0);
  const masks = [...new Set([...plays.map(play => maskOf(play.cards)), ...hand.map((_, i) => 1 << i)])]
    .filter(mask => mask !== 0).sort((a, b) => bitCount(b) - bitCount(a));
  const byBit = hand.map((_, i) => masks.filter(mask => (mask & (1 << i)) !== 0));
  const maxLength = masks.length ? bitCount(masks[0]) : 1;
  const memo = new Map<number, TurnEstimate>([[0, { turns: 0, exact: true }]]);
  let nodes = 0;
  const greedy = (mask: number) => {
    let turns = 0;
    for (const group of masks) {
      if ((mask & group) === group) { mask ^= group; turns++; }
      if (!mask) break;
    }
    return turns;
  };
  const solve = (mask: number): TurnEstimate => {
    const cached = memo.get(mask);
    if (cached) return cached;
    let best = greedy(mask);
    const lower = Math.ceil(bitCount(mask) / maxLength);
    if (best === lower) return { turns: best, exact: true };
    if (performance.now() >= deadline || ++nodes > 20000) return { turns: best, exact: false };
    const first = 31 - Math.clz32(mask & -mask);
    let exact = true;
    for (const group of byBit[first]) {
      if ((mask & group) !== group) continue;
      if (performance.now() >= deadline) { exact = false; break; }
      const rest = solve(mask ^ group);
      best = Math.min(best, 1 + rest.turns);
      exact = exact && rest.exact;
      if (best === lower) { exact = true; break; }
    }
    const result = { turns: best, exact };
    if (exact) memo.set(mask, result);
    return result;
  };
  return {
    whole: () => solve(fullMask),
    after: (play: CardPattern) => solve(fullMask ^ maskOf(play.cards)),
  };
}

interface Outcome { reward: number; win: boolean; doubleWin: boolean }
type GenerateReplies = (hand: Card[], level: number) => CardPattern[];
interface ReplyBranch { mode: 'control' | 'hold'; generate: GenerateReplies }

/** One sampled continuation. Each simulated policy sees only its own sampled
 * hand and public state, never the other sampled hands. */
export function rollout(
  initialHands: Card[][], root: CardPattern | null, last: CardPattern | null,
  level: number, context: AiDecisionContext, choose: ChoosePlay, deadline: number,
  replyBranch?: ReplyBranch,
): Outcome | null {
  const hands = initialHands.map(cards => [...cards]);
  let branched = false;
  const finishes = context.players.filter(player => player.finishRank !== null)
    .sort((a, b) => a.finishRank! - b.finishRank!).map(player => player.seatIndex);
  let seat = context.selfSeatIndex;
  let winner = context.lastPlayPlayerIndex;
  let trick = last;
  let passes = context.passCount || 0;
  const history = context.actionHistory ? [...context.actionHistory] : undefined;
  const recent = [...context.recentActions];
  const record = (action: AiRecentAction) => {
    history?.push(action);
    recent.push(action);
    if (recent.length > 12) recent.shift();
  };
  const nextActive = (from: number) => {
    for (let step = 1; step <= 4; step++) {
      const next = (from + step) % 4;
      if (!finishes.includes(next)) return next;
    }
    return -1;
  };
  for (let step = 0; step < 160; step++) {
    if (performance.now() >= deadline) return null;
    const simContext: AiDecisionContext = {
      ...context, actionHistory: history ? [...history] : undefined, recentActions: [...recent],
      strategyMemory: undefined, // Rollout seats must not inherit the real player's private plan.
      selfSeatIndex: seat, partnerSeatIndex: (seat + 2) % 4,
      lastPlayPlayerIndex: winner, passCount: passes,
      players: hands.map((cards, i) => ({
        seatIndex: i, cardCount: cards.length,
        finishRank: finishes.includes(i) ? finishes.indexOf(i) + 1 : null,
        relation: i === seat ? 'self' : i === (seat + 2) % 4 ? 'partner' : 'opponent',
      })),
    };
    let action = step === 0 ? root : choose(hands[seat], trick, !trick, level, simContext);
    // Branch only at the first opposing response. The response policy sees its
    // own sampled hand and public trick, never the other sampled hands.
    if (step > 0 && !branched && replyBranch && trick
      && seat % 2 !== context.selfSeatIndex % 2) {
      branched = true;
      const replies = replyBranch.generate(hands[seat], level).filter(play => canBeat(play, trick, level));
      const finish = replies.find(play => play.cards.length === hands[seat].length);
      // Conserving control never means declining a legal immediate finish.
      if (finish) action = finish;
      else if (replyBranch.mode === 'hold') action = null;
      else {
        const controls = replies.filter(play => !isBombPattern(play)).sort((a, b) =>
          canBeat(a, b, level) ? -1 : canBeat(b, a, level) ? 1 : 0);
        const bombs = replies.filter(isBombPattern).sort((a, b) =>
          canBeat(a, b, level) ? 1 : canBeat(b, a, level) ? -1 : 0);
        action = controls[0] || bombs[0] || null;
      }
    }
    if (action) {
      if (!canBeat(action, trick, level)) return null;
      const ids = new Set(action.cards.map(card => card.id));
      if (ids.size !== action.cards.length || action.cards.some(card => !hands[seat].some(item => item.id === card.id))) return null;
      record({ seatIndex: seat, action: 'play', pattern: action });
      hands[seat] = hands[seat].filter(card => !ids.has(card.id));
      trick = action; winner = seat; passes = 0;
      if (!hands[seat].length) finishes.push(seat);
      if (finishes.length >= 3 || (finishes.length === 2 && finishes[0] % 2 === finishes[1] % 2)) {
        const win = finishes[0] % 2 === context.selfSeatIndex % 2;
        const partnerPlace = finishes.indexOf((finishes[0] + 2) % 4) + 1 || 4;
        const magnitude = (partnerPlace === 2 ? 3 : partnerPlace === 3 ? 2 : 1) / 3;
        return { reward: win ? magnitude : -magnitude, win, doubleWin: win && partnerPlace === 2 };
      }
      seat = nextActive(seat);
    } else {
      if (!trick) return null;
      record({ seatIndex: seat, action: 'pass' });
      passes++;
      const needed = 4 - finishes.length - (finishes.includes(winner) ? 0 : 1);
      if (passes >= needed) {
        const partner = (winner + 2) % 4;
        seat = finishes.includes(winner)
          ? finishes.includes(partner) ? nextActive(partner) : partner : winner;
        trick = null; winner = -1; passes = 0;
      } else seat = nextActive(seat);
    }
  }
  return null;
}

export async function analyzeDecision(
  hand: Card[], allPlays: CardPattern[], candidates: CardPattern[],
  last: CardPattern | null, level: number, context: AiDecisionContext | undefined,
  choose: ChoosePlay,
  options: { budgetMs?: number; maxSamples?: number; random?: () => number; generateReplies?: GenerateReplies } = {},
): Promise<DecisionAnalysis> {
  const start = performance.now();
  const budget = Math.max(0, options.budgetMs ?? 800);
  const deadline = start + budget;
  const estimator = createTurnEstimator(hand, allPlays, Math.min(deadline, start + 80));
  const analysis: DecisionAnalysis = {
    teamPlan: buildTeamPlan(hand, allPlays, context),
    handTurns: estimator.whole(), candidates: {},
    simulation: { status: 'not_endgame', samples: 0, elapsedMs: 0 },
  };
  const routes = analyzeEndgameRoutes(hand, allPlays, level, context);
  const estimateCandidate = (play: CardPattern) => {
    const endgameRoute = routes[analysisKey(play)];
    const remainingTurns = estimator.after(play);
    const used = new Set(play.cards.map(card => card.id));
    analysis.candidates[analysisKey(play)] = { remainingTurns, endgameRoute,
      continuation: { extraTurns: 1 + remainingTurns.turns - analysis.handTurns.turns,
        exact: remainingTurns.exact && analysis.handTurns.exact,
        tailControlCost: tailControlCost(hand, play, allPlays, level),
        largestRemainingGroup: Math.max(0, ...allPlays.filter(group =>
          group.cards.every(card => !used.has(card.id))).map(group => group.cards.length)) } };
  };
  for (const [index, play] of candidates.entries()) {
    if (index < 40 || routes[analysisKey(play)]) estimateCandidate(play);
  }
  analysis.seatBeliefs = context
    ? inferSeatBeliefs(hand, context, level, Math.min(deadline, start + 140), options.random) : [];
  const partnerBelief = analysis.seatBeliefs.find(belief => belief.seat === context?.partnerSeatIndex);
  if (analysis.teamPlan?.goal === 'feed_partner' && partnerBelief && partnerBelief.samples >= 8
    && partnerBelief.pairProbability !== undefined && partnerBelief.pairProbability < 0.35) {
    analysis.teamPlan = { goal: 'feed_partner', feedType: PatternType.Single,
      reason: '公开行为加权的抽样更支持两张散单；优先尝试送单，仍比较送对路线' };
  }
  analysis.teamRoutes = buildTeamRoutes(hand, allPlays, candidates, last, level, context,
    analysis.candidates, options.generateReplies);
  // Every advertised route gets the same structural evidence, even if its
  // representative lies beyond the first forty heuristic candidates.
  for (const route of analysis.teamRoutes) {
    const play = candidates.find(p => analysisKey(p) === route.actionKey);
    if (play && !analysis.candidates[route.actionKey!]) estimateCandidate(play);
  }
  // One-ply terminal threats are cheap enough to inspect even when the full
  // active deal is too large for rollout. All candidates face the same deals.
  if (context && options.generateReplies
    && context.players.some(p => p.relation === 'opponent' && p.finishRank === null && p.cardCount <= 5)) {
    const knowledge = buildPublicKnowledge(hand, context);
    const riskDeadline = Math.min(deadline, performance.now() + 40);
    let samples = 0;
    const hits = candidates.map(() => 0);
    if (knowledge) for (; samples < 8 && performance.now() < riskDeadline;) {
      const deal = sampleHiddenHandsWeighted(hand, context, knowledge, level, options.random, 2);
      if (!deal) break;
      const exits = context.players.filter(p => p.relation === 'opponent' && p.finishRank === null && p.cardCount <= 5)
        .flatMap(p => options.generateReplies!(deal[p.seatIndex], level)
          .filter(reply => reply.cards.length === p.cardCount));
      if (performance.now() >= riskDeadline) break;
      candidates.forEach((play, i) => {
        if (play.cards.length < hand.length && exits.some(reply => canBeat(reply, play, level))) hits[i]++;
      });
      samples++;
    }
    if (samples >= 8) candidates.forEach((play, i) => {
      if (analysis.candidates[analysisKey(play)]) {
        analysis.candidates[analysisKey(play)].replyFinishRisk = { samples, rate: hits[i] / samples };
      }
    });
  }
  const finish = () => {
    for (const route of analysis.teamRoutes || []) route.simulation = route.actionKey
      ? analysis.candidates[route.actionKey]?.simulation : analysis.passSimulation;
    analysis.simulation.elapsedMs = Math.round(performance.now() - start);
    return analysis;
  };
  // Entire active deal must be small, not merely the current player's hand.
  if (!context || context.players.reduce((sum, player) => sum + player.cardCount, 0) > 24
    || hand.length > 10) return finish();
  const knowledge = buildPublicKnowledge(hand, context);
  if (!knowledge) { analysis.simulation.status = 'incomplete_public_history'; return finish(); }

  const roots: Array<CardPattern | null> = [];
  const shapes = new Set<string>();
  const structurallyOrdered = [...candidates.slice(0, 40)].sort((a, b) =>
    analysis.candidates[analysisKey(a)].remainingTurns.turns
      - analysis.candidates[analysisKey(b)].remainingTurns.turns);
  // Keep distinct plans in the small rollout budget: probe, control, feed,
  // and shed structure. Ranking alone can fill every slot with similar leads.
  const routeLeads = [...candidates].filter(play => routes[analysisKey(play)])
    .sort((a, b) => routes[analysisKey(b)].score - routes[analysisKey(a)].score).slice(0, 2);
  const controls = [PatternType.Single, PatternType.Pair].map(type =>
    candidates.filter(play => play.type === type).sort((a, b) =>
      effectiveRank(b.rank, level) - effectiveRank(a.rank, level))[0]);
  const feed = candidates.find(play => play.type === analysis.teamPlan?.feedType);
  const teamActions = (analysis.teamRoutes || []).map(route =>
    candidates.find(play => analysisKey(play) === route.actionKey));
  for (const play of [candidates[0], ...teamActions, ...routeLeads, ...controls, feed, ...structurallyOrdered]) {
    if (!play) continue;
    const evidence = analysis.candidates[analysisKey(play)];
    const shape = [play.type, play.rank, evidence?.remainingTurns.turns,
      evidence?.continuation?.tailControlCost, evidence?.replyFinishRisk?.rate,
      evidence?.endgameRoute?.intent].join(':');
    if (!shapes.has(shape)) { roots.push(play); shapes.add(shape); }
    if (!analysis.candidates[analysisKey(play)]) {
      analysis.candidates[analysisKey(play)] = { remainingTurns: estimator.after(play) };
    }
    if (roots.length >= 8) break;
  }
  if (last) roots.push(null);
  if (!roots.length) return finish();
  const totals = roots.map(() => ({ samples: 0, weight: 0, winRate: 0, doubleWinRate: 0, meanReward: 0 }));
  // Cache local-policy decisions by public state and that player's own sampled
  // hand. This cache never contains another player's real hand.
  const policyCache = new Map<string, CardPattern | null>();
  const policy: ChoosePlay = (cards, trick, free, currentLevel, state) => {
    const key = `${cards.map(c => c.id).sort((a, b) => a - b)}|${trick?.type}:${trick?.rank}:${trick?.length}|${state.selfSeatIndex}:${state.lastPlayPlayerIndex}:${state.passCount}|${state.players.map(p => `${p.cardCount}:${p.finishRank}`)}|${JSON.stringify(state.actionHistory)}`;
    if (!policyCache.has(key)) policyCache.set(key, choose(cards, trick, free, currentLevel, state));
    return policyCache.get(key)!;
  };
  analysis.simulation.status = 'budget_exhausted';
  const deals = enumerateHiddenHands(hand, context, knowledge, options.maxSamples ?? 256);
  const sampleLimit = options.maxSamples ?? (deals?.length || 256);
  for (let sample = 0; sample < Math.min(sampleLimit, deals?.length ?? sampleLimit); sample++) {
    await new Promise<void>(resolve => setImmediate(resolve));
    if (performance.now() >= deadline) break;
    const sampled = deals ? deals[sample]
      : sampleHiddenHandsWeighted(hand, context, knowledge, level, options.random);
    if (!sampled) { analysis.simulation.status = 'inconsistent_public_state'; break; }
    const sampleWeight = deals ? behaviorConsistencyWeight(sampled, context, level) : 1;
    const replyBranches: Array<ReplyBranch | undefined> = [undefined];
    if (options.generateReplies && context.players.reduce((n, p) => n + p.cardCount, 0) <= 12) {
      replyBranches.push({ mode: 'control', generate: options.generateReplies },
        { mode: 'hold', generate: options.generateReplies });
    }
    const results = roots.map(root => replyBranches.map(branch =>
      rollout(sampled, root, last, level, context, policy, deadline, branch)));
    if (results.some(outcomes => outcomes.some(result => result === null))) break;
    // Only complete paired samples count: every candidate faces the same deal.
    results.forEach((outcomes, index) => {
      const total = totals[index];
      total.samples++;
      total.weight += sampleWeight;
      for (const outcome of outcomes) {
        const weight = sampleWeight / outcomes.length;
        total.winRate += Number(outcome!.win) * weight;
        total.doubleWinRate += Number(outcome!.doubleWin) * weight;
        total.meanReward += outcome!.reward * weight;
      }
    });
    analysis.simulation.samples++;
    analysis.simulation.status = 'sampled';
  }
  if (deals) analysis.simulation.status = analysis.simulation.samples === deals.length
    ? 'all_deals_policy_rollout' : 'incomplete_enumeration';
  // A lexicographic prefix is not an unbiased sample of possible deals.
  if (deals && analysis.simulation.samples !== deals.length) {
    analysis.simulation.samples = 0;
    return finish();
  }
  roots.forEach((root, index) => {
    const total = totals[index];
    if (!total.samples) return;
    const result = { samples: total.samples, winRate: total.winRate / total.weight,
      doubleWinRate: total.doubleWinRate / total.weight, meanReward: total.meanReward / total.weight };
    if (root) analysis.candidates[analysisKey(root)].simulation = result;
    else analysis.passSimulation = result;
  });
  return finish();
}


/** Compact temporal context derived from the complete public action history. */
export function decisionTempo(context?: AiDecisionContext) {
  const history = context?.actionHistory || context?.recentActions || [];
  let consecutiveLeaderPlays = 0;
  let ownPassesDuringStreak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const action = history[i];
    if (action.action === 'play') {
      if (action.seatIndex !== context?.lastPlayPlayerIndex) break;
      consecutiveLeaderPlays++;
    } else if (action.seatIndex === context?.selfSeatIndex) ownPassesDuringStreak++;
  }
  const active = context?.players.filter(player => player.finishRank === null) || [];
  const minimum = active.length ? Math.min(...active.map(player => player.cardCount)) : undefined;
  const stage = context?.players.some(player => player.finishRank !== null) || (minimum !== undefined && minimum <= 5)
    ? '残局' : minimum !== undefined && minimum >= 20 && history.filter(a => a.action === 'play').length <= 4
      ? '开局' : '中盘';
  return { stage, leaderSeat: context?.lastPlayPlayerIndex, consecutiveLeaderPlays,
    ownPassesDuringStreak, minimumActiveCount: minimum };
}
