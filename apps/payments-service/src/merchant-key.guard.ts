import { CanActivate, createParamDecorator, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Merchant } from './entities';
import { MerchantsService } from './merchants.service';

/** Autentica al comercio por su API key secreta (cabecera x-api-key o Authorization: Bearer sk_...). */
@Injectable()
export class MerchantKeyGuard implements CanActivate {
  constructor(private readonly merchants: MerchantsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const auth: string | undefined = req.headers['authorization'];
    const key: string | undefined =
      req.headers['x-api-key'] ?? (auth?.startsWith('Bearer sk_') ? auth.slice(7) : undefined);
    if (!key) throw new UnauthorizedException('Falta la API key del comercio (cabecera x-api-key)');
    const merchant = await this.merchants.findByApiKey(key);
    if (!merchant) throw new UnauthorizedException('API key inválida');
    req.merchant = merchant;
    return true;
  }
}

export const CurrentMerchant = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Merchant => ctx.switchToHttp().getRequest().merchant,
);
