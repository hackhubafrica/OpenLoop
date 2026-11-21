import { describe, expect, it } from 'vitest';
import {
  discretizeStateSpace,
  expm,
  identity,
  matAdd,
  matInv,
  matMul,
  matScale,
  matSub,
  matVecMul,
  zeros,
} from './math';
import { StateSpaceConfig } from '../types/control';

function expectMatrixClose(
  actual: number[][],
  expected: number[][],
  decimals = 8
) {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i].length).toBe(expected[i].length);
    for (let j = 0; j < expected[i].length; j++) {
      expect(actual[i][j]).toBeCloseTo(expected[i][j], decimals);
    }
  }
}

describe('State-Space Matrix Multiplication & Algebra', () => {
  it('computes rectangular matrix multiplication A(2x3) * B(3x2) accurately', () => {
    const A = [
      [1, 2, -1],
      [0, 3, 4],
    ];
    const B = [
      [2, -1],
      [1, 5],
      [-2, 3],
    ];
    const expected = [
      [6, 6],
      [-5, 27],
    ];
    expectMatrixClose(matMul(A, B), expected, 12);
  });

  it('satisfies associativity (A*B)*C == A*(B*C) and identity preservation', () => {
    const A = [
      [0, 1, 0],
      [-4, -1.2, 2],
      [0.5, 0, -3],
    ];
    const B = [
      [2, 0],
      [-1, 3],
      [4, -2],
    ];
    const C = [
      [1, 0.5, -1],
      [2, 1.5, 0],
    ];

    const left = matMul(matMul(A, B), C);
    const right = matMul(A, matMul(B, C));
    expectMatrixClose(left, right, 10);

    expectMatrixClose(matMul(identity(3), A), A, 12);
    expectMatrixClose(matMul(A, identity(3)), A, 12);
    expectMatrixClose(matMul(zeros(3, 3), A), zeros(3, 3), 12);
  });

  it('computes discrete state-space step x[k+1] = A*x[k] + B*u[k] via matVecMul', () => {
    const A = [
      [0.95, 0.02],
      [-0.1, 0.9],
    ];
    const B = [[0.002], [0.05]];
    const x = [1.5, -0.4];
    const u = [2.0];

    const Ax = matVecMul(A, x);
    const Bu = matVecMul(B, u);
    const xNext = Ax.map((v, i) => v + Bu[i]);

    expect(xNext[0]).toBeCloseTo(0.95 * 1.5 + 0.02 * -0.4 + 0.002 * 2.0, 12);
    expect(xNext[1]).toBeCloseTo(-0.1 * 1.5 + 0.9 * -0.4 + 0.05 * 2.0, 12);
  });
});

describe('ZOH Discretization Theoretical Accuracy', () => {
  it('matches exact analytical ZOH solution for a damped harmonic oscillator', () => {
    // x_dot = [[0, 1], [-w^2, -2*zeta*w]] x + [[0], [w^2]] u
    const wn = 4.0;
    const zeta = 0.25;
    const dt = 0.02;
    const wd = wn * Math.sqrt(1 - zeta * zeta);
    const sigma = zeta * wn;
    const decay = Math.exp(-sigma * dt);

    const plant: StateSpaceConfig = {
      n: 2,
      m: 1,
      p: 1,
      stateNames: ['x', 'v'],
      stateUnits: ['m', 'm/s'],
      outputNames: ['x'],
      outputUnits: ['m'],
      inputName: 'u',
      inputUnit: 'm',
      inputNames: ['u'],
      inputUnits: ['m'],
      A: [
        [0, 1],
        [-wn * wn, -2 * zeta * wn],
      ],
      B: [[0], [wn * wn]],
      C: [[1, 0]],
      D: [[0]],
      x0: [0, 0],
    };

    const zoh = discretizeStateSpace(plant, dt, 'zoh');

    // Exact transition matrix e^(A*dt)
    const cosWd = Math.cos(wd * dt);
    const sinWd = Math.sin(wd * dt);
    const expectedAd = [
      [
        decay * (cosWd + (sigma / wd) * sinWd),
        decay * (sinWd / wd),
      ],
      [
        -decay * ((wn * wn) / wd) * sinWd,
        decay * (cosWd - (sigma / wd) * sinWd),
      ],
    ];

    // Exact Bd = A^-1 * (Ad - I) * B
    const expectedBd = matMul(
      matInv(plant.A),
      matMul(matSub(expectedAd, identity(2)), plant.B)
    );

    expectMatrixClose(zoh.Ad, expectedAd, 10);
    expectMatrixClose(zoh.Bd, expectedBd, 10);
    expectMatrixClose(zoh.Cd, plant.C, 12);
    expectMatrixClose(zoh.Dd, plant.D, 12);
  });

  it('matches exact ZOH for a decoupled 2-input 2-state MIMO system', () => {
    const dt = 0.05;
    const plant: StateSpaceConfig = {
      n: 2,
      m: 2,
      p: 2,
      stateNames: ['x1', 'x2'],
      stateUnits: ['u', 'u'],
      outputNames: ['y1', 'y2'],
      outputUnits: ['u', 'u'],
      inputName: 'u',
      inputUnit: 'u',
      inputNames: ['u1', 'u2'],
      inputUnits: ['u', 'u'],
      A: [
        [-2, 0],
        [0, -5],
      ],
      B: [
        [4, 0],
        [0, 10],
      ],
      C: identity(2),
      D: [
        [0.5, 0],
        [0, -0.2],
      ],
      x0: [0, 0],
    };

    const zoh = discretizeStateSpace(plant, dt, 'zoh');
    expectMatrixClose(
      zoh.Ad,
      [
        [Math.exp(-0.1), 0],
        [0, Math.exp(-0.25)],
      ],
      10
    );
    expectMatrixClose(
      zoh.Bd,
      [
        [(4 / 2) * (1 - Math.exp(-0.1)), 0],
        [0, (10 / 5) * (1 - Math.exp(-0.25))],
      ],
      10
    );
    expectMatrixClose(zoh.Dd, plant.D, 12);
  });
});

