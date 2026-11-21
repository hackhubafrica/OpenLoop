import { ControlModel, StateSpaceConfig } from '../types/control';
import { discretizeStateSpace } from './math';

export interface ComplexPoleZero {
  re: number;
  im: number;
  mag: number;
  naturalFreqRad: number;
  dampingRatio: number | null; // Defined for continuous s-plane poles/zeros with mag > 0
  stable: boolean;
  marginal: boolean;
  kind: 'pole' | 'zero';
  source?: 'plant' | 'pid';
}

export type StabilityVerdict = 'STABLE' | 'MARGINAL' | 'UNSTABLE';

export interface PoleZeroAnalysis {
  openLoopPoles: ComplexPoleZero[];
  closedLoopPoles: ComplexPoleZero[];
  discretePoles: ComplexPoleZero[];
  plantZeros: ComplexPoleZero[];
  pidZeros: ComplexPoleZero[];
  openLoopVerdict: StabilityVerdict;
  closedLoopVerdict: StabilityVerdict;
  discreteVerdict: StabilityVerdict;
  maxRealPartOpen: number;
  maxRealPartClosed: number;
  maxDiscreteMag: number;
}

const TOL = 1e-6;

function classifyContinuous(poles: ComplexPoleZero[]): {
  verdict: StabilityVerdict;
  maxReal: number;
} {
  if (poles.length === 0) return { verdict: 'MARGINAL', maxReal: 0 };
  const maxReal = Math.max(...poles.map((p) => p.re));
  if (maxReal > TOL) return { verdict: 'UNSTABLE', maxReal };
  if (maxReal >= -TOL) return { verdict: 'MARGINAL', maxReal };
  return { verdict: 'STABLE', maxReal };
}

function classifyDiscrete(poles: ComplexPoleZero[]): {
  verdict: StabilityVerdict;
  maxMag: number;
} {
  if (poles.length === 0) return { verdict: 'MARGINAL', maxMag: 0 };
  const maxMag = Math.max(...poles.map((p) => p.mag));
  if (maxMag > 1 + TOL) return { verdict: 'UNSTABLE', maxMag };
  if (maxMag >= 1 - TOL) return { verdict: 'MARGINAL', maxMag };
  return { verdict: 'STABLE', maxMag };
}

function makeContinuousEntry(
  re: number,
  im: number,
  kind: 'pole' | 'zero',
  source: 'plant' | 'pid' = 'plant'
): ComplexPoleZero {
  const cleanRe = Math.abs(re) < 1e-11 ? 0 : re;
  const cleanIm = Math.abs(im) < 1e-11 ? 0 : im;
  const mag = Math.hypot(cleanRe, cleanIm);
  return {
    re: cleanRe,
    im: cleanIm,
    mag,
    naturalFreqRad: mag,
    dampingRatio: mag > 1e-9 ? -cleanRe / mag : null,
    stable: cleanRe < -TOL,
    marginal: Math.abs(cleanRe) <= TOL,
    kind,
    source,
  };
}

function makeDiscreteEntry(re: number, im: number): ComplexPoleZero {
  const cleanRe = Math.abs(re) < 1e-11 ? 0 : re;
  const cleanIm = Math.abs(im) < 1e-11 ? 0 : im;
  const mag = Math.hypot(cleanRe, cleanIm);
  return {
    re: cleanRe,
    im: cleanIm,
    mag,
    naturalFreqRad: mag,
    dampingRatio: null,
    stable: mag < 1 - TOL,
    marginal: Math.abs(mag - 1) <= TOL,
    kind: 'pole',
  };
}

/**
 * Reduces a real n x n matrix M to upper Hessenberg form in-place via Householder reflections.
 */
function toUpperHessenberg(M: number[][]): number[][] {
  const n = M.length;
  const H = M.map((r) => [...r]);
  for (let k = 0; k <= n - 3; k++) {
    let normSq = 0;
    for (let i = k + 1; i < n; i++) normSq += H[i][k] * H[i][k];
    const norm = Math.sqrt(normSq);
    if (norm < 1e-15) continue;

    const alpha = H[k + 1][k] >= 0 ? -norm : norm;
    const vLen = n - (k + 1);
    const v = new Array<number>(vLen);
    v[0] = H[k + 1][k] - alpha;
    for (let i = 1; i < vLen; i++) v[i] = H[k + 1 + i][k];

    let vNormSq = 0;
    for (let i = 0; i < vLen; i++) vNormSq += v[i] * v[i];
    if (vNormSq < 1e-28) continue;
    const beta = 2 / vNormSq;

    // Left multiply: H[k+1..n-1][k..n-1] -= beta * v * (v^T * H[k+1..n-1][k..n-1])
    for (let j = k; j < n; j++) {
      let dot = 0;
      for (let i = 0; i < vLen; i++) dot += v[i] * H[k + 1 + i][j];
      const scale = beta * dot;
      for (let i = 0; i < vLen; i++) H[k + 1 + i][j] -= scale * v[i];
    }

    // Right multiply: H[0..n-1][k+1..n-1] -= beta * (H[0..n-1][k+1..n-1] * v) * v^T
    for (let i = 0; i < n; i++) {
      let dot = 0;
      for (let j = 0; j < vLen; j++) dot += H[i][k + 1 + j] * v[j];
      const scale = beta * dot;
      for (let j = 0; j < vLen; j++) H[i][k + 1 + j] -= scale * v[j];
    }
  }
  return H;
}

/**
 * Extracts eigenvalues of a 2x2 real block [[a, b], [c, d]].
 */
function eig2x2(a: number, b: number, c: number, d: number): { re: number; im: number }[] {
  const tr = a + d;
  const det = a * d - b * c;
  const disc = tr * tr - 4 * det;
  if (disc >= 0) {
    const s = Math.sqrt(disc);
    return [
      { re: 0.5 * (tr + s), im: 0 },
      { re: 0.5 * (tr - s), im: 0 },
    ];
  }
  const im = 0.5 * Math.sqrt(-disc);
  return [
    { re: 0.5 * tr, im },
    { re: 0.5 * tr, im: -im },
  ];
}

/**
 * Computes all real and complex conjugate eigenvalues of an n x n real matrix
 * via Householder Hessenberg reduction + Francis double-shift QR iteration.
 */
