import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import helmet from 'helmet';
import { existsSync } from 'fs';
import { join } from 'path';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { AppModule } from './app.module';

/**
 * Punto de entrada único para las apps (billetera, POS, admin).
 * Enruta /api/<servicio>/... al microservicio correspondiente.
 * La validación del JWT la hace cada servicio con la librería común.
 */
const ROUTES: Record<string, string> = {
  auth: process.env.AUTH_SERVICE_URL ?? 'http://localhost:3001',
  wallet: process.env.WALLET_SERVICE_URL ?? 'http://localhost:3002',
  cards: process.env.CARD_SERVICE_URL ?? 'http://localhost:3004',
  payments: process.env.PAYMENTS_SERVICE_URL ?? 'http://localhost:3003',
  kyc: process.env.KYC_SERVICE_URL ?? 'http://localhost:3005',
};

/** Carpeta con las páginas web servidas por el gateway. */
const WEB_DIR = process.env.WEB_DIR ?? join(process.cwd(), 'web');
/** /pay = pagar un QR · /kyc = verificar identidad · /admin = panel de administración */
const PAGES = ['pay', 'kyc', 'admin'];
/** App PWA compilada (npm run app:build). */
const APP_DIR = process.env.APP_DIR ?? join(process.cwd(), 'dist', 'wallet-app');
/** Todo GET que no sea API, páginas sueltas, archivos ni /health va a la app. */
const SPA_ROUTES = /^\/(?!api(\/|$)|pay(\/|$)|kyc(\/|$)|admin(\/|$)|common\/|assets\/|icons\/|health$)[^.]*$/;

async function bootstrap() {
  // bodyParser desactivado: el cuerpo se reenvía tal cual al servicio destino.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // unpkg: lector de QR con cámara (html5-qrcode)
          scriptSrc: ["'self'", 'https://unpkg.com'],
          imgSrc: ["'self'", 'data:', 'blob:'],
          mediaSrc: ["'self'", 'blob:'],
        },
      },
    }),
  );
  app.enableCors({ origin: true, credentials: true });

  // Páginas web (el QR del POS apunta a /pay?i=<cobro>&s=<firma>)
  for (const page of PAGES) {
    const sendPage = (_req: Request, res: Response) => res.sendFile(join(WEB_DIR, page, 'index.html'));
    app.getHttpAdapter().get(`/${page}`, sendPage);
    app.useStaticAssets(join(WEB_DIR, page), { prefix: `/${page}/`, index: false });
  }
  app.useStaticAssets(join(WEB_DIR, 'common'), { prefix: '/common/', index: false });

  for (const [name, target] of Object.entries(ROUTES)) {
    app.use(
      `/api/${name}`,
      createProxyMiddleware({
        target,
        changeOrigin: true,
        xfwd: true,
        // Express quita el prefijo montado: /api/auth/login -> /login -> /auth/login
        pathRewrite: (path) => `/${name}${path}`,
        on: {
          error: (_err, _req, res) => {
            if ('writeHead' in res && !res.headersSent) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ statusCode: 503, message: `Servicio "${name}" no disponible` }));
            }
          },
        },
      }),
    );
  }

  // App PWA de la billetera en la raíz. Las rutas internas (/tarjeta, /perfil…) devuelven
  // index.html y React decide qué pantalla mostrar.
  if (existsSync(join(APP_DIR, 'index.html'))) {
    app.useStaticAssets(APP_DIR, {
      index: false,
      setHeaders: (res, path) => {
        // sw.js e index.html no se cachean (para recibir actualizaciones); /assets sí (llevan hash).
        if (/[\\/]assets[\\/]/.test(path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else res.setHeader('Cache-Control', 'no-cache');
      },
    });
    app.getHttpAdapter().getInstance().get(SPA_ROUTES, (_req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(APP_DIR, 'index.html'));
    });
  } else {
    Logger.warn('App PWA sin compilar: ejecuta "npm run app:build" (o usa "npm run app:dev" en :5173)', 'Bootstrap');
  }

  const port = Number(process.env.GATEWAY_PORT ?? 4000);
  await app.listen(port);
  Logger.log(`api-gateway en http://localhost:${port} (app) y /api -> ${JSON.stringify(ROUTES)}`, 'Bootstrap');
}
bootstrap();
