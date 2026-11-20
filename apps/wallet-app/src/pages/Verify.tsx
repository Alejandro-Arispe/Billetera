import { FormEvent, useState } from 'react';
import { api } from '../api';
import { useMe } from '../App';
import { Alert, Page, Spinner, useAction, useLoad } from '../ui';

interface KycStatus {
  status: 'NOT_STARTED' | 'PENDING' | 'APPROVED' | 'REJECTED';
  canSubmit: boolean;
  rejectionReason: string | null;
  submission: { firstName: string; lastName: string; documentType: string; documentNumberMasked: string; createdAt: string } | null;
}

const COUNTRIES = [
  ['AR', 'Argentina'], ['BO', 'Bolivia'], ['BR', 'Brasil'], ['CL', 'Chile'], ['CO', 'Colombia'], ['CR', 'Costa Rica'],
  ['EC', 'Ecuador'], ['ES', 'España'], ['US', 'Estados Unidos'], ['GT', 'Guatemala'], ['HN', 'Honduras'], ['MX', 'México'],
  ['NI', 'Nicaragua'], ['PA', 'Panamá'], ['PY', 'Paraguay'], ['PE', 'Perú'], ['DO', 'República Dominicana'],
  ['SV', 'El Salvador'], ['UY', 'Uruguay'], ['VE', 'Venezuela'],
];
const STATUS = {
  NOT_STARTED: { icon: '🪪', title: 'Verifica tu identidad', text: 'Es necesario para habilitar tu tarjeta virtual.' },
  PENDING: { icon: '⏳', title: 'En revisión', text: 'Recibimos tus datos. Te avisaremos por correo cuando esté lista.' },
  APPROVED: { icon: '✅', title: 'Identidad verificada', text: 'Ya puedes habilitar tu tarjeta virtual.' },
  REJECTED: { icon: '⚠️', title: 'No pudimos verificarte', text: 'Corrige los datos y vuelve a enviarlos.' },
};
const MAX = 5 * 1024 * 1024;

/** Verificación de identidad (KYC): datos personales, documento y selfie. */
export default function Verify() {
  const { refreshMe } = useMe();
  const st = useLoad(() => api<KycStatus>('GET', '/kyc/status'));
  const [docType, setDocType] = useState('DNI');
  const [previews, setPreviews] = useState<Record<string, string>>({});

  const submit = useAction(async (form: HTMLFormElement) => {
    const data = new FormData(form);
    data.delete('consent');
    if (docType === 'PASSPORT') data.delete('documentBack');
    for (const k of ['documentFront', 'documentBack', 'selfie']) {
      const f = data.get(k);
      if (f instanceof File && f.size > MAX) throw new Error('Cada foto debe pesar como máximo 5 MB');
      if (f instanceof File && f.size === 0) data.delete(k);
    }
    st.setData(await api<KycStatus>('POST', '/kyc/submissions', data));
    await refreshMe();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  if (!st.data) return <Page title="Verificar identidad" back>{st.error ? <Alert>{st.error}</Alert> : <Spinner />}</Page>;
  const s = STATUS[st.data.status];

  const onFile = (name: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    setPreviews((p) => ({ ...p, [name]: f && f.type.startsWith('image/') ? URL.createObjectURL(f) : f ? 'pdf' : '' }));
  };
  const upload = (name: string, title: string, hint: string, accept: string, capture: 'user' | 'environment', required: boolean) => (
    <label className={`upload ${previews[name] ? 'done' : ''}`}>
      <span className="up-title">{title}</span>
      {previews[name] && previews[name] !== 'pdf' ? <img src={previews[name]} alt="" /> : <span className="up-hint">{previews[name] === 'pdf' ? 'PDF listo' : hint}</span>}
      <input type="file" name={name} accept={accept} capture={capture} required={required} onChange={onFile(name)} />
    </label>
  );

  return (
    <Page title="Verificar identidad" back>
      <div className="card center">
        <div className="big-icon">{s.icon}</div>
        <h2>{s.title}</h2>
        <p className="muted">{s.text}</p>
        {st.data.rejectionReason && <Alert>Motivo: {st.data.rejectionReason}</Alert>}
        {st.data.submission && st.data.status !== 'REJECTED' && (
          <p className="small muted">
            {st.data.submission.firstName} {st.data.submission.lastName} · {st.data.submission.documentType} {st.data.submission.documentNumberMasked}
          </p>
        )}
      </div>

      {st.data.canSubmit && (
        <form
          className="card"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            void submit.run(e.currentTarget);
          }}
        >
          <p className="muted">
            Completa los datos <strong>tal como aparecen en tu documento</strong>.
          </p>
          <fieldset>
            <legend>Datos personales</legend>
            <div className="two">
              <label>Nombres<input name="firstName" autoComplete="given-name" required /></label>
              <label>Apellidos<input name="lastName" autoComplete="family-name" required /></label>
            </div>
            <div className="two">
              <label>Nacimiento<input name="birthDate" type="date" required /></label>
              <label>
                Nacionalidad
                <select name="nationality" required defaultValue="">
                  <option value="" disabled>Elegir…</option>
                  {COUNTRIES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                </select>
              </label>
            </div>
            <div className="two">
              <label>Teléfono<input name="phone" type="tel" placeholder="+5491155550000" required /></label>
              <label>Ocupación<input name="occupation" required /></label>
            </div>
          </fieldset>
          <fieldset>
            <legend>Documento</legend>
            <div className="two">
              <label>
                Tipo
                <select name="documentType" value={docType} onChange={(e) => setDocType(e.target.value)}>
                  <option value="DNI">DNI</option>
                  <option value="CEDULA">Cédula</option>
                  <option value="PASSPORT">Pasaporte</option>
                </select>
              </label>
              <label>Número<input name="documentNumber" required autoComplete="off" /></label>
            </div>
            <label>Vencimiento<input name="documentExpiresAt" type="date" required /></label>
          </fieldset>
          <fieldset>
            <legend>Domicilio</legend>
            <label>Calle y número<input name="addressLine1" autoComplete="address-line1" required /></label>
            <div className="two">
              <label>Ciudad<input name="city" autoComplete="address-level2" required /></label>
              <label>Provincia / estado<input name="state" autoComplete="address-level1" required /></label>
            </div>
            <div className="two">
              <label>Código postal<input name="postalCode" autoComplete="postal-code" required /></label>
              <label>
                País
                <select name="country" required defaultValue="">
                  <option value="" disabled>Elegir…</option>
                  {COUNTRIES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                </select>
              </label>
            </div>
          </fieldset>
          <fieldset>
            <legend>Fotos</legend>
            <p className="muted small">JPG, PNG o WEBP (el documento también en PDF), hasta 5 MB. En el celular se abre la cámara.</p>
            <div className="uploads">
              {upload('documentFront', 'Frente del documento', 'Tocar para sacar foto', 'image/*,application/pdf', 'environment', true)}
              {docType !== 'PASSPORT' && upload('documentBack', 'Dorso del documento', 'Tocar para sacar foto', 'image/*,application/pdf', 'environment', true)}
              {upload('selfie', 'Selfie', 'Mirando a la cámara, con buena luz', 'image/*', 'user', true)}
            </div>
          </fieldset>
          <label className="check-row">
            <input type="checkbox" name="consent" required /> Declaro que los datos son verdaderos y acepto que se usen para verificar mi identidad.
          </label>
          <Alert>{submit.error}</Alert>
          <button className="btn primary" disabled={submit.busy}>
            {submit.busy ? 'Enviando…' : 'Enviar verificación'}
          </button>
        </form>
      )}
    </Page>
  );
}
