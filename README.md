# Billetera digital (simulación) · pagos QR tipo POS

Billetera móvil simulada con multimoneda, autenticación por correo, tarjeta virtual
tipo Takenos y pagos por QR que cualquier proyecto POS puede integrar
(como una pasarela tipo Stripe). Microservicios con **NestJS + PostgreSQL + RabbitMQ**.

## Arquitectura

| Servicio | Puerto | Estado |
|---|---|---|
| api-gateway | 4000 | ✅ Etapa 1: enruta `/api/<servicio>/...` |
| auth-service | 3001 | ✅ Etapa 1: registro, OTP por correo, 2FA, sesiones, PIN |
| notification-service | 3006 | ✅ Etapa 1: correos (consume RabbitMQ) |
| wallet-service | 3002 | ✅ Etapa 2: cuentas BOB/USD/EUR, ledger, recargas, P2P, cambio de divisas |
| payments-service | 3003 | ✅ Etapa 3: comercios con API key, cobros QR firmados, webhooks |
| card-service | 3004 | ✅ Etapa 2: tarjeta virtual tipo Takenos y autorización de compras |
| kyc-service | 3005 | ✅ Etapa 4: verificación de identidad (documento + selfie) y revisión manual |
| pos-demo | 5000 | ✅ Etapa 3: caja de ejemplo que cobra con QR o tarjeta (usa el SDK, como un proyecto externo) |
| wallet-app | 4000 (`/`) | ✅ Etapa 5: app PWA (React + Vite) instalable en el celular |
| packages/sdk | — | ✅ Etapa 5: `@billetera/sdk` para que otros proyectos cobren con la billetera |

Infraestructura (Docker): PostgreSQL `5434`, RabbitMQ `5672` (panel `15672`),
Redis `6379`, Mailpit (bandeja de correo de pruebas) `8025`.

## Puesta en marcha

```powershell
npm install
copy .env.example .env      # luego cambia los secretos y claves (JWT, OTP, INTERNAL_API_KEY, CARD_ENCRYPTION_KEY)
npm run infra:up            # Postgres, RabbitMQ, Redis, Mailpit
npm run build               # compila servicios, app PWA y SDK (la app queda en dist/wallet-app)
npm run dev                 # todos los servicios + POS demo en modo watch
npm run pos:setup           # (una vez) registra el POS como comercio y crea un cliente demo
npm run smoke               # pruebas de punta a punta (auth, wallet, tarjeta, cobros QR, POS)
```

- **App de la billetera: http://localhost:4000** (o `npm run app:dev` → http://localhost:5173 con recarga en vivo)
- **POS demo: http://localhost:5000** · Página de pago rápida: http://localhost:4000/pay
- **Verificar identidad: http://localhost:4000/kyc** · **Panel de administración: http://localhost:4000/admin**
  (usuario `ADMIN_EMAIL` / `ADMIN_PASSWORD` del `.env`, se crea solo al arrancar)
- Swagger: auth :3001/docs · wallet :3002/docs · cobros :3003/docs · tarjetas :3004/docs
- Correos recibidos (códigos OTP): http://localhost:8025
- Todo dentro de Docker: `docker compose --profile apps up -d --build`

## Flujo de autenticación

1. `POST /api/auth/register` `{email, password, fullName}` → envía un código al correo
2. `POST /api/auth/verify-email` `{email, code}` → activa la cuenta y devuelve tokens
3. `POST /api/auth/login` `{email, password}` → `accessToken` (15 min) + `refreshToken` (7 días). El código por correo solo se pide al crear la cuenta.
4. `POST /api/auth/refresh` rota el refresh token. Si se reutiliza uno viejo, se cierran todas las sesiones.
5. `POST /api/auth/pin` configura el PIN de 4-6 dígitos que confirmará los pagos.

Seguridad incluida: OTP guardado como HMAC, vence a los 10 min, 5 intentos, un solo
uso y 60 s entre reenvíos. Bloqueo de 15 min tras 5 contraseñas erradas. Rate limiting.
Contraseñas y PIN con bcrypt.

### Correos reales

Por defecto los correos van a Mailpit. Para enviarlos de verdad, configura en `.env`
un SMTP (por ejemplo Gmail con *contraseña de aplicación*: `SMTP_HOST=smtp.gmail.com`,
`SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER`, `SMTP_PASSWORD`).

