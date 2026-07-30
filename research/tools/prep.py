"""يحضّر مخزناً واحداً لكل سنة: الشموع، ATR، ونتيجة الدخول عند كل شمعة.

    python3 research/tools/prep.py

يُنفّذ مرة واحدة. بعده كل نافذة اختبار تقرأ الملف الجاهز بدل إعادة حساب
النتائج الأمامية (٤٨٠ شمعة لكل شمعة) في كل مرة.
"""
import csv
import gzip
import os

import numpy as np

PU, TPM, SLR, MH = 0.1, 2.0, 1.3, 480
YEARS = (2021, 2023, 2025, 2026)


def rma(x, n):
    out = np.empty(len(x)); out[0] = x[0]
    a = 1. / n
    for i in range(1, len(x)):
        out[i] = a * x[i] + (1 - a) * out[i - 1]
    return out


def main():
    os.makedirs('research/data/prep', exist_ok=True)
    cols = {y: {k: [] for k in 'tohlcvs'} for y in YEARS}
    with gzip.open('research/data/vault_utc.csv.gz', 'rt') as f:
        for r in csv.DictReader(f):
            y = int(r['time'][:4])
            if y not in cols:
                continue
            d = cols[y]
            d['t'].append(r['time']); d['o'].append(float(r['open']))
            d['h'].append(float(r['high'])); d['l'].append(float(r['low']))
            d['c'].append(float(r['close'])); d['v'].append(float(r['volume']))
            d['s'].append(float(r['spread']))

    for y in YEARS:
        d = cols[y]
        o, h, l, c, v, sp = (np.array(d[k]) for k in 'ohlcvs')
        t = d['t']; n = len(c)
        pc = np.concatenate([[c[0]], c[:-1]])
        tr = np.maximum(h - l, np.maximum(abs(h - pc), abs(l - pc)))
        ap = rma(tr, 14) / PU

        rb = np.zeros(n, np.int8); rs = np.zeros(n, np.int8)
        bar_b = np.zeros(n, np.int16); bar_s = np.zeros(n, np.int16)
        tp = TPM * ap; sl = SLR * tp
        tpb, slb, tps, sls = c + tp * PU, c - sl * PU, c - tp * PU, c + sl * PU
        ar = np.arange(n)
        for k in range(1, MH + 1):
            j = ar + k; ok = j < n; jj = np.where(ok, j, n - 1)
            hj, lj = h[jj], l[jj]
            m = ok & (rb == 0); x = m & (lj <= slb); w = m & (hj >= tpb) & ~x
            rb[x] = -1; bar_b[x] = k; rb[w] = 1; bar_b[w] = k
            m = ok & (rs == 0); x = m & (hj >= sls); w = m & (lj <= tps) & ~x
            rs[x] = -1; bar_s[x] = k; rs[w] = 1; bar_s[w] = k

        day = np.array([x[:10] for x in t])
        hour = np.array([int(x[11:13]) for x in t], np.int8)
        minute = np.array([int(x[14:16]) for x in t], np.int8)
        _, day_idx = np.unique(day, return_inverse=True)
        np.savez_compressed(f'research/data/prep/{y}.npz', o=o, h=h, l=l, c=c, v=v, sp=sp,
                            atr=ap, rb=rb, rs=rs, bar_b=bar_b, bar_s=bar_s,
                            hour=hour, minute=minute, day_idx=day_idx,
                            ndays=len(set(day)))
        base_b = 100 * (rb[rb != 0] == 1).mean()
        base_s = 100 * (rs[rs != 0] == 1).mean()
        print(f'{y}: {n} شمعة • {len(set(day))} يوم • أساس شراء {base_b:.2f}% بيع {base_s:.2f}%')


if __name__ == '__main__':
    main()
