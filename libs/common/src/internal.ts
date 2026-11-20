import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

/**
 * Comunicación síncrona entre servicios (HTTP interno).
 * Las rutas /internal/* NO están expuestas por el API gateway y además exigen
 * la cabecera x-internal-key = INTERNAL_API_KEY.
 */
export const INTERNAL_KEY_HEADER = 'x-internal-key';

@Injectable()
export class InternalKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const expected = process.env.INTERNAL_API_KEY ?? '';
    const given: string = req.headers[INTERNAL_KEY_HEADER] ?? '';
    const ok =
      expected.length > 0 &&
      given.length === expected.length &&
      timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!ok) throw new UnauthorizedException('Llamada interna no autorizada');
    return true;
  }
}

/**
 * Llama a otro microservicio. Si responde con error, se relanza la misma
 * excepción HTTP (mismo status y mensaje) para que llegue tal cual al cliente.
 */
export async function callInternal<T>(
  baseUrl: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_KEY_HEADER]: process.env.INTERNAL_API_KEY ?? '',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ServiceUnavailableException(`Servicio interno no disponible (${baseUrl})`);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new HttpException(data ?? { message: 'Error interno' }, res.status);
  }
  return data as T;
}
