import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export enum SubmissionStatus {
  PENDING = 'PENDING', // en revisión
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED', // el usuario puede corregir y reenviar
}

export enum DocumentType {
  DNI = 'DNI',
  PASSPORT = 'PASSPORT',
  CEDULA = 'CEDULA',
}

export type FileKind = 'documentFront' | 'documentBack' | 'selfie';

export interface StoredFile {
  path: string; // relativo a KYC_STORAGE_DIR, contenido cifrado
  mime: string;
  size: number;
}

export interface CheckResult {
  key: string;
  label: string;
  result: 'PASS' | 'WARN' | 'FAIL';
  detail: string;
}

export interface Address {
  line1: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

/**
 * Una solicitud de verificación de identidad (KYC = "Know Your Customer").
 * Los datos sensibles (número de documento y archivos) se guardan cifrados.
 */
@Entity('kyc_submissions')
@Index(['userId', 'createdAt'])
export class KycSubmission {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'user_email' })
  userEmail!: string;

  @Index()
  @Column({ type: 'enum', enum: SubmissionStatus, default: SubmissionStatus.PENDING })
  status!: SubmissionStatus;

  @Column({ name: 'first_name' })
  firstName!: string;

  @Column({ name: 'last_name' })
  lastName!: string;

  @Column({ name: 'birth_date', type: 'date' })
  birthDate!: string;

  @Column({ length: 2 })
  nationality!: string;

  @Column({ name: 'document_type', type: 'enum', enum: DocumentType })
  documentType!: DocumentType;

  @Column({ name: 'document_number_enc' })
  documentNumberEnc!: string;

  /** HMAC del documento para detectar el mismo documento en otra cuenta sin descifrar. */
  @Index()
  @Column({ name: 'document_hash' })
  documentHash!: string;

  @Column({ name: 'document_last4', length: 4 })
  documentLast4!: string;

  @Column({ name: 'document_expires_at', type: 'date' })
  documentExpiresAt!: string;

  @Column({ type: 'jsonb' })
  address!: Address;

  @Column()
  phone!: string;

  @Column()
  occupation!: string;

  @Column({ type: 'jsonb' })
  files!: Partial<Record<FileKind, StoredFile>>;

  /** Resultado de las verificaciones automáticas. */
  @Column({ type: 'jsonb', default: [] })
  checks!: CheckResult[];

  @Column({ name: 'rejection_reason', type: 'varchar', nullable: true })
  rejectionReason!: string | null;

  /** null = decisión automática. */
  @Column({ name: 'reviewed_by', type: 'varchar', nullable: true })
  reviewedBy!: string | null;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
