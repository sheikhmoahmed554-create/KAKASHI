// KAKASHI headless backtest harness — replicates the V16 web worker in Node.
const fs = require('fs');
const path = require('path');

const S = __dirname;
const coreText = fs.readFileSync(path.join(S, 'core_v16.js'), 'utf8');
(0, eval)(coreText);
const PineLabJS = globalThis.PineLabJS;
if (!PineLabJS) throw new Error('PineLabJS did not load');

const OUTPUTS = ['wins','losses','trades','netPts','maxWin','maxLoss','sumWinPts','sumLossPts','lastClosedPts',
  'trendVoteLiveWins','trendVoteLiveLosses','finalFusionLiveWins','finalFusionLiveLosses','m1LiveM1Wins','m1LiveM1Losses',
  'm1LiveOwnTrades','m1LiveSameTrades','m1LiveTakeTrades','trendVoteLiveTrades','finalFusionLiveTrades','statsActive',
  'active','side','entryPrice','tpPrice','slPrice','tradeTargetPts','tradeStopPts','tradeEntrySource','tradeEntrySourceCode',
  'tradeKind','sy348EntryBuyPlot','sy348EntrySellPlot','sy348ExitTPPlot','sy348ExitSLPlot','skipTrade','isWin','isLoss',
  'hardExit','canEnterLong','canEnterShort','tradeDecisionSide','pointUnit'];

let CSV_CACHE = null;
function loadRows(limit, fromISO) {
  if (!CSV_CACHE) {
    const raw = fs.readFileSync(path.join(S, 'xauusd_m1_2026.csv'), 'utf8');
    const lines = raw.split('\n');
    const out = [];
    for (let i = 1; i < lines.length; i++) {
      const L = lines[i];
      if (!L) continue;
      const c = L.split(',');
      if (c.length < 5) continue;
      const t = Date.parse(c[0].replace(' ', 'T'));
      if (!Number.isFinite(t)) continue;
      out.push({ time: t, open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +(c[5] || 0), spread: +(c[6] || 0) });
    }
    CSV_CACHE = out;
  }
  let rows = CSV_CACHE;
  if (fromISO) { const f = Date.parse(fromISO); rows = rows.filter(r => r.time >= f); }
  if (limit) rows = rows.slice(0, limit);
  return rows;
}

function backtest({ source, rows, statsStartTime, inputs = {}, lot = 0.02, dpp = 20 }) {
  const overrides = { ...inputs, statsMode: 'From Custom Time',
    statsStartTime: statsStartTime != null ? statsStartTime : (rows.length ? rows[0].time : 0),
    sameCandleRule: 'Skip', sy963LotSize: lot };
  const t0 = Date.now();
  const engine = new PineLabJS.PineEngine(source, overrides);
  const r = engine.run(rows, OUTPUTS, true);
  if (r.diagnostics && r.diagnostics.length) {
    return { ok: false, error: r.diagnostics[0].error, diagnostics: r.diagnostics.slice(0, 5) };
  }
  const S_ = n => r.series[n] || [];
  const N = x => Number.isFinite(Number(x)) ? Number(x) : null;
  const B = x => Boolean(x);
  const events = [];
  let current = null;
  for (let i = 0; i < r.bars; i++) {
    const row = rows[i];
    const stats = B(S_('statsActive')[i]);
    const eb = B(S_('sy348EntryBuyPlot')[i]), es = B(S_('sy348EntrySellPlot')[i]);
    if (stats && (eb || es)) current = {
      entry_time: new Date(row.time).toISOString(), side: eb ? 'BUY' : 'SELL',
      entry_price: N(S_('entryPrice')[i]), tp: N(S_('tpPrice')[i]), sl: N(S_('slPrice')[i]),
      target_points: N(S_('tradeTargetPts')[i]), stop_points: N(S_('tradeStopPts')[i]),
      point_unit: N(S_('pointUnit')[i]) || 0.1, source: S_('tradeEntrySource')[i] || 'PINE',
    };
    const skip = B(S_('skipTrade')[i]), tp = B(S_('sy348ExitTPPlot')[i]), sl = B(S_('sy348ExitSLPlot')[i]);
    if (stats && (skip || tp || sl)) {
      const q = current ? { ...current } : { entry_time: 'PRE-START', side: '—', entry_price: null, tp: null, sl: null,
        target_points: N(S_('tradeTargetPts')[i]), stop_points: N(S_('tradeStopPts')[i]), point_unit: 0.1, source: 'PRE-START' };
      q.exit_time = new Date(row.time).toISOString();
      q.outcome = skip ? 'SKIP' : tp ? 'WIN' : 'LOSS';
      q.points = skip ? 0 : tp ? q.target_points : (q.stop_points == null ? null : -q.stop_points);
      q.exit_price = tp ? q.tp : sl ? q.sl : row.close;
      events.push(q); current = null;
    }
  }
  const last = Math.max(0, r.bars - 1);
  const val = k => N(S_(k)[last]) || 0;
  const summary = {
    trades: val('trades'), wins: val('wins'), losses: val('losses'),
    win_rate: val('trades') ? 100 * val('wins') / val('trades') : 0,
    net_points: val('netPts'), net_dollars: Math.round(val('netPts') * lot * dpp * 100) / 100,
    max_win_streak: val('maxWin'), max_loss_streak: val('maxLoss'),
    avg_target_points: val('wins') ? val('sumWinPts') / val('wins') : 0,
    avg_stop_points: val('losses') ? val('sumLossPts') / val('losses') : 0,
  };
  return { ok: true, bars: r.bars, seconds: (Date.now() - t0) / 1000, summary,
    trades: events.filter(e => e.outcome !== 'SKIP'), skips: events.filter(e => e.outcome === 'SKIP').length };
}

module.exports = { loadRows, backtest, PineLabJS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const srcFile = args[0];
  const limit = args[1] ? parseInt(args[1], 10) : 0;
  const fromISO = args[2] || null;
  const source = fs.readFileSync(srcFile, 'utf8');
  const rows = loadRows(limit, fromISO);
  console.log(`bars loaded: ${rows.length}  (${new Date(rows[0].time).toISOString()} → ${new Date(rows[rows.length-1].time).toISOString()})`);
  const res = backtest({ source, rows });
  if (!res.ok) { console.error('ENGINE ERROR:', res.error); console.error(JSON.stringify(res.diagnostics, null, 1)); process.exit(1); }
  console.log(`ran ${res.bars} bars in ${res.seconds}s`);
  console.log('SUMMARY:', JSON.stringify(res.summary, null, 1));
  console.log(`trades: ${res.trades.length}  skips: ${res.skips}`);
  for (const t of res.trades.slice(0, 15)) {
    console.log(` ${t.entry_time}  ${t.side}  @${t.entry_price}  tp=${t.tp} sl=${t.sl}  → ${t.outcome} ${t.points}pts`);
  }
}
