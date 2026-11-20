import { Body, Controller, Get, Headers, HttpCode, Param, Post, RawBodyRequest, Req, Sse } from '@nestjs/common';
import type { Request } from 'express';
import { CATALOG, PosService } from './pos.service';

@Controller()
export class PosController {
  constructor(private readonly pos: PosService) {}

  @Get('api/config')
  config() {
    return { storeName: this.pos.storeName, currency: this.pos.currency, configured: this.pos.configured };
  }

  @Get('api/products')
  products() {
    return CATALOG;
  }

  @Post('api/orders')
  create(@Body() body: { items: { productId: string; quantity: number }[] }) {
    return this.pos.createOrder(body?.items);
  }

  @Get('api/orders/:id')
  get(@Param('id') id: string) {
    return this.pos.get(id);
  }

  @Post('api/orders/:id/qr')
  @HttpCode(200)
  qr(@Param('id') id: string) {
    return this.pos.chargeWithQr(id);
  }

  @Post('api/orders/:id/card')
  @HttpCode(200)
  card(
    @Param('id') id: string,
    @Body() body: { cardNumber: string; expMonth: number; expYear: number; cvv: string },
  ) {
    return this.pos.chargeWithCard(id, body);
  }

  @Post('api/orders/:id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string) {
    return this.pos.cancel(id);
  }

  @Post('api/orders/:id/refresh')
  @HttpCode(200)
  refresh(@Param('id') id: string) {
    return this.pos.refresh(id);
  }

  /** La pantalla del POS escucha aquí los cambios de la orden en tiempo real (Server-Sent Events). */
  @Sse('api/orders/:id/events')
  events(@Param('id') id: string) {
    return this.pos.stream(id);
  }

  /** URL que se configura como webhook del comercio en la billetera. */
  @Post('webhooks/billetera')
  @HttpCode(200)
  webhook(@Req() req: RawBodyRequest<Request>, @Headers('billetera-signature') signature?: string) {
    return this.pos.handleWebhook(req.rawBody, signature);
  }
}
