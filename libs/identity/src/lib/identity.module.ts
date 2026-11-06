import { DynamicModule, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import {
  AuthService,
  IDENTITY_OPTIONS,
  type IdentityOptions,
} from './auth.service.js';
import { PasswordHasher } from './passwords.js';

@Module({})
export class IdentityModule {
  static forRoot(options: IdentityOptions): DynamicModule {
    if (options.jwtSecret.length < 32) {
      throw new Error('JWT_SECRET doit compter au moins 32 caractères');
    }
    return {
      module: IdentityModule,
      imports: [
        JwtModule.register({
          secret: options.jwtSecret,
          signOptions: { algorithm: 'HS256' },
        }),
      ],
      providers: [
        { provide: IDENTITY_OPTIONS, useValue: options },
        { provide: PasswordHasher, useFactory: () => new PasswordHasher() },
        AuthService,
      ],
      exports: [AuthService],
    };
  }
}
