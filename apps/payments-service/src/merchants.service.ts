import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { InternalUser, callInternal } from '@app/common';
import { Merchant } from './entities';
import { AdminCreateMerchantDto, UpdateMerchantDto } from './dto';

export const hashApiKey = (key: string) => createHash('sha256').update(key).digest('hex');

/**
 * Comercios = sistemas externos (un POS, un software de facturación) que cobran con QR.
 * Solo el administrador los da de alta: entrega la API key y el secreto de webhooks, y elige
 * la cuenta de la billetera donde se acredita el dinero cobrado.
 */
@Injectable()
export class MerchantsService {
  private readonly authUrl: string;

  constructor(
    @InjectRepository(Merchant) private readonly merchants: Repository<Merchant>,
    config: ConfigService,
  ) {
    this.authUrl = config.get('AUTH_SERVICE_URL', 'http://localhost:3001');
  }

  async create(dto: AdminCreateMerchantDto) {
    const owner = await callInternal<InternalUser>(
      this.authUrl,
      `/internal/users/by-email?email=${encodeURIComponent(dto.ownerEmail)}`,
    );
    if (await this.merchants.findOne({ where: { ownerUserId: owner.id } })) {
      throw new ConflictException(`La cuenta ${owner.email} ya recibe los cobros de otro comercio`);
    }
    const apiKey = newApiKey();
    const merchant = await this.merchants.save(
      this.merchants.create({
        ownerUserId: owner.id,
        name: dto.name.trim(),
        webhookUrl: dto.webhookUrl ?? null,
        webhookSecret: `whsec_${randomBytes(24).toString('base64url')}`,
        apiKeyHash: hashApiKey(apiKey),
        apiKeyPrefix: apiKey.slice(0, 14),
      }),
    );
    return { ...this.view(merchant), ownerEmail: owner.email, apiKey, warning: 'Guarda la API key: no se vuelve a mostrar' };
  }

  /** El dueño de la cuenta receptora puede ver (no editar) el comercio asociado. */
  async mine(ownerUserId: string) {
    const m = await this.merchants.findOne({ where: { ownerUserId } });
    if (!m) throw new NotFoundException('Tu cuenta no recibe cobros de ningún comercio');
    return this.view(m);
  }

  async update(id: string, dto: UpdateMerchantDto) {
    const m = await this.findById(id);
    if (dto.name) m.name = dto.name.trim();
    if (dto.webhookUrl !== undefined) m.webhookUrl = dto.webhookUrl || null;
    return this.view(await this.merchants.save(m));
  }

  /** Genera una API key nueva; la anterior deja de funcionar al instante. */
  async rotateKey(id: string) {
    const m = await this.findById(id);
    const apiKey = newApiKey();
    m.apiKeyHash = hashApiKey(apiKey);
    m.apiKeyPrefix = apiKey.slice(0, 14);
    await this.merchants.save(m);
    return { ...this.view(m), apiKey, warning: 'Guarda la API key: no se vuelve a mostrar' };
  }

  findByApiKey(apiKey: string) {
    return this.merchants.findOne({ where: { apiKeyHash: hashApiKey(apiKey) } });
  }

  private async findById(id: string) {
    const m = await this.merchants.findOne({ where: { id } });
    if (!m) throw new NotFoundException('Comercio no encontrado');
    return m;
  }

  private view(m: Merchant) {
    return {
      id: m.id,
      name: m.name,
      apiKeyPrefix: `${m.apiKeyPrefix}…`,
      webhookUrl: m.webhookUrl,
      webhookSecret: m.webhookSecret,
      createdAt: m.createdAt,
    };
  }
}

const newApiKey = () => `sk_test_${randomBytes(24).toString('base64url')}`;