export function computeMatrixEigenvalues(
  matrix: number[][]
): { re: number; im: number }[] {
  const n = matrix.length;
  if (n === 0) return [];
  if (n === 1) return [{ re: matrix[0][0], im: 0 }];
  if (n === 2) {
    return eig2x2(matrix[0][0], matrix[0][1], matrix[1][0], matrix[1][1]);
  }

  const H = toUpperHessenberg(matrix);
  const eigs: { re: number; im: number }[] = [];
  const eps = 1e-13;

  let m = n - 1;
  let iter = 0;
  let maxIter = 120 * n;

  while (m >= 0 && iter < maxIter) {
    if (m === 0) {
      eigs.push({ re: H[0][0], im: 0 });
      break;
    }

    // Find lowest index l where subdiagonal H[l][l-1] is negligible
    let l = m;
    while (l > 0) {
      const s = Math.abs(H[l - 1][l - 1]) + Math.abs(H[l][l]);
      const thresh = eps * Math.max(1e-12, s);
      if (Math.abs(H[l][l - 1]) <= thresh) {
        H[l][l - 1] = 0;
        break;
      }
      l--;
    }

    if (l === m) {
      // Single 1x1 eigenvalue converged
      eigs.push({ re: H[m][m], im: 0 });
      m -= 1;
      iter = 0;
      continue;
    }

    if (l === m - 1) {
      // 2x2 block converged
      const pair = eig2x2(H[m - 1][m - 1], H[m - 1][m], H[m][m - 1], H[m][m]);
      eigs.push(pair[0], pair[1]);
      m -= 2;
      iter = 0;
      continue;
    }

    // Exceptional shift every 10 iterations to break symmetry (e.g. pure rotation/companion)
    let p: number;
    let q: number;
    let r: number;
    if (iter > 0 && iter % 10 === 0) {
      const s = Math.abs(H[m][m - 1]) + Math.abs(H[m - 1][m - 2]);
      const tr = 1.5 * s;
      const det = s * s;
      p = H[l][l] * H[l][l] + H[l][l + 1] * H[l + 1][l] - tr * H[l][l] + det;
      q = H[l + 1][l] * (H[l][l] + H[l + 1][l + 1] - tr);
      r = l + 2 <= m ? H[l + 1][l] * H[l + 2][l + 1] : 0;
    } else {
      // Francis double shift from trailing 2x2 submatrix
      const tr = H[m - 1][m - 1] + H[m][m];
      const det = H[m - 1][m - 1] * H[m][m] - H[m - 1][m] * H[m][m - 1];
      p = H[l][l] * H[l][l] + H[l][l + 1] * H[l + 1][l] - tr * H[l][l] + det;
      q = H[l + 1][l] * (H[l][l] + H[l + 1][l + 1] - tr);
      r = l + 2 <= m ? H[l + 1][l] * H[l + 2][l + 1] : 0;
    }

    // Bulge chase from l to m - 1
    for (let k = l; k <= m - 1; k++) {
      const len = k + 2 <= m ? 3 : 2;
      const v = len === 3 ? [p, q, r] : [p, q];
      const norm = Math.sqrt(v.reduce((acc, val) => acc + val * val, 0));
      if (norm > 1e-30) {
        const sgn = v[0] >= 0 ? 1 : -1;
        v[0] += sgn * norm;
        const vNormSq = v.reduce((acc, val) => acc + val * val, 0);
        const beta = 2 / Math.max(1e-30, vNormSq);

        // Apply from left to rows k .. k + len - 1, cols max(l, k - 1) .. m
        const colStart = k > l ? k - 1 : l;
        for (let j = colStart; j <= m; j++) {
          let dot = 0;
          for (let i = 0; i < len; i++) dot += v[i] * H[k + i][j];
          const sc = beta * dot;
          for (let i = 0; i < len; i++) H[k + i][j] -= sc * v[i];
        }

        // Apply from right to rows l .. min(m, k + 3), cols k .. k + len - 1
        const rowEnd = Math.min(m, k + 3);
        for (let i = l; i <= rowEnd; i++) {
          let dot = 0;
          for (let j = 0; j < len; j++) dot += H[i][k + j] * v[j];
          const sc = beta * dot;
          for (let j = 0; j < len; j++) H[i][k + j] -= sc * v[j];
        }
      }

      if (k + 1 < m) {
        p = H[k + 1][k];
        q = H[k + 2][k];
        r = k + 3 <= m ? H[k + 3][k] : 0;
      }
    }

    iter++;
  }

  // Fallback if any remaining 2x2 or 1x1 block did not finish cleanly within maxIter
  if (iter >= maxIter && m >= 0) {
    for (let i = 0; i <= m; i++) {
      eigs.push({ re: H[i][i], im: 0 });
    }
  }

  return eigs.sort((a, b) => b.re - a.re || b.im - a.im);
}

/**
 * Computes roots of a real polynomial c[0]*s^d + c[1]*s^(d-1) + ... + c[d]
 * via the companion matrix eigenvalues.
 */
export function computePolynomialRoots(coeffs: number[]): { re: number; im: number }[] {
  let start = 0;
  while (start < coeffs.length && Math.abs(coeffs[start]) < 1e-12) {
    start++;
  }
  const trimmed = coeffs.slice(start);
  const deg = trimmed.length - 1;
  if (deg <= 0) return [];
  const lead = trimmed[0];
  const comp: number[][] = Array.from({ length: deg }, (_, r) =>
    Array.from({ length: deg }, (__, c) => {
      if (r === 0) return -trimmed[c + 1] / lead;
      return r - 1 === c ? 1 : 0;
    })
  );
  return computeMatrixEigenvalues(comp);
}

/**
 * Extracts exact SISO transfer function N(s)/D(s) from continuous state-space
 * for output row outIdx and input col inIdx using Faddeev-LeVerrier.
 * Returns coefficients in descending powers of s.
 */
