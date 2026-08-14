/* 測定 M3：Wave 10 の101枚を測る（2026-08-14）。
   index.html は1行も変更しない。実プレイ経路（Chromium の実UI操作）だけで走らせ、
   1ランごとに JSON 1行を書き出す。集計は tools/m3-report.mjs。

   使い方：
     node tools/m3-measure.mjs --policy=base --from=3001 --to=3024 --out=tools/out/m3-base.jsonl
     --workers=N でページを並列に走らせる（既定4）。--days=10 で dayGoal。

   方策（--policy）：
     base   基準：3択はデッキの最弱より代理打点が高いものを取る（無ければ見送る）。
            店は 削除→（ソース枠が空いていればソース）→カード→具材枠 の順。
     norem  削除しない：base と同じで、店で「取り除く」を買わない。
     nosauce ソース無視：ソースを取らない・買わない（初期デッキのケチャップは残る）。
     noaxis 軸を無視：軸を見ず、代理打点だけで取捨する（base の軸ボーナスを外す）。
     random 何も考えない：3択は無作為・店は買えるものを無作為に買う。
*/
import pkg from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pkg;
import { writeFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=').slice(1).join('=') : d; };
const POLICY = arg('policy', 'base');
const FROM = +arg('from', 3001), TO = +arg('to', 3024);
const OUT = arg('out', `tools/out/m3-${POLICY}.jsonl`);
const WORKERS = +arg('workers', 4);
const DAYS = +arg('days', 10);
const TARGET = 'file:///home/user/burger-stack/index.html';

if (!existsSync('tools/out')) mkdirSync('tools/out', { recursive: true });
writeFileSync(OUT, '');

// ── 代理打点（ボットが使う近似）。実際の打点は知らない。 ────────────────
//   具材＝帯の値／ソース＝40×(倍率−1)（§5-2 の打点の式と同じ換算。中段の他の合計を40とする）
const PROXY = `
  const BAND = { nami:60, jou:120, tokujou:240, kiwami:480 };
  const SAUCE_MULT = { nami:1.5, jou:3, tokujou:6, kiwami:10 };
  function proxy(nm){
    const it = CONFIG.items[nm]; if (!it) return 0;
    if (it.pile === "sauce") return Math.round(40 * ((SAUCE_MULT[it.rar] || 1) - 1));
    return BAND[it.rar] || 0;
  }
  // 軸ボーナス：デッキの主軸と同じ軸なら 1.3 倍に見積もる（noaxis では使わない）
  function proxyWithAxis(nm, useAxis){
    const v = proxy(nm); if (!useAxis) return v;
    const main = RUN.mainCuisine();
    const cu = (CONFIG.items[nm] || {}).cuisine || "none";
    return (main !== "none" && cu === main) ? Math.round(v * 1.3) : v;
  }
  // デッキで最も弱い個体（代理打点）。初期デッキのカードも対象。
  // 方策 random 用の乱数。ゲームの grand() は使わない（使うとゲーム側の抽選がずれる）。
  //   ランのシードから別に作るので、同じシードなら何度走らせても同じ選択になる。
  window.__rngState = 0;
  function botRand(){ let t = (window.__rngState += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
  function weakestInDeck(){
    const d = RUN.deck(); let lo = null;
    for (const x of d){ const v = proxy(x.name); if (lo === null || v < lo.v) lo = { v, name: x.name }; }
    return lo || { v: 0, name: null };
  }
`;

// ── 1スピンぶんのカード別打点を取り出す（plan から読むだけ・コードは変えない）──
const PERCARD = `
  function perCardHits(){
    if (typeof plan === "undefined" || !plan) return [];
    const st = plan.stack, ba = plan.sc.baseArr || [], hits = plan.sc.hits || [];
    const out = [];
    for (let i = 0; i < st.length; i++){
      const it = CONFIG.items[st[i]]; if (!it || it.pile === "bun") continue;
      let add = 0, mul = 1;
      for (const h of hits){ if (h.src !== i || h.disabled) continue;
        if (h.kind === "add") add += (h.add || 0);
        else if (h.kind === "mult") mul *= (h.mult || 1); }
      const dmg = Math.round((40 + (ba[i] || 0) + add) * mul - 40);
      out.push([st[i], dmg]);
    }
    return out;
  }
`;

const BAND_OF = { nami: 60, jou: 120, tokujou: 240, kiwami: 480 };

async function runOne(page, seed, policy) {
  const errs = [];
  page.removeAllListeners('pageerror'); page.removeAllListeners('console');
  page.on('pageerror', e => errs.push('PE ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('CE ' + m.text()); });
  await page.goto(TARGET);
  await page.waitForFunction(() => typeof window.RUN !== 'undefined');
  await page.evaluate(([seed, days, policy, proxySrc, perCardSrc]) => {
    window.__M3 = { policy, spins: [], days: [], buys: [], removes: {}, skips: {}, deckBands: [], artBuys: [], artSwaps: 0, fills: null };
    eval(proxySrc); eval(perCardSrc);
    window.__proxy = proxy; window.__proxyAxis = proxyWithAxis; window.__weakest = weakestInDeck; window.__perCard = perCardHits;
    window.__botRand = botRand; window.__rngState = seed * 7919;
    CONFIG.params.skipFx = true; CONFIG.params.completeLock = 0.001;
    RUN.setPendingSeed(seed); RUN.reset();
    CONFIG.params.skipFx = true; CONFIG.params.completeLock = 0.001;
    CONFIG.params.run.dayGoal = days;
  }, [seed, DAYS, policy, PROXY, PERCARD]);

  const st = () => page.evaluate(() => ({
    show: document.getElementById('offer').classList.contains('show'),
    title: (document.querySelector('#offer .offer-title') || {}).textContent || '',
    done: /完成/.test(document.getElementById('progress').textContent),
    active: RUN.state().runActive, days: RUN.state().daysSurvived, money: RUN.state().money,
    cls: document.getElementById('offer').className }));
  const tap = () => page.evaluate(() => { const el = document.getElementById('tap');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); });

  let guard = 0, ended = null, lastKey = '', rep = 0;
  while (guard++ < 4000) {
    const s = await st();
    if (!s.active) { ended = /cleared/.test(s.cls) ? 'cleared' : 'broke'; break; }
    const key = s.show + '|' + s.title + '|' + s.days;
    if (key === lastKey) rep++; else { rep = 0; lastKey = key; }
    if (rep > 40) { ended = 'stuck'; break; }   // 同じ画面から動かない＝ハーネスが処理できていない
    if (!s.show) {
      // 盤面を組む → 完成 → 回収
      for (let k = 0; k < 14; k++) { if ((await page.evaluate(() => /完成/.test(document.getElementById('progress').textContent)))) break; await tap(); await page.waitForTimeout(20); }
      await page.evaluate(() => {   // 完成した時点のカード別打点と得点を控える
        const day = RUN.state().daysSurvived + 1;
        window.__M3.spins.push({ d: day, t: plan ? plan.sc.total : 0, n: plan ? plan.stack.length : 0,
          deck: RUN.deck().length, ing: Math.round(CONFIG.params.tiers.ingredients), cards: window.__perCard() });
      });
      for (let k = 0; k < 14; k++) { if (!(await page.evaluate(() => /完成/.test(document.getElementById('progress').textContent)))) break; await tap(); await page.waitForTimeout(20); }
      continue;
    }
    const handled = await page.evaluate((policy) => {
      const M = window.__M3, title = (document.querySelector('#offer .offer-title') || {}).textContent || '';
      const day = RUN.state().daysSurvived + 1;
      const useAxis = policy !== 'noaxis';
      const rnd = arr => arr[Math.floor(window.__botRand() * arr.length)];
      // ① バンズの押し出し：効果を持たないゴマバンズを優先して捨てる（方策で差をつけない）
      if (/バンズを1枚入手/.test(title)) {
        // 所持枠に空きがあるときは押し出しが起きず、行をタップしても何も起きない（「受け取る」を押す）。
        const sub = (document.querySelector('#offer .offer-subtitle') || {}).textContent || '';
        const take = [...document.querySelectorAll('#offer .offer-buy')].find(x => /受け取る/.test(x.textContent));
        if (!/押し出す/.test(sub) && take) { take.click(); return 'bun'; }
        const rows = [...document.querySelectorAll('#offer .bunslots .remove-row:not(.off)')];
        const goma = rows.find(r => (r.querySelector('.nm') || {}).textContent === 'ゴマバンズ');
        if (goma) goma.click(); else if (rows[0]) rows[0].click();
        else if (take) take.click();
        return 'bun';
      }
      // ② 家賃
      if (/家賃の支払い/.test(title)) {
        const before = RUN.state().money;
        const x = [...document.querySelectorAll('#offer .offer-buy')].find(y => /支払う|前借り|結果/.test(y.textContent));
        if (x) x.click();
        M.days.push({ d: day, moneyBefore: before, money: RUN.state().money,
          bands: (() => { const c = { nami:0, jou:0, tokujou:0, kiwami:0 }; for (const y of RUN.deck()) c[CONFIG.items[y.name].rar]++; return c; })(),
          deck: RUN.deck().length });
        return 'rent';
      }
      // ③ 店
      if (/店（/.test(title)) {
        const money = () => RUN.state().money;
        const keep = () => Math.round(300 * Math.pow(1.4, RUN.state().daysSurvived));   // 今日の家賃ぶんは残す
        const btn = re => [...document.querySelectorAll('#offer .shopbtn')].find(y => re.test(y.textContent));
        const price = el => +((el.querySelector('.price') || {}).textContent || '0').replace(/\D/g, '');
        if (policy === 'random') {
          for (let k = 0; k < 6; k++) {
            const cs = [...document.querySelectorAll('#offer .shopcard')].filter(x => !x.classList.contains('cant'));
            if (!cs.length) break; const c = rnd(cs);
            const nm = (c.querySelector('.nm') || {}).textContent; const isArt = c.classList.contains('artcard');
            c.click(); (isArt ? M.artBuys : M.buys).push({ d: day, nm });
          }
        } else {
          // 削除：デッキ最弱を取り除く（norem では買わない）
          if (policy !== 'norem') {
            for (let k = 0; k < 3; k++) {
              const rb = btn(/取り除く/); if (!rb || /cant/.test(rb.className)) break;
              const cost = price(rb); if (money() - cost < keep()) break;
              rb.click();
              const rows = [...document.querySelectorAll('#offer .remove-row:not(.off)')];
              if (!rows.length) { const back = [...document.querySelectorAll('#offer .offer-skip')].find(y => /戻る/.test(y.textContent)); if (back) back.click(); break; }
              let lo = rows[0], lv = 1e9;
              for (const r of rows) { const v = window.__proxy((r.querySelector('.nm') || {}).textContent); if (v < lv) { lv = v; lo = r; } }
              const nm = (lo.querySelector('.nm') || {}).textContent;
              lo.click(); M.removes[day] = (M.removes[day] || 0) + 1; M.buys.push({ d: day, nm, kind: 'remove' });
            }
          }
          // カード：代理打点の高い順に、買えるだけ買う（ソース枠が空いていればソースを優先）
          for (let k = 0; k < 8; k++) {
            let cs = [...document.querySelectorAll('#offer .shopcard:not(.artcard)')].filter(x => !x.classList.contains('cant'));
            if (policy === 'nosauce') cs = cs.filter(x => (CONFIG.items[(x.querySelector('.nm') || {}).textContent] || {}).pile !== 'sauce');
            cs = cs.filter(x => money() - price(x) >= keep());
            if (!cs.length) break;
            const sauceSlots = Math.round(CONFIG.params.tiers.sauces);
            const haveSauce = RUN.deck().filter(y => CONFIG.items[y.name].pile === 'sauce').length;
            const wantSauce = policy !== 'nosauce' && haveSauce < sauceSlots;
            const pick = cs.map(x => ({ x, nm: (x.querySelector('.nm') || {}).textContent }))
              .map(o => ({ ...o, v: window.__proxyAxis(o.nm, useAxis) + ((wantSauce && CONFIG.items[o.nm].pile === 'sauce') ? 10000 : 0) }))
              .sort((a, b) => b.v - a.v)[0];
            pick.x.click(); M.buys.push({ d: day, nm: pick.nm, kind: 'card' });
          }
          // アーティファクト：買えるものを高いレアリティから
          for (let k = 0; k < 3; k++) {
            const as = [...document.querySelectorAll('#offer .shopcard.artcard')].filter(x => !x.classList.contains('cant'))
              .filter(x => money() - price(x) >= keep());
            if (!as.length) break;
            const before = (RUN.state().artifacts || []).length;
            const nm = (as[0].querySelector('.nm') || {}).textContent;
            as[0].click();
            const after = (RUN.state().artifacts || []).length;
            if (after === before) M.artSwaps++;
            M.artBuys.push({ d: day, nm });
            if (M.fills === null && after >= 3) M.fills = day;
          }
          // 具材枠：デッキ枚数が枠より多ければ枠を買う
          for (let k = 0; k < 2; k++) {
            const ib = btn(/具材枠/); if (!ib || /cant/.test(ib.className)) break;
            const cost = price(ib); if (money() - cost < keep()) break;
            if (RUN.deck().length <= Math.round(CONFIG.params.tiers.ingredients) + 1) break;
            ib.click(); M.buys.push({ d: day, nm: '具材枠+1', kind: 'slot' });
          }
        }
        const out = [...document.querySelectorAll('#offer .offer-skip')].find(y => /店を出る/.test(y.textContent));
        if (out) out.click();
        return 'shop';
      }
      // ④ 押し出し・軸選択など
      if (/押し出す|減らす|軸を選ぶ/.test(title)) {
        const r = document.querySelector('#offer .remove-row:not(.off)') || document.querySelector('#offer .offer-card')
          || [...document.querySelectorAll('#offer .offer-buy')][0];
        if (r) r.click();
        return 'other';
      }
      // ⑤ 3択
      const cs = [...document.querySelectorAll('#offer .offer-card')];
      if (!cs.length) { const s = document.querySelector('#offer .offer-skip'); if (s) s.click(); return 'offer-empty'; }
      const names = cs.map(c => (c.querySelector('.nm') || {}).textContent);
      if (policy === 'random') { const k = Math.floor(window.__botRand() * cs.length); cs[k].click(); return 'offer'; }
      let cand = names.map((nm, k) => ({ nm, k, v: window.__proxyAxis(nm, useAxis) }));
      if (policy === 'nosauce') cand = cand.filter(o => CONFIG.items[o.nm].pile !== 'sauce');
      const weak = window.__weakest();
      cand = cand.filter(o => o.v > weak.v);
      if (!cand.length) { const s = document.querySelector('#offer .offer-skip'); if (s) s.click();
        window.__M3.skips[day] = (window.__M3.skips[day] || 0) + 1; return 'skip'; }
      cand.sort((a, b) => b.v - a.v || a.k - b.k);   // 同点なら左端
      cs[cand[0].k].click();
      return 'offer';
    }, policy);
    await page.waitForTimeout(handled === 'shop' ? 40 : 25);
  }

  const out = await page.evaluate(() => {
    const M = window.__M3;
    return { spins: M.spins, days: M.days, buys: M.buys, removes: M.removes, skips: M.skips,
      artBuys: M.artBuys, artSwaps: M.artSwaps, fills: M.fills,
      arts: (RUN.state().artifacts || []).slice(),
      fb: (RUN.rarityFallbacks ? RUN.rarityFallbacks().length : 0),
      warn: selfCheck().length, warnMsg: selfCheck(), deck: RUN.deck().length, money: RUN.state().money,
      daysSurvived: RUN.state().daysSurvived };
  });
  return { seed, policy, ended, errs: errs.length, err0: errs[0] || null, ...out };
}

const seeds = []; for (let s = FROM; s <= TO; s++) seeds.push(s);
const t0 = Date.now();
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell', args: ['--no-sandbox'] });
let idx = 0, done = 0;
async function worker() {
  const page = await browser.newPage();
  while (true) {
    const my = idx++; if (my >= seeds.length) break;
    try {
      const r = await runOne(page, seeds[my], POLICY);
      appendFileSync(OUT, JSON.stringify(r) + '\n');
    } catch (e) {
      appendFileSync(OUT, JSON.stringify({ seed: seeds[my], policy: POLICY, ended: 'error', error: String(e).slice(0, 200) }) + '\n');
    }
    done++;
    if (done % 5 === 0) process.stderr.write(`  ${POLICY}: ${done}/${seeds.length}（${Math.round((Date.now()-t0)/1000)}秒）\n`);
  }
  await page.close();
}
await Promise.all(Array.from({ length: Math.min(WORKERS, seeds.length) }, worker));
await browser.close();
console.log(`${POLICY}: ${done}ラン / ${Math.round((Date.now() - t0) / 1000)}秒 → ${OUT}`);
