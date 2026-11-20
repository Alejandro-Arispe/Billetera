import { FormEvent, useState } from 'react';
import { ApiError, api } from '../api';
import { Alert, Copy, Page, Spinner, useAction, useLoad } from '../ui';

interface MerchantInfo {
  id: string;
  name: string;
  apiKeyPrefix: string;
  webhookUrl: string | null;
  webhookSecret: string;
  createdAt: string;
  apiKey?: string;
}

/** "Mi comercio": registrarse para cobrar con QR desde otro sistema (POS, tienda online). */
export default function Merchant() {
  // null = cargando, false = todavía no tiene comercio
  const m = useLoad<MerchantInfo | false>(async () => {
    try {
      return await api<MerchantInfo>('GET', '/payments/merchants/me');
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return false;
      throw e;
    }
  });
  const [newKey, setNewKey] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [webhook, setWebhook] = useState('');

  const create = useAction(async () => {
    const r = await api<MerchantInfo>('POST', '/payments/merchants', { name, webhookUrl: webhook || undefined });
    setNewKey(r.apiKey ?? null);
    m.setData(r);
  });
  const rotate = useAction(async () => {
    if (!confirm('La API key actual dejará de funcionar. ¿Generar una nueva?')) return;
    const r = await api<MerchantInfo>('POST', '/payments/merchants/me/rotate-key');
    setNewKey(r.apiKey ?? null);
    m.setData(r);
  });
  const update = useAction(async (url: string) => {
    m.setData(await api<MerchantInfo>('PATCH', '/payments/merchants/me', { webhookUrl: url }));
  });

  if (m.data === false) {
    // Aún sin comercio: formulario de alta.
    return (
      <Page title="Mi comercio" back>
        <form
          className="card"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void create.run();
          }}
        >
          <p className="muted">
            Registra tu comercio para cobrar con QR desde tu POS o tienda online. Lo que cobres llega a esta billetera.
          </p>
          <Alert>{create.error}</Alert>
          <label>
            Nombre del comercio
            <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} placeholder="Cafetería Central" />
          </label>
          <label>
            URL de webhook (opcional)
            <input value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://mi-pos.com/webhooks/billetera" />
            <small className="muted">Te avisamos ahí cuando un cobro se paga, vence o se cancela.</small>
          </label>
          <button className="btn primary" disabled={create.busy}>
            Registrar comercio
          </button>
        </form>
      </Page>
    );
  }
  if (!m.data) return <Page title="Mi comercio" back>{m.error ? <Alert>{m.error}</Alert> : <Spinner />}</Page>;

  return (
    <Page title="Mi comercio" back>
      {newKey && (
        <div className="card highlight">
          <h2>Tu API key</h2>
          <p className="muted small">Cópiala ahora: por seguridad no se vuelve a mostrar.</p>
          <p className="mono break">{newKey}</p>
          <Copy text={newKey} label="API key" />
        </div>
      )}
      <div className="card">
        <h2>{m.data.name}</h2>
        <dl className="kv">
          <dt>ID</dt>
          <dd className="mono small">{m.data.id}</dd>
          <dt>API key</dt>
          <dd className="mono">{m.data.apiKeyPrefix}</dd>
          <dt>Secreto de webhooks</dt>
          <dd>
            <span className="mono small break">{m.data.webhookSecret}</span> <Copy text={m.data.webhookSecret} label="Secreto" />
          </dd>
        </dl>
        <Alert>{rotate.error}</Alert>
        <button className="btn ghost" onClick={() => void rotate.run()} disabled={rotate.busy}>
          Generar nueva API key
        </button>
      </div>
      <WebhookForm current={m.data.webhookUrl} onSave={(u) => void update.run(u)} busy={update.busy} error={update.error} />
      <div className="card">
        <h2>Cómo cobrar</h2>
        <ol className="steps small">
          <li>
            Crea un cobro con el SDK (<code>@billetera/sdk</code>) o con <code>POST /api/payments/intents</code> y la cabecera{' '}
            <code>x-api-key</code>.
          </li>
          <li>Muestra la imagen del QR que te devuelve.</li>
          <li>Cuando el cliente paga, recibes el webhook <code>payment_intent.succeeded</code> firmado con tu secreto.</li>
        </ol>
      </div>
    </Page>
  );
}

function WebhookForm({ current, onSave, busy, error }: { current: string | null; onSave: (u: string) => void; busy: boolean; error: string }) {
  const [url, setUrl] = useState(current ?? '');
  return (
    <form
      className="card"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSave(url);
      }}
    >
      <Alert>{error}</Alert>
      <label>
        URL de webhook
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mi-pos.com/webhooks/billetera" />
      </label>
      <button className="btn ghost" disabled={busy || url === (current ?? '')}>
        Guardar URL
      </button>
    </form>
  );
}
