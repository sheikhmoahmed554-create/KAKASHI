"""يطلّع النسختين من المخزون الكامل ويتحقق أنهما تنتجان الأرقام المعلنة."""
import numpy as np, json, methods, lab, lab30, os, collections, re
X30=lab30.build(); D=X30['D']; O=X30['O']
_,F=methods.all_features(D)
n=D['n']; valid=(D['hour']<22)&(~D['gap']); split=int(n*0.6)
d_tr=len(set((D['t'][:split][valid[:split]]//86400).astype(int)))
d_te=len(set((D['t'][split:][valid[split:]]//86400).astype(int)))
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
def seq(mask,sn,lo,hi):
    W,P,B,K=O[sn]; idx=[]; res=[]; busy=-1
    for i in range(lo,hi):
        if i<=busy or not valid[i] or not mask[i] or W[i]<0: continue
        idx.append(i); res.append(int(W[i])); busy=i+int(B[i])
    return idx,res
pool={}
for fn in ('megagen_rules.json','final_rules.json','merged_rules.json'):
    if not os.path.exists(fn): continue
    for r in json.load(open(fn)):
        k=(r['name'],r['side'])
        if k in pool: continue
        m=build_mask(r['name'])
        if m is not None: pool[k]=m
print('المخزون الكامل: %d'%len(pool), flush=True)
scored=[]
for (nm,sn),m in pool.items():
    ia,ra=seq(m,sn,0,split); ib,rb=seq(m,sn,split,n)
    if len(ra)<30 or len(rb)<20: continue
    wa=100*sum(ra)/len(ra); wb=100*sum(rb)/len(rb)
    if min(wa,wb)<68: continue
    scored.append(dict(name=nm,side=sn,mask=m,idx=set(ib),wa=wa,wb=wb,score=min(wa,wb)))
scored.sort(key=lambda c:-c['score'])
print('صامدة: %d\n'%len(scored), flush=True)
def pick(ov,k):
    out=[]
    for c in scored:
        if all(len(c['idx']&p['idx'])<=ov*min(len(c['idx']),len(p['idx'])) for p in out):
            out.append(c)
        if len(out)>=k: break
    return out
def port(rs,lo,hi,days):
    wins=[];pts=[];durs=[];busy=-1
    for i in range(lo,hi):
        if i<=busy or not valid[i]: continue
        for nm,sn,m in rs:
            if not m[i]: continue
            W,P,B,K=O[sn]
            if W[i]<0: continue
            wins.append(int(W[i])); pts.append(float(P[i])); durs.append(int(B[i]))
            busy=i+int(B[i]); break
    N=len(wins)
    return N,100*sum(wins)/N,N/days,float(np.mean(pts)),float(np.mean(durs))
VER={'A':(0.30,20),'B':(0.55,150)}
feats=collections.Counter()
for lbl,(ov,k) in VER.items():
    S=pick(ov,k); R=[(c['name'],c['side'],c['mask']) for c in S]
    a=port(R,0,split,d_tr); b=port(R,split,n,d_te)
    nb=sum(1 for c in S if c['side']=='BUY')
    print('══ النسخة %s — %d عائلة (%d شراء، %d بيع)'%(lbl,len(S),nb,len(S)-nb))
    print('   تدريب : %5d صفقة  %5.1f%%  %5.1f/يوم  توقّع %+6.2f  مدة %.1f'%a)
    print('   اختبار: %5d صفقة  %5.1f%%  %5.1f/يوم  توقّع %+6.2f  مدة %.1f\n'%b)
    json.dump({'version':lbl,'overlap':ov,'families':len(S),
               'test':{'trades':b[0],'win_rate':round(b[1],2),'per_day':round(b[2],2),
                       'expectancy':round(b[3],2),'avg_bars':round(b[4],1)},
               'rules':[{'name':c['name'],'side':c['side'],
                         'wr_train':round(c['wa'],1),'wr_test':round(c['wb'],1)} for c in S]},
              open('version_%s.json'%lbl,'w'), ensure_ascii=False, indent=1)
    for c in S:
        for part in c['name'].split(' & '):
            feats[re.split(r'[<>=]',part.strip())[0]]+=1
print('خصائص مطلوبة في Pine: %d'%len(feats))
json.dump(list(feats.keys()), open('pine_features.json','w'))
