import fs from 'node:fs';
import path from 'node:path';
import type { RoundResult } from '../../../shared/types';
import type { AiRecentAction } from '../engine/llmAi';

export interface SavedReplay {
  roomId: string;
  roundNumber: number;
  level: number;
  players: Array<{ id: string; name: string; seatIndex: number }>;
  actions: AiRecentAction[];
  result: RoundResult;
}

/** One file per completed round; the UI replay includes post-tribute hands. */
export function saveRoundReplay(replay: SavedReplay,
  directory = path.join(process.cwd(), 'data', 'replays')): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const room = replay.roomId.replace(/[^a-zA-Z0-9-]/g, '_');
  const filename = path.join(directory, `${room}-round-${replay.roundNumber}.json`);
  const temporary = `${filename}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({
    savedAt: new Date().toISOString(), ...replay,
  }, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, filename);
}
