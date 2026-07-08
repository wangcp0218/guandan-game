import { Card, CardPattern, PatternType, Rank, Suit } from '../../../shared/types';
import { cardDisplayName, sortCards, effectiveRank } from './card';
import { identifyPattern } from './patterns';
import { canBeat, canFreePlay } from './compare';

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const LLM_TIMEOUT = 2000;

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

    const systemPrompt = `你是掼蛋AI玩家。牌的大小：大王>小王>级牌(${currentLevel})>A>K>Q>J>10>9>8>7>6>5>4>3>2。
牌型：单张、对子、三不带、三带二、顺子(≥5连)、连对(≥3连对)、钢板(≥2连三)、炸弹(4-8同点)。
出牌规则：跟牌必须同类型同长度更大，或出炸弹。牌型不对或不够大就要"不出"。
牌型强度：天王炸(4王)>普通炸弹(张多>张少，同张比点)>同花顺>普通牌型。`;

    const userMessage = `级牌:${currentLevel}级 手牌:${handDesc}
手牌JSON:${handJson}
上家出牌:${lastDesc}
${isFreePlay ? '自由出牌' : '需跟牌或炸弹'}

返回JSON:{"card_ids":[牌id列表],"reason":"理由"}。不出则card_ids:[]。自由出牌优先小单张/小对子。`;

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
  return null;
}