export function stateSpaceToTransferFunction(
  plant: StateSpaceConfig,
  outputIndex: number = 0,
  inputIndex: number = 0
): { numerator: number[]; denominator: number[] } {
  const { n, A, B, C, D } = plant;
  const safeOut = Math.min(Math.max(0, outputIndex), Math.max(0, C.length - 1));
  const safeIn = Math.min(Math.max(0, inputIndex), Math.max(0, (B[0]?.length ?? 1) - 1));

  const cRow = C[safeOut] ?? Array(n).fill(0);
  const bCol = B.map((r) => r[safeIn] ?? 0);
  const dVal = D[safeOut]?.[safeIn] ?? 0;

  if (n <= 0) {
    return { numerator: [dVal], denominator: [1] };
  }

  // Faddeev-LeVerrier:
  // (sI - A)^-1 = (R_0 s^(n-1) + R_1 s^(n-2) + ... + R_{n-1}) / det(sI - A)
  // det(sI - A) = s^n + c_1 s^(n-1) + ... + c_n
  const den: number[] = Array(n + 1).fill(0);
  den[0] = 1;

  // R_0 = I
  let R: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (__, j) => (i === j ? 1 : 0))
  );

  // Numerator of strictly proper part: N_sp(s) = sum_{k=0..n-1} (C * R_k * B) * s^(n-1-k)
  const spNum: number[] = Array(n).fill(0);

  for (let k = 1; k <= n; k++) {
    // Capture C * R_{k-1} * B for s^(n - k)
    let crb = 0;
    for (let i = 0; i < n; i++) {
      let rowSum = 0;
      for (let j = 0; j < n; j++) rowSum += R[i][j] * bCol[j];
      crb += cRow[i] * rowSum;
    }
    spNum[k - 1] = crb;

    // A * R_{k-1}
    const AR: number[][] = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (__, j) => {
        let sum = 0;
        for (let t = 0; t < n; t++) sum += A[i][t] * R[t][j];
        return sum;
      })
    );

    let trace = 0;
    for (let i = 0; i < n; i++) trace += AR[i][i];
    const ck = -trace / k;
    den[k] = ck;

    // Next R_k = A * R_{k-1} + ck * I
    R = AR.map((row, i) => row.map((v, j) => (i === j ? v + ck : v)));
  }

  // Full numerator N(s) = N_sp(s) + dVal * D(s), length n + 1
  const fullNum: number[] = Array(n + 1).fill(0);
  fullNum[0] = dVal * den[0];
  for (let k = 1; k <= n; k++) {
    fullNum[k] = spNum[k - 1] + dVal * den[k];
  }

  // Trim near-zero leading coefficients from numerator while keeping at least 1 term
  let trimIdx = 0;
  while (trimIdx < fullNum.length - 1 && Math.abs(fullNum[trimIdx]) < 1e-10) {
    trimIdx++;
  }
  const cleanNum = fullNum.slice(trimIdx).map((v) => (Math.abs(v) < 1e-11 ? 0 : v));
  const cleanDen = den.map((v) => (Math.abs(v) < 1e-11 ? 0 : v));

  return { numerator: cleanNum, denominator: cleanDen };
}

/**
 * Builds the continuous closed-loop state matrix accounting for full-state LQR
 * feedback K and optional PID controller (integrator + filtered derivative states).
 */
export function buildClosedLoopMatrix(model: ControlModel): number[][] {
  const { n, A, B, C } = model.plant;
  const b0 = B.map((row) => row[0] ?? 0);
  const kVec = model.lqrK;

  const yIdx = Math.min(Math.max(0, model.pid.targetOutputIndex), Math.max(0, C.length - 1));
  const cy = C[yIdx] ?? Array(n).fill(0);

  if (!model.pid.enabled) {
    // A_cl = A - b0 * K
    return A.map((row, i) => row.map((v, j) => v - b0[i] * (kVec[j] ?? 0)));
  }

  const { kp, ki, kd, nFilter } = model.pid;
  const hasInt = Math.abs(ki) > 1e-12;
  const hasDeriv = Math.abs(kd) > 1e-12;
  const N = Math.max(0.1, nFilter);

  const dim = n + (hasInt ? 1 : 0) + (hasDeriv ? 1 : 0);
  const Acl: number[][] = Array.from({ length: dim }, () => Array(dim).fill(0));

  const intIdx = hasInt ? n : -1;
  const derivIdx = hasDeriv ? n + (hasInt ? 1 : 0) : -1;

  // Control law: u = -K*x - kp*(Cy*x) + ki*e_i - kd*N*(Cy*x - x_f)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const fbGain =
        (kVec[j] ?? 0) +
        kp * (cy[j] ?? 0) +
        (hasDeriv ? kd * N * (cy[j] ?? 0) : 0);
      Acl[i][j] = A[i][j] - b0[i] * fbGain;
    }
    if (hasInt) {
      Acl[i][intIdx] = b0[i] * ki;
    }
    if (hasDeriv) {
      Acl[i][derivIdx] = b0[i] * kd * N;
    }
  }

  // e_i_dot = -Cy * x
  if (hasInt) {
    for (let j = 0; j < n; j++) {
      Acl[intIdx][j] = -(cy[j] ?? 0);
    }
  }

  // x_f_dot = N * Cy * x - N * x_f
  if (hasDeriv) {
    for (let j = 0; j < n; j++) {
      Acl[derivIdx][j] = N * (cy[j] ?? 0);
    }
    Acl[derivIdx][derivIdx] = -N;
  }

  return Acl;
}

/**
 * Computes the continuous-time zeros introduced by the filtered PID compensator:
 *   C(s) = kp + ki/s + kd*N*s/(s + N)
 */
export function computePidCompensatorZeros(
  pid: ControlModel['pid']
): ComplexPoleZero[] {
  if (!pid.enabled) return [];
  const { kp, ki, kd, nFilter } = pid;
  const N = Math.max(0.1, nFilter);
  const hasInt = Math.abs(ki) > 1e-12;
  const hasDeriv = Math.abs(kd) > 1e-12;

  let numCoeffs: number[] = [];
  if (hasInt && hasDeriv) {
    // [(kp + kd*N) s^2 + (kp*N + ki) s + ki*N] / [s(s + N)]
    numCoeffs = [kp + kd * N, kp * N + ki, ki * N];
  } else if (hasDeriv) {
    // [(kp + kd*N) s + kp*N] / (s + N)
    numCoeffs = [kp + kd * N, kp * N];
  } else if (hasInt) {
    // [kp s + ki] / s
    numCoeffs = [kp, ki];
  } else {
    return [];
  }

  return computePolynomialRoots(numCoeffs).map((z) =>
    makeContinuousEntry(z.re, z.im, 'zero', 'pid')
  );
}

/**
 * Computes full continuous (open/closed-loop) and discrete stability profile
 * for the active ControlModel.
 */
