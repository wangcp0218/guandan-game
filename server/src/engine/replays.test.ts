import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveRoundReplay, SavedReplay } from '../db/replays';

test('completed replay survives memory changes and preserves separate rounds', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guandan-replay-'));
  try {
    const replay: SavedReplay = {
      roomId: 'test-room', roundNumber: 1, level: 2,
      players: [{ id: 'p1', name: '玩家', seatIndex: 0 }],
      actions: [{ seatIndex: 0, action: 'pass' }],
      result: { replay: ['本局级牌：2', '玩家：♠Q ♥Q ♣Q', '玩家：不出'],
        rankings: [{ playerId: 'p1', rank: 1 }], winnerTeam: 0, loserTeam: 1, winnerLevelDelta: 3 },
    };
    saveRoundReplay(replay, directory);
    const expected = JSON.parse(JSON.stringify(replay));
    replay.actions.length = 0;
    replay.result.replay!.length = 0;
    saveRoundReplay({ ...replay, roundNumber: 2 }, directory);
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'test-room-round-1.json'), 'utf8'));
    assert.ok(saved.savedAt);
    delete saved.savedAt;
    assert.deepEqual(saved, expected);
    assert.deepEqual(fs.readdirSync(directory).sort(), ['test-room-round-1.json', 'test-room-round-2.json']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
