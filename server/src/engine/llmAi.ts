import { STRATEGY_GUIDE, strategyBrief } from './aiStrategy';
import { AiModelSelection, AiProvider, Card, CardPattern, PatternType, Rank } from '../../../shared/types';
import { cardDisplayName, sortCards } from './card';
import { isBombPattern } from './compare';
import { analysisKey, buildPublicKnowledge, buildTeamPlan, decisionTempo, passPosition, resourceCost } from './aiAnalysis';
import type { DecisionAnalysis } from './aiAnalysis';
import { recordAiModelCall } from './aiTelemetry';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const LOCAL_BASE_URL = 'https://fueternal.com/api/v1';
export const HW_AI_MODEL = 'HW-deepseek-v4.1-flash-1017';
export const LOCAL_AI_MODEL = 'Qwen3.8-27';
export const DEFAULT_AI_SELECTION: AiModelSelection = {
  provider: 'fueternal',
  model: HW_AI_MODEL,
};
const MODEL_REQUEST_TIMEOUT = 20000;
// Keep room for complete JSON; this is a ceiling, not a target length.
// Thinking is explicitly disabled below to reduce per-turn latency.
const DEEPSEEK_MAX_OUTPUT_TOKENS = 4096;

interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
}

export interface AiPlayerSnapshot {
  seatIndex: number;
  cardCount: number;
  finishRank: number | null;
  relation: 'self' | 'partner' | 'opponent';
}

export interface AiRecentAction {
  seatIndex: number;
  action: 'play' | 'pass';
  pattern?: CardPattern;
}

export interface AiStrategyPlan {
  next: string;
  reconsiderWhen: string;
}

export interface AiStrategyMemory extends AiStrategyPlan {
  afterAction: number;
  executed: string;
}

export interface AiDecisionCheck {
  goal: 'direct_finish' | 'block_opponent' | 'help_partner' | 'own_route' | 'organize' | 'hold_control';
  resourceUse: 'preserve' | 'spend_justified' | 'none';
  worstReply: string;
  whyNotLowerCost: string;
}

const DECISION_GOALS = new Set<AiDecisionCheck['goal']>([
  'direct_finish', 'block_opponent', 'help_partner', 'own_route', 'organize', 'hold_control',
]);
const RESOURCE_USES = new Set<AiDecisionCheck['resourceUse']>(['preserve', 'spend_justified', 'none']);

function decisionCheckFailure(value: unknown) {
  if (value == null) return 'missing_strategy_check';
  if (typeof value !== 'object' || Array.isArray(value)) return 'invalid_strategy_check';
  const check = value as Record<string, unknown>;
  if (['goal', 'resource_use', 'worst_reply', 'why_not_lower_cost'].some(key => check[key] == null)) {
    return 'missing_strategy_field';
  }
  if (!DECISION_GOALS.has(check.goal as AiDecisionCheck['goal'])) return 'invalid_strategy_goal';
  if (!RESOURCE_USES.has(check.resource_use as AiDecisionCheck['resourceUse'])) return 'invalid_resource_use';
  if (typeof check.worst_reply !== 'string' || !check.worst_reply.trim()
    || typeof check.why_not_lower_cost !== 'string' || !check.why_not_lower_cost.trim()) {
    return 'invalid_strategy_reason';
  }
  return undefined;
}

/** A compact visible audit, not hidden chain-of-thought. Accepted live model
 * decisions must classify their goal, resource use and dangerous reply. */
export function parseDecisionCheck(value: unknown): AiDecisionCheck | undefined {
  if (decisionCheckFailure(value)) return undefined;
  const check = value as Record<string, unknown>;
  return {
    goal: check.goal as AiDecisionCheck['goal'],
    resourceUse: check.resource_use as AiDecisionCheck['resourceUse'],
    worstReply: (check.worst_reply as string).trim().slice(0, 40),
    whyNotLowerCost: (check.why_not_lower_cost as string).trim().slice(0, 40),
  };
}