## Wallet (Etapa 2)

Todos los montos van como **texto con 2 decimales** (`"25.50"`); internamente se guardan en centavos enteros.

| Endpoint | Qué hace |
|---|---|
| `GET /api/wallet/accounts` | Saldos BOB, USD, EUR |
| `POST /api/wallet/topups` `{currency, amount}` | Recarga simulada (máx. 5000) |
| `POST /api/wallet/transfers` `{toEmail, currency, amount, description?, pin}` | Envío a otro usuario. Header opcional `Idempotency-Key` |
| `GET /api/wallet/transactions?currency=&page=` | Historial |
| `GET /api/wallet/fx/rates` | Tasas reales (open.er-api.com) con margen del 1.5 % |
| `POST /api/wallet/fx/quotes` → `POST /api/wallet/fx/convert` | Cotiza (válida 30 s) y ejecuta el cambio |

**Ledger de doble entrada:** cada operación genera asientos que suman 0 por moneda contra
cuentas del sistema (`TOPUP_SOURCE`, `FX_POOL`, `CARD_SETTLEMENT`, `QR_SETTLEMENT`). Los saldos se
bloquean con `SELECT … FOR UPDATE`, así dos pagos simultáneos no pueden gastar el mismo dinero.

## Tarjeta virtual tipo Takenos (apartado "Tarjetas")

1. `GET /api/cards/eligibility` → requisitos: correo verificado, PIN configurado, **identidad verificada**
   y sin otra tarjeta activa (la identidad se puede dejar de exigir con `CARD_REQUIRE_KYC=false`).
2. `POST /api/cards` `{pin}` → **Habilitar tarjeta**: VISA virtual de débito en USD, vence en 4 años.
3. `POST /api/cards/:id/details` `{pin}` → **Ver datos para rellenar**: número, vencimiento, CVV,
   titular y dirección de facturación.
4. `POST /api/cards/:id/freeze` · `/unfreeze` · `PATCH /api/cards/:id/limit` · `POST /api/cards/:id/cancel`
5. `GET /api/cards/:id/transactions` → compras aprobadas y rechazadas.

La tarjeta se paga con el saldo USD. Si el comercio cobra en BOB o EUR, se convierte al vuelo.

**Cobrar con la tarjeta (lado del comercio):** `POST /api/cards/authorizations` con el header
`x-api-key: demo-pos-key` y los datos que rellenó el cliente
`{cardNumber, expMonth, expYear, cvv, amount, currency, merchantName, reference}`.
Responde `APPROVED` con código de aprobación, o `DECLINED` con el motivo: `INVALID_CVV`,
`EXPIRED_CARD`, `CARD_FROZEN`, `LIMIT_EXCEEDED`, `INSUFFICIENT_FUNDS`, etc.
Si se repite la misma `reference`, no se cobra dos veces.

> Los números de tarjeta son simulados (BIN `40000012` + dígito Luhn válido) y solo funcionan
> dentro de este sistema. Número y CVV se guardan cifrados con AES-256-GCM.

## Cobros QR para POS y otros proyectos (Etapa 3)

```
POS / tu proyecto            payments-service                  Cliente (celular)
 │ POST /api/payments/intents  │                                     │
 │  x-api-key: sk_test_…       │                                     │
 │  {amount, currency,         │                                     │
 │   reference, items}         │                                     │
 │ ◄── {id, qr.image, qr.payload, expiresAt}                         │
 │ muestra el QR               │      escanea con la cámara ───────► │ abre {PAY_BASE_URL}/pay?i=…&s=…
 │                             │ ◄── POST /api/payments/qr/scan       │ (login)              
 │ ◄── webhook payment_intent.scanned                                │ elige cuenta (BOB/USD/EUR)
 │                             │ ◄── POST /api/payments/qr/:id/pay {pin}
 │                             │  cobra en wallet (atómico, idempotente)
 │                             │  y acredita la billetera del comercio
 │ ◄── webhook payment_intent.succeeded (firmado)  ──────────────►   │ "¡Pago realizado!"
 │ marca la orden PAGADA, imprime ticket y sigue
```

