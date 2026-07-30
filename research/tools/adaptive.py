"""أهداف متكيّفة: الهدف والوقف يُحسبان لكل صفقة من تقلب اللحظة بدل قيم ثابتة.

المنطق: هدف 30 نقطة في سوق هادئ (ATR=12) بعيد جداً، وفي سوق متقلب (ATR=35) قريب جداً.
لذا نربطهما بـ ATR14 مع احترام قيود المشروع: هدف 30-60، الوقف ≤ الهدف+20.
"""
import numpy as np, json, methods, lab, lab30
PU=lab.PU
D=lab.load(); _,F=methods.all_features(D)
n=D['n']; h,l,c=D['h'],D['l'],D['c']
valid=(D['hour']<22)&(~D['gap']); split=int(n*0.6)
d_tr=len(set((D['t'][:split][valid[:split]]//86400).astype(int)))
d_te=len(set((D['t'][split:][valid[split:]]//86400).astype(int)))
ATR=np.maximum(F['atr14'],1e-9)     # بالنقاط
print('توزيع ATR14 (نقاط): p10 %.0f  وسيط %.0f  p90 %.0f'%(
    np.percentile(ATR,10),np.percentile(ATR,50),np.percentile(ATR,90)))

def sim_adaptive(i0, buy, tp_pts, sl_pts, maxbars=30):
    ep=c[i0]; tpd,sld = tp_pts*PU, sl_pts*PU
    tp = ep+tpd if buy else ep-tpd
    sl = ep-sld if buy else ep+sld
    end=min(i0+1+maxbars, n)
    for j in range(i0+1,end):
        if (l[j]<=sl) if buy else (h[j]>=sl): return 0,-sl_pts,j-i0
        if (h[j]>=tp) if buy else (l[j]<=tp): return 1, tp_pts,j-i0
    if end>i0+1:
        j=end-1; pts=(c[j]-ep)/PU if buy else (ep-c[j])/PU
        return (1 if pts>0 else 0), pts, j-i0
    return None,None,None

def build_mask(name):
    m=np.ones(n,bool)
    for part in name.split(' & '):
        part=part.strip()
        if '<' in part:   f,t=part.split('<')
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
print('عائلات: %d\n'%len(rules), flush=True)

def run(rs, plan_fn, lo, hi, days):
    wins=[];pts=[];durs=[];tps=[];busy=-1
    for i in range(lo,hi):
        if i<=busy or not valid[i]: continue
        for nm,sn,m in rs:
            if not m[i]: continue
            tp_pts, sl_pts = plan_fn(i)
            w,p,b = sim_adaptive(i, sn=='BUY', tp_pts, sl_pts)
            if w is None: continue
            wins.append(w); pts.append(p); durs.append(b); tps.append(tp_pts)
            busy=i+b; break
    if not wins: return None
    N=len(wins)
    return N,100*sum(wins)/N,N/days,float(np.mean(pts)),float(np.mean(durs)),float(np.mean(tps))

def clamp(tp,sl):
    tp=min(60.0,max(30.0,tp))
    sl=min(tp+20.0, max(20.0, sl))
    return tp,sl

PLANS={}
PLANS['ثابت 30/50']      = lambda i:(30.0,50.0)
PLANS['ثابت 40/60']      = lambda i:(40.0,60.0)
PLANS['ثابت 50/70']      = lambda i:(50.0,70.0)
for ktp,ksl in ((1.2,2.0),(1.5,2.2),(1.5,2.5),(1.8,2.5),(2.0,2.8),(2.0,3.0),(2.5,3.0)):
    PLANS['تكيّف %.1f×ATR / %.1f×ATR'%(ktp,ksl)] = (
        lambda i,a=ktp,b=ksl: clamp(a*ATR[i], b*ATR[i]))
# تكيّف عكسي: هدف أكبر في الهدوء (السعر يتحرك ببطء لكن باتجاه)
PLANS['عكسي: هدف أكبر في الهدوء'] = lambda i: clamp(60.0-1.0*ATR[i], 80.0-1.0*ATR[i])

print('%-34s | %7s %7s %7s %8s %6s | %7s %7s %7s %8s %6s'%(
    'الخطة','عدد','فوز%','/يوم','توقّع','مدة','عدد','فوز%','/يوم','توقّع','مدة'))
print('%-34s | %39s | %39s'%('','تدريب','اختبار'))
print('─'*118)
res=[]
for nm,fn in PLANS.items():
    a=run(rules,fn,0,split,d_tr); b=run(rules,fn,split,n,d_te)
    if not a or not b: continue
    res.append((nm,a,b))
    print('%-34s | %7d %6.1f%% %6.1f %+8.2f %6.1f | %7d %6.1f%% %6.1f %+8.2f %6.1f'%(
        nm,a[0],a[1],a[2],a[3],a[4],b[0],b[1],b[2],b[3],b[4]), flush=True)
print('\n═══ الترتيب بالتوقّع (أضعف الفترتين) ═══')
for nm,a,b in sorted(res,key=lambda r:-min(r[1][3],r[2][3]))[:5]:
    print('  %-34s اختبار %5.1f%% • %5.1f/يوم • %+6.2f • متوسط الهدف %.0f نقطة'%(nm,b[1],b[2],b[3],b[5]))
print('\n═══ الترتيب بنسبة الفوز ═══')
for nm,a,b in sorted(res,key=lambda r:-min(r[1][1],r[2][1]))[:5]:
    print('  %-34s اختبار %5.1f%% • %5.1f/يوم • %+6.2f • متوسط الهدف %.0f نقطة'%(nm,b[1],b[2],b[3],b[5]))