export function analyzeSystemStability(
  model: ControlModel,
  outputIndex: number = model.pid.targetOutputIndex,
  inputIndex: number = 0
): PoleZeroAnalysis {
  const openRaw = computeMatrixEigenvalues(model.plant.A);
  const openLoopPoles = openRaw.map((e) => makeContinuousEntry(e.re, e.im, 'pole'));

  const closedMatrix = buildClosedLoopMatrix(model);
  const closedRaw = computeMatrixEigenvalues(closedMatrix);
  const closedLoopPoles = closedRaw.map((e) => makeContinuousEntry(e.re, e.im, 'pole'));

  const discrete = discretizeStateSpace(
    model.plant,
    Math.max(1e-6, model.baseDt),
    model.discretization
  );
  const discreteRaw = computeMatrixEigenvalues(discrete.Ad);
  const discretePoles = discreteRaw.map((e) => makeDiscreteEntry(e.re, e.im));

  const tf = stateSpaceToTransferFunction(model.plant, outputIndex, inputIndex);
  const zeroRoots = computePolynomialRoots(tf.numerator);
  const plantZeros = zeroRoots.map((z) =>
    makeContinuousEntry(z.re, z.im, 'zero', 'plant')
  );
  const pidZeros = computePidCompensatorZeros(model.pid);

  const openStats = classifyContinuous(openLoopPoles);
  const closedStats = classifyContinuous(closedLoopPoles);
  const discStats = classifyDiscrete(discretePoles);

  return {
    openLoopPoles,
    closedLoopPoles,
    discretePoles,
    plantZeros,
    pidZeros,
    openLoopVerdict: openStats.verdict,
    closedLoopVerdict: closedStats.verdict,
    discreteVerdict: discStats.verdict,
    maxRealPartOpen: openStats.maxReal,
    maxRealPartClosed: closedStats.maxReal,
    maxDiscreteMag: discStats.maxMag,
  };
}

export interface PoleZeroStabilitySummary {
  scope: 'open' | 'closed';
  verdict: StabilityVerdict;
  dominantPole: ComplexPoleZero | null;
  dampingRatio: number | null;
  minDampingRatio: number | null;
  naturalFreqRad: number | null;
  naturalFreqHz: number | null;
  dampingRegime: string;
  gainMarginDb: number | null;
  phaseMarginDeg: number | null;
  gainCrossoverOmega: number | null;
  phaseCrossoverOmega: number | null;
  poleCount: number;
  zeroCount: number;
}

function selectDominantPole(poles: ComplexPoleZero[]): ComplexPoleZero | null {
  if (poles.length === 0) return null;
  const dynamic = poles.filter((p) => p.mag > 1e-6);
  const candidates = dynamic.length > 0 ? dynamic : poles;

  // Prefer the rightmost (largest Re) pole; tie-break by positive imaginary frequency
  const sorted = [...candidates].sort((a, b) => {
    const reDiff = b.re - a.re;
    if (Math.abs(reDiff) > 1e-6) return reDiff;
    return Math.abs(b.im) - Math.abs(a.im);
  });
  return sorted[0] ?? null;
}

function classifyDampingRegime(
  pole: ComplexPoleZero | null,
  zeta: number | null
): string {
  if (!pole || zeta === null) return 'Origin / Integrator';
  if (pole.re > TOL) return 'Unstable (RHP)';
  if (Math.abs(pole.re) <= TOL) return 'Undamped (Marginal)';
  if (Math.abs(pole.im) > 1e-5) {
    return zeta < 0.999 ? 'Underdamped' : 'Critically Damped';
  }
  return Math.abs(zeta - 1) <= 1e-3 ? 'Critically Damped' : 'Real / Overdamped';
}

/**
 * Computes damping ratio (zeta), natural frequency (omega_n), and gain/phase margins
 * directly from extracted pole-zero locations of the active ControlModel.
 */
