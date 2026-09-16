import { findBestPlay } from './ai';
import { evaluateStrategies } from './aiEvaluation';

const deals = Math.max(1, Number.parseInt(process.argv[2] || '20', 10) || 20);
const summary = evaluateStrategies(findBestPlay, findBestPlay, { deals, seed: 20260916 });
console.log(JSON.stringify(summary, null, 2));

