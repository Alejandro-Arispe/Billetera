# @billetera/sdk

SDK para cobrar con la **Billetera** desde cualquier proyecto Node.js 18+ (un POS, una tienda online,
un bot). No tiene dependencias.

```bash
npm run sdk:build          # desde la raíz del monorepo: compila a packages/sdk/dist
npm install ../Billetera/packages/sdk   # en tu otro proyecto
```

## 1. Crear un cobro y mostrar el QR

```js
const { Billetera } = require('@billetera/sdk');

const billetera = new Billetera({
  apiKey: process.env.BILLETERA_API_KEY,      // sk_test_… (Perfil → Mi comercio en la app)
  baseUrl: 'http://localhost:4000/api',
});

const cobro = await billetera.payments.create({
  amount: '7.00',                 // siempre texto con 2 decimales
  currency: 'USD',                // BOB | USD | EUR
  reference: 'ORD-1001',          // id del pedido en tu sistema (reintentos = mismo cobro)
  description: 'Mesa 4',
  items: [
    { name: 'Café latte', quantity: 2, unitPrice: '3.50' },
  ],
});

// cobro.qr.image  -> "data:image/png;base64,…"  (ponlo en un <img src>)
// cobro.qr.payload -> URL que abre la página de pago al escanear
```

## 2. Saber cuándo se pagó

**Opción A: webhooks (recomendado).** Configura tu URL en *Mi comercio*. Verifica siempre la firma
con el **cuerpo crudo**:

```js
const express = require('express');
const { verifyWebhook } = require('@billetera/sdk');

app.post('/webhooks/billetera', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = verifyWebhook(req.body, req.header('billetera-signature'), process.env.BILLETERA_WEBHOOK_SECRET);
  } catch {
    return res.sendStatus(400);
  }
  if (event.type === 'payment_intent.succeeded') {
    marcarPedidoPagado(event.data.object.reference, event.data.object.payer?.name);
  }
  res.sendStatus(200);   // responde 2xx o la Billetera reintenta (10 s, 30 s, 2 min, 10 min, 30 min)
});
```

Eventos: `payment_intent.scanned` · `payment_intent.succeeded` · `payment_intent.expired` · `payment_intent.canceled`.
El mismo evento puede llegar más de una vez: usa `event.id` para no procesarlo dos veces.

**Opción B: consultar el estado** (si tu sistema no puede recibir webhooks):

```js
const final = await billetera.payments.waitForStatus(cobro.id);   // PAID, EXPIRED o CANCELLED
```

## 3. Otras operaciones

```js
await billetera.payments.retrieve(id);
await billetera.payments.list({ status: 'PAID' });
await billetera.payments.cancel(id);       // solo si sigue pendiente
```

Los errores se lanzan como `BilleteraError` con `status` (HTTP) y `body`. `status === 0` significa
que no hubo conexión.

## Estados de un cobro

`CREATED` → `SCANNED` (el cliente abrió el QR) → `PROCESSING` → `PAID`, o bien `EXPIRED` / `CANCELLED`.

El POS de demostración ([apps/pos-demo](../../apps/pos-demo/src/pos.service.ts)) usa este SDK y sirve como
ejemplo completo.
