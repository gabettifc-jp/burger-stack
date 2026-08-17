/* Wave 37：純度と③・④の傾きを測る（集計だけ・2026-08-17）。
   index.html にもゲームの値にも触らない。m4-measure.mjs の出した jsonl を読んで並べ直すだけ。

   1ランにつき1点を取る（§3-1）：
     x  … そのランの**最高スピン**での純度 ＝ cui[軸] / (ic + sc)
           分母をデッキ枚数にしないのは、バンズが cuisine を持たず 'none' に落ちるため
           （m4-measure.mjs:180 の cui は cuisine||'none' で数えている）。
           ic/sc は同じスピンの pile==='ingredient'/'sauce' の枚数（m4-measure.mjs:175-176）。
     y1 … 同じスピンの mmul ＝ ④（倍率の乗算・evaluate の multMul）
     y2 … 同じスピンの madd ＝ ③（倍率の加算・evaluate の multAdd）
   11方策を**混ぜて**扱う（方策ごとに分けない）。軸方策は純度を上げるための道具であって、
   ここで見たいのは「純度が高いと④はどうなるか」だから、純度そのものを横軸に置く。

   相関は**スピアマン（順位相関）**。ピアソンは使わない：得点も倍率も軸内で数百倍の幅があり、
   上振れ数本が係数を決めてしまう（Wave 31 §3 で 470〜11,610倍の幅を確認済み）。
   同順位は平均順位で潰す。p 値は t 近似 t = ρ√((n−2)/(1−ρ²))・自由度 n−2・両側。
   t の裾は不完全ベータ関数（Lentz の連分数）で出す。α=0.05。

   使い方： node tools/w37-slope.mjs <データのあるディレクトリ>
*/
import { readFileSync, existsSync } from 'fs';

const DIR = process.argv[2];
if (!DIR){ console.error('使い方: node tools/w37-slope.mjs <dir>'); process.exit(1); }

const AX = [['和','wa'],['中華','chuka'],['揚げ物','agemono'],['高級','kokyu'],['海鮮','kaisen']];
const FILES = ['base.jsonl'];
for (const [,en] of AX){ FILES.push(`weak-${en}.jsonl`); FILES.push(`strong-${en}.jsonl`); }

const med = a => { if(!a.length) return NaN; const s=[...a].sort((x,y)=>x-y),n=s.length; return n%2?s[(n-1)/2]:(s[n/2-1]+s[n/2])/2; };
const yen = v => Number.isFinite(v) ? '¥'+Math.round(v).toLocaleString('en-US') : '—';
const r1 = v => Math.round(v*10)/10, r2 = v => Math.round(v*100)/100, r3 = v => Math.round(v*1000)/1000;

/* ── 不完全ベータ関数と t 分布の両側 p 値 ───────────────────────────── */
function lgamma(x){   // Lanczos
  const g=[676.5203681218851,-1259.1392167224028,771.32342877765313,-176.61502916214059,
           12.507343278686905,-0.13857109526572012,9.9843695780195716e-6,1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI/Math.sin(Math.PI*x)) - lgamma(1-x);
  x -= 1; let a = 0.99999999999980993; const t = x + 7.5;
  for (let i=0;i<8;i++) a += g[i]/(x+i+1);
  return 0.5*Math.log(2*Math.PI) + (x+0.5)*Math.log(t) - t + Math.log(a);
}
function betacf(a,b,x){
  const FPMIN=1e-300, EPS=3e-16; const qab=a+b, qap=a+1, qam=a-1;
  let c=1, d=1-qab*x/qap; if (Math.abs(d)<FPMIN) d=FPMIN; d=1/d; let h=d;
  for (let m=1;m<=300;m++){
    const m2=2*m;
    let aa=m*(b-m)*x/((qam+m2)*(a+m2));
    d=1+aa*d; if(Math.abs(d)<FPMIN) d=FPMIN; c=1+aa/c; if(Math.abs(c)<FPMIN) c=FPMIN; d=1/d; h*=d*c;
    aa=-(a+m)*(qab+m)*x/((a+m2)*(qap+m2));
    d=1+aa*d; if(Math.abs(d)<FPMIN) d=FPMIN; c=1+aa/c; if(Math.abs(c)<FPMIN) c=FPMIN; d=1/d;
    const del=d*c; h*=del; if (Math.abs(del-1)<EPS) break;
  }
  return h;
}
function betai(a,b,x){
  if (x<=0) return 0; if (x>=1) return 1;
  const bt = Math.exp(lgamma(a+b)-lgamma(a)-lgamma(b)+a*Math.log(x)+b*Math.log(1-x));
  return (x < (a+1)/(a+b+2)) ? bt*betacf(a,b,x)/a : 1 - bt*betacf(b,a,1-x)/b;
}
const tp2 = (t,df) => (df<=0) ? NaN : betai(df/2, 0.5, df/(df+t*t));   // 両側

