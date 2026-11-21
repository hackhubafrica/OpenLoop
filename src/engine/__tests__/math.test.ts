import { describe, expect, it } from 'vitest';
import {
  discretizeStateSpace,
  expm,
  identity,
  matInv,
  matMul,
  matSolve,
  matSub,
} from '../math';
import { runSimulation } from '../simulator';
import { validateControlModel } from '../validator';
import { computeBodeAnalysis } from '../bode';
import { PRESET_MODELS } from '../../data/presets';
import { StateSpaceConfig } from '../../types/control';

function expectMatrixClose(
  actual: number[][],
  expected: number[][],
  tol = 1e-6
) {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i].length).toBe(expected[i].length);
    for (let j = 0; j < expected[i].length; j++) {
      expect(actual[i][j]).toBeCloseTo(expected[i][j], -Math.log10(tol));
    }
  }
}

describe('Dense Matrix Algebra', () => {
  it('computes matrix inverse and satisfies A * A^-1 = I', () => {
    const A = [
      [4, 2, 1],
      [0, 3, -1],
      [2, 1, 5],
    ];
    const invA = matInv(A);
    const prod = matMul(A, invA);
    expectMatrixClose(prod, identity(3), 1e-10);
  });

  it('solves linear system M * X = R accurately via partial pivoting', () => {
    const M = [
      [0, 2, 1],
      [1, -2, -3],
      [-1, 1, 2],
    ];
    const R = [[-8], [0], [3]];
    const X = matSolve(M, R);
    expectMatrixClose(X, [[-4], [-5], [2]], 1e-10);
  });
});

describe('Matrix Exponential (Padé [6/6] Scaling & Squaring)', () => {
  it('evaluates expm(0) = I and expm(I) = e*I', () => {
    const zero2 = [
      [0, 0],
      [0, 0],
    ];
    expectMatrixClose(expm(zero2), identity(2), 1e-12);

    const e = Math.E;
    expectMatrixClose(
      expm(identity(2)),
      [
        [e, 0],
        [0, e],
      ],
      1e-10
    );
  });

  it('matches analytical SO(2) rotation matrix for skew-symmetric generator', () => {
    const theta = Math.PI / 3;
    const skew = [
      [0, -theta],
      [theta, 0],
    ];
    const expected = [
      [Math.cos(theta), -Math.sin(theta)],
      [Math.sin(theta), Math.cos(theta)],
    ];
    expectMatrixClose(expm(skew), expected, 1e-10);
  });

  it('matches analytical undamped harmonic oscillator transition matrix', () => {
    const w = 3.5;
    const t = 0.4;
    const A_dt = [
      [0, t],
      [-w * w * t, 0],
    ];
    const expected = [
      [Math.cos(w * t), Math.sin(w * t) / w],
      [-w * Math.sin(w * t), Math.cos(w * t)],
    ];
    expectMatrixClose(expm(A_dt), expected, 1e-9);
  });
});

