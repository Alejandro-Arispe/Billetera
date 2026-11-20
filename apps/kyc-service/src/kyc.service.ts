import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { callInternal, EVENTS, InternalUser, NOTIFICATION_CLIENT, SendKycResultEmailEvent } from '@app/common';
import { SubmitKycDto } from './dto';
import { CheckResult, DocumentType, FileKind, KycSubmission, SubmissionStatus } from './entities';
import { VaultService } from './vault.service';

export type UploadedFiles = Partial<Record<FileKind, { buffer: Buffer; size: number }[]>>;

const MIN_AGE = 18;
const DOC_PATTERNS: Record<DocumentType, { re: RegExp; hint: string }> = {
  DNI: { re: /^\d{7,9}$/, hint: '7 a 9 dígitos' },
  CEDULA: { re: /^\d{6,12}$/, hint: '6 a 12 dígitos' },
  PASSPORT: { re: /^[A-Z0-9]{6,10}$/, hint: '6 a 10 letras o números' },
};

/**
 * Verificación de identidad simulada, al estilo de las fintech:
 *  1. El usuario envía datos personales reales + foto del documento (frente/dorso) + selfie.
 *  2. Se ejecutan verificaciones automáticas (edad, formato y vigencia del documento,
 *     coincidencia de nombre, documento duplicado en otra cuenta, archivos válidos).
 *  3. Si algo falla de forma clara se rechaza al instante; si no, queda PENDIENTE para que
 *     un administrador compare las fotos y apruebe o rechace (o se aprueba sola si
 *     KYC_AUTO_APPROVE=true).
 *  4. El resultado se informa a auth-service (habilita la tarjeta) y al usuario por correo.
 */
