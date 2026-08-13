// 測定 M2：序盤2営業日（10スピン）だけを実プレイ経路で回すハーネス（開発用・ゲーム本体とは別）。
//
// 目的：Wave 8 時点で「初日の壁」がどうなっているか、1営業日目に期待できる基礎点はいくつか、
//       m（軸の傾斜の速さ）をいくつにするかを知る。判定の基準は測定指示書 M2 §1 に固定済み。
//
// ゲームのコードは1行も変更しない。 実UIをタップして回す（内部関数の直接呼び出しでは代替しない）。
//
// 使い方（条件ごとに走らせる。並列に回してよい）:
//   node tools/m2-measure.mjs --policy=P --m=8 --from=2001 --to=2030 --out=tools/out/m2-P8.jsonl
//
//   --policy  P（基礎点重視）/ Q（軸重視）
//   --m       axisBias.m（4 または 8）
//   --from --to  シードの範囲（両端を含む）
//   --out     1行1ランの JSONL 出力先（tools/out/ は .gitignore 済み＝コミットしない）
//   --url     対象URL（既定：同梱の ../index.html）
//
// 条件（M2 §2）:
//   dayGoal は 5 のまま（進行度＝営業日/dayGoal を実プレイと同じにするため）。10スピンで打ち切る。
//   完走判定は使わず「10スピン到達」か「家賃を払えず終了」かで記録する。
//   rentEvery 5 / rentBase 300 / rentMul 1.4 はゲームの既定値のまま（触らない）。
//   演出のみ skipFx で省略する（計算層は同じ）。
//
// 方策の範囲（測定の解釈のために明記）:
//   3択は必ず取る（見送らない）。店で買うのはカードだけで、枠・リロール・削除・アーティファクトは買わない。
//   （M2 の方策表が「店」で言及しているのはカードの選び方だけであり、枠を買うと段数が変わって
//     B6「盤面の基礎点合計」の比較が崩れるため。買えたはずのもの＝所持金で足りたものは別に記録する。）
//   バンズの押し出しは「効果を持たないもの（ゴマバンズ）を優先、無ければいちばん古いもの」で固定。

import { chromium } from 'playwright-core';
import { fileURLToPath } from 'url';
import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const arg = (k, d) => { const m = process.argv.find(a => a.startsWith(`--${k}=`)); return m ? m.slice(k.length + 3) : d; };
const POLICY = arg('policy', 'P');
const M      = parseFloat(arg('m', '8'));
const FROM   = parseInt(arg('from', '2001'), 10);
const TO     = parseInt(arg('to', '2030'), 10);
const OUT    = arg('out', `tools/out/m2-${POLICY}${M}.jsonl`);
const TARGET = arg('url', 'file://' + fileURLToPath(new URL('../index.html', import.meta.url)));
const EXE    = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';
const SPINS  = parseInt(arg('spins', '10'), 10);

mkdirSync(dirname(OUT), { recursive: true });

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });

// 画面の状態を読む
const look = p => p.evaluate(() => {
  const el = document.getElementById('offer');
  return {
    show: el.classList.contains('show'),
    cls: el.className,
    title: (document.querySelector('#offer .offer-title') || {}).textContent || '',
    days: window.RUN.state().daysSurvived,
    money: window.RUN.state().money,
    active: window.RUN.state().runActive,
    done: /完成/.test(document.getElementById('progress').textContent),
  };
});
const tap = p => p.evaluate(() => {
  const el = document.getElementById('tap');
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
});

