/* 測定 M1：Wave 6 時点の基準線を取る。
   ゲームのコードは1行も変更しない。実プレイ経路（実UIのタップ・クリック）だけで回す。
   使い方: node tools/m1-measure.mjs [--seeds 30] [--par 3] [--only a,b] [--goal10 10]
   出力: tools/out/m1-<goal>.jsonl（生データ・コミットしない）＋ 標準出力に進捗 */
import pkg from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pkg;
import fs from 'fs';
import path from 'path';

const GAME = 'file:///home/user/burger-stack/index.html';
const OUT = '/home/user/burger-stack/tools/out';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const NSEEDS = +arg('seeds', 30), PAR = +arg('par', 3), SEED0 = +arg('seed0', 1001);
const ONLY = arg('only', 'a,b,c,d,e').split(',');
const GOAL = +arg('goal', 5), N10 = +arg('n10', 10);
const INJECT = (arg('inject', '') || '').split(',').filter(Boolean);   // C3 用：ラン開始時に1枚だけ足すカード
const TAG = arg('tag', '');

/* ── 測定側の乱数（方策 e 用。ゲームの grand とは別物） ── */
function mulberry(a){ return () => { a |= 0; a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/* ── 画面状態の軽い読み取り（毎ループ） ── */
const LIGHT = () => {
  const off = document.getElementById('offer');
  return { show: off.classList.contains('show'), res: off.classList.contains('result'),
    cleared: off.classList.contains('cleared'),
    title: (off.querySelector('.offer-title') || {}).textContent || '',
    done: /完成/.test(document.getElementById('progress').textContent),
    locked: (typeof collectLocked !== 'undefined') && collectLocked,
    spins: runSpins, days: daysSurvived, money, active: runActive };
};
/* ── 完成時の盤面（回収の前に読む） ── */
const BOARD = () => (typeof plan !== 'undefined' && plan) ? {
  stack: plan.stack.slice(), total: plan.sc.total,
  base: plan.sc.base, grow: plan.sc.grow, add: plan.sc.add, mult: +plan.sc.mult.toFixed(4),
  piles: (() => { const c = { bun:0, ingredient:0, sauce:0 };
    for (const x of window.RUN.deck()) c[CONFIG.items[x.name].pile]++; return c; })(),
  deckN: window.RUN.deck().length,
  tiersCfg: { i: CONFIG.params.tiers.ingredients, s: CONFIG.params.tiers.sauces },
} : null;
/* ── 3択の札（軸・効果の有無つき） ── */
const OFFER = () => [...document.querySelectorAll('#offer .offer-card')].map(c => {
  const nm = c.querySelector('.nm').textContent; const it = CONFIG.items[nm] || {};
  return { nm, cui: it.cuisine || 'none', pile: it.pile, hasEffect: !!(it.effect && it.effect.id),
    cant: c.classList.contains('cant') };
});
/* ── 店の中身 ── */
const SHOP = () => ({
  cards: [...document.querySelectorAll('#offer .shopcard:not(.artcard)')].map(c => {
    const nm = c.querySelector('.nm').textContent; const it = CONFIG.items[nm] || {};
    return { nm, cui: it.cuisine || 'none', pile: it.pile,
      price: +((c.querySelector('.price') || { textContent:'' }).textContent.replace(/[^0-9]/g, '') || 0),
      cant: c.classList.contains('cant') }; }),
  btns: [...document.querySelectorAll('#offer .shopbtn')].map(x => ({
    label: x.textContent.split('¥')[0].trim(),
    price: +((x.querySelector('.price') || { textContent:'' }).textContent.replace(/[^0-9]/g, '') || 0),
    cant: x.classList.contains('cant') })),
  arts: [...document.querySelectorAll('#offer .artcard')].map(x => ({
    nm: x.querySelector('.nm').textContent,
    price: +((x.querySelector('.price') || { textContent:'' }).textContent.replace(/[^0-9]/g, '') || 0),
    cant: x.classList.contains('cant') })),
  money, deckAxis: (() => { const c = {}; for (const x of window.RUN.deck()) {
    const cu = CONFIG.items[x.name].cuisine || 'none'; c[cu] = (c[cu] || 0) + 1; } return c; })(),
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tap = p => p.evaluate(() => { const el = document.getElementById('tap');
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, button:0 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles:true })); });
const clickSel = (p, sel) => p.evaluate(s => { const x = document.querySelector(s); if (x) x.click(); return !!x; }, sel);
const clickIdx = (p, sel, i) => p.evaluate(([s, k]) => { const a = [...document.querySelectorAll(s)]; if (a[k]) a[k].click(); return !!a[k]; }, [sel, i]);
const clickText = (p, sel, re) => p.evaluate(([s, r]) => { const x = [...document.querySelectorAll(s)].find(n => new RegExp(r).test(n.textContent)); if (x) x.click(); return !!x; }, [sel, re]);

/* ══════════════════ 1ラン ══════════════════ */
async function runOne(browser, seed, policy, dayGoal){
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PE ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('CE ' + m.text()); });
  const rnd = mulberry(seed * 977 + policy.charCodeAt(0));
  await page.goto(GAME);
  await page.waitForFunction(() => typeof window.RUN !== 'undefined' && typeof CONFIG !== 'undefined');
  // 変えるのは skipFx（演出の省略）と dayGoal だけ。他は既定のまま。
  await page.evaluate(([sd, dg]) => {
    try { localStorage.clear(); } catch(e){}
    const set = () => { CONFIG.params.skipFx = true; CONFIG.params.run.dayGoal = dg; };
    set(); window.RUN.setPendingSeed(sd); window.RUN.reset(); set();
  }, [seed, dayGoal]);
  if (INJECT.length) await page.evaluate(ns => { for (const n of ns) window.RUN.addInstance(n, 0); }, INJECT);   // C3：希釈の観測用

  const spins = [];            // スピンごと（盤面は plog に無いのでここで拾う）
  const shopVisits = [];       // 来店ごとの金の流れ
  let outcome = null, stalled = null, lastSpin = -1, guard = 0, sameStateFor = 0, prevKey = '';

  while (guard++ < 60000){
    const st = await page.evaluate(LIGHT);
    if (st.res){ outcome = st.cleared ? 'cleared' : 'broke'; break; }

    const key = `${st.show}|${st.title}|${st.done}|${st.spins}|${st.days}|${st.money}`;
    sameStateFor = (key === prevKey) ? sameStateFor + 1 : 0; prevKey = key;
    if (sameStateFor > 400){   // 同じ画面のまま進まない＝停止（詰み）。直さずに記録して次へ。
      stalled = { spin: st.spins, day: st.days, screen: st.show ? st.title : (st.done ? '完成' : '積み中'), money: st.money };
      outcome = 'stalled'; break;
    }

    if (st.show){
      if (/家賃/.test(st.title)){
        await clickIdx(page, '#offer .offer-buy', 0);          // 支払う／結果を見る
      } else if (/店（/.test(st.title)){
        const sh = await page.evaluate(SHOP);
        const before = sh.money;
        const acts = await doShop(page, policy, rnd);
        const after = await page.evaluate(() => money);
        shopVisits.push({ day: st.days, before, after, spent: before - after, acts });
        await clickText(page, '#offer .offer-skip', '店を出る');
      } else if (/取り除く/.test(st.title)){
        await clickText(page, '#offer .offer-skip', '店に戻る');
      } else {                                                  // 3択
        const cards = await page.evaluate(OFFER);
        const deckAxis = await page.evaluate(() => { const c = {};
          for (const x of window.RUN.deck()) { const cu = CONFIG.items[x.name].cuisine || 'none'; c[cu] = (c[cu]||0)+1; } return c; });
        const k = pickOffer(policy, cards, deckAxis, rnd);
        if (k == null) await clickText(page, '#offer .offer-skip', '見送');
        else await clickIdx(page, '#offer .offer-card', k);
      }
      await sleep(12); continue;
    }
    if (st.done && !st.locked){                                 // 完成 → 盤面を読んでから回収
      if (st.spins !== lastSpin){
        const bd = await page.evaluate(BOARD);
        if (bd) spins.push(Object.assign({ spin: st.spins + 1, day: st.days + 1 }, bd));
        lastSpin = st.spins;
      }
      await tap(page); await sleep(12); continue;
    }
    if (st.done){ await sleep(20); continue; }                   // 入力ロック中
    await tap(page); await sleep(12);                            // 積む（skipFx なので1タップで完成まで）
  }

  const plog = await page.evaluate(() => {
    const runs = JSON.parse(localStorage.getItem('bstack.plog.runs.v1') || '[]');
    const cur = JSON.parse(localStorage.getItem('bstack.plog.current.v1') || 'null');
    return runs.length ? runs[runs.length - 1] : cur;
  });
  const fin = await page.evaluate(() => ({
    days: daysSurvived, spins: runSpins, ings: CONFIG.params.tiers.ingredients, sauces: CONFIG.params.tiers.sauces,
    deck: window.RUN.deck().map(x => ({ n: x.name, g: x.g, pb: x.pb, pm: x.pm })),
    axis: (() => { const c = {}; for (const x of window.RUN.deck()) {
      const cu = CONFIG.items[x.name].cuisine || 'none'; c[cu] = (c[cu]||0)+1; } return c; })(),
    money,
  }));
  await page.close();
  return { seed, policy, dayGoal, outcome, stalled, errs, spins, shopVisits, plog, fin };
}

