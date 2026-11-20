import { FormEvent, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Session, api, setSession } from '../api';
import { useMe } from '../App';
import { Alert, useAction } from '../ui';

type Step = 'login' | 'login-code' | 'register' | 'register-code';

/** Ingreso en dos pasos (contraseña + código por correo) y registro con verificación de correo. */
export default function Login() {
  const { me } = useMe();
  const loc = useLocation();
  const [step, setStep] = useState<Step>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [info, setInfo] = useState('');

  const action = useAction(async (fn: () => Promise<void>) => fn());
  if (me) return <Navigate to={(loc.state as { from?: string })?.from ?? '/'} replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      if (step === 'login') {
        const r = await api<{ challengeId: string; message: string }>('POST', '/auth/login', { email, password });
        setChallengeId(r.challengeId);
        setInfo(r.message);
        setCode('');
        setStep('login-code');
      } else if (step === 'login-code') {
        setSession(await api<Session>('POST', '/auth/login/verify', { challengeId, code }));
      } else if (step === 'register') {
        const r = await api<{ message: string }>('POST', '/auth/register', { email, password, fullName });
        setInfo(r.message);
        setCode('');
        setStep('register-code');
      } else {
        setSession(await api<Session>('POST', '/auth/verify-email', { email, code }));
      }
    });
  };

  const resend = () =>
    void action.run(async () => {
      if (step === 'register-code') {
        const r = await api<{ message: string }>('POST', '/auth/resend-verification', { email });
        setInfo(r.message);
      } else {
        const r = await api<{ challengeId: string; message: string }>('POST', '/auth/login', { email, password });
        setChallengeId(r.challengeId);
        setInfo(r.message);
      }
    });

  const isCode = step.endsWith('code');
  return (
    <div className="auth">
      <div className="auth-brand">
        <img src="/icons/icon-192.png" alt="" width={56} height={56} />
        <h1>Billetera</h1>
        <p className="muted">Tu dinero en dólares, euros y pesos. Paga con QR o con tu tarjeta virtual.</p>
      </div>

      <form className="card" onSubmit={submit}>
        <h2>
          {step === 'login' && 'Ingresar'}
          {step === 'register' && 'Crear cuenta'}
          {isCode && 'Revisa tu correo'}
        </h2>
        <Alert>{action.error}</Alert>
        {isCode && <Alert kind="info">{info}</Alert>}

        {step === 'register' && (
          <label>
            Nombre completo
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" required minLength={3} />
          </label>
        )}
        {!isCode && (
          <>
            <label>
              Correo
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
            </label>
            <label>
              Contraseña
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={step === 'register' ? 'new-password' : 'current-password'}
                required
                minLength={step === 'register' ? 8 : 1}
              />
              {step === 'register' && <small className="muted">Mínimo 8 caracteres, con mayúscula, minúscula y número.</small>}
            </label>
          </>
        )}
        {isCode && (
          <label>
            Código de 6 dígitos
            <input
              className="pin"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              autoFocus
            />
          </label>
        )}

        <button className="btn primary" disabled={action.busy || (isCode && code.length !== 6)}>
          {action.busy ? 'Un momento…' : isCode ? 'Verificar' : step === 'login' ? 'Continuar' : 'Crear cuenta'}
        </button>

        {isCode ? (
          <div className="row-between">
            <button type="button" className="link" onClick={resend} disabled={action.busy}>
              Reenviar código
            </button>
            <button type="button" className="link" onClick={() => setStep(step === 'login-code' ? 'login' : 'register')}>
              Cambiar datos
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="link center"
            onClick={() => {
              action.setError('');
              setStep(step === 'login' ? 'register' : 'login');
            }}
          >
            {step === 'login' ? '¿No tienes cuenta? Crear una' : '¿Ya tienes cuenta? Ingresar'}
          </button>
        )}
      </form>
    </div>
  );
}