export function computePoleZeroStabilitySummary(
  model: ControlModel,
  scope: 'open' | 'closed' = 'closed',
  outputIndex: number = model.pid.targetOutputIndex,
  inputIndex: number = 0
): PoleZeroStabilitySummary {
  const analysis = analyzeSystemStability(model, outputIndex, inputIndex);
  const poles = scope === 'closed' ? analysis.closedLoopPoles : analysis.openLoopPoles;
  const verdict = scope === 'closed' ? analysis.closedLoopVerdict : analysis.openLoopVerdict;

  const dominantPole = selectDominantPole(poles);
  const dampingRatio = dominantPole?.dampingRatio ?? null;
  const naturalFreqRad = dominantPole ? dominantPole.naturalFreqRad : null;
  const naturalFreqHz =
    naturalFreqRad !== null ? naturalFreqRad / (2 * Math.PI) : null;

  const nonOriginDampings = poles
    .filter((p) => p.mag > 1e-6 && p.dampingRatio !== null)
    .map((p) => p.dampingRatio as number);
  const minDampingRatio =
    nonOriginDampings.length > 0 ? Math.min(...nonOriginDampings) : null;

  // Evaluate frequency response L(jw) directly from factored plant poles & zeros:
  // G(jw) = k0 * prod(jw - z_m) / prod(jw - p_i)
  const tf = stateSpaceToTransferFunction(model.plant, outputIndex, inputIndex);
  const k0 = (tf.numerator[0] ?? 0) / (tf.denominator[0] ?? 1);

  const nyquistOmega = Math.PI / Math.max(1e-6, model.baseDt);
  const maxPoleMag = Math.max(
    10,
    ...analysis.openLoopPoles.map((p) => p.mag),
    ...analysis.plantZeros.map((z) => z.mag)
  );
  const omegaMax = Math.max(
    100,
    Math.pow(10, Math.ceil(Math.log10(Math.max(nyquistOmega * 2, maxPoleMag * 4))))
  );
  const omegaMin = Math.max(0.02, omegaMax / 1e5);

  const numPts = 260;
  const logMin = Math.log10(omegaMin);
  const logMax = Math.log10(omegaMax);

  let gainCrossoverOmega: number | null = null;
  let phaseMarginDeg: number | null = null;
  let phaseCrossoverOmega: number | null = null;
  let gainMarginDb: number | null = null;

  if (Math.abs(k0) > 1e-14) {
    let prevMagDb = 0;
    let prevPhase = 0;
    let prevOmega = omegaMin;

    for (let k = 0; k < numPts; k++) {
      const omega = Math.pow(10, logMin + (k / (numPts - 1)) * (logMax - logMin));

      // Numerator product: k0 * prod(( -z.re ) + j*( omega - z.im ))
      let numRe = k0;
      let numIm = 0;
      for (const z of analysis.plantZeros) {
        const fRe = -z.re;
        const fIm = omega - z.im;
        const nextRe = numRe * fRe - numIm * fIm;
        const nextIm = numRe * fIm + numIm * fRe;
        numRe = nextRe;
        numIm = nextIm;
      }

      // Denominator product: prod(( -p.re ) + j*( omega - p.im ))
      let denRe = 1;
      let denIm = 0;
      for (const p of analysis.openLoopPoles) {
        const fRe = -p.re;
        const fIm = omega - p.im;
        const nextRe = denRe * fRe - denIm * fIm;
        const nextIm = denRe * fIm + denIm * fRe;
        denRe = nextRe;
        denIm = nextIm;
      }

      const denSq = Math.max(1e-28, denRe * denRe + denIm * denIm);
      const gRe = (numRe * denRe + numIm * denIm) / denSq;
      const gIm = (numIm * denRe - numRe * denIm) / denSq;

      let respRe = gRe;
      let respIm = gIm;

      if (scope === 'closed' && model.pid.enabled) {
        const { kp, ki, kd, nFilter } = model.pid;
        const iIm = -ki / Math.max(1e-9, omega);
        const nf = Math.max(0.1, nFilter);
        const nfDen = nf * nf + omega * omega;
        const dRe = (kd * nf * omega * omega) / nfDen;
        const dIm = (kd * nf * nf * omega) / nfDen;
        const cRe = kp + dRe;
        const cIm = iIm + dIm;

        respRe = cRe * gRe - cIm * gIm;
        respIm = cRe * gIm + cIm * gRe;
      }

      const mag = Math.hypot(respRe, respIm);
      const magDb = 20 * Math.log10(Math.max(1e-12, mag));
      let phase = (Math.atan2(respIm, respRe) * 180) / Math.PI;

      if (k > 0) {
        let diff = phase - prevPhase;
        while (diff > 180) {
          phase -= 360;
          diff = phase - prevPhase;
        }
        while (diff < -180) {
          phase += 360;
          diff = phase - prevPhase;
        }

        // 0 dB gain crossover -> Phase Margin
        if (
          gainCrossoverOmega === null &&
          ((prevMagDb >= 0 && magDb <= 0) || (prevMagDb <= 0 && magDb >= 0))
        ) {
          const denom = magDb - prevMagDb;
          const t = Math.abs(denom) > 1e-12 ? (0 - prevMagDb) / denom : 0.5;
          gainCrossoverOmega = Math.pow(
            10,
            Math.log10(prevOmega) + t * (Math.log10(omega) - Math.log10(prevOmega))
          );
          const interpPhase = prevPhase + t * (phase - prevPhase);
          let pm = 180 + interpPhase;
          while (pm > 180) pm -= 360;
          while (pm < -180) pm += 360;
          phaseMarginDeg = pm;
        }

        // -180 / +180 deg phase crossover -> Gain Margin
        for (const targetPhase of [-180, 180, -540]) {
          if (
            phaseCrossoverOmega === null &&
            ((prevPhase >= targetPhase && phase <= targetPhase) ||
              (prevPhase <= targetPhase && phase >= targetPhase))
          ) {
            const denom = phase - prevPhase;
            const t = Math.abs(denom) > 1e-12 ? (targetPhase - prevPhase) / denom : 0.5;
            phaseCrossoverOmega = Math.pow(
              10,
              Math.log10(prevOmega) + t * (Math.log10(omega) - Math.log10(prevOmega))
            );
            const interpMagDb = prevMagDb + t * (magDb - prevMagDb);
            gainMarginDb = -interpMagDb;
          }
        }
      }

      prevMagDb = magDb;
      prevPhase = phase;
      prevOmega = omega;
    }
  }

  return {
    scope,
    verdict,
    dominantPole,
    dampingRatio,
    minDampingRatio,
    naturalFreqRad,
    naturalFreqHz,
    dampingRegime: classifyDampingRegime(dominantPole, dampingRatio),
    gainMarginDb,
    phaseMarginDeg,
    gainCrossoverOmega,
    phaseCrossoverOmega,
    poleCount: poles.length,
    zeroCount: analysis.plantZeros.length,
  };
}

export interface StepResponsePoint {
  t: number;
  y: number;
}

export interface StepResponseAnalysis {
  mode: 'open' | 'closed';
  points: StepResponsePoint[];
  horizonSec: number;
  dcSteadyState: number | null;
  finalValue: number;
  peakValue: number;
  overshootPct: number | null;
  settlingTimeSec: number | null;
  divergent: boolean;
}

function chooseStepHorizon(poles: ComplexPoleZero[], fallbackDuration: number): number {
  const maxReal = poles.length > 0 ? Math.max(...poles.map((p) => p.re)) : 0;
  if (maxReal > 1e-4) {
    // Unstable system: keep horizon compact so exponential growth fits cleanly
    return Math.min(2.0, Math.max(0.25, Number((4.0 / maxReal).toFixed(2))));
  }

  const damped = poles.filter((p) => p.re < -1e-4);
  if (damped.length > 0) {
    const slowestDecay = Math.min(...damped.map((p) => Math.abs(p.re)));
    const est = Math.min(25, Math.max(0.008, 6.5 / slowestDecay));
    // Snap to clean engineering horizon values
    const candidates = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 3, 4, 5, 8, 10, 15, 20, 25];
    return candidates.find((c) => c >= est) ?? 25;
  }

  // Marginal / pure integrator
  return Math.min(10, Math.max(1, fallbackDuration));
}

/**
 * Computes unit step response y(t) for the active SISO transfer function (open-loop G(s))
 * or closed-loop controller+plant using 4th-order Runge-Kutta integration from zero initial state.
 */
