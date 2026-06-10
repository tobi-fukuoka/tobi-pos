/* ============================================================
   東美レジ v2 — オフラインPOS（割引対応・AI価格読み取り）
   ============================================================ */
'use strict';

const TAX_RATE = 10; // 内税10%
const yen = n => '¥' + Math.round(n).toLocaleString('ja-JP');
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ---------------- IndexedDB ---------------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open('tobi-pos-v2', 1);
      rq.onupgradeneeded = e => {
        const d = e.target.result;
        d.createObjectStore('products', { keyPath: 'id', autoIncrement: true });
        d.createObjectStore('sales', { keyPath: 'id', autoIncrement: true });
        d.createObjectStore('staff', { keyPath: 'id', autoIncrement: true });
        d.createObjectStore('meta', { keyPath: 'k' });
      };
      rq.onsuccess = e => { DB.db = e.target.result; res(); };
      rq.onerror = () => rej(rq.error);
    });
  },
  tx(store, mode) { return DB.db.transaction(store, mode).objectStore(store); },
  all(store) {
    return new Promise((res, rej) => {
      const rq = DB.tx(store, 'readonly').getAll();
      rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
    });
  },
  put(store, v) {
    return new Promise((res, rej) => {
      const rq = DB.tx(store, 'readwrite').put(v);
      rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
    });
  },
  del(store, k) {
    return new Promise((res, rej) => {
      const rq = DB.tx(store, 'readwrite').delete(k);
      rq.onsuccess = () => res(); rq.onerror = () => rej(rq.error);
    });
  },
  async getMeta(k, dflt) {
    return new Promise(res => {
      const rq = DB.tx('meta', 'readonly').get(k);
      rq.onsuccess = () => res(rq.result ? rq.result.v : dflt);
      rq.onerror = () => res(dflt);
    });
  },
  setMeta(k, v) { return DB.put('meta', { k, v }); }
};

/* ---------------- 状態 ---------------- */
const S = {
  products: [], staff: [], sales: [],
  cart: [],            // {pid, name, category, price, qty, discType:null|'amount'|'percent', discValue}
  curStaff: null,      // {id,name}
  cat: 'すべて',
  apiKey: ''
};

/* ---------------- 計算 ---------------- */
function lineCalc(l) {
  const base = l.price * l.qty;
  let total = base;
  if (l.discType === 'amount')  total = Math.max(0, base - (l.discValue || 0));
  if (l.discType === 'percent') total = Math.floor(base * (100 - Math.min(100, l.discValue || 0)) / 100);
  return { base, total, disc: base - total };
}
function cartCalc() {
  let sub = 0, disc = 0, total = 0;
  for (const l of S.cart) { const c = lineCalc(l); sub += c.base; disc += c.disc; total += c.total; }
  const tax = Math.floor(total * TAX_RATE / (100 + TAX_RATE));
  return { sub, disc, total, tax };
}

/* ---------------- UI 基盤 ---------------- */
const UI = {
  go(p) {
    document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('act', b.dataset.p === p));
    document.querySelectorAll('.page').forEach(pg => pg.classList.toggle('act', pg.id === 'page-' + p));
    if (p === 'prod') Prod.render();
    if (p === 'hist') Hist.render();
    if (p === 'rep') Rep.render();
    if (p === 'staff') Staff.render();
    if (p === 'set') $('set-apikey').value = S.apiKey || '';
  },
  open(id) { $(id).classList.add('act'); },
  close(id) { $(id).classList.remove('act'); },
  toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(UI._tt); UI._tt = setTimeout(() => t.classList.remove('show'), 2400);
  }
};
document.querySelectorAll('#nav button').forEach(b => b.onclick = () => UI.go(b.dataset.p));

