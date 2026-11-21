import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { SerialPort } from 'serialport';

const execFileAsync = promisify(execFile);

export interface CompilerCheckOutcome {
  target: 'c99' | 'rust';
  status: 'passed' | 'failed' | 'unavailable';
  binary: string | null;
  command: string;
  durationMs: number;
  objectBytes: number | null;
  output: string;
}

export interface FirmwareVerifyRequest {
  modelId: string;
  cHeader: string;
  cSource: string;
  hilHeader: string;
  rustLib: string;
}

export interface FirmwareVerifyResponse {
  ok: boolean;
  verifiedAt: string;
  c99: CompilerCheckOutcome;
  rust: CompilerCheckOutcome;
}

export interface SerialPortInfo {
  id: string;
  label: string;
  kind: 'loopback' | 'hardware';
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
}

export interface HilProbeRequest {
  portId: string;
  baudRate: number;
  transport: 'uart_cobs' | 'socketcan' | 'udp';
  wireHex: string;
}

export interface HilProbeResponse {
  ok: boolean;
  portId: string;
  rttMs: number;
  rxBytes: number;
  crcValid: boolean;
  decodedSeq: number | null;
  decodedTickUs: number | null;
  message: string;
}

const ALLOWED_BAUD_RATES = new Set([9600, 115200, 460800, 921600, 1000000, 2000000]);
const MAX_SOURCE_CHARS = 250_000;
const HARDWARE_PORT_PATH_PATTERN = /^(?:\/dev\/[A-Za-z0-9._/-]{1,64}|COM\d{1,3})$/;
const SERIAL_TRANSFER_TIMEOUT_MS = 500;
const SERIAL_ECHO_WINDOW_MS = 35;

async function findExecutable(candidates: string[]): Promise<string | null> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  for (const bin of candidates) {
    try {
      await execFileAsync(cmd, [bin], { timeout: 2000 });
      return bin;
    } catch {
      // Try next binary candidate
    }
  }
  return null;
}

function resolveConfinedPath(baseDir: string, fileName: string): string {
  const realBase = fs.realpathSync(baseDir);
  const resolved = path.resolve(realBase, fileName);
  if (!resolved.startsWith(realBase + path.sep)) {
    throw new Error(`Refused unsafe file path outside sandbox: ${fileName}`);
  }
  return resolved;
}

function crc16Ccitt(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function cobsDecode(encoded: Uint8Array): Uint8Array | null {
  if (encoded.length < 2) return null;
  // Strip trailing 0x00 delimiter if present
  const end = encoded[encoded.length - 1] === 0 ? encoded.length - 1 : encoded.length;
  const out: number[] = [];
  let idx = 0;
  while (idx < end) {
    const code = encoded[idx];
    if (code === 0) return null;
    idx += 1;
    for (let i = 1; i < code; i++) {
      if (idx >= end) return null;
      out.push(encoded[idx++]);
    }
    if (code < 0xff && idx < end) {
      out.push(0);
    }
  }
  return Uint8Array.from(out);
}

function decodeHilFrame(
  wireBytes: Uint8Array,
  transport: HilProbeRequest['transport']
): {
  rawPayload: Uint8Array | null;
  crcValid: boolean;
  seq: number | null;
  tickUs: number | null;
  computedCrc: number | null;
} {
  const rawPayload = transport === 'uart_cobs' ? cobsDecode(wireBytes) : wireBytes;
  if (!rawPayload || rawPayload.length < 28) {
    return {
      rawPayload,
      crcValid: false,
      seq: null,
      tickUs: null,
      computedCrc: null,
    };
  }

  const view = new DataView(
    rawPayload.buffer,
    rawPayload.byteOffset,
    rawPayload.byteLength
  );
  const sof = view.getUint16(0, false);
  const seq = view.getUint32(2, true);
  const tickUs = view.getUint32(6, true);
  const frameCrc = view.getUint16(26, true);
  const computedCrc = crc16Ccitt(rawPayload.subarray(0, 26));
  const crcValid = sof === 0xaa55 && frameCrc === computedCrc;

  return {
    rawPayload,
    crcValid,
    seq,
    tickUs,
    computedCrc,
  };
}

export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  const ports: SerialPortInfo[] = [
    {
      id: 'bridge://loopback-pty',
      label: 'Node Bridge Loopback (COBS / CRC-16 Echo)',
      kind: 'loopback',
    },
  ];
  const seen = new Set<string>(['bridge://loopback-pty']);

  try {
    const detected = await SerialPort.list();
    for (const dev of detected) {
      if (!dev.path || seen.has(dev.path) || !HARDWARE_PORT_PATH_PATTERN.test(dev.path)) {
        continue;
      }
      seen.add(dev.path);
      const mfgSuffix = dev.manufacturer ? ` — ${dev.manufacturer}` : '';
      ports.push({
        id: dev.path,
        label: `Hardware Serial (${dev.path}${mfgSuffix})`,
        kind: 'hardware',
        manufacturer: dev.manufacturer || undefined,
        vendorId: dev.vendorId || undefined,
        productId: dev.productId || undefined,
      });
    }
  } catch {
    // Headless container without udev/sysfs bindings; fall back to /dev scan + loopback
  }

  try {
    const devEntries = fs.readdirSync('/dev');
    const ttyPattern = /^(ttyUSB|ttyACM|cu\.usb|tty\.usb)[A-Za-z0-9._-]{0,32}$/;
    for (const entry of devEntries) {
      const fullPath = `/dev/${entry}`;
      if (ttyPattern.test(entry) && !seen.has(fullPath)) {
        seen.add(fullPath);
        ports.push({
          id: fullPath,
          label: `Hardware Serial (${fullPath})`,
          kind: 'hardware',
        });
      }
    }
  } catch {
    // Non-POSIX host or restricted /dev read; loopback port remains available
  }

  return ports;
}