**Integrarlo en otro proyecto (3 pasos).** Guía completa para el POS de facturación (Spring Boot + Angular): [docs/INTEGRACION_POS.md](docs/INTEGRACION_POS.md)

1. El **administrador** da de alta el comercio (el POS externo) en `/admin → Comercios`
   (`POST /api/payments/admin/merchants` `{name, ownerEmail, webhookUrl}`). `ownerEmail` es la cuenta de
   la billetera que recibe el dinero. Devuelve la `apiKey` (`sk_test_…`, se muestra una vez) y el `webhookSecret`.
2. Al cobrar: `POST /api/payments/intents` con `x-api-key` → mostrar `qr.image` (PNG en data URL).
3. Recibir el webhook en `webhookUrl` y verificar la firma:
   `Billetera-Signature: t=<unix>,v1=HMAC_SHA256(webhookSecret, "<t>.<cuerpo>")`.
   Eventos: `payment_intent.scanned | succeeded | expired | canceled`.
   Si no se usan webhooks, se puede consultar `GET /api/payments/intents/:id`.

Estados: `CREATED → SCANNED → PROCESSING → PAID` (o `EXPIRED` / `CANCELLED`).
Seguridad: QR firmado con HMAC (alterarlo invalida el pago), vencimiento (5 min por defecto),
PIN obligatorio, un solo pago por QR aunque lleguen pedidos simultáneos, referencia única por
comercio (reintentos del POS devuelven el mismo QR) y webhooks firmados con reintentos
(10 s, 30 s, 2 min, 10 min, 30 min).

**POS demo** ([apps/pos-demo](apps/pos-demo)): catálogo, carrito, cobro con QR (la pantalla cambia
sola a "Pagado" con el webhook) o con los datos de la tarjeta virtual, y ticket. Usa solo la API
pública, como cualquier proyecto externo.

**Pagar desde el celular:** en `.env` pon `PAY_BASE_URL=http://<IP-de-tu-PC>:4000` (por ejemplo
`http://192.168.1.50:4000`), reinicia, y el celular debe estar en la misma red Wi-Fi. La cámara del
celular abre el link del QR. Si Windows pregunta por el firewall para Node.js, permite redes privadas.

## Verificación de identidad · KYC (Etapa 4)

Como en las fintech, para habilitar la tarjeta hay que verificar la identidad:

1. El usuario abre **/kyc** (en el celular, los campos de foto abren la cámara) y envía:
   - datos personales tal como figuran en el documento: nombres, apellidos, nacimiento, nacionalidad,
     teléfono y ocupación;
   - el documento (DNI, cédula o pasaporte), con número y vencimiento, y su domicilio;
   - foto del **frente** y del **dorso** del documento (el pasaporte no lleva dorso) y una **selfie**.
2. **Verificaciones automáticas:** mayor de 18 años, formato del documento, documento vigente, que el
   nombre coincida con el de la cuenta, que el documento no esté usado en otra cuenta, y archivos válidos
   (se revisa el contenido real del archivo, no la extensión). Si algo falla claramente, se **rechaza al
   instante** con el motivo.
3. Si no, queda **En revisión**. Un administrador la abre en **/admin**, compara la selfie con el
   documento, y la **aprueba** o la **rechaza con un motivo** (el usuario puede corregir y reenviar).
   Con `KYC_AUTO_APPROVE=true` se aprueba sola si todas las verificaciones dan PASS.
4. Al aprobarse, la cuenta toma el **nombre legal** (que va impreso en la tarjeta) y queda habilitada
   para la tarjeta virtual. El usuario recibe un correo en cada paso.

Privacidad: el número de documento y las fotos se guardan **cifrados (AES-256-GCM)** en
`storage/kyc` (fuera de git). Solo un ADMIN puede verlos, y el usuario ve su documento enmascarado.

| Endpoint | Quién |
|---|---|
| `GET /api/kyc/status` | usuario |
| `POST /api/kyc/submissions` (multipart: datos + `documentFront`, `documentBack`, `selfie`) | usuario |
| `GET /api/kyc/admin/submissions?status=PENDING` | ADMIN |
| `GET /api/kyc/admin/submissions/:id` · `/:id/files/{documentFront,documentBack,selfie}` | ADMIN |
| `POST /api/kyc/admin/submissions/:id/approve` · `/:id/reject {reason}` | ADMIN |