describe('ODE Discretization Benchmarks (ZOH & Tustin)', () => {
  it('ZOH matches exact closed-form for 1st-order RC system', () => {
    const a = 4.0;
    const b = 2.5;
    const dt = 0.05;
    const rcPlant: StateSpaceConfig = {
      n: 1,
      m: 1,
      p: 1,
      stateNames: ['v'],
      stateUnits: ['V'],
      outputNames: ['v'],
      outputUnits: ['V'],
      inputName: 'u',
      inputUnit: 'V',
      inputNames: ['u'],
      inputUnits: ['V'],
      A: [[-a]],
      B: [[b]],
      C: [[1]],
      D: [[0]],
      x0: [0],
    };

    const zoh = discretizeStateSpace(rcPlant, dt, 'zoh');
    const expAt = Math.exp(-a * dt);
    const expectedBd = (b / a) * (1 - expAt);

    expect(zoh.Ad[0][0]).toBeCloseTo(expAt, 10);
    expect(zoh.Bd[0][0]).toBeCloseTo(expectedBd, 10);
    expect(zoh.Cd[0][0]).toBe(1);
    expect(zoh.Dd[0][0]).toBe(0);
  });

  it('ZOH matches exact kinematics for double integrator plant', () => {
    const dt = 0.02;
    const doubleInt: StateSpaceConfig = {
      n: 2,
      m: 1,
      p: 1,
      stateNames: ['p', 'v'],
      stateUnits: ['m', 'm/s'],
      outputNames: ['p'],
      outputUnits: ['m'],
      inputName: 'a',
      inputUnit: 'm/s^2',
      inputNames: ['a'],
      inputUnits: ['m/s^2'],
      A: [
        [0, 1],
        [0, 0],
      ],
      B: [[0], [1]],
      C: [[1, 0]],
      D: [[0]],
      x0: [0, 0],
    };

    const zoh = discretizeStateSpace(doubleInt, dt, 'zoh');
    expectMatrixClose(
      zoh.Ad,
      [
        [1, dt],
        [0, 1],
      ],
      1e-11
    );
    expectMatrixClose(zoh.Bd, [[0.5 * dt * dt], [dt]], 1e-11);
  });

  it('Tustin matches exact bilinear pole transform for 1st-order system', () => {
    const a = 10.0;
    const b = 5.0;
    const dt = 0.02;
    const plant: StateSpaceConfig = {
      n: 1,
      m: 1,
      p: 1,
      stateNames: ['x'],
      stateUnits: ['u'],
      outputNames: ['y'],
      outputUnits: ['u'],
      inputName: 'u',
      inputUnit: 'u',
      inputNames: ['u'],
      inputUnits: ['u'],
      A: [[-a]],
      B: [[b]],
      C: [[1]],
      D: [[0]],
      x0: [0],
    };

    const tustin = discretizeStateSpace(plant, dt, 'tustin');
    const expectedAd = (1 - 0.5 * a * dt) / (1 + 0.5 * a * dt);
    expect(tustin.Ad[0][0]).toBeCloseTo(expectedAd, 10);

    // Verify exact DC gain preservation: Cd * (I - Ad)^-1 * Bd + Dd == b / a
    const dcGain =
      (tustin.Cd[0][0] * tustin.Bd[0][0]) / (1 - tustin.Ad[0][0]) +
      tustin.Dd[0][0];
    expect(dcGain).toBeCloseTo(b / a, 10);
  });

  it('preserves DC gain & stability radius across ZOH and Tustin for DC Motor & Buck Converter', () => {
    for (const presetId of ['dcmotor', 'buck'] as const) {
      const model = PRESET_MODELS[presetId];
      const { A, B, C, D, n } = model.plant;

      // Continuous DC gain: -C * A^-1 * B + D
      const invA = matInv(A);
      const contDc = matSub(D, matMul(C, matMul(invA, B)));

      for (const method of ['zoh', 'tustin'] as const) {
        const disc = discretizeStateSpace(model.plant, model.baseDt, method);
        expect(disc.spectralRadius).toBeLessThan(1.0);

        const I_minus_Ad = matSub(identity(n), disc.Ad);
        const invIAd = matInv(I_minus_Ad);
        const discDc = matMul(disc.Cd, matMul(invIAd, disc.Bd)).map((row, i) =>
          row.map((v, j) => v + disc.Dd[i][j])
        );

        expectMatrixClose(discDc, contDc, 1e-6);
      }
    }
  });
});

describe('Closed-Loop MIL/SIL Simulation & Graph Validation', () => {
  it('stabilizes inverted pendulum and tracks reference step cleanly', () => {
    const model = structuredClone(PRESET_MODELS.pendulum);
    const trace = runSimulation(model);
    const last = trace.samples[trace.samples.length - 1];

    // Cart reaches 0.5m target and pendulum stays upright near 0 rad
    expect(last.silOutputs[0]).toBeCloseTo(0.5, 1);
    expect(Math.abs(last.silOutputs[1])).toBeLessThan(0.02);
    expect(Math.abs(last.milOutputs[0] - last.silOutputs[0])).toBeLessThan(0.05);
  });

  it('keeps MIL (RK4) and SIL (fixed-step) closely aligned on DC Motor & Buck presets', () => {
    const motorTrace = runSimulation(structuredClone(PRESET_MODELS.dcmotor));
    const motorLast = motorTrace.samples[motorTrace.samples.length - 1];
    expect(motorLast.silOutputs[0]).toBeCloseTo(40.0, 0);
    expect(Math.abs(motorLast.milOutputs[0] - motorLast.silOutputs[0])).toBeLessThan(0.25);

    const buckTrace = runSimulation(structuredClone(PRESET_MODELS.buck));
    const buckLast = buckTrace.samples[buckTrace.samples.length - 1];
    expect(buckLast.silOutputs[0]).toBeCloseTo(5.0, 1);
    expect(Math.abs(buckLast.milOutputs[0] - buckLast.silOutputs[0])).toBeLessThan(0.05);
  });

  it('validates all benchmark presets and catches injected algebraic loops', () => {
    for (const preset of Object.values(PRESET_MODELS)) {
      const report = validateControlModel(preset);
      expect(report.valid).toBe(true);
      expect(report.issues.length).toBe(0);
    }

    const looped = structuredClone(PRESET_MODELS.pendulum);
    looped.injectAlgebraicLoopTest = true;
    const loopReport = validateControlModel(looped);
    expect(loopReport.valid).toBe(false);
    expect(loopReport.issues.some((i) => i.code === 'ALGEBRAIC_LOOP')).toBe(true);
  });
});

