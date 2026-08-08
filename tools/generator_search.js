'use strict';
/*
 * Searching for rare, precise generators — and measuring the search itself.
 *
 * A generator here is a fully specified rule:
 *
 *     stream (family x timeframe)  x  reaction (rejection / break)
 *       x  direction (follow / fade)  x  up to two context conditions
 *       x  target size R  x  hold limit,      with TP = SL = R
 *
 * Roughly half a million are expressible. The idea under test is to find the
 * few dozen that win seventy to eighty percent of the time while firing rarely,
 * and run them together. The arithmetic is sound: at one-to-one the breakeven
 * is 50%, so 70% earns 0.4R a trade, and forty generators at one trade a day
 * each recovers the sample size that rarity gave away — PROVIDED the generators
 * are independent and the win rates are real.
 *
 * ── WHY THE NULL CONTROL IS THE MAIN RESULT ─────────────────────────────────
 *
 * Search half a million rules with twenty-five trades each and thousands read
 * 75% in-sample from nothing but the searching. That is not a risk to hedge, it
 * is the default outcome, and testing the WINNER out of sample does not fix it
 * — the winner was chosen by looking, so the looking is what has to be tested.
 *
 * So the entire procedure runs twice. Once on real events. Once on events whose
 * outcomes have been shuffled among rows inside the same month, which preserves
 * every generator's trade count, its timing, and that month's own baseline win
 * rate, and destroys only the link between WHICH rows a rule selects and HOW
 * they turn out. Structure that survives the shuffle is structure the search
 * invented.
 *
 * The number that matters is not the portfolio's out-of-sample win rate. It is
 * the gap between that and the shuffled portfolio's, through the same search.
 *
 * ── THE SWEEP ───────────────────────────────────────────────────────────────
 *
 * A single configuration answers nothing, because the failure mode is a
 * property of the search, not of the data. So the run varies the four knobs
 * that control how much rope the search is given:
 *
 *   minTrain   how many training trades a rule must have to be eligible. The
 *              whole bias lives here: 20 trades has a 9-point standard error on
 *              its win rate, 200 has under 4.
 *   maxCond    0 = no context conditions, 1 = singles, 2 = pairs. Each step
 *              multiplies the candidate count by an order of magnitude.
 *   rule       raw win rate / Wilson lower bound / month-by-month stability.
 *   topN       how many generators the portfolio holds.
 *
 * If the idea works, there is a corner of that space where the real result
 * pulls clear of the shuffled one. If there is no such corner, the idea does
 * not work on this data and the honest thing is to say which knob it died on.
 *
 * Usage: node tools/generator_search.js --sweep [--shuffles 8]
 *        node tools/generator_search.js --min 100 --cond 1 --rule wilson --top 30
 */
const GL = require('./generator_library');

const args = process.argv.slice(2);
const has = k => args.includes(k);
const argOf = (k, d) => { const i = args.indexOf(k); return i > -1 && args[i + 1] ? args[i + 1] : d; };
const SHUFFLES = +argOf('--shuffles', 8);
const MAX_PER_STREAM = 2;
const MAX_PER_FAMILY = 4;

const T = GL.load();
const ROWS = T.rows;
const K = ROWS.length;
const { R_GRID, HOLD_GRID, COST } = T.meta;
const famOf = new Map(T.streams.map(s => [s.sid, s.family]));
const tfOf = new Map(T.streams.map(s => [s.sid, s.tf]));

// ── outcomes, direction-free ────────────────────────────────────────────────
// rawPts[r][h][k] is what a LONG at row k collects before cost; a short collects
// its negative. Rows where both barriers landed on one candle are dropped —
// candle data cannot order them, and guessing flatters or damns by turns.
const rawPts = [], valid = [];
for (let r = 0; r < R_GRID.length; r++) {
  rawPts.push([]); valid.push([]);
  for (let h = 0; h < HOLD_GRID.length; h++) {
    const p = new Float32Array(K), v = new Uint8Array(K);
    const R = R_GRID[r], H = HOLD_GRID[h];
    for (let k = 0; k < K; k++) {
      const i = ROWS[k].i;
      const u = T.upBar[r][k], d = T.dnBar[r][k];
      const uOK = u >= 0 && u - i <= H, dOK = d >= 0 && d - i <= H;
      if (uOK && dOK && u === d) { v[k] = 0; continue; }
      v[k] = 1;
      p[k] = uOK && (!dOK || u < d) ? R : dOK && (!uOK || d < u) ? -R : T.timeClose[h][k];
    }
    rawPts[r].push(p); valid[r].push(v);
  }
}

