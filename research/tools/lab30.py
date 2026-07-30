"""محرك بوقف زمني: الصفقة تُغلق بالسوق بعد MAXBARS شمعة إن لم تُحسم.

الفروق عن lab.py:
  • الحد الأقصى لعمر الصفقة 30 شمعة (نصف ساعة) بدل 240
  • الخروج الزمني يُحسب بربح/خسارة فعلية عند شمعة الإغلاق، لا يُهمَل
  • المكسب = ربح فعلي موجب (سواء هدف أو خروج زمني رابح)
"""
import numpy as np, lab, os, pickle
PU = lab.PU
CACHE = 'lab30_cache.pkl'

def outcomes_timed(D, tp_pts, sl_pts, maxbars=30):
    """يُرجع: win (1/0/-1)، النقاط الفعلية، عدد الشموع، نوع الخروج (0 هدف، 1 وقف، 2 زمني)."""
    h,l,c,n = D['h'],D['l'],D['c'],D['n']
    tpd, sld = tp_pts*PU, sl_pts*PU
    out = {}
    for side in ('BUY','SELL'):
        buy = side=='BUY'
        W = np.full(n,-1,np.int8); P = np.zeros(n,np.float32)
        B = np.zeros(n,np.int16); K = np.full(n,-1,np.int8)
        for i in range(n-1):
            ep = c[i]
            tp = ep+tpd if buy else ep-tpd
            sl = ep-sld if buy else ep+sld
            end = min(i+1+maxbars, n)
            done = False
            for j in range(i+1, end):
                hitS = (l[j]<=sl) if buy else (h[j]>=sl)
                hitT = (h[j]>=tp) if buy else (l[j]<=tp)
                if hitS:
                    W[i]=0; P[i]=-sl_pts; B[i]=j-i; K[i]=1; done=True; break
                if hitT:
                    W[i]=1; P[i]=tp_pts;  B[i]=j-i; K[i]=0; done=True; break
            if not done and end>i+1:
                j = end-1
                pts = (c[j]-ep)/PU if buy else (ep-c[j])/PU
                W[i] = 1 if pts>0 else 0
                P[i] = pts; B[i]=j-i; K[i]=2
        out[side]=(W,P,B,K)
    return out

def build(tp=30, sl=50, maxbars=30):
    if os.path.exists(CACHE):
        with open(CACHE,'rb') as f: return pickle.load(f)
    D = lab.load()
    print('  بحساب النتائج بوقف زمني %d شمعة لخطة %g/%g ...'%(maxbars,tp,sl), flush=True)
    O = outcomes_timed(D, tp, sl, maxbars)
    obj = dict(D=D, O=O, tp=tp, sl=sl, maxbars=maxbars)
    with open(CACHE,'wb') as f: pickle.dump(obj,f)
    return obj

if __name__=='__main__':
    import time; t0=time.time()
    X=build(); D=X['D']
    print('  تم في %.0f ثانية'%(time.time()-t0))
    valid=(D['hour']<22)&(~D['gap'])
    for side in ('BUY','SELL'):
        W,P,B,K = X['O'][side]
        m = valid&(W>=0)
        kinds=np.bincount(K[m]+0, minlength=3)
        print('  %-5s فوز %.2f%%  |  متوسط النقاط %+.2f  |  متوسط المدة %.1f شمعة'%(
            side, 100*W[m].mean(), P[m].mean(), B[m].mean()))
        print('        هدف %.1f%%  وقف %.1f%%  خروج زمني %.1f%%'%(
            100*kinds[0]/m.sum(), 100*kinds[1]/m.sum(), 100*kinds[2]/m.sum()))
