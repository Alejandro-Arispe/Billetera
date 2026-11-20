# Integrar la pasarela QR de la Billetera en el POS de facturación

Guía para conectar **POS_facturacion** (backend Spring Boot + frontend Angular) con la Billetera,
que funciona como pasarela de pagos al estilo Stripe:

- **Cobro con QR**: el POS crea un cobro, muestra el QR, el cliente lo paga desde la billetera
  móvil y el POS recibe la confirmación (webhook firmado). Recién ahí registra la venta.
- **Cobro con la tarjeta virtual** (opcional): el cajero ingresa los datos de la tarjeta de la
  billetera y el POS pide la autorización, como con una terminal ATC/Linkser.

El POS no necesita saber nada de usuarios, saldos ni monedas de la billetera: solo usa una API key.

```
POS (Angular)            POS backend (Spring, AWS)                Billetera (Azure)
─────────────            ─────────────────────────                ─────────────────
Cobrar 150 Bs con QR ──► POST /api/billetera/cobros ────────────► POST /api/payments/intents
                                                    ◄──────────── { id, qr.image, expiresAt }
muestra el QR        ◄── { id, qr_image, ... }
                                                                  el cliente escanea y paga
                         POST /api/billetera/webhook ◄─────────── payment_intent.succeeded (firmado)
                         guarda el cobro como PAID
consulta cada 2 s    ──► GET /api/billetera/cobros/{id} → PAID
registra la venta    ──► POST /api/.../ventas  (pago QR con referencia_billetera = id)
                         valida que el cobro esté PAID, por ese monto y sin usar
```

> **Regla de oro:** la API key y el secreto de webhooks viven **solo en el backend**. El frontend
> Angular nunca habla directo con la billetera.

---

## 1. Datos de la billetera

| Qué | Valor |
|---|---|
| URL base de la API | `https://billetera-qr-7k3.eastus2.cloudapp.azure.com/api` |
| App de la billetera (clientes) | `https://billetera-qr-7k3.eastus2.cloudapp.azure.com` |
| Panel de administración | `https://billetera-qr-7k3.eastus2.cloudapp.azure.com/admin` |
| Documentación interactiva (Swagger) | Cada servicio expone `/docs` dentro del servidor |
| Moneda | `BOB` (también acepta `USD` y `EUR`) |

### Obtener las credenciales del POS

1. Crea (o elige) la **cuenta de la billetera que recibirá el dinero** de las ventas, por ejemplo
   `caja@tuempresa.bo`. Es una cuenta normal: se registra en la app con correo y contraseña.
2. Entra al **panel de administración → Comercios → Nuevo comercio** y completa:
   - **Nombre:** el nombre de la empresa (es lo que el cliente ve al pagar).
   - **Cuenta que recibe el dinero:** el correo del paso 1.
   - **URL de webhooks:** `https://<dominio-de-tu-POS>/api/billetera/webhook`
3. El panel muestra **una sola vez** la `BILLETERA_API_KEY` y el `BILLETERA_WEBHOOK_SECRET`. Cópialos.
4. Para cobrar con la tarjeta virtual también necesitas la **clave de adquirente**: es el valor de
   `CARD_ACQUIRER_API_KEYS` en `deploy/.env` del servidor de la billetera.

Con un solo comercio se pueden atender todas las empresas y sucursales del POS: la `referencia` de
cada cobro identifica la venta. Si quieres que cada empresa reciba su dinero en una cuenta distinta,
da de alta un comercio por empresa y guarda su API key junto a la empresa.

---

## 2. API de la billetera (lo que usa el backend)

Todas las llamadas llevan la cabecera `x-api-key: <BILLETERA_API_KEY>` y JSON en el cuerpo.
Los montos son **texto con 2 decimales** (`"150.00"`), nunca números con coma flotante.

### Crear un cobro QR

`POST /api/payments/intents`

```json
{
  "amount": "150.00",
  "currency": "BOB",
  "reference": "VENTA-12-1732050000",
  "description": "Mi Empresa · Caja 1",
  "items": [
    { "name": "Coca Cola 2L", "quantity": 2, "unitPrice": "15.00" },
    { "name": "Pan", "quantity": 12, "unitPrice": "10.00" }
  ],
  "expiresInSeconds": 300
}
```

- `reference` es **única por comercio**: si reenvías la misma referencia con el mismo monto obtienes
  el mismo cobro (idempotencia); con otro monto responde `409`.