export function computeTransferFunctionStepResponse(
  model: ControlModel,
  mode: 'open' | 'closed' = 'open',
  outputIndex: number = model.pid.targetOutputIndex,
  inputIndex: number = 0
): StepResponseAnalysis {
  const { n, A, B, C, D } = model.plant;
  const safeOut = Math.min(Math.max(0, outputIndex), Math.max(0, C.length - 1));
  const safeIn = Math.min(Math.max(0, inputIndex), Math.max(0, (B[0]?.length ?? 1) - 1));

  const cRow = C[safeOut] ?? Array(n).fill(0);
  const bCol = B.map((r) => r[safeIn] ?? 0);
  const dVal = D[safeOut]?.[safeIn] ?? 0;

  const analysis = analyzeSystemStability(model, safeOut, safeIn);
  const activePoles = mode === 'closed' ? analysis.closedLoopPoles : analysis.openLoopPoles;
  const isUnstable =
    mode === 'closed'
      ? analysis.closedLoopVerdict === 'UNSTABLE'
      : analysis.openLoopVerdict === 'UNSTABLE';

  const horizonSec = chooseStepHorizon(activePoles, model.duration);
  const numPts = 140;
  const dt = horizonSec / numPts;
  const subSteps = 4;
  const h = dt / subSteps;

  // Determine analytical steady-state target when stable
  const tf = stateSpaceToTransferFunction(model.plant, safeOut, safeIn);
  const a0 = tf.denominator[tf.denominator.length - 1] ?? 0;
  const b0 = tf.numerator[tf.numerator.length - 1] ?? 0;
  const openDcGain = !isUnstable && Math.abs(a0) > 1e-10 ? b0 / a0 : null;

  const pidOutIdx = Math.min(
    Math.max(0, model.pid.targetOutputIndex),
    Math.max(0, C.length - 1)
  );
  const cyPid = C[pidOutIdx] ?? Array(n).fill(0);
  const dPid = D[pidOutIdx]?.[0] ?? 0;
  const N = Math.max(0.1, model.pid.nFilter);

  const computeUClosed = (x: number[], eInt: number, xFilt: number): number => {
    let uLqr = 0;
    for (let i = 0; i < n; i++) {
      const target = i === 0 && model.lqrTracksRefOnState0 ? 1 : 0;
      uLqr += -(model.lqrK[i] ?? 0) * (x[i] - target);
    }
    if (!model.pid.enabled) return uLqr;

    let cyx = 0;
    for (let i = 0; i < n; i++) cyx += cyPid[i] * x[i];
    const refPid = model.pid.tracksStepRef ? 1 : 0;
    const gFb = model.pid.kp + model.pid.kd * N;
    const denom = Math.abs(1 + gFb * dPid) > 1e-9 ? 1 + gFb * dPid : 1;
    const errNoD = refPid - cyx;
    const uMem = uLqr + model.pid.ki * eInt - model.pid.kd * N * xFilt;
    return (uMem + gFb * errNoD) / denom;
  };

  // State vector: [x_0..x_{n-1}, e_i, x_f] (last 2 only used in closed mode)
  let state = Array(n + 2).fill(0);
  const points: StepResponsePoint[] = [];

  const evalOutput = (s: number[]): number => {
    const u = mode === 'open' ? 1 : computeUClosed(s, s[n], s[n + 1]);
    let y = dVal * u;
    for (let i = 0; i < n; i++) y += cRow[i] * s[i];
    return y;
  };

  const deriv = (s: number[]): number[] => {
    const out = Array(n + 2).fill(0);
    if (mode === 'open') {
      for (let i = 0; i < n; i++) {
        let sum = bCol[i];
        for (let j = 0; j < n; j++) sum += A[i][j] * s[j];
        out[i] = sum;
      }
      return out;
    }

    const u = computeUClosed(s, s[n], s[n + 1]);
    for (let i = 0; i < n; i++) {
      let sum = (B[i]?.[0] ?? 0) * u;
      for (let j = 0; j < n; j++) sum += A[i][j] * s[j];
      out[i] = sum;
    }

    if (model.pid.enabled) {
      let yPid = dPid * u;
      for (let i = 0; i < n; i++) yPid += cyPid[i] * s[i];
      const err = (model.pid.tracksStepRef ? 1 : 0) - yPid;
      out[n] = Math.abs(model.pid.ki) > 1e-12 ? err : 0;
      out[n + 1] = N * (err - s[n + 1]);
    }
    return out;
  };

  let divergent = false;
  points.push({ t: 0, y: evalOutput(state) });

  for (let step = 1; step <= numPts; step++) {
    for (let sub = 0; sub < subSteps; sub++) {
      const k1 = deriv(state);
      const k2 = deriv(state.map((v, i) => v + 0.5 * h * k1[i]));
      const k3 = deriv(state.map((v, i) => v + 0.5 * h * k2[i]));
      const k4 = deriv(state.map((v, i) => v + h * k3[i]));
      state = state.map(
        (v, i) => v + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i])
      );
    }

    const y = evalOutput(state);
    if (!Number.isFinite(y) || Math.abs(y) > 1e5) {
      divergent = true;
      break;
    }
    points.push({ t: step * dt, y });
  }

  const finalValue = points[points.length - 1]?.y ?? 0;
  const ys = points.map((pt) => pt.y);
  const peakValue = ys.reduce(
    (best, v) => (Math.abs(v) > Math.abs(best) ? v : best),
    ys[0] ?? 0
  );

  const closedTracksTarget =
    mode === 'closed' &&
    !isUnstable &&
    ((model.pid.enabled && model.pid.tracksStepRef && Math.abs(model.pid.ki) > 1e-12) ||
      model.lqrTracksRefOnState0);

  const dcSteadyState =
    mode === 'open'
      ? openDcGain
      : isUnstable
      ? null
      : closedTracksTarget && model.pid.enabled && model.pid.tracksStepRef
      ? 1
      : finalValue;

  const refSs = dcSteadyState ?? finalValue;
  let overshootPct: number | null = null;
  if (!isUnstable && !divergent && Math.abs(refSs) > 1e-6) {
    const sign = refSs >= 0 ? 1 : -1;
    const maxSigned = Math.max(...ys.map((y) => sign * y));
    overshootPct = Math.max(0, ((maxSigned - Math.abs(refSs)) / Math.abs(refSs)) * 100);
  }

  let settlingTimeSec: number | null = null;
  if (!isUnstable && !divergent && dcSteadyState !== null) {
    const band = Math.max(1e-4, 0.02 * Math.max(1, Math.abs(dcSteadyState)));
    const lastOutsideIdx = points.reduce(
      (acc, pt, idx) => (Math.abs(pt.y - dcSteadyState) > band ? idx : acc),
      -1
    );
    if (lastOutsideIdx < points.length - 1) {
      settlingTimeSec = lastOutsideIdx >= 0 ? points[lastOutsideIdx + 1].t : 0;
    }
  }

  return {
    mode,
    points,
    horizonSec,
    dcSteadyState,
    finalValue,
    peakValue,
    overshootPct,
    settlingTimeSec,
    divergent: divergent || isUnstable,
  };
}

export interface RootLocusPoint {
  k: number;
  re: number;
  im: number;
}

export interface RootLocusBranch {
  id: number;
  points: RootLocusPoint[];
}

export interface RootLocusCrossing {
  gainK: number;
  omega: number;
}

export interface RootLocusAnalysis {
  branches: RootLocusBranch[];
  gains: number[];
  kMin: number;
  kMax: number;
  relativeDegree: number;
  asymptoteCentroid: number | null;
  asymptoteAnglesDeg: number[];
  jwCrossings: RootLocusCrossing[];
}

/**
 * Computes root locus trajectories for unity feedback 1 + K * N(s)/D(s) = 0
 * over K >= 0 with nearest-neighbor branch continuity tracking.
 */