// ── conditions ──────────────────────────────────────────────────────────────
const CONDS = [
  { name: 'آسيا',         f: r => r.hour >= 0 && r.hour < 7 },
  { name: 'لندن',         f: r => r.hour >= 7 && r.hour < 13 },
  { name: 'نيويورك',      f: r => r.hour >= 13 && r.hour < 21 },
  { name: 'تذبذب منخفض',  f: r => r.atrPct < 33 },
  { name: 'تذبذب متوسط',  f: r => r.atrPct >= 33 && r.atrPct < 66 },
  { name: 'تذبذب عالي',   f: r => r.atrPct >= 66 },
  { name: 'مع اتجاه 4س',  f: (r, d) => Number.isFinite(r.htf) && Math.sign(r.htf) === d },
  { name: 'ضد اتجاه 4س',  f: (r, d) => Number.isFinite(r.htf) && Math.sign(r.htf) === -d },
  { name: 'اتجاه قوي',    f: r => Math.abs(r.htf) >= 2 },
  { name: 'اتجاه هادئ',   f: r => Math.abs(r.htf) < 1 },
  { name: 'مع الزخم',     f: (r, d) => Number.isFinite(r.mom) && Math.sign(r.mom) === d },
  { name: 'ضد الزخم',     f: (r, d) => Number.isFinite(r.mom) && Math.sign(r.mom) === -d },
  { name: 'زخم هادئ',     f: r => Math.abs(r.mom) < 0.5 },
  { name: 'لمسة أولى',    f: r => r.touch === 1 },
  { name: 'لمسة ثانية+',  f: r => r.touch >= 2 },
  { name: 'لمسة ثالثة+',  f: r => r.touch >= 3 },
  { name: 'ملامسة دقيقة', f: r => r.dist < 0.4 },
  { name: 'ابتعاد عميق',  f: r => r.travel >= 3 },
  { name: 'أسفل المدى',   f: r => r.rangePos < 0.33 },
  { name: 'أعلى المدى',   f: r => r.rangePos > 0.67 },
  { name: 'وسط الأسبوع',  f: r => r.dow >= 2 && r.dow <= 4 },
];
const NC = CONDS.length;

const maskPos = new Uint32Array(K), maskNeg = new Uint32Array(K);
for (let k = 0; k < K; k++) {
  const r = ROWS[k];
  let mp = 0, mn = 0;
  for (let c = 0; c < NC; c++) {
    if (CONDS[c].f(r, 1)) mp |= (1 << c);
    if (CONDS[c].f(r, -1)) mn |= (1 << c);
  }
  maskPos[k] = mp; maskNeg[k] = mn;
}
const CONDSETS_BY_DEPTH = [[{ bits: 0, label: '—' }]];
CONDSETS_BY_DEPTH.push(CONDSETS_BY_DEPTH[0].concat(
  Array.from({ length: NC }, (_, a) => ({ bits: 1 << a, label: CONDS[a].name }))));
{
  const pairs = [];
  for (let a = 0; a < NC; a++) for (let b = a + 1; b < NC; b++)
    pairs.push({ bits: (1 << a) | (1 << b), label: `${CONDS[a].name} + ${CONDS[b].name}` });
  CONDSETS_BY_DEPTH.push(CONDSETS_BY_DEPTH[1].concat(pairs));
}

// ── rows grouped by (stream, reaction) ──────────────────────────────────────
const groups = new Map();
for (let k = 0; k < K; k++) {
  const g = `${ROWS[k].sid}|${ROWS[k].kind}`;
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(k);
}
const monthOf = ROWS.map(r => new Date(r.t).toISOString().slice(0, 7));
const MONTHS = [...new Set(monthOf)].sort();
const monthIdx = new Int8Array(K);
for (let k = 0; k < K; k++) monthIdx[k] = MONTHS.indexOf(monthOf[k]);
const FIRST_TEST = 2;

