import { AiModelSelection, AiProvider, Card, CardPattern, PatternType } from '../../../shared/types';
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
  const normalizedModel = typeof model === 'string' && /^[\w./:-]{1,120}$/.test(model.trim())
    ? model.trim()
    : normalizedProvider === 'deepseek'
      ? (process.env.DEEPSEEK_MODEL || DEFAULT_AI_SELECTION.model)
      : '';
  return { provider: normalizedProvider, model: normalizedModel };
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
    return Array.from(new Set<string>(modelIds)).sort((a, b) => a.localeCompare(b));
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

function describeOptions(options: CardPattern[]): string {
  return options.map((option, optionId) => JSON.stringify({
    option_id: optionId,
    type: PATTERN_NAMES[option.type],
    cards: option.cards.map(card => cardDisplayName(card)),
    rank: option.rank,
    length: option.length,
  })).join('\n');
}

function describePlayers(context?: AiDecisionContext): string {
  if (!context) return '无额外玩家信息';
  const relationNames = { self: '自己', partner: '队友', opponent: '对手' } as const;
  return context.players.map(player => {
    const finished = player.finishRank ? `，已获第${player.finishRank}名` : '';
    return `座位${player.seatIndex}（${relationNames[player.relation]}）：剩${player.cardCount}张${finished}`;
  }).join('\n');
}

function describeHistory(context?: AiDecisionContext): string {
  const history = context?.actionHistory ?? context?.recentActions;
  if (!history?.length) return '暂无';
  return history.map(item => item.action === 'pass'
    ? `座位${item.seatIndex}：不出`
    : `座位${item.seatIndex}：${describePattern(item.pattern || null)}`
  ).join('\n');
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
): Promise<CardPattern | null | undefined> {
  const normalizedSelection = normalizeAiSelection(selection.provider, selection.model);
  const providerConfig = getProviderConfig(normalizedSelection.provider);
  if (!providerConfig.apiKey || !normalizedSelection.model) return undefined;
  if (legalPlays.length === 0) return isFreePlay ? undefined : null;

  const systemPrompt = `你是一名高水平竞技掼蛋选手，熟悉牌型、进贡还贡、逢人配、升级、双人协作、记牌、牌权控制和残局计算。你的任务不是单纯尽快出完，而是与对家合作，最大化本方双上、升级并避免对方双上的概率。

【规则与执行边界】
使用两副牌、四人两队、对家为队友。牌型包括单张、对子、三张、三带二、固定5张顺子、固定3连对、固定2连三钢板、炸弹、同花顺和四王炸。红桃级牌是逢人配，可代替除大小王外的任意牌。牌力为大王>小王>级牌>A>K>Q>J>10>9>8>7>6>5>4>3>2；炸弹先比张数再比点数，同花顺大于五炸小于六炸，四王炸最大。平台传入的规则与合法动作集合拥有最高优先级。你不判断合法性，只能选择legal_actions中的action_id，绝不能创造动作或修改动作里的牌。

【信息边界】
只能使用本轮输入中的自己手牌、桌面牌、公开出牌推算的余牌数、公开行动与进贡还贡、当前级牌和合法动作。未见牌池只表示其余玩家合计可能持有的牌，不表示某个玩家的确定手牌。不得假设知道其他玩家实际手牌，不得把推断当成事实；过牌不代表没有能接的牌。remainingTurns是只考虑自己手牌、无对手干扰时的拆分手数，exact=false时只是可行上界。模拟胜率来自少量随机分配的未知手牌和规则AI续打，不是保证；样本少于4时不要据此改变策略，样本相近时优先手牌结构与本地排序。未提供完整公开牌历史时，不得声称完成了精确记牌。

【决策优先级】
1. 最大化本方取得有利名次和升级的概率；2. 争取本方双上；3. 避免对方双上；4. 帮助队友取得头游；5. 控制关键牌权；6. 保存炸弹、同花顺和逢人配的战略价值；7. 减少孤张并优化手牌结构；8. 收益接近时选择风险更低、信息暴露更少的打法。必要时主动让牌、送队友、阻击对手或牺牲自己的名次。

【行动前检查】
在内部依次检查但不要输出冗长思维过程：当前牌权与阶段；各家余牌及主要威胁；自己的自然成牌、孤张与拆牌风险；逢人配最佳用途；关键牌和炸弹的概率分布；队友近期行动与送牌机会；对手报单/报双风险；每个主要候选的即时收益、续牌能力、被反压概率、队友收益、对手收益、牌型成本及双上概率变化。

【阶段策略】
开局整理结构、确定主攻与辅助，不为试探反复出单。中盘根据余牌和行动历史传递己方牌权，不为低价值一轮破坏整体结构。任何玩家剩5张以内进入残局规划，按一手、两手、三手计算；对手报单保留单张控制，对手报双保留对子控制，队友报单/报双尽量创造对应牌型。自由出牌默认优先不拆炸弹的多张自然牌型，不要连续以“试探”为由出单；只有确需清理孤张或多张动作明显破坏关键结构时才出小单。

【协作与炸弹】
队友牌默认不压；接队友牌必须为了直接走完、阻击对手或重新送牌。队友是主攻者时承担拦截、拆牌和送牌职责。炸弹并非越晚越好：能阻止对手走牌、帮助队友走牌或形成连续牌权时果断使用；不要用炸弹赢低价值牌，炸后还要评估能否续牌。红桃级牌优先用于组合，除紧急拦截报单对手外不单出。稳健但不机械保守，信息不足时作概率化的稳健决策。

只输出一个JSON对象，不得输出JSON以外内容。`;

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
    public_history_scope: knowledge ? '本局完整公开出牌与过牌；未见牌不确定属于哪家'
      : '公开历史不完整或不一致，不能精确记牌',
    public_memory: knowledge ? {
      played_cards: describeHand(knowledge.played, currentLevel),
      unseen_cards: describeHand(knowledge.unseen, currentLevel),
      publicly_known_cards: knowledge.knownBySeat.map((cards, seat) => ({
        seat, cards: describeHand(cards, currentLevel),
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
    action_history: describeHistory(context).split('\n'),
    legal_actions: legalPlays.map((option, actionId) => ({
      action_id: actionId,
      type: PATTERN_NAMES[option.type],
      cards: option.cards.map(card => cardDisplayName(card)),
      rank: option.rank,
      length: option.length,
      analysis: analysis?.candidates[analysisKey(option)],
    })),
  };
  const userPrompt = `请根据以下牌桌输入选择动作：\n${JSON.stringify(input)}\n
输出格式：{"action_id":数字或"PASS","cards":["仅用于复述所选动作"],"intent":"走牌/控权/送队友/阻击对手/整理牌型/试探/保留实力","confidence":0.00,"brief_reason":"不超过80个汉字","risk":"主要风险"}。只有跟牌时可选择PASS。`;

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
        temperature: 0.25,
        max_tokens: 384,
      };
      if (normalizedSelection.provider === 'deepseek') {
        requestBody.thinking = { type: 'disabled' };
        requestBody.response_format = { type: 'json_object' };
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
    const reason = typeof reasonSource === 'string' ? reasonSource.slice(0, 80) : '未提供理由';
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