/* ── 同順位を平均順位で潰した順位 ───────────────────────────────────── */
function ranks(v){
  const idx = v.map((x,i)=>[x,i]).sort((a,b)=>a[0]-b[0]);
  const r = new Array(v.length);
  let i = 0;
  while (i < idx.length){
    let j = i; while (j+1 < idx.length && idx[j+1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k=i;k<=j;k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
function spearman(xs, ys){
  const n = xs.length;
  if (n < 3) return { rho: NaN, p: NaN, n };
  const rx = ranks(xs), ry = ranks(ys);
  const mx = rx.reduce((a,b)=>a+b,0)/n, my = ry.reduce((a,b)=>a+b,0)/n;
  let sxy=0, sxx=0, syy=0;
  for (let i=0;i<n;i++){ const a=rx[i]-mx, b=ry[i]-my; sxy+=a*b; sxx+=a*a; syy+=b*b; }
  if (sxx===0 || syy===0) return { rho: NaN, p: NaN, n };   // 片方が全部同値
  const rho = sxy/Math.sqrt(sxx*syy);
  const t = rho*Math.sqrt((n-2)/Math.max(1e-15, 1-rho*rho));
  return { rho, p: tp2(t, n-2), n };
}

/* ── 五分位（同値は同じ帯に入れる） ─────────────────────────────────
   純度は 0 や 0.5 のような同値が多い。順位で機械的に5等分すると、
   同じ純度のランが帯をまたいで別々に数えられ、帯の境目が意味を失う。
   そこで「目標の位置を超えた**最初の別の値**」で切る。
   結果として帯の本数は等しくならないことがある（そのぶん本数を必ず出す）。 */
function quintiles(vals){
  const s = [...vals].sort((a,b)=>a-b), n = s.length;
  const cuts = [];
  for (let k=1;k<=4;k++){
    const target = s[Math.min(n-1, Math.floor(n*k/5))];
    let c = target;
    if (cuts.length && c <= cuts[cuts.length-1]){          // 前の切れ目と同じなら次の別の値へ
      const nxt = s.find(v => v > cuts[cuts.length-1]);
      if (nxt === undefined) continue; c = nxt;
    }
    cuts.push(c);
  }
  return cuts;   // 帯 i は [cuts[i-1], cuts[i]) ／ 最後は [cuts[3], ∞)
}
const bandOf = (v, cuts) => { let i=0; while (i<cuts.length && v >= cuts[i]) i++; return i; };

/* ── 読み込み：1ランにつき1点 ─────────────────────────────────────── */
const runs = [];
let skippedStuck = 0, skippedNoSpin = 0;
for (const f of FILES){
  const path = `${DIR}/${f}`;
  if (!existsSync(path)){ console.error('ない: '+path); process.exit(1); }
  for (const line of readFileSync(path,'utf8').trim().split('\n').filter(Boolean)){
    const r = JSON.parse(line);
    if (r.ended === 'stuck'){ skippedStuck++; continue; }
    const best = (r.spins||[]).reduce((b,s)=>(!b||s.t>b.t)?s:b, null);
    if (!best){ skippedNoSpin++; continue; }
    const den = (best.ic||0) + (best.sc||0);
    if (!den){ skippedNoSpin++; continue; }
    runs.push({ policy: f.replace('.jsonl',''), seed: r.seed, money: r.money,
                cui: best.cui||{}, den, mmul: best.mmul, madd: best.madd, t: best.t });
  }
}

console.log('■ 母数');
console.log('  読んだ方策 '+FILES.length+'／ラン '+runs.length+'本（stuck で除外 '+skippedStuck+'・スピン無しで除外 '+skippedNoSpin+'）');
console.log('  1ラン1点。x＝最高スピンの cui[軸]/(ic+sc)、y＝同じスピンの mmul（④）と madd（③）。');
console.log('  11方策を混ぜている（方策では分けない）。');

for (const [ja,en] of AX){
  const pts = runs.map(r => ({ x: (r.cui[en]||0)/r.den, m4: r.mmul, m3: r.madd, money: r.money }));
  console.log('\n════ '+ja+'（'+en+'） ════');

  for (const [tag, sel] of [['純度0を含む', pts], ['純度0を除く', pts.filter(p=>p.x>0)]]){
    const n = sel.length;
    console.log('\n── '+tag+'（'+n+'本）');
    if (n < 5){ console.log('   本数が足りない'); continue; }
    const cuts = quintiles(sel.map(p=>p.x));
    const label = i => {
      const lo = i===0 ? 0 : cuts[i-1], hi = i<cuts.length ? cuts[i] : null;
      return (r1(lo*100)+'%')+' 〜 '+(hi===null ? '100%' : r1(hi*100)+'%未満');
    };
    console.log('   帯                    本数    ④中央値   ③中央値   最終所持金の中央値');
    for (let i=0;i<=cuts.length;i++){
      const g = sel.filter(p => bandOf(p.x, cuts) === i);
      if (!g.length) continue;
      console.log('   '+label(i).padEnd(20,' ')+String(g.length).padStart(5)
        +'   '+('×'+r2(med(g.map(p=>p.m4)))).padStart(8)
        +'   '+('+'+r2(med(g.map(p=>p.m3)))).padStart(8)
        +'   '+yen(med(g.map(p=>p.money))).padStart(14));
    }
    console.log('   帯の切れ目：'+cuts.map(c=>r1(c*100)+'%').join(' / '));

    for (const [nm, key] of [['④（mmul）','m4'], ['③（madd）','m3']]){
      const s = spearman(sel.map(p=>p.x), sel.map(p=>p[key]));
      const sig = Number.isFinite(s.p) && s.p < 0.05;
      const dir = !Number.isFinite(s.rho) ? '判定不能' : !sig ? 'ほぼ0（有意でない）' : s.rho > 0 ? '正' : '負';
      console.log('   純度 vs '+nm+'：ρ='+(Number.isFinite(s.rho)?(s.rho>=0?'+':'')+r3(s.rho):'—')
        +'　p='+(Number.isFinite(s.p)?(s.p<0.001?'<0.001':r3(s.p)):'—')
        +(sig?'（有意）':'')+'　→ '+dir);
    }
  }
}
