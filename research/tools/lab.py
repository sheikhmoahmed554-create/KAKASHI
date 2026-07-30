"""ماكينة بحث عن حافة تداول على XAUUSD M1.
الفكرة: نحسب مقدماً نتيجة الدخول (فوز/خسارة) عند كل شمعة لكل خطة خروج.
بعدها تقييم أي قاعدة = قناع منطقي، أي جزء من الثانية."""
import numpy as np, csv, datetime, json, os, pickle

PU = 0.1                      # وحدة النقطة
CACHE = 'lab_cache.pkl'

def load():
    R = list(csv.DictReader(open('vault.csv')))
    t = np.array([datetime.datetime.fromisoformat(r['time']).timestamp() for r in R])
    o = np.array([float(r['open']) for r in R]);  h = np.array([float(r['high']) for r in R])
    l = np.array([float(r['low'])  for r in R]);  c = np.array([float(r['close']) for r in R])
    v = np.array([float(r['volume']) for r in R]); sp = np.array([float(r['spread']) for r in R])
    hh = np.array([datetime.datetime.fromisoformat(r['time']).hour for r in R])
    dw = np.array([datetime.datetime.fromisoformat(r['time']).weekday() for r in R])
    # فجوة زمنية > 5 دقائق = بداية جلسة جديدة (عطلة/انقطاع)
    gap = np.concatenate([[True], np.diff(t) > 300])
    return dict(t=t,o=o,h=h,l=l,c=c,v=v,sp=sp,hour=hh,dow=dw,gap=gap,n=len(R))

def outcomes(D, tp_pts, sl_pts, maxbars=240):
    """لكل شمعة: 1 فوز، 0 خسارة، -1 لم يُحسم. الوقف له الأولوية عند التصادم."""
    h,l,c,n = D['h'],D['l'],D['c'],D['n']
    tpd, sld = tp_pts*PU, sl_pts*PU
    L = np.full(n, -1, np.int8); S = np.full(n, -1, np.int8)
    LB = np.zeros(n, np.int16); SB = np.zeros(n, np.int16)
    for i in range(n-1):
        ep = c[i]; end = min(i+1+maxbars, n)
        # شراء
        tp, sl = ep+tpd, ep-sld
        for j in range(i+1, end):
            if l[j] <= sl: L[i]=0; LB[i]=j-i; break
            if h[j] >= tp: L[i]=1; LB[i]=j-i; break
        # بيع
        tp, sl = ep-tpd, ep+sld
        for j in range(i+1, end):
            if h[j] >= sl: S[i]=0; SB[i]=j-i; break
            if l[j] <= tp: S[i]=1; SB[i]=j-i; break
    return L,S,LB,SB

# ---------------- مؤشرات ----------------
def ema(x,n):
    a=2/(n+1); out=np.empty_like(x); out[0]=x[0]
    for i in range(1,len(x)): out[i]=a*x[i]+(1-a)*out[i-1]
    return out
def rma(x,n):
    a=1/n; out=np.empty_like(x); out[0]=x[0]
    for i in range(1,len(x)): out[i]=a*x[i]+(1-a)*out[i-1]
    return out
def roll_max(x,n):
    out=np.full_like(x,np.nan)
    if n<=len(x):
        from numpy.lib.stride_tricks import sliding_window_view
        out[n-1:]=sliding_window_view(x,n).max(1)
    return out
def roll_min(x,n):
    out=np.full_like(x,np.nan)
    if n<=len(x):
        from numpy.lib.stride_tricks import sliding_window_view
        out[n-1:]=sliding_window_view(x,n).min(1)
    return out
def roll_mean(x,n):
    cs=np.concatenate([[0],np.cumsum(x)]); out=np.full_like(x,np.nan)
    out[n-1:]=(cs[n:]-cs[:-n])/n; return out
def roll_std(x,n):
    m=roll_mean(x,n); m2=roll_mean(x*x,n)
    return np.sqrt(np.maximum(m2-m*m,0))
def rsi(c,n=14):
    d=np.diff(c,prepend=c[0]); up=rma(np.maximum(d,0),n); dn=rma(np.maximum(-d,0),n)
    return 100-100/(1+up/np.maximum(dn,1e-12))

def features(D):
    o,h,l,c,v = D['o'],D['h'],D['l'],D['c'],D['v']
    F={}
    tr=np.maximum(h-l, np.maximum(np.abs(h-np.roll(c,1)), np.abs(l-np.roll(c,1)))); tr[0]=h[0]-l[0]
    F['atr14']=rma(tr,14)/PU; F['atr60']=rma(tr,60)/PU
    F['atr_ratio']=F['atr14']/np.maximum(F['atr60'],1e-9)
    for n in (9,21,50,200): F['ema%d'%n]=ema(c,n)
    F['rsi14']=rsi(c,14); F['rsi3']=rsi(c,3)
    for n in (20,60,240):
        F['hh%d'%n]=roll_max(h,n); F['ll%d'%n]=roll_min(l,n)
        F['pos%d'%n]=(c-F['ll%d'%n])/np.maximum(F['hh%d'%n]-F['ll%d'%n],1e-9)*100
    F['bb_mid']=roll_mean(c,20); F['bb_sd']=roll_std(c,20)
    F['bb_z']=(c-F['bb_mid'])/np.maximum(F['bb_sd'],1e-9)
    F['body']=np.abs(c-o)/np.maximum(h-l,1e-9)
    F['upwick']=(h-np.maximum(o,c))/np.maximum(h-l,1e-9)
    F['dnwick']=(np.minimum(o,c)-l)/np.maximum(h-l,1e-9)
    F['ret1']=(c-np.roll(c,1))/PU;  F['ret5']=(c-np.roll(c,5))/PU
    F['ret15']=(c-np.roll(c,15))/PU; F['ret60']=(c-np.roll(c,60))/PU
    F['vol_ratio']=v/np.maximum(roll_mean(v,60),1e-9)
    F['spread']=D['sp']
    F['ema9_21']=(F['ema9']-F['ema21'])/PU
    F['ema21_50']=(F['ema21']-F['ema50'])/PU
    F['dist_ema200']=(c-F['ema200'])/PU
    for k in F: F[k]=np.nan_to_num(F[k], nan=0.0, posinf=0.0, neginf=0.0)
    return F

def build(tp=30, sl=50):
    if os.path.exists(CACHE):
        with open(CACHE,'rb') as f: return pickle.load(f)
    D=load(); F=features(D)
    print('  شموع:', D['n'], '| خصائص:', len(F))
    print('  بحساب النتائج مقدماً لخطة %g/%g ...'%(tp,sl))
    L,S,LB,SB = outcomes(D,tp,sl)
    obj=dict(D=D,F=F,L=L,S=S,LB=LB,SB=SB,tp=tp,sl=sl)
    with open(CACHE,'wb') as f: pickle.dump(obj,f)
    return obj

if __name__=='__main__':
    import time; t0=time.time()
    X=build()
    D,L,S=X['D'],X['L'],X['S']
    print('  تم في %.0f ثانية'%(time.time()-t0))
    for nm,A in (('شراء',L),('بيع',S)):
        r=A[A>=0]; print('  %s: %d شمعة محسومة، نسبة الفوز الأساسية %.2f%%'%(nm,len(r),100*r.mean()))
    print('  التعادل: %.2f%%'%(100*X['sl']/(X['tp']+X['sl'])))
