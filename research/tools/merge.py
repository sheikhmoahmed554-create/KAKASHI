"""دمج كل مجموعات القواعد المكتشفة في محفظة واحدة.
عائلات المكتبة القديمة (تردد عالٍ) + عائلات البحث الضخم (جودة عالية)."""
import numpy as np, json, methods, lab, os
D,F = methods.all_features(); X=lab.build()
L,S,LB,SB=X['L'],X['S'],X['LB'],X['SB']
n=D['n']; valid=(D['hour']<22)&(~D['gap']); split=int(n*0.6)
TR=np.zeros(n,bool); TR[:split]=True; TE=~TR
OK={'BUY':L>=0,'SELL':S>=0}; OUT={'BUY':L,'SELL':S}
BASE={}
for pn,p in (('tr',TR),('te',TE)):
    for sn in ('BUY','SELL'):
        m=p&valid&OK[sn]; BASE[(pn,sn)]=float(OUT[sn][m].mean())*100
d_tr=len(set((D['t'][:split][valid[:split]]//86400).astype(int)))
d_te=len(set((D['t'][split:][valid[split:]]//86400).astype(int)))

def build_mask(name):
    m=np.ones(n,bool)
    for part in name.split(' & '):
        part=part.strip()
        if '<' in part:   f,t=part.split('<'); 
        elif '>' in part: f,t=part.split('>')
        elif '=' in part: f=part.split('=')[0]; m&=F[f.strip()]>0.5; continue
        else: return None
        f=f.strip()
        if f not in F: return None
        m &= (F[f]<float(t)) if '<' in part else (F[f]>float(t))
    return m

pool={}
for fn,side_key in [('mega_rules.json','side'),('quad_families.json','side'),
                    ('buy_families.json',None),('cands.json','side'),('diverse.json','side')]:
    if not os.path.exists(fn): continue
    for r in json.load(open(fn)):
        nm=r.get('name'); sn=r.get('side','BUY') if side_key else 'BUY'
        if not nm: continue
        key=(nm,sn)
        if key in pool: continue
        m=build_mask(nm)
        if m is None: continue
        pool[key]=m
print('قواعد فريدة قابلة لإعادة البناء: %d'%len(pool), flush=True)

def seq(mask,sn,lo,hi):
    out,bars=(L,LB) if sn=='BUY' else (S,SB); idx=[]; res=[]; busy=-1
    for i in range(lo,hi):
        if i<=busy or not valid[i] or not mask[i] or out[i]<0: continue
        idx.append(i); res.append(int(out[i])); busy=i+int(bars[i])
    return idx,res

scored=[]
for (nm,sn),m in pool.items():
    ia,ra=seq(m,sn,0,split); ib,rb=seq(m,sn,split,n)
    if len(ra)<35 or len(rb)<25: continue
    wa=100*sum(ra)/len(ra); wb=100*sum(rb)/len(rb)
    if min(wa,wb)<68: continue
    scored.append(dict(name=nm,side=sn,mask=m,wa=wa,wb=wb,idx=set(ib),
                       pb=len(rb)/d_te,score=min(wa,wb)))
scored.sort(key=lambda c:-c['score'])
print('صامدة فوق 68%% في الفترتين: %d\n'%len(scored), flush=True)

TP,SL=30.0,50.0
def port(rs,lo,hi,days,maxpos,cd):
    tr=[]; openu=[]; last={}; conc=[]
    for i in range(lo,hi):
        openu=[u for u in openu if u>i]
        if valid[i]:
            for j,(nm,sn,m) in enumerate(rs):
                if len(openu)>=maxpos: break
                if not m[i]: continue
                if cd and i-last.get(j,-10**9)<cd: continue
                out,bars=(L,LB) if sn=='BUY' else (S,SB)
                if out[i]<0: continue
                tr.append(int(out[i])); openu.append(i+int(bars[i])); last[j]=i
        conc.append(len(openu))
    if not tr: return None
    w=sum(tr); N=len(tr); net=w*TP-(N-w)*SL
    return N,100*w/N,N/days,max(conc),net/N

for ov in (0.30,0.55):
    picked=[]
    for c in scored:
        if all(len(c['idx']&p['idx'])<=ov*min(len(c['idx']),len(p['idx'])) for p in picked):
            picked.append(c)
        if len(picked)>=80: break
    nb=sum(1 for p in picked if p['side']=='BUY')
    print('══ حد التداخل %.0f%%  —  %d عائلة (%d شراء، %d بيع)'%(ov*100,len(picked),nb,len(picked)-nb), flush=True)
    R=[(p['name'],p['side'],p['mask']) for p in picked]
    print('  %6s %7s %6s | %7s %7s %6s %6s %8s'%('عائلات','متزامن','تهدئة','عدد','فوز%','/يوم','ذروة','توقّع'))
    for k in (10,20,40,60,80):
        if k>len(R): break
        for maxpos,cd in ((5,15),(10,10),(999,10)):
            b=port(R[:k],split,n,d_te,maxpos,cd)
            if b: print('  %6d %7s %6d | %7d %6.1f%% %6.1f %6d %+8.2f'%(
                k,maxpos if maxpos<999 else 'بلاحد',cd,b[0],b[1],b[2],b[3],b[4]), flush=True)
    print()
json.dump([{'name':c['name'],'side':c['side'],'wa':c['wa'],'wb':c['wb'],'pb':c['pb']}
           for c in scored[:250]], open('merged_rules.json','w'), ensure_ascii=False)
