"""هل العائلات تنسجم مع بعضها؟ تعارض الاتجاه، الحجب، حساسية الترتيب، ترابط الفشل."""
import numpy as np, lab, itertools, json
X=lab.build(); D,F,L,S,LB,SB=X['D'],X['F'],X['L'],X['S'],X['LB'],X['SB']
n=D['n']; valid=(D['hour']<22)&(~D['gap']); split=int(n*0.6)
d_te=len(set((D['t'][split:][valid[split:]]//86400).astype(int)))
TR=np.zeros(n,bool); TR[:split]=True; TE=~TR
OK={'BUY':L>=0,'SELL':S>=0}; OUT={'BUY':L,'SELL':S}
BASE={}
for pn,p in (('tr',TR),('te',TE)):
    for sn in ('BUY','SELL'):
        m=p&valid&OK[sn]; BASE[(pn,sn)]=float(OUT[sn][m].mean())*100
SKIP={'ema9','ema21','ema50','ema200','bb_mid','bb_sd','hh20','hh60','hh240',
      'll20','ll60','ll240','vwap','atr60','spread'}
q=lambda a,p: np.nanpercentile(a[np.isfinite(a)],p)
C={}
for f in F:
    if f in SKIP: continue
    a=F[f]
    if len(np.unique(a[:5000]))<=2: C['%s=1'%f]=a>0.5; continue
    for p in (3,8,15,85,92,97):
        t=q(a,p)
        if np.isfinite(t): C['%s%s%.4g'%(f,'<' if p<50 else '>',t)]=(a<t if p<50 else a>t)
fam=lambda s: s.split('<')[0].split('>')[0].split('=')[0]
names=list(C)
surv=[]
for combo in itertools.combinations(names,3):
    if len({fam(x) for x in combo})<3: continue
    m=C[combo[0]]&C[combo[1]]&C[combo[2]]
    if m.sum()<600: continue
    for sn in ('BUY','SELL'):
        xa=m&TR&valid&OK[sn]
        if xa.sum()<250: continue
        wa=float(OUT[sn][xa].mean())*100
        if wa-BASE[('tr',sn)]<3: continue
        xb=m&TE&valid&OK[sn]
        if xb.sum()<200: continue
        wb=float(OUT[sn][xb].mean())*100
        if wb-BASE[('te',sn)]<3: continue
        surv.append((' & '.join(combo),sn,m,min(wa,wb)))
surv.sort(key=lambda r:-r[3])
def seq(mask,sn,lo,hi):
    out,bars=(L,LB) if sn=='BUY' else (S,SB); idx=[]; res=[]; busy=-1
    for i in range(lo,hi):
        if i<=busy or not valid[i] or not mask[i] or out[i]<0: continue
        idx.append(i); res.append(int(out[i])); busy=i+int(bars[i])
    return idx,res
cands=[]
for nm,sn,m,_ in surv[:900]:
    ia,ra=seq(m,sn,0,split)
    if len(ra)<45: continue
    ib,rb=seq(m,sn,split,n)
    if len(rb)<35: continue
    wa=100*sum(ra)/len(ra); wb=100*sum(rb)/len(rb)
    if min(wa,wb)<66: continue
    cands.append(dict(name=nm,side=sn,mask=m,idx_te=set(ib),score=min(wa,wb),wb=wb))
cands.sort(key=lambda c:-c['score'])
picked=[]
for c in cands:
    if all(len(c['idx_te']&p['idx_te'])<=0.30*min(len(c['idx_te']),len(p['idx_te'])) for p in picked):
        picked.append(c)
    if len(picked)>=30: break
R=[(c['name'],c['side'],c['mask'],c['wb']) for c in picked]
print('العائلات المختارة: %d (%d بيع، %d شراء)\n'%(
    len(R), sum(1 for r in R if r[1]=='SELL'), sum(1 for r in R if r[1]=='BUY')), flush=True)

# ── 1. تعارض الاتجاه ──
buy_any=np.zeros(n,bool); sell_any=np.zeros(n,bool)
for nm,sn,m,_ in R:
    if sn=='BUY': buy_any|=m
    else: sell_any|=m
both=buy_any&sell_any&valid&TE
print('١) تعارض الاتجاه على نفس الشمعة:')
print('   شموع فيها إشارة شراء: %d | بيع: %d | الاتنين معا: %d (%.2f%% من إشارات الاختبار)'%(
    (buy_any&valid&TE).sum(),(sell_any&valid&TE).sum(),both.sum(),
    100*both.sum()/max((buy_any|sell_any)[valid&TE].sum(),1)))
if both.sum()>50:
    for sn in ('BUY','SELL'):
        x=both&OK[sn]
        print('   نتيجة الشموع المتعارضة لو دخلنا %s: %.1f%% (%d شمعة)'%(sn,100*OUT[sn][x].mean(),x.sum()))

# ── 2. الحجب: كم إشارة تضيع لأن صفقة مفتوحة؟ ──
def run_port(rules,lo,hi,order=None):
    rs=rules if order is None else [rules[i] for i in order]
    tr=[]; busy=-1; blocked=0
    for i in range(lo,hi):
        if not valid[i]: continue
        fired=any(m[i] for _,_,m,_ in rs)
        if i<=busy:
            if fired: blocked+=1
            continue
        for nm,sn,m,_ in rs:
            if not m[i]: continue
            out,bars=(L,LB) if sn=='BUY' else (S,SB)
            if out[i]<0: continue
            tr.append(int(out[i])); busy=i+int(bars[i]); break
    return tr, blocked
tr,blocked=run_port(R,split,n)
print('\n٢) الحجب (صفقة واحدة في المرة):')
print('   صفقات منفذة: %d | إشارات ضاعت بسبب الحجب: %d (%.0f%% من الإشارات)'%(
    len(tr),blocked,100*blocked/max(len(tr)+blocked,1)))

# ── 3. حساسية الترتيب ──
print('\n٣) حساسية ترتيب الأولوية:')
base_wr=100*sum(tr)/len(tr)
print('   الترتيب الحالي (الأعلى جودة أولا): %.2f%% على %d صفقة'%(base_wr,len(tr)))
rng=np.random.default_rng(7); res=[]
for k in range(8):
    o=list(rng.permutation(len(R)))
    t,_=run_port(R,split,n,o); res.append(100*sum(t)/len(t))
print('   ٨ ترتيبات عشوائية: من %.2f%% إلى %.2f%% (المدى %.2f نقطة)'%(min(res),max(res),max(res)-min(res)))
o=list(np.argsort([r[3] for r in R]))
t,_=run_port(R,split,n,o)
print('   الترتيب المعكوس (الأضعف أولا): %.2f%% على %d صفقة'%(100*sum(t)/len(t),len(t)))

# ── 4. ترابط الفشل: هل تخسر العائلات في نفس الأيام؟ ──
print('\n٤) ترابط الفشل بين العائلات (فترة الاختبار):')
daily={}
for j,(nm,sn,m,_) in enumerate(R):
    idx,res_=seq(m,sn,split,n)
    for i,r in zip(idx,res_):
        day=int(D['t'][i]//86400)
        daily.setdefault(j,{}).setdefault(day,[]).append(r)
days=sorted({d for v in daily.values() for d in v})
mat=[]
for j in daily:
    row=[]
    for d in days:
        v=daily[j].get(d)
        row.append(sum(v)/len(v) if v else np.nan)
    mat.append(row)
M=np.array(mat,float)
cors=[]
for a,b in itertools.combinations(range(len(M)),2):
    ok=~(np.isnan(M[a])|np.isnan(M[b]))
    if ok.sum()>=20:
        ca=np.corrcoef(M[a][ok],M[b][ok])[0,1]
        if np.isfinite(ca): cors.append(ca)
if cors:
    print('   متوسط الارتباط اليومي بين العائلات: %+.3f'%np.mean(cors))
    print('   المدى: %+.2f إلى %+.2f | نسبة الأزواج فوق +0.3: %.0f%%'%(
        min(cors),max(cors),100*sum(1 for c in cors if c>0.3)/len(cors)))
# أسوأ يوم للمحفظة
pd_={}
for i_,r in zip(*[[],[]]): pass
tr_idx=[]; busy=-1
for i in range(split,n):
    if i<=busy or not valid[i]: continue
    for nm,sn,m,_ in R:
        if not m[i]: continue
        out,bars=(L,LB) if sn=='BUY' else (S,SB)
        if out[i]<0: continue
        tr_idx.append((int(D['t'][i]//86400),int(out[i]))); busy=i+int(bars[i]); break
dd={}
for day,r in tr_idx: dd.setdefault(day,[]).append(r)
wrs=[(sum(v)/len(v),len(v),day) for day,v in dd.items() if len(v)>=10]
wrs.sort()
print('\n   أداء المحفظة اليومي (أيام بها 10+ صفقات، %d يوم):'%len(wrs))
print('   أسوأ 3 أيام: %s'%', '.join('%.0f%% (%d صفقة)'%(100*w,k) for w,k,_ in wrs[:3]))
print('   أفضل 3 أيام: %s'%', '.join('%.0f%% (%d صفقة)'%(100*w,k) for w,k,_ in wrs[-3:]))
print('   أيام خاسرة (فوز < 62.5%%): %d من %d (%.0f%%)'%(
    sum(1 for w,_,_ in wrs if w<0.625),len(wrs),100*sum(1 for w,_,_ in wrs if w<0.625)/len(wrs)))
