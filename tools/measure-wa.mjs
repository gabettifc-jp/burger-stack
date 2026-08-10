// burger-stack 和軸の測定ツール（開発用・依存: playwright-core + Chromium）。
// 判定基準は LOG.md「和軸の測定：事前登録した判定基準」に測定前に確定済み。ここは計測のみ。
//   node tools/measure-wa.mjs > /tmp/wa.json
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'url';

const exe = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';
const url = 'file://' + fileURLToPath(new URL('../index.html', import.meta.url));
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'load' });

// 共通ヘルパを window に載せる（各 evaluate から使う）。temporalBonus は collect を呼ばないので空のまま。
await page.evaluate(() => {
  const I = window.CONFIG.items;
  window.__init = Object.fromEntries(Object.keys(I).map(n => [n, I[n].count]));  // 初期無印デッキ
  window.__wa = Object.keys(I).filter(n => I[n].cuisine === 'wa');
  window.__setDeck = (counts) => { for (const n in I) I[n].count = 0; for (const k in counts) if (I[k]) I[k].count = counts[k]; };
  window.__pileTot = (counts, pile) => Object.keys(counts).reduce((s,n)=> s + (I[n].pile===pile ? counts[n] : 0), 0);
  window.__avg = (N, counts) => { if (counts) window.__setDeck(counts); let s=0,n=0; for (let k=0;k<N;k++){ const b=window.buildBurger(); if(!b) continue; s+=window.evaluate(b.stack).total; n++; } return n ? s/n : 0; };
  window.__mean = a => a.reduce((s,x)=>s+x,0)/a.length;
  // WA_ASSEMBLED（和10枚・納豆なし）と、その +納豆版
  window.__WA = { "ライスバンズ":2, "もち":1, "きんぴら":1, "のり":1, "豆腐":1, "たけのこ":1, "かつおぶし":1, "みそ":1, "テリヤキソース":1 }; // 計10 和
  // 無印中心デッキ（初期そのもの）は __init
});

const out = { settings: {}, results: {} };

// 設定スナップショット
out.settings = await page.evaluate(() => {
  const I = window.CONFIG.items, P = window.CONFIG.params;
  const eff = {}; for (const n of Object.keys(I)) if (I[n].effect && I[n].effect.id) eff[n] = { base:I[n].base, ...I[n].effect };
  return { tiers: P.tiers, comboBonus: P.comboBonus, offer: P.offer, tierBonus: P.tierBonus, waEffects: eff,
           initDeck: Object.fromEntries(Object.entries(I).filter(([,it])=>it.count>0).map(([n,it])=>[n,it.count])) };
});

// ===== 1. カードごとの寄与 =====
out.results.contribution = await page.evaluate(() => {
  const I = window.CONFIG.items, N = 6000;
  const wa = window.__wa;
  const decks = { muji: {...window.__init}, wa: {...window.__WA} };
  const res = {};
  for (const [label, base] of Object.entries(decks)){
    const baseAvg = window.__avg(N, base);
    res[label] = { baseAvg: +baseAvg.toFixed(1), cards: {} };
    for (const name of wa){
      const full = window.__avg(N, { ...base, [name]: (base[name]||0)+1 });
      // 素の無印版（効果と軸タグを外す）
      const it = I[name], se = it.effect, sc = it.cuisine; it.effect = { id:null, kind:null }; it.cuisine = 'none';
      const vanilla = window.__avg(N, { ...base, [name]: (base[name]||0)+1 });
      it.effect = se; it.cuisine = sc;
      res[label].cards[name] = { full:+(full-baseAvg).toFixed(1), vanilla:+(vanilla-baseAvg).toFixed(1), effectValue:+(full-vanilla).toFixed(1) };
    }
  }
  // 死にカード（和デッキで効果価値 <= baseAvg*0.01）
  const noise = res.wa.baseAvg * 0.01;
  res.deadCardsWaBaseline = Object.entries(res.wa.cards).filter(([,v]) => v.effectValue <= noise).map(([n,v]) => ({ name:n, effectValue:v.effectValue }));
  res.noiseThreshold = +noise.toFixed(1);
  return res;
});