## App PWA y panel de administración (Etapa 5)

**App de la billetera** ([apps/wallet-app](apps/wallet-app/src)), React + Vite, pensada para el celular:

| Pantalla | Qué hace |
|---|---|
| Ingresar / Crear cuenta | Contraseña + código por correo; registro con verificación de correo |
| Inicio | Saldos BOB/USD/EUR, accesos rápidos, últimos movimientos y avisos (verificar identidad, crear PIN) |
| Actividad | Historial filtrable por moneda y comprobante de cada operación |
| Recargar · Enviar · Cambiar | Recarga simulada, envío por correo con PIN (idempotente), cambio con cotización de 30 s |
| Pagar (botón central) | Escanea el QR con la cámara (o pega el texto), elige la cuenta y paga con PIN |
| Tarjeta | Requisitos → **Habilitar tarjeta** → tarjeta visual, **Ver datos** (con PIN, para copiar en un checkout), pausar, límite mensual, compras y baja |
| Perfil | Identidad (formulario de verificación con cámara), PIN, **Mi comercio** (alta, API key, webhook) y acceso al panel si eres ADMIN |

Es **instalable** (manifest + service worker + íconos). El service worker guarda la app para que
abra rápido, pero **nunca** guarda en caché respuestas de la API (saldos y pagos siempre son en vivo).

> **En el celular:** el navegador solo permite la **cámara** e **instalar la app** en `https` o en
> `localhost`. Por la red local (`http://192.168.x.x:4000`) la app funciona, pero para escanear se usa
> la cámara del teléfono, que abre el link del QR. Para tener cámara e instalación en el celular, publica
> el gateway con un túnel HTTPS (por ejemplo `cloudflared tunnel --url http://localhost:4000`) y pon esa
> URL en `PAY_BASE_URL`.

**Panel de administración** (`/admin`):
- **Resumen:** usuarios, verificaciones pendientes, operaciones, dinero total de los usuarios por moneda
  y control del ledger (si cuadra).
- **Usuarios:** búsqueda, bloquear y desbloquear. Un usuario bloqueado no puede ingresar, se cierran sus
  sesiones y no puede mover dinero aunque su token siga vigente.
- **Transacciones:** cada operación con sus asientos de doble entrada.
- **Comercios:** cobros, pagos y volumen de cada uno, y webhooks fallidos.
- **Verificaciones:** revisión de identidad (KYC).

**SDK para comercios:** ver [packages/sdk/README.md](packages/sdk/README.md). El POS demo lo usa.

## Despliegue en una máquina virtual (Azure)

Todo corre en una sola VM con Docker Compose ([deploy/](deploy/)). Caddy pone HTTPS automático
(Let's Encrypt), así la cámara y la instalación de la app funcionan en el celular.

| URL | Qué es |
|---|---|
| `https://DOMINIO` | App de la billetera, `/pay`, `/kyc`, `/admin` y la API (`/api/...`) |
| `https://DOMINIO/correo/` | Bandeja de Mailpit (códigos de registro) si no configuraste SMTP real |
| `https://DOMINIO:8443` | POS de demostración |

Primera vez, en una VM Ubuntu con los puertos 80, 443 y 8443 abiertos:

```bash
git clone <este repo> billetera && cd billetera
bash deploy/setup-vm.sh <dominio>      # instala Docker, genera deploy/.env con secretos y levanta todo
```

Actualizar: `git pull && cd deploy && sudo docker compose up -d --build`.
Para enviar los códigos de registro a correos reales, completa `SMTP_*` en `deploy/.env`.

## Hoja de ruta

1. ✅ Base: monorepo, Docker, gateway, auth con OTP por correo
2. ✅ Wallet multimoneda, ledger, P2P, FX real + tarjeta virtual tipo Takenos
3. ✅ Cobros QR + página de pago + POS de demostración (webhooks firmados + SSE)
4. ✅ KYC: documento + selfie, verificaciones automáticas, panel de revisión, tarjeta exige identidad
5. ✅ App PWA instalable que une todo, panel de administración completo y SDK para comercios
