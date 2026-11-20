import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { Merchant } from './entities';
import { CreateMerchantDto, UpdateMerchantDto } from './dto';

export const hashApiKey = (key: string) => createHash('sha256').update(key).digest('hex');

/** Alta y gestión de comercios. Cualquier usuario verificado puede registrar su comercio. */
@Injectable()
export class MerchantsService {
  constructor(@InjectRepository(Merchant) private readonly merchants: Repository<Merchant>) {}

  async create(ownerUserId: string, dto: CreateMerchantDto) {
    if (await this.merchants.findOne({ where: { ownerUserId } })) {
      throw new ConflictException('Ya tienes un comercio registrado');
    }
    const apiKey = newApiKey();
    const merchant = await this.merchants.save(
      this.merchants.create({
        ownerUserId,
        name: dto.name.trim(),
        webhookUrl: dto.webhookUrl ?? null,
        webhookSecret: `whsec_${randomBytes(24).toString('base64url')}`,
        apiKeyHash: hashApiKey(apiKey),
        apiKeyPrefix: apiKey.slice(0, 14),
      }),
    );
    return { ...this.view(merchant), apiKey, warning: 'Guarda la API key: no se vuelve a mostrar' };
  }

  async mine(ownerUserId: string) {
    return this.view(await this.findByOwner(ownerUserId));
  }

  async update(ownerUserId: string, dto: UpdateMerchantDto) {
    const m = await this.findByOwner(ownerUserId);
    if (dto.name) m.name = dto.name.trim();
    if (dto.webhookUrl !== undefined) m.webhookUrl = dto.webhookUrl || null;
    return this.view(await this.merchants.save(m));
  }

  /** Genera una API key nueva; la anterior deja de funcionar al instante. */
  async rotateKey(ownerUserId: string) {
    const m = await this.findByOwner(ownerUserId);
    const apiKey = newApiKey();
    m.apiKeyHash = hashApiKey(apiKey);
    m.apiKeyPrefix = apiKey.slice(0, 14);
    await this.merchants.save(m);
    return { ...this.view(m), apiKey, warning: 'Guarda la API key: no se vuelve a mostrar' };
  }

  findByApiKey(apiKey: string) {
    return this.merchants.findOne({ where: { apiKeyHash: hashApiKey(apiKey) } });
  }

  private async findByOwner(ownerUserId: string) {
    const m = await this.merchants.findOne({ where: { ownerUserId } });
    if (!m) throw new NotFoundException('Aún no registraste un comercio');
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