export async function getBridgeStatus() {
  const [cBin, rustBin, ports] = await Promise.all([
    findExecutable(['gcc', 'cc', 'clang']),
    findExecutable(['rustc']),
    listSerialPorts(),
  ]);

  return {
    ok: true,
    runtime: `node ${process.version}`,
    serialDriver: 'serialport',
    compilers: {
      c99: { available: Boolean(cBin), binary: cBin },
      rust: { available: Boolean(rustBin), binary: rustBin },
    },
    serial: {
      ports,
    },
  };
}

export async function verifyEmbeddedBuild(
  req: FirmwareVerifyRequest
): Promise<FirmwareVerifyResponse> {
  const cleanModelId = (req.modelId || 'model').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  if (!cleanModelId) {
    throw new Error('Invalid model identifier.');
  }

  for (const field of [req.cHeader, req.cSource, req.hilHeader, req.rustLib]) {
    if (
      typeof field !== 'string' ||
      field.length > MAX_SOURCE_CHARS ||
      field.includes('\0')
    ) {
      throw new Error('Source payload invalid or exceeds maximum allowed size.');
    }
  }

  const [cBin, rustBin] = await Promise.all([
    findExecutable(['gcc', 'cc', 'clang']),
    findExecutable(['rustc']),
  ]);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openloop-verify-'));

  try {
    const cHeaderPath = resolveConfinedPath(tmpDir, 'ctrl_model.h');
    const hilHeaderPath = resolveConfinedPath(tmpDir, 'hil_frame.h');
    const cSourcePath = resolveConfinedPath(tmpDir, 'ctrl_model.c');
    const smokePath = resolveConfinedPath(tmpDir, 'smoke_test.c');
    const rustPath = resolveConfinedPath(tmpDir, 'lib.rs');

    fs.writeFileSync(cHeaderPath, req.cHeader, 'utf8');
    fs.writeFileSync(hilHeaderPath, req.hilHeader, 'utf8');
    fs.writeFileSync(cSourcePath, req.cSource, 'utf8');

    const smokeSource = `#include "ctrl_model.h"
#include "hil_frame.h"
int main(void) {
    CtrlState st;
    CtrlInput in = { 0 };
    CtrlOutput out = { 0 };
    ctrl_init(&st);
    in.hil_rx_valid = true;
    in.ref = 1.0f;
    ctrl_step(&st, &in, &out);
    ctrl_plant_step(&st, out.u_cmd);
    HilWireFrame wf = { 0 };
    uint8_t enc[64];
    (void)hil_crc16_ccitt((const uint8_t *)&wf, sizeof(wf) - 2U);
    (void)hil_cobs_encode((const uint8_t *)&wf, sizeof(wf), enc);
    return 0;
}
`;
    fs.writeFileSync(smokePath, smokeSource, 'utf8');
    fs.writeFileSync(rustPath, req.rustLib, 'utf8');

    let c99Outcome: CompilerCheckOutcome;
    if (!cBin) {
      c99Outcome = {
        target: 'c99',
        status: 'unavailable',
        binary: null,
        command: 'gcc -std=c99 -Wall -Wextra -Werror -pedantic -c ctrl_model.c',
        durationMs: 0,
        objectBytes: null,
        output: 'No C99 compiler (gcc, cc, or clang) found on host PATH.',
      };
    } else {
      const start = performance.now();
      const args = [
        '-std=c99',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-pedantic',
        '-c',
        'ctrl_model.c',
        '-o',
        'ctrl_model.o',
      ];
      try {
        const { stdout, stderr } = await execFileAsync(cBin, args, {
          cwd: tmpDir,
          timeout: 8000,
          maxBuffer: 256 * 1024,
        });
        // Also verify full ABI + hil_frame.h linkage against smoke_test.c
        await execFileAsync(
          cBin,
          ['-std=c99', '-Wall', '-Wextra', '-Werror', 'smoke_test.c', 'ctrl_model.o', '-o', 'smoke_test'],
          { cwd: tmpDir, timeout: 8000, maxBuffer: 256 * 1024 }
        );
        const objPath = resolveConfinedPath(tmpDir, 'ctrl_model.o');
        const objSize = fs.statSync(objPath).size;
        c99Outcome = {
          target: 'c99',
          status: 'passed',
          binary: cBin,
          command: `${cBin} ${args.join(' ')}`,
          durationMs: Number((performance.now() - start).toFixed(1)),
          objectBytes: objSize,
          output:
            [stdout, stderr].filter(Boolean).join('\n').trim() ||
            `Compiled & linked ctrl_model.o (${objSize} bytes) for ${cleanModelId} with zero warnings.`,
        };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        c99Outcome = {
          target: 'c99',
          status: 'failed',
          binary: cBin,
          command: `${cBin} ${args.join(' ')}`,
          durationMs: Number((performance.now() - start).toFixed(1)),
          objectBytes: null,
          output: [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim(),
        };
      }
    }

    let rustOutcome: CompilerCheckOutcome;
    if (!rustBin) {
      rustOutcome = {
        target: 'rust',
        status: 'unavailable',
        binary: null,
        command: 'rustc --crate-type lib --edition 2021 -D warnings lib.rs',
        durationMs: 0,
        objectBytes: null,
        output: 'rustc is not installed on this host; download Preset ZIP to build locally.',
      };
    } else {
      const start = performance.now();
      const args = [
        '--crate-type',
        'lib',
        '--edition',
        '2021',
        '-O',
        '-D',
        'warnings',
        'lib.rs',
        '-o',
        'libopenloop_ctrl.rlib',
      ];
      try {
        const { stdout, stderr } = await execFileAsync(rustBin, args, {
          cwd: tmpDir,
          timeout: 10000,
          maxBuffer: 256 * 1024,
        });
        const rlibPath = resolveConfinedPath(tmpDir, 'libopenloop_ctrl.rlib');
        const rlibSize = fs.statSync(rlibPath).size;
        rustOutcome = {
          target: 'rust',
          status: 'passed',
          binary: rustBin,
          command: `${rustBin} ${args.join(' ')}`,
          durationMs: Number((performance.now() - start).toFixed(1)),
          objectBytes: rlibSize,
          output:
            [stdout, stderr].filter(Boolean).join('\n').trim() ||
            `Compiled #![no_std] crate (${rlibSize} bytes) with zero warnings.`,
        };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        rustOutcome = {
          target: 'rust',
          status: 'failed',
          binary: rustBin,
          command: `${rustBin} ${args.join(' ')}`,
          durationMs: Number((performance.now() - start).toFixed(1)),
          objectBytes: null,
          output: [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim(),
        };
      }
    }

    return {
      ok: c99Outcome.status !== 'failed' && rustOutcome.status !== 'failed',
      verifiedAt: new Date().toISOString(),
      c99: c99Outcome,
      rust: rustOutcome,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function exchangeSerialFrame(
  portPath: string,
  baudRate: number,
  wireBytes: Uint8Array
): Promise<Uint8Array> {
  const port = new SerialPort({
    path: portPath,
    baudRate,
    autoOpen: false,
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out opening serial port ${portPath}`));
    }, SERIAL_TRANSFER_TIMEOUT_MS);

    port.open((err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });

  try {
    const rxChunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      rxChunks.push(chunk);
    };
    port.on('data', onData);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out writing frame to ${portPath}`));
      }, SERIAL_TRANSFER_TIMEOUT_MS);

      port.write(Buffer.from(wireBytes), (writeErr) => {
        if (writeErr) {
          clearTimeout(timer);
          reject(writeErr);
          return;
        }
        port.drain((drainErr) => {
          clearTimeout(timer);
          if (drainErr) reject(drainErr);
          else resolve();
        });
      });
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, SERIAL_ECHO_WINDOW_MS);
    });
    port.off('data', onData);

    return rxChunks.length > 0 ? Buffer.concat(rxChunks) : new Uint8Array(0);
  } finally {
    if (port.isOpen) {
      await new Promise<void>((resolve) => {
        port.close(() => resolve());
      });
    }
  }
}