- `items` es opcional; si lo envías, la suma debe ser exactamente `amount`.
- `expiresInSeconds`: vigencia del QR (15 a 3600, por defecto 300).

Respuesta `201`:

```json
{
  "id": "6f1c0b2e-…",
  "object": "payment_intent",
  "status": "CREATED",
  "amount": "150.00",
  "currency": "BOB",
  "reference": "VENTA-12-1732050000",
  "expiresAt": "2026-11-20T15:05:00.000Z",
  "payer": null,
  "qr": {
    "payload": "https://billetera-…/pay?i=6f1c…&s=…",
    "image": "data:image/png;base64,iVBORw0…"
  }
}
```

`qr.image` se puede poner directo en un `<img [src]>`. Si el cliente escanea el QR con la cámara del
celular, se abre la página de pago de la billetera.

### Consultar, listar y cancelar

| Método | Ruta | Uso |
|---|---|---|
| `GET` | `/api/payments/intents/{id}` | Estado actual (respaldo si se pierde un webhook) |
| `GET` | `/api/payments/intents?status=PAID` | Listar cobros |
| `POST` | `/api/payments/intents/{id}/cancel` | Cancelar un cobro pendiente (el cliente cerró la venta) |
| `GET` | `/api/payments/intents/{id}/webhooks` | Historial de entregas de webhooks |

Estados: `CREATED` → `SCANNED` (el cliente lo abrió) → `PROCESSING` → `PAID`, o bien `EXPIRED` /
`CANCELLED`. Solo **`PAID`** significa que el dinero se movió.

### Webhooks

La billetera hace `POST` a la URL configurada con estos eventos:

| Evento | Cuándo |
|---|---|
| `payment_intent.scanned` | El cliente abrió el cobro en su billetera |
| `payment_intent.succeeded` | **Pagado.** El dinero ya está en la cuenta receptora |
| `payment_intent.expired` | Venció sin pagarse |
| `payment_intent.canceled` | El POS lo canceló |

Cuerpo: `{ "id": "evt_…", "type": "payment_intent.succeeded", "createdAt": "…", "data": { "object": { …cobro… } } }`

Cabecera de firma: `Billetera-Signature: t=<unix-seconds>,v1=<hex>` donde
`v1 = HMAC-SHA256(BILLETERA_WEBHOOK_SECRET, "<t>.<cuerpo crudo>")`.

El POS debe:
1. calcular el HMAC sobre el **cuerpo crudo** (antes de parsear el JSON);
2. comparar en tiempo constante;
3. rechazar si `t` tiene más de 5 minutos (evita repeticiones);
4. responder `2xx` rápido. Si no, la billetera reintenta a los 10 s, 30 s, 2 min, 10 min y 30 min.

Un mismo evento puede llegar más de una vez: procésalo de forma idempotente.

### Cobro con la tarjeta virtual (opcional)

`POST /api/cards/authorizations` con cabecera `x-api-key: <clave de adquirente>`

```json
{
  "cardNumber": "4000001234567890",
  "expMonth": 11,
  "expYear": 2030,
  "cvv": "123",
  "holderName": "ANA PEREZ",
  "amount": "150.00",
  "currency": "BOB",
  "merchantName": "Mi Empresa",
  "reference": "VENTA-12-1732050000-T"
}
```

Responde `200` siempre que la solicitud sea válida; mira `status`:

```json
{ "authorizationId": "…", "status": "APPROVED", "approvalCode": "482913", "message": "Pago aprobado",
  "amount": "150.00", "currency": "BOB", "debited": "21.95", "debitedCurrency": "USD", "cardLast4": "7890" }
```

o `"status": "DECLINED"` con `declineCode` y `message` (fondos insuficientes, tarjeta pausada, CVV
incorrecto, límite mensual…). La tarjeta es en USD; si cobras en BOB, la billetera convierte al
tipo de cambio del día.

---

## 3. Backend Spring Boot

Todo va en un paquete nuevo `com.pos.billetera`, siguiendo el mismo estilo que `com.pos.pagos`
(la integración con Stripe).

### 3.1 Configuración

`application.yml` (junto a `app.stripe`):

```yaml
app:
  billetera:
    api-url: ${BILLETERA_API_URL:}
    api-key: ${BILLETERA_API_KEY:}
    webhook-secret: ${BILLETERA_WEBHOOK_SECRET:}
    acquirer-key: ${BILLETERA_ACQUIRER_KEY:}
```