/* ── 3択の方策。返り値＝押すカードの index、null なら見送り ── */
function pickOffer(policy, cards, deckAxis, rnd){
  const ok = cards.map((c, i) => ({ c, i })).filter(x => !x.c.cant);
  if (!ok.length) return null;
  if (policy === 'a' || policy === 'b') return ok[0].i;                       // 左端固定
  if (policy === 'e') return ok[Math.floor(rnd() * ok.length)].i;             // 無作為
  if (policy === 'c'){                                                       // 単軸寄せ：デッキ最多軸を優先
    let best = null, bn = -1;
    for (const k of Object.keys(deckAxis)) if (k !== 'none' && deckAxis[k] > bn){ bn = deckAxis[k]; best = k; }
    const hit = ok.find(x => x.c.cui === best);
    return hit ? hit.i : ok[0].i;
  }
  if (policy === 'd'){                                                       // 薄く保つ：デッキに無い軸で、かつ効果がある札だけ取る
    const hit = ok.find(x => x.c.hasEffect && !(deckAxis[x.c.cui] > 0));
    return hit ? hit.i : null;
  }
  return ok[0].i;
}

const clickCard = (p, nm, isArt) => p.evaluate(([n, a]) => {
  const sel = a ? '#offer .artcard' : '#offer .shopcard:not(.artcard)';
  const c = [...document.querySelectorAll(sel)].find(x => x.querySelector('.nm').textContent === n);
  if (c) c.click(); return !!c; }, [nm, !!isArt]);

