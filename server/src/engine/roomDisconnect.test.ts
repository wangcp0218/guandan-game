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

test('AI watchdog executes the prepared interception and clears it for the next turn', () => {
  const { room } = setup();
  try {
    const deck = createDeck();
    const self = room.state!.currentPlayerIndex, player = room.players[self];
    player.isAI = true;
    room.hands.set(player.id, [deck[4], deck[5]]);
    room.state!.lastPlay = identifyPattern([deck[2]], 2)!;
    room.state!.lastPlayPlayerIndex = (self + 3) % 4;
    const internals = room as unknown as {
      preparedPlay: ReturnType<typeof identifyPattern> | undefined;
      handleTimeout(): void;
    };
    internals.preparedPlay = identifyPattern([deck[4]], 2);
    internals.handleTimeout();
    assert.equal(room.state!.lastPlayPlayerIndex, self);
    assert.deepEqual(room.getHand(player.id).map(c => c.id), [deck[5].id]);
    assert.equal(internals.preparedPlay, undefined);
  } finally { room.clearPlayers(); }
});

test('waiting room departure still frees the seat', () => {
  const room = new GameRoom('waiting-test', 'p0');
  room.addPlayer('p0', 'P0', 2, null);
  room.removePlayer('p0');
  assert.equal(room.getPlayerCount(), 0);
});

test('invited players can choose the inviter partner or either opponent seat', () => {
  const room = new GameRoom('invite-seat-test', 'owner');
  room.addPlayer('owner', 'Owner', 2, null);
  const partner = room.resolveInviteSeat('owner', 'partner');
  assert.deepEqual(partner, { success: true, seatIndex: 2 });
  assert.equal(room.addPlayer('friend', 'Friend', 2, null, false, partner.seatIndex), 2);
  assert.match(room.resolveInviteSeat('owner', 'partner').error || '', /同队座位已被占用/);

  const firstOpponent = room.resolveInviteSeat('owner', 'opponent');
  assert.deepEqual(firstOpponent, { success: true, seatIndex: 1 });
  assert.equal(room.addPlayer('opponent-1', 'Opponent 1', 2, null, false, firstOpponent.seatIndex), 1);
  const secondOpponent = room.resolveInviteSeat('owner', 'opponent');
  assert.deepEqual(secondOpponent, { success: true, seatIndex: 3 });
  assert.equal(room.addPlayer('opponent-2', 'Opponent 2', 2, null, false, secondOpponent.seatIndex), 3);
  assert.match(room.resolveInviteSeat('owner', 'opponent').error || '', /两个对手座位都已被占用/);
  room.clearPlayers();
});

test('LLM is default and AI turns retain the 90-second watchdog', () => {
  const room = new GameRoom('ai-timeout-test', 'p0');
  assert.equal(room.aiUseLLM, true);
  room.addPlayer('p0', 'P0', 2, null);
  room.fillWithAI();
  room.startGame();
  try {
    if (room.turnTimer) clearTimeout(room.turnTimer);
    const aiIndex = room.players.findIndex(player => player.isAI);
    room.state!.currentPlayerIndex = aiIndex;
    (room as unknown as { startTurn(): void }).startTurn();
    assert.ok(room.turnTimer);
    const remaining = room.state!.actionDeadline! - Date.now();
    assert.ok(remaining > 89_000 && remaining <= 90_000);
  } finally { room.clearPlayers(); }
});
