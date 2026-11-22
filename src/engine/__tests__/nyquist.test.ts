import { describe, expect, it } from 'vitest';
import { PRESET_MODELS } from '../../data/presets';
import { computeNyquistAnalysis } from '../bode';
import { applyTransferFunctionToModel } from '../transferFunction';

describe('computeNyquistAnalysis', () => {
  it('computes exact gain margin, phase margin, zero encirclements, and sensitivity peak for stable 3rd-order plant', () => {
    // G(s) = 20 / ((s+1)(s+2)(s+4)) => phase crossover at w = sqrt(14), G = -20/90 = -0.2222
    const { model: plant3rd } = applyTransferFunctionToModel(
      PRESET_MODELS.dcmotor,
      [20],
      [1, 7, 14, 8],
      'Nyquist 3rd Order Stable'
    );
    const nyq = computeNyquistAnalysis(plant3rd, 0, 'plant', 0);

    expect(nyq.points.length).toBeGreaterThan(200);
    expect(nyq.openLoopRhpPoles).toBe(0);
    expect(nyq.cwEncirclements).toBe(0);
    expect(nyq.verdict).toBe('STABLE_MARGIN');

    expect(nyq.phaseCrossoverPoint).not.toBeNull();
    expect(nyq.phaseCrossoverPoint!.re).toBeCloseTo(-20 / 90, 2);
    expect(nyq.phaseCrossoverPoint!.linearGainMargin).toBeCloseTo(4.5, 1);
    expect(nyq.margins.gainMarginDb!).toBeCloseTo(20 * Math.log10(4.5), 1);

    expect(nyq.gainCrossoverPoint).not.toBeNull();
    expect(nyq.margins.phaseMarginDeg!).toBeGreaterThan(20);
    expect(nyq.closestPoint).not.toBeNull();
    expect(nyq.closestPoint!.sensitivityPeakMs).toBeCloseTo(
      1 / nyq.closestPoint!.distance,
      6
    );
  });

  it('detects clockwise encirclements of (-1, 0) and negative margins when loop gain exceeds stability limit', () => {
    // G(s) = 200 / ((s+1)(s+2)(s+4)) => crosses negative real axis at -200/90 = -2.222 (left of -1)
    const { model: highGain3rd } = applyTransferFunctionToModel(
      PRESET_MODELS.dcmotor,
      [200],
      [1, 7, 14, 8],
      'Nyquist 3rd Order Unstable'
    );
    const nyq = computeNyquistAnalysis(highGain3rd, 0, 'plant', 0);

    expect(nyq.openLoopRhpPoles).toBe(0);
    expect(nyq.cwEncirclements).toBe(2);
    expect(nyq.margins.gainMarginDb!).toBeLessThan(0);
    expect(nyq.margins.phaseMarginDeg!).toBeLessThan(0);
    expect(nyq.verdict).toBe('UNSTABLE_MARGIN');
  });

  it('identifies open-loop RHP poles on inverted pendulum and evaluates closed PID loop for DC motor', () => {
    const pendNyq = computeNyquistAnalysis(PRESET_MODELS.pendulum, 1, 'plant', 0);
    expect(pendNyq.openLoopRhpPoles).toBe(1);
    expect(pendNyq.verdict).toBe('OPEN_LOOP_RHP');

    const dcLoopNyq = computeNyquistAnalysis(PRESET_MODELS.dcmotor, 0, 'open_loop', 0);
    expect(dcLoopNyq.openLoopRhpPoles).toBe(0);
    expect(dcLoopNyq.cwEncirclements).toBe(0);
    expect(dcLoopNyq.closestPoint).not.toBeNull();
    expect(dcLoopNyq.closestPoint!.distance).toBeGreaterThan(0.1);
  });
});