/* ── 店の方策。1来店の買い物を実行して、買ったものの配列を返す ── */
async function doShop(page, policy, rnd){
  const acts = [];
  for (let round = 0; round < 12; round++){
    const sh = await page.evaluate(SHOP);
    const slot = sh.btns.filter(x => !x.cant && /枠 \+1/.test(x.label));
    const cards = sh.cards.filter(x => !x.cant);
    const rem = sh.btns.find(x => !x.cant && /取り除く/.test(x.label));
    let did = null;

    if (policy === 'b'){                                                     // 貪欲（段数）：全額を段数枠に
      if (slot.length){ const t = slot.slice().sort((a,b)=>b.price-a.price)[0];   // 高い枠から（ソース枠を優先）
        await clickText(page, '#offer .shopbtn', t.label.replace(/[+]/g,'\\+')); did = { kind:'slot', name:t.label, price:t.price }; }
      else if (cards.length){ const t = cards.slice().sort((a,b)=>a.price-b.price)[0];
        await clickCard(page, t.nm, false); did = { kind:'card', name:t.nm, price:t.price }; }
    } else if (policy === 'd'){                                              // 薄く保つ：取り除きを優先・カードは買わない
      if (rem){
        await clickText(page, '#offer .shopbtn', '取り除く');
        await sleep(20);
        // 取り除き画面：その山に2枚以上あるもののうち、基礎点のいちばん低い個体を消す
        const gone = await page.evaluate(() => {
          const rows = [...document.querySelectorAll('#offer .remove-row')].filter(r => !r.classList.contains('off'));
          if (!rows.length) return null;
          const val = r => { const nm = r.querySelector('.nm').textContent; const it = CONFIG.items[nm] || {}; return (it.base||0); };
          rows.sort((a,b) => val(a) - val(b));
          const nm = rows[0].querySelector('.nm').textContent; rows[0].click(); return nm; });
        if (gone) did = { kind:'remove', name:gone, price:rem.price };
        else { await clickText(page, '#offer .offer-skip', '店に戻る'); break; }
      }
    } else if (policy === 'c'){                                              // 単軸寄せ：最多軸のカードを優先
      let best = null, bn = -1;
      for (const k of Object.keys(sh.deckAxis)) if (k !== 'none' && sh.deckAxis[k] > bn){ bn = sh.deckAxis[k]; best = k; }
      const t = cards.filter(x => x.cui === best).sort((a,b)=>a.price-b.price)[0]
             || cards.slice().sort((a,b)=>a.price-b.price)[0];
      if (t){ await clickCard(page, t.nm, false); did = { kind:'card', name:t.nm, price:t.price }; }
      else if (slot.length){ const s2 = slot.slice().sort((a,b)=>a.price-b.price)[0];
        await clickText(page, '#offer .shopbtn', s2.label.replace(/[+]/g,'\\+')); did = { kind:'slot', name:s2.label, price:s2.price }; }
    } else if (policy === 'e'){                                              // 無作為に買えるだけ
      const pool = [].concat(cards.map(x => ({ kind:'card', o:x })), slot.map(x => ({ kind:'slot', o:x })),
                             sh.arts.filter(x => !x.cant).map(x => ({ kind:'art', o:x })),
                             rem ? [{ kind:'remove', o:rem }] : []);
      if (pool.length){
        const t = pool[Math.floor(rnd() * pool.length)];
        if (t.kind === 'card' || t.kind === 'art'){ await clickCard(page, t.o.nm, t.kind === 'art');
          did = { kind:t.kind, name:t.o.nm, price:t.o.price }; }
        else if (t.kind === 'slot'){ await clickText(page, '#offer .shopbtn', t.o.label.replace(/[+]/g,'\\+'));
          did = { kind:'slot', name:t.o.label, price:t.o.price }; }
        else { await clickText(page, '#offer .shopbtn', '取り除く'); await sleep(20);
          const gone = await page.evaluate(() => { const rows = [...document.querySelectorAll('#offer .remove-row')].filter(r => !r.classList.contains('off'));
            if (!rows.length) return null; const k = Math.floor(Math.random() * rows.length);
            const nm = rows[k].querySelector('.nm').textContent; rows[k].click(); return nm; });
          if (gone) did = { kind:'remove', name:gone, price:t.o.price };
          else { await clickText(page, '#offer .offer-skip', '店に戻る'); break; } }
      }
    } else {                                                                 // a：安いものから順に買えるだけ（カード・枠・道具）
      const arts = sh.arts.filter(x => !x.cant);
      const pool = [].concat(cards.map(x => ({ kind:'card', o:x, price:x.price })),
                             slot.map(x => ({ kind:'slot', o:x, price:x.price })),
                             arts.map(x => ({ kind:'art', o:x, price:x.price })));
      if (pool.length){
        const t = pool.sort((x,y) => x.price - y.price)[0];
        if (t.kind === 'slot'){ await clickText(page, '#offer .shopbtn', t.o.label.replace(/[+]/g,'\\+'));
          did = { kind:'slot', name:t.o.label, price:t.price }; }
        else { await clickCard(page, t.o.nm, t.kind === 'art');
          did = { kind:t.kind, name:t.o.nm, price:t.price }; }
      }
    }
    if (!did) break;
    acts.push(did); await sleep(20);
    // 取り除き画面に残っていたら店に戻す
    const t2 = await page.evaluate(() => (document.querySelector('#offer .offer-title') || {}).textContent || '');
    if (/取り除く/.test(t2)) await clickText(page, '#offer .offer-skip', '店に戻る');
  }
  return acts;
}

