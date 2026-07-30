"""بحث مكثّف عن عائلات شراء لموازنة اختلال 29:1."""
from setup_common import *
import itertools, json
C=conditions((2,5,10,20,80,90,95,98)); names=list(C)
print('شروط: %d'%len(names), flush=True)
surv=[]
for combo in itertools.combinations(names,3):
    if len({fam(x) for x in combo})<3: continue
    m=C[combo[0]]&C[combo[1]]&C[combo[2]]
    if m.sum()<500: continue
    xa=m&TR&valid&OK['BUY']
    if xa.sum()<200: continue
    wa=float(OUT['BUY'][xa].mean())*100
    if wa-BASE[('tr','BUY')]<3: continue
    xb=m&TE&valid&OK['BUY']
    if xb.sum()<150: continue
    wb=float(OUT['BUY'][xb].mean())*100
    if wb-BASE[('te','BUY')]<3: continue
    surv.append((' & '.join(combo),m,min(wa,wb)))
surv.sort(key=lambda r:-r[2])
print('ناجون: %d'%len(surv), flush=True)
out=[]
for nm,m,_ in surv[:500]:
    ia,ra=seq(m,'BUY',0,split); ib,rb=seq(m,'BUY',split,n)
    if len(ra)<40 or len(rb)<30: continue
    wa=100*sum(ra)/len(ra); wb=100*sum(rb)/len(rb)
    if min(wa,wb)<66: continue
    out.append(dict(name=nm,wa=wa,wb=wb,na=len(ra),nb=len(rb),pb=len(rb)/d_te,idx=list(ib)))
out.sort(key=lambda c:-min(c['wa'],c['wb']))
print('\n=== أفضل عائلات الشراء ===')
for c in out[:15]:
    print('  %-58s %5.1f%%/%5.1f%%  %4.2f/يوم'%(c['name'][:58],c['wa'],c['wb'],c['pb']))
json.dump(out[:60],open('buy_families.json','w'),ensure_ascii=False)
print('\nإجمالي عائلات شراء صامدة: %d'%len(out))
