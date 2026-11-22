import { describe, expect, it } from 'vitest';
import { PRESET_MODELS } from '../../data/presets';
import { getPlantTemplateById } from '../../data/plantTemplates';
import {
  computeSDomainSensitivity,
  getModelSensitivityParameters,
} from '../stability';
import { applyTransferFunctionToModel } from '../transferFunction';

describe('S-Domain parameter sensitivity analysis', () => {
  it('extracts physical state-space parameters for presets, templates, and generic TF models', () => {
    const motorParams = getModelSensitivityParameters(PRESET_MODELS.dcmotor);
    expect(motorParams.some((p) => p.id === 'motor_inductance')).toBe(true);
    expect(motorParams.some((p) => p.id === 'motor_resistance')).toBe(true);
    expect(motorParams.some((p) => p.id === 'motor_inertia')).toBe(true);

    const buckParams = getModelSensitivityParameters(PRESET_MODELS.buck);
    expect(buckParams.some((p) => p.id === 'buck_inductance')).toBe(true);
    expect(buckParams.some((p) => p.id === 'buck_capacitance')).toBe(true);
    expect(buckParams.some((p) => p.id === 'buck_load')).toBe(true);

    const pendulumParams = getModelSensitivityParameters(PRESET_MODELS.pendulum);
    expect(pendulumParams.some((p) => p.id === 'pendulum_length')).toBe(true);
    expect(pendulumParams.some((p) => p.id === 'pendulum_mass')).toBe(true);

    const msd = getPlantTemplateById('mass_spring_damper')!.model;
    const msdParams = getModelSensitivityParameters(msd);
    expect(msdParams[0].id).toBe('msd_mass');
    expect(msdParams.some((p) => p.id === 'msd_stiffness')).toBe(true);

    // Custom 3rd-order transfer function falls back cleanly to non-zero A[i,j] matrix entries
    const { model: customTf } = applyTransferFunctionToModel(
      PRESET_MODELS.dcmotor,
      [1],
      [1, 6, 11, 6]
    );
    const tfParams = getModelSensitivityParameters(customTf);
    expect(tfParams.length).toBeGreaterThan(0);
    expect(tfParams.every((p) => p.id.startsWith('A_'))).toBe(true);
  });

  it('tracks open-loop pole shift wrt Mass (m) analytically for Mass-Spring-Damper', () => {
    const msd = getPlantTemplateById('mass_spring_damper')!.model;
    // Nominal m=1, k=16, c=1.2 => omega_n = sqrt(k/m) = 4.0 rad/s, sigma = -c/(2m) = -0.6
    // At alpha = 4.0 (4x mass) => omega_n = sqrt(16/4) = 2.0 rad/s, sigma = -1.2 / 8 = -0.15
    const result = computeSDomainSensitivity(msd, 'msd_mass', {
      scope: 'open',
      minFactor: 0.25,
      maxFactor: 4.0,
      steps: 49,
      activeFactor: 4.0,
    });

    expect(result.branches.length).toBe(2);
    expect(result.nominalMaxRealPart).toBeCloseTo(-0.6, 4);
    expect(result.activePoles[0].re).toBeCloseTo(-0.15, 4);
    expect(result.activePoles[0].naturalFreqRad).toBeCloseTo(2.0, 4);
    expect(result.maxSensitivity).toBeGreaterThan(0.5);

    // Normalized sensitivity sits cleanly in [0, 1]
    for (const branch of result.branches) {
      expect(branch.peakSensitivity).toBeGreaterThan(0);
      for (const pt of branch.points) {
        expect(Number.isFinite(pt.sensitivity)).toBe(true);
        expect(pt.normSensitivity).toBeGreaterThanOrEqual(0);
        expect(pt.normSensitivity).toBeLessThanOrEqual(1);
      }
    }
  });

  it('captures DC motor closed-loop sensitivity and RHP instability onset when increasing inductance', () => {
    // Increasing armature inductance excessively adds phase lag to inner current/velocity loop
    const result = computeSDomainSensitivity(
      PRESET_MODELS.dcmotor,
      'motor_inductance',
      {
        scope: 'closed',
        minFactor: 0.25,
        maxFactor: 6.0,
        steps: 61,
        activeFactor: 1.0,
      }
    );

    expect(result.nominalStable).toBe(true);
    expect(result.activeStable).toBe(true);
    expect(result.branches.length).toBeGreaterThanOrEqual(3);
    expect(result.maxSensitivity).toBeGreaterThan(10);
    // Nominal motor should have contiguous stable span covering 1.0
    expect(result.stableFactorRange.min).not.toBeNull();
    expect(result.stableFactorRange.max).not.toBeNull();
    expect(result.stableFactorRange.min!).toBeLessThanOrEqual(1.0);
    expect(result.stableFactorRange.max!).toBeGreaterThanOrEqual(1.0);
  });
});