`deploy/docker-compose.yml`, en `backend.environment`:

```yaml
      BILLETERA_API_URL: ${BILLETERA_API_URL:-}
      BILLETERA_API_KEY: ${BILLETERA_API_KEY:-}
      BILLETERA_WEBHOOK_SECRET: ${BILLETERA_WEBHOOK_SECRET:-}
      BILLETERA_ACQUIRER_KEY: ${BILLETERA_ACQUIRER_KEY:-}
```

`deploy/.env` del servidor en AWS:

```bash
BILLETERA_API_URL=https://billetera-qr-7k3.eastus2.cloudapp.azure.com/api
BILLETERA_API_KEY=sk_test_...            # del panel de administración
BILLETERA_WEBHOOK_SECRET=whsec_...       # del panel de administración
BILLETERA_ACQUIRER_KEY=acq_...           # CARD_ACQUIRER_API_KEYS de la billetera
```

`SecurityConfig`: el webhook entra sin JWT (lo protege la firma), igual que el de Stripe:

```java
.requestMatchers("/api/pagos/webhook").permitAll()
.requestMatchers("/api/billetera/webhook").permitAll()   // ← agregar
```

### 3.2 Entidad `CobroBilletera`

Guarda cada cobro QR para saber su estado y que se use en **una sola** venta.
Con `ddl-auto: update` la tabla se crea sola.

```java
package com.pos.billetera.domain;

import java.math.BigDecimal;
import java.time.LocalDateTime;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

@Getter
@Setter
@Entity
@Table(name = "cobro_billetera")
public class CobroBilletera {

    /** Id del cobro en la billetera (UUID). */
    @Id
    @Column(name = "id_cobro", length = 36)
    private String idCobro;

    @Column(name = "referencia", nullable = false, unique = true, length = 64)
    private String referencia;

    @Column(name = "id_empresa", nullable = false)
    private Integer idEmpresa;

    @Column(name = "monto", nullable = false, precision = 12, scale = 2)
    private BigDecimal monto;

    @Column(name = "moneda", nullable = false, length = 3)
    private String moneda = "BOB";

    /** CREATED, SCANNED, PROCESSING, PAID, EXPIRED o CANCELLED (el de la billetera). */
    @Column(name = "estado", nullable = false, length = 12)
    private String estado;

    @Column(name = "pagado_por", length = 120)
    private String pagadoPor;

    @Column(name = "id_venta")
    private Integer idVenta;

    @Column(name = "vence", nullable = false)
    private LocalDateTime vence;

    @Column(name = "fecha_creacion", nullable = false)
    private LocalDateTime fechaCreacion = LocalDateTime.now();

    @Column(name = "fecha_pago")
    private LocalDateTime fechaPago;
}
```

```java
package com.pos.billetera.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import com.pos.billetera.domain.CobroBilletera;

public interface CobroBilleteraRepository extends JpaRepository<CobroBilletera, String> {}
```

### 3.3 Cliente HTTP y verificación de la firma

Se usan `Map` para los cuerpos: así la estrategia `SNAKE_CASE` del proyecto no renombra los campos
que espera la billetera (`unitPrice`, `expiresInSeconds`…).