function tickClock() {
  const d = new Date();
  $('hd-clock').textContent =
    `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
setInterval(tickClock, 10000); tickClock();
function netDot(){ $('net-dot').classList.toggle('off', !navigator.onLine); }
window.addEventListener('online', netDot); window.addEventListener('offline', netDot); netDot();

/* ---------------- レジ ---------------- */
const Reg = {
  renderCats() {
    const cats = ['すべて', ...new Set(S.products.map(p => p.category))];
    if (!cats.includes(S.cat)) S.cat = 'すべて';
    $('cat-bar').innerHTML = cats.map(c =>
      `<button class="${c === S.cat ? 'act' : ''}" onclick="Reg.setCat('${esc(c)}')">${esc(c)}</button>`).join('');
  },
  setCat(c) { S.cat = c; Reg.renderCats(); Reg.renderGrid(); },
  renderGrid() {
    const list = S.products.filter(p => S.cat === 'すべて' || p.category === S.cat);
    $('prod-grid').innerHTML = list.length ? list.map(p => `
      <button class="prod-card" onclick="Reg.add(${p.id})">
        <span class="nm">${esc(p.name)}</span>
        <span class="ct">${esc(p.category)}</span>
        <span class="pr">${yen(p.price)}</span>
      </button>`).join('')
      : `<div class="grid-empty">商品がまだありません。<br>「商品」タブから登録してください。</div>`;
  },
  add(pid) {
    const p = S.products.find(x => x.id === pid); if (!p) return;
    const line = S.cart.find(l => l.pid === pid && !l.discType);
    if (line) line.qty++;
    else S.cart.push({ pid, name: p.name, category: p.category, price: p.price, qty: 1, discType: null, discValue: 0 });
    Reg.renderCart();
  },
  qty(i, d) {
    const l = S.cart[i]; if (!l) return;
    l.qty += d; if (l.qty <= 0) S.cart.splice(i, 1);
    Reg.renderCart();
  },
  remove(i) { S.cart.splice(i, 1); Reg.renderCart(); },
  clearCart() {
    if (!S.cart.length) return;
    if (confirm('カゴの中身を全て削除しますか？')) { S.cart = []; Reg.renderCart(); }
  },
  renderCart() {
    const el = $('cart-list');
    el.innerHTML = S.cart.length ? S.cart.map((l, i) => {
      const c = lineCalc(l);
      const tag = l.discType
        ? `<span class="disc-tag">${l.discType === 'amount' ? `値引き −${yen(l.discValue).slice(1)}円相当` : `${l.discValue}%引き`}　−${yen(c.disc).slice(1)}円</span>` : '';
      return `<div class="cart-line">
        <div class="cl-top"><span class="nm">${esc(l.name)}</span><span class="amt num">${yen(c.total)}</span></div>
        ${tag}
        <div class="cl-bottom">
          <button class="qty-btn" onclick="Reg.qty(${i},-1)">−</button>
          <span class="cl-qty">${l.qty}</span>
          <button class="qty-btn" onclick="Reg.qty(${i},1)">＋</button>
          <button class="cl-del" onclick="Reg.remove(${i})">削除</button>
          <button class="disc-btn" onclick="Disc.open(${i})">${l.discType ? '割引を変更' : '値引き / 割引'}</button>
        </div>
      </div>`;
    }).join('') : `<div class="cart-empty">商品をタップしてカゴに追加</div>`;
    const c = cartCalc();
    $('cart-cnt').textContent = S.cart.length ? `${S.cart.reduce((a, l) => a + l.qty, 0)}点` : '';
    $('t-sub').textContent = yen(c.sub);
    $('t-disc-row').style.display = c.disc ? '' : 'none';
    $('t-disc').textContent = '−' + yen(c.disc).slice(1);
    $('t-total').textContent = yen(c.total);
    $('t-tax').textContent = yen(c.tax);
    $('pay-btn').disabled = !S.cart.length;
  },
  openCheckout() {
    if (!S.curStaff) { UI.toast('先に「スタッフ」タブで担当者を選んでください'); UI.go('staff'); return; }
    CO.open();
  }
};

/* ---------------- 割引 ---------------- */
const Disc = {
  idx: -1, type: 'amount',
  open(i) {
    Disc.idx = i;
    const l = S.cart[i];
    Disc.type = l.discType || 'amount';
    $('disc-title').textContent = l.name;
    $('disc-val').value = l.discType ? l.discValue : '';
    Disc.renderType(); Disc.preview();
    UI.open('m-disc');
  },
  setType(t) { Disc.type = t; Disc.renderType(); Disc.preview(); },
  renderType() {
    $('disc-seg-amt').classList.toggle('act', Disc.type === 'amount');
    $('disc-seg-pct').classList.toggle('act', Disc.type === 'percent');
    $('disc-val-label').textContent = Disc.type === 'amount' ? '値引き額（円）' : '割引率（%）';
    const q = Disc.type === 'amount' ? [50, 100, 200, 500] : [5, 10, 20, 50];
    $('disc-quick').innerHTML = q.map(v =>
      `<button onclick="Disc.quick(${v})">${Disc.type === 'amount' ? v + '円' : v + '%'}</button>`).join('');
  },
  quick(v) { $('disc-val').value = v; Disc.preview(); },
  preview() {
    const l = S.cart[Disc.idx]; if (!l) return;
    const v = Number($('disc-val').value) || 0;
    const c = lineCalc({ ...l, discType: v > 0 ? Disc.type : null, discValue: v });
    $('disc-preview-v').textContent = `${yen(l.price * l.qty)} → ${yen(c.total)}`;
  },
  apply() {
    const l = S.cart[Disc.idx]; if (!l) return;
    const v = Number($('disc-val').value) || 0;
    if (Disc.type === 'percent' && v > 100) { UI.toast('割引率は100%までです'); return; }
    if (v > 0) { l.discType = Disc.type; l.discValue = v; } else { l.discType = null; l.discValue = 0; }
    UI.close('m-disc'); Reg.renderCart();
  },
  clear() {
    const l = S.cart[Disc.idx]; if (l) { l.discType = null; l.discValue = 0; }
    UI.close('m-disc'); Reg.renderCart();
  }
};
$('disc-val').addEventListener('input', () => Disc.preview());

/* ---------------- 会計 ---------------- */
const CO = {
  cash: 0,
  open() { CO.cash = 0; CO.render(); UI.open('m-co'); },
  add(v) { CO.cash += v; CO.render(); },
  exact() { CO.cash = cartCalc().total; CO.render(); },
  reset() { CO.cash = 0; CO.render(); },
  render() {
    const t = cartCalc().total, chg = CO.cash - t;
    $('co-total').textContent = yen(t);
    $('co-cash').textContent = yen(CO.cash);
    $('co-change').textContent = chg >= 0 ? yen(chg) : '−' + yen(-chg).slice(1) + '（不足）';
    $('co-change-row').classList.toggle('minus', chg < 0);
    $('co-done').disabled = chg < 0 || t <= 0;
  },
  async done() {
    const c = cartCalc();
    const txNo = (await DB.getMeta('txCounter', 0)) + 1;
    await DB.setMeta('txCounter', txNo);
    const sale = {
      txNo, ts: Date.now(),
      staffId: S.curStaff.id, staffName: S.curStaff.name,
      items: S.cart.map(l => { const lc = lineCalc(l); return { ...l, lineTotal: lc.total, lineDisc: lc.disc }; }),
      subtotal: c.sub, discountTotal: c.disc, total: c.total, tax: c.tax,
      cash: CO.cash, change: CO.cash - c.total, refunded: false
    };
    sale.id = await DB.put('sales', sale);
    S.sales.push(sale);
    S.cart = []; Reg.renderCart();
    UI.close('m-co');
    $('rcpt-body').innerHTML = receiptHTML(sale);
    UI.open('m-rcpt');
  }
};

function receiptHTML(s, forDetail) {
  const d = new Date(s.ts);
  const dt = `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  const lines = s.items.map(it => {
    const disc = it.lineDisc ? `<div class="li dim"><span class="n">　${it.discType === 'percent' ? it.discValue + '%引き' : '値引き'}</span><span>−${yen(it.lineDisc).slice(1)}</span></div>` : '';
    return `<div class="li"><span class="n">${esc(it.name)} ×${it.qty}</span><span>${yen(it.price * it.qty)}</span></div>${disc}`;
  }).join('');
  return `
    <div class="c ttl">東 美</div>
    <div class="c dim">領収書（控）</div>
    <hr>
    <div class="li"><span class="n">取引No</span><span>${String(s.txNo).padStart(6, '0')}</span></div>
    <div class="li"><span class="n">日時</span><span>${dt}</span></div>
    <div class="li"><span class="n">担当</span><span>${esc(s.staffName)}</span></div>
    ${s.refunded ? '<div class="c" style="color:#b3422e;font-weight:700">＊＊ 返品・返金済み ＊＊</div>' : ''}
    <hr>${lines}<hr>
    ${s.discountTotal ? `<div class="li"><span class="n">小計</span><span>${yen(s.subtotal)}</span></div>
    <div class="li"><span class="n">値引き合計</span><span>−${yen(s.discountTotal).slice(1)}</span></div>` : ''}
    <div class="li big"><span class="n">合計</span><span>${yen(s.total)}</span></div>
    <div class="li dim"><span class="n">（内消費税 ${TAX_RATE}%）</span><span>${yen(s.tax)}</span></div>
    <div class="li"><span class="n">お預り</span><span>${yen(s.cash)}</span></div>
    <div class="li"><span class="n">お釣り</span><span>${yen(s.change)}</span></div>
    <hr><div class="c dim">ご来店ありがとうございました</div>`;
}

