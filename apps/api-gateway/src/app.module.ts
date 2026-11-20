import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

@Controller()
class GatewayController {
  @Get('health')
  health() {
    return { service: 'api-gateway', status: 'ok' };
  }
}

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] })],
  controllers: [GatewayController],
})
export class AppModule {}
