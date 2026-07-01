import { Card, CardPattern, PatternType, Rank, Suit } from '../../../shared/types';
import { cardDisplayName, sortCards, effectiveRank } from './card';
import { identifyPattern } from './patterns';
import { canBeat, canFreePlay } from './compare';
import { findBestPlay } from './ai';

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const LLM_TIMEOUT = 5000;

function describeHand(cards: Card[], currentLevel: number): string {
  const sorted = sortCards(cards, currentLevel);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let count = 1;
    while (i + count < sorted.length && sorted[i + count].rank === sorted[i].rank) {
      count++;
    }
    parts.push(`${cardDisplayName(sorted[i])}x${count}`);
    i += count;
  }
  return parts.join(' ');
}

function describePattern(pattern: CardPattern | null): string {
  if (!pattern) return '无';
  const cards = pattern.cards.map(c => cardDisplayName(c)).join(' ');
  return `${pattern.type}(${cards}) 长度:${pattern.length}`;
}

function handToCardIds(cards: Card[]): { id: number; display: string }[] {
  return cards.map(c => ({ id: c.id, display: cardDisplayName(c) }));
}

export async function llmDecidePlay(
  hand: Card[],
  lastPattern: CardPattern | null,
  isFreePlay: boolean,
  currentLevel: number
): Promise<Card[] | null> {
  if (!DEEPSEEK_API_KEY) return null;

  try {
    const handDesc = describeHand(hand, currentLevel);
    const handCards = handToCardIds(hand);
    const handJson = JSON.stringify(handCards);
    const lastDesc = describePattern(lastPattern);

    const systemPrompt = `你是掼蛋（淮安掼蛋）游戏的AI玩家。你需要从手牌中选择要出的牌。

游戏规则：
- 当前级牌是${currentLevel}级，级牌的大小仅次于大小王
- 牌的大小顺序：大王 > 小王 > 级牌(${currentLevel}) > A > K > Q > J > 10 > 9 > 8 > 7 > 6 > 5 > 4 > 3 > 2(非级牌时)
- 可以出的牌型：单张、对子、三不带、三带二、顺子(5张及以上连续，不含2和王)、连对(3对及以上连续)、钢板/飞机(2个及以上连续三张)、炸弹(4-8张同点数)
- 天王炸(4张王) > 同花顺 > 普通炸弹(张数多的大，张数相同比点数)
- 必须出比上家大的同类型相同长度的牌，或者炸弹
- 如果上家出了非炸弹牌型，你必须出同类型同长度的更大牌，或者出炸弹
- 自由出牌时可以出任意牌型
- 每人27张牌，出完即获胜`;

    const userMessage = `当前局面：
- 当前级牌等级: ${currentLevel}
- 你的手牌: ${handDesc}
- 你的手牌JSON(含id): ${handJson}
- 上家出的牌: ${lastDesc}
- 是否自由出牌: ${isFreePlay ? '是' : '否'}
- ${isFreePlay ? '你可以自由选择出什么牌' : lastPattern ? '你必须出比上家大的牌或炸弹' : '你必须出任意牌'}

请从手牌中选择要出的牌，返回JSON格式：
{
  "card_ids": [1, 2, 3],  // 要出的牌的id列表，如果选择"不出"则返回空数组[]
  "reason": "简要说明出牌理由"
}

如果确实没有能打过的牌，card_ids返回空数组[]（表示"不出"）。
如果自由出牌，优先出小单张、小对子，保留炸弹和大牌。`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT);

    const response = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.3,
        max_tokens: 1024,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error(`DeepSeek API error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);
    const cardIds: number[] = parsed.card_ids || [];

    if (cardIds.length === 0) return [];

    const selectedCards = cardIds
      .map(id => hand.find(c => c.id === id))
      .filter(Boolean) as Card[];

    if (selectedCards.length !== cardIds.length) return null;

    const pattern = identifyPattern(selectedCards, currentLevel);
    if (!pattern) return null;

    if (!isFreePlay && lastPattern) {
      if (!canBeat(pattern, lastPattern, currentLevel)) return null;
    }

    return selectedCards;
  } catch (e: any) {
    if (e.name === 'AbortError') {
      console.log('DeepSeek API timeout, using rule-based AI');
    }
    return null;
  }
}

export async function llmFindBestPlay(
  hand: Card[],
  lastPattern: CardPattern | null,
  isFreePlay: boolean,
  currentLevel: number
): Promise<CardPattern | null> {
  const llmCards = await llmDecidePlay(hand, lastPattern, isFreePlay, currentLevel);
  if (llmCards !== null) {
    if (llmCards.length === 0) return null;
    return identifyPattern(llmCards, currentLevel);
  }
  return findBestPlay(hand, lastPattern, isFreePlay, currentLevel);
}