/* ---------------- 商品管理 ---------------- */
const Prod = {
  editId: null,
  render() {
    $('prod-count').textContent = `${S.products.length}件`;
    const dl = [...new Set(S.products.map(p => p.category))];
    $('cat-datalist').innerHTML = dl.map(c => `<option value="${esc(c)}">`).join('');
    $('prod-list').innerHTML = S.products.length ? S.products.map(p => `
      <div class="row" onclick="Prod.openEdit(${p.id})" style="cursor:pointer">
        <div class="grow">${esc(p.name)}<div class="sub"><span class="badge cat">${esc(p.category)}</span></div></div>
        <div class="num" style="font-weight:700">${yen(p.price)}</div>
      </div>`).join('')
      : `<div class="row" style="color:var(--sub)">商品がありません。「＋ 商品を追加」から登録してください。</div>`;
  },
  openEdit(id) {
    Prod.editId = id ?? null;
    const p = id ? S.products.find(x => x.id === id) : null;
    $('prod-m-title').textContent = p ? '商品を編集' : '商品を追加';
    $('pf-name').value = p ? p.name : '';
    $('pf-cat').value = p ? p.category : '';
    $('pf-price').value = p ? p.price : '';
    $('pf-del').style.display = p ? '' : 'none';
    UI.open('m-prod');
  },
  async save() {
    const name = $('pf-name').value.trim(), cat = $('pf-cat').value.trim();
    const price = Number($('pf-price').value);
    if (!name || !cat || !(price >= 0)) { UI.toast('商品名・カテゴリ・価格を入力してください'); return; }
    const p = Prod.editId ? S.products.find(x => x.id === Prod.editId) : { };
    Object.assign(p, { name, category: cat, price });
    p.id = await DB.put('products', Prod.editId ? p : { name, category: cat, price });
    if (!Prod.editId) S.products.push({ id: p.id, name, category: cat, price });
    UI.close('m-prod'); Prod.render(); Reg.renderCats(); Reg.renderGrid();
    UI.toast('保存しました');
  },
  async del() {
    if (!Prod.editId || !confirm('この商品を削除しますか？\n（過去の売上履歴には残ります）')) return;
    await DB.del('products', Prod.editId);
    S.products = S.products.filter(p => p.id !== Prod.editId);
    UI.close('m-prod'); Prod.render(); Reg.renderCats(); Reg.renderGrid();
    UI.toast('削除しました');
  }
};