// ── scoring ─────────────────────────────────────────────────────────────────
function wilsonLower(w, n, z = 1.2816) {
  if (!n) return 0;
  const p = w / n, z2 = z * z;
  const den = 1 + z2 / n;
  return ((p + z2 / (2 * n)) - z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / den;
}

function score(rowIdx, bits, dirSign, r, h, mLo, mHi, pts, wantMonths) {
  const P = pts[r][h], V = valid[r][h];
  let n = 0, w = 0, net = 0;
  const per = wantMonths ? new Map() : null;
  for (const k of rowIdx) {
    const m = monthIdx[k];
    if (m < mLo || m >= mHi || !V[k]) continue;
    const d = ROWS[k].dir * dirSign;
    if (((d === 1 ? maskPos[k] : maskNeg[k]) & bits) !== bits) continue;
    const p = P[k] * d - COST;
    n++; net += p; if (p > 0) w++;
    if (per) {
      let e = per.get(m); if (!e) { e = { n: 0, w: 0 }; per.set(m, e); }
      e.n++; if (p > 0) e.w++;
    }
  }
  return { n, w, net, wr: n ? w / n : 0, per: n ? net / n : 0, months: per };
}

/**
 * The whole selection for one test month, on one outcome table. `pts` is either
 * the real outcomes or a shuffled copy; the procedure cannot tell, which is the
 * point of having it.
 */
function selectAndTrade(testM, cfg, pts) {
  const CONDSETS = CONDSETS_BY_DEPTH[cfg.maxCond];
  const wantMonths = cfg.rule === 'stable';
  const cands = [];
  for (const [g, rowIdx] of groups) {
    const sid = +g.split('|')[0];
    for (const dirSign of [1, -1]) {
      for (let r = 0; r < R_GRID.length; r++) {
        for (let h = 0; h < HOLD_GRID.length; h++) {
          for (const cs of CONDSETS) {
            const s = score(rowIdx, cs.bits, dirSign, r, h, 0, testM, pts, wantMonths);
            if (s.n < cfg.minTrain) continue;
            let key;
            if (cfg.rule === 'raw') key = s.wr;
            else if (cfg.rule === 'wilson') key = wilsonLower(s.w, s.n);
            else {
              // Stability: a rule that only works in some months does not work.
              // Score it by its WORST month that carried enough trades to mean
              // anything, then break ties on the pooled Wilson bound.
              let worst = 1;
              for (const e of s.months.values()) if (e.n >= 5) worst = Math.min(worst, e.w / e.n);
              key = worst + wilsonLower(s.w, s.n) / 1000;
            }
            cands.push({ g, sid, rowIdx, bits: cs.bits, label: cs.label, dirSign, r, h, key, train: s });
          }
        }
      }
    }
  }
  cands.sort((a, b) => b.key - a.key);

  const chosen = [];
  const perStream = new Map(), perFam = new Map(), seenRule = new Set();
  for (const c of cands) {
    if (chosen.length >= cfg.topN) break;
    // The same entry rule with a different hold limit is not a second bet.
    const ruleKey = `${c.g}|${c.dirSign}|${c.bits}|${c.r}`;
    if (seenRule.has(ruleKey)) continue;
    const fam = famOf.get(c.sid);
    if ((perStream.get(c.sid) || 0) >= MAX_PER_STREAM) continue;
    if ((perFam.get(fam) || 0) >= MAX_PER_FAMILY) continue;
    seenRule.add(ruleKey);
    perStream.set(c.sid, (perStream.get(c.sid) || 0) + 1);
    perFam.set(fam, (perFam.get(fam) || 0) + 1);
    chosen.push(c);
  }

  let n = 0, w = 0, net = 0;
  const perGen = [];
  for (const c of chosen) {
    const s = score(c.rowIdx, c.bits, c.dirSign, c.r, c.h, testM, testM + 1, pts, false);
    n += s.n; w += s.w; net += s.net;
    perGen.push({ c, test: s });
  }
  return { chosen, perGen, n, w, net, wr: n ? w / n : 0 };
}

// ── shuffled outcomes ───────────────────────────────────────────────────────
function rng(seed) {
  let s = seed | 0;
  return () => { s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function shuffledPts(seed) {
  const rand = rng(seed);
  const byMonth = new Map();
  for (let k = 0; k < K; k++) {
    if (!byMonth.has(monthIdx[k])) byMonth.set(monthIdx[k], []);
    byMonth.get(monthIdx[k]).push(k);
  }
  const out = [];
  for (let r = 0; r < R_GRID.length; r++) {
    out.push([]);
    for (let h = 0; h < HOLD_GRID.length; h++) {
      const src = rawPts[r][h], dst = new Float32Array(K);
      for (const idxs of byMonth.values()) {
        const perm = idxs.slice();
        for (let x = perm.length - 1; x > 0; x--) { const y = Math.floor(rand() * (x + 1)); const t2 = perm[x]; perm[x] = perm[y]; perm[y] = t2; }
        for (let x = 0; x < idxs.length; x++) dst[idxs[x]] = src[perm[x]];
      }
      out[r].push(dst);
    }
  }
  return out;
}

const SHUFFLE_CACHE = [];
function getShuffle(s) {
  if (!SHUFFLE_CACHE[s]) SHUFFLE_CACHE[s] = shuffledPts(1000 + s * 7919);
  return SHUFFLE_CACHE[s];
}

// ── one configuration, end to end ───────────────────────────────────────────
function runConfig(cfg, shuffles) {
  let n = 0, w = 0, net = 0;
  const folds = [];
  for (let m = FIRST_TEST; m < MONTHS.length; m++) {
    const res = selectAndTrade(m, cfg, rawPts);
    n += res.n; w += res.w; net += res.net;
    folds.push(res);
  }
  const realWR = n ? 100 * w / n : NaN;
  const nulls = [];
  for (let s = 0; s < shuffles; s++) {
    const pts = getShuffle(s);
    let nn = 0, nw = 0;
    for (let m = FIRST_TEST; m < MONTHS.length; m++) {
      const res = selectAndTrade(m, cfg, pts);
      nn += res.n; nw += res.w;
    }
    if (nn) nulls.push(100 * nw / nn);
  }
  nulls.sort((a, b) => a - b);
  const nm = nulls.length ? nulls.reduce((a, x) => a + x, 0) / nulls.length : NaN;
  const nsd = nulls.length > 1 ? Math.sqrt(nulls.reduce((a, x) => a + (x - nm) ** 2, 0) / (nulls.length - 1)) : NaN;
  const trainWR = folds.length
    ? 100 * folds.reduce((a, f2) => a + f2.chosen.reduce((b, c) => b + c.train.wr, 0), 0)
        / Math.max(1, folds.reduce((a, f2) => a + f2.chosen.length, 0)) : NaN;
  return { cfg, n, w, net, realWR, trainWR, nm, nsd, beat: nulls.filter(x => x >= realWR).length, nulls, folds };
}

// ── run ─────────────────────────────────────────────────────────────────────
const f = (x, d = 2) => Number.isFinite(x) ? x.toFixed(d) : '—';
const DAYS = 197 * (MONTHS.length - FIRST_TEST) / MONTHS.length;

console.log(`المكتبة: ${K} حدث، ${T.streams.length} مجرى`);
console.log(`مساحة البحث: بلا شروط ${(groups.size * 2 * 4 * 2 * CONDSETS_BY_DEPTH[0].length).toLocaleString('en')}` +
            `   شرط واحد ${(groups.size * 2 * 4 * 2 * CONDSETS_BY_DEPTH[1].length).toLocaleString('en')}` +
            `   شرطان ${(groups.size * 2 * 4 * 2 * CONDSETS_BY_DEPTH[2].length).toLocaleString('en')}`);
console.log(`الاختبار الأمامي: ${MONTHS.slice(FIRST_TEST).join(', ')}   ضبط عشوائي ${SHUFFLES} خلطة لكل إعداد\n`);

if (has('--sweep') || has('--sweep2')) {
  const SWEEP = [];
  if (has('--sweep2')) {
    // The first sweep showed the result improving monotonically with the
    // minimum training count, right up to the edge of the grid. Push past it —
    // an effect that keeps growing as the eligibility bar rises is an effect
    // that was being buried by small-sample noise, and one that stops growing
    // has been found.
    for (const minTrain of [200, 400, 800, 1600, 3200]) SWEEP.push({ minTrain, maxCond: 2, rule: 'wilson', topN: 40 });
    for (const topN of [10, 20, 80]) SWEEP.push({ minTrain: 800, maxCond: 2, rule: 'wilson', topN });
    for (const maxCond of [0, 1]) SWEEP.push({ minTrain: 800, maxCond, rule: 'wilson', topN: 40 });
    SWEEP.push({ minTrain: 800, maxCond: 2, rule: 'raw', topN: 40 });
    SWEEP.push({ minTrain: 800, maxCond: 2, rule: 'stable', topN: 40 });
  } else {
    for (const minTrain of [20, 50, 100, 200]) SWEEP.push({ minTrain, maxCond: 2, rule: 'wilson', topN: 40 });
    for (const maxCond of [0, 1]) SWEEP.push({ minTrain: 100, maxCond, rule: 'wilson', topN: 40 });
    for (const rule of ['raw', 'stable']) SWEEP.push({ minTrain: 100, maxCond: 2, rule, topN: 40 });
    for (const topN of [10, 60]) SWEEP.push({ minTrain: 100, maxCond: 2, rule: 'wilson', topN });
  }

  console.log('حد أدنى  شروط  قاعدة   عدد   |  تدريب   خارج العيّنة        صافي  ص/يوم  |  العشوائي        الفارق   خلطات تفوّقت');
  console.log('─'.repeat(120));
  const out = [];
  for (const cfg of SWEEP) {
    const r = runConfig(cfg, SHUFFLES);
    out.push(r);
    const sd = Number.isFinite(r.nsd) && r.nsd > 0 ? (r.realWR - r.nm) / r.nsd : NaN;
    console.log(
      `${String(cfg.minTrain).padStart(7)}  ${String(cfg.maxCond).padStart(5)}  ${cfg.rule.padEnd(6)} ${String(cfg.topN).padStart(4)}   |` +
      ` ${f(r.trainWR, 1).padStart(5)}%  ${f(r.realWR, 1).padStart(5)}% (${String(r.n).padStart(5)})  ${((r.net > 0 ? '+' : '') + f(r.net, 0)).padStart(7)} ${f(r.n / DAYS, 0).padStart(5)}  |` +
      ` ${f(r.nm, 1).padStart(5)}%±${f(r.nsd, 1)}  ${f(r.realWR - r.nm, 2).padStart(6)}pp ${f(sd, 2).padStart(6)}σ  ${r.beat}/${SHUFFLES}`);
  }
  console.log('\nالعمود الأخير هو الحكم: كم خلطة عشوائية بلغت النتيجة الحقيقية أو تجاوزتها.');
  console.log('صفر من الخلطات يعني أن هناك شيئًا حقيقيًا. واحدة أو أكثر تعني أن البحث وحده يفسّرها.');

  const best = out.slice().sort((a, b) => (b.realWR - b.nm) - (a.realWR - a.nm))[0];
  console.log(`\nأفضل إعداد بالفارق عن العشوائي: حد ${best.cfg.minTrain}، شروط ${best.cfg.maxCond}، ${best.cfg.rule}، ${best.cfg.topN} مولّد` +
              `  →  ${f(best.realWR, 1)}% مقابل ${f(best.nm, 1)}%   ${best.beat}/${SHUFFLES} خلطة تفوّقت`);
  module.exports = { sweep: out };
} else {
  const cfg = { minTrain: +argOf('--min', 100), maxCond: +argOf('--cond', 2), rule: argOf('--rule', 'wilson'), topN: +argOf('--top', 40) };
  const r = runConfig(cfg, SHUFFLES);
  console.log(`حد ${cfg.minTrain} صفقة تدريب، ${cfg.maxCond} شرط، قاعدة ${cfg.rule}، ${cfg.topN} مولّد\n`);
  for (let m = FIRST_TEST; m < MONTHS.length; m++) {
    const fo = r.folds[m - FIRST_TEST];
    console.log(`${MONTHS[m]}   ${fo.chosen.length} مولّد   ${String(fo.n).padStart(4)} صفقة   نسبة ${f(100 * fo.wr, 1).padStart(5)}%   صافي ${((fo.net > 0 ? '+' : '') + f(fo.net, 0)).padStart(7)}`);
  }
  console.log(`\nخارج العيّنة: ${r.n} صفقة   ${f(r.realWR, 1)}%   صافي ${(r.net > 0 ? '+' : '') + f(r.net, 0)}   ${f(r.n / DAYS, 1)} صفقة/يوم`);
  console.log(`نسبة التدريب المتوسطة للمختارين: ${f(r.trainWR, 1)}%`);
  console.log(`العشوائي: ${f(r.nm, 1)}% ± ${f(r.nsd, 2)}   الفارق ${f(r.realWR - r.nm, 2)}pp   ${r.beat}/${SHUFFLES} خلطة بلغته`);

  const last = r.folds[r.folds.length - 1];
  console.log(`\nمولّدات آخر طيّة:`);
  for (const { c, test } of last.perGen.slice().sort((a, b) => b.train.wr - a.train.wr)) {
    const kind = ROWS[c.rowIdx[0]].kind === 0 ? 'ارتداد' : 'كسر';
    const name = `${famOf.get(c.sid)}@${tfOf.get(c.sid)}m ${kind}/${c.dirSign === 1 ? 'اتباع' : 'عكس'}`;
    console.log(`  ${name.padEnd(30)} ${String(R_GRID[c.r]).padStart(3)}pt  ${c.label.padEnd(26)}  تدريب ${f(100 * c.train.wr, 1).padStart(5)}% (${String(c.train.n).padStart(4)})  اختبار ${test.n ? f(100 * test.wr, 1).padStart(5) + '% (' + test.n + ')' : '—'}`);
  }
  module.exports = { result: r };
}
