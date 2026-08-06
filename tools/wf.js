// Walk-forward evaluation: a config counts as good only if it holds up in EVERY period.
const fs = require('fs'), path = require('path'), os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const S = __dirname;
const PERIODS = [
  ['P1 Jan-Feb', '2026-01-02T00:00:00Z', '2026-03-01T00:00:00Z'],
  ['P2 Mar-Apr', '2026-03-01T00:00:00Z', '2026-05-01T00:00:00Z'],
  ['P3 May-Jul', '2026-05-01T00:00:00Z', '2026-08-01T00:00:00Z'],
];

if (isMainThread) {
  const configs = JSON.parse(fs.readFileSync(path.join(S, process.env.WFCFG || 'wf_configs.json'), 'utf8'));
  const jobs = [];
  configs.forEach((c, ci) => PERIODS.forEach((p, pi) => jobs.push({ ci, pi, cfg: c })));
  const nT = Math.min(os.cpus().length, 4);
  const shards = Array.from({ length: nT }, () => []);
  jobs.forEach((j, i) => shards[i % nT].push(j));
  let done = 0; const out = [];
  console.log(`walk-forward: ${configs.length} configs x ${PERIODS.length} periods = ${jobs.length} runs`);
  shards.forEach(sh => {
    if (!sh.length) { if (++done === nT) fin(); return; }
    const w = new Worker(__filename, { workerData: { shard: sh } });
    w.on('message', m => { out.push(m); if (out.length % 20 === 0) process.stderr.write(`  ${out.length}/${jobs.length}\n`); });
    w.on('error', e => { console.error('worker', e.message); if (++done === nT) fin(); });
    w.on('exit', () => { if (++done === nT) fin(); });
  });
  function fin() {
    const byCfg = new Map();
    for (const r of out) {
      if (!byCfg.has(r.ci)) byCfg.set(r.ci, { cfg: r.cfg, per: {} });
      byCfg.get(r.ci).per[r.pi] = r.summary;
    }
    const rows = [...byCfg.values()].map(v => {
      const p = [0, 1, 2].map(i => v.per[i] || { trades: 0, win_rate: 0, net_points: 0 });
      const allPos = p.every(x => x.net_points > 0);
      const minWr = Math.min(...p.map(x => x.win_rate));
      return { cfg: v.cfg, p, allPos, minWr,
        totTrades: p.reduce((a, x) => a + x.trades, 0),
        totNet: p.reduce((a, x) => a + x.net_points, 0) };
    });
    rows.sort((a, b) => (b.allPos - a.allPos) || (b.minWr - a.minWr) || (b.totNet - a.totNet));
    console.log('\n' + '='.repeat(132));
    console.log('ROBUST  minWin%  trades   net    |  P1 tr/win%/net       P2 tr/win%/net       P3 tr/win%/net    | config');
    console.log('='.repeat(132));
    for (const r of rows.slice(0, 24)) {
      const f = x => `${String(x.trades).padStart(4)}/${x.win_rate.toFixed(1).padStart(5)}/${String(Math.round(x.net_points)).padStart(6)}`;
      console.log((r.allPos ? '  YES' : '   no').padEnd(7), r.minWr.toFixed(2).padStart(7),
        String(r.totTrades).padStart(7), String(Math.round(r.totNet)).padStart(7),
        '|', f(r.p[0]), ' ', f(r.p[1]), ' ', f(r.p[2]), '|', JSON.stringify(r.cfg));
    }
    fs.writeFileSync(path.join(S, 'wf_results.json'), JSON.stringify(rows, null, 1));
    console.log('\n-> wf_results.json');
  }
} else {
  const { loadRows, backtest } = require('./run.js');
  const source = fs.readFileSync(path.join(S, process.env.PINE || 'KAKASHI_FUSION_V3.pine'), 'utf8');
  for (const j of workerData.shard) {
    const [, from, to] = PERIODS[j.pi];
    const tEnd = Date.parse(to);
    const rows = loadRows(0, from).filter(r => r.time < tEnd);
    let res;
    try { res = backtest({ source, rows, inputs: j.cfg }); }
    catch (e) { res = { ok: false, error: e.message }; }
    parentPort.postMessage({ ci: j.ci, pi: j.pi, cfg: j.cfg,
      summary: res.ok ? res.summary : { trades: 0, win_rate: 0, net_points: -1e9 } });
  }
}
