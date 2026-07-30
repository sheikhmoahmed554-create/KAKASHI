"""الهجين: دخولات المعمل (80.9%) + منطق الخروج بتاع SYR30 (وقف من البنية، هدف من السيولة).

خطة SYR30 المستخرجة من f_sy999_current_plan:
  الوقف  = المسافة لأقرب قاع/قمة خلال lookback + هامش (ثابت + ATR×معامل)
  الهدف  = مقيّد بنطاق R:R من الوقف، ويُفضَّل أقرب مستوى سيولة
مقارنة بالخطط الثابتة التي تستخدمها قواعد المعمل حالياً."""
import numpy as np, json, methods, lab
PU=lab.PU; MAXBARS=30
D=lab.load(); _,F=methods.all_features(D)
n=D['n']; o,h,l,c=D['o'],D['h'],D['l'],D['c']
valid=(D['hour']<22)&(~D['gap']); split=int(n*0.6)
d_tr=len(set((D['t'][:split][valid[:split]]//86400).astype(int)))
d_te=len(set((D['t'][split:][valid[split:]]//86400).astype(int)))
ATR=np.maximum(F['atr14'],1e-9)

def roll_min(x,w):
    from numpy.lib.stride_tricks import sliding_window_view
    out=np.full_like(x,np.nan); out[w-1:]=sliding_window_view(x,w).min(1); return out
def roll_max(x,w):
    from numpy.lib.stride_tricks import sliding_window_view
    out=np.full_like(x,np.nan); out[w-1:]=sliding_window_view(x,w).max(1); return out

# بنية الوقف: أقرب قاع/قمة خلال lookback (افتراضي SYR30 = 8)
LB=8
LOW8=np.nan_to_num(roll_min(l,LB),nan=l[0]); HIGH8=np.nan_to_num(roll_max(h,LB),nan=h[0])

def plan_syr30(i, buy, buf_fixed=5.0, buf_atr=0.5, minRR=0.6, maxRR=1.2,
               lo_s=20.0, hi_s=60.0, lo_t=30.0, hi_t=60.0):
    """يحاكي منطق SYR30: وقف من البنية + هامش، هدف مقيّد بـ R:R."""
    ep=c[i]
    buf = buf_fixed + ATR[i]*buf_atr
    raw = (ep-LOW8[i])/PU + buf if buy else (HIGH8[i]-ep)/PU + buf
    stop = min(hi_s, max(lo_s, raw))
    tgt  = min(hi_t, max(lo_t, max(lo_t, stop*minRR)))
    tgt  = min(tgt, max(lo_t, stop*maxRR))
    return tgt, min(stop, tgt+20.0)      # قيد المشروع

def sim(i0,buy,tp,sl):
    ep=c[i0]; tpp=ep+(tp*PU if buy else -tp*PU); slp=ep-(sl*PU if buy else -sl*PU)
    end=min(i0+1+MAXBARS,n)
    for j in range(i0+1,end):
        if (l[j]<=slp) if buy else (h[j]>=slp): return 0,-sl,j-i0
        if (h[j]>=tpp) if buy else (l[j]<=tpp): return 1, tp,j-i0
    if end>i0+1:
        j=end-1; pts=(c[j]-ep)/PU if buy else (ep-c[j])/PU
        return (1 if pts>0 else 0),pts,j-i0
    return None,None,None

def build_mask(name):
    m=np.ones(n,bool)
    for part in name.split(' & '):
        part=part.strip()
        if '<' in part: f,t=part.split('<')
        elif '>' in part: f,t=part.split('>')
        elif '=' in part: m&=F[part.split('=')[0].strip()]>0.5; continue
        else: return None
        f=f.strip()
        if f not in F: return None
        m &= (F[f]<float(t)) if '<' in part else (F[f]>float(t))
    return m
rules=[]
for r in json.load(open('final_rules.json'))[:40]:
    m=build_mask(r['name'])
    if m is not None: rules.append((r['name'],r['side'],m))
print('عائلات المعمل: %d\n'%len(rules), flush=True)

def run(planner,lo,hi,days):
    wins=[];pts=[];durs=[];tps=[];sls=[];busy=-1
    for i in range(lo,hi):
        if i<=busy or not valid[i]: continue
        for nm,sn,m in rules:
            if not m[i]: continue
            buy = sn=='BUY'
            tp,sl = planner(i,buy)
            w,p,b = sim(i,buy,tp,sl)
            if w is None: continue
            wins.append(w);pts.append(p);durs.append(b);tps.append(tp);sls.append(sl)
            busy=i+b; break
    if not wins: return None
    N=len(wins)
    return N,100*sum(wins)/N,N/days,float(np.mean(pts)),float(np.mean(durs)),float(np.mean(tps)),float(np.mean(sls))

PLANNERS={
 'ثابت 30/50 (الحالي)': lambda i,b:(30.0,50.0),
 'ثابت 39/55 (متوسط SYR30)': lambda i,b:(39.0,55.0),
 'SYR30 بنيوي (افتراضي)': plan_syr30,
 'SYR30 هامش أوسع': lambda i,b: plan_syr30(i,b,buf_fixed=8.0,buf_atr=0.8),
 'SYR30 R:R أعلى': lambda i,b: plan_syr30(i,b,minRR=0.8,maxRR=1.5),
 'SYR30 وقف أضيق': lambda i,b: plan_syr30(i,b,hi_s=45.0),
}
print('%-28s | %6s %7s %6s %8s %5s %5s %5s | %6s %7s %6s %8s %5s'%(
 'الخطة','عدد','فوز%','/يوم','توقّع','هدف','وقف','مدة','عدد','فوز%','/يوم','توقّع','مدة'))
print('%-28s | %44s | %32s'%('','تدريب','اختبار'))
print('─'*118)
for nm,fn in PLANNERS.items():
    a=run(fn,0,split,d_tr); b=run(fn,split,n,d_te)
    if not a or not b: continue
    print('%-28s | %6d %6.1f%% %6.1f %+8.2f %5.0f %5.0f %5.1f | %6d %6.1f%% %6.1f %+8.2f %5.1f'%(
        nm,a[0],a[1],a[2],a[3],a[5],a[6],a[4],b[0],b[1],b[2],b[3],b[4]), flush=True)
