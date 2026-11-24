import { describe, expect, it } from 'vitest';
import { PRESET_MODELS } from '../../data/presets';
import { getPlantTemplateById } from '../../data/plantTemplates';
import { discretizeStateSpace } from '../math';
import { generateEmbeddedCode } from '../codegen';
import { runSimulation } from '../simulator';
import {
  analyzeTelemetryChannelWindow,
  buildHilFrameStream,
  cobsDecode,
  cobsEncode,
  computeHilFrameCrc16,
  computeNominalTelemetryRange,
  computeTelemetryChannelYScale,
  createHilPacket,
  encodeHilWireFrameBytes,
  evaluateHilLoopbackDiagnostic,
  extractTelemetryStripSeries,
  generateEsp32HilDeserializationCpp,
  getHilTelemetryChannels,
  HilSerialStreamAccumulator,
  isHilCobsEnabled,
} from '../hil';

describe('HIL COBS Framing & ESP32 C++ Deserialization Boilerplate', () => {
  it('round-trips arbitrary binary payloads containing zero bytes through cobsEncode/cobsDecode', () => {
    const raw = new Uint8Array([0xaa, 0x55, 0x00, 0x01, 0x00, 0x00, 0x42, 0xff, 0x00]);
    const encoded = cobsEncode(raw);
    expect(encoded[encoded.length - 1]).toBe(0x00);
    // Payload segment before final delimiter must contain zero 0x00 bytes
    expect(encoded.slice(0, -1).includes(0x00)).toBe(false);

    const decoded = cobsDecode(encoded);
    expect(decoded).not.toBeNull();
    expect(Array.from(decoded!)).toEqual(Array.from(raw));
  });

  it('toggles wire framing between COBS + 0x00 and raw 28-byte binary frames via hil.cobsEnabled', () => {
    const baseModel = structuredClone(PRESET_MODELS.dcmotor);
    const trace = runSimulation(baseModel);
    const sample = trace.samples[10];

    const cobsModel = {
      ...baseModel,
      hil: { ...baseModel.hil, transport: 'uart_cobs' as const, cobsEnabled: true },
    };
    const rawModel = {
      ...baseModel,
      hil: { ...baseModel.hil, transport: 'uart_cobs' as const, cobsEnabled: false },
    };

    expect(isHilCobsEnabled(cobsModel)).toBe(true);
    expect(isHilCobsEnabled(rawModel)).toBe(false);

    const cobsRes = createHilPacket(cobsModel, sample, 7, 0, {
      jitterMs: 0.5,
      packetDropPct: 0,
      seed: 1,
    });
    expect(cobsRes.packet.byteLength).toBeGreaterThan(28);
    expect(cobsRes.packet.wireHex.endsWith('00')).toBe(true);

    const rawRes = createHilPacket(rawModel, sample, 7, 0, {
      jitterMs: 0.5,
      packetDropPct: 0,
      seed: 1,
    });
    expect(rawRes.packet.byteLength).toBe(28);
    expect(rawRes.packet.wireHex).toBe(rawRes.packet.rawHex);
  });

  it('generates ESP32 C++ deserialization boilerplate for both COBS and Raw Binary modes alongside hil_cobs_decode in hil_frame.h', () => {
    const model = PRESET_MODELS.pendulum;
    const discrete = discretizeStateSpace(
      model.plant,
      model.baseDt,
      model.discretization
    );
    const code = generateEmbeddedCode(model, discrete);
    expect(code.hilHeader).toContain('size_t hil_cobs_decode(');

    const cobsCpp = generateEsp32HilDeserializationCpp(model, true);
    expect(cobsCpp).toContain('class HilCobsSerialReceiver');
    expect(cobsCpp).toContain('hil_cobs_decode(encoded, len, raw, sizeof(raw))');
    expect(cobsCpp).toContain('hil_crc16_ccitt(raw, 26U)');
    expect(cobsCpp).toContain('ctrl_step(ctrl, &in, ctrl_out)');
    expect(cobsCpp).toContain('hil_closed_loop_cobs_tick');

    const rawCpp = generateEsp32HilDeserializationCpp(model, false);
    expect(rawCpp).toContain('class HilRawSerialReceiver');
    expect(rawCpp).toContain('byte == 0xAAU');
    expect(rawCpp).toContain('hil_closed_loop_raw_tick');
    expect(rawCpp).toContain('ctrl_step(ctrl, &in, ctrl_out)');
  });

  it('formats incoming ESP32 serial packets into multi-channel strip telemetry and enforces SAFE_CLAMP values', () => {
    const usModel = getPlantTemplateById('esp32_ultrasonic_hold')!.model;
    const trace = runSimulation(usModel);

    const channels = getHilTelemetryChannels(usModel);
    expect(channels.map((c) => c.id)).toEqual(['ref', 'y0', 'y1', 'uCmd']);
    expect(channels[1].shortLabel).toContain('dist_m');
    expect(channels[3].shortLabel).toContain('pwm_led_pct');

    const packets = buildHilFrameStream(
      usModel,
      trace,
      { jitterMs: 2.5, packetDropPct: 20, seed: 19 },
      64
    );
    expect(packets.length).toBeGreaterThan(32);

    const nominal = packets[0];
    const safeClamped = {
      ...packets[1],
      watchdogState: 'SAFE_CLAMP' as const,
      payloadFloats: [0.25, 0.24, -0.02, 45.0],
    };

    const series = extractTelemetryStripSeries(usModel, [nominal, safeClamped]);
    expect(series).toHaveLength(2);
    expect(series[1].rawUCmd).toBe(45.0);
    expect(series[1].uCmd).toBe(usModel.hil.safeClampValue);
    expect(series[1].ref).toBe(0.25);
    expect(series[1].y0).toBe(0.24);
  });

  it('decodes fragmented Web Serial chunks across both COBS and Raw binary streams and rejects corrupted CRC frames', () => {
    const usModel = structuredClone(getPlantTemplateById('esp32_ultrasonic_hold')!.model);
    const acc = new HilSerialStreamAccumulator();

    // 1. COBS fragmented read chunks
    const cobsModel = {
      ...usModel,
      hil: { ...usModel.hil, transport: 'uart_cobs' as const, cobsEnabled: true },
    };
    const cobsFrame = encodeHilWireFrameBytes(cobsModel, {
      seq: 101,
      tickUs: 250_000,
      ref: 0.35,
      y0: 0.31,
      y1: -0.04,
      uCmd: 42.5,
    });

    const splitA = cobsFrame.slice(0, 11);
    const splitB = cobsFrame.slice(11);
    expect(acc.pushChunk(splitA, cobsModel, true, 1000)).toEqual([]);
    const cobsEvents = acc.pushChunk(splitB, cobsModel, true, 1005);
    expect(cobsEvents).toHaveLength(1);
    expect(cobsEvents[0].ok).toBe(true);
    if (cobsEvents[0].ok) {
      expect(cobsEvents[0].packet.seq).toBe(101);
      expect(cobsEvents[0].packet.tickUs).toBe(250_000);
      expect(cobsEvents[0].packet.payloadFloats[0]).toBeCloseTo(0.35, 5);
      expect(cobsEvents[0].packet.payloadFloats[3]).toBeCloseTo(42.5, 5);
    }

    // 2. Raw 28B binary fragmented read chunks + CRC corruption check
    acc.reset();
    const rawModel = {
      ...usModel,
      hil: { ...usModel.hil, transport: 'uart_cobs' as const, cobsEnabled: false },
    };
    const rawFrame = encodeHilWireFrameBytes(rawModel, {
      seq: 202,
      tickUs: 500_000,
      ref: 0.4,
      y0: 0.39,
      y1: 0.01,
      uCmd: 12.0,
    });
    const corrupted = Uint8Array.from(rawFrame);
    corrupted[15] ^= 0xff;

    const badEvents = acc.pushChunk(corrupted, rawModel, false, 1020);
    expect(badEvents).toHaveLength(1);
    expect(badEvents[0]).toEqual({ ok: false, reason: 'crc' });

    // Immediately recovers on next valid fragmented frame
    expect(acc.pushChunk(rawFrame.slice(0, 14), rawModel, false, 1030)).toEqual([]);
    const okEvents = acc.pushChunk(rawFrame.slice(14), rawModel, false, 1035);
    expect(okEvents).toHaveLength(1);
    expect(okEvents[0].ok).toBe(true);
    if (okEvents[0].ok) {
      expect(okEvents[0].packet.seq).toBe(202);
    }
  });

  it('evaluates HIL loopback integrity verdicts across nominal RTT, budget overrun, and timeout/CRC failure', () => {
    const fields = {
      seq: 77,
      tickUs: 120_000,
      ref: 0.35,
      y0: 0.34,
      y1: 0.0,
      uCmd: 18.2,
    };
    const crc = computeHilFrameCrc16(fields);

    const passDiag = evaluateHilLoopbackDiagnostic({
      id: 1,
      mode: 'webserial',
      targetLabel: 'COM #1 · CP210x',
      cobsEnabled: true,
      txSeq: 77,
      txBytes: 31,
      expectedCrc16: crc,
      budgetMs: 20,
      rttMs: 2.45,
      rxSeq: 77,
      rxBytes: 31,
      rxCrc16: crc,
      crcValid: true,
    });
    expect(passDiag.verdict).toBe('PASS');
    expect(passDiag.payloadMatch).toBe(true);
    expect(passDiag.crcValid).toBe(true);

    const warnDiag = evaluateHilLoopbackDiagnostic({
      id: 2,
      mode: 'webserial',
      targetLabel: 'COM #1 · CP210x',
      cobsEnabled: true,
      txSeq: 78,
      txBytes: 31,
      expectedCrc16: crc,
      budgetMs: 5,
      rttMs: 11.8,
      rxSeq: 79,
      rxBytes: 31,
      rxCrc16: crc,
      crcValid: true,
    });
    expect(warnDiag.verdict).toBe('WARN_LATENCY');
    expect(warnDiag.payloadMatch).toBe(false);

    const failDiag = evaluateHilLoopbackDiagnostic({
      id: 3,
      mode: 'webserial',
      targetLabel: 'COM #1 · CP210x',
      cobsEnabled: true,
      txSeq: 80,
      txBytes: 31,
      expectedCrc16: crc,
      budgetMs: 20,
      rttMs: 1200,
      rxSeq: null,
      rxBytes: 0,
      crcValid: false,
    });
    expect(failDiag.verdict).toBe('FAIL');
    expect(failDiag.crcValid).toBe(false);
  });

  it('detects signal peaks and computes dual-cursor delta metrics for strip chart analysis', () => {
    const samples = [
      { seq: 10, tickUs: 0, simTime: 0.0, ref: 1, y0: 0.0, y1: 0, uCmd: 0, rawUCmd: 0, dropped: false, deadlineMissed: false, watchdogState: 'NOMINAL' as const },
      { seq: 11, tickUs: 50000, simTime: 0.05, ref: 1, y0: 0.8, y1: 0, uCmd: 1, rawUCmd: 1, dropped: false, deadlineMissed: false, watchdogState: 'NOMINAL' as const },
      { seq: 12, tickUs: 100000, simTime: 0.1, ref: 1, y0: 1.4, y1: 0, uCmd: 2, rawUCmd: 2, dropped: false, deadlineMissed: false, watchdogState: 'NOMINAL' as const },
      { seq: 13, tickUs: 150000, simTime: 0.15, ref: 1, y0: 0.7, y1: 0, uCmd: 1, rawUCmd: 1, dropped: false, deadlineMissed: false, watchdogState: 'NOMINAL' as const },
      { seq: 14, tickUs: 200000, simTime: 0.2, ref: 1, y0: 0.5, y1: 0, uCmd: 0.5, rawUCmd: 0.5, dropped: false, deadlineMissed: false, watchdogState: 'NOMINAL' as const },
      { seq: 15, tickUs: 250000, simTime: 0.25, ref: 1, y0: 1.15, y1: 0, uCmd: 1.2, rawUCmd: 1.2, dropped: false, deadlineMissed: false, watchdogState: 'NOMINAL' as const },
      { seq: 16, tickUs: 300000, simTime: 0.3, ref: 1, y0: 0.9, y1: 0, uCmd: 0.8, rawUCmd: 0.8, dropped: false, deadlineMissed: false, watchdogState: 'NOMINAL' as const },
    ];

    const analysis = analyzeTelemetryChannelWindow(samples, 'y0', 12, 15);
    expect(analysis.windowMax?.seq).toBe(12);
    expect(analysis.windowMax?.y0).toBe(1.4);
    expect(analysis.windowMin?.seq).toBe(10);
    expect(analysis.windowPeakToPeak).toBeCloseTo(1.4, 6);
    expect(analysis.localPeaks.map((p) => p.seq)).toEqual([12, 15]);
    expect(analysis.cursorA?.seq).toBe(12);
    expect(analysis.cursorB?.seq).toBe(15);
    expect(analysis.deltaSeq).toBe(3);
    expect(analysis.deltaTimeSec).toBeCloseTo(0.15, 6);
    expect(analysis.frequencyHz).toBeCloseTo(1 / 0.15, 4);
    expect(analysis.deltaValue).toBeCloseTo(-0.25, 6);
    expect(analysis.intervalMin?.seq).toBe(14);
    expect(analysis.intervalMax?.seq).toBe(12);
    expect(analysis.intervalPeakToPeak).toBeCloseTo(0.9, 6);

    // Out-of-range sequences clamp cleanly to window boundaries
    const clamped = analyzeTelemetryChannelWindow(samples, 'y0', 1, 99);
    expect(clamped.cursorA?.seq).toBe(10);
    expect(clamped.cursorB?.seq).toBe(16);
  });

  it('dynamically adjusts Y-axis bounds from incoming signal peak-to-peak amplitude and falls back to model limits when empty', () => {
    const usModel = getPlantTemplateById('esp32_ultrasonic_hold')!.model;

    // 1. Tight low-amplitude ripple (Vpp = 0.02 around 0.31) zooms in with proportional headroom
    const tightSamples = [
      { seq: 1, tickUs: 0, simTime: 0, ref: 0.3, y0: 0.30, y1: 0, uCmd: 20, rawUCmd: 20, dropped: false, deadlineMissed: false, watchdogState: 'NOMINAL' as const },
      { seq: 2, tickUs: 20000, simTime: 0.02, ref: 0.3, y0: 0.32, y1: 0, uCmd: 22, rawUCmd: 22, dropped: false, deadlineMissed: false, watchdogState: 'NOMINAL' as const },
    ];
    const tightScale = computeTelemetryChannelYScale(tightSamples, 'y0', usModel, 4);
    expect(tightScale.peakToPeak).toBeCloseTo(0.02, 6);
    expect(tightScale.min).toBeLessThan(0.30);
    expect(tightScale.max).toBeGreaterThan(0.32);
    expect(tightScale.max - tightScale.min).toBeLessThan(0.1);
    expect(tightScale.perDiv).toBeCloseTo((tightScale.max - tightScale.min) / 4, 8);

    // 2. Large swing (Vpp = 35) expands dynamically to contain both peaks
    const wideSamples = [
      { seq: 3, tickUs: 40000, simTime: 0.04, ref: 0.3, y0: -12, y1: 0, uCmd: 0, rawUCmd: 0, dropped: false, deadlineMissed: false, watchdogState: 'NOMINAL' as const },
      { seq: 4, tickUs: 60000, simTime: 0.06, ref: 0.3, y0: 23, y1: 0, uCmd: 100, rawUCmd: 100, dropped: false, deadlineMissed: false, watchdogState: 'NOMINAL' as const },
    ];
    const wideScale = computeTelemetryChannelYScale(wideSamples, 'y0', usModel, 4);
    expect(wideScale.peakToPeak).toBeCloseTo(35, 6);
    expect(wideScale.min).toBeLessThan(-12);
    expect(wideScale.max).toBeGreaterThan(23);

    // 3. Flat zero-Vpp signal produces valid non-degenerate range
    const flatSamples = [
      { seq: 5, tickUs: 80000, simTime: 0.08, ref: 0.3, y0: 0.35, y1: 0, uCmd: 0, rawUCmd: 0, dropped: false, deadlineMissed: false, watchdogState: 'NOMINAL' as const },
      { seq: 6, tickUs: 100000, simTime: 0.1, ref: 0.3, y0: 0.35, y1: 0, uCmd: 0, rawUCmd: 0, dropped: false, deadlineMissed: false, watchdogState: 'NOMINAL' as const },
    ];
    const flatScale = computeTelemetryChannelYScale(flatSamples, 'y0', usModel, 4);
    expect(flatScale.peakToPeak).toBe(0);
    expect(flatScale.max).toBeGreaterThan(flatScale.min);

    // 4. Empty buffer falls back cleanly to model-calibrated nominal limits
    const nomUCmd = computeNominalTelemetryRange(usModel, 'uCmd');
    expect(nomUCmd.min).toBeLessThanOrEqual(usModel.limits.satMin);
    expect(nomUCmd.max).toBeGreaterThanOrEqual(usModel.limits.satMax);
    const emptyUCmd = computeTelemetryChannelYScale([], 'uCmd', usModel, 4);
    expect(emptyUCmd.max).toBeGreaterThan(emptyUCmd.min);
  });
});
