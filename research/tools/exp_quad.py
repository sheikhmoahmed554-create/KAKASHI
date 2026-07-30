"""المسار الأول: تركيبات رباعية لرفع جودة العائلات."""
from setup_common import *
import itertools, json
C=conditions((3,8,15,85,92,97)); names=list(C)
print('شروط: %d'%len(names), flush=True)
# ابدأ من أفضل الثلاثيات ثم أضف شرطاً رابعاً
tri=[]
for combo in itertools.combinations(names,3):
    if len({fam(x) for x in combo})<3: continue
    m=C[combo[0]]&C[combo[1]]&C[combo[2]]
    if m.sum()<1500: continue
    for sn in ('BUY','SELL'):
        xa=m&TR&valid&OK[sn]
        if xa.sum()<600: continue
        wa=float(OUT[sn][xa].mean())*100
        if wa-BASE[('tr',sn)]<2.5: continue
        xb=m&TE&valid&OK[sn]
        if xb.sum()<400: continue
        wb=float(OUT[sn][xb].mean())*100
        if wb-BASE[('te',sn)]<2.5: continue
        tri.append((combo,sn,m,min(wa,wb)))
tri.sort(key=lambda r:-r[3]); tri=tri[:150]
print('ثلاثيات أساس: %d'%len(tri), flush=True)
out=[]
for combo,sn,m,_ in tri:
    fams={fam(x) for x in combo}
    for nm4 in names:
        if fam(nm4) in fams: continue
        m4=m&C[nm4]
        if m4.sum()<600: continue
        xa=m4&TR&valid&OK[sn]
        if xa.sum()<250: continue
        wa=float(OUT[sn][xa].mean())*100
        if wa-BASE[('tr',sn)]<5: continue
        xb=m4&TE&valid&OK[sn]
        if xb.sum()<180: continue
        wb=float(OUT[sn][xb].mean())*100
        if wb-BASE[('te',sn)]<5: continue
        out.append((' & '.join(list(combo)+[nm4]),sn,m4,min(wa,wb)))
out.sort(key=lambda r:-r[3])
print('رباعيات ناجية: %d\n'%len(out), flush=True)
fin=[]
for nm,sn,m,_ in out[:400]:
    ia,ra=seq(m,sn,0,split); ib,rb=seq(m,sn,split,n)
    if len(ra)<40 or len(rb)<30: continue
    wa=100*sum(ra)/len(ra); wb=100*sum(rb)/len(rb)
    if min(wa,wb)<70: continue
    fin.append(dict(name=nm,side=sn,wa=wa,wb=wb,nb=len(rb),pb=len(rb)/d_te,idx=list(ib)))
fin.sort(key=lambda c:-min(c['wa'],c['wb']))
print('=== أفضل الرباعيات (>=70%% في الفترتين) ===')
for c in fin[:20]:
    print('  %-70s %-5s %5.1f%%/%5.1f%%  %4.2f/يوم'%(c['name'][:70],c['side'],c['wa'],c['wb'],c['pb']))
json.dump(fin[:80],open('quad_families.json','w'),ensure_ascii=False)
print('\nإجمالي: %d رباعية تجاوزت 70%%'%len(fin))