async function runOne(seed){
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PE ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('CE ' + m.text()); });
  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForTimeout(200);

  // シードを固定してランを開始し、そのあとで測定用の設定を入れる（reset は params を戻さない）
  await page.evaluate(([seed, m]) => {
    window.RUN.setPendingSeed(seed); window.RUN.reset();
    window.CONFIG.params.skipFx = true;
    window.CONFIG.params.completeLock = 0.001;      // 0 は falsy になるので使わない
    window.CONFIG.params.axisBias.m = m;
    try { localStorage.removeItem('bstack.plog.current.v1'); } catch(e){}
  }, [seed, M]);

  const spins = [];            // スピンごとの記録
  const offers = [];           // 3択の提示と選択
  const buys = [];             // 買ったもの
  const affordable = [];       // 買えたはずのもの（所持金で足りたもの）
  const bunEvents = [];        // バンズの入手と押し出し
  const mainSeq = [];          // 各スピン終了時点の主軸（決まるまでのスピン数を出す）
  let stopped = null;          // 停止（タップしても何も起きない）
  let ended = null;            // "10spins" | "broke"
  let rentsPaid = 0;           // 払った家賃の回数（rentEvery=5 なので10スピンで2回来る）

  // 10スピン回したあと、その営業日ぶんの家賃までは処理する（2営業日目の壁を見るため）。
  //   11個目を組み始める手前で止める。
  for (let guard = 0; guard < 800; guard++){
    if (spins.length >= SPINS && rentsPaid >= 2) break;
    const st = await look(page);
    if (!st.active){ ended = /broke/.test(st.cls) ? 'broke' : (ended || 'ended'); break; }

    // ── 待機中：1個組んで得点を回収する ──
    if (!st.show){
      if (spins.length >= SPINS) break;      // 11個目は組まない
      let tapped = 0;
      for (let k = 0; k < 14 && !(await page.evaluate(() => /完成/.test(document.getElementById('progress').textContent))); k++){
        await tap(page); tapped++; await page.waitForTimeout(60);
      }
      const built = await page.evaluate(() => {
        if (typeof plan === 'undefined' || !plan) return null;
        const items = window.CONFIG.items;
        return {
          stack: plan.stack.slice(),
          baseArr: plan.sc.baseArr.slice(),
          isBun: plan.stack.map(n => (items[n] || {}).pile === 'bun'),
          base: plan.sc.base, grow: plan.sc.grow, add: plan.sc.add, mult: +plan.sc.mult.toFixed(4),
          total: plan.sc.total, tiers: plan.stack.length,
          deckN: window.RUN.deck().length,
        };
      });
      if (!built){
        stopped = { spin: spins.length + 1, taps: tapped, where: '組めない（plan が null）' };
        break;
      }
      // 回収（完成状態を消化）
      for (let k = 0; k < 14 && (await page.evaluate(() => /完成/.test(document.getElementById('progress').textContent))); k++){
        await tap(page); await page.waitForTimeout(60);
      }
      const after = await page.evaluate(() => ({
        money: window.RUN.state().money, days: window.RUN.state().daysSurvived,
        deck: window.RUN.deck().map(x => x.name), main: window.RUN.mainCuisine(),
        axis: (function(){ const c = {}; for (const x of window.RUN.deck()){ const cu = (window.CONFIG.items[x.name]||{}).cuisine || 'none'; c[cu] = (c[cu]||0)+1; } return c; })(),
      }));
      // 盤面の基礎点合計（バンズを除く）
      let baseNoBun = 0;
      for (let i = 0; i < built.baseArr.length; i++) if (!built.isBun[i]) baseNoBun += built.baseArr[i];
      spins.push({ spin: spins.length + 1, day: st.days + 1, total: built.total, tiers: built.tiers,
                   base: built.base, baseNoBun, grow: built.grow, add: built.add, mult: built.mult,
                   money: after.money, deckN: after.deck.length, main: after.main, axis: after.axis,
                   stack: built.stack, baseArr: built.baseArr });
      mainSeq.push(after.main);
      continue;
    }

    // ── バンズの入手：ゴマバンズを優先して押し出す。無ければいちばん古いもの ──
    if (/バンズを1枚入手/.test(st.title)){
      const ev = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('#offer .offer-card.bunnew')];
        if (cards.length > 1) cards[0].click();          // 選り好み（2択）は左を取る＝固定
        const rows = [...document.querySelectorAll('#offer .bunslots .remove-row')];
        const slots = window.RUN.buns();
        const gained = (cards[0] && (cards[0].querySelector('.nm')||{}).textContent) || null;
        if (!rows.length){                                // 空きがある＝そのまま受け取る
          const g = [...document.querySelectorAll('#offer .offer-buy')].find(x => /受け取る/.test(x.textContent));
          if (g) g.click();
          return { gained, pushed: null, slots: slots.map(s => s.name) };
        }
        // ゴマバンズ（効果なし）を優先。無ければ id がいちばん小さい＝いちばん古いもの
        let idx = slots.findIndex(s => s.name === 'ゴマバンズ');
        if (idx < 0){ let best = 0; for (let i = 1; i < slots.length; i++) if (slots[i].id < slots[best].id) best = i; idx = best; }
        const pushed = slots[idx].name;
        rows[idx].click();
        return { gained, pushed, slots: slots.map(s => s.name) };
      });
      bunEvents.push(Object.assign({ spin: spins.length, day: st.days + 1 }, ev));
      await page.waitForTimeout(90);
      continue;
    }

    // ── 家賃 ──
    if (/家賃の支払い/.test(st.title)){
      const paid = await page.evaluate(() => {
        const pay = [...document.querySelectorAll('#offer .offer-buy')].find(x => /支払う/.test(x.textContent));
        if (pay){ pay.click(); return true; }
        const res = [...document.querySelectorAll('#offer .offer-buy')].find(x => /結果|前借り/.test(x.textContent));
        if (res) res.click();
        return false;
      });
      await page.waitForTimeout(120);
      if (!paid){ ended = 'broke'; break; }
      rentsPaid++;
      continue;
    }

    // ── 店：方策に従ってカードだけ買う ──
    if (/店（/.test(st.title)){
      // 買えたはずのもの（所持金で足りたもの）を先に記録する
      const avail = await page.evaluate(() => {
        const money = window.RUN.state().money;
        const cards = [...document.querySelectorAll('#offer .offer-cards .shopcard:not(.artcard)')].map(c => ({
          kind:'card', name:(c.querySelector('.nm')||{}).textContent||'',
          cost:+(((c.querySelector('.price')||{}).textContent||'').replace(/[^0-9]/g,'')||0) }));
        const arts = [...document.querySelectorAll('#offer .offer-cards .artcard')].map(c => ({
          kind:'artifact', name:(c.querySelector('.nm')||{}).textContent||'',
          cost:+(((c.querySelector('.price')||{}).textContent||'').replace(/[^0-9]/g,'')||0) }));
        const btns = [...document.querySelectorAll('#offer .shop-acts .shopbtn')].map(x => ({
          kind:'action', name:(x.textContent||'').replace(/\s+/g,' ').replace(/¥\d+.*/,'').trim(),
          cost:+(((x.querySelector('.price')||{}).textContent||'').replace(/[^0-9]/g,'')||0),
          off:x.classList.contains('cant') }));
        return { money, cards, arts, btns };
      });
      affordable.push({ day: st.days + 1, money: avail.money,
        cards: avail.cards.filter(c => c.cost <= avail.money),
        arts:  avail.arts.filter(c => c.cost <= avail.money),
        actions: avail.btns.filter(x => !x.off && x.cost <= avail.money) });

      // カードを買う（方策 P：安い順／方策 Q：主軸を優先、無ければ安い順）
      for (let k = 0; k < 12; k++){
        const got = await page.evaluate((policy) => {
          const money = window.RUN.state().money;
          const main = window.RUN.mainCuisine();
          const cs = [...document.querySelectorAll('#offer .offer-cards .shopcard:not(.artcard)')]
            .map(c => ({ el:c, name:(c.querySelector('.nm')||{}).textContent||'',
                         cost:+(((c.querySelector('.price')||{}).textContent||'').replace(/[^0-9]/g,'')||0) }))
            .filter(c => c.cost <= money);
          if (!cs.length) return null;
          const cui = nm => (window.CONFIG.items[nm]||{}).cuisine || 'none';
          let pick;
          if (policy === 'Q' && main !== 'none'){
            const inMain = cs.filter(c => cui(c.name) === main);
            pick = (inMain.length ? inMain : cs).slice().sort((a,b)=> a.cost - b.cost)[0];
          } else {
            pick = cs.slice().sort((a,b)=> a.cost - b.cost)[0];
          }
          pick.el.click();
          return { name: pick.name, cost: pick.cost };
        }, POLICY);
        if (!got) break;
        buys.push(Object.assign({ day: st.days + 1 }, got));
        await page.waitForTimeout(90);
      }
      await page.evaluate(() => { const x = [...document.querySelectorAll('#offer .offer-skip')].find(y => /店を出る/.test(y.textContent)); if (x) x.click(); });
      await page.waitForTimeout(100);
      continue;
    }

    // ── 新陳代謝などの押し出し画面（アーティファクトは買わないので通常は出ない） ──
    if (/押し出す|減らす|軸を選ぶ/.test(st.title)){
      await page.evaluate(() => { const r = document.querySelector('#offer .remove-row:not(.off)') || document.querySelector('#offer .offer-card')
        || [...document.querySelectorAll('#offer .offer-buy')][0]; if (r) r.click(); });
      await page.waitForTimeout(100);
      continue;
    }

    // ── 3択：方策に従って必ず1枚取る ──
    {
      const shown = await page.evaluate(() => [...document.querySelectorAll('#offer .offer-card')].map(c => {
        const nm = (c.querySelector('.nm')||{}).textContent||''; const it = window.CONFIG.items[nm] || {};
        return { name: nm, cuisine: it.cuisine, rar: it.rar, base: it.base };
      }));
      if (!shown.length){
        // 何も並んでいない＝見送りだけの画面。押して進める
        const adv = await page.evaluate(() => { const s = document.querySelector('#offer .offer-skip'); if (s){ s.click(); return true; } return false; });
        if (!adv){ stopped = { spin: spins.length + 1, where: '3択が空で進めない: ' + st.title }; break; }
        await page.waitForTimeout(90); continue;
      }
      const took = await page.evaluate((policy) => {
        const cards = [...document.querySelectorAll('#offer .offer-card')].map(c => {
          const nm = (c.querySelector('.nm')||{}).textContent||''; const it = window.CONFIG.items[nm] || {};
          return { el:c, name:nm, cuisine:it.cuisine, base:(it.base||0) };
        });
        const main = window.RUN.mainCuisine();
        let pick;
        if (policy === 'Q' && main !== 'none'){
          const inMain = cards.filter(c => c.cuisine === main);
          //   主軸のカードが無ければ基礎点がいちばん高いもの（同値なら左）
          pick = inMain.length ? inMain.slice().sort((a,b)=> b.base - a.base)[0]
                               : cards.slice().sort((a,b)=> b.base - a.base)[0];
        } else {
          //   方策 P、および Q の1枚目（主軸がまだ無い）＝基礎点がいちばん高いもの（同値なら左）
          pick = cards.slice().sort((a,b)=> b.base - a.base)[0];
        }
        pick.el.click();
        return { name: pick.name, cuisine: pick.cuisine, base: pick.base };
      }, POLICY);
      offers.push({ spin: spins.length, day: st.days + 1, shown, picked: took });
      await page.waitForTimeout(100);
      continue;
    }
  }

  if (!ended && !stopped) ended = (spins.length >= SPINS && rentsPaid >= 2) ? '10spins' : 'unknown';
  const fin = await page.evaluate(() => ({
    days: window.RUN.state().daysSurvived, money: window.RUN.state().money,
    active: window.RUN.state().runActive, cls: document.getElementById('offer').className,
    deck: window.RUN.deck().map(x => x.name), main: window.RUN.mainCuisine(),
    axis: (function(){ const c = {}; for (const x of window.RUN.deck()){ const cu = (window.CONFIG.items[x.name]||{}).cuisine || 'none'; c[cu] = (c[cu]||0)+1; } return c; })(),
    buns: window.RUN.buns().map(x => x.name), arts: window.RUN.state().artifacts,
    fallbacks: window.RUN.rarityFallbacks().length,
    plog: (function(){
      try {
        const cur = JSON.parse(localStorage.getItem('bstack.plog.current.v1') || 'null');
        if (cur && cur.spins && cur.spins.length) return cur;
        const runs = JSON.parse(localStorage.getItem('bstack.plog.runs.v1') || '[]');
        return runs.length ? runs[runs.length - 1] : null;
      } catch(e){ return null; }
    })(),
  }));
  await page.close();

  const cum = spins.reduce((s, x) => s + x.total, 0);
  return { seed, policy: POLICY, m: M, ended, stopped, rentsPaid,
           spinsDone: spins.length, days: fin.days, cum, money: fin.money,
           deckN: fin.deck.length, main: fin.main, axis: fin.axis, buns: fin.buns, arts: fin.arts,
           fallbacks: fin.fallbacks, errs,
           spins, offers, buys, affordable, bunEvents, mainSeq,
           plogSpins: (fin.plog && fin.plog.spins) ? fin.plog.spins.map(s => ({
             spin: s.spin, score: s.score, cum: s.cum, day: s.day, money: s.money, tiers: s.tiers,
             deckN: (s.deck || []).length, bought: s.bought, removed: s.removed,
             offered: s.offered, picked: s.picked, growth: s.growth, pb: s.pb, pm: s.pm,
             gambles: s.gambles, buns: s.buns, bunSwaps: s.bunSwaps, rarFallbacks: s.rarFallbacks,
           })) : null };
}

let n = 0;
for (let seed = FROM; seed <= TO; seed++){
  const r = await runOne(seed);
  appendFileSync(OUT, JSON.stringify(r) + '\n');
  n++;
  const tag = r.stopped ? 'STOP' : r.ended;
  process.stdout.write(`${POLICY}m${M} seed${seed}: ${String(r.spinsDone).padStart(2)}スピン ${r.days}営業日 ¥${r.cum} ${tag}${r.errs.length ? ' ERR' + r.errs.length : ''}\n`);
}
await browser.close();
process.stdout.write(`done ${POLICY} m=${M}: ${n} runs → ${OUT}\n`);
