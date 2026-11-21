import { ControlModel, HilFramePacket, SimulationTrace } from '../types/control';

export function crc16Ccitt(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export function cobsEncode(input: Uint8Array): Uint8Array {
  const out: number[] = [0];
  let codeIdx = 0;
  let code = 1;

  for (let i = 0; i < input.length; i++) {
    const byte = input[i];
    if (byte === 0) {
      out[codeIdx] = code;
      codeIdx = out.length;
      out.push(0);
      code = 1;
    } else {
      out.push(byte);
      code++;
      if (code === 0xff) {
        out[codeIdx] = code;
        codeIdx = out.length;
        out.push(0);
        code = 1;
      }
    }
  }
  out[codeIdx] = code;
  out.push(0x00); // Delimiter
  return new Uint8Array(out);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
}

export interface HilSimulationConfig {
  jitterMs: number;
  packetDropPct: number;
  seed: number;
}

function pseudoRand(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export function createHilPacket(
  model: ControlModel,
  sample: SimulationTrace['samples'][number],
  seq: number,
  prevConsecutiveMisses: number,
  hilSim: HilSimulationConfig
): { packet: HilFramePacket; nextConsecutiveMisses: number } {
  const budgetMs = model.baseDt * 1000;
  const tickUs = Math.round(sample.t * 1_000_000);
  const payload = [
    sample.ref,
    sample.silOutputs[0] ?? 0,
    sample.silOutputs[1] ?? 0,
    sample.uSat,
  ];

  // Pack binary frame: [SOF 2B] [SEQ 4B] [TICK_US 4B] [4x f32 16B] = 26 bytes + CRC16 2B = 28 bytes
  const buf = new ArrayBuffer(28);
  const view = new DataView(buf);
  view.setUint16(0, 0xaa55, false);
  view.setUint32(2, seq, true);
  view.setUint32(6, tickUs, true);
  view.setFloat32(10, payload[0], true);
  view.setFloat32(14, payload[1], true);
  view.setFloat32(18, payload[2], true);
  view.setFloat32(22, payload[3], true);

  const crc = crc16Ccitt(new Uint8Array(buf, 0, 26));
  view.setUint16(26, crc, true);

  const rawBytes = new Uint8Array(buf);
  const wireBytes =
    model.hil.transport === 'uart_cobs' ? cobsEncode(rawBytes) : rawBytes;

  // Deterministic fault & jitter evaluation
  const rDrop = pseudoRand(hilSim.seed + seq * 17);
  const rJitter = pseudoRand(hilSim.seed + seq * 31);
  const dropped = rDrop * 100 < hilSim.packetDropPct;

  const baseRtt =
    model.hil.transport === 'udp'
      ? 0.22
      : model.hil.transport === 'socketcan'
      ? 0.38
      : 0.48;
  const rttMs = dropped
    ? budgetMs * 1.5
    : Number((baseRtt + rJitter * hilSim.jitterMs).toFixed(3));
  const deadlineMissed = dropped || rttMs > budgetMs;

  const nextConsecutiveMisses = deadlineMissed ? prevConsecutiveMisses + 1 : 0;

  const watchdogState: HilFramePacket['watchdogState'] =
    nextConsecutiveMisses >= model.hil.watchdogMissLimit
      ? 'SAFE_CLAMP'
      : nextConsecutiveMisses > 0
      ? 'WARN'
      : 'NOMINAL';

  return {
    packet: {
      seq,
      tickUs,
      simTime: sample.t,
      transport: model.hil.transport,
      payloadFloats: payload,
      crc16: crc,
      rawHex: toHex(rawBytes),
      wireHex: toHex(wireBytes),
      byteLength: wireBytes.length,
      rttMs,
      dropped,
      deadlineMissed,
      watchdogState,
    },
    nextConsecutiveMisses,
  };
}

export function buildHilFrameStream(
  model: ControlModel,
  trace: SimulationTrace,
  hilSim: HilSimulationConfig
): HilFramePacket[] {
  const packets: HilFramePacket[] = [];
  const sampleCount = Math.min(48, trace.samples.length);
  const step = Math.max(1, Math.floor(trace.samples.length / sampleCount));
  let consecutiveMisses = 0;

  for (let idx = 0, seq = 1; idx < trace.samples.length && packets.length < 48; idx += step, seq++) {
    const res = createHilPacket(
      model,
      trace.samples[idx],
      seq,
      consecutiveMisses,
      hilSim
    );
    consecutiveMisses = res.nextConsecutiveMisses;
    packets.push(res.packet);
  }

  return packets;
}
