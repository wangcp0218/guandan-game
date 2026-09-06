const assert = require('node:assert/strict');
const { identifyPattern, declarePatterns } = require('./dist/server/src/engine/patterns');
const { canBeat } = require('./dist/server/src/engine/compare');
const { isValidReturnTributeCard } = require('./dist/server/src/engine/rules');
const { GameRoom } = require('./dist/server/src/services/GameRoom');
let id = 0;
const cards = ranks => ranks.map((rank, i) => ({ id: id++, rank, suit: ['S', 'C', 'D'][i % 3] }));
const wild = () => ({ id: id++, rank: 2, suit: 'H' });
assert.equal(identifyPattern(cards([3,3,3,4,4,4,5,5,5]), 2), null);
assert.equal(identifyPattern(cards([3,3,3,4,4,4,7,7,8,8]), 2), null);
assert.equal(identifyPattern(cards([3,3,3,4,4,4]), 2).type, 'plane');
for (const [lower, upper] of [ [[3,4,5,6,7], [4,5,6,7,8]], [[5,5,6,6,7,7],[6,6,7,7,8,8]], [[6,6,6,7,7,7],[7,7,7,8,8,8]] ]) {
  assert.equal(canBeat(identifyPattern(cards(lower),7), identifyPattern(cards(upper),7),7), false);
}
assert.equal(identifyPattern([...cards([15,15,6,6]),wild()],2).rank, 6);
const ten = identifyPattern([...cards(Array(8).fill(7)),wild(),wild()],2);
assert.equal(ten.type,'bomb10');
assert(canBeat(identifyPattern(cards([15,15,16,16]),2),ten,2));
assert.equal(canBeat(ten,identifyPattern(cards([15,15,16,16]),2),2),false);
const physical = [...cards([3,4,5,6]),wild()];
for (const option of declarePatterns(physical,2)) {
  assert.deepEqual(option.cards.map(c=>c.id),physical.map(c=>c.id));
  assert(option.substitutions.every(c=>c.rank<=14));
}
assert(isValidReturnTributeCard({rank:7,suit:'H'},7));
assert(!isValidReturnTributeCard({rank:11,suit:'S'},2));
function room() {
  const r=new GameRoom('test','p0');
  for(let i=0;i<4;i++)r.addPlayer('p'+i,'P'+i,2,{emit(){}},false);
  r.startTurn=()=>{};
  r.startGame();
  return r;
}
function finish(r) {
  r.rankings=[{playerId:'p0',rank:1},{playerId:'p2',rank:2},{playerId:'p1',rank:3},{playerId:'p3',rank:4}];
  r.endRound();
}
const entering=room();entering.teamLevels=[13,2];entering.currentLevel=13;finish(entering);
assert.equal(entering.state.phase,'round_end');
const ace=room();ace.teamLevels=[14,2];ace.currentLevel=14;finish(ace);
assert.equal(ace.state.phase,'game_over');
assert(!ace.startNextRound('p0').success);
const limited=room();limited.competition.maxRounds=1;finish(limited);
assert.equal(limited.state.phase,'game_over');
const tied=room();tied.teamLevels=[2,5];tied.competition.maxRounds=1;finish(tied);
assert.equal(tied.state.phase,'round_end');
assert.match(tied.state.roundResult.endReason,/加赛/);
const timed=room();timed.competition.maxMinutes=1;timed.matchStartedAt=Date.now()-61000;finish(timed);
assert.equal(timed.state.phase,'game_over');
const penalty=room();penalty.competition.tripleDoublePenalty=true;
finish(penalty);finish(penalty);finish(penalty);
assert.equal(penalty.teamLevels[0],9);
assert.equal(penalty.state.roundResult.levelPenalty,2);
const noReturn=room();noReturn.state.phase='return_tribute';noReturn.hands.set('p0',cards([11,12,13,14]));
let transferred=false;noReturn.finishReturnTribute=()=>{transferred=true;};
noReturn.autoReturnTribute({toPlayerId:'p0',returnCard:null});assert.equal(transferred,false);
const r=room();r.state.currentPlayerIndex=0;r.hands.set('p0',cards([3,4]));
assert(r.playCards('p0',[r.getHand('p0')[0]]).success);
assert.equal(r.reportedCounts.get('p0'),1);
r.startGame();assert.equal(r.reportedCounts.size,0);
console.log('Rules regression passed');
