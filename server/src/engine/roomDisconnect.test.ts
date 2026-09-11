import assert from 'node:assert/strict';
import test from 'node:test';
import { GameRoom } from '../services/GameRoom';
import { createDeck } from './card';
import { identifyPattern } from './patterns';

function setup() {
  const room = new GameRoom('disconnect-test', 'p0');
  const sockets = Array.from({ length: 4 }, () => ({ emit() {} }));
  sockets.forEach((socket, i) => room.addPlayer(`p${i}`, `P${i}`, 2, socket));
  room.startGame();
  return { room, sockets };
}

test('finished player disconnect preserves seats and catch wind, then rejoining restores socket', () => {
  const { room, sockets } = setup();
  try {
    const card = createDeck()[0];
    room.rankings = [{ playerId: 'p0', rank: 1 }];
    room.hands.set('p0', []);
    room.state!.lastPlay = identifyPattern([card], 2)!;
    room.state!.lastPlayPlayerIndex = 0;
    room.state!.currentPlayerIndex = 1;
    assert.equal(room.removePlayer('p0', sockets[0]), true);
    assert.deepEqual(room.players.map(p => p.id), ['p0', 'p1', 'p2', 'p3']);
    for (const id of ['p1', 'p2', 'p3']) assert.equal(room.playCards(id, []).success, true);
    assert.equal(room.state!.currentPlayerIndex, 2);
    assert.equal(room.state!.lastPlay, null);
    assert.ok(room.turnTimer);
    const replacement = { emit() {} };
    room.addPlayer('p0', 'P0', 2, replacement);
    assert.equal(room.removePlayer('p0', sockets[0]), false);
    assert.equal(room.players[0].socket, replacement);
    assert.equal(room.rankings[0].playerId, 'p0');
  } finally { room.clearPlayers(); }
});

test('invalid play and invalid pass retain the turn timeout', () => {
  const { room } = setup();
  try {
    const player = room.players[room.state!.currentPlayerIndex];
    const timer = room.turnTimer;
    assert.equal(room.playCards(player.id, []).success, false);
    assert.equal(room.turnTimer, timer);
    const card = room.getHand(player.id)[0];
    assert.equal(room.playCards(player.id, [card, card]).success, false);
    assert.equal(room.turnTimer, timer);
  } finally { room.clearPlayers(); }
});

test('waiting room departure still frees the seat', () => {
  const room = new GameRoom('waiting-test', 'p0');
  room.addPlayer('p0', 'P0', 2, null);
  room.removePlayer('p0');
  assert.equal(room.getPlayerCount(), 0);
});