/** Optional, bounded planning notes; malformed notes never invalidate an action. */
export function parseStrategyPlan(value: unknown): AiStrategyPlan | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const plan = value as Record<string, unknown>;
  if (typeof plan.next !== 'string' || typeof plan.reconsider_when !== 'string') return undefined;
  const next = plan.next.trim().slice(0, 80);
  const reconsiderWhen = plan.reconsider_when.trim().slice(0, 80);
  return next && reconsiderWhen ? { next, reconsiderWhen } : undefined;
}

export interface AiDecisionContext {
  strategyMemory?: AiStrategyMemory;
  selfSeatIndex: number;
  partnerSeatIndex: number;
  lastPlayPlayerIndex: number;
  roundNumber: number;
  teamLevels: [number, number];
  leadingTeam: 0 | 1;
  players: AiPlayerSnapshot[];
  recentActions: AiRecentAction[];
  /** Complete public play/pass history since this deal started. */
  actionHistory?: AiRecentAction[];
  passCount?: number;
  publicTransfers?: Array<{ fromSeat: number; toSeat: number; card: Card }>;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function getProviderConfig(provider: AiProvider): ProviderConfig {
  if (provider === 'local' || provider === 'fueternal') {
    return {
      baseUrl: trimTrailingSlash(process.env.LOCAL_LLM_BASE_URL || LOCAL_BASE_URL),
      apiKey: process.env.LOCAL_LLM_API_KEY || process.env.FUETERNAL_API_KEY || '',
    };
  }
  return {
    baseUrl: trimTrailingSlash(process.env.DEEPSEEK_BASE_URL || DEEPSEEK_BASE_URL),
    apiKey: process.env.DEEPSEEK_API_KEY || '',
  };
}

export function normalizeAiSelection(
  provider: unknown,
  model: unknown,
): AiModelSelection {
  const normalizedProvider: AiProvider = provider === 'local' || provider === 'deepseek' || provider === 'fueternal'
    ? provider : DEFAULT_AI_SELECTION.provider;
  const candidate = typeof model === 'string' && /^[\w./:-]{1,120}$/.test(model.trim())
    ? model.trim()
    : '';
  const configuredDefault = normalizedProvider === 'deepseek'
    ? (process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash')
    : normalizedProvider === 'fueternal' ? HW_AI_MODEL : LOCAL_AI_MODEL;
  const normalizedModel = isSelectableAiModel(normalizedProvider, candidate)
    ? candidate
    : !candidate && isSelectableAiModel(normalizedProvider, configuredDefault)
      ? configuredDefault
      : '';
  return { provider: normalizedProvider, model: normalizedModel };
}

/** Cost-controlled model allowlist used by both model discovery and room creation. */
export function isSelectableAiModel(provider: AiProvider, model: string): boolean {
  const modelId = model.trim();
  if (!modelId) return false;
  if (provider === 'deepseek') return !modelId.toLowerCase().includes('pro');
  return modelId === (provider === 'fueternal' ? HW_AI_MODEL : LOCAL_AI_MODEL);
}

export function filterSelectableAiModels(provider: AiProvider, models: string[]): string[] {
  return Array.from(new Set(
    models
      .map(model => model.trim())
      .filter(model => isSelectableAiModel(provider, model)),
  )).sort((a, b) => a.localeCompare(b));
}

export async function fetchAvailableAiModels(provider: AiProvider): Promise<string[]> {
  const config = getProviderConfig(provider);
  if (!config.apiKey) throw new Error(`${provider} API key is not configured`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MODEL_REQUEST_TIMEOUT);
  try {
    const response = await fetch(`${config.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${provider} models API returned ${response.status}`);
    const data: any = await response.json();
    const models = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    const modelIds: string[] = models
      .map((item: any) => typeof item === 'string' ? item : item?.id || item?.name)
      .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
    return filterSelectableAiModels(provider, modelIds);
  } finally {
    clearTimeout(timeoutId);
  }
}

function describeHand(cards: Card[], currentLevel: number): string {
  const counts = new Map<string, number>();
  for (const card of sortCards(cards, currentLevel)) {
    const name = `${cardDisplayName(card)}${card.rank === currentLevel && card.suit === 'H' ? '(逢人配)' : ''}`;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return Array.from(counts, ([name, count]) => `${name}×${count}`).join(' ');
}

function describePattern(pattern: CardPattern | null): string {
  if (!pattern) return '无';
  const resolved = pattern.cards.map(card => {
    const substitute = pattern.substitutions?.find(item => item.id === card.id);
    return cardDisplayName(card) + (substitute ? '→' + cardDisplayName(substitute) : '');
  }).join(' ');
  return `${pattern.type}，声明点数${pattern.rank}，长度${pattern.length}，实体牌及替代：${resolved}`;
}

const PATTERN_NAMES: Record<PatternType, string> = {
  [PatternType.Single]: '单张',
  [PatternType.Pair]: '对子',
  [PatternType.Triple]: '三张',
  [PatternType.TriplePair]: '三带二',
  [PatternType.Straight]: '顺子',
  [PatternType.ConsecutivePair]: '连对',
  [PatternType.Plane]: '钢板',
  [PatternType.PlaneWings]: '飞机带翅膀',
  [PatternType.Bomb4]: '四炸',
  [PatternType.Bomb5]: '五炸',
  [PatternType.Bomb6]: '六炸',
  [PatternType.Bomb7]: '七炸',
  [PatternType.Bomb8]: '八炸',
  [PatternType.Bomb9]: '九炸',
  [PatternType.Bomb10]: '十炸',
  [PatternType.KingBomb]: '天王炸',
  [PatternType.FlushStraight]: '同花顺',
};

function describeHistory(context?: AiDecisionContext): string {
  const history = context?.recentActions ?? context?.actionHistory?.slice(-12);
  if (!history?.length) return '暂无';
  return history.map(item => item.action === 'pass'
    ? `座位${item.seatIndex}：不出`
    : `座位${item.seatIndex}：${describePattern(item.pattern || null)}`
  ).join('\n');
}

function describeActionCost(option: CardPattern, hand: Card[], currentLevel: number, held: Map<number, number>) {
  const used = new Map<number, number>();
  for (const card of option.cards) used.set(card.rank, (used.get(card.rank) || 0) + 1);
  const resources = resourceCost(hand, option, currentLevel);
  return {
    remaining_cards: hand.length - option.cards.length,
    ...resources,
    uses_wildcards: option.cards.filter(card => card.rank === currentLevel && card.suit === 'H').length,
    uses_jokers: option.cards.filter(card => card.rank >= Rank.SmallJoker).length,
    uses_aces: option.cards.filter(card => card.rank === Rank.Ace).length,
    uses_bomb: isBombPattern(option),
    breaks_bomb: resources.broken_natural_bombs.length > 0,
    splits_group: [...used].some(([rank, count]) => (held.get(rank) || 0) > count),
  };
}

function spendsControlResource(option: CardPattern, hand: Card[], currentLevel: number): boolean {
  const held = new Map<number, number>();
  for (const card of hand) held.set(card.rank, (held.get(card.rank) || 0) + 1);
  const cost = describeActionCost(option, hand, currentLevel, held);
  return cost.uses_wildcards > 0 || cost.uses_jokers > 0 || cost.uses_aces > 0
    || cost.natural_level_cards_spent > 0 || cost.breaks_bomb || cost.weakened_natural_bombs.length > 0 || cost.uses_bomb;
}

function compactActionGroups(
  options: CardPattern[], equivalentCounts: number[], hand: Card[], currentLevel: number,
  includeAnalysis = false, analysis?: DecisionAnalysis,
) {
  const held = new Map<number, number>();
  for (const card of hand) held.set(card.rank, (held.get(card.rank) || 0) + 1);
  return options.map((option, actionId) => ({
    action_id: actionId,
    type: option.type, type_name: PATTERN_NAMES[option.type],
    declared_rank: option.rank, length: option.length,
    cards: option.cards.map(card => ({ id: card.id, card: cardDisplayName(card) })),
    substitutions: option.substitutions?.map(card => ({
      physical_id: card.id, replaces: cardDisplayName(card),
    })),
    equivalent_variants: equivalentCounts[actionId] || 1,
    cost: describeActionCost(option, hand, currentLevel, held),
    next_cycle: includeAnalysis ? analysis?.trickForecast?.[analysisKey(option)] : undefined,
    analysis: includeAnalysis ? analysis?.candidates[analysisKey(option)] : undefined,
  }));
}

function parseModelResponse(content: string): any {
  try {
    return JSON.parse(content);
  } catch {}
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    try { return JSON.parse(fenced.trim()); } catch {}
  }
  const objectText = content.match(/\{[\s\S]*\}/)?.[0];
  if (objectText) return JSON.parse(objectText);
  throw new Error('model response did not contain valid JSON');
}

export function decodeModelDecision(data: any, count: number, free: boolean):
  { parsed: any; action: number | 'PASS' } | { failure: string } {
  const choice = data?.choices?.[0];
  if (choice?.finish_reason === 'length') return { failure: 'truncated' };
  const content = choice?.message?.content;
  if (typeof content !== 'string' || !content.trim()) return { failure: 'empty_content' };
  let parsed: any;
  try { parsed = parseModelResponse(content); } catch { return { failure: 'invalid_json' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { failure: 'invalid_action' };
  const raw = parsed.action_id ?? parsed.option_id;
  if (raw === 'PASS') return free ? { failure: 'illegal_pass' } : { parsed, action: 'PASS' };
  const action = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (!Number.isInteger(action) || action < 0 || action >= count) return { failure: 'invalid_action' };
  return { parsed, action };
}

export async function llmFindBestPlay(
  hand: Card[],
  legalPlays: CardPattern[],
  lastPattern: CardPattern | null,
  isFreePlay: boolean,
  currentLevel: number,
  context?: AiDecisionContext,
  selection: AiModelSelection = DEFAULT_AI_SELECTION,
  analysis?: DecisionAnalysis,
  equivalentCounts: number[] = [],
  handCombinations: CardPattern[] = legalPlays,
  handCombinationEquivalentCounts: number[] = equivalentCounts,
  onPlan?: (plan: AiStrategyPlan) => void,
): Promise<CardPattern | null | undefined> {
  const modelStarted = performance.now();
  const normalizedSelection = normalizeAiSelection(selection.provider, selection.model);
  const providerConfig = getProviderConfig(normalizedSelection.provider);
  if (!providerConfig.apiKey || !normalizedSelection.model) {
    recordAiModelCall('unavailable', performance.now() - modelStarted);
    return undefined;
  }
  if (legalPlays.length === 0) return isFreePlay ? undefined : null;

  const lastPlayer = context?.players.find(p => p.seatIndex === context.lastPlayPlayerIndex);
  const endgame = context?.players.some(p => p.finishRank !== null || p.cardCount <= 5);
  const scenario = isFreePlay ? '自由领牌' : lastPlayer?.relation === 'partner' ? '跟队友牌' : '跟对手牌';
  const task = isFreePlay
    ? '比较先走整组、保留控制回手、送队友与收尾。平静开局不为减少手数消耗配牌；等牌力先检查自然牌替代。'
    : lastPlayer?.relation === 'partner'
      ? '优先让队友走。仅在直接走完、明确阻断对手或接管后有可执行团队收益时压队友。'
      : '比较接管与PASS的整手收益。先查完整普通接牌，不要把不拆组的级牌对误称拆炸。结合对手持续推进、可能下一手结束与接风风险，比较完整炸弹改变牌型的收益，不必机械等到报单。保牌必须有具体收益或后续接管条件，不能仅因存在模拟结果就认定PASS更好。';
  const systemPrompt = `你是四人两队掼蛋选手，对家是队友。程序负责合法性、牌型和记牌，你选择战略。
规则：红桃级牌是逢人配；单张大王>小王>级牌>A>K…；顺子用声明点数比较，A2345最低。实体牌、替代关系与声明点数由输入确定，不自行改牌。
信息边界：只用自己的手牌和公开信息，不知道其他人的底牌；过牌不代表不能接，两张不保证是对子。hand_combinations只是有上限的代表组合，并非全部结构。
当前任务：${scenario}。${task}
${endgame ? '残局重点：先比较控制→收尾、试探→回手→收尾及阻止接风。检查被压后的回手机会，不能把静态两手当成连续两手必走。' : '中前盘重点：整理整手结构与回手机会，比较消耗炸弹/配牌/王的真实收益。'}
统一实战决策指南：
${STRATEGY_GUIDE}
证据口径：remainingTurns是静态拆分，exact不表示必胜；controlProven才是公开信息的控牌证明。replyFinishRisk是公开信息约束抽样中对手可一手接完的比例，不是实际胜率，也未保证对手轮到时牌权不变。比较continuation.tailControlCost和真实余牌，级牌单张不等于保留了双王回手。模拟样本不足或接近时不臆造胜率。
strategy_memory每回合重验；以当前手牌、verified_resources和strategy_framework为准，不得声称持有不存在的牌。策略指南提供比较方法，不替代平台的合法性与防守检查。decision_check必须填写。按所选动作的cost核对资源；消耗A、王、自然级牌、逢人配、拆炸或uses_bomb为true时，resource_use必须为spend_justified。
下家报单/双时比较最大普通牌与完整炸弹，避免为出最大对子拆开炸弹；两张不保证是对子。此原则不强制选某牌型或取消PASS。接管送队友必须保留实际可出的nextLead；controlProven=false不保证拿到牌权。跟牌通常保留更强控制；允许合理拆组、用王回手与炸弹拦截。
after_pass.responders是过牌后仍能应牌的座位；partnerMayRespond=false时不能指望队友接，nextLead是无人再压时的领牌人。对手已拿头游时要比较放其队友续领造成双上的代价。核对 remaining_rank_bombs 才能声称留炸。拆炸跟牌要与 PASS 和完整接牌比较具体收益。remainingTurns 是该动作之后的余牌手数，exact=false 是上界；残局比较先出整组和保留整组、用同型控制回手的顺序。
next_cycle与pass_next_cycle用同一批可能底牌估计：teamAhead是其他座位各应一次后本方占先比例，partnerAhead是队友占先比例，allyExit、enemyExit是这一圈先有人走完的比例。这是短程估计，结合余牌手数与保留控制比较。
从legal_actions返回action_id（跟牌可PASS），decision_check执行固定自检，strategy_plan写本次执行后的下一步及失效条件。不复述长推理，不声称持有输入没有的炸弹或直接走完。`;

  const lastPlayerSnapshot = context?.players.find(player =>
    player.seatIndex === context.lastPlayPlayerIndex
  );
  const relationNames = { self: '自己', partner: '队友', opponent: '对手' } as const;
  const lastPlayerLabel = lastPlayerSnapshot
    ? `座位${lastPlayerSnapshot.seatIndex}（${relationNames[lastPlayerSnapshot.relation]}）`
    : '无';
  const tempo = decisionTempo(context);
  const stage = tempo.stage;
  const knowledge = context ? buildPublicKnowledge(hand, context) : null;
  const representedCounts = legalPlays.map((_, index) => equivalentCounts[index] || 1);
  const representedHandCombinationCounts = handCombinations
    .map((_, index) => handCombinationEquivalentCounts[index] || 1);
  const input = {
    strategy_framework: strategyBrief(hand, currentLevel, context),
    strategy_memory: context?.strategyMemory,
    public_action_count: context?.actionHistory?.length,
    seat: context?.selfSeatIndex ?? '未知',
    partner_seat: context?.partnerSeatIndex ?? '未知',
    seat_order: '座位0→座位1→座位2→座位3→座位0（顺时针）',
    level_rank: currentLevel,
    match_state: context
      ? `第${context.roundNumber}局，队伍A ${context.teamLevels[0]}级，队伍B ${context.teamLevels[1]}级，队伍${context.leadingTeam === 0 ? 'A' : 'B'}在台`
      : '未提供',
    stage,
    scenario,
    tempo,
    team_plan: analysis?.teamPlan ?? buildTeamPlan(hand, handCombinations, context),
    team_routes: analysis?.teamRoutes?.flatMap(({ actionKey, simulation: _simulation, ...route }) => {
      const index = actionKey === null ? -1 : legalPlays.findIndex(play => analysisKey(play) === actionKey);
      if ((actionKey !== null && index < 0) || (actionKey === null && isFreePlay)) return [];
      // Share the exact candidate evidence used locally; do not invent a
      // second route score or label rollout estimates as proven wins.
      const evidence = actionKey === null ? undefined : analysis.candidates[actionKey];
      return [{ ...route, action_id: actionKey === null ? 'PASS' : index,
        remaining_turns: evidence?.remainingTurns,
        continuation: evidence?.continuation,
        simulation: actionKey === null ? analysis.passSimulation : evidence?.simulation }];
    }),
    turn_mode: isFreePlay ? '自由出牌，必须选择动作' : '跟牌，可选择合法动作或PASS',
    hand: describeHand(hand, currentLevel),
    verified_resources: {
      card_count: hand.length,
      small_jokers: hand.filter(c => c.rank === Rank.SmallJoker).length,
      big_jokers: hand.filter(c => c.rank === Rank.BigJoker).length,
      aces: hand.filter(c => c.rank === Rank.Ace).length,
      natural_level_cards: hand.filter(c => c.rank === currentLevel && c.suit !== 'H').length,
      wildcards: hand.filter(c => c.rank === currentLevel && c.suit === 'H').length,
      rank_bombs_as_dealt: [...new Set(hand.map(c => c.rank))].filter(rank =>
        rank < Rank.SmallJoker && hand.filter(c => c.rank === rank).length >= 4),
    },
    wildcards: hand
      .filter(card => card.rank === currentLevel && card.suit === 'H')
      .map(card => cardDisplayName(card)),
    after_pass: context && !isFreePlay ? passPosition(context, lastPattern) : undefined,
    current_trick: {
      player: lastPlayerLabel,
      pattern: describePattern(lastPattern),
    },
    remaining_counts: context?.players.map(player => ({
      seat: player.seatIndex,
      relation: relationNames[player.relation],
      cards: player.cardCount,
      finish_rank: player.finishRank,
    })) || [],
    public_history_scope: knowledge ? '每家完整公开出牌＋最近12次出牌/过牌；未见牌不确定属于哪家'
      : '公开历史不完整或不一致，不能精确记牌',
    public_memory: knowledge ? {
      unseen_cards: describeHand(knowledge.unseen, currentLevel),
      publicly_known_cards: knowledge.knownBySeat.map((cards, seat) => ({
        seat, cards: describeHand(cards, currentLevel),
      })),
    } : undefined,
    played_by_seat: context?.players.map(player => ({
      seat: player.seatIndex,
      cards: describeHand((context.actionHistory || [])
        .filter(action => action.seatIndex === player.seatIndex && action.action === 'play')
        .flatMap(action => action.pattern?.cards || []), currentLevel),
    })) || [],
    public_inference: knowledge ? {
      seat_beliefs: analysis?.seatBeliefs,
      belief_caveat: '仅16份以内公开行为加权抽样，非真实底牌或校准概率；高牌存在不代表必然能回手',
      unseen_controls: describeHand(knowledge.unseen.filter(card =>
        card.rank >= Rank.King || card.rank === currentLevel
      ), currentLevel),
      reported_threats: context?.players
        .filter(player => player.finishRank === null && player.cardCount <= 2)
        .map(player => ({ seat: player.seatIndex, relation: relationNames[player.relation], cards: player.cardCount })),
      recent_passes: context?.players.map(player => ({
        seat: player.seatIndex,
        count: (context.recentActions || []).filter(action =>
          action.seatIndex === player.seatIndex && action.action === 'pass'
        ).length,
      })),
    } : undefined,
    tribute_history: context?.publicTransfers?.map(transfer => ({
      from_seat: transfer.fromSeat, to_seat: transfer.toSeat, card: cardDisplayName(transfer.card),
    })),
    local_analysis: analysis ? {
      pass_next_cycle: analysis.trickForecast?.PASS,
      hand_turns: analysis.handTurns, simulation: analysis.simulation,
      pass_simulation: analysis.passSimulation,
      caveat: '手数不含对手干扰；抽样模拟不是校准后的真实胜率',
    } : undefined,
    recent_action_history: describeHistory(context).split('\n'),
    candidate_coverage: {
      model_actions: legalPlays.length,
      represented_equivalent_actions: representedCounts.reduce((sum, count) => sum + count, 0),
      policy: '按牌型分层保留的高价值战略组合；等价实体选择合并，由本地评分保留最少损伤的代表牌',
    },
    hand_combinations: isFreePlay ? {
      same_as_legal_actions: true,
    } : compactActionGroups(
      handCombinations, representedHandCombinationCounts, hand, currentLevel,
    ),
    legal_actions: compactActionGroups(
      legalPlays, representedCounts, hand, currentLevel, true, analysis,
    ),
  };
  const outputExample = '{"action_id":0,"decision_check":{"goal":"organize","resource_use":"preserve","worst_reply":"对手用更高同型接管","why_not_lower_cost":"该动作保住回手牌"},"brief_reason":"先走低组合","strategy_plan":{"next":"有牌权再领低对","reconsider_when":"对手报单"}}';
  const userPrompt = `请根据以下牌桌输入选择动作：\n${JSON.stringify(input)}\n
只输出一个紧凑JSON。格式示例：${outputExample}
必填action_id（整数或跟牌时的"PASS"）与decision_check的四个字段。
goal必须是其中一项：${[...DECISION_GOALS].join('、')}。resource_use必须是其中一项：${[...RESOURCE_USES].join('、')}。worst_reply和why_not_lower_cost各20字内，无则填“无”。
可选brief_reason（20字内）和strategy_plan（下一步，32字内；失效条件，32字内）。不复述牌桌、候选或推理，不加额外字段或Markdown。`;
  const promptCharacters = systemPrompt.length + userPrompt.length;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MODEL_REQUEST_TIMEOUT);
    let response: Response;
    let data: any;
    try {
      const requestBody: Record<string, unknown> = {
        model: normalizedSelection.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: normalizedSelection.provider === 'deepseek' ? DEEPSEEK_MAX_OUTPUT_TOKENS : 4096,
      };
      if (normalizedSelection.provider === 'deepseek' || normalizedSelection.provider === 'fueternal') {
        requestBody.thinking = { type: 'disabled' };
        requestBody.response_format = { type: 'json_object' };
      } else {
        requestBody.enable_thinking = false;
        requestBody.chat_template_kwargs = { enable_thinking: false };
        requestBody.temperature = stage === '残局' ? 0 : 0.25;
      }
      response = await fetch(`${providerConfig.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${providerConfig.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      // Keep the deadline active until the entire model response is read.
      if (response.ok) data = await response.json();
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      recordAiModelCall('http_error', performance.now() - modelStarted, promptCharacters);
      console.error(`[LLM AI] ${normalizedSelection.provider}/${normalizedSelection.model} API error: ${response.status}`);
      return undefined;
    }

    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    // Record diagnostics without storing prompts, cards or reasoning text.
    console.info('[LLM AI response]', JSON.stringify({
      provider: normalizedSelection.provider,
      model: normalizedSelection.model,
      finishReason: choice?.finish_reason ?? null,
      promptTokens: data?.usage?.prompt_tokens ?? null,
      completionTokens: data?.usage?.completion_tokens ?? null,
      reasoningTokens: data?.usage?.completion_tokens_details?.reasoning_tokens ?? null,
      contentLength: typeof content === 'string' ? content.length : 0,
      reasoningLength: typeof choice?.message?.reasoning_content === 'string'
        ? choice.message.reasoning_content.length : 0,
      elapsedMs: Math.round(performance.now() - modelStarted),
    }));
    const decision = decodeModelDecision(data, legalPlays.length, isFreePlay);
    if ('failure' in decision) {
      recordAiModelCall('invalid_response', performance.now() - modelStarted, promptCharacters);
      // Never log response text, prompts or credentials.
      console.warn('[AI response]', JSON.stringify({
        provider: normalizedSelection.provider, model: normalizedSelection.model,
        reason: decision.failure,
        cause: decision.failure === 'truncated' ? 'output_token_limit' : decision.failure,
        finishReason: data?.choices?.[0]?.finish_reason,
        contentLength: data?.choices?.[0]?.message?.content?.length || 0,
        completionTokens: data?.usage?.completion_tokens,
        reasoningTokens: data?.usage?.completion_tokens_details?.reasoning_tokens,
        round: context?.roundNumber, seat: context?.selfSeatIndex,
        action: context?.actionHistory?.length,
      }));
      return undefined;
    }
    const { parsed, action: optionId } = decision;
    const decisionCheck = parseDecisionCheck(parsed.decision_check);
    const selectedPlay = optionId === 'PASS' ? null : legalPlays[optionId];
    const inconsistentResource = decisionCheck && (selectedPlay
      ? spendsControlResource(selectedPlay, hand, currentLevel)
        && decisionCheck.resourceUse !== 'spend_justified'
      : decisionCheck.resourceUse === 'spend_justified');
    if (context && (!decisionCheck || inconsistentResource)) {
      recordAiModelCall('invalid_response', performance.now() - modelStarted, promptCharacters);
      console.warn('[AI response]', JSON.stringify({
        provider: normalizedSelection.provider, model: normalizedSelection.model,
        reason: inconsistentResource ? 'inconsistent_resource_check' : decisionCheckFailure(parsed.decision_check),
        round: context.roundNumber, seat: context.selfSeatIndex,
        action: context.actionHistory?.length,
      }));
      return undefined;
    }
    const reasonSource = parsed.brief_reason ?? parsed.reason;
    const reason = typeof reasonSource === 'string' ? reasonSource.slice(0, 40) : '未提供理由';
    if (optionId === 'PASS') {
      const plan = parseStrategyPlan(parsed.strategy_plan);
      if (plan) onPlan?.(plan);
      recordAiModelCall('pass', performance.now() - modelStarted, promptCharacters);
      console.log(`[LLM AI ${normalizedSelection.provider}/${normalizedSelection.model}] pass; goal=${decisionCheck?.goal || 'unchecked'}; reason=${reason}`);
      return null;
    }
    const plan = parseStrategyPlan(parsed.strategy_plan);
    if (plan) onPlan?.(plan);
    recordAiModelCall('success', performance.now() - modelStarted, promptCharacters);
    console.log(`[LLM AI ${normalizedSelection.provider}/${normalizedSelection.model}] option=${optionId}; goal=${decisionCheck?.goal || 'unchecked'}; resource=${decisionCheck?.resourceUse || 'unchecked'}; reason=${reason}`);
    return legalPlays[optionId];
  } catch (error: any) {
    if (error.name === 'AbortError') {
      recordAiModelCall('timeout', performance.now() - modelStarted, promptCharacters);
      console.log(`[LLM AI] ${normalizedSelection.provider}/${normalizedSelection.model} timeout, trying next model or local fallback`);
    } else {
      recordAiModelCall(error instanceof SyntaxError ? 'invalid_response' : 'error',
        performance.now() - modelStarted, promptCharacters);
      console.warn(`[LLM AI] request/response error: ${error?.message || 'unknown error'}`);
    }
    return undefined;
  }
}
