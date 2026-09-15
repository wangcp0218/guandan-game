import { AiModelSelection, AiProvider, Card, CardPattern, PatternType, Rank } from '../../../shared/types';
import { cardDisplayName, sortCards } from './card';
import { analysisKey, buildPublicKnowledge } from './aiAnalysis';
import type { DecisionAnalysis } from './aiAnalysis';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const LOCAL_BASE_URL = 'http://192.168.150.51:3000/v1';
export const DEFAULT_AI_SELECTION: AiModelSelection = {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
};
const MODEL_REQUEST_TIMEOUT = 20000;
export const LOCAL_AI_MODEL = 'Qwen3.8-27';

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

export interface AiDecisionContext {
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
  if (provider === 'local') {
    return {
      baseUrl: trimTrailingSlash(process.env.LOCAL_LLM_BASE_URL || LOCAL_BASE_URL),
      apiKey: process.env.LOCAL_LLM_API_KEY || '',
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
  const normalizedProvider: AiProvider = provider === 'local' ? 'local' : 'deepseek';
  const candidate = typeof model === 'string' && /^[\w./:-]{1,120}$/.test(model.trim())
    ? model.trim()
    : '';
  const configuredDefault = normalizedProvider === 'deepseek'
    ? (process.env.DEEPSEEK_MODEL || DEFAULT_AI_SELECTION.model)
    : '';
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
  return modelId === LOCAL_AI_MODEL;
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
  const cards = pattern.cards.map(card => cardDisplayName(card)).join(' ');
  return `${pattern.type}(${cards})，长度${pattern.length}`;
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

function describeActionCost(option: CardPattern, hand: Card[], currentLevel: number) {
  const held = new Map<number, number>();
  const used = new Map<number, number>();
  for (const card of hand) held.set(card.rank, (held.get(card.rank) || 0) + 1);
  for (const card of option.cards) used.set(card.rank, (used.get(card.rank) || 0) + 1);
  return {
    remaining_cards: hand.length - option.cards.length,
    uses_wildcards: option.cards.filter(card => card.rank === currentLevel && card.suit === 'H').length,
    uses_jokers: option.cards.filter(card => card.rank >= Rank.SmallJoker).length,
    breaks_bomb: [...used].some(([rank, count]) => (held.get(rank) || 0) >= 4 && count < (held.get(rank) || 0)),
    splits_group: [...used].some(([rank, count]) => (held.get(rank) || 0) > count),
  };
}

function compactActionGroups(
  options: CardPattern[], equivalentCounts: number[], hand: Card[], currentLevel: number,
  includeAnalysis = false, analysis?: DecisionAnalysis,
) {
  const groups = new Map<PatternType, unknown[][]>();
  options.forEach((option, actionId) => {
    const cost = describeActionCost(option, hand, currentLevel);
    const row: unknown[] = [
      actionId, option.cards.map(card => cardDisplayName(card)).join(' '),
      option.rank, option.length, equivalentCounts[actionId] || 1,
      cost.remaining_cards, cost.uses_wildcards, cost.uses_jokers,
      cost.breaks_bomb, cost.splits_group,
    ];
    if (includeAnalysis) row.push(analysis?.candidates[analysisKey(option)]);
    const members = groups.get(option.type) || [];
    members.push(row);
    groups.set(option.type, members);
  });
  return [...groups].map(([type, members]) => [PATTERN_NAMES[type], members]);
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
): Promise<CardPattern | null | undefined> {
  const normalizedSelection = normalizeAiSelection(selection.provider, selection.model);
  const providerConfig = getProviderConfig(normalizedSelection.provider);
  if (!providerConfig.apiKey || !normalizedSelection.model) return undefined;
  if (legalPlays.length === 0) return isFreePlay ? undefined : null;

  const systemPrompt = `你是竞技掼蛋选手，与对家合作争取双上和升级。程序保证合法性，你只负责战略选择。

规则：两副牌、四人两队；牌型含单、对、三张、三带二、5张顺子、3连对、2连三、炸弹、同花顺、四王炸。红桃级牌可代替除王外任意牌。大王>小王>级牌>A>K…>2；炸弹先比张数，同花顺大于五炸小于六炸，四王炸最大。平台输入优先。

信息边界：只用自己手牌、公开历史、各家余牌、进还贡、当前桌面和程序分析。未见牌不确定属于谁；过牌不等于不能接。hand_combinations是全部手牌结构，仅供规划；legal_actions是当前可选动作。它们按对应schema解释，等价实体牌已合并并由本地评分保留较优代表。只能返回legal_actions中的action_id。

目标顺序：本方有利名次与升级、双上、阻止对方双上、送队友、控制牌权、保存炸弹/同花顺/逢人配、减少剩余手数和坏结构。不要只追求自己先走。

策略：领出看减手数、后续回手和队友需求；跟牌通常用最低充分牌力。同类结构相近时先小后大，但对手报双可先用大对控权。队友牌默认不压；仅为直接走完、必要拦截或明确团队收益接管。敌方压过队友后可反压。炸弹用于阻止对手走牌、送队友或形成连续牌权，不赢低价值一轮；炸后评估续牌。逢人配优先组成强结构，残局可降低保存成本。

残局：任一玩家≤5张时规划未来1至3手。对手报单保留单张控制，报双保留对子控制；队友报单/双时创造对应牌型。下家只剩1张且决定出单时必须出最大合法单张；下家剩2张且决定出对子时必须出最大合法对子，但不强制该牌型或强制放弃PASS。

程序分析限制：remainingTurns不含对手干扰；抽样模拟不是确定胜率，样本少或接近时优先结构与本地排序；incomplete_enumeration无有效胜率。不要展示冗长推理，只输出指定JSON。`;

  const lastPlayerSnapshot = context?.players.find(player =>
    player.seatIndex === context.lastPlayPlayerIndex
  );
  const relationNames = { self: '自己', partner: '队友', opponent: '对手' } as const;
  const lastPlayer = lastPlayerSnapshot
    ? `座位${lastPlayerSnapshot.seatIndex}（${relationNames[lastPlayerSnapshot.relation]}）`
    : '无';
  const minimumActiveCount = context?.players
    .filter(player => player.finishRank === null)
    .reduce((minimum, player) => Math.min(minimum, player.cardCount), Number.POSITIVE_INFINITY);
  const stage = minimumActiveCount !== undefined && minimumActiveCount <= 5
    ? '残局'
    : hand.length >= 20 ? '开局' : hand.length >= 10 ? '中盘' : '收官';
  const knowledge = context ? buildPublicKnowledge(hand, context) : null;
  const representedCounts = legalPlays.map((_, index) => equivalentCounts[index] || 1);
  const representedHandCombinationCounts = handCombinations
    .map((_, index) => handCombinationEquivalentCounts[index] || 1);
  const input = {
    seat: context?.selfSeatIndex ?? '未知',
    partner_seat: context?.partnerSeatIndex ?? '未知',
    seat_order: '座位0→座位1→座位2→座位3→座位0（顺时针）',
    level_rank: currentLevel,
    match_state: context
      ? `第${context.roundNumber}局，队伍A ${context.teamLevels[0]}级，队伍B ${context.teamLevels[1]}级，队伍${context.leadingTeam === 0 ? 'A' : 'B'}在台`
      : '未提供',
    stage,
    turn_mode: isFreePlay ? '自由出牌，必须选择动作' : '跟牌，可选择合法动作或PASS',
    hand: describeHand(hand, currentLevel),
    wildcards: hand
      .filter(card => card.rank === currentLevel && card.suit === 'H')
      .map(card => cardDisplayName(card)),
    current_trick: {
      player: lastPlayer,
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
      hand_turns: analysis.handTurns, simulation: analysis.simulation,
      pass_simulation: analysis.passSimulation,
      caveat: '手数不含对手干扰；抽样模拟不是校准后的真实胜率',
    } : undefined,
    recent_action_history: describeHistory(context).split('\n'),
    candidate_coverage: {
      model_actions: legalPlays.length,
      represented_equivalent_actions: representedCounts.reduce((sum, count) => sum + count, 0),
      policy: '全量战略组合；等价实体选择合并，由本地评分保留最少损伤的代表牌',
    },
    action_group_schema: ['type', 'members'],
    hand_combination_member_schema: [
      'combination_id', 'cards', 'rank', 'length', 'equivalent_variants',
      'remaining_cards', 'uses_wildcards', 'uses_jokers', 'breaks_bomb', 'splits_group',
    ],
    hand_combinations: isFreePlay ? {
      same_as_legal_actions: true,
    } : compactActionGroups(
      handCombinations, representedHandCombinationCounts, hand, currentLevel,
    ),
    legal_action_member_schema: [
      'action_id', 'cards', 'rank', 'length', 'equivalent_variants',
      'remaining_cards', 'uses_wildcards', 'uses_jokers', 'breaks_bomb', 'splits_group', 'analysis',
    ],
    legal_actions: compactActionGroups(
      legalPlays, representedCounts, hand, currentLevel, true, analysis,
    ),
  };
  const userPrompt = `请根据以下牌桌输入选择动作：\n${JSON.stringify(input)}\n
输出格式：{"action_id":数字或"PASS","intent":"走牌/控权/送队友/阻击对手/整理牌型/试探/保留实力","confidence":0.00,"brief_reason":"不超过40个汉字","risk":"主要风险"}。只有跟牌时可选择PASS。`;

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
        max_tokens: normalizedSelection.provider === 'deepseek' ? 512 : 192,
      };
      if (normalizedSelection.provider === 'deepseek') {
        requestBody.thinking = { type: 'enabled' };
        requestBody.reasoning_effort = 'low';
        requestBody.response_format = { type: 'json_object' };
      } else {
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
      console.error(`[LLM AI] ${normalizedSelection.provider}/${normalizedSelection.model} API error: ${response.status}`);
      return undefined;
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) return undefined;
    const parsed = parseModelResponse(content);
    const rawActionId = parsed.action_id ?? parsed.option_id;
    const optionId = typeof rawActionId === 'string' && /^\d+$/.test(rawActionId)
      ? Number(rawActionId)
      : rawActionId;
    const reasonSource = parsed.brief_reason ?? parsed.reason;
    const reason = typeof reasonSource === 'string' ? reasonSource.slice(0, 40) : '未提供理由';
    if (rawActionId === 'PASS' || optionId === null) {
      if (isFreePlay) {
        console.warn(`[LLM AI ${normalizedSelection.provider}/${normalizedSelection.model}] rejected pass during free play; using rule-based AI`);
        return undefined;
      }
      console.log(`[LLM AI ${normalizedSelection.provider}/${normalizedSelection.model}] pass; reason=${reason}`);
      return null;
    }
    if (!Number.isInteger(optionId) || optionId < 0 || optionId >= legalPlays.length) {
      console.warn(`[LLM AI ${normalizedSelection.provider}/${normalizedSelection.model}] invalid option=${String(optionId)}; using rule-based AI`);
      return undefined;
    }

    console.log(`[LLM AI ${normalizedSelection.provider}/${normalizedSelection.model}] option=${optionId}; reason=${reason}`);
    return legalPlays[optionId];
  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.log(`[LLM AI] ${normalizedSelection.provider}/${normalizedSelection.model} timeout, using rule-based AI`);
    } else {
      console.warn(`[LLM AI] request/response error: ${error?.message || 'unknown error'}`);
    }
    return undefined;
  }
}