```java
package com.pos.billetera.service;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import com.pos.common.exception.ApiException;

/** Cliente de la API de la billetera (cobros QR y tarjeta virtual). */
@Component
public class BilleteraClient {

    private final RestClient http;
    private final ObjectMapper json;
    private final String apiKey;
    private final String webhookSecret;
    private final String acquirerKey;

    public BilleteraClient(ObjectMapper json,
            @Value("${app.billetera.api-url:}") String apiUrl,
            @Value("${app.billetera.api-key:}") String apiKey,
            @Value("${app.billetera.webhook-secret:}") String webhookSecret,
            @Value("${app.billetera.acquirer-key:}") String acquirerKey) {
        this.json = json;
        this.http = RestClient.builder().baseUrl(apiUrl).build();
        this.apiKey = apiKey;
        this.webhookSecret = webhookSecret;
        this.acquirerKey = acquirerKey;
    }

    public JsonNode crearCobro(BigDecimal monto, String referencia, String descripcion, List<Map<String, Object>> items) {
        var body = new java.util.HashMap<String, Object>();
        body.put("amount", monto.setScale(2, java.math.RoundingMode.HALF_UP).toPlainString());
        body.put("currency", "BOB");
        body.put("reference", referencia);
        body.put("expiresInSeconds", 300);
        if (descripcion != null) body.put("description", descripcion);
        if (items != null && !items.isEmpty()) body.put("items", items);
        return llamar("POST", "/payments/intents", apiKey, body);
    }

    public JsonNode obtenerCobro(String id) {
        return llamar("GET", "/payments/intents/" + id, apiKey, null);
    }

    public JsonNode cancelarCobro(String id) {
        return llamar("POST", "/payments/intents/" + id + "/cancel", apiKey, Map.of());
    }

    public JsonNode autorizarTarjeta(Map<String, Object> body) {
        return llamar("POST", "/cards/authorizations", acquirerKey, body);
    }

    private JsonNode llamar(String metodo, String ruta, String key, Object body) {
        if (key == null || key.isBlank()) throw ApiException.badRequest("La billetera no está configurada en este servidor.");
        try {
            var req = http.method(org.springframework.http.HttpMethod.valueOf(metodo)).uri(ruta)
                    .header("x-api-key", key).accept(MediaType.APPLICATION_JSON);
            if (body != null) req = req.contentType(MediaType.APPLICATION_JSON).body(json.writeValueAsString(body));
            return json.readTree(req.retrieve().body(String.class));
        } catch (RestClientResponseException e) {
            String msg = e.getResponseBodyAsString();
            try { msg = json.readTree(msg).path("message").asText(msg); } catch (Exception ignored) { }
            throw ApiException.badRequest("Billetera: " + msg);
        }
    }

    /**
     * Verifica la cabecera Billetera-Signature (t=...,v1=...) sobre el cuerpo crudo.
     * Rechaza firmas inválidas o de más de 5 minutos.
     */
    public JsonNode verificarWebhook(String cuerpo, String firma) {
        if (firma == null || webhookSecret.isBlank()) throw ApiException.badRequest("Webhook sin firma.");
        String t = null, v1 = null;
        for (String parte : firma.split(",")) {
            String[] kv = parte.trim().split("=", 2);
            if (kv.length != 2) continue;
            if (kv[0].equals("t")) t = kv[1];
            if (kv[0].equals("v1")) v1 = kv[1];
        }
        if (t == null || v1 == null) throw ApiException.badRequest("Firma de webhook inválida.");
        if (Math.abs(Instant.now().getEpochSecond() - Long.parseLong(t)) > 300) {
            throw ApiException.badRequest("Webhook vencido.");
        }
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(webhookSecret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] esperado = mac.doFinal((t + "." + cuerpo).getBytes(StandardCharsets.UTF_8));
            if (!MessageDigest.isEqual(esperado, HexFormat.of().parseHex(v1))) {
                throw ApiException.badRequest("Firma de webhook inválida.");
            }
            return json.readTree(cuerpo);
        } catch (ApiException e) {
            throw e;
        } catch (Exception e) {
            throw ApiException.badRequest("Firma de webhook inválida.");
        }
    }
}
```

> Si tu `ApiException` no tiene `badRequest(...)` con ese nombre, usa el equivalente que ya
> usa `PagoService`.

### 3.4 Servicio

