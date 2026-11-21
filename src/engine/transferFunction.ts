import { ControlModel, StateSpaceConfig } from '../types/control';
import { MAX_STATE_DIM, MIN_STATE_DIM } from '../utils/modelHelpers';

export interface TransferFunctionResult {
  A: number[][];
  B: number[][];
  C: number[][];
  D: number[][];
  order: number;
  dcGain: number | null;
  normalizedNum: number[];
  normalizedDen: number[];
}

/**
 * Parses comma- or whitespace-separated polynomial coefficients in descending powers of s.
 */
export function parseCoefficientList(raw: string): {
  coeffs: number[];
  error: string | null;
} {
  const tokens = raw
    .trim()
    .split(/[\s,;]+/)
    .filter(Boolean);

  if (tokens.length === 0) {
    return { coeffs: [], error: 'Enter at least one finite numeric coefficient.' };
  }

  const coeffs: number[] = [];
  for (const tok of tokens) {
    const val = Number(tok);
    if (!Number.isFinite(val)) {
      return { coeffs: [], error: `Invalid numeric coefficient: "${tok}"` };
    }
    coeffs.push(val);
  }

  return { coeffs, error: null };
}

/**
 * Converts a proper SISO rational transfer function N(s) / D(s)
 * (coefficients in descending powers of s) into Controllable Canonical Form (A, B, C, D).
 */
export function transferFunctionToStateSpace(
  rawNum: number[],
  rawDen: number[]
): { result: TransferFunctionResult | null; error: string | null } {
  if (rawDen.length === 0 || rawNum.length === 0) {
    return {
      result: null,
      error: 'Numerator and denominator coefficient lists cannot be empty.',
    };
  }

  // Trim leading near-zero terms from denominator
  let denStart = 0;
  while (denStart < rawDen.length - 1 && Math.abs(rawDen[denStart]) < 1e-14) {
    denStart++;
  }
  const den = rawDen.slice(denStart);
  const lead = den[0];
  if (Math.abs(lead) < 1e-14) {
    return {
      result: null,
      error: 'Denominator leading coefficient cannot be zero.',
    };
  }

  const order = den.length - 1;
  if (order < MIN_STATE_DIM || order > MAX_STATE_DIM) {
    return {
      result: null,
      error: `Denominator degree n=${order} must be between ${MIN_STATE_DIM} and ${MAX_STATE_DIM}.`,
    };
  }

  // Trim leading zeros from numerator
  let numStart = 0;
  while (numStart < rawNum.length - 1 && Math.abs(rawNum[numStart]) < 1e-14) {
    numStart++;
  }
  const num = rawNum.slice(numStart);
  if (num.length > den.length) {
    return {
      result: null,
      error: `Transfer function is improper (num degree ${num.length - 1} > den degree ${order}).`,
    };
  }

  // Normalize to monic denominator: D(s) = s^n + a_{n-1} s^{n-1} + ... + a_0
  const normDen = den.map((v) => v / lead);
  const normNum = num.map((v) => v / lead);

  // Pad numerator on left to length n + 1: [b_n, b_{n-1}, ..., b_0]
  const paddedNum = Array(order + 1 - normNum.length)
    .fill(0)
    .concat(normNum);

  const bn = paddedNum[0]; // Direct feedthrough D = b_n

  // Controllable Canonical Form with state x = [z, z', ..., z^(n-1)]^T:
  // A has superdiagonal 1s and bottom row [-a_0, -a_1, ..., -a_{n-1}]
  const A: number[][] = Array.from({ length: order }, (_, r) =>
    Array.from({ length: order }, (__, c) => {
      if (r < order - 1) return c === r + 1 ? 1 : 0;
      // Bottom row corresponds to descending normDen indices [order .. 1]
      const aCoeff = normDen[order - c];
      return Math.abs(aCoeff) < 1e-14 ? 0 : -aCoeff;
    })
  );

  const B: number[][] = Array.from({ length: order }, (_, r) => [
    r === order - 1 ? 1 : 0,
  ]);

  // C[0][c] = b_c - b_n * a_c, where power c corresponds to paddedNum[order - c]
  const C: number[][] = [
    Array.from({ length: order }, (_, c) => {
      const bCoeff = paddedNum[order - c];
      const aCoeff = normDen[order - c];
      const val = bCoeff - bn * aCoeff;
      return Math.abs(val) < 1e-14 ? 0 : val;
    }),
  ];

  const D: number[][] = [[Math.abs(bn) < 1e-14 ? 0 : bn]];

  const a0 = normDen[order];
  const b0 = paddedNum[order];
  const dcGain = Math.abs(a0) > 1e-12 ? b0 / a0 : null;

  return {
    result: {
      A,
      B,
      C,
      D,
      order,
      dcGain,
      normalizedNum: paddedNum,
      normalizedDen: normDen,
    },
    error: null,
  };
}

