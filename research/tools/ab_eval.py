"""يقيس أداء كل إعداد A/B: يحاكي دخولاته بخطة ثابتة ويقارن."""
import json, csv, math, sys
PU=0.1; TP,SL=30.0,50.0
R=list(csv.DictReader(open('vault.csv')))
H=[float(r['high']) for r in R]; L=[float(r['low']) for r in R]; C=[float(r['close']) for r in R]; N=len(R)
def sim(i0,buy,maxbars=240):
    ep=C[i0]; tp=ep+(TP*PU if buy else -TP*PU); sl=ep-(SL*PU if buy else -SL*PU)
    for i in range(i0+1,min(i0+1+maxbars,N)):
        if (L[i]<=sl) if buy else (H[i]>=sl): return 0
        if (H[i]>=tp) if buy else (L[i]<=tp): return 1
    return None
BE=100*SL/(TP+SL)
CFG=['A_baseline','B_bbkc_off','C_syr30_on','D_all_on','E_all_on_bbkc_off']
res={}
print('خطة ثابتة %g/%g • تعادل %.1f%%\n'%(TP,SL,BE))
print('%-22s %8s %8s %8s %9s %10s %9s'%('الإعداد','صفقات','شراء','بيع','فوز%','الحافة','لكل صفقة'))
print('─'*82)
for c in CFG:
    try: d=json.load(open('ab/%s.out.json'%c))
    except Exception: print('%-22s (لم يكتمل)'%c); continue
    w=l=0; nb=ns=0; outs={}
    for i,side,tgt,stp in d['entries']:
        if i>=N-1: continue
        r=sim(i,side>0)
        if r is None: continue
        outs[i]=(side,r)
        if side>0: nb+=1
        else: ns+=1
        w+=r; l+=1-r
    n=w+l
    if not n: continue
    wr=100*w/n; net=w*TP-l*SL
    res[c]=outs
    print('%-22s %8d %8d %8d %8.2f%% %+9.2f %+9.2f'%(c,n,nb,ns,wr,wr-BE,net/n))
print('─'*82)
base=res.get('A_baseline')
if base:
    print('\nالفروق عن الأساس:')
    for c in CFG[1:]:
        if c not in res: continue
        o=res[c]
        only_new=set(o)-set(base); only_old=set(base)-set(o)
        common=set(o)&set(base)
        diff_side=sum(1 for i in common if o[i][0]!=base[i][0])
        wn=sum(o[i][1] for i in only_new); wo=sum(base[i][1] for i in only_old)
        print('  %-22s دخولات جديدة %4d (فوز %5.1f%%) | اختفت %4d (فوز %5.1f%%) | غيّرت الجهة %d'%(
            c,len(only_new),100*wn/max(len(only_new),1),len(only_old),100*wo/max(len(only_old),1),diff_side))