```java
package com.pos.billetera.service;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import tools.jackson.databind.JsonNode;

import com.pos.billetera.domain.CobroBilletera;
import com.pos.billetera.repo.CobroBilleteraRepository;
import com.pos.common.exception.ApiException;

@Service
public class BilleteraService {

    private static final ZoneId BOLIVIA = ZoneId.of("America/La_Paz");
    private final BilleteraClient client;
    private final CobroBilleteraRepository cobros;

    public BilleteraService(BilleteraClient client, CobroBilleteraRepository cobros) {
        this.client = client;
        this.cobros = cobros;
    }

    /** Crea el cobro en la billetera y devuelve el QR para mostrar en caja. */
    @Transactional
    public Map<String, Object> crearCobro(Integer idEmpresa, BigDecimal monto, String descripcion) {
        if (monto == null || monto.signum() <= 0) throw ApiException.badRequest("Monto inválido.");
        String referencia = "POS-" + idEmpresa + "-" + System.currentTimeMillis();
        JsonNode intent = client.crearCobro(monto, referencia, descripcion, List.of());

        CobroBilletera c = new CobroBilletera();
        c.setIdCobro(intent.path("id").asText());
        c.setReferencia(referencia);
        c.setIdEmpresa(idEmpresa);
        c.setMonto(new BigDecimal(intent.path("amount").asText()));
        c.setMoneda(intent.path("currency").asText("BOB"));
        c.setEstado(intent.path("status").asText());
        c.setVence(fecha(intent.path("expiresAt").asText()));
        cobros.save(c);

        return Map.of(
                "id", c.getIdCobro(),
                "estado", c.getEstado(),
                "monto", c.getMonto(),
                "referencia", referencia,
                "vence", intent.path("expiresAt").asText(),
                "qr_imagen", intent.path("qr").path("image").asText(),
                "qr_texto", intent.path("qr").path("payload").asText());
    }

    /**
     * Estado del cobro. Normalmente lo actualiza el webhook; si todavía figura pendiente se consulta
     * a la billetera (por si el webhook no llegó: firewall, reinicio del servidor, etc.).
     */
    @Transactional
    public Map<String, Object> estado(String idCobro) {
        CobroBilletera c = cobros.findById(idCobro).orElseThrow(() -> ApiException.notFound("Cobro no encontrado."));
        if (!esFinal(c.getEstado())) aplicar(c, client.obtenerCobro(idCobro));
        return Map.of("id", c.getIdCobro(), "estado", c.getEstado(), "monto", c.getMonto(),
                "pagado_por", c.getPagadoPor() == null ? "" : c.getPagadoPor());
    }

    @Transactional
    public void cancelar(String idCobro) {
        CobroBilletera c = cobros.findById(idCobro).orElseThrow(() -> ApiException.notFound("Cobro no encontrado."));
        if (esFinal(c.getEstado())) return;
        aplicar(c, client.cancelarCobro(idCobro));
    }

    /** Webhook de la billetera (firma ya verificada). Idempotente. */
    @Transactional
    public void webhook(JsonNode evento) {
        JsonNode intent = evento.path("data").path("object");
        cobros.findById(intent.path("id").asText()).ifPresent(c -> aplicar(c, intent));
    }

    /**
     * Llamar desde VentaService al registrar una venta con pago QR: exige que el cobro esté PAGADO,
     * por el mismo monto y que no se haya usado en otra venta. Lo marca como usado.
     */
    @Transactional
    public void consumirParaVenta(String idCobro, BigDecimal monto, Integer idEmpresa, Integer idVenta) {
        CobroBilletera c = cobros.findById(idCobro)
                .orElseThrow(() -> ApiException.badRequest("El cobro QR no existe."));
        if (!"PAID".equals(c.getEstado())) aplicar(c, client.obtenerCobro(idCobro));
        if (!"PAID".equals(c.getEstado())) throw ApiException.badRequest("El cobro QR todavía no fue pagado.");
        if (!c.getIdEmpresa().equals(idEmpresa)) throw ApiException.badRequest("El cobro QR es de otra empresa.");
        if (c.getMonto().compareTo(monto) != 0) throw ApiException.badRequest("El monto del pago QR no coincide con el cobro.");
        if (c.getIdVenta() != null) throw ApiException.badRequest("Ese cobro QR ya se usó en otra venta.");
        c.setIdVenta(idVenta);
    }

    private void aplicar(CobroBilletera c, JsonNode intent) {
        c.setEstado(intent.path("status").asText(c.getEstado()));
        if (intent.hasNonNull("payer")) c.setPagadoPor(intent.path("payer").path("name").asText(null));
        if (intent.hasNonNull("paidAt")) c.setFechaPago(fecha(intent.path("paidAt").asText()));
    }

    private static boolean esFinal(String estado) {
        return List.of("PAID", "EXPIRED", "CANCELLED").contains(estado);
    }

    private static LocalDateTime fecha(String iso) {
        return LocalDateTime.ofInstant(Instant.parse(iso), BOLIVIA);
    }
}
```

### 3.5 Controlador

