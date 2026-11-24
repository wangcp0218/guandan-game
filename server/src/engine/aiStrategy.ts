import { Card, Rank, Suit } from '../../../shared/types';
import type { AiDecisionContext } from './llmAi';

/** Synthesized guidance, not a learned policy or a reproduction of paper results.
 * Sources and qualifications: docs/ai-strategy-research.md.
 * Stable checklist shared by every decision; no additional model requests. */
export const STRATEGY_GUIDE = `【目标优先级，前项优先】
P0 直接合法走完；P1 阻止对手本轮走完或获得危险接风；P2 让队友续走或接管后送出队友可接的牌；P3 为自己建立“领牌→被压→回手→尾牌”路线；P4 整理低散牌并保留控制资源。名次和本方升级高于个人出牌张数。
【每手固定核对】
1. 比较拟选动作、低耗接牌和合法的PASS。过牌不证明无牌，两张不证明是对子；对手连续推进或可能接风时应比较主动拦截。
2. 平静开局，先出低牌若不增加余牌手数，就保留高三张。跟牌时比较普通接牌、过牌和用王或炸弹抢回后能领什么。只抢回一墩、余牌仍很长，收益有限。三带二只比三张的点数，附件尽量用普通对子，保留王、级牌、逢人配和炸弹。
3. 让队友续走；若接管送队友，核实余牌有对应领牌及中间座位的拦截风险。残局比较试探→回手→收尾和控制→收尾，检查对手能否先走。
4. 核对所选动作余下的控制和手数。抽样与未来牌权有不确定性；说明最危险应手及放弃低成本选项的原因。`;

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
