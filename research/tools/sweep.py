import json, csv, datetime, bisect, sys

rows=list(csv.DictReader(open('vault.csv')))
ts=[datetime.datetime.fromisoformat(r['time']).timestamp() for r in rows]
H=[float(r['high']) for r in rows]; L=[float(r['low']) for r in rows]
def idx(t): return bisect.bisect_left(ts,t)

d=json.load(open(sys.argv[1] if len(sys.argv)>1 else 'june01_jul06.json'))
E=[t for t in d['trades'] if t['side'] in ('BUY','SELL') and (t.get('ep') or t.get('entry_price'))]
print('دخولات مُعاد محاكاتها:',len(E))

PU=0.1; MAXBARS=600   # حد أقصى لعمر الصفقة
def simulate(tp_pts, sl_pts):
    """يفتح نفس الدخولات بخطة خروج جديدة. عند لمس الهدف والوقف في نفس الشمعة يُحتسب خسارة (زي TradingView)."""
    w=l=o=0
    for t in E:
        i0=idx(datetime.datetime.fromisoformat(t['entry'].replace('Z','+00:00')).timestamp())
        buy = t['side']=='BUY'; ep=(t.get('ep') or t.get('entry_price'))
        tp = ep + (tp_pts*PU if buy else -tp_pts*PU)
        sl = ep - (sl_pts*PU if buy else -sl_pts*PU)
        done=False
        for i in range(i0+1, min(i0+1+MAXBARS, len(rows))):
            hi,lo=H[i],L[i]
            hitT = hi>=tp if buy else lo<=tp
            hitS = lo<=sl if buy else hi>=sl
            if hitS: l+=1; done=True; break      # الوقف له الأولوية عند التصادم
            if hitT: w+=1; done=True; break
        if not done: o+=1
    n=w+l
    if not n: return None
    wr=100*w/n; be=100*sl_pts/(tp_pts+sl_pts)
    net=w*tp_pts - l*sl_pts
    return dict(tp=tp_pts,sl=sl_pts,n=n,w=w,l=l,wr=wr,be=be,edge=wr-be,net=net,exp=net/n,open=o)

out=[]
for tp in (15,20,25,30,35,40,45,50,60):
    for sl in (30,40,50,60,70,80):
        r=simulate(tp,sl)
        if r: out.append(r)
json.dump(out, open('sweep_'+ (sys.argv[2] if len(sys.argv)>2 else 'jun') +'.json','w'))
print()
print('%5s %5s %6s %6s %7s %7s %8s %9s'%('هدف','وقف','عدد','فوز%','تعادل%','الحافة','الصافي','لكل صفقة'))
for r in sorted(out,key=lambda r:-r['net'])[:14]:
    print('%5d %5d %6d %5.1f%% %6.1f%% %+6.1f %8.0f %+8.2f'%(r['tp'],r['sl'],r['n'],r['wr'],r['be'],r['edge'],r['net'],r['exp']))
print(' ... الأسوأ:')
for r in sorted(out,key=lambda r:r['net'])[:3]:
    print('%5d %5d %6d %5.1f%% %6.1f%% %+6.1f %8.0f %+8.2f'%(r['tp'],r['sl'],r['n'],r['wr'],r['be'],r['edge'],r['net'],r['exp']))