```java
package com.pos.billetera.web;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.Map;

import org.springframework.web.bind.annotation.*;

import jakarta.servlet.http.HttpServletRequest;

import com.pos.billetera.service.BilleteraClient;
import com.pos.billetera.service.BilleteraService;

@RestController
@RequestMapping("/api/billetera")
public class BilleteraController {

    private final BilleteraService service;
    private final BilleteraClient client;

    public BilleteraController(BilleteraService service, BilleteraClient client) {
        this.service = service;
        this.client = client;
    }

    /** Body: { "id_empresa": 1, "monto": 150.00, "descripcion": "Caja 1" } */
    @PostMapping("/cobros")
    public Map<String, Object> crear(@RequestBody Map<String, Object> body) {
        // Valida aquí que el usuario actual tenga acceso a la empresa (EmpresaAccess / RBAC del POS).
        Integer idEmpresa = Integer.valueOf(body.get("id_empresa").toString());
        BigDecimal monto = new BigDecimal(body.get("monto").toString());
        Object desc = body.get("descripcion");
        return service.crearCobro(idEmpresa, monto, desc == null ? null : desc.toString());
    }

    @GetMapping("/cobros/{id}")
    public Map<String, Object> estado(@PathVariable String id) {
        return service.estado(id);
    }

    @PostMapping("/cobros/{id}/cancelar")
    public Map<String, Object> cancelar(@PathVariable String id) {
        service.cancelar(id);
        return Map.of("ok", true);
    }

    /** Autoriza un cobro con la tarjeta virtual de la billetera (los datos no se guardan). */
    @PostMapping("/tarjeta/autorizar")
    public Object autorizarTarjeta(@RequestBody Map<String, Object> body) {
        return client.autorizarTarjeta(Map.of(
                "cardNumber", body.get("numero").toString().replaceAll("\\D", ""),
                "expMonth", Integer.valueOf(body.get("mes").toString()),
                "expYear", Integer.valueOf(body.get("anio").toString()),
                "cvv", body.get("cvv").toString(),
                "holderName", body.getOrDefault("titular", "").toString(),
                "amount", new BigDecimal(body.get("monto").toString()).setScale(2).toPlainString(),
                "currency", "BOB",
                "merchantName", body.getOrDefault("comercio", "POS").toString(),
                "reference", "TJ-" + System.currentTimeMillis()));
    }

    /** Webhook de la billetera: público, protegido por la firma HMAC. */
    @PostMapping("/webhook")
    public Map<String, Object> webhook(HttpServletRequest request) throws java.io.IOException {
        String cuerpo = new String(request.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        service.webhook(client.verificarWebhook(cuerpo, request.getHeader("Billetera-Signature")));
        return Map.of("received", true);
    }
}
```

> `autorizarTarjeta` devuelve el `JsonNode` tal cual (con nombres en camelCase:
> `status`, `approvalCode`, `message`, `cardLast4`).

### 3.6 Validar el pago QR al registrar la venta

En `VentaDtos.PagoCreate` agrega el campo (llega como `referencia_billetera` por el `SNAKE_CASE`):

```java
public static class PagoCreate {
    private Integer idMetodoPago;
    private BigDecimal monto;
    /** Id del cobro QR de la billetera (solo para el método QR). */
    private String referenciaBilletera;
}
```

En `VentaService`, inyecta `BilleteraService` y, **después de guardar la venta** (cuando ya existe
`venta.getIdVenta()`), dentro del mismo `@Transactional`, valida cada pago QR. Así, si el cobro no
es válido, se revierte toda la venta:

```java
for (VentaDtos.PagoCreate pago : pagosPayload) {
    MetodoPago metodo = metodoPagoRepository.findById(pago.getIdMetodoPago()).orElseThrow();
    if ("QR".equalsIgnoreCase(metodo.getNombre().trim())) {
        if (pago.getReferenciaBilletera() == null || pago.getReferenciaBilletera().isBlank()) {
            throw ApiException.badRequest("El pago QR debe confirmarse con la billetera.");
        }
        billeteraService.consumirParaVenta(pago.getReferenciaBilletera(), pago.getMonto(), idEmpresa, venta.getIdVenta());
    }
}
```

---

## 4. Frontend Angular (pantalla de ventas)

Hoy `sales.ts` arma un "QR Simple" simulado y el cajero confirma a mano con **"Confirmar pago
recibido"**. Hay que cambiarlo para que el QR venga de la billetera y la confirmación sea automática.

### 4.1 Servicio

`src/app/core/services/billetera.service.ts`:

