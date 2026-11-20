// Pantalla de caja: carrito -> cobro (QR o tarjeta) -> pagado. Recibe el estado en tiempo real por SSE.
const $ = (id) => document.getElementById(id);
const PANELS = ['cart', 'qr', 'card', 'paid'];
const cart = new Map(); // productId -> cantidad
let products = [];
let currency = 'USD';
let order = null;
let stream = null;
let timer = null;

const fmt = (n) => Number(n).toFixed(2);
const money = (n) => `${currency} ${fmt(n)}`;

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'Error');
  return data;
}

function panel(name) {
  PANELS.forEach((p) => $(`panel-${p}`).classList.toggle('hidden', p !== name));
}

// ------------------------------------------------------------------ catálogo y carrito
function renderProducts() {
  $('products').replaceChildren(
    ...products.map((p) => {
      const b = document.createElement('button');
      b.className = 'product';
      b.type = 'button';
      const emoji = document.createElement('span');
      emoji.className = 'emoji';
      emoji.textContent = p.emoji;
      const name = document.createElement('div');
      name.textContent = p.name;
      const price = document.createElement('div');
      price.className = 'price';
      price.textContent = money(p.price);
      b.append(emoji, name, price);
      b.addEventListener('click', () => {
        if (order) return;
        cart.set(p.id, (cart.get(p.id) ?? 0) + 1);
        renderCart();
      });
      return b;
    }),
  );
}

function cartTotal() {
  let cents = 0;
  for (const [id, q] of cart) cents += Math.round(Number(products.find((p) => p.id === id).price) * 100) * q;
  return cents / 100;
}

function renderCart() {
  $('cart').replaceChildren(
    ...[...cart].map(([id, q]) => {
      const p = products.find((x) => x.id === id);
      const li = document.createElement('li');
      const qty = document.createElement('span');
      qty.className = 'qty';
      const minus = document.createElement('button');
      minus.textContent = '−';
      minus.onclick = () => { q > 1 ? cart.set(id, q - 1) : cart.delete(id); renderCart(); };
      const n = document.createElement('span');
      n.textContent = q;
      const plus = document.createElement('button');
      plus.textContent = '+';
      plus.onclick = () => { cart.set(id, q + 1); renderCart(); };
      qty.append(minus, n, plus);
      const name = document.createElement('span');
      name.textContent = p.name;
      const sub = document.createElement('span');
      sub.textContent = fmt(Number(p.price) * q);
      li.append(qty, name, sub);
      return li;
    }),
  );
  const empty = cart.size === 0;
  $('cart-empty').classList.toggle('hidden', !empty);
  $('total').textContent = money(cartTotal());
  $('pay-qr').disabled = empty;
  $('pay-card').disabled = empty;
}

$('clear').onclick = () => { cart.clear(); renderCart(); };

async function ensureOrder() {
  if (order) return order;
  order = await api('POST', '/api/orders', {
    items: [...cart].map(([productId, quantity]) => ({ productId, quantity })),
  });
  listen(order.id);
  return order;
}

// ------------------------------------------------------------------ tiempo real
function listen(id) {
  stream?.close();
  stream = new EventSource(`/api/orders/${id}/events`);
  stream.onmessage = (e) => render(JSON.parse(e.data));
}

function render(o) {
  order = o;
  $('events').replaceChildren(
    ...o.events.map((ev) => {
      const li = document.createElement('li');
      li.textContent = `${new Date(ev.at).toLocaleTimeString()} — ${ev.text}`;
      return li;
    }),
  );
  const st = $('qr-status');
  if (o.status === 'WAITING_PAYMENT') { st.className = 'status waiting'; st.textContent = 'Esperando pago…'; }
  if (o.status === 'SCANNED') { st.className = 'status scanned'; st.textContent = 'El cliente está pagando…'; }
  if (o.status === 'EXPIRED') { st.className = 'status err'; st.textContent = 'El QR venció'; }
  if (o.status === 'CANCELLED') { st.className = 'status err'; st.textContent = 'Cobro cancelado'; }
  if (o.status === 'PAID') showPaid(o);
}