describe('Tustin (Bilinear) Discretization Theoretical Accuracy', () => {
  it('matches exact bilinear matrix identities Ad, Bd, Cd, Dd for non-zero D feedthrough', () => {
    const dt = 0.01;
    const plant: StateSpaceConfig = {
      n: 2,
      m: 1,
      p: 1,
      stateNames: ['x1', 'x2'],
      stateUnits: ['u', 'u'],
      outputNames: ['y'],
      outputUnits: ['u'],
      inputName: 'u',
      inputUnit: 'u',
      inputNames: ['u'],
      inputUnits: ['u'],
      A: [
        [-3, 1],
        [-2, -4],
      ],
      B: [[1], [2]],
      C: [[2, -1]],
      D: [[0.25]],
      x0: [0, 0],
    };

    const tustin = discretizeStateSpace(plant, dt, 'tustin');

    const I = identity(2);
    const halfAdt = matScale(plant.A, 0.5 * dt);
    const invMinus = matInv(matSub(I, halfAdt));
    const expectedAd = matMul(matAdd(I, halfAdt), invMinus);
    const expectedBd = matScale(matMul(invMinus, plant.B), dt);
    const expectedCd = matMul(plant.C, invMinus);
    const expectedDd = matAdd(
      plant.D,
      matScale(matMul(plant.C, matMul(invMinus, plant.B)), 0.5 * dt)
    );

    expectMatrixClose(tustin.Ad, expectedAd, 12);
    expectMatrixClose(tustin.Bd, expectedBd, 12);
    expectMatrixClose(tustin.Cd, expectedCd, 12);
    expectMatrixClose(tustin.Dd, expectedDd, 12);
  });

  it('preserves continuous DC gain and imaginary-axis unit-circle mapping under Tustin', () => {
    // Undamped integrator/oscillator eigenvalues on j*omega axis map onto |z| = 1
    const wn = 10;
    const dt = 0.01;
    const osc: StateSpaceConfig = {
      n: 2,
      m: 1,
      p: 1,
      stateNames: ['x', 'v'],
      stateUnits: ['m', 'm/s'],
      outputNames: ['x'],
      outputUnits: ['m'],
      inputName: 'u',
      inputUnit: 'm',
      inputNames: ['u'],
      inputUnits: ['m'],
      A: [
        [0, 1],
        [-wn * wn, 0],
      ],
      B: [[0], [wn * wn]],
      C: [[1, 0]],
      D: [[0]],
      x0: [0, 0],
    };

    const tustin = discretizeStateSpace(osc, dt, 'tustin');
    // For lossless oscillator, Tustin maps j*wn -> e^(j*theta) with |z| == 1:
    // Complex-conjugate eigenvalues have |lambda|^2 = det(Ad) == 1 and
    // cos(theta) = tr(Ad)/2 == (1 - (wn*dt/2)^2) / (1 + (wn*dt/2)^2)
    const detAd =
      tustin.Ad[0][0] * tustin.Ad[1][1] - tustin.Ad[0][1] * tustin.Ad[1][0];
    const traceAd = tustin.Ad[0][0] + tustin.Ad[1][1];
    const discriminant = traceAd * traceAd - 4 * detAd;
    const expectedCosTheta =
      (1 - Math.pow(0.5 * wn * dt, 2)) / (1 + Math.pow(0.5 * wn * dt, 2));

    expect(detAd).toBeCloseTo(1.0, 12);
    expect(discriminant).toBeLessThan(0);
    expect(Math.sqrt(detAd)).toBeCloseTo(1.0, 12);
    expect(traceAd / 2).toBeCloseTo(expectedCosTheta, 12);

    // DC gain check: Cd * (I - Ad)^-1 * Bd + Dd == -C * A^-1 * B + D == 1
    const invIminusAd = matInv(matSub(identity(2), tustin.Ad));
    const dcDiscrete =
      matMul(tustin.Cd, matMul(invIminusAd, tustin.Bd))[0][0] + tustin.Dd[0][0];
    expect(dcDiscrete).toBeCloseTo(1.0, 10);

    // Verify expm agrees with ZOH for the same lossless oscillator
    const zoh = discretizeStateSpace(osc, dt, 'zoh');
    expectMatrixClose(zoh.Ad, expm(matScale(osc.A, dt)), 11);
  });
});
