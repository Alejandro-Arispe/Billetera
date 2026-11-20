import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { StoredFile } from './entities';

/** Tipos de archivo aceptados, reconocidos por su contenido real (no por la extensión). */
const SIGNATURES: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  { mime: 'application/pdf', ext: 'pdf', test: (b) => b.toString('ascii', 0, 5) === '%PDF-' },
];

/**
 * Bóveda de datos sensibles: cifra con AES-256-GCM el número de documento y
 * las imágenes (documento y selfie) antes de guardarlos.
 */
@Injectable()
export class VaultService {
  private readonly key: Buffer;
  private readonly dir: string;

  constructor(config: ConfigService) {
    this.key = Buffer.from(config.getOrThrow<string>('KYC_ENCRYPTION_KEY'), 'hex');
    if (this.key.length !== 32) throw new Error('KYC_ENCRYPTION_KEY debe tener 64 caracteres hex');
    this.dir = resolve(config.get('KYC_STORAGE_DIR', join(process.cwd(), 'storage', 'kyc')));
  }

  encryptText(text: string): string {
    return this.encrypt(Buffer.from(text, 'utf8')).toString('base64');
  }

  decryptText(payload: string): string {
    return this.decrypt(Buffer.from(payload, 'base64')).toString('utf8');
  }

  hash(value: string): string {
    return createHmac('sha256', this.key).update(value).digest('hex');
  }

  /** Detecta el tipo real del archivo. Rechaza todo lo que no sea JPG, PNG, WEBP o PDF. */
  detectType(buf: Buffer, allowPdf: boolean) {
    const sig = SIGNATURES.find((s) => s.test(buf));
    if (!sig || (sig.mime === 'application/pdf' && !allowPdf)) {
      throw new BadRequestException(
        allowPdf ? 'Formato no admitido: usa JPG, PNG, WEBP o PDF' : 'La selfie debe ser una foto JPG, PNG o WEBP',
      );
    }
    return sig;
  }

  async saveFile(folder: string, name: string, buf: Buffer, allowPdf: boolean): Promise<StoredFile> {
    const { mime } = this.detectType(buf, allowPdf);
    const rel = join(folder, `${name}-${randomUUID()}.bin`);
    const abs = join(this.dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, this.encrypt(buf));
    return { path: rel, mime, size: buf.length };
  }

  async readFile(file: StoredFile): Promise<Buffer> {
    const abs = resolve(this.dir, file.path);
    if (!abs.startsWith(this.dir)) throw new BadRequestException('Ruta inválida');
    return this.decrypt(await readFile(abs));
  }

  private encrypt(data: Buffer): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]);
  }

  private decrypt(data: Buffer): Buffer {
    const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
  }
}
