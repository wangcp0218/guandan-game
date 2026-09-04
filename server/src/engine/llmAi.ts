import { AiModelSelection, AiProvider, Card, CardPattern, PatternType } from '../../../shared/types';
import { cardDisplayName, sortCards } from './card';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const LOCAL_BASE_URL = 'http://192.168.150.51:3000/v1';
export const DEFAULT_AI_SELECTION: AiModelSelection = {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
};
const DEFAULT_TIMEOUT = 8000;
const DEFAULT_LOCAL_TIMEOUT = 20000;

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
  players: AiPlayerSnapshot[];
  recentActions: AiRecentAction[];
}

function getTimeoutMs(provider: AiProvider): number {
  const configured = Number(provider === 'local'
    ? process.env.LOCAL_LLM_TIMEOUT_MS || process.env.LLM_TIMEOUT_MS
    : process.env.DEEPSEEK_TIMEOUT_MS || process.env.LLM_TIMEOUT_MS
  );
  const fallback = provider === 'local' ? DEFAULT_LOCAL_TIMEOUT : DEFAULT_TIMEOUT;
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
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
  const timeoutId = setTimeout(() => controller.abort(), getTimeoutMs(provider));
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
  if (!context || context.recentActions.length === 0) return '暂无';
  return context.recentActions.map(item => item.action === 'pass'
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
): Promise<CardPattern | null | undefined> {
  const normalizedSelection = normalizeAiSelection(selection.provider, selection.model);
  const providerConfig = getProviderConfig(normalizedSelection.provider);
  if (!providerConfig.apiKey || !normalizedSelection.model) return undefined;
  if (legalPlays.length === 0) return isFreePlay ? undefined : null;

  const systemPrompt = `你是四人掼蛋的高水平搭档型AI。你不需要判断牌型合法性，服务端已给出一组经过校验的候选方案，只能选择候选的option_id。
你的目标是让自己与对家组成的队伍获得尽可能好的名次，而不是只顾自己最快出完。
关键规则：红桃级牌是逢人配；大王>小王>级牌>A>K>Q>J>10>9>8>7>6>5>4>3>2；炸弹张数越多越大；天王炸最大。
策略：优先帮助即将出完的队友；对手剩1至2张时主动封堵；红桃级牌作为逢人配应优先用于组合，除非紧急拦截报单对手，否则绝不单出；队友领牌时默认不压，绝不使用炸弹压队友，除非该手能让自己立即出完；非必要不拆炸弹、同花顺和整齐组合；能用普通牌压制就不用炸弹；自由出牌优先清理孤张或一次多出牌，但要结合队友与对手余牌。自由出牌若选择单张，必须优先使用低有效点数的普通孤张；手中还有普通牌时绝不能以大王、小王或级牌单张起手。
请简短权衡本轮局势，只输出JSON。`;

  const lastPlayerSnapshot = context?.players.find(player =>
    player.seatIndex === context.lastPlayPlayerIndex
  );
  const relationNames = { self: '自己', partner: '队友', opponent: '对手' } as const;
  const lastPlayer = lastPlayerSnapshot
    ? `座位${lastPlayerSnapshot.seatIndex}（${relationNames[lastPlayerSnapshot.relation]}）`
    : '无';
  const userPrompt = `当前是${currentLevel}级，自己座位${context?.selfSeatIndex ?? '未知'}，队友座位${context?.partnerSeatIndex ?? '未知'}。
阶段：${isFreePlay ? '自由出牌，必须选择一个候选方案' : '跟牌，可以选择候选方案或不出'}。
自己的手牌：${describeHand(hand, currentLevel)}
上一手出牌者：${lastPlayer}
上一手：${describePattern(lastPattern)}

玩家状态：
${describePlayers(context)}

最近行动（由早到晚）：
${describeHistory(context)}

合法候选方案：
${describeOptions(legalPlays)}

返回格式：{"option_id":数字或null,"reason":"不超过40字的策略理由"}。只有跟牌且决定不出时option_id才可为null。`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), getTimeoutMs(normalizedSelection.provider));
    let response: Response;
    try {
      const requestBody: Record<string, unknown> = {
        model: normalizedSelection.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.25,
        max_tokens: 256,
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
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      console.error(`[LLM AI] ${normalizedSelection.provider}/${normalizedSelection.model} API error: ${response.status}`);
      return undefined;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return undefined;
    const parsed = parseModelResponse(content);
    const optionId = parsed.option_id;

    const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 80) : '未提供理由';
    if (optionId === null) {
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