// ===== 3. 納豆の期待値 =====
out.results.natto = await page.evaluate(() => {
  const N = 8000;
  const waNo = { ...window.__WA }; const waYes = { ...window.__WA, "納豆":1 };
  const mujiNo = { ...window.__init }; const mujiYes = { ...window.__init, "納豆":1 };
  const a = window.__avg(N, waNo), b = window.__avg(N, waYes);
  const c = window.__avg(N, mujiNo), d = window.__avg(N, mujiYes);
  return { waWithout:+a.toFixed(1), waWith:+b.toFixed(1), waDelta:+(b-a).toFixed(1),
           mujiWithout:+c.toFixed(1), mujiWith:+d.toFixed(1), mujiDelta:+(d-c).toFixed(1) };
});

// ===== 4. もちの成長速度 =====
out.results.mochi = await page.evaluate(() => {
  const I = window.CONFIG.items, N = 8000;
  const per = I["もち"].effect.per, base = I["もち"].base;
  const k = Math.ceil((20 - base) / per);
  // base10 と base20 のもちを和デッキに入れた平均得点差（成長の得点インパクト）
  const deck = { ...window.__WA, "もち":2 };
  const at10 = window.__avg(N, deck);
  I["もち"].base = 20; const at20 = window.__avg(N, deck); I["もち"].base = base;
  return { base, per, burgersTo20: k, avgAtBase10:+at10.toFixed(1), avgAtBase20:+at20.toFixed(1), growthImpact:+(at20-at10).toFixed(1) };
});

// ===== 5. かつおぶしの除外効果 =====
out.results.katsuobushi = await page.evaluate(() => {
  const N = 8000;
  // (a) 効果価値（和デッキ）: 既に contribution にあるが単独でも出す
  const base = { ...window.__WA }; delete base["かつおぶし"];
  const baseAvg = window.__avg(N, base);
  const withK = window.__avg(N, { ...base, "かつおぶし":1 });
  // (b) 希釈低下: 混成デッキ（初期無印）から弱い無印1枚（ピクルス base4）を抜く
  const mixAvg = window.__avg(N, { ...window.__init });
  const thin = { ...window.__init }; thin["ピクルス"] = Math.max(0,(thin["ピクルス"]||0)-1);
  const thinAvg = window.__avg(N, thin);
  // (c) かつおぶしを繰り返し撃つ＝和デッキからかつおぶしを1枚ずつ減らす（自己除外）
  const curve = []; const d = { ...window.__WA, "かつおぶし":3 };
  for (let kk=3; kk>=0; kk--){ d["かつおぶし"]=kk; if (kk===0) delete d["かつおぶし"]; curve.push({ katsuo:kk, avg:+window.__avg(4000, {...d}).toFixed(1) }); }
  return { effectValueWa:+(withK-baseAvg).toFixed(1), mixAvg:+mixAvg.toFixed(1), thinAvg:+thinAvg.toFixed(1),
           dilutionBenefit:+(thinAvg-mixAvg).toFixed(1), selfConsumeCurve: curve };
});

// ===== 6. 到達可能性 =====
out.results.reach = await page.evaluate(() => {
  const I = window.CONFIG.items;
  const waBun = window.__wa.filter(n=>I[n].pile==='bun');
  const waIng = window.__wa.filter(n=>I[n].pile==='ingredient');
  const waSauce = window.__wa.filter(n=>I[n].pile==='sauce');
  function sim(rounds){
    const c = { ...window.__init };
    const cnt = (arr)=>arr.reduce((s,n)=>s+(c[n]||0),0);
    for (let r=0;r<rounds;r++){
      if (cnt(waBun)===0){ c[waBun[0]]=(c[waBun[0]]||0)+1; continue; }        // まず和バンズ
      if (cnt(waSauce)===0){ c[waSauce[0]]=(c[waSauce[0]]||0)+1; continue; }  // まず和ソース
      const removableMuji = Object.keys(c).filter(n=>c[n]>0 && I[n].cuisine==='none' && window.__pileTot(c,I[n].pile)>=2);
      if (removableMuji.length && r%2===0){ const t=removableMuji.sort((a,b)=>I[a].base-I[b].base)[0]; c[t]-=1; if(c[t]<=0) delete c[t]; }
      else { const n=waIng[r%waIng.length]; c[n]=(c[n]||0)+1; }               // 和具材を追加
    }
    return c;
  }
  function boardStats(counts, N){
    window.__setDeck(counts); let ge3=0, sumWa=0, n=0;
    for (let k=0;k<N;k++){ const b=window.buildBurger(); if(!b) continue; const w=b.stack.filter(x=>I[x].cuisine==='wa').length; if(w>=3) ge3++; sumWa+=w; n++; }
    return { pGe3:+(ge3/n*100).toFixed(1), meanWa:+(sumWa/n).toFixed(2) };
  }
  const summ = (c)=>{ const waTot=window.__wa.reduce((s,n)=>s+(c[n]||0),0); const mujiTot=Object.keys(c).reduce((s,n)=>s+(I[n].cuisine==='none'?(c[n]||0):0),0); return { deckWa:waTot, deckMuji:mujiTot, total:waTot+mujiTot }; };
  const d20 = sim(20), d50 = sim(50);
  return { r20: { ...summ(d20), board: boardStats(d20, 6000), deck:d20 },
           r50: { ...summ(d50), board: boardStats(d50, 6000), deck:d50 } };
});

