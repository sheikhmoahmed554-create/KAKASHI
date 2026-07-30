import json, csv, datetime, bisect, statistics as st, sys

# ---------- شموع ----------
R=list(csv.DictReader(open('vault.csv')))
TS=[datetime.datetime.fromisoformat(r['time']).timestamp() for r in R]
O=[float(r['open']) for r in R]; H=[float(r['high']) for r in R]
L=[float(r['low']) for r in R]; C=[float(r['close']) for r in R]
SP=[int(r['spread']) for r in R]
N=len(R)

TR=[0.0]*N
for i in range(1,N): TR[i]=max(H[i]-L[i], abs(H[i]-C[i-1]), abs(L[i]-C[i-1]))
def rma(src,n):
    out=[None]*N; a=None
    for i in range(n,N):
        a = sum(src[i-n+1:i+1])/n if a is None else (a*(n-1)+src[i])/n
        out[i]=a
    return out
ATR14=rma(TR,14); ATR60=rma(TR,60)

PU=0.1
def sim(i0, buy, ep, tp_pts, sl_pts, maxbars=600):
    tp = ep + (tp_pts*PU if buy else -tp_pts*PU)
    sl = ep - (sl_pts*PU if buy else -sl_pts*PU)
    for i in range(i0+1, min(i0+1+maxbars, N)):
        hitS = L[i]<=sl if buy else H[i]>=sl
        hitT = H[i]>=tp if buy else L[i]<=tp
        if hitS: return 0, i-i0          # الوقف أولا عند التصادم (زي TradingView)
        if hitT: return 1, i-i0
    return None, None

def build(path, tp_pts=30, sl_pts=50):
    d=json.load(open(path))
    out=[]
    for t in d['trades']:
        if t['side'] not in ('BUY','SELL'): continue
        ep = t.get('ep') or t.get('entry_price')
        if not ep: continue
        et = datetime.datetime.fromisoformat(t['entry'].replace('Z','+00:00'))
        i = bisect.bisect_left(TS, et.timestamp())
        if i<=60 or i>=N-2 or ATR60[i] is None: continue
        buy = t['side']=='BUY'
        res, bars = sim(i, buy, ep, tp_pts, sl_pts)
        if res is None: continue
        w60=slice(i-59,i+1)
        hi=max(H[w60]); lo=min(L[w60]); rng=max(hi-lo,1e-9)
        rngpos = (ep-lo)/rng*100                      # موضع الدخول داخل مدى الساعة
        out.append(dict(
            win=res, bars=bars, side=t['side'], src=t.get('src'), kind=t.get('kind'),
            hour=et.hour, dow=et.weekday(), date=t['entry'][:10],
            atr=ATR14[i]/PU, atr_ratio=ATR14[i]/ATR60[i],
            rngpos = rngpos if buy else 100-rngpos,   # 0 = دخول عند الطرف المؤيد
            mom=(C[i]-C[i-15])/PU * (1 if buy else -1),
            body=abs(C[i]-O[i])/max(H[i]-L[i],1e-9),
            spread=SP[i], plan_tp=t.get('target'), plan_sl=t.get('stop')))
    return out

def wr(g):
    n=len(g); return (n, sum(x['win'] for x in g), 100*sum(x['win'] for x in g)/n if n else 0)

def table(rows, key, buckets=None, label=''):
    print('\n── %s ──'%(label or key))
    if buckets:
        groups=[]
        for lo,hi in buckets:
            g=[x for x in rows if lo<=x[key]<hi]
            if len(g)>=25: groups.append(('%g–%g'%(lo,hi), g))
    else:
        vals=sorted(set(x[key] for x in rows))
        groups=[(str(v),[x for x in rows if x[key]==v]) for v in vals]
        groups=[(k,g) for k,g in groups if len(g)>=25]
    for k,g in groups:
        n,w,p=wr(g)
        print('  %-12s %5d صفقة  فوز %5.1f%%  %s'%(k,n,p,'█'*int(p/2.5)))

if __name__=='__main__':
    path=sys.argv[1] if len(sys.argv)>1 else 'june01_jul06.json'
    rows=build(path)
    json.dump(rows, open(path.replace('.json','_feat.json'),'w'))
    n,w,p=wr(rows)
    print('=== %s | خطة TP30/SL50 على كل الدخولات ==='%path)
    print('%d صفقة • %d فوز • نسبة %.1f%% • التعادل 62.5%%'%(n,w,p))
    table(rows,'src'); table(rows,'side'); table(rows,'hour')
    table(rows,'atr',[(0,3),(3,5),(5,8),(8,12),(12,20),(20,100)],'ATR14 (نقاط)')
    table(rows,'atr_ratio',[(0,.7),(.7,.9),(.9,1.1),(1.1,1.5),(1.5,9)],'ATR14/ATR60 — حِدّة التقلب')
    table(rows,'rngpos',[(0,20),(20,40),(40,60),(60,80),(80,101)],'موضع الدخول في مدى الساعة (0=طرف مؤيد)')
    table(rows,'mom',[(-999,-20),(-20,-5),(-5,5),(5,20),(20,999)],'زخم 15 شمعة في اتجاه الصفقة')
    table(rows,'body',[(0,.2),(.2,.4),(.4,.6),(.6,1.01)],'جسم شمعة الدخول ÷ مداها')