export function computeRootLocus(
  model: ControlModel,
  outputIndex: number = model.pid.targetOutputIndex,
  inputIndex: number = 0,
  numSteps: number = 110
): RootLocusAnalysis {
  const tf = stateSpaceToTransferFunction(model.plant, outputIndex, inputIndex);
  const den = tf.denominator;
  const num = tf.numerator;
  const n = Math.max(0, den.length - 1);

  if (n === 0 || num.every((v) => Math.abs(v) < 1e-13)) {
    return {
      branches: [],
      gains: [],
      kMin: 0,
      kMax: 0,
      relativeDegree: n,
      asymptoteCentroid: null,
      asymptoteAnglesDeg: [],
      jwCrossings: [],
    };
  }

  // Pad numerator to length n + 1 in descending powers of s
  const paddedNum = Array(Math.max(0, den.length - num.length))
    .fill(0)
    .concat(num);

  // Determine characteristic gain scale kRef where |K * N(s)| matches |D(s)|
  const numOrder = num.length - 1;
  const maxDenCoeff = Math.max(...den.map((v) => Math.abs(v)));
  const maxNumCoeff = Math.max(...paddedNum.map((v) => Math.abs(v)));
  const kRef = Math.max(1e-3, maxDenCoeff / Math.max(1e-12, maxNumCoeff));
  const kMin = 0;
  const kMax = Math.max(10, kRef * 24);
  const kStartLog = Math.min(0.01, kRef * 1e-3);

  const gains: number[] = [0];
  const logLow = Math.log10(Math.max(1e-5, kStartLog));
  const logHigh = Math.log10(kMax);
  const totalLogSteps = Math.max(24, numSteps);
  for (let s = 0; s < totalLogSteps; s++) {
    const t = s / (totalLogSteps - 1);
    gains.push(Math.pow(10, logLow + t * (logHigh - logLow)));
  }

  const openPoles = computePolynomialRoots(den);
  const openZeros = computePolynomialRoots(num);
  const relativeDegree = Math.max(0, n - numOrder);

  let asymptoteCentroid: number | null = null;
  const asymptoteAnglesDeg: number[] = [];
  if (relativeDegree > 0) {
    const sumPoles = openPoles.reduce((acc, p) => acc + p.re, 0);
    const sumZeros = openZeros.reduce((acc, z) => acc + z.re, 0);
    asymptoteCentroid = (sumPoles - sumZeros) / relativeDegree;
    for (let k = 0; k < relativeDegree; k++) {
      asymptoteAnglesDeg.push(((2 * k + 1) * 180) / relativeDegree);
    }
  }

  // Initialize n continuous branches from open-loop poles at K = 0
  const branches: RootLocusBranch[] = openPoles.map((p, idx) => ({
    id: idx,
    points: [{ k: 0, re: p.re, im: p.im }],
  }));

  for (let gIdx = 1; gIdx < gains.length; gIdx++) {
    const K = gains[gIdx];
    const poly = den.map((dVal, i) => dVal + K * paddedNum[i]);
    if (Math.abs(poly[0]) < 1e-14) continue;

    const roots = computePolynomialRoots(poly);
    if (roots.length === 0) continue;

    // Match each active branch's last point to the closest root at gain K
    const branchCount = Math.min(branches.length, roots.length);
    const pairs: { bIdx: number; rIdx: number; dist: number }[] = [];

    for (let bIdx = 0; bIdx < branches.length; bIdx++) {
      const last = branches[bIdx].points[branches[bIdx].points.length - 1];
      for (let rIdx = 0; rIdx < roots.length; rIdx++) {
        const dist = Math.hypot(roots[rIdx].re - last.re, roots[rIdx].im - last.im);
        pairs.push({ bIdx, rIdx, dist });
      }
    }
    pairs.sort((a, b) => a.dist - b.dist);

    const usedBranches = new Set<number>();
    const usedRoots = new Set<number>();
    for (const pair of pairs) {
      if (usedBranches.has(pair.bIdx) || usedRoots.has(pair.rIdx)) continue;
      usedBranches.add(pair.bIdx);
      usedRoots.add(pair.rIdx);
      const r = roots[pair.rIdx];
      branches[pair.bIdx].points.push({ k: K, re: r.re, im: r.im });
      if (usedBranches.size >= branchCount) break;
    }
  }

  // Detect imaginary-axis crossings (Re crosses 0) along branches
  const jwCrossings: RootLocusCrossing[] = [];
  for (const branch of branches) {
    for (let i = 1; i < branch.points.length; i++) {
      const p0 = branch.points[i - 1];
      const p1 = branch.points[i];
      if (
        (p0.re < -1e-6 && p1.re > 1e-6) ||
        (p0.re > 1e-6 && p1.re < -1e-6)
      ) {
        const frac = -p0.re / (p1.re - p0.re);
        const gainK = p0.k + frac * (p1.k - p0.k);
        const omega = Math.abs(p0.im + frac * (p1.im - p0.im));
        // Deduplicate conjugate crossing pairs by gain/omega
        const already = jwCrossings.some(
          (c) => Math.abs(c.gainK - gainK) < 1e-3 * Math.max(1, gainK) && Math.abs(c.omega - omega) < 1e-2
        );
        if (!already && omega >= 0) {
          jwCrossings.push({ gainK, omega });
        }
      }
    }
  }

  jwCrossings.sort((a, b) => a.gainK - b.gainK);

  return {
    branches,
    gains,
    kMin,
    kMax,
    relativeDegree,
    asymptoteCentroid,
    asymptoteAnglesDeg,
    jwCrossings,
  };
}