/**
 * Formats polynomial coefficients [c_n, ..., c_0] as a readable string in s.
 */
export function formatPolynomial(coeffs: number[]): string {
  const parts: string[] = [];
  const deg = coeffs.length - 1;
  for (let i = 0; i < coeffs.length; i++) {
    const c = coeffs[i];
    if (Math.abs(c) < 1e-10) continue;
    const p = deg - i;
    const absC = Math.abs(c);
    const numStr = Number.isInteger(absC) ? String(absC) : Number(absC.toPrecision(4)).toString();
    const sTerm = p === 0 ? '' : p === 1 ? 's' : `s^${p}`;
    const coeffStr = p > 0 && Math.abs(absC - 1) < 1e-9 ? '' : numStr;
    const term = `${coeffStr}${sTerm}` || '1';
    if (parts.length === 0) {
      parts.push(c < 0 ? `-${term}` : term);
    } else {
      parts.push(c < 0 ? ` - ${term}` : ` + ${term}`);
    }
  }
  return parts.length > 0 ? parts.join('') : '0';
}

/**
 * Applies a converted transfer function into a cloned ControlModel in Controllable Canonical Form.
 */
export function applyTransferFunctionToModel(
  model: ControlModel,
  rawNum: number[],
  rawDen: number[],
  label?: string
): { model: ControlModel; error: string | null } {
  const { result, error } = transferFunctionToStateSpace(rawNum, rawDen);
  if (!result || error) {
    return { model, error: error ?? 'Failed to convert transfer function.' };
  }

  const next = structuredClone(model);
  const n = result.order;

  const plant: StateSpaceConfig = {
    n,
    m: 1,
    p: 1,
    stateNames: Array.from({ length: n }, (_, i) => (i === 0 ? 'y' : `y_d${i}`)),
    stateUnits: Array.from({ length: n }, () => model.plant.outputUnits[0] || 'u'),
    outputNames: [model.plant.outputNames[0] || 'Output (y)'],
    outputUnits: [model.plant.outputUnits[0] || 'u'],
    inputName: model.plant.inputName || 'Input (u)',
    inputUnit: model.plant.inputUnit || 'u',
    inputNames: [model.plant.inputNames?.[0] || model.plant.inputName || 'Input (u)'],
    inputUnits: [model.plant.inputUnits?.[0] || model.plant.inputUnit || 'u'],
    auxInputs: [0],
    A: result.A,
    B: result.B,
    C: result.C,
    D: result.D,
    x0: Array(n).fill(0),
  };

  next.id = label ? label.toLowerCase().replace(/[^a-z0-9]+/g, '_') : `tf_${n}th_order`;
  next.isCustomModel = true;
  next.basePreset = model.basePreset ?? (model.id === 'pendulum' || model.id === 'dcmotor' || model.id === 'buck' ? model.id : 'pendulum');
  next.name = label || `Transfer Function (${n}-State Canonical)`;
  next.subtitle = `Controllable canonical realization of G(s) = (${formatPolynomial(rawNum)}) / (${formatPolynomial(rawDen)})`;
  next.plant = plant;
  next.lqrK = Array(n).fill(0);
  next.lqrTracksRefOnState0 = false;
  next.pid = {
    ...next.pid,
    targetOutputIndex: 0,
    tracksStepRef: true,
  };

  return { model: next, error: null };
}