@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);
  private readonly authUrl: string;
  private readonly autoApprove: boolean;

  constructor(
    @InjectRepository(KycSubmission) private readonly subs: Repository<KycSubmission>,
    @Inject(NOTIFICATION_CLIENT) private readonly notifications: ClientProxy,
    private readonly vault: VaultService,
    config: ConfigService,
  ) {
    this.authUrl = config.get('AUTH_SERVICE_URL', 'http://localhost:3001');
    this.autoApprove = config.get('KYC_AUTO_APPROVE', 'false') === 'true';
  }

  // ------------------------------------------------------------------ usuario

  async status(userId: string) {
    const latest = await this.latest(userId);
    return {
      status: latest?.status ?? 'NOT_STARTED',
      canSubmit: !latest || latest.status === SubmissionStatus.REJECTED,
      rejectionReason: latest?.status === SubmissionStatus.REJECTED ? latest.rejectionReason : null,
      submittedAt: latest?.createdAt ?? null,
      reviewedAt: latest?.reviewedAt ?? null,
      requirements: [
        'Datos personales tal como figuran en tu documento',
        'Foto del frente del documento',
        'Foto del dorso (no hace falta para pasaporte)',
        'Selfie con buena luz, sin lentes de sol ni gorra',
      ],
      submission: latest ? this.userView(latest) : null,
    };
  }

  async submit(userId: string, dto: SubmitKycDto, files: UploadedFiles) {
    const latest = await this.latest(userId);
    if (latest?.status === SubmissionStatus.PENDING) {
      throw new ConflictException('Ya tienes una verificación en revisión');
    }
    if (latest?.status === SubmissionStatus.APPROVED) {
      throw new ConflictException('Tu identidad ya está verificada');
    }

    const front = files.documentFront?.[0];
    const back = files.documentBack?.[0];
    const selfie = files.selfie?.[0];
    if (!front) throw new BadRequestException('Falta la foto del frente del documento');
    if (!selfie) throw new BadRequestException('Falta la selfie');
    if (dto.documentType !== DocumentType.PASSPORT && !back) {
      throw new BadRequestException('Falta la foto del dorso del documento');
    }
    // Valida los formatos antes de guardar nada.
    this.vault.detectType(front.buffer, true);
    if (back) this.vault.detectType(back.buffer, true);
    this.vault.detectType(selfie.buffer, false);

    const user = await callInternal<InternalUser>(this.authUrl, `/internal/users/${userId}`);
    const documentHash = this.vault.hash(`${dto.documentType}:${dto.nationality}:${dto.documentNumber}`);
    const folder = `${userId}/${Date.now()}`;

    const sub = this.subs.create({
      userId,
      userEmail: user.email,
      firstName: dto.firstName,
      lastName: dto.lastName,
      birthDate: dto.birthDate,
      nationality: dto.nationality,
      documentType: dto.documentType,
      documentNumberEnc: this.vault.encryptText(dto.documentNumber),
      documentHash,
      documentLast4: dto.documentNumber.slice(-4),
      documentExpiresAt: dto.documentExpiresAt,
      address: {
        line1: dto.addressLine1,
        city: dto.city,
        state: dto.state,
        postalCode: dto.postalCode,
        country: dto.country,
      },
      phone: dto.phone,
      occupation: dto.occupation,
      files: {
        documentFront: await this.vault.saveFile(folder, 'front', front.buffer, true),
        ...(back ? { documentBack: await this.vault.saveFile(folder, 'back', back.buffer, true) } : {}),
        selfie: await this.vault.saveFile(folder, 'selfie', selfie.buffer, false),
      },
    });
    sub.checks = await this.runChecks(sub, user, dto.documentNumber);

    const failed = sub.checks.filter((c) => c.result === 'FAIL');
    if (failed.length) {
      sub.status = SubmissionStatus.REJECTED;
      sub.rejectionReason = failed.map((c) => c.detail).join('. ');
      sub.reviewedAt = new Date();
    } else if (this.autoApprove && sub.checks.every((c) => c.result === 'PASS')) {
      sub.status = SubmissionStatus.APPROVED;
      sub.reviewedAt = new Date();
    }
    await this.subs.save(sub);
    await this.publish(sub);
    this.logger.log(`Verificación de ${user.email}: ${sub.status}`);
    return this.status(userId);
  }

  // ------------------------------------------------------------------ administración

  async list(status?: SubmissionStatus) {
    const rows = await this.subs.find({
      where: status ? { status } : {},
      order: { createdAt: status === SubmissionStatus.PENDING ? 'ASC' : 'DESC' },
      take: 100,
    });
    const counts = await this.subs
      .createQueryBuilder('s')
      .select('s.status', 'status')
      .addSelect('COUNT(*)::int', 'count')
      .groupBy('s.status')
      .getRawMany<{ status: string; count: number }>();
    return {
      counts: Object.fromEntries(counts.map((c) => [c.status, c.count])),
      items: rows.map((s) => ({
        id: s.id,
        status: s.status,
        fullName: `${s.firstName} ${s.lastName}`,
        email: s.userEmail,
        documentType: s.documentType,
        nationality: s.nationality,
        warnings: s.checks.filter((c) => c.result !== 'PASS').length,
        createdAt: s.createdAt,
      })),
    };
  }

  async detail(id: string) {
    const s = await this.find(id);
    return {
      ...this.userView(s),
      userId: s.userId,
      email: s.userEmail,
      documentNumber: this.vault.decryptText(s.documentNumberEnc),
      phone: s.phone,
      occupation: s.occupation,
      checks: s.checks,
      reviewedBy: s.reviewedBy,
      files: Object.keys(s.files),
      previousSubmissions: await this.subs.count({ where: { userId: s.userId, id: Not(s.id) } }),
    };
  }

  async file(id: string, kind: FileKind) {
    const s = await this.find(id);
    const f = s.files[kind];
    if (!f) throw new NotFoundException('Archivo no encontrado');
    return { mime: f.mime, data: await this.vault.readFile(f) };
  }

  async approve(id: string, adminEmail: string) {
    const s = await this.findPending(id);
    s.status = SubmissionStatus.APPROVED;
    s.reviewedBy = adminEmail;
    s.reviewedAt = new Date();
    await this.subs.save(s);
    await this.publish(s);
    return this.detail(id);
  }

  async reject(id: string, adminEmail: string, reason: string) {
    const s = await this.findPending(id);
    s.status = SubmissionStatus.REJECTED;
    s.rejectionReason = reason;
    s.reviewedBy = adminEmail;
    s.reviewedAt = new Date();
    await this.subs.save(s);
    await this.publish(s);
    return this.detail(id);
  }

  // ------------------------------------------------------------------ helpers

  private async runChecks(sub: KycSubmission, user: InternalUser, documentNumber: string): Promise<CheckResult[]> {
    const checks: CheckResult[] = [];
    const add = (key: string, label: string, ok: boolean | 'WARN', detail: string) =>
      checks.push({ key, label, result: ok === 'WARN' ? 'WARN' : ok ? 'PASS' : 'FAIL', detail });

    const age = yearsSince(sub.birthDate);
    add('AGE', 'Mayor de edad', age >= MIN_AGE && age < 120,
      age >= MIN_AGE && age < 120 ? `${age} años` : `Debes ser mayor de ${MIN_AGE} años`);

    const pattern = DOC_PATTERNS[sub.documentType];
    const formatOk = pattern.re.test(documentNumber);
    add('DOCUMENT_FORMAT', 'Formato del documento', formatOk,
      formatOk ? `${sub.documentType} válido` : `El ${sub.documentType} debe tener ${pattern.hint}`);

    const expiresIn = daysUntil(sub.documentExpiresAt);
    add('DOCUMENT_EXPIRY', 'Documento vigente', expiresIn > 0 ? (expiresIn < 30 ? 'WARN' : true) : false,
      expiresIn > 0 ? `Vence en ${expiresIn} días` : 'El documento está vencido');

    const legal = tokens(`${sub.firstName} ${sub.lastName}`);
    const account = tokens(user.fullName);
    const matched = account.filter((t) => legal.includes(t)).length;
    add('NAME_MATCH', 'Nombre coincide con la cuenta', matched >= Math.min(2, account.length) ? true : 'WARN',
      matched >= Math.min(2, account.length)
        ? 'El nombre del documento coincide con el de la cuenta'
        : `La cuenta dice "${user.fullName}" y el documento "${sub.firstName} ${sub.lastName}"`);

    const duplicate = await this.subs.findOne({
      where: {
        documentHash: sub.documentHash,
        userId: Not(sub.userId),
        status: In([SubmissionStatus.PENDING, SubmissionStatus.APPROVED]),
      },
    });
    add('DUPLICATE_DOCUMENT', 'Documento no usado en otra cuenta', !duplicate,
      duplicate ? 'Este documento ya está registrado en otra cuenta' : 'Documento único');

    add('FILES', 'Fotos recibidas', true,
      `${Object.keys(sub.files).length} archivo(s) válidos (se revisan visualmente)`);
    return checks;
  }

  /** Avisa a auth-service (estado de la cuenta) y al usuario (correo). */
  private async publish(s: KycSubmission) {
    await callInternal(this.authUrl, `/internal/users/${s.userId}/kyc`, {
      method: 'PATCH',
      body: { status: s.status, legalName: `${s.firstName} ${s.lastName}` },
    });
    const event: SendKycResultEmailEvent = {
      to: s.userEmail,
      fullName: s.firstName,
      status: s.status,
      reason: s.rejectionReason,
    };
    this.notifications.emit(EVENTS.SEND_KYC_RESULT_EMAIL, event);
  }

  private latest(userId: string) {
    return this.subs.findOne({ where: { userId }, order: { createdAt: 'DESC' } });
  }

  private async find(id: string) {
    const s = await this.subs.findOne({ where: { id } });
    if (!s) throw new NotFoundException('Verificación no encontrada');
    return s;
  }

  private async findPending(id: string) {
    const s = await this.find(id);
    if (s.status !== SubmissionStatus.PENDING) {
      throw new ConflictException(`La verificación ya fue resuelta (${s.status})`);
    }
    return s;
  }

  private userView(s: KycSubmission) {
    return {
      id: s.id,
      status: s.status,
      firstName: s.firstName,
      lastName: s.lastName,
      birthDate: s.birthDate,
      nationality: s.nationality,
      documentType: s.documentType,
      documentNumberMasked: `••••${s.documentLast4}`,
      documentExpiresAt: s.documentExpiresAt,
      address: s.address,
      rejectionReason: s.rejectionReason,
      createdAt: s.createdAt,
      reviewedAt: s.reviewedAt,
    };
  }
}

function yearsSince(date: string): number {
  const d = new Date(`${date}T00:00:00`);
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) age--;
  return age;
}

function daysUntil(date: string): number {
  return Math.floor((new Date(`${date}T00:00:00`).getTime() - Date.now()) / 86_400_000);
}

function tokens(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length > 1);
}
