import { describe, expect, it } from 'vitest';
import { PRESET_MODELS } from '../../data/presets';
import { computeBodeAnalysis } from '../bode';
import { applyTransferFunctionToModel } from '../transferFunction';

describe('computeBodeAnalysis', () => {
  it('computes accurate DC gain, -3 dB bandwidth, and continuous phase for a first-order plant', () => {
    // G(s) = 5 / (s + 5) => DC gain = 1 (0 dB), -3 dB corner at omega = 5 rad/s, phase = -45 deg at w=5
    const { model } = applyTransferFunctionToModel(
      PRESET_MODELS.dcmotor,
      [5],
      [1, 5],
      'First Order Low-Pass'
    );
    const bode = computeBodeAnalysis(model, 0, 'plant', 0);

    expect(bode.points.length).toBeGreaterThan(150);
    expect(bode.dcGainDb).toBeCloseTo(0, 1);
    expect(bode.bandwidthOmega).not.toBeNull();
    expect(bode.bandwidthOmega!).toBeGreaterThan(4.5);
    expect(bode.bandwidthOmega!).toBeLessThan(5.5);

    // Phase must roll monotonically from near 0° down toward -90° without 360° wrapping jumps
    for (let i = 1; i < bode.points.length; i++) {
      expect(Math.abs(bode.points[i].phaseDeg - bode.points[i - 1].phaseDeg)).toBeLessThan(35);
    }
    const lastPt = bode.points[bode.points.length - 1];
    expect(lastPt.phaseDeg).toBeLessThan(-80);
    expect(lastPt.phaseDeg).toBeGreaterThan(-95);
  });

  it('computes open-loop PID margins and identifies generic open-loop RHP unstable plants', () => {
    const dcOpenLoop = computeBodeAnalysis(PRESET_MODELS.dcmotor, 0, 'open_loop', 0);
    expect(dcOpenLoop.margins.gainCrossoverOmega).not.toBeNull();
    expect(dcOpenLoop.margins.phaseMarginDeg).not.toBeNull();
    expect(dcOpenLoop.peakMagDb).toBeGreaterThanOrEqual(dcOpenLoop.dcGainDb);

    // Custom open-loop unstable plant: G(s) = 2 / (s - 3)
    const { model: unstablePlant } = applyTransferFunctionToModel(
      PRESET_MODELS.dcmotor,
      [2],
      [1, -3],
      'Custom Unstable Plant'
    );
    const unstableBode = computeBodeAnalysis(unstablePlant, 0, 'plant', 0);
    expect(unstableBode.margins.closedLoopStableHint).toBe('OPEN_LOOP_UNSTABLE');
  });

  it('supports MIMO channel selection across pendulum outputs without error', () => {
    const out0 = computeBodeAnalysis(PRESET_MODELS.pendulum, 0, 'plant', 0);
    const out1 = computeBodeAnalysis(PRESET_MODELS.pendulum, 1, 'plant', 0);
    expect(out0.points.length).toBe(out1.points.length);
    // Cart position x vs Pendulum angle theta frequency responses must differ
    expect(out0.points[10].magDb).not.toBeCloseTo(out1.points[10].magDb, 2);
  });
});
