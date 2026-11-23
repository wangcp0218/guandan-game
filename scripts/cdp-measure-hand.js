const WebSocket = require('/root/guandan-game/node_modules/ws');
const { execFile } = require('child_process');
const fs = require('fs');

const WIDTH = parseInt(process.argv[2] || '390', 10);
const HEIGHT = parseInt(process.argv[3] || '844', 10);
const MODE = process.argv[4] || 'phone'; // phone = forced-landscape rotation, desktop = native
const DIST = '/root/guandan-game/client/dist';
const HARNESS = '/tmp/hand-harness.html';

const cssMatch = fs.readFileSync(`${DIST}/index.html`, 'utf8').match(/index-[^"]*\.css/);
if (!cssMatch) throw new Error('built css not found in dist/index.html');
const cssName = cssMatch[0];

const card = (rank, suit, red) => `
  <div class="playing-card playing-card--hand" style="width: var(--hand-card-width); height: var(--hand-card-height); background: linear-gradient(145deg, #ffffff 0%, #f4f4f2 100%); cursor: pointer; color: ${red ? '#c52c22' : '#15131a'};">
    <div class="card-corner card-corner--hand"><span class="card-rank">${rank}</span><span class="card-corner-suit">${suit}</span></div>
    <div class="card-center"><span style="font-size: var(--hand-card-center-size)">${suit}</span></div>
  </div>`;

const slot = (i, inner) => `
  <div class="hand-card-slot" style="bottom: ${i === 0 ? '0px' : `calc(${Array.from({ length: i }, () => 'var(--hand-stack-rise)').join(' + ')})`}; z-index: ${4 - i};">${inner}</div>`;

const harness = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<title>hand stack harness</title>
<link rel="stylesheet" href="file://${DIST}/assets/${cssName}">
</head>
<body>
<div id="root">
  <div class="game-viewport${MODE === 'phone' ? ' prefer-landscape' : ''}">
    <div class="game-room" style="height:100vh;overflow:hidden">
      <div class="game-table" style="position:relative;width:100%;height:100%">
        <div class="game-bottom-area">
          <div class="hand-scroll">
            <div class="hand-cards" style="height: calc(var(--hand-card-height) + var(--hand-stack-rise) + var(--hand-stack-rise) + var(--hand-stack-rise))" aria-label="手牌，共 5 张">
              <div class="hand-card-group" style="z-index: 1; flex-basis: var(--hand-column-step); min-width: var(--hand-column-min);">
                ${slot(0, card('5', '♠', false))}
                ${slot(1, card('5', '♥', true))}
                ${slot(2, card('5', '♦', true))}
                ${slot(3, card('5', '♣', false))}
              </div>
              <div class="hand-card-group" style="z-index: 2; flex-basis: var(--hand-card-width); min-width: var(--hand-card-width);">
                ${slot(0, card('A', '♠', false))}
              </div>
            </div>
          </div>
          <div class="game-action-bar"><div class="game-play-actions"><button>出牌</button><button>过</button></div></div>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
window.addEventListener('load', () => {
  setTimeout(() => {
    const hand = document.querySelector('.hand-cards');
    const scroll = document.querySelector('.hand-scroll');
    const corner = document.querySelector('.card-corner--hand');
    const per = [...document.querySelectorAll('.hand-card-slot')].map(slot => {
      const cardEl = slot.querySelector('.playing-card');
      const rank = cardEl.querySelector('.card-rank');
      const suit = cardEl.querySelector('.card-corner-suit');
      return {
        rankFont: getComputedStyle(rank).fontSize,
        suitFont: getComputedStyle(suit).fontSize,
        rankVis: +(rank.offsetTop + rank.offsetHeight).toFixed(1),
        suitVis: +(suit.offsetTop + suit.offsetHeight).toFixed(1),
      };
    });
    const out = {
      inner: [innerWidth, innerHeight],
      rise: getComputedStyle(hand).getPropertyValue('--hand-stack-rise').trim(),
      cornerTop: getComputedStyle(corner).top,
      handH: hand.offsetHeight,
      scrollClientH: scroll.clientHeight,
      scrollScrollH: scroll.scrollHeight,
      per,
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
  const proc = execFile('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9224', 'about:blank']);
  await new Promise(r => setTimeout(r, 2500));
  const list = await fetch('http://127.0.0.1:9224/json/list').then(r => r.json());
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  await cdp(ws, 'Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: MODE === 'phone' });
  await cdp(ws, 'Page.enable');
  await cdp(ws, 'Page.navigate', { url: 'file://' + HARNESS });
  await new Promise(r => setTimeout(r, 1500));
  const result = await cdp(ws, 'Runtime.evaluate', { expression: `document.querySelector('#measure-out')?.textContent || 'NO MEASURE'`, returnByValue: true });
  console.log(result.result.value);
  ws.close();
  proc.kill('SIGKILL');
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