/* ---------------- 履歴・返品 ---------------- */
const Hist = {
  curId: null,
  render() {
    const list = [...S.sales].sort((a, b) => b.ts - a.ts);
    $('hist-list').innerHTML = list.length ? list.map(s => {
      const d = new Date(s.ts);
      const dt = `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      return `<div class="row" style="cursor:pointer;${s.refunded ? 'opacity:.55' : ''}" onclick="Hist.openTx(${s.id})">
        <div class="grow">
          <span class="num" style="font-weight:600">No.${String(s.txNo).padStart(6,'0')}</span>
          ${s.refunded ? '<span class="badge ref" style="margin-left:6px">返品済</span>' : ''}
          <div class="sub">${dt}　担当：${esc(s.staffName)}　${s.items.reduce((a,i)=>a+i.qty,0)}点</div>
        </div>
        <div class="num" style="font-weight:700;${s.refunded ? 'text-decoration:line-through' : ''}">${yen(s.total)}</div>
      </div>`;
    }).join('') : `<div class="row" style="color:var(--sub)">売上履歴はまだありません。</div>`;
  },
  openTx(id) {
    Hist.curId = id;
    const s = S.sales.find(x => x.id === id); if (!s) return;
    $('tx-body').innerHTML = receiptHTML(s, true);
    $('tx-refund').style.display = s.refunded ? 'none' : '';
    UI.open('m-tx');
  },
  async refund() {
    const s = S.sales.find(x => x.id === Hist.curId); if (!s) return;
    if (!confirm(`取引No.${String(s.txNo).padStart(6,'0')}（${yen(s.total)}）を返品・返金処理しますか？`)) return;
    s.refunded = true; s.refundTs = Date.now();
    await DB.put('sales', s);
    UI.close('m-tx'); Hist.render();
    UI.toast(`返金 ${yen(s.total)} を記録しました`);
  }
};

/* ---------------- 集計 ---------------- */
const Rep = {
  period: 'today',
  setPeriod(p) {
    Rep.period = p;
    document.querySelectorAll('[data-pd]').forEach(b => b.classList.toggle('act', b.dataset.pd === p));
    Rep.renderBreakdown();
  },
  inPeriod(ts, p) {
    const d = new Date(ts), n = new Date();
    if (p === 'today') return d.toDateString() === n.toDateString();
    if (p === 'month') return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth();
    return true;
  },
  valid() { return S.sales.filter(s => !s.refunded); },
  render() {
    const mk = p => {
      const ss = Rep.valid().filter(s => Rep.inPeriod(s.ts, p));
      return { n: ss.length, amt: ss.reduce((a, s) => a + s.total, 0) };
    };
    const t = mk('today'), m = mk('month'), a = mk('all');
    $('rep-cards').innerHTML = [
      ['本日', t], ['今月', m], ['累計', a]
    ].map(([lb, v]) => `<div class="rep-card"><div class="lb">${lb}の売上</div><div class="v">${yen(v.amt)}</div><div class="s">${v.n}件</div></div>`).join('');
    Rep.renderBreakdown();
  },
  renderBreakdown() {
    const ss = Rep.valid().filter(s => Rep.inPeriod(s.ts, Rep.period));
    const cat = {}, stf = {};
    for (const s of ss) {
      stf[s.staffName] = (stf[s.staffName] || 0) + s.total;
      for (const it of s.items) cat[it.category] = (cat[it.category] || 0) + it.lineTotal;
    }
    $('rep-cat').innerHTML = bars(cat);
    $('rep-staff').innerHTML = bars(stf);
    function bars(o) {
      const es = Object.entries(o).sort((a, b) => b[1] - a[1]);
      if (!es.length) return `<div class="row" style="color:var(--sub)">対象期間のデータがありません。</div>`;
      const mx = es[0][1] || 1;
      return es.map(([k, v]) => `<div class="bar-row">
        <span class="lb">${esc(k)}</span>
        <span class="bar"><i style="width:${Math.max(3, v / mx * 100)}%"></i></span>
        <span class="v">${yen(v)}</span></div>`).join('');
    }
  }
};

/* ---------------- スタッフ ---------------- */
const Staff = {
  render() {
    $('staff-list').innerHTML = S.staff.length ? S.staff.map(st => `
      <div class="row">
        <button class="grow" style="text-align:left;padding:0" onclick="Staff.select(${st.id})">
          ${S.curStaff && S.curStaff.id === st.id ? '● ' : '○ '}${esc(st.name)}
          ${S.curStaff && S.curStaff.id === st.id ? '<span class="badge cat" style="margin-left:8px">担当中</span>' : ''}
        </button>
        <button class="btn ghost sm" onclick="Staff.del(${st.id})">削除</button>
      </div>`).join('')
      : `<div class="row" style="color:var(--sub)">スタッフが未登録です。「＋ 追加」から登録してください。</div>`;
  },
  async add() {
    const name = prompt('スタッフの名前を入力してください'); if (!name || !name.trim()) return;
    const st = { name: name.trim() };
    st.id = await DB.put('staff', st);
    S.staff.push(st);
    if (!S.curStaff) await Staff.select(st.id);
    Staff.render();
  },
  async select(id) {
    S.curStaff = S.staff.find(s => s.id === id) || null;
    await DB.setMeta('curStaffId', id);
    $('hd-staff-name').textContent = S.curStaff ? S.curStaff.name : '未設定';
    Staff.render();
  },
  async del(id) {
    const st = S.staff.find(s => s.id === id);
    if (!st || !confirm(`「${st.name}」を削除しますか？\n（過去の売上履歴には残ります）`)) return;
    await DB.del('staff', id);
    S.staff = S.staff.filter(s => s.id !== id);
    if (S.curStaff && S.curStaff.id === id) { S.curStaff = null; $('hd-staff-name').textContent = '未設定'; await DB.setMeta('curStaffId', null); }
    Staff.render();
  }
};

/* ---------------- 設定 ---------------- */
const Setting = {
  async saveKey() {
    S.apiKey = $('set-apikey').value.trim();
    await DB.setMeta('apiKey', S.apiKey);
    UI.toast(S.apiKey ? 'APIキーを保存しました' : 'APIキーを削除しました');
  }
};

/* ---------------- CSV ---------------- */
const CSV = {
  dl(name, rows) {
    const body = rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob(['\uFEFF' + body], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },
  stamp() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  },
  products() {
    CSV.dl(`商品マスタ_${CSV.stamp()}.csv`,
      [['商品ID','商品名','カテゴリ','価格(税込)'], ...S.products.map(p => [p.id, p.name, p.category, p.price])]);
    UI.toast('商品マスタCSVを出力しました');
  },
  sales() {
    const rows = [['取引No','日時','担当','状態','商品名','カテゴリ','単価','数量','割引','明細金額','取引合計','お預り','お釣り']];
    for (const s of [...S.sales].sort((a, b) => a.ts - b.ts)) {
      const d = new Date(s.ts);
      const dt = `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      for (const it of s.items) {
        const disc = it.discType ? (it.discType === 'percent' ? `${it.discValue}%引き` : `${it.discValue}円引き`) : '';
        rows.push([String(s.txNo).padStart(6,'0'), dt, s.staffName, s.refunded ? '返品済' : '通常',
          it.name, it.category, it.price, it.qty, disc, it.lineTotal, s.total, s.cash, s.change]);
      }
    }
    CSV.dl(`売上履歴_${CSV.stamp()}.csv`, rows);
    UI.toast('売上履歴CSVを出力しました');
  }
};

/* ---------------- AI価格読み取り ---------------- */
const AIP = {
  results: [],
  start() {
    if (!S.apiKey) {
      UI.toast('先に「設定」タブでAPIキーを保存してください'); UI.go('set'); return;
    }
    if (!navigator.onLine) {
      UI.toast('AI読み取りにはインターネット接続が必要です'); return;
    }
    $('ai-body').innerHTML = `<div class="ai-zone">
      価格変更表を撮影、または写真を選択してください。<br>
      <span style="font-size:12px">表全体が枠に入り、文字がはっきり読める写真ほど精度が上がります。</span><br><br>
      <button class="btn blue" onclick="$('ai-file').click()">カメラ / 写真を選ぶ</button>
    </div>`;
    $('ai-foot').innerHTML = `<button class="btn ghost" onclick="AIP.cancel()">キャンセル</button>`;
    UI.open('m-ai');
  },
  cancel() { UI.close('m-ai'); $('ai-file').value = ''; },
  async picked(file) {
    if (!file) return;
    $('ai-body').innerHTML = `<div style="text-align:center;padding:30px 0"><div class="spin"></div><div style="font-size:14px;color:var(--sub)">写真を読み取っています…<br>（10〜20秒ほどかかります）</div></div>`;
    $('ai-foot').innerHTML = '';
    try {
      const b64 = await AIP.shrink(file);
      const items = await AIP.callAPI(b64);
      AIP.preview(items);
    } catch (e) {
      $('ai-body').innerHTML = `<div class="ai-zone" style="border-color:var(--danger);color:var(--danger)">
        読み取りに失敗しました。<br><span style="font-size:12px">${esc(e.message || e)}</span><br><br>
        <button class="btn" onclick="AIP.start()">やり直す</button></div>`;
      $('ai-foot').innerHTML = `<button class="btn ghost" onclick="AIP.cancel()">閉じる</button>`;
    } finally { $('ai-file').value = ''; }
  },
  shrink(file) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1568;
        let { width: w, height: h } = img;
        if (Math.max(w, h) > MAX) { const r = MAX / Math.max(w, h); w = Math.round(w * r); h = Math.round(h * r); }
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        res(cv.toDataURL('image/jpeg', 0.85).split(',')[1]);
      };
      img.onerror = () => rej(new Error('画像を読み込めませんでした'));
      img.src = URL.createObjectURL(file);
    });
  },
  async callAPI(b64) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': S.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text', text:
