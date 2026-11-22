import express, { type Express, type Request, type Response, type Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SerialPort } from 'serialport';
import {
  getBridgeStatus,
  listSerialPorts,
  probeHilBridge,
  verifyEmbeddedBuild,
  type FirmwareVerifyRequest,
  type HilProbeRequest,
} from './bridgeService.ts';

export interface BridgeRouterOptions {
  /** Optional explicit list of allowed CORS origins for standalone bridge mode. */
  allowedOrigins?: string[];
}

export function createBridgeRouter(options: BridgeRouterOptions = {}): Router {
  const router = express.Router();
  const allowedOriginSet = new Set(options.allowedOrigins ?? []);

  router.use(express.json({ limit: '512kb' }));

  router.use((req: Request, res: Response, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');

    const origin = req.headers.origin;
    if (origin && allowedOriginSet.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      service: 'openloop-bridge',
      serialDriver: typeof SerialPort.list === 'function' ? 'serialport' : 'unavailable',
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/bridge/status', async (_req: Request, res: Response) => {
    try {
      const status = await getBridgeStatus();
      res.json(status);
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to inspect host bridge.',
      });
    }
  });

  router.post('/codegen/verify', async (req: Request, res: Response) => {
    try {
      const body = req.body as Partial<FirmwareVerifyRequest>;
      if (
        !body ||
        typeof body.cHeader !== 'string' ||
        typeof body.cSource !== 'string' ||
        typeof body.hilHeader !== 'string' ||
        typeof body.rustLib !== 'string'
      ) {
        res.status(400).json({
          ok: false,
          error: 'Expected cHeader, cSource, hilHeader, and rustLib source strings.',
        });
        return;
      }

      const result = await verifyEmbeddedBuild({
        modelId: typeof body.modelId === 'string' ? body.modelId : 'model',
        cHeader: body.cHeader,
        cSource: body.cSource,
        hilHeader: body.hilHeader,
        rustLib: body.rustLib,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Compiler verification failed.',
      });
    }
  });

  router.get('/hil/ports', async (_req: Request, res: Response) => {
    try {
      const ports = await listSerialPorts();
      res.json({
        ok: true,
        driver: 'serialport',
        ports,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to enumerate serial ports.',
      });
    }
  });

  router.post('/hil/probe', async (req: Request, res: Response) => {
    try {
      const body = req.body as Partial<HilProbeRequest>;
      if (
        !body ||
        typeof body.portId !== 'string' ||
        typeof body.wireHex !== 'string' ||
        typeof body.baudRate !== 'number' ||
        !Number.isFinite(body.baudRate) ||
        (body.transport !== 'uart_cobs' &&
          body.transport !== 'socketcan' &&
          body.transport !== 'udp')
      ) {
        res.status(400).json({
          ok: false,
          error: 'Invalid HIL probe request payload.',
        });
        return;
      }

      const result = await probeHilBridge({
        portId: body.portId,
        baudRate: body.baudRate,
        transport: body.transport,
        cobsEnabled: typeof body.cobsEnabled === 'boolean' ? body.cobsEnabled : undefined,
        wireHex: body.wireHex,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err instanceof Error ? err.message : 'HIL probe rejected.',
      });
    }
  });

  return router;
}

export function createBridgeApp(options: BridgeRouterOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', createBridgeRouter(options));
  return app;
}

export function startBridgeServer(
  port = Number(process.env.BRIDGE_PORT ?? process.env.PORT) || 3001,
  host = process.env.BRIDGE_HOST || '127.0.0.1'
) {
  const allowedOrigins = (process.env.BRIDGE_ALLOWED_ORIGINS ?? 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const app = createBridgeApp({ allowedOrigins });
  return app.listen(port, host, () => {
    console.log(`OpenLoop local Express + serialport bridge listening on http://${host}:${port}`);
  });
}

const isDirectEntry =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectEntry) {
  startBridgeServer();
}