```ts
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

export interface CobroQr {
  id: string;
  estado: 'CREATED' | 'SCANNED' | 'PROCESSING' | 'PAID' | 'EXPIRED' | 'CANCELLED';
  monto: number;
  referencia: string;
  vence: string;
  qr_imagen: string;
  qr_texto: string;
}

export interface EstadoCobro {
  id: string;
  estado: CobroQr['estado'];
  monto: number;
  pagado_por: string;
}

@Injectable({ providedIn: 'root' })
export class BilleteraService {
  private readonly api = inject(ApiService);

  crearCobro(idEmpresa: number, monto: number, descripcion: string): Observable<CobroQr> {
    return this.api.post<CobroQr, unknown>('/api/billetera/cobros', { id_empresa: idEmpresa, monto, descripcion });
  }

  estado(id: string): Observable<EstadoCobro> {
    return this.api.get<EstadoCobro>(`/api/billetera/cobros/${id}`);
  }

  cancelar(id: string): Observable<unknown> {
    return this.api.post<unknown, unknown>(`/api/billetera/cobros/${id}/cancelar`, {});
  }

  autorizarTarjeta(datos: { numero: string; mes: number; anio: number; cvv: string; titular: string; monto: number; comercio: string }) {
    return this.api.post<{ status: 'APPROVED' | 'DECLINED'; approvalCode?: string; message: string; cardLast4?: string }, unknown>(
      '/api/billetera/tarjeta/autorizar', datos);
  }
}
```

### 4.2 Cambios en `sales.ts`

1. En `SalePaymentRow`, agrega el id del cobro:

```ts
interface SalePaymentRow {
  id: number;
  metodoPagoId: number | null;
  monto: number | null;
  qrConfirmado?: boolean;
  /** Id del cobro QR en la billetera; se envía al registrar la venta. */
  cobroId?: string;
  tarjeta?: CardForm;
}
```

2. Inyecta el servicio y guarda los temporizadores de consulta:

```ts
private readonly billetera = inject(BilleteraService);
private readonly qrPollers = new Map<number, ReturnType<typeof setInterval>>();
```

3. Reemplaza `generateQr` por la versión real. Cada 2 s consulta el estado; cuando llega `PAID`
   marca la fila como confirmada:

```ts
protected generateQr(row: SalePaymentRow): void {
  this.stopQrPolling(row);
  if (row.cobroId) this.billetera.cancelar(row.cobroId).subscribe();   // QR anterior (monto cambiado)
  row.qrConfirmado = false;
  row.cobroId = undefined;
  const monto = this.normalizeMoney(row.monto);
  if (!(monto > 0) || !this.companyId) return;

  this.billetera.crearCobro(Number(this.companyId), monto, this.companyName || 'Venta POS').subscribe({
    next: (cobro) => {
      row.cobroId = cobro.id;
      this.qrImages.set(row.id, cobro.qr_imagen);
      this.qrInfo.set(row.id, { banco: 'Billetera', referencia: cobro.referencia, vence: new Date(cobro.vence) });
      this.qrPollers.set(row.id, setInterval(() => this.checkQr(row), 2000));
      this.cdr.markForCheck();
    },
    error: (e) => { this.registerError = e?.error?.detail ?? e?.error?.message ?? 'No se pudo crear el cobro QR.'; this.cdr.markForCheck(); },
  });
}

private checkQr(row: SalePaymentRow): void {
  if (!row.cobroId) return this.stopQrPolling(row);
  this.billetera.estado(row.cobroId).subscribe((s) => {
    if (s.estado === 'PAID') {
      row.qrConfirmado = true;
      this.stopQrPolling(row);
    } else if (s.estado === 'EXPIRED' || s.estado === 'CANCELLED') {
      this.stopQrPolling(row);
      this.registerError = 'El QR venció. Genera uno nuevo.';
    }
    this.cdr.markForCheck();
  });
}

private stopQrPolling(row: SalePaymentRow): void {
  clearInterval(this.qrPollers.get(row.id));
  this.qrPollers.delete(row.id);
}
```

   Como `generateQr` ya no es `async`, quita el `void` donde se llama
   (`if (this.isQrRow(row)) this.generateQr(row);`). Cuando cambie el monto de una fila QR, llama
   otra vez a `generateQr(row)` para que el QR tenga el monto nuevo. Al salir de la pantalla
   (`destroyRef.onDestroy`), limpia los intervalos.

4. Borra `confirmQrPayment` (ya no se confirma a mano) y, al armar el payload de la venta, envía
   la referencia:

```ts
const paymentRows = this.salePaymentRows
  .map((row) => ({
    id_metodo_pago: row.metodoPagoId ?? null,
    monto: this.normalizeMoney(row.monto),
    referencia_billetera: this.isQrRow(row) ? row.cobroId : undefined,
  }))
```

   Y agrega `referencia_billetera?: string` a la interfaz de pagos de `CreateSaleRequest`.