function showPaid(o) {
  clearInterval(timer);
  stream?.close();
  $('paid-amount').textContent = money(o.total);
  $('paid-detail').textContent =
    o.method === 'CARD' ? `Tarjeta aprobada · código ${o.approvalCode}` : `Pagado con QR${o.payerName ? ` por ${o.payerName}` : ''}`;
  const lines = o.items.map((i) => `${String(i.quantity).padStart(2)} ${i.name.padEnd(22).slice(0, 22)} ${fmt(Number(i.unitPrice) * i.quantity).padStart(7)}`);
  $('ticket').textContent = [
    `Orden #${o.number}`,
    new Date(o.paidAt).toLocaleString(),
    '-'.repeat(33),
    ...lines,
    '-'.repeat(33),
    `TOTAL ${o.currency}${money(o.total).replace(o.currency, '').padStart(27 - o.currency.length)}`,
    `Medio: ${o.method === 'CARD' ? 'Tarjeta' : 'QR Billetera'}`,
    `Transacción: ${o.transactionId ?? '-'}`,
  ].join('\n');
  panel('paid');
}

// ------------------------------------------------------------------ cobro QR
$('pay-qr').onclick = async () => {
  try {
    await ensureOrder();
    const o = await api('POST', `/api/orders/${order.id}/qr`);
    $('qr-amount').textContent = money(o.total);
    $('qr-img').src = o.qrImage;
    $('qr-link').href = o.qrPayload;
    render(o);
    panel('qr');
    clearInterval(timer);
    timer = setInterval(() => {
      const s = Math.max(0, Math.round((new Date(o.expiresAt) - Date.now()) / 1000));
      $('qr-timer').textContent = s ? `Vence en ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '';
    }, 1000);
  } catch (e) {
    alert(e.message);
  }
};

$('refresh').onclick = async () => {
  try { render(await api('POST', `/api/orders/${order.id}/refresh`)); } catch (e) { alert(e.message); }
};

$('cancel-qr').onclick = async () => {
  try { await api('POST', `/api/orders/${order.id}/cancel`); } catch { /* ya no estaba pendiente */ }
  resetSale(false);
};

// ------------------------------------------------------------------ cobro con tarjeta
$('pay-card').onclick = async () => {
  try {
    await ensureOrder();
    $('card-amount').textContent = money(order.total);
    $('card-result').classList.add('hidden');
    panel('card');
  } catch (e) {
    alert(e.message);
  }
};

$('form-card').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const [mm, yy] = String(f.get('exp')).split('/');
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const r = await api('POST', `/api/orders/${order.id}/card`, {
      cardNumber: String(f.get('cardNumber')).replace(/\s/g, ''),
      expMonth: Number(mm),
      expYear: Number(yy),
      cvv: f.get('cvv'),
    });
    const box = $('card-result');
    box.classList.remove('hidden');
    if (r.authorization.status === 'APPROVED') {
      e.target.reset();
      render(r.order);
    } else {
      box.className = 'status err';
      box.textContent = `Rechazada: ${r.authorization.message}`;
    }
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
};

$('cancel-card').onclick = () => panel('cart');

// ------------------------------------------------------------------ nueva venta
function resetSale(clearCart = true) {
  clearInterval(timer);
  stream?.close();
  order = null;
  if (clearCart) cart.clear();
  renderCart();
  panel('cart');
}
$('new-sale').onclick = () => resetSale(true);

// ------------------------------------------------------------------ arranque
(async () => {
  const cfg = await api('GET', '/api/config');
  currency = cfg.currency;
  $('store-name').textContent = cfg.storeName;
  document.title = `${cfg.storeName} · POS`;
  $('setup-warning').classList.toggle('hidden', cfg.configured);
  products = await api('GET', '/api/products');
  renderProducts();
  renderCart();
})();
