import { ApiError, api } from '../api';
import { Alert, Copy, Page, Spinner, useLoad, when } from '../ui';

interface MerchantInfo {
  id: string;
  name: string;
  apiKeyPrefix: string;
  webhookUrl: string | null;
  webhookSecret: string;
  createdAt: string;
}

/**
 * Comercio cuyos cobros QR se acreditan en esta cuenta. Solo lectura: el alta, la API key y la URL
 * de webhooks las gestiona el administrador desde el panel.
 */
export default function Merchant() {
  // null = cargando, false = la cuenta no recibe cobros de ningún comercio
  const m = useLoad<MerchantInfo | false>(async () => {
    try {
      return await api<MerchantInfo>('GET', '/payments/merchants/me');
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return false;
      throw e;
    }
  });

  if (m.data === false) {
    return (
      <Page title="Comercio" back>
        <p className="card muted">Tu cuenta no recibe cobros de ningún comercio.</p>
      </Page>
    );
  }
  if (!m.data) return <Page title="Comercio" back>{m.error ? <Alert>{m.error}</Alert> : <Spinner />}</Page>;

  return (
    <Page title="Comercio" back>
      <div className="card">
        <h2>{m.data.name}</h2>
        <p className="muted small">Los cobros QR de este comercio se acreditan en tu billetera.</p>
        <dl className="kv">
          <dt>ID</dt>
          <dd className="mono small">{m.data.id}</dd>
          <dt>API key</dt>
          <dd className="mono">{m.data.apiKeyPrefix}</dd>
          <dt>Webhook</dt>
          <dd className="mono small break">{m.data.webhookUrl ?? 'Sin configurar'}</dd>
          <dt>Secreto de webhooks</dt>
          <dd>
            <span className="mono small break">{m.data.webhookSecret}</span> <Copy text={m.data.webhookSecret} label="Secreto" />
          </dd>
          <dt>Alta</dt>
          <dd>{when(m.data.createdAt)}</dd>
        </dl>
        <p className="muted small">Para cambiar la URL de webhooks o generar una API key nueva, contacta al administrador.</p>
      </div>
    </Page>
  );
}
