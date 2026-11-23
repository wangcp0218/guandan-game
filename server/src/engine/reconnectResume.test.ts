import assert from 'node:assert/strict';
import test from 'node:test';
import { GameRoom } from '../services/GameRoom';
import { GamePhase } from '../../../shared/types';

function fakeSockets(count: number) {
  return Array.from({ length: count }, () => ({ emit() {} }));
}

test('mid-game disconnect keeps the seat and rejoin restores state without resetting', () => {
  const room = new GameRoom('reconnect-test', 'p0');
  const sockets = fakeSockets(4);
  sockets.forEach((socket, i) => room.addPlayer(`p${i}`, `P${i}`, 2, socket));
  room.startGame();
  try {
    const phaseBefore = room.state!.phase;
    const handsBefore = room.players.map(player => room.getHand(player.id).length);
    assert.equal(room.markPlayerOffline('p1', sockets[1]), true);
    assert.equal(room.players.find(player => player.id === 'p1')!.socket, null);
    assert.equal(room.state!.players.find(player => player.id === 'p1')!.isOnline, false);
    // The turn/phase must not be reset back to waiting.
    assert.equal(room.state!.phase, phaseBefore);
    assert.notEqual(room.state!.phase, GamePhase.Waiting);

    const replacement = { emit() {} };
    const seat = room.addPlayer('p1', 'P1', 2, replacement);
    assert.equal(room.players.find(player => player.id === 'p1')!.socket, replacement);
    assert.equal(room.state!.players.find(player => player.id === 'p1')!.isOnline, true);
    assert.equal(room.state!.phase, phaseBefore);
    assert.deepEqual(room.players.map(player => room.getHand(player.id).length), handsBefore);
    assert.ok(seat >= 0);
  } finally {
    room.clearPlayers();
  }
});

test('waiting-room disconnect reserves the seat for a grace period and rejoin keeps the same seat', () => {
  const room = new GameRoom('waiting-reconnect', 'p0');
  const socket0 = { emit() {} };
  const socket1 = { emit() {} };
  room.addPlayer('p0', 'P0', 2, socket0);
  room.addPlayer('p1', 'P1', 2, socket1);
  const seatBefore = room.state!.players.find(player => player.id === 'p1')!.seatIndex;
  try {
    assert.equal(room.markPlayerOffline('p1', socket1), true);
    // Seat is reserved, the player is not removed immediately.
    assert.equal(room.getPlayerCount(), 2);
    assert.equal(room.state!.players.find(player => player.id === 'p1')!.isOnline, false);

    const replacement = { emit() {} };
    const seat = room.addPlayer('p1', 'P1', 2, replacement);
    assert.equal(seat, seatBefore);
    assert.equal(room.getPlayerCount(), 2);
    assert.equal(room.state!.players.find(player => player.id === 'p1')!.isOnline, true);
    assert.equal(room.state!.players.find(player => player.id === 'p1')!.seatIndex, seatBefore);
  } finally {
    room.clearPlayers();
  }
});

test('playerIds reports only human players', () => {
  const room = new GameRoom('player-ids', 'p0');
  room.addPlayer('p0', 'P0', 2, { emit() {} });
  room.fillWithAI();
  const info = room.toRoomInfo();
  assert.deepEqual(info.playerIds, ['p0']);
});
