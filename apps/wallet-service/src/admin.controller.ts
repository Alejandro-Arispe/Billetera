import { Controller, Get, ParseEnumPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { Currency, fromMinor, JwtAuthGuard, Roles, UserRole } from '@app/common';
import { LedgerEntry, TransactionType, WalletTransaction } from './entities';
import { LedgerService } from './ledger.service';

/** Vista de administración del dinero (solo ADMIN). */
@ApiTags('administración')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Roles(UserRole.ADMIN)
@Controller('wallet/admin')
export class WalletAdminController {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @InjectRepository(WalletTransaction) private readonly txs: Repository<WalletTransaction>,
    @InjectRepository(LedgerEntry) private readonly entries: Repository<LedgerEntry>,
    private readonly ledger: LedgerService,
  ) {}

  @Get('stats')
  @ApiOperation({ summary: 'Saldos totales de usuarios, operaciones y volumen de las últimas 24 h' })
  async stats() {
    const balances: { currency: Currency; total: string; accounts: number }[] = await this.db.query(
      `SELECT currency, SUM(balance_minor)::text AS total, COUNT(*) FILTER (WHERE balance_minor > 0)::int AS accounts
         FROM accounts WHERE user_id IS NOT NULL GROUP BY currency ORDER BY currency`,
    );
    const byType: { type: string; total: number; last24h: number }[] = await this.db.query(
      `SELECT type, COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last24h
         FROM transactions GROUP BY type ORDER BY type`,
    );
    // Volumen = dinero que salió de cuentas de usuario, por tipo y moneda, en 24 h.
    const volume: { type: string; currency: Currency; total: string }[] = await this.db.query(
      `SELECT t.type, e.currency, (-SUM(e.amount_minor))::text AS total
         FROM ledger_entries e JOIN transactions t ON t.id = e.transaction_id
        WHERE e.user_id IS NOT NULL AND e.amount_minor < 0 AND e.created_at > now() - interval '24 hours'
        GROUP BY t.type, e.currency ORDER BY t.type, e.currency`,
    );
    return {
      userBalances: balances.map((b) => ({ currency: b.currency, total: fromMinor(Number(b.total), b.currency), accountsWithFunds: b.accounts })),
      transactions: byType,
      volume24h: volume.map((v) => ({ type: v.type, currency: v.currency, total: fromMinor(Number(v.total), v.currency) })),
      ledger: await this.ledger.audit(),
    };
  }

  @Get('transactions')
  @ApiQuery({ name: 'type', required: false, enum: TransactionType })
  @ApiOperation({ summary: 'Últimas transacciones con sus asientos contables' })
  async transactions(@Query('type', new ParseEnumPipe(TransactionType, { optional: true })) type?: TransactionType) {
    const txs = await this.txs.find({ where: type ? { type } : {}, order: { createdAt: 'DESC' }, take: 60 });
    const entries = txs.length ? await this.entries.find({ where: { transactionId: In(txs.map((t) => t.id)) } }) : [];
    const systemCodes: { id: string; system_code: string }[] = await this.db.query(
      `SELECT id, system_code FROM accounts WHERE system_code IS NOT NULL`,
    );
    const sys = new Map(systemCodes.map((s) => [s.id, s.system_code]));
    return txs.map((t) => ({
      id: t.id,
      type: t.type,
      description: t.description,
      createdAt: t.createdAt,
      metadata: t.metadata,
      entries: entries
        .filter((e) => e.transactionId === t.id)
        .map((e) => ({
          account: e.userId ? { userId: e.userId } : { system: sys.get(e.accountId) ?? 'SISTEMA' },
          amount: fromMinor(e.amountMinor, e.currency),
          currency: e.currency,
        })),
    }));
  }
}
