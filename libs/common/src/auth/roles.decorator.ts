import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../constants';

export const ROLES_KEY = 'roles';
/** Restringe un endpoint a ciertos roles. Se usa junto con JwtAuthGuard. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