describe('Numerical Stability & Stiff System Benchmarks', () => {
  it('maintains accuracy and unit-disk stability on stiff eigenvalues (||A*dt|| = 25)', () => {
    const dt = 0.05;
    const stiffPlant: StateSpaceConfig = {
      n: 2,
      m: 1,
      p: 2,
      stateNames: ['fast', 'slow'],
      stateUnits: ['u', 'u'],
      outputNames: ['fast', 'slow'],
      outputUnits: ['u', 'u'],
      inputName: 'u',
      inputUnit: 'u',
      inputNames: ['u'],
      inputUnits: ['u'],
      A: [
        [-500.0, 0.0],
        [0.0, -0.5],
      ],
      B: [[500.0], [0.5]],
      C: identity(2),
      D: [[0], [0]],
      x0: [0, 0],
    };

    // Forward Euler would diverge (|1 - 500*0.05| = 24), while ZOH & Tustin remain A-stable
    const zoh = discretizeStateSpace(stiffPlant, dt, 'zoh');
    expect(zoh.Ad[0][0]).toBeCloseTo(Math.exp(-25.0), 10);
    expect(zoh.Ad[1][1]).toBeCloseTo(Math.exp(-0.025), 10);
    expect(zoh.spectralRadius).toBeLessThan(1.0);

    const tustin = discretizeStateSpace(stiffPlant, dt, 'tustin');
    expect(tustin.Ad[0][0]).toBeCloseTo((1 - 12.5) / (1 + 12.5), 10);
    expect(tustin.Ad[1][1]).toBeCloseTo((1 - 0.0125) / (1 + 0.0125), 10);
    expect(tustin.spectralRadius).toBeLessThan(1.0);
  });

  it('distinguishes open-loop unstable pendulum poles from closed-loop stabilization', () => {
    const pendulum = PRESET_MODELS.pendulum;
    const openLoopDisc = discretizeStateSpace(pendulum.plant, pendulum.baseDt, 'zoh');
    // Inverted pendulum has an unstable right-half-plane pole => spectral radius > 1
    expect(openLoopDisc.spectralRadius).toBeGreaterThan(1.0);

    // Closed-loop simulation must remain bounded without NaN/Inf divergence
    const trace = runSimulation(structuredClone(pendulum));
    for (const sample of trace.samples) {
      expect(Number.isFinite(sample.silOutputs[0])).toBe(true);
      expect(Number.isFinite(sample.silOutputs[1])).toBe(true);
      expect(Math.abs(sample.silOutputs[1])).toBeLessThan(0.5);
    }
  });

  it('computes exact 1st-order cutoff (-3.01 dB, -45°) and positive margins for DC Motor Bode response', () => {
    const motor = structuredClone(PRESET_MODELS.dcmotor);
    // Replace plant temporarily with normalized 1st-order G(s) = 10 / (s + 10)
    const rcModel = structuredClone(motor);
    rcModel.plant = {
      ...motor.plant,
      n: 1,
      m: 1,
      p: 1,
      A: [[-10]],
      B: [[10]],
      C: [[1]],
      D: [[0]],
      x0: [0],
    };
    const bodeRc = computeBodeAnalysis(rcModel, 0, 'plant');
    // Find nearest point to omega = 10 rad/s
    const nearest = bodeRc.points.reduce((best, p) =>
      Math.abs(p.omega - 10) < Math.abs(best.omega - 10) ? p : best
    );
    const exactMagDb = 20 * Math.log10(10 / Math.hypot(nearest.omega, 10));
    const exactPhaseDeg = -(Math.atan(nearest.omega / 10) * 180) / Math.PI;
    expect(nearest.magDb).toBeCloseTo(exactMagDb, 10);
    expect(nearest.phaseDeg).toBeCloseTo(exactPhaseDeg, 10);

    // Full DC Motor open-loop should report positive Phase Margin
    const motorBode = computeBodeAnalysis(motor, 0, 'open_loop');
    expect(motorBode.margins.phaseMarginDeg).not.toBeNull();
    expect(motorBode.margins.phaseMarginDeg!).toBeGreaterThan(20);
  });

  it('tracks computeTimePerIterationUs, stepIndex, and dimensional FLOPs per iteration in simulation metrics', () => {
    const model = structuredClone(PRESET_MODELS.pendulum);
    const trace = runSimulation(model);

    expect(Number.isFinite(trace.metrics.computeTimePerIterationUs)).toBe(true);
    expect(trace.metrics.computeTimePerIterationUs).toBeGreaterThanOrEqual(0);
    expect(trace.metrics.executedSteps).toBe(Math.round(model.duration / model.baseDt) + 1);
    expect(trace.samples[0].stepIndex).toBe(0);
    expect(trace.samples[trace.samples.length - 1].stepIndex).toBe(trace.metrics.executedSteps - 1);

    // 4-state pendulum with PID enabled executes 98 discrete SIL FLOPs/iter
    expect(trace.metrics.flopsPerIteration).toBe(98);

    // Disabling PID reduces FLOPs/iter by 16
    const noPid = structuredClone(model);
    noPid.pid.enabled = false;
    const noPidTrace = runSimulation(noPid);
    expect(noPidTrace.metrics.flopsPerIteration).toBe(82);
  });
});

