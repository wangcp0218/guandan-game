// Usage: node scripts/compare-ai-revisions.cjs [deals-per-level] [output-dir] [candidate] [baseline]
// Compares an isolated working-tree snapshot with HEAD; never loads .env or calls an LLM.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const root = path.resolve(__dirname, '..');
const dealsPerLevel = Number(process.argv[2] || 100);
if (!Number.isInteger(dealsPerLevel) || dealsPerLevel < 1 || dealsPerLevel > 100000) {
  throw new Error('Deals per level must be an integer between 1 and 100000');
}
const output = path.resolve(process.argv[3] || 'reports/ai-structure-self-play-2026-09-18');
const refs = [process.argv[4] || 'WORKTREE', process.argv[5] || 'HEAD'];
const revisions = refs.map(ref => ref === 'WORKTREE' ? 'WORKTREE' : execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' }).trim());
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'guandan-selfplay-'));
const seedBase = 20260918;
fs.mkdirSync(output, { recursive: true });
const rawPath = path.join(output, 'rounds.jsonl');
fs.writeFileSync(rawPath, '');
const started = Date.now();

function compile(revision, name) {
  const folder = path.join(temporary, name);
  fs.mkdirSync(folder);
  const archive = execFileSync('git', ['archive', revision === 'WORKTREE' ? 'HEAD' : revision], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', folder], { input: archive });
  if (revision === 'WORKTREE') {
    for (const dir of ['server/src', 'shared']) fs.cpSync(path.join(root, dir), path.join(folder, dir), { recursive: true });
    fs.copyFileSync(path.join(root, 'server/tsconfig.json'), path.join(folder, 'server/tsconfig.json'));
    fs.writeFileSync(path.join(output, 'candidate.patch'), execFileSync('git', ['diff', 'HEAD', '--', 'server/src', 'shared', 'server/tsconfig.json'], { cwd: root }));
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(folder, 'node_modules'), 'dir');
  execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(folder, 'server/tsconfig.json')]);
  return path.join(folder, 'server/dist/server/src/engine');
}

// Confidence intervals treat each exchanged-seat pair as one independent sample.
function meanCI(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length < 2) return { mean, ci95: null };
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const margin = 1.96 * Math.sqrt(variance / values.length);
  return { mean, ci95: [mean - margin, mean + margin] };
}

function summarize(pairs) {
  const outcomes = pairs.flatMap(pair => pair.outcomes);
  return {
    deals: pairs.length, rounds: outcomes.length,
    candidateWinRate: meanCI(pairs.map(pair => pair.outcomes.filter(o => o.won).length / 2)),
    candidateMeanLevelDelta: meanCI(pairs.map(pair => pair.outcomes.reduce((sum, o) => sum + o.levelDelta, 0) / 2)),
    candidateDoubleWinRate: outcomes.filter(o => o.won && o.partnerRank === 2).length / outcomes.length,
    baselineDoubleWinRate: outcomes.filter(o => !o.won && o.partnerRank === 2).length / outcomes.length,
    telemetry: ['candidate', 'baseline'].map(name => {
      const entries = pairs.map(pair => pair.telemetry[name]);
      const calls = entries.reduce((s, e) => s + e.calls, 0);
      return { name, calls, meanDecisionMs: entries.reduce((s, e) => s + e.ms, 0) / calls, leads: entries.reduce((s,e) => s + e.leads,0), consecutivePairLeads: entries.reduce((s,e) => s + e.consecutivePairLeads,0) };
    }),
    meanActions: outcomes.reduce((sum, o) => sum + o.steps, 0) / outcomes.length,
  };
}