/* ══════════════════ 実行 ══════════════════ */
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const jobs = [];
for (const pol of ONLY) for (let i = 0; i < NSEEDS; i++) jobs.push({ seed: SEED0 + i, policy: pol, dayGoal: GOAL });
console.log(`# ${jobs.length} ラン（方策 ${ONLY.join(',')} × シード ${SEED0}〜${SEED0+NSEEDS-1} / dayGoal ${GOAL}）並列 ${PAR}`);
const outFile = path.join(OUT, `m1-goal${GOAL}${TAG?'-'+TAG:''}.jsonl`);
fs.writeFileSync(outFile, '');
let done = 0; const t0 = Date.now();
async function worker(){
  while (jobs.length){
    const j = jobs.shift(); if (!j) break;
    let r;
    try { r = await runOne(browser, j.seed, j.policy, j.dayGoal); }
    catch(e){ r = { seed:j.seed, policy:j.policy, dayGoal:j.dayGoal, outcome:'error', errs:[String(e.message||e)], spins:[], shopVisits:[], plog:null, fin:null }; }
    fs.appendFileSync(outFile, JSON.stringify(r) + '\n');
    done++;
    const el = (Date.now() - t0) / 1000;
    process.stdout.write(`\r  ${done}/${done + jobs.length} 完了  ${el.toFixed(0)}s  (${(el/done).toFixed(1)}s/ラン)  最新: ${j.policy}/${j.seed} → ${r.outcome} ${r.fin?r.fin.days+'営業日':''}   `);
  }
}
await Promise.all(Array.from({ length: PAR }, worker));
await browser.close();
console.log(`\n# 完了 → ${outFile}`);
