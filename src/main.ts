import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { setupSwagger } from './common/swagger';
import { assertExactJsonSupported } from './common/exact-json';
import { trustProxySetting } from './rate-limit/trust-proxy';

async function bootstrap(): Promise<void> {
  // Money is parsed from exact JSON text; an older runtime must not start.
  assertExactJsonSupported();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // REQUIRED. The Quidax webhook signature is computed over the RAW bytes;
    // Nest's body parser re-serialises JSON and re-stringifying will not
    // reproduce them, so HMAC comparison fails silently for every event.
    rawBody: true,
  });

  const config = app.get(ConfigService);
  const log = new Logger('Bootstrap');

  // The client IP every rate limit keys on (spec §2.5). X-Forwarded-For is
  // believed only from the named proxy (or, failing that, for a fixed number
  // of hops); anything else is the client's own claim and is ignored.
  const trustedProxy = trustProxySetting({
    TRUST_PROXY_ADDRESSES: config.get<string[]>('TRUST_PROXY_ADDRESSES'),
    TRUST_PROXY_HOPS: config.get<number>('TRUST_PROXY_HOPS'),
  });
  app.set('trust proxy', trustedProxy);

  // Swagger UI loads inline scripts and styles, which helmet's default CSP
  // blocks outright — the page renders blank with a console full of CSP errors.
  // An admin avatar arrives as a base64 data URL, and base64 costs a third on
  // top. The default 100 KB would reject a perfectly ordinary picture with
  // Express's own "request entity too large" instead of a message that says
  // what the actual limit is.
  app.useBodyParser('json', { limit: '1mb' });

  app.use(helmet({ contentSecurityPolicy: false }));

  /*
   * Who may call this API from inside a browser.
   *
   * A named list when one is configured. Otherwise: everything in development,
   * so a page on any local port just works — and nothing in production, which
   * costs nothing because neither the app nor the dashboard uses cross-origin
   * browser calls. `origin: true` in production would let any site a signed-in
   * user visits make authenticated calls on their behalf.
   */
  const allowedOrigins = config.get<string[]>('CORS_ORIGINS') ?? [];
  const isProduction = config.get<string>('NODE_ENV') === 'production';
  app.enableCors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : !isProduction,
    credentials: true,
  });
  app.setGlobalPrefix(config.get<string>('API_PREFIX') ?? 'v1', {
    exclude: ['health', 'webhooks/quidax', 'webhooks/flutterwave'],
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableShutdownHooks();

  // Must come after setGlobalPrefix, or every documented path loses its /v1.
  const docsPath = setupSwagger(app, config);

  const port = config.get<number>('PORT') ?? 3000;
  await app.listen(port);

  log.log(`Davochain API listening on :${port}`);
  if (docsPath) log.log(`API explorer:  http://localhost:${port}${docsPath}`);
  log.log(`Quidax mode: ${config.get<boolean>('QUIDAX_USE_MOCK') ? 'MOCK' : 'LIVE'}`);
  log.log(
    Array.isArray(trustedProxy)
      ? `Trusted proxy addresses: ${trustedProxy.join(', ')}`
      : `Trusted proxy hops: ${trustedProxy}`,
  );
  if (!config.get<boolean>('QUIDAX_USE_MOCK')) {
    log.warn('LIVE Quidax key in use — every call moves real money. There is no sandbox.');
  }

  /*
   * Things that are legal to run without, and that you want to be told about.
   *
   * A refusal to boot belongs in env.validation.ts and is reserved for
   * configuration that would be unsafe — running production against the mock,
   * for instance. These are the softer ones: the process works, but something
   * is quietly switched off or wide open, and finding that out from a warning
   * beats finding it out from a user.
   */
  if (!config.get<string>('CREDENTIALS_KEY')) {
    log.warn(
      'CREDENTIALS_KEY is not set — gift card voucher codes cannot be accepted, ' +
        'and stored provider credentials are unencrypted. Set it before going live.',
    );
  }
  if (isProduction && allowedOrigins.length === 0) {
    log.warn(
      'CORS_ORIGINS is empty — no website may call this API from a browser. ' +
        'The app and the admin dashboard are unaffected. Set it if a web front end needs it.',
    );
  } else if (allowedOrigins.length > 0) {
    log.log(`CORS allows: ${allowedOrigins.join(', ')}`);
  } else {
    log.warn('CORS is open to every origin — development default.');
  }
}

void bootstrap();