function escapeLatexText(text: string): string {
  return text.replace(/([&%$#_{}])/g, '\\$1');
}

function formatLatexNumber(val: number): string {
  if (Math.abs(val) < 1e-10) return '0';
  return Number.isInteger(val) ? String(val) : Number(val.toPrecision(4)).toString();
}

function formatLatexPoly(coeffs: number[]): string {
  const parts: string[] = [];
  const deg = coeffs.length - 1;
  for (let i = 0; i < coeffs.length; i++) {
    const c = coeffs[i];
    if (Math.abs(c) < 1e-10) continue;
    const p = deg - i;
    const absStr = formatLatexNumber(Math.abs(c));
    const sTerm = p === 0 ? '' : p === 1 ? 's' : `s^{${p}}`;
    const coeffStr = p > 0 && Math.abs(Math.abs(c) - 1) < 1e-9 ? '' : absStr;
    const term = `${coeffStr}${sTerm}` || '1';
    if (parts.length === 0) {
      parts.push(c < 0 ? `-${term}` : term);
    } else {
      parts.push(c < 0 ? ` - ${term}` : ` + ${term}`);
    }
  }
  return parts.length > 0 ? parts.join('') : '0';
}

function formatLatexMatrix(mat: number[][]): string {
  const rows = mat.map((row) =>
    row.map((v) => formatLatexNumber(v)).join(' & ')
  );
  return `\\begin{bmatrix} ${rows.join(' \\\\ ')} \\end{bmatrix}`;
}

function formatLatexComplexList(items: ComplexPoleZero[]): string {
  if (items.length === 0) return '\\text{None}';
  return items
    .map((p) =>
      Math.abs(p.im) < 1e-6
        ? p.re.toFixed(4)
        : `${p.re.toFixed(4)} ${p.im >= 0 ? '+' : '-'} j\\,${Math.abs(p.im).toFixed(4)}`
    )
    .join(',\\; ');
}

/**
 * Generates a formatted LaTeX report snippet containing the active SISO
 * transfer function, state-space realization, poles/zeros, damping ratio,
 * natural frequency, and stability margins.
 */
export function generateLatexStabilityReport(
  model: ControlModel,
  outputIndex: number = model.pid.targetOutputIndex,
  inputIndex: number = 0
): string {
  const tf = stateSpaceToTransferFunction(model.plant, outputIndex, inputIndex);
  const analysis = analyzeSystemStability(model, outputIndex, inputIndex);
  const openSummary = computePoleZeroStabilitySummary(model, 'open', outputIndex, inputIndex);
  const closedSummary = computePoleZeroStabilitySummary(model, 'closed', outputIndex, inputIndex);
  const rootLocus = computeRootLocus(model, outputIndex, inputIndex, 60);

  const numTex = formatLatexPoly(tf.numerator);
  const denTex = formatLatexPoly(tf.denominator);

  const gmClosedTex =
    closedSummary.gainMarginDb !== null
      ? `${closedSummary.gainMarginDb.toFixed(2)}\\text{ dB}`
      : '\\infty';
  const pmClosedTex =
    closedSummary.phaseMarginDeg !== null
      ? `${closedSummary.phaseMarginDeg.toFixed(1)}^{\\circ}`
      : '\\text{No }0\\text{ dB}';

  const lines: string[] = [
    `% OpenLoop System Analysis Report`,
    `\\subsection*{System Analysis: ${escapeLatexText(model.name)}}`,
    `\\noindent\\textbf{Dimensions:} $n=${model.plant.n},\\; m=${model.plant.m},\\; p=${model.plant.p}$ \\quad|\\quad \\textbf{Step:} $dt=${model.baseDt}\\text{ s}$ \\quad|\\quad \\textbf{Discretization:} ${model.discretization.toUpperCase()}`,
    ``,
    `\\subsubsection*{Transfer Function (Channel $u_{${inputIndex}} \\rightarrow y_{${outputIndex}}$)}`,
    `\\[`,
    `G(s) = \\frac{${numTex}}{${denTex}}`,
    `\\]`,
    ``,
    `\\subsubsection*{State-Space Realization}`,
    `\\[`,
    `A = ${formatLatexMatrix(model.plant.A)}, \\quad B = ${formatLatexMatrix(model.plant.B)}, \\quad C = ${formatLatexMatrix(model.plant.C)}, \\quad D = ${formatLatexMatrix(model.plant.D)}`,
    `\\]`,
    ``,
    `\\subsubsection*{Poles, Zeros \\& Eigenvalues}`,
    `\\begin{itemize}`,
    `  \\item \\textbf{Open-Loop Poles} $\\lambda(A)$: $${formatLatexComplexList(analysis.openLoopPoles)}$`,
    `  \\item \\textbf{Closed-Loop Poles} $\\lambda(A_{\\mathrm{cl}})$: $${formatLatexComplexList(analysis.closedLoopPoles)}$`,
    `  \\item \\textbf{Plant Zeros}: $${formatLatexComplexList(analysis.plantZeros)}$`,
    `\\end{itemize}`,
    ``,
    `\\subsubsection*{Stability \\& Frequency-Domain Metrics}`,
    `\\begin{tabular}{lll}`,
    `\\hline`,
    `Metric & Open-Loop $G(s)$ & Closed-Loop \\\\`,
    `\\hline`,
    `Stability Verdict & ${analysis.openLoopVerdict} & ${analysis.closedLoopVerdict} \\\\`,
    `Dominant Damping Ratio ($\\zeta$) & ${openSummary.dampingRatio !== null ? openSummary.dampingRatio.toFixed(4) : '---'} & ${closedSummary.dampingRatio !== null ? closedSummary.dampingRatio.toFixed(4) : '---'} \\\\`,
    `Dominant Natural Freq ($\\omega_n$) & ${openSummary.naturalFreqRad !== null ? `${openSummary.naturalFreqRad.toFixed(3)}\\text{ rad/s}` : '---'} & ${closedSummary.naturalFreqRad !== null ? `${closedSummary.naturalFreqRad.toFixed(3)}\\text{ rad/s}` : '---'} \\\\`,
    `Damping Regime & ${escapeLatexText(openSummary.dampingRegime)} & ${escapeLatexText(closedSummary.dampingRegime)} \\\\`,
    `Discrete Spectral Radius ($\\max|z|$) & \\multicolumn{2}{l}{${analysis.maxDiscreteMag.toFixed(5)} (${analysis.discreteVerdict})} \\\\`,
    `Gain Margin ($GM$) & \\multicolumn{2}{l}{$${gmClosedTex}$${closedSummary.phaseCrossoverOmega !== null ? ` at $\\omega_{pc}=${closedSummary.phaseCrossoverOmega.toFixed(2)}\\text{ rad/s}$` : ''}} \\\\`,
    `Phase Margin ($PM$) & \\multicolumn{2}{l}{$${pmClosedTex}$${closedSummary.gainCrossoverOmega !== null ? ` at $\\omega_{gc}=${closedSummary.gainCrossoverOmega.toFixed(2)}\\text{ rad/s}$` : ''}} \\\\`,
  ];

  if (rootLocus.jwCrossings.length > 0) {
    const crossingStr = rootLocus.jwCrossings
      .map((c) => `K_{\\text{crit}}=${c.gainK.toFixed(2)}\\;(\\omega=${c.omega.toFixed(2)}\\text{ rad/s})`)
      .join(',\\; ');
    lines.push(`Root Locus $j\\omega$-Crossing & \\multicolumn{2}{l}{$${crossingStr}$} \\\\`);
  }

  lines.push(`\\hline`, `\\end{tabular}`);

  return lines.join('\n');
}