async function main() {
  try {
    const candidateDir = compile(revisions[0], 'candidate');
    const baselineDir = compile(revisions[1], 'baseline');
    const candidate = require(path.join(candidateDir, 'ai.js')).findBestPlay;
    const { shuffledDeal, simulateEvaluationRound } = require(path.join(candidateDir, 'aiEvaluation.js'));
    // A/A on an identical deal must produce identical outcomes regardless of labels.
    const sanityHands = shuffledDeal(seedBase);
    const sanityA = simulateEvaluationRound(sanityHands, 2, [candidate, candidate, candidate, candidate]);
    const sanityB = simulateEvaluationRound(sanityHands, 2, [candidate, candidate, candidate, candidate]);
    if (JSON.stringify(sanityA) !== JSON.stringify(sanityB)) throw new Error('A/A reproducibility failed');
    const pairs = [];
    const workerCount = Math.min(4, os.availableParallelism());
    const workers = Array.from({ length: workerCount }, (_, workerIndex) => new Worker(
      '(' + evaluateWorker.toString() + ')()',
      { eval: true, workerData: { candidateDir, baselineDir, seedBase, dealsPerLevel, workerIndex, workerCount } },
    ));
    try {
      await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
        worker.on('message', pair => {
          pairs.push(pair);
          fs.appendFileSync(rawPath, JSON.stringify(pair) + '\n');
          if (pairs.length % 100 === 0) console.log(JSON.stringify({ seconds: (Date.now() - started) / 1000, ...summarize(pairs) }));
        });
        worker.on('error', reject);
        worker.on('exit', code => code === 0 ? resolve() : reject(new Error('Worker exit ' + code)));
      })));
    } finally {
      await Promise.all(workers.map(worker => worker.terminate()));
    }
    pairs.sort((a, b) => a.level - b.level || a.seed - b.seed);
    if (pairs.length !== dealsPerLevel * 13) throw new Error('Incomplete evaluation');
    fs.writeFileSync(rawPath, pairs.map(pair => JSON.stringify(pair)).join('\n') + '\n');
    const result = {
      candidate: revisions[0], candidateBase: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), baseline: revisions[1], seedBase, dealsPerLevel,
      mode: 'findBestPlay; no LLM; independent rounds without tribute; same deal with exchanged teams; seat 0 leads',
      ciMethod: 'Normal approximation on independent paired-deal means (not individual rounds)',
      sanityPassed: true, seconds: (Date.now() - started) / 1000,
      overall: summarize(pairs),
      byLevel: Array.from({ length: 13 }, (_, index) => ({ level: index + 2, ...summarize(pairs.filter(pair => pair.level === index + 2)) })),
    };
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
    console.log('Saved ' + path.join(output, 'summary.json'));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }

}

function evaluateWorker() {
  const { workerData, parentPort } = require('node:worker_threads');
  const path = require('node:path');
  const { candidateDir, baselineDir, seedBase, dealsPerLevel, workerIndex, workerCount } = workerData;
  const candidate = require(path.join(candidateDir, 'ai.js')).findBestPlay;
  const baseline = require(path.join(baselineDir, 'ai.js')).findBestPlay;
  const { shuffledDeal, simulateEvaluationRound } = require(path.join(candidateDir, 'aiEvaluation.js'));
  for (let index = workerIndex; index < dealsPerLevel; index += workerCount) {
    for (let level = 2; level <= 14; level++) {
      const seed = seedBase + (level - 2) * 100000 + index;
      const hands = shuffledDeal(seed);
      const telemetry = Object.fromEntries(['candidate', 'baseline'].map(name => [name, { calls: 0, ms: 0, leads: 0, consecutivePairLeads: 0 }]));
      const instrument = (policy, name) => (...args) => {
        const start = performance.now();
        const action = policy(...args);
        const stats = telemetry[name];
        stats.calls++; stats.ms += performance.now() - start;
        if (args[2] && action) { stats.leads++; if (action.type === 'consecutive_pair') stats.consecutivePairLeads++; }
        return action;
      };
      const c = instrument(candidate, 'candidate'), b = instrument(baseline, 'baseline');
      const rounds = [
        simulateEvaluationRound(hands, level, [c, b, c, b]),
        simulateEvaluationRound(hands, level, [b, c, b, c]),
      ];
      parentPort.postMessage({ level, seed, telemetry, outcomes: rounds.map((round, team) => ({
        won: round.winnerTeam === team,
        levelDelta: Math.round(round.rewardForTeam0 * 3) * (team === 0 ? 1 : -1),
        partnerRank: round.partnerRank, steps: round.steps,
      })) });
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
