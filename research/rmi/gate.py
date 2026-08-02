"""بوابة: لا يُسمح بأي مسح قبل أن يطابق الماسح المحرك على الإعداد الافتراضي."""
import json
import numpy as np
import tune, rmi_py

DEF = dict(length=18, momentum=6, zone=(20.0, 80.0), reaction=2, wait=12, extreme=40)
ok = True
print("═══ بوابة الماسح مقابل محرك المنصة ═══")
for y in tune.YEARS:
    D = tune.load(y); P = tune.prep(D)
    b, s = tune.sig(D, P, DEF)
    d = json.load(open(f'probe_{y}.json'))
    eb = np.zeros(D['n'], bool); eb[d['bits']['rmiRawBuy']] = True
    es = np.zeros(D['n'], bool); es[d['bits']['rmiRawSell']] = True
    e = d['engine_internal']
    r = tune.simulate(D, b, s)
    sig_ok = (b != eb).sum() == 0 and (s != es).sum() == 0
    trd_ok = r['trades'] == e['trades'] and r['wins'] == e['wins'] and abs(r['net'] - e['net']) < 1
    ok &= sig_ok and trd_ok
    print(f"  {y}: إشارات {b.sum()}/{s.sum()} مقابل {eb.sum()}/{es.sum()} {'✓' if sig_ok else '✗'}"
          f"  •  صفقات {r['trades']}/{r['wins']}W/{r['net']:+.0f} مقابل "
          f"{e['trades']}/{e['wins']}W/{e['net']:+.0f} {'✓' if trd_ok else '✗'}")
raise SystemExit(0 if ok else "\n!! لا تطابق — المسح ممنوع.")