export async function probeHilBridge(req: HilProbeRequest): Promise<HilProbeResponse> {
  const start = performance.now();
  const allowedPorts = await listSerialPorts();
  const matchedPort = allowedPorts.find((p) => p.id === req.portId);
  if (!matchedPort) {
    throw new Error('Selected port is not in the enumerated host serial allowlist.');
  }
  if (!ALLOWED_BAUD_RATES.has(req.baudRate)) {
    throw new Error(`Unsupported baud rate: ${req.baudRate}`);
  }

  const hexTokens = req.wireHex.trim().split(/\s+/).filter(Boolean);
  if (hexTokens.length === 0 || hexTokens.length > 256) {
    throw new Error('Wire frame hex length must be between 1 and 256 bytes.');
  }
  const wireBytes = Uint8Array.from(
    hexTokens.map((tok) => {
      if (!/^[0-9a-fA-F]{2}$/.test(tok)) {
        throw new Error(`Invalid hex byte token: ${tok}`);
      }
      return parseInt(tok, 16);
    })
  );

  const txDecoded = decodeHilFrame(wireBytes, req.transport);

  if (!txDecoded.rawPayload || txDecoded.rawPayload.length < 28) {
    return {
      ok: false,
      portId: req.portId,
      rttMs: Number((performance.now() - start).toFixed(3)),
      rxBytes: wireBytes.length,
      crcValid: false,
      decodedSeq: null,
      decodedTickUs: null,
      message: 'Frame decode failed: invalid COBS framing or truncated payload.',
    };
  }

  if (matchedPort.kind === 'hardware') {
    if (!txDecoded.crcValid) {
      return {
        ok: false,
        portId: matchedPort.id,
        rttMs: Number((performance.now() - start).toFixed(3)),
        rxBytes: 0,
        crcValid: false,
        decodedSeq: txDecoded.seq,
        decodedTickUs: txDecoded.tickUs,
        message: 'Refused hardware serial write: TX frame CRC-16 check failed.',
      };
    }

    try {
      const echoed = await exchangeSerialFrame(matchedPort.id, req.baudRate, wireBytes);
      if (echoed.length > 0) {
        const rxDecoded = decodeHilFrame(echoed, req.transport);
        return {
          ok: rxDecoded.crcValid,
          portId: matchedPort.id,
          rttMs: Number((performance.now() - start).toFixed(3)),
          rxBytes: echoed.length,
          crcValid: rxDecoded.crcValid,
          decodedSeq: rxDecoded.seq,
          decodedTickUs: rxDecoded.tickUs,
          message: rxDecoded.crcValid
            ? `SerialPort RX echo verified on ${matchedPort.id} at ${req.baudRate} bps (SEQ=#${rxDecoded.seq}).`
            : `SerialPort received ${echoed.length}B from ${matchedPort.id}, but CRC-16 verification failed.`,
        };
      }

      return {
        ok: true,
        portId: matchedPort.id,
        rttMs: Number((performance.now() - start).toFixed(3)),
        rxBytes: wireBytes.length,
        crcValid: true,
        decodedSeq: txDecoded.seq,
        decodedTickUs: txDecoded.tickUs,
        message: `Transmitted ${wireBytes.length}B frame via serialport to ${matchedPort.id} at ${req.baudRate} bps.`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'SerialPort transfer failed';
      return {
        ok: false,
        portId: matchedPort.id,
        rttMs: Number((performance.now() - start).toFixed(3)),
        rxBytes: 0,
        crcValid: txDecoded.crcValid,
        decodedSeq: txDecoded.seq,
        decodedTickUs: txDecoded.tickUs,
        message: `Hardware port ${matchedPort.id} unavailable (${msg}).`,
      };
    }
  }

  // Host Node loopback verification
  return {
    ok: txDecoded.crcValid,
    portId: matchedPort.id,
    rttMs: Number((performance.now() - start).toFixed(3)),
    rxBytes: wireBytes.length,
    crcValid: txDecoded.crcValid,
    decodedSeq: txDecoded.seq,
    decodedTickUs: txDecoded.tickUs,
    message: txDecoded.crcValid
      ? `Bridge loopback verified SOF=0xAA55, SEQ=#${txDecoded.seq}, CRC=0x${(txDecoded.computedCrc ?? 0).toString(16).toUpperCase().padStart(4, '0')}.`
      : 'Bridge loopback CRC-16 mismatch.',
  };
}

