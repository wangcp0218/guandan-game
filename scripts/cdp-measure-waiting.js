const WebSocket = require('/root/guandan-game/node_modules/ws');
const { execFile } = require('child_process');
const fs = require('fs');

const WIDTH = parseInt(process.argv[2] || '390', 10);
const HEIGHT = parseInt(process.argv[3] || '844', 10);
const DIST = '/root/guandan-game/client/dist';
const HARNESS = '/tmp/waiting-harness.html';

const cssMatch = fs.readFileSync(`${DIST}/index.html`, 'utf8').match(/index-[^"]*\.css/);
if (!cssMatch) throw new Error('built css not found in dist/index.html');
const cssName = cssMatch[0];

const harness = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<title>waiting landscape harness</title>
<link rel="stylesheet" href="file://${DIST}/assets/${cssName}">
</head>
<body>
<div id="root">
  <div class="game-viewport prefer-landscape">
    <div class="game-room is-waiting" style="height:100vh;overflow:hidden">
      <div class="game-table" style="position:relative;width:100%;height:100%">
        <div class="duel-scoreboard"><div class="duel-score-team is-leading"><span>我方</span><strong>2<em>级</em></strong></div><span class="duel-score-vs">VS</span><div class="duel-score-team is-trailing"><span>对方</span><strong>2<em>级</em></strong></div><div class="duel-score-meta">第 0 局 · 我方在台</div></div>
        <div class="game-top-actions">
          <div class="game-turn-status"><span class="game-turn-message">等待玩家加入</span></div>
          <button type="button" class="spectator-menu">观战 0</button>
          <div class="room-exit-actions">
            <button type="button" class="btn-secondary">邀请朋友</button>
            <button type="button" class="btn-secondary orientation-toggle" aria-pressed="true">竖屏</button>
            <button class="btn-danger"><span class="desktop-action-label">退出房间</span><span class="mobile-action-label">Exit</span></button>
            <button class="btn-secondary"><span class="desktop-action-label">退出登录</span><span class="mobile-action-label">Logout</span></button>
          </div>
        </div>
        <div class="game-center-play-area">
          <div class="waiting-seat-setup">
            <p class="waiting-seat-title">开局前排座</p>
            <p class="waiting-seat-help">点击一位玩家，再点击目标座位即可交换；开始后座位锁定。</p>
            <div class="waiting-seat-grid">
              <button type="button" class="waiting-seat"><span>座位 1 · 队伍 A</span><strong>我</strong><small>对家：座位 3</small></button>
              <button type="button" class="waiting-seat is-seat-empty"><span>座位 2 · 队伍 B</span><strong>空位</strong><small>对家：座位 4</small></button>
              <button type="button" class="waiting-seat is-seat-empty"><span>座位 3 · 队伍 A</span><strong>空位</strong><small>对家：座位 1</small></button>
              <button type="button" class="waiting-seat is-seat-empty"><span>座位 4 · 队伍 B</span><strong>空位</strong><small>对家：座位 2</small></button>
            </div>
            <button class="btn-primary waiting-start-button">开始牌局（自动补 AI）</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
window.addEventListener('load', () => {
  setTimeout(() => {
    const $ = s => document.querySelector(s);
    const table = $('.game-table');
    const panel = $('.game-center-play-area'), setup = $('.waiting-seat-setup');
    const start = $('.waiting-start-button'), grid = $('.waiting-seat-grid');
    const cs = getComputedStyle(setup);
    const out = {
      inner: [innerWidth, innerHeight],
      tableH: table.offsetHeight,
      setupMaxHeight: cs.maxHeight,
      setupW: setup.offsetWidth,
      setupH: setup.offsetHeight,
      setupScrollH: setup.scrollHeight,
      gridH: grid.offsetHeight,
      startH: start.offsetHeight,
      panelTop: panel.offsetTop,
      panelVisualTop: panel.offsetTop - setup.offsetHeight / 2,
      panelVisualBottom: panel.offsetTop + setup.offsetHeight / 2,
    };
    const pre = document.createElement('pre');
    pre.id = 'measure-out';
    pre.textContent = 'MEASURE:' + JSON.stringify(out);
    document.body.appendChild(pre);
  }, 100);
});
</script>
</body>
</html>`;
fs.writeFileSync(HARNESS, harness);

function cdp(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++cdp.id;
    const onMsg = (data) => {
      const msg = JSON.parse(data);
      if (msg.id === id) { ws.off('message', onMsg); msg.error ? reject(new Error(method + ': ' + JSON.stringify(msg.error))) : resolve(msg.result); }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
cdp.id = 0;

(async () => {
  const proc = execFile('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9223', 'about:blank']);
  await new Promise(r => setTimeout(r, 2500));
  const list = await fetch('http://127.0.0.1:9223/json/list').then(r => r.json());
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  await cdp(ws, 'Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: true });
  await cdp(ws, 'Page.enable');
  await cdp(ws, 'Page.navigate', { url: 'file://' + HARNESS });
  await new Promise(r => setTimeout(r, 1500));
  const result = await cdp(ws, 'Runtime.evaluate', { expression: `document.querySelector('#measure-out')?.textContent || 'NO MEASURE'`, returnByValue: true });
  console.log(result.result.value);
  ws.close();
  proc.kill('SIGKILL');
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
