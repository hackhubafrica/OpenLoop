import { describe, expect, it } from 'vitest';
import { PRESET_MODELS } from '../../data/presets';
import { computeBodeAnalysis } from '../../engine/bode';
import { serializeModelToToml } from '../../engine/ir';
import { runSimulation } from '../../engine/simulator';
import { validateControlModel } from '../../engine/validator';
import { serializeModelToJson } from '../exportBundle';
import {
  addInputChannel,
  addOutputChannel,
  importModelFromText,
  removeInputChannel,
  removeOutputChannel,
  resizePlantDimensions,
} from '../modelHelpers';

describe('Custom Plant Resizing & JSON/TOML Model Import', () => {
  it('resizes plant dimensions cleanly while preserving overlapping matrices and passing validator', () => {
    const motor = structuredClone(PRESET_MODELS.dcmotor);
    const expanded = resizePlantDimensions(motor, 5, 3);

    expect(expanded.plant.n).toBe(5);
    expect(expanded.plant.p).toBe(3);
    expect(expanded.plant.A.length).toBe(5);
    expect(expanded.plant.A[0].length).toBe(5);
    expect(expanded.plant.B.length).toBe(5);
    expect(expanded.plant.C.length).toBe(3);
    expect(expanded.plant.C[0].length).toBe(5);
    expect(expanded.plant.x0.length).toBe(5);
    expect(expanded.lqrK.length).toBe(5);
    expect(expanded.isCustomModel).toBe(true);

    // Overlapping values remain preserved
    expect(expanded.plant.A[0][0]).toBe(motor.plant.A[0][0]);
    expect(expanded.plant.A[1][1]).toBe(motor.plant.A[1][1]);

    // Validator accepts resized state-space matrices
    const report = validateControlModel(expanded);
    expect(report.valid).toBe(true);

    // Shrinking back clamps pid.targetOutputIndex within bounds
    expanded.pid.targetOutputIndex = 2;
    const shrunk = resizePlantDimensions(expanded, 2, 1);
    expect(shrunk.plant.n).toBe(2);
    expect(shrunk.plant.p).toBe(1);
    expect(shrunk.pid.targetOutputIndex).toBe(0);
    expect(validateControlModel(shrunk).valid).toBe(true);
  });

  it('imports custom JSON snapshots including resized dimensions and custom IDs', () => {
    const custom = resizePlantDimensions(PRESET_MODELS.buck, 3, 2);
    custom.id = 'custom-3phase-buck';
    custom.name = '3-State Custom Converter';
    const jsonText = serializeModelToJson(custom);

    const res = importModelFromText('custom.ctrl.json', jsonText, PRESET_MODELS.pendulum);
    expect(res.error).toBeNull();
    expect(res.format).toBe('json');
    expect(res.model.id).toBe('custom-3phase-buck');
    expect(res.model.plant.n).toBe(3);
    expect(res.model.plant.p).toBe(2);
    expect(res.model.isCustomModel).toBe(true);
    expect(validateControlModel(res.model).valid).toBe(true);
  });

  it('imports custom TOML IR files with updated dimensions and matrices', () => {
    const custom = resizePlantDimensions(PRESET_MODELS.pendulum, 3, 2);
    custom.id = 'custom-toml-plant';
    const tomlText = serializeModelToToml(custom);

    const res = importModelFromText('model.ctrl.toml', tomlText, PRESET_MODELS.pendulum);
    expect(res.error).toBeNull();
    expect(res.format).toBe('toml');
    expect(res.model.id).toBe('custom-toml-plant');
    expect(res.model.plant.n).toBe(3);
    expect(res.model.plant.p).toBe(2);
    expect(validateControlModel(res.model).valid).toBe(true);
  });

  it('rejects malformed or dimension-mismatched import files with clear diagnostics', () => {
    const badJson = JSON.stringify({
      id: 'broken',
      baseDt: 0.01,
      duration: 1,
      lqrK: [1],
      plant: { n: 2, m: 1, p: 1, A: [[1]], B: [[1]], C: [[1]], D: [[0]], x0: [0] },
    });
    const res = importModelFromText('broken.ctrl.json', badJson, PRESET_MODELS.pendulum);
    expect(res.error).not.toBeNull();

    const badToml = `
[model
id = "broken"
`;
    const tomlErr = importModelFromText('broken.ctrl.toml', badToml, PRESET_MODELS.pendulum);
    expect(tomlErr.format).toBe('toml');
    expect(tomlErr.error).toMatch(/Invalid TOML/i);
  });

  it('parses minimal custom hand-authored TOML configurations without relying on fallback A/B/C', () => {
    const customToml = `
[model]
id = "quad-pitch"
name = "Quadrotor Pitch Axis"
base_dt = 0.004
duration = 1.5
discretization = "tustin"

[plant.state_space]
states = ["theta", "omega"]
outputs = ["theta"]
x0 = [0.1, 0.0]
A = [[0.0, 1.0], [-12.0, -3.5]]
B = [[0.0], [18.0]]
C = [[1.0, 0.0]]
D = [[0.0]]

[controller.lqr]
K = [2.4, 0.65]
tracks_ref_state0 = true

[controller.pid]
enabled = true
kp = 1.2
ki = 0.4
kd = 0.08
`;
    const res = importModelFromText('quad.ctrl.toml', customToml, PRESET_MODELS.dcmotor);
    expect(res.error).toBeNull();
    expect(res.format).toBe('toml');
    expect(res.model.id).toBe('quad-pitch');
    expect(res.model.plant.n).toBe(2);
    expect(res.model.plant.p).toBe(1);
    expect(res.model.discretization).toBe('tustin');
    expect(res.model.lqrK).toEqual([2.4, 0.65]);
    expect(validateControlModel(res.model).valid).toBe(true);
  });

  it('dynamically resizes m inputs, adds/removes input & output channels cleanly', () => {
    const base = structuredClone(PRESET_MODELS.pendulum);

    // Resize all dims (n=5, p=4, m=3)
    const resized = resizePlantDimensions(base, 5, 4, 3);
    expect(resized.plant.n).toBe(5);
    expect(resized.plant.m).toBe(3);
    expect(resized.plant.p).toBe(4);
    expect(resized.plant.B.length).toBe(5);
    expect(resized.plant.B[0].length).toBe(3);
    expect(resized.plant.D.length).toBe(4);
    expect(resized.plant.D[0].length).toBe(3);
    expect(resized.plant.inputNames).toHaveLength(3);
    expect(resized.plant.outputNames).toHaveLength(4);
    expect(resized.basePreset).toBe('pendulum');
    expect(resized.isCustomModel).toBe(true);
    expect(validateControlModel(resized).valid).toBe(true);

    // Add input channel up to cap 4
    const withFourIn = addInputChannel(resized);
    expect(withFourIn.plant.m).toBe(4);
    expect(withFourIn.plant.B[0].length).toBe(4);
    expect(addInputChannel(withFourIn).plant.m).toBe(4);

    // Remove a specific middle input column and check column preservation
    withFourIn.plant.B[1][0] = 10;
    withFourIn.plant.B[1][1] = 20;
    withFourIn.plant.B[1][2] = 30;
    withFourIn.plant.B[1][3] = 40;
    const afterRemoveIn = removeInputChannel(withFourIn, 1);
    expect(afterRemoveIn.plant.m).toBe(3);
    expect(afterRemoveIn.plant.B[1]).toEqual([10, 30, 40]);
    expect(afterRemoveIn.plant.D[0].length).toBe(3);

    // Add and remove output channels while clamping pid.targetOutputIndex
    const addedOut = addOutputChannel(PRESET_MODELS.dcmotor);
    expect(addedOut.plant.p).toBe(3);
    expect(addedOut.plant.C.length).toBe(3);
    expect(addedOut.plant.D.length).toBe(3);

    addedOut.pid.targetOutputIndex = 2;
    const removedLastOut = removeOutputChannel(addedOut, 2);
    expect(removedLastOut.plant.p).toBe(2);
    expect(removedLastOut.pid.targetOutputIndex).toBe(1);

    // Cannot remove below MIN_INPUT_DIM=1 or MIN_OUTPUT_DIM=1
    const singleOut = removeOutputChannel(removedLastOut, 0);
    expect(singleOut.plant.p).toBe(1);
    expect(removeOutputChannel(singleOut, 0).plant.p).toBe(1);
    expect(removeInputChannel(PRESET_MODELS.dcmotor, 0).plant.m).toBe(1);

    // TOML round-trip preserves multi-input dimensions and channel names
    afterRemoveIn.plant.inputNames = ['Force X', 'Brake Torque', 'Trim'];
    const toml = serializeModelToToml(afterRemoveIn);
    const reimported = importModelFromText('multi.ctrl.toml', toml, PRESET_MODELS.pendulum);
    expect(reimported.error).toBeNull();
    expect(reimported.model.plant.m).toBe(3);
    expect(reimported.model.plant.inputNames).toEqual([
      'Force X',
      'Brake Torque',
      'Trim',
    ]);
    expect(validateControlModel(reimported.model).valid).toBe(true);
  });

  it('propagates auxiliary input channels through MIMO B/D matrices, Bode analysis, and block labels', () => {
    const mimo = addInputChannel(PRESET_MODELS.dcmotor);
    expect(mimo.plant.m).toBe(2);
    expect(mimo.blocks.find((b) => b.id === 'plant_ss')?.label).toBe('SS Plant (2×2→2)');

    mimo.plant.B[0][1] = 25.0;
    mimo.plant.auxInputs = [0, 2.0];

    const traceWithAux = runSimulation(mimo);
    const traceZeroAux = runSimulation({
      ...mimo,
      plant: { ...mimo.plant, auxInputs: [0, 0] },
    });

    expect(traceWithAux.metrics.rmsError).not.toBeCloseTo(
      traceZeroAux.metrics.rmsError,
      3
    );

    const bodeU1 = computeBodeAnalysis(mimo, 0, 'plant', 1);
    expect(bodeU1.points.length).toBeGreaterThan(100);
    expect(Number.isFinite(bodeU1.points[0].magDb)).toBe(true);
  });
});