// ===== 7. 削除の強さ =====
out.results.removalStrength = await page.evaluate(() => {
  const I = window.CONFIG.items, N = 6000;
  const wa = window.__wa;
  // A: 毎回 和を1枚追加（和具材/バンズ/ソースを巡回）。まず和バンズ・ソースを1枚ずつ確保。
  function policyAdd(rounds){ const c={...window.__init}; const waBun=wa.filter(n=>I[n].pile==='bun'), waSauce=wa.filter(n=>I[n].pile==='sauce'), waIng=wa.filter(n=>I[n].pile==='ingredient');
    for(let r=0;r<rounds;r++){ if(r===0){c[waBun[0]]=(c[waBun[0]]||0)+1;continue;} if(r===1){c[waSauce[0]]=(c[waSauce[0]]||0)+1;continue;} const n=waIng[(r-2)%waIng.length]; c[n]=(c[n]||0)+1; } return c; }
  // B: 毎回 無印を1枚削除（山の最後の1枚は残す）。削れなくなったら何もしない。
  function policyRemove(rounds){ const c={...window.__init};
    for(let r=0;r<rounds;r++){ const rem=Object.keys(c).filter(n=>c[n]>0 && I[n].cuisine==='none' && window.__pileTot(c,I[n].pile)>=2); if(!rem.length) break; const t=rem.sort((a,b)=>I[a].base-I[b].base)[0]; c[t]-=1; if(c[t]<=0) delete c[t]; } return c; }
  const a20=window.__avg(N, policyAdd(20)), a50=window.__avg(N, policyAdd(50));
  const b20=window.__avg(N, policyRemove(20)), b50=window.__avg(N, policyRemove(50));
  return { add20:+a20.toFixed(1), add50:+a50.toFixed(1), remove20:+b20.toFixed(1), remove50:+b50.toFixed(1) };
});

// ===== 2. 支配戦略の検出（重いので最後）=====
out.results.dominant = await page.evaluate(() => {
  const I = window.CONFIG.items, N = 300;
  const buns=["ライスバンズ","食パン"], sauces=["みそ","テリヤキソース"];
  const ings=["もち","きんぴら","のり","納豆","豆腐","かつおぶし","たけのこ"];
  // cap2 の多重集合を列挙
  function multisets(items, total, cap){ const res=[]; const rec=(i, left, acc)=>{ if(i===items.length){ if(left===0) res.push({...acc}); return; } for(let v=0; v<=Math.min(cap,left); v++){ acc[items[i]]=v; rec(i+1,left-v,acc); } delete acc[items[i]]; }; rec(0,total,{}); return res; };
  const bunSets=multisets(buns,2,2), sauceSets=multisets(sauces,2,2), ingSets=multisets(ings,6,2);
  const comps=[]; let evalCount=0;
  for(const bs of bunSets) for(const ss of sauceSets) for(const is of ingSets){
    const deck={}; for(const k in bs) if(bs[k]) deck[k]=bs[k]; for(const k in ss) if(ss[k]) deck[k]=ss[k]; for(const k in is) if(is[k]) deck[k]=is[k];
    const avg=window.__avg(N, deck); evalCount++;
    comps.push({ deck, avg:+avg.toFixed(1) });
  }
  comps.sort((a,b)=>b.avg-a.avg);
  const top1=comps[0].avg; const top10=comps.slice(0,10);
  const within70=top10.filter(c=>c.avg>=top1*0.7).length;
  return { compositions: comps.length, samplesPer: N, top1, top10Within70of1: within70,
           pass: within70===10, top10: top10.map(c=>({avg:c.avg, deck:c.deck})), worstOfSpace: comps[comps.length-1].avg };
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
