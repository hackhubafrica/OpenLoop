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

export function isHilCobsEnabled(model: ControlModel): boolean {
  return model.hil.cobsEnabled ?? model.hil.transport === 'uart_cobs';
}

export function cobsDecode(encoded: Uint8Array): Uint8Array | null {
  if (encoded.length < 2) return null;
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
  const cobsActive = isHilCobsEnabled(model);
  const wireBytes = cobsActive ? cobsEncode(rawBytes) : rawBytes;

  // Deterministic fault & jitter evaluation
  const rDrop = pseudoRand(hilSim.seed + seq * 17);
  const rJitter = pseudoRand(hilSim.seed + seq * 31);
  const dropped = rDrop * 100 < hilSim.packetDropPct;

  const baseRtt =
    model.hil.transport === 'udp'
      ? 0.22
      : model.hil.transport === 'socketcan'
      ? 0.38
      : cobsActive
      ? 0.48
      : 0.44;
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

export interface HilWireFrameFields {
  seq: number;
  tickUs: number;
  ref: number;
  y0: number;
  y1: number;
  uCmd: number;
}

export function encodeHilWireFrameBytes(
  model: ControlModel,
  fields: HilWireFrameFields
): Uint8Array {
  const buf = new ArrayBuffer(28);
  const view = new DataView(buf);
  view.setUint16(0, 0xaa55, false);
  view.setUint32(2, fields.seq >>> 0, true);
  view.setUint32(6, fields.tickUs >>> 0, true);
  view.setFloat32(10, fields.ref, true);
  view.setFloat32(14, fields.y0, true);
  view.setFloat32(18, fields.y1, true);
  view.setFloat32(22, fields.uCmd, true);

  const crc = crc16Ccitt(new Uint8Array(buf, 0, 26));
  view.setUint16(26, crc, true);

  const rawBytes = new Uint8Array(buf);
  return isHilCobsEnabled(model) ? cobsEncode(rawBytes) : rawBytes;
}

export function computeHilFrameCrc16(fields: HilWireFrameFields): number {
  const buf = new ArrayBuffer(26);
  const view = new DataView(buf);
  view.setUint16(0, 0xaa55, false);
  view.setUint32(2, fields.seq >>> 0, true);
  view.setUint32(6, fields.tickUs >>> 0, true);
  view.setFloat32(10, fields.ref, true);
  view.setFloat32(14, fields.y0, true);
  view.setFloat32(18, fields.y1, true);
  view.setFloat32(22, fields.uCmd, true);
  return crc16Ccitt(new Uint8Array(buf, 0, 26));
}

export interface HilLoopbackDiagnostic {
  id: number;
  timestamp: string;
  mode: 'webserial' | 'bridge' | 'simulated';
  targetLabel: string;
  protocol: 'COBS + CRC16' | 'RAW + CRC16';
  txSeq: number;
  rxSeq: number | null;
  txBytes: number;
  rxBytes: number;
  expectedCrc16: number;
  rxCrc16: number | null;
  crcValid: boolean;
  payloadMatch: boolean;
  rttMs: number;
  budgetMs: number;
  verdict: 'PASS' | 'WARN_LATENCY' | 'FAIL';
  summary: string;
}

export interface EvaluateHilLoopbackInput {
  id: number;
  mode: HilLoopbackDiagnostic['mode'];
  targetLabel: string;
  cobsEnabled: boolean;
  txSeq: number;
  txBytes: number;
  expectedCrc16: number;
  budgetMs: number;
  rttMs: number;
  rxPacket?: HilFramePacket | null;
  rxSeq?: number | null;
  rxBytes?: number;
  rxCrc16?: number | null;
  crcValid?: boolean;
  errorMessage?: string | null;
}

export function evaluateHilLoopbackDiagnostic(
  input: EvaluateHilLoopbackInput
): HilLoopbackDiagnostic {
  const protocol: HilLoopbackDiagnostic['protocol'] = input.cobsEnabled
    ? 'COBS + CRC16'
    : 'RAW + CRC16';
  const rttMs = Number(Math.max(0, input.rttMs).toFixed(3));
  const budgetMs = Number(Math.max(0.01, input.budgetMs).toFixed(3));
  const rxSeq = input.rxPacket?.seq ?? input.rxSeq ?? null;
  const rxCrc16 = input.rxPacket?.crc16 ?? input.rxCrc16 ?? null;
  const rxBytes = input.rxPacket?.byteLength ?? input.rxBytes ?? 0;
  const crcValid =
    input.errorMessage != null
      ? false
      : input.crcValid ?? (input.rxPacket != null && input.rxPacket.crc16 >= 0);

  const payloadMatch =
    crcValid &&
    rxSeq === input.txSeq &&
    (rxCrc16 === null || rxCrc16 === input.expectedCrc16);

  let verdict: HilLoopbackDiagnostic['verdict'] = 'FAIL';
  let summary = '';

  if (input.errorMessage) {
    verdict = 'FAIL';
    summary = input.errorMessage;
  } else if (!crcValid || rxSeq === null) {
    verdict = 'FAIL';
    summary =
      rxBytes === 0
        ? `No loopback reply received on ${input.targetLabel} within timeout.`
        : `CRC-16 mismatch on ${input.targetLabel} (expected 0x${input.expectedCrc16
            .toString(16)
            .toUpperCase()
            .padStart(4, '0')}).`;
  } else if (rttMs > budgetMs) {
    verdict = 'WARN_LATENCY';
    summary = `CRC-16 valid (${
      payloadMatch ? 'exact echo' : `telemetry reply #${rxSeq}`
    }), but RTT ${rttMs.toFixed(3)} ms exceeds ${budgetMs.toFixed(2)} ms tick budget.`;
  } else {
    verdict = 'PASS';
    summary = `HIL integrity confirmed (${
      payloadMatch ? 'exact packet echo' : `CRC-verified reply #${rxSeq}`
    }) in ${rttMs.toFixed(3)} ms ≤ ${budgetMs.toFixed(2)} ms budget.`;
  }

  return {
    id: input.id,
    timestamp: new Date().toLocaleTimeString([], { hour12: false }),
    mode: input.mode,
    targetLabel: input.targetLabel,
    protocol,
    txSeq: input.txSeq,
    rxSeq,
    txBytes: input.txBytes,
    rxBytes,
    expectedCrc16: input.expectedCrc16,
    rxCrc16,
    crcValid,
    payloadMatch,
    rttMs,
    budgetMs,
    verdict,
    summary,
  };
}

export type HilStreamParseEvent =
  | { ok: true; packet: HilFramePacket }
  | { ok: false; reason: 'cobs' | 'crc' | 'length' };

export function parseRawHilFrameBytes(
  rawBytes: Uint8Array,
  model: ControlModel,
  wireBytes: Uint8Array,
  prevTimestampMs?: number,
  nowMs: number = Date.now()
): HilStreamParseEvent {
  if (rawBytes.length !== 28) {
    return { ok: false, reason: 'length' };
  }
  const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  const sof = view.getUint16(0, false);
  if (sof !== 0xaa55) {
    return { ok: false, reason: 'length' };
  }
  const frameCrc = view.getUint16(26, true);
  const computedCrc = crc16Ccitt(rawBytes.subarray(0, 26));
  if (frameCrc !== computedCrc) {
    return { ok: false, reason: 'crc' };
  }

  const seq = view.getUint32(2, true);
  const tickUs = view.getUint32(6, true);
  const payloadFloats = [
    view.getFloat32(10, true),
    view.getFloat32(14, true),
    view.getFloat32(18, true),
    view.getFloat32(22, true),
  ];

  const budgetMs = model.baseDt * 1000;
  const rttMs =
    prevTimestampMs !== undefined
      ? Number(Math.max(0.05, nowMs - prevTimestampMs).toFixed(3))
      : Number((budgetMs * 0.45).toFixed(3));
  const deadlineMissed = rttMs > budgetMs * 1.5;

  return {
    ok: true,
    packet: {
      seq,
      tickUs,
      simTime: Number((tickUs * 1e-6).toFixed(4)),
      transport: model.hil.transport,
      payloadFloats,
      crc16: frameCrc,
      rawHex: toHex(rawBytes),
      wireHex: toHex(wireBytes),
      byteLength: wireBytes.length,
      rttMs,
      dropped: false,
      deadlineMissed,
      watchdogState: deadlineMissed ? 'WARN' : 'NOMINAL',
    },
  };
}

/**
 * Stateful streaming accumulator that parses arbitrary-length USB CDC / UART
 * chunks into CRC-verified COBS or Raw 28-byte HIL packets.
 */
export class HilSerialStreamAccumulator {
  private buffer: number[] = [];
  private lastPacketTimeMs: number | undefined;
  private static readonly MAX_COBS_BUFFER = 48;

  public reset(): void {
    this.buffer = [];
    this.lastPacketTimeMs = undefined;
  }

  public pushChunk(
    chunk: Uint8Array,
    model: ControlModel,
    cobsEnabled: boolean,
    nowMs: number = Date.now()
  ): HilStreamParseEvent[] {
    const events: HilStreamParseEvent[] = [];

    if (cobsEnabled) {
      for (let i = 0; i < chunk.length; i++) {
        const b = chunk[i];
        if (b === 0x00) {
          if (this.buffer.length > 0) {
            const wireBytes = Uint8Array.from([...this.buffer, 0x00]);
            this.buffer = [];
            const decoded = cobsDecode(wireBytes);
            if (!decoded) {
              events.push({ ok: false, reason: 'cobs' });
            } else {
              const parsed = parseRawHilFrameBytes(
                decoded,
                model,
                wireBytes,
                this.lastPacketTimeMs,
                nowMs
              );
              if (parsed.ok) {
                this.lastPacketTimeMs = nowMs;
              }
              events.push(parsed);
            }
          }
        } else if (this.buffer.length < HilSerialStreamAccumulator.MAX_COBS_BUFFER) {
          this.buffer.push(b);
        } else {
          // Overrun guard: discard noise until next 0x00 delimiter
          this.buffer = [];
        }
      }
      return events;
    }

    // Raw unstuffed binary mode: sync on 0xAA 0x55 and collect 28 bytes
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      if (this.buffer.length === 0) {
        if (b === 0xaa) this.buffer.push(b);
      } else if (this.buffer.length === 1) {
        if (b === 0x55) {
          this.buffer.push(b);
        } else {
          this.buffer = b === 0xaa ? [0xaa] : [];
        }
      } else {
        this.buffer.push(b);
        if (this.buffer.length === 28) {
          const rawBytes = Uint8Array.from(this.buffer);
          this.buffer = [];
          const parsed = parseRawHilFrameBytes(
            rawBytes,
            model,
            rawBytes,
            this.lastPacketTimeMs,
            nowMs
          );
          if (parsed.ok) {
            this.lastPacketTimeMs = nowMs;
          }
          events.push(parsed);
        }
      }
    }

    return events;
  }
}

export function buildHilFrameStream(
  model: ControlModel,
  trace: SimulationTrace,
  hilSim: HilSimulationConfig,
  maxPackets: number = 48
): HilFramePacket[] {
  const packets: HilFramePacket[] = [];
  const cap = Math.max(8, Math.min(240, Math.round(maxPackets)));
  const sampleCount = Math.min(cap, trace.samples.length);
  const step = Math.max(1, Math.floor(trace.samples.length / Math.max(1, sampleCount)));
  let consecutiveMisses = 0;

  for (let idx = 0, seq = 1; idx < trace.samples.length && packets.length < cap; idx += step, seq++) {
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

export interface TelemetryChannelMeta {
  id: 'ref' | 'y0' | 'y1' | 'uCmd';
  shortLabel: string;
  label: string;
  unit: string;
  color: string;
  stepped?: boolean;
}

export interface TelemetryStripSample {
  seq: number;
  tickUs: number;
  simTime: number;
  ref: number;
  y0: number;
  y1: number;
  uCmd: number;
  rawUCmd: number;
  dropped: boolean;
  deadlineMissed: boolean;
  watchdogState: HilFramePacket['watchdogState'];
}

export function getHilTelemetryChannels(model: ControlModel): TelemetryChannelMeta[] {
  const rx0 = model.hil.rxChannels[0] ?? 'y0';
  const rx1 = model.hil.rxChannels[1] ?? 'y1';
  const tx0 = model.hil.txChannels[0] ?? 'u_cmd';
  const outIdx = Math.min(
    Math.max(0, model.pid.targetOutputIndex),
    Math.max(0, model.plant.outputUnits.length - 1)
  );
  const refUnit = model.plant.outputUnits[outIdx] ?? '';
  const y0Unit = model.plant.outputUnits[0] ?? '';
  const y1Unit = model.plant.outputUnits[1] ?? '';
  const uUnit = model.plant.inputUnit ?? '';

  return [
    {
      id: 'ref',
      shortLabel: 'CH0 · ref',
      label: 'Setpoint Ref',
      unit: refUnit,
      color: '#E2E8F0',
    },
    {
      id: 'y0',
      shortLabel: `CH1 · ${rx0}`,
      label: model.plant.outputNames[0] ?? rx0,
      unit: y0Unit,
      color: '#06B6D4',
    },
    {
      id: 'y1',
      shortLabel: `CH2 · ${rx1}`,
      label: model.plant.outputNames[1] ?? rx1,
      unit: y1Unit,
      color: '#10B981',
    },
    {
      id: 'uCmd',
      shortLabel: `CH3 · ${tx0}`,
      label: model.plant.inputName ?? tx0,
      unit: uUnit,
      color: '#F59E0B',
      stepped: true,
    },
  ];
}

export function extractTelemetryStripSeries(
  model: ControlModel,
  packets: HilFramePacket[]
): TelemetryStripSample[] {
  return packets.map((pkt) => {
    const ref = pkt.payloadFloats[0] ?? 0;
    const y0 = pkt.payloadFloats[1] ?? 0;
    const y1 = pkt.payloadFloats[2] ?? 0;
    const rawUCmd = pkt.payloadFloats[3] ?? 0;
    const uCmd =
      pkt.watchdogState === 'SAFE_CLAMP' ? model.hil.safeClampValue : rawUCmd;
    return {
      seq: pkt.seq,
      tickUs: pkt.tickUs,
      simTime: pkt.simTime,
      ref,
      y0,
      y1,
      uCmd,
      rawUCmd,
      dropped: pkt.dropped,
      deadlineMissed: pkt.deadlineMissed,
      watchdogState: pkt.watchdogState,
    };
  });
}

export type TelemetryChannelId = TelemetryChannelMeta['id'];

export interface TelemetryLocalPeak {
  seq: number;
  simTime: number;
  value: number;
}

export interface TelemetryPeakAndCursorAnalysis {
  channelId: TelemetryChannelId;
  sampleCount: number;
  windowMin: TelemetryStripSample | null;
  windowMax: TelemetryStripSample | null;
  windowPeakToPeak: number;
  windowMean: number;
  windowRms: number;
  localPeaks: TelemetryLocalPeak[];
  cursorA: TelemetryStripSample | null;
  cursorB: TelemetryStripSample | null;
  deltaSeq: number | null;
  deltaTimeSec: number | null;
  frequencyHz: number | null;
  deltaValue: number | null;
  deltaPct: number | null;
  intervalMin: TelemetryStripSample | null;
  intervalMax: TelemetryStripSample | null;
  intervalPeakToPeak: number | null;
  intervalMean: number | null;
  intervalRms: number | null;
}

function resolveCursorSample(
  samples: TelemetryStripSample[],
  targetSeq: number | null | undefined
): { sample: TelemetryStripSample; index: number } | null {
  if (samples.length === 0 || targetSeq === null || targetSeq === undefined) {
    return null;
  }
  let bestIdx = 0;
  let bestDist = Math.abs(samples[0].seq - targetSeq);
  for (let i = 1; i < samples.length; i++) {
    const dist = Math.abs(samples[i].seq - targetSeq);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return { sample: samples[bestIdx], index: bestIdx };
}

function computeSeriesStats(
  samples: TelemetryStripSample[],
  channelId: TelemetryChannelId
): {
  minSample: TelemetryStripSample | null;
  maxSample: TelemetryStripSample | null;
  peakToPeak: number;
  mean: number;
  rms: number;
} {
  if (samples.length === 0) {
    return {
      minSample: null,
      maxSample: null,
      peakToPeak: 0,
      mean: 0,
      rms: 0,
    };
  }
  let minSample = samples[0];
  let maxSample = samples[0];
  let minVal = samples[0][channelId];
  let maxVal = samples[0][channelId];
  let sum = 0;
  let sumSq = 0;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const v = s[channelId];
    if (v < minVal) {
      minVal = v;
      minSample = s;
    }
    if (v > maxVal) {
      maxVal = v;
      maxSample = s;
    }
    sum += v;
    sumSq += v * v;
  }

  return {
    minSample,
    maxSample,
    peakToPeak: maxVal - minVal,
    mean: sum / samples.length,
    rms: Math.sqrt(sumSq / samples.length),
  };
}

export function analyzeTelemetryChannelWindow(
  samples: TelemetryStripSample[],
  channelId: TelemetryChannelId,
  cursorASeq?: number | null,
  cursorBSeq?: number | null
): TelemetryPeakAndCursorAnalysis {
  if (samples.length === 0) {
    return {
      channelId,
      sampleCount: 0,
      windowMin: null,
      windowMax: null,
      windowPeakToPeak: 0,
      windowMean: 0,
      windowRms: 0,
      localPeaks: [],
      cursorA: null,
      cursorB: null,
      deltaSeq: null,
      deltaTimeSec: null,
      frequencyHz: null,
      deltaValue: null,
      deltaPct: null,
      intervalMin: null,
      intervalMax: null,
      intervalPeakToPeak: null,
      intervalMean: null,
      intervalRms: null,
    };
  }

  const winStats = computeSeriesStats(samples, channelId);

  // Detect local maxima (handles single-point peaks and flat plateaus cleanly)
  const localPeaks: TelemetryLocalPeak[] = [];
  for (let i = 1; i < samples.length - 1; i++) {
    const prev = samples[i - 1][channelId];
    const curr = samples[i][channelId];
    const next = samples[i + 1][channelId];
    if (curr > prev && curr >= next) {
      // Advance past flat plateau if equal values continue
      let j = i;
      while (j + 1 < samples.length - 1 && samples[j + 1][channelId] === curr) {
        j++;
      }
      if (samples[j + 1][channelId] < curr) {
        localPeaks.push({
          seq: samples[i].seq,
          simTime: samples[i].simTime,
          value: curr,
        });
      }
      i = j;
    }
  }
  localPeaks.sort((a, b) => b.value - a.value);

  const resolvedA = resolveCursorSample(samples, cursorASeq);
  const resolvedB = resolveCursorSample(samples, cursorBSeq);
  const cursorA = resolvedA?.sample ?? null;
  const cursorB = resolvedB?.sample ?? null;

  if (!resolvedA || !resolvedB) {
    return {
      channelId,
      sampleCount: samples.length,
      windowMin: winStats.minSample,
      windowMax: winStats.maxSample,
      windowPeakToPeak: winStats.peakToPeak,
      windowMean: winStats.mean,
      windowRms: winStats.rms,
      localPeaks,
      cursorA,
      cursorB,
      deltaSeq: null,
      deltaTimeSec: null,
      frequencyHz: null,
      deltaValue: null,
      deltaPct: null,
      intervalMin: null,
      intervalMax: null,
      intervalPeakToPeak: null,
      intervalMean: null,
      intervalRms: null,
    };
  }

  const loIdx = Math.min(resolvedA.index, resolvedB.index);
  const hiIdx = Math.max(resolvedA.index, resolvedB.index);
  const intervalSlice = samples.slice(loIdx, hiIdx + 1);
  const intervalStats = computeSeriesStats(intervalSlice, channelId);

  const valA = resolvedA.sample[channelId];
  const valB = resolvedB.sample[channelId];
  const deltaSeq = resolvedB.sample.seq - resolvedA.sample.seq;
  const deltaTimeSec = resolvedB.sample.simTime - resolvedA.sample.simTime;
  const absDt = Math.abs(deltaTimeSec);
  const frequencyHz = absDt > 1e-6 ? 1 / absDt : null;
  const deltaValue = valB - valA;
  const deltaPct =
    Math.abs(valA) > 1e-9 ? ((valB - valA) / Math.abs(valA)) * 100 : null;

  return {
    channelId,
    sampleCount: samples.length,
    windowMin: winStats.minSample,
    windowMax: winStats.maxSample,
    windowPeakToPeak: winStats.peakToPeak,
    windowMean: winStats.mean,
    windowRms: winStats.rms,
    localPeaks,
    cursorA,
    cursorB,
    deltaSeq,
    deltaTimeSec,
    frequencyHz,
    deltaValue,
    deltaPct,
    intervalMin: intervalStats.minSample,
    intervalMax: intervalStats.maxSample,
    intervalPeakToPeak: intervalStats.peakToPeak,
    intervalMean: intervalStats.mean,
    intervalRms: intervalStats.rms,
  };
}

export interface TelemetryChannelYScale {
  min: number;
  max: number;
  rawMin: number;
  rawMax: number;
  peakToPeak: number;
  perDiv: number;
}

export function computeNominalTelemetryRange(
  model: ControlModel,
  channelId: TelemetryChannelId
): { min: number; max: number } {
  if (channelId === 'uCmd') {
    const lo = Math.min(model.limits.satMin, model.hil.safeClampValue);
    const hi = Math.max(model.limits.satMax, model.hil.safeClampValue);
    const span = Math.max(1e-3, hi - lo);
    return { min: lo - span * 0.08, max: hi + span * 0.08 };
  }
  const refTarget = Math.max(
    Math.abs(model.reference.initialValue),
    Math.abs(model.reference.finalValue)
  );
  if (channelId === 'ref' || channelId === 'y0') {
    if (refTarget > 1e-4) {
      const lo = Math.min(0, model.reference.initialValue, model.reference.finalValue);
      const hi = Math.max(0, model.reference.initialValue, model.reference.finalValue);
      const span = Math.max(refTarget, hi - lo);
      return { min: lo - span * 0.2, max: hi + span * 0.35 };
    }
    return { min: -1, max: 1 };
  }
  const span = refTarget > 1e-4 ? refTarget * 1.2 : 1;
  return { min: -span, max: span };
}

function niceScaleStep(rawStep: number): number {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 0.25;
  const exp = Math.floor(Math.log10(rawStep));
  const pow10 = Math.pow(10, exp);
  const frac = rawStep / pow10;
  const niceFrac =
    frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10;
  return niceFrac * pow10;
}

export function computeTelemetryChannelYScale(
  samples: TelemetryStripSample[],
  channelId: TelemetryChannelId,
  model: ControlModel,
  yDivs: number = 4,
  headroomFraction: number = 0.16
): TelemetryChannelYScale {
  const divs = Math.max(1, yDivs);
  if (samples.length === 0) {
    const nom = computeNominalTelemetryRange(model, channelId);
    const step = niceScaleStep((nom.max - nom.min) / divs);
    const min = Math.floor(nom.min / step) * step;
    const max = Math.ceil(nom.max / step) * step;
    const safeMax = max <= min ? min + step * divs : max;
    return {
      min,
      max: safeMax,
      rawMin: nom.min,
      rawMax: nom.max,
      peakToPeak: nom.max - nom.min,
      perDiv: (safeMax - min) / divs,
    };
  }

  let rawMin = samples[0][channelId];
  let rawMax = samples[0][channelId];
  for (let i = 1; i < samples.length; i++) {
    const v = samples[i][channelId];
    if (v < rawMin) rawMin = v;
    if (v > rawMax) rawMax = v;
  }

  const peakToPeak = Math.max(0, rawMax - rawMin);
  const pad =
    peakToPeak > 1e-6
      ? peakToPeak * headroomFraction
      : Math.max(0.25, Math.abs(rawMax) * 0.25);

  const paddedMin = rawMin - pad;
  const paddedMax = rawMax + pad;
  const step = niceScaleStep((paddedMax - paddedMin) / divs);
  const min = Math.floor(paddedMin / step) * step;
  const max = Math.ceil(paddedMax / step) * step;
  const safeMax = max <= min ? min + step * divs : max;

  return {
    min,
    max: safeMax,
    rawMin,
    rawMax,
    peakToPeak,
    perDiv: (safeMax - min) / divs,
  };
}

export function generateEsp32HilDeserializationCpp(
  model: ControlModel,
  cobsEnabled: boolean
): string {
  const missLimit = Math.max(1, Math.round(model.hil.watchdogMissLimit));
  const dtUs = Math.max(200, Math.round(model.baseDt * 1e6));

  if (cobsEnabled) {
    return `/**
 * @file esp32_hil_rx.hpp
 * @brief ESP32 C++ COBS + CRC-16-CCITT Serial Deserializer for OpenLoop HIL
 *
 * Model    : ${model.name} (${model.id})
 * Protocol : UART Serial + Consistent Overhead Byte Stuffing (COBS, 0x00 delimiter)
 * Payload  : 28 B -> [SOF 0xAA 0x55][SEQ u32 LE][TICK_US u32 LE][4x f32 LE][CRC16 u16 LE]
 * Watchdog : ${missLimit} consecutive missed ticks -> safe clamp (${model.hil.safeClampValue})
 */
#pragma once

#include <Arduino.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>

extern "C" {
#include "ctrl_model.h"
#include "hil_frame.h"
}

struct HilDecodedFrame {
    uint32_t seq;
    uint32_t tick_us;
    float ref;
    float y0;
    float y1;
    float u_host;
    uint16_t crc16;
};

class HilCobsSerialReceiver {
public:
    static constexpr size_t RAW_FRAME_BYTES = 28U;
    static constexpr size_t MAX_COBS_BYTES  = 36U;

    bool pollFrame(Stream &serial, HilDecodedFrame &out_frame) {
        while (serial.available() > 0) {
            const int c = serial.read();
            if (c < 0) { break; }
            const uint8_t byte = static_cast<uint8_t>(c);

            if (byte == 0x00U) {
                const bool valid = (rx_len_ > 0U) && decodeAndVerify(rx_buf_, rx_len_, out_frame);
                rx_len_ = 0U;
                if (valid) { return true; }
            } else if (rx_len_ < MAX_COBS_BYTES) {
                rx_buf_[rx_len_++] = byte;
            } else {
                /* Overrun recovery: discard corrupt partial frame and wait for next 0x00 sync */
                rx_len_ = 0U;
            }
        }
        return false;
    }

    static bool decodeAndVerify(const uint8_t *encoded, size_t len, HilDecodedFrame &out) {
        uint8_t raw[RAW_FRAME_BYTES];
        const size_t decoded_len = hil_cobs_decode(encoded, len, raw, sizeof(raw));
        if (decoded_len != RAW_FRAME_BYTES) { return false; }

        /* Verify big-endian Start-of-Frame marker 0xAA 0x55 */
        if ((raw[0] != 0xAAU) || (raw[1] != 0x55U)) { return false; }

        uint16_t rx_crc = 0U;
        memcpy(&rx_crc, raw + 26U, sizeof(uint16_t));
        const uint16_t calc_crc = hil_crc16_ccitt(raw, 26U);
        if (rx_crc != calc_crc) { return false; }

        memcpy(&out.seq,     raw + 2U,  sizeof(uint32_t));
        memcpy(&out.tick_us, raw + 6U,  sizeof(uint32_t));
        memcpy(&out.ref,     raw + 10U, sizeof(float));
        memcpy(&out.y0,      raw + 14U, sizeof(float));
        memcpy(&out.y1,      raw + 18U, sizeof(float));
        memcpy(&out.u_host,  raw + 22U, sizeof(float));
        out.crc16 = rx_crc;
        return true;
    }

private:
    uint8_t rx_buf_[MAX_COBS_BYTES] = { 0 };
    size_t  rx_len_ = 0U;
};

/* Closed-loop tick integration (call every ${dtUs} us inside deterministic loop) */
inline void hil_closed_loop_cobs_tick(
    Stream &serial,
    HilCobsSerialReceiver &rx,
    CtrlState *ctrl,
    CtrlOutput *ctrl_out,
    uint32_t &consecutive_misses
) {
    static HilDecodedFrame last_frame = { 0U, 0U, 0.0f, 0.0f, 0.0f, 0.0f, 0U };
    HilDecodedFrame fresh;
    const bool got_packet = rx.pollFrame(serial, fresh);
    if (got_packet) {
        last_frame = fresh;
        consecutive_misses = 0U;
    } else if (consecutive_misses < 0xFFFFU) {
        consecutive_misses += 1U;
    }

    CtrlInput in;
    memset(&in, 0, sizeof(in));
    in.ref = last_frame.ref;
    in.meas_state[0] = last_frame.y0;
    if (CTRL_STATE_DIM > 1U) { in.meas_state[1] = last_frame.y1; }
    in.hil_rx_valid = (consecutive_misses < ${missLimit}U);

    ctrl_step(ctrl, &in, ctrl_out);
}
`;
  }

  return `/**
 * @file esp32_hil_rx.hpp
 * @brief ESP32 C++ Raw Binary Serial Deserializer for OpenLoop HIL (COBS Disabled)
 *
 * Model    : ${model.name} (${model.id})
 * Protocol : Raw Unstuffed Binary Serial (SOF 0xAA 0x55 sync, 28 B fixed frame)
 * Watchdog : ${missLimit} consecutive missed ticks -> safe clamp (${model.hil.safeClampValue})
 */
#pragma once

#include <Arduino.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>

extern "C" {
#include "ctrl_model.h"
#include "hil_frame.h"
}

struct HilDecodedFrame {
    uint32_t seq;
    uint32_t tick_us;
    float ref;
    float y0;
    float y1;
    float u_host;
    uint16_t crc16;
};

class HilRawSerialReceiver {
public:
    static constexpr size_t RAW_FRAME_BYTES = 28U;

    bool pollFrame(Stream &serial, HilDecodedFrame &out_frame) {
        while (serial.available() > 0) {
            const int c = serial.read();
            if (c < 0) { break; }
            const uint8_t byte = static_cast<uint8_t>(c);

            if (pos_ == 0U) {
                if (byte == 0xAAU) { buf_[pos_++] = byte; }
            } else if (pos_ == 1U) {
                if (byte == 0x55U) { buf_[pos_++] = byte; }
                else { pos_ = (byte == 0xAAU) ? 1U : 0U; }
            } else {
                buf_[pos_++] = byte;
                if (pos_ >= RAW_FRAME_BYTES) {
                    pos_ = 0U;
                    if (verifyRaw(buf_, out_frame)) { return true; }
                }
            }
        }
        return false;
    }

    static bool verifyRaw(const uint8_t *raw, HilDecodedFrame &out) {
        uint16_t rx_crc = 0U;
        memcpy(&rx_crc, raw + 26U, sizeof(uint16_t));
        if (rx_crc != hil_crc16_ccitt(raw, 26U)) { return false; }

        memcpy(&out.seq,     raw + 2U,  sizeof(uint32_t));
        memcpy(&out.tick_us, raw + 6U,  sizeof(uint32_t));
        memcpy(&out.ref,     raw + 10U, sizeof(float));
        memcpy(&out.y0,      raw + 14U, sizeof(float));
        memcpy(&out.y1,      raw + 18U, sizeof(float));
        memcpy(&out.u_host,  raw + 22U, sizeof(float));
        out.crc16 = rx_crc;
        return true;
    }

private:
    uint8_t buf_[RAW_FRAME_BYTES] = { 0 };
    size_t  pos_ = 0U;
};

/* Closed-loop tick integration (call every ${dtUs} us inside deterministic loop) */
inline void hil_closed_loop_raw_tick(
    Stream &serial,
    HilRawSerialReceiver &rx,
    CtrlState *ctrl,
    CtrlOutput *ctrl_out,
    uint32_t &consecutive_misses
) {
    static HilDecodedFrame last_frame = { 0U, 0U, 0.0f, 0.0f, 0.0f, 0.0f, 0U };
    HilDecodedFrame fresh;
    const bool got_packet = rx.pollFrame(serial, fresh);
    if (got_packet) {
        last_frame = fresh;
        consecutive_misses = 0U;
    } else if (consecutive_misses < 0xFFFFU) {
        consecutive_misses += 1U;
    }

    CtrlInput in;
    memset(&in, 0, sizeof(in));
    in.ref = last_frame.ref;
    in.meas_state[0] = last_frame.y0;
    if (CTRL_STATE_DIM > 1U) { in.meas_state[1] = last_frame.y1; }
    in.hil_rx_valid = (consecutive_misses < ${missLimit}U);

    ctrl_step(ctrl, &in, ctrl_out);
}
`;
}

