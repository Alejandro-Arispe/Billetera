import { UserRole } from '../constants';

/** Contenido del access token emitido por auth-service y validado por todos los servicios. */
export interface JwtPayload {
  sub: string; // id de usuario
  email: string;
  role: UserRole;
  kycStatus: string;
}
