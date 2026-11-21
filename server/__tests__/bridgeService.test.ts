import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { PRESET_MODELS } from '../../src/data/presets';
import { generateEmbeddedCode } from '../../src/engine/codegen';
import { createHilPacket } from '../../src/engine/hil';
import { discretizeStateSpace } from '../../src/engine/math';
import { runSimulation } from '../../src/engine/simulator';
import { resizePlantDimensions } from '../../src/utils/modelHelpers';
import {
  listSerialPorts,
  probeHilBridge,
  verifyEmbeddedBuild,
} from '../bridgeService';
import { createBridgeApp } from '../index';

describe('Local Node Bridge Service & Express Router', () => {
  it('compiles generated C99 firmware with -std=c99 -Wall -Wextra -Werror -pedantic including custom IDs and MIMO dims', async () => {
    const custom = resizePlantDimensions(PRESET_MODELS.pendulum, 5, 3, 3);
    custom.id = 'custom-plant 5d';
    const discrete = discretizeStateSpace(custom.plant, custom.baseDt, custom.discretization);
    const code = generateEmbeddedCode(custom, discrete);

    const res = await verifyEmbeddedBuild({
      modelId: custom.id,
      cHeader: code.cHeader,
      cSource: code.cSource,
      hilHeader: code.hilHeader,
      rustLib: code.rustLib,
    });

    expect(res.c99.status).toBe('passed');
    expect(res.c99.objectBytes).toBeGreaterThan(100);
    expect(['passed', 'unavailable']).toContain(res.rust.status);
  });

  it('enumerates loopback port and verifies COBS + CRC-16-CCITT HIL frame round-trip', async () => {
    const ports = await listSerialPorts();
    expect(ports.some((p) => p.id === 'bridge://loopback-pty')).toBe(true);

    const model = PRESET_MODELS.pendulum;
    const trace = runSimulation(model);
    const { packet } = createHilPacket(model, trace.samples[10], 7, 0, {
      jitterMs: 0,
      packetDropPct: 0,
      seed: 1,
    });

    const probe = await probeHilBridge({
      portId: 'bridge://loopback-pty',
      baudRate: 921600,
      transport: model.hil.transport,
      wireHex: packet.wireHex,
    });

    expect(probe.ok).toBe(true);
    expect(probe.crcValid).toBe(true);
    expect(probe.decodedSeq).toBe(7);
  });

  it('rejects unallowlisted device paths and invalid baud rates on HIL probe', async () => {
    await expect(
      probeHilBridge({
        portId: '/etc/passwd',
        baudRate: 921600,
        transport: 'uart_cobs',
        wireHex: '01 02 00',
      })
    ).rejects.toThrow(/allowlist/i);

    await expect(
      probeHilBridge({
        portId: 'bridge://loopback-pty',
        baudRate: 12345,
        transport: 'uart_cobs',
        wireHex: '01 02 00',
      })
    ).rejects.toThrow(/baud rate/i);
  });

  it('serves health, port enumeration, HIL probe, and compiler verification over Express in server/index.ts', async () => {
    const app = createBridgeApp();
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
    });

    try {
      const { port } = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${port}/api`;

      const healthRes = await fetch(`${baseUrl}/health`);
      expect(healthRes.status).toBe(200);
      const health = (await healthRes.json()) as { ok: boolean; serialDriver: string };
      expect(health.ok).toBe(true);
      expect(health.serialDriver).toBe('serialport');

      const portsRes = await fetch(`${baseUrl}/hil/ports`);
      expect(portsRes.status).toBe(200);
      const portsData = (await portsRes.json()) as {
        ok: boolean;
        driver: string;
        ports: { id: string }[];
      };
      expect(portsData.ok).toBe(true);
      expect(portsData.driver).toBe('serialport');
      expect(portsData.ports.some((p) => p.id === 'bridge://loopback-pty')).toBe(true);

      const badProbeRes = await fetch(`${baseUrl}/hil/probe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          portId: '../../dev/ttyUSB0',
          baudRate: 921600,
          transport: 'uart_cobs',
          wireHex: 'AA 55',
        }),
      });
      expect(badProbeRes.status).toBe(400);

      const model = PRESET_MODELS.pendulum;
      const discrete = discretizeStateSpace(model.plant, model.baseDt, model.discretization);
      const code = generateEmbeddedCode(model, discrete);
      const verifyRes = await fetch(`${baseUrl}/codegen/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId: model.id,
          cHeader: code.cHeader,
          cSource: code.cSource,
          hilHeader: code.hilHeader,
          rustLib: code.rustLib,
        }),
      });
      expect(verifyRes.status).toBe(200);
      const verifyData = (await verifyRes.json()) as {
        ok: boolean;
        c99: { status: string };
      };
      expect(verifyData.ok).toBe(true);
      expect(verifyData.c99.status).toBe('passed');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

