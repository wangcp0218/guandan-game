import { Card, Rank, Suit } from '../../../shared/types';
import type { AiDecisionContext } from './llmAi';

/** Synthesized guidance, not a learned policy or a reproduction of paper results.
 * Sources and qualifications: docs/ai-strategy-research.md.
 * Stable checklist shared by every decision; no additional model requests. */
export const STRATEGY_GUIDE = `【目标优先级，前项优先】
P0 直接合法走完；P1 阻止对手本轮走完或获得危险接风；P2 让队友续走或接管后送出队友可接的牌；P3 为自己建立“领牌→被压→回手→尾牌”路线；P4 整理低散牌并保留控制资源。名次和本方升级高于个人出牌张数。
【每手固定核对】
1. 只列公开事实：谁领牌、各家余牌、连续推进、PASS后谁接风；过牌不证明无牌，两张不证明是对子，未知底牌不得当事实。
2. 至少比较当前候选、较低资源候选、PASS（若合法）。比较余牌手数、实际回手牌型、队友收益和对手最危险应手；remainingTurns只是静态拆分。
3. 王、A、自然级牌、炸弹、同花顺、逢人配均为控制/重组资源。平静开局若自然顺子或低组合出牌不少且余牌手数不增，保留三张A、级牌和王；高组合只有在少一手、解决唯一坏结构、直接走完或必要防守时才先出。
4. 三带二的附件不提高主体强度；主体与附件共同比较。接管必须说明下一手实际可出的牌；让牌必须说明等待谁、等待什么牌型。controlProven=false不等于必能回手。
5. 残局比较试探→回手→收尾和控制→收尾；检查对手能否一手接完。模拟和抽样只是不确定证据。
【输出自检】
decision_check必须如实说明目标、资源是保留还是有理由消耗、最危险应手，以及为何不用更低成本候选；不得声称保留了本手已经打出的A、王、级牌、配牌或炸弹。`;

export function strategyBrief(hand: Card[], level: number, context?: AiDecisionContext) {
  const naturalLevel = hand.filter(c => c.rank === level && c.suit !== Suit.Heart).length;
  const opponents = context?.players.filter(p => p.relation === 'opponent' && p.finishRank === null) || [];
  const publicPlays = (context?.actionHistory || context?.recentActions || [])
    .filter(action => action.action === 'play').length;
  const opening = hand.length >= 20 && publicPlays <= 4
    && (context?.players.every(player => player.finishRank === null && player.cardCount >= 20) ?? true);
  return {
    framework_version: 'whole-hand-v2',
    priority_order: ['direct_finish', 'block_immediate_finish_or_catch_wind',
      'partner_progress', 'own_recapture_route', 'organize_and_preserve_control'],
    mandatory_comparison: ['selected_action', 'lower_resource_action', 'PASS_if_legal',
      'remaining_turns', 'real_recapture_shape', 'opponent_worst_reply'],
    opening,
    level,
    natural_level_cards: naturalLevel,
    level_group_options: { pair: naturalLevel >= 2, triple: naturalLevel >= 3,
      caveat: '这些选择重叠，不是独立的多次控制；顺子按声明点数比较' },
    wildcards: hand.filter(c => c.rank === level && c.suit === Suit.Heart).length,
    most_advanced_opponents: opponents.length ? opponents.filter(p =>
      p.cardCount === Math.min(...opponents.map(x => x.cardCount))).map(p => p.seatIndex) : [],
    comparison_axes: ['team_finish_order', 'lead_and_recapture', 'control_resources',
      'remaining_structure', 'seat_interception', 'opponent_best_reply'],
    note: '按优先级逐项核对。推进快不证明牌强；牌少不证明牌型；不得读取其他手牌。',
  };
}
