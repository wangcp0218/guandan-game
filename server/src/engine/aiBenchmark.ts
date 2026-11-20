import path from 'node:path';
import * as current from './ai';
import { EvaluationPolicy, seededRandom, shuffledDeal, simulatePolicyRound } from './aiEvaluation';
import type { AiStrategyMemory, AiStrategyPlan } from './llmAi';

// npm run benchmark:ai -w server -- deals candidate baseline seed [baseline-ai.js]
// Modes: rules (fast heuristic), local (full decision, no network), model (live).
function policy(engine: typeof current, mode: string, calls: Record<string, number>, seed: number): EvaluationPolicy {
  if (mode === 'rules') return engine.findBestPlay;
  if (!['local', 'model'].includes(mode)) throw new Error('Unknown policy: ' + mode);
  const memory = new Map<number, AiStrategyMemory>();
  return async (hand, trick, free, level, ctx) => {
    const seat = ctx.selfSeatIndex;
    ctx.strategyMemory = memory.get(seat);
    let plan: AiStrategyPlan | undefined;
    // This CLI runs one decision at a time in its own process. Also seed older
    // compiled policies which do not expose an RNG parameter.
    const original = Math.random;
    Math.random = seededRandom(seed * 257 + (ctx.actionHistory?.length || 0) * 4 + seat);
    const credentials = ['LOCAL_LLM_API_KEY', 'FUETERNAL_API_KEY', 'DEEPSEEK_API_KEY'] as const;
    const saved = credentials.map(name => process.env[name]);
    // Frozen revisions may predate useModel. Force their real offline fallback.
    if (mode === 'local' && engine !== current) for (const name of credentials) delete process.env[name];
    let action: Awaited<ReturnType<typeof current.findSmartPlay>>;
    try {
      action = await engine.findSmartPlay(hand, trick, free, level, ctx, undefined,
        p => { plan = p; }, trace => {
          calls[trace.source] = (calls[trace.source] || 0) + 1;
          if (trace.corrections?.some(note => note.rule === 'team_trick')) calls.teamTrick = (calls.teamTrick || 0) + 1;
          if (trace.corrections?.some(note => note.rule === 'team_baseline')) calls.teamBaseline = (calls.teamBaseline || 0) + 1;
        }, { useModel: mode === 'model' });
    } finally {
      Math.random = original;
      if (mode === 'local' && engine !== current) credentials.forEach((name, i) => {
        if (saved[i] !== undefined) process.env[name] = saved[i];
      });
    }
    if (plan) memory.set(seat, { ...plan, afterAction: (ctx.actionHistory?.length || 0) + 1,
      executed: action ? action.type + ':' + action.rank + ':' + action.cards.length : 'PASS' });
    return action;
  };
}

async function main() {
  const [count = '4', candidate = 'local', baseline = 'rules', seedArg = '20260916', file] = process.argv.slice(2);
  const deals = Number(count), seed = Number(seedArg);
  if (!Number.isSafeInteger(deals) || deals < 1 || !Number.isSafeInteger(seed)) throw new Error('Invalid deals or seed');
  if ([candidate, baseline].includes('model')
    && !(process.env.LOCAL_LLM_API_KEY || process.env.FUETERNAL_API_KEY || process.env.DEEPSEEK_API_KEY)) {
    throw new Error('Model evaluation requires configured provider credentials');
  }
  const previous: typeof current = file ? require(path.resolve(file)) : current;
  const candidateSources = {}, baselineSources = {};
  let wins = 0, doubleWins = 0, doubleLosses = 0, delta = 0;
  for (let i = 0; i < deals; i++) {
    const hands = shuffledDeal(seed + i), level = 2 + ((seed + i) % 13 + 13) % 13;
    for (const side of [0, 1]) {
      const test = policy(current, candidate, candidateSources, seed+i);
      const reference = policy(previous, baseline, baselineSources, seed+i);
      const result = await simulatePolicyRound(hands, level, side ? [reference, test] : [test, reference]);
      const won = result.winnerTeam === side;
      wins += Number(won);
      doubleWins += Number(won && result.partnerRank === 2);
      doubleLosses += Number(!won && result.partnerRank === 2);
      delta += 3 * result.rewardForTeam0 * (side ? -1 : 1);
    }
  }
  console.log(JSON.stringify({ deals, seed, candidate, baseline, baselineFile: file, rounds: 2 * deals,
    wins, doubleWins, doubleLosses, meanNetLevels: delta / (2 * deals), candidateSources, baselineSources }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