`この画像は小売店の商品価格変更表です。商品名と新しい価格（税込・円）を読み取ってください。

出力は次のJSON配列「のみ」。説明文・Markdownコードブロックは一切不要です。
[{"name":"商品名","price":1234}]

注意：
- 価格が複数列ある場合は「新価格」「変更後」にあたる列を使う
- カンマや円記号は除いた整数にする
- 読み取れない行は含めない`
          }
        ]}]
      })
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      if (resp.status === 401) throw new Error('APIキーが正しくありません（設定タブで確認してください）');
      throw new Error(`API エラー（${resp.status}）${t.slice(0, 120)}`);
    }
    const data = await resp.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const clean = text.replace(/```json|```/g, '').trim();
    const m = clean.match(/\[[\s\S]*\]/);
    if (!m) throw new Error('表から商品と価格を読み取れませんでした');
    const arr = JSON.parse(m[0]);
    const items = arr.filter(x => x && x.name && Number.isFinite(Number(x.price)))
                     .map(x => ({ name: String(x.name).trim(), price: Math.round(Number(x.price)) }));
    if (!items.length) throw new Error('表から商品と価格を読み取れませんでした');
    return items;
  },
  norm(s) { return String(s).normalize('NFKC').toLowerCase().replace(/\s+/g, ''); },
  match(name) {
    const n = AIP.norm(name);
    let p = S.products.find(x => AIP.norm(x.name) === n);
    if (p) return { p, sure: true };
    p = S.products.find(x => AIP.norm(x.name).includes(n) || n.includes(AIP.norm(x.name)));
    return { p: p || null, sure: false };
  },
  preview(items) {
    AIP.results = items.map(it => {
      const m = AIP.match(it.name);
      return { read: it.name, price: it.price, pid: m.p ? m.p.id : 0,
               use: !!(m.p && m.p.price !== it.price) };
    });
    const opts = pid => `<option value="0">（対象なし）</option>` +
      S.products.map(p => `<option value="${p.id}" ${p.id === pid ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    $('ai-body').innerHTML = `
      <div style="font-size:13px;color:var(--sub);margin-bottom:10px">${items.length}件 読み取りました。反映する行にチェックを入れて「価格を更新」を押してください。</div>
      <table class="ai-prev"><tr><th></th><th>読み取った商品名</th><th>対象商品</th><th>価格</th></tr>
      ${AIP.results.map((r, i) => {
        const p = S.products.find(x => x.id === r.pid);
        return `<tr>
          <td><input type="checkbox" ${r.use ? 'checked' : ''} onchange="AIP.results[${i}].use=this.checked" style="width:20px;height:20px"></td>
          <td>${esc(r.read)}</td>
          <td><select onchange="AIP.results[${i}].pid=Number(this.value)">${opts(r.pid)}</select></td>
          <td class="num">${p ? `<span class="old">${yen(p.price)}</span> → ` : ''}<span class="new">${yen(r.price)}</span></td>
        </tr>`;
      }).join('')}</table>
      <div class="notice">「対象商品」が（対象なし）の行は商品マスタに該当が見つからなかった行です。プルダウンで選び直すか、チェックを外してください。</div>`;
    $('ai-foot').innerHTML = `
      <button class="btn ghost" onclick="AIP.cancel()">キャンセル</button>
      <button class="btn blue" onclick="AIP.apply()">価格を更新</button>`;
  },
  async apply() {
    let n = 0;
    for (const r of AIP.results) {
      if (!r.use || !r.pid) continue;
      const p = S.products.find(x => x.id === r.pid);
      if (!p) continue;
      p.price = r.price;
      await DB.put('products', p);
      n++;
    }
    UI.close('m-ai');
    Prod.render(); Reg.renderGrid();
    UI.toast(n ? `${n}件の価格を更新しました` : '更新対象がありませんでした');
  }
};
$('ai-file').addEventListener('change', e => AIP.picked(e.target.files[0]));

/* ---------------- 初期化 ---------------- */
const SAMPLE = [
  ['ホルベイン 透明水彩 24色セット', '絵具', 6600],
  ['ホルベイン 油絵具 20号 単色', '絵具', 770],
  ['クサカベ 油絵具 6号 単色', '絵具', 462],
  ['アルシュ 水彩紙 300g 中目', '紙', 1980],
  ['ワトソン スケッチブック F4', '紙', 1320],
  ['キャンソン パステル紙', '紙', 660],
  ['名村 彩色筆 中', '筆', 1430],
  ['ラファエル 水彩筆 8号', '筆', 4950],
  ['豚毛 油彩筆 平 10号', '筆', 880],
  ['張りキャンバス F6', 'キャンバス・パネル', 1650],
  ['シナベニヤパネル B3', 'キャンバス・パネル', 1100],
  ['ペインティングオイル 250ml', '画用液・小物', 1540]
];

async function init() {
  await DB.open();
  S.products = await DB.all('products');
  if (!S.products.length && !(await DB.getMeta('seeded', false))) {
    for (const [name, category, price] of SAMPLE) {
      const id = await DB.put('products', { name, category, price });
      S.products.push({ id, name, category, price });
    }
    await DB.setMeta('seeded', true);
  }
  S.staff = await DB.all('staff');
  S.sales = await DB.all('sales');
  S.apiKey = await DB.getMeta('apiKey', '');
  const csid = await DB.getMeta('curStaffId', null);
  S.curStaff = S.staff.find(s => s.id === csid) || null;
  $('hd-staff-name').textContent = S.curStaff ? S.curStaff.name : '未設定';

  Reg.renderCats(); Reg.renderGrid(); Reg.renderCart();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(e => console.warn('SW登録失敗:', e));
  }
}
init().catch(e => { console.error(e); alert('初期化エラー: ' + e.message); });