### 4.3 Cambios en `sales.html`

Quita el selector de banco y el botón manual; deja el QR, el texto y el estado:

```html
@if (isQrRow(paymentRow)) {
  <div class="qr-payment" role="group" aria-label="Pago con QR de la billetera">
    @if (qrImages.get(paymentRow.id); as qr) {
      <img class="qr-payment-image" [src]="qr" alt="QR para pagar con la billetera" width="220" height="220" />
    }
    @if (qrInfo.get(paymentRow.id); as info) {
      <p class="qr-payment-text">
        <strong>Paga con tu Billetera</strong><br />
        Cobro a {{ companyName || 'este comercio' }} por <strong>Bs {{ formatCurrency(paymentRow.monto ?? 0) }}</strong><br />
        <small>Ref. {{ info.referencia }} · Válido hasta {{ info.vence | date: 'HH:mm' }}</small>
      </p>
    }
    @if (paymentRow.qrConfirmado) {
      <p class="feedback feedback-success">Pago recibido ✓</p>
    } @else {
      <p class="muted">Esperando el pago… se confirma solo.</p>
      <button class="btn btn-secondary" type="button" (click)="generateQr(paymentRow)">Generar otro QR</button>
    }
  </div>
}
```

### 4.4 Tarjeta virtual (opcional)

En `authorizeCard`, reemplaza el `setTimeout` simulado por la llamada real:

```ts
card.procesando = true;
const [mm, yy] = card.vencimiento.split('/').map(Number);
this.billetera.autorizarTarjeta({
  numero: digits, mes: mm, anio: 2000 + yy, cvv: card.cvv, titular: card.titular,
  monto: this.normalizeMoney(row.monto), comercio: this.companyName || 'POS',
}).subscribe({
  next: (r) => {
    card.procesando = false;
    if (r.status === 'APPROVED') {
      card.autorizacion = r.approvalCode ?? '';
      card.ultimos4 = r.cardLast4 ?? digits.slice(-4);
      card.marca = 'Visa';
      card.numero = '•••• •••• •••• ' + card.ultimos4;
      card.cvv = '';
    } else {
      card.error = r.message;
    }
    this.cdr.markForCheck();
  },
  error: (e) => { card.procesando = false; card.error = e?.error?.detail ?? 'No se pudo autorizar.'; this.cdr.markForCheck(); },
});
```

Los datos de la tarjeta se ven en la app de la billetera: **Tarjeta → Ver datos**.

---

## 5. Probar de punta a punta

1. En la billetera (`https://billetera-qr-7k3.eastus2.cloudapp.azure.com`):
   - crea la cuenta receptora (`caja@…`);
   - crea una cuenta de cliente, recárgala en **Recargar** (BOB) y configura el **PIN** en Perfil.
2. En el panel `/admin → Comercios`, da de alta el POS con la URL del webhook y copia las claves al
   `deploy/.env` del POS. Reinicia el backend: `docker compose up -d backend`.
3. En el POS, haz una venta y elige **QR**. Aparece el QR de la billetera.
4. Desde el celular, abre la billetera → **Pagar** y escanea el QR (o escanéalo con la cámara del
   teléfono). Confirma con el PIN.
5. En 2 s el POS muestra **Pago recibido ✓**. Registra la venta.
6. Comprueba:
   - en la billetera, la cuenta receptora tiene el dinero (**Actividad**);
   - en `/admin → Comercios`, el cobro figura como pagado y los webhooks como entregados;
   - si intentas registrar otra venta con el mismo cobro, el backend la rechaza.

### Problemas comunes

| Síntoma | Causa probable |
|---|---|
| `401 API key de comercio inválida` | `BILLETERA_API_KEY` mal copiada o se generó una nueva en el panel |
| El POS no se entera del pago | Webhook mal configurado o firma rechazada. El respaldo (`GET /cobros/{id}`) igual lo detecta en 2 s. Revisa `/admin → Comercios` |
| `Firma de webhook inválida` | El secreto no coincide, o se calculó sobre el JSON re-serializado en vez del cuerpo crudo |
| `Webhook vencido` | El reloj del servidor del POS está desfasado; sincroniza con NTP |
| `409` al crear el cobro | Se reutilizó una `reference` con otro monto |
| La cámara no abre en el celular | La billetera debe abrirse por `https://` |
