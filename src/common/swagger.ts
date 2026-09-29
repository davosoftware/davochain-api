import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * Browsable API docs at /docs.
 *
 * This is a developer tool, not the admin panel — a real admin UI is a separate
 * frontend. What it gives you is every endpoint, its shape, and a Try it out
 * button, which is enough to drive the whole system by hand.
 *
 * Disabled in production by default: it enumerates every route and schema,
 * which is a map of the attack surface. Set ENABLE_DOCS=true if you
 * deliberately want it there, behind your own auth.
 */
export function setupSwagger(app: INestApplication, config: ConfigService): string | null {
  const isProduction = config.get<string>('NODE_ENV') === 'production';
  const forced = config.get<string>('ENABLE_DOCS') === 'true';
  if (isProduction && !forced) return null;

  const doc = new DocumentBuilder()
    .setTitle('Davochain API')
    .setDescription(
      [
        'Quidax-backed crypto exchange.',
        '',
        '**Two separate token types.** A user token from `/v1/auth/login` works on',
        'the app endpoints. An admin token from `/v1/admin/auth/login` works on',
        '`/admin/*`. They are signed with different secrets — a user token is',
        'useless against the admin surface even if it leaks.',
        '',
        '**To use Try it out:** call a login endpoint, copy the token out of the',
        'response, click **Authorize** at the top right, and paste it in.',
        '',
        '**Money is always a string.** Never parse an amount as a float —',
        'a double cannot hold 8 decimal places of BTC without drifting.',
      ].join('\n'),
    )
    .setVersion('0.1')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'User access token' },
      'user',
    )
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Admin access token' },
      'admin',
    )
    .addTag('auth', 'Register, log in, refresh. Refresh tokens rotate on every use.')
    .addTag('kyc', 'Tier submission. Trading needs TIER_1.')
    .addTag('assets', 'Listed coins and their chains. Public.')
    .addTag('deposits', 'Addresses are generated asynchronously — poll until usable.')
    .addTag('trading', 'Quotes live 12 seconds. Executing one needs an Idempotency-Key.')
    .addTag('withdrawals', 'Crypto leaves from the user’s own sub-account.')
    .addTag('admin', 'Gates, inventory, fee claims, reconciliation, KYC review.')
    .build();

  const document = SwaggerModule.createDocument(app, doc);

  SwaggerModule.setup('docs', app, document, {
    customSiteTitle: 'Davochain API',
    swaggerOptions: {
      persistAuthorization: true, // survives a reload; you paste the token once
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
      docExpansion: 'none',
    },
  });

  return '/docs';
}
