import { describe, expect, it } from 'vitest';
import { PRESET_MODELS } from '../../data/presets';
import { discretizeStateSpace } from '../../engine/math';
import { computeRootLocus } from '../../engine/stability';
import {
  buildPresetZipEntries,
  buildZipBytes,
  crc32,
  serializeModelToJson,
} from '../exportBundle';
import { buildSystemAnalysisPdf } from '../exportPdfReport';

describe('Preset ZIP Packaging & Export Utilities', () => {
  it('packages model JSON/TOML configuration alongside C99/Rust headers and toolchain manifests', () => {
    const model = PRESET_MODELS.pendulum;
    const discrete = discretizeStateSpace(
      model.plant,
      model.baseDt,
      model.discretization
    );

    const entries = buildPresetZipEntries(model, discrete);
    const names = entries.map((e) => e.name);

    expect(names).toEqual([
      'openloop-pendulum/model.ctrl.json',
      'openloop-pendulum/model.ctrl.toml',
      'openloop-pendulum/include/ctrl_model.h',
      'openloop-pendulum/include/hil_frame.h',
      'openloop-pendulum/src/ctrl_model.c',
      'openloop-pendulum/c99/CMakeLists.txt',
      'openloop-pendulum/rust/Cargo.toml',
      'openloop-pendulum/rust/src/lib.rs',
      'openloop-pendulum/README.md',
    ]);

    const jsonEntry = entries.find((e) => e.name.endsWith('model.ctrl.json'));
    expect(jsonEntry?.content.endsWith('\n')).toBe(true);
    const parsedJson = JSON.parse(jsonEntry!.content);
    expect(parsedJson.id).toBe('pendulum');
    expect(parsedJson.schemaVersion).toBe('1.0');

    const cHeader = entries.find((e) => e.name.endsWith('ctrl_model.h'));
    expect(cHeader?.content).toContain('#ifndef OPENLOOP_PENDULUM_CTRL_H');
    expect(cHeader?.content).toContain('void ctrl_step(');

    const rustLib = entries.find((e) => e.name.endsWith('src/lib.rs'));
    expect(rustLib?.content).toContain('#![no_std]');
    expect(rustLib?.content).toContain('#[repr(C)]');
  });

  it('produces a valid PKZIP binary stream with matching CRC-32 and EOCD record', () => {
    const model = PRESET_MODELS.dcmotor;
    const discrete = discretizeStateSpace(
      model.plant,
      model.baseDt,
      model.discretization
    );

    const entries = buildPresetZipEntries(model, discrete);
    const zipBytes = buildZipBytes(entries);
    const view = new DataView(
      zipBytes.buffer,
      zipBytes.byteOffset,
      zipBytes.byteLength
    );

    // Local file header signature at offset 0: 0x04034b50 ("PK\x03\x04")
    expect(view.getUint32(0, true)).toBe(0x04034b50);

    // End of Central Directory (last 22 bytes): 0x06054b50 ("PK\x05\x06")
    const eocdOffset = zipBytes.length - 22;
    expect(view.getUint32(eocdOffset, true)).toBe(0x06054b50);
    expect(view.getUint16(eocdOffset + 8, true)).toBe(entries.length);
    expect(view.getUint16(eocdOffset + 10, true)).toBe(entries.length);

    // Verify first entry CRC-32 matches computed CRC-32
    const encoder = new TextEncoder();
    const expectedFirstCrc = crc32(encoder.encode(entries[0].content));
    expect(view.getUint32(14, true)).toBe(expectedFirstCrc);
  });

  it('serializes JSON cleanly across all benchmark presets with trailing newline', () => {
    for (const preset of Object.values(PRESET_MODELS)) {
      const json = serializeModelToJson(preset);
      expect(json.endsWith('\n')).toBe(true);
      const parsed = JSON.parse(json);
      expect(parsed.id).toBe(preset.id);
      expect(parsed.baseDt).toBe(preset.baseDt);
    }
  });

  it('compiles a valid multi-page PDF document containing stability metrics, s-plane vector plot, and LaTeX report', () => {
    const model = PRESET_MODELS.pendulum;
    const rl = computeRootLocus(model, 1, 0, 40);

    const openPdf = buildSystemAnalysisPdf({
      model,
      scope: 'open',
      outputIndex: 1,
      inputIndex: 0,
      rootLocus: rl,
    });
    const closedPdf = buildSystemAnalysisPdf({
      model,
      scope: 'closed',
      outputIndex: 1,
      inputIndex: 0,
    });

    expect(openPdf.filename).toBe('pendulum_analysis_report.pdf');
    expect(openPdf.bytes.length).toBeGreaterThan(2500);
    expect(openPdf.doc.getNumberOfPages()).toBeGreaterThanOrEqual(2);

    const header = new TextDecoder('ascii').decode(openPdf.bytes.slice(0, 7));
    expect(header).toBe('%PDF-1.');

    const fullText = new TextDecoder('latin1').decode(openPdf.bytes);
    expect(fullText).toContain('Stability Metrics Panel');
    expect(fullText).toContain('s-Plane Pole-Zero Visualization');
    expect(fullText).toContain('Compiled LaTeX Report Snippet');

    expect(closedPdf.bytes.length).toBeGreaterThan(2500);
    expect(closedPdf.doc.getNumberOfPages()).toBeGreaterThanOrEqual(2);
  });
});
