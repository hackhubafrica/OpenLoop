import { describe, expect, it } from 'vitest';
import { PRESET_MODELS } from '../../data/presets';
import { discretizeStateSpace } from '../math';
import { generateEmbeddedCode } from '../codegen';
import { runSimulation } from '../simulator';
import {
  cobsDecode,
  cobsEncode,
  createHilPacket,
  generateEsp32HilDeserializationCpp,
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
});
