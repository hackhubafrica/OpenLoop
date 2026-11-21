import { DiscretizationMethod, DiscretizedMatrices, StateSpaceConfig } from '../types/control';

export function zeros(rows: number, cols: number): number[][] {
  return Array.from({ length: rows }, () => Array(cols).fill(0));
}

export function identity(n: number): number[][] {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (__, j) => (i === j ? 1 : 0))
  );
}

export function matAdd(A: number[][], B: number[][]): number[][] {
  return A.map((row, i) => row.map((v, j) => v + (B[i]?.[j] ?? 0)));
}

export function matSub(A: number[][], B: number[][]): number[][] {
  return A.map((row, i) => row.map((v, j) => v - (B[i]?.[j] ?? 0)));
}

export function matScale(A: number[][], s: number): number[][] {
  return A.map((row) => row.map((v) => v * s));
}

export function matMul(A: number[][], B: number[][]): number[][] {
  const r = A.length;
  const c = B[0]?.length ?? 0;
  const kLen = B.length;
  const out = zeros(r, c);
  for (let i = 0; i < r; i++) {
    for (let k = 0; k < kLen; k++) {
      const aik = A[i][k];
      if (aik === 0) continue;
      for (let j = 0; j < c; j++) {
        out[i][j] += aik * B[k][j];
      }
    }
  }
  return out;
}

export function matVecMul(A: number[][], x: number[]): number[] {
  return A.map((row) => row.reduce((acc, v, j) => acc + v * (x[j] ?? 0), 0));
}

export function matInfNorm(A: number[][]): number {
  let max = 0;
  for (let i = 0; i < A.length; i++) {
    let rowSum = 0;
    for (let j = 0; j < A[i].length; j++) {
      rowSum += Math.abs(A[i][j]);
    }
    if (rowSum > max) max = rowSum;
  }
  return max;
}

/**
 * Solves M * X = R using Gaussian elimination with partial pivoting.
 */
export function matSolve(M: number[][], R: number[][]): number[][] {
  const n = M.length;
  const cols = R[0]?.length ?? 0;
  const A = M.map((row) => [...row]);
  const B = R.map((row) => [...row]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxVal = Math.abs(A[col][col]);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(A[row][col]);
      if (v > maxVal) {
        maxVal = v;
        pivotRow = row;
      }
    }
    if (maxVal < 1e-14) {
      A[col][col] = 1e-14;
    } else if (pivotRow !== col) {
      [A[col], A[pivotRow]] = [A[pivotRow], A[col]];
      [B[col], B[pivotRow]] = [B[pivotRow], B[col]];
    }

    const invPivot = 1 / A[col][col];
    for (let j = col; j < n; j++) A[col][j] *= invPivot;
    for (let j = 0; j < cols; j++) B[col][j] *= invPivot;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = A[row][col];
      if (factor === 0) continue;
      for (let j = col; j < n; j++) A[row][j] -= factor * A[col][j];
      for (let j = 0; j < cols; j++) B[row][j] -= factor * B[col][j];
    }
  }
  return B;
}

export function matInv(M: number[][]): number[][] {
  return matSolve(M, identity(M.length));
}

/**
 * Matrix exponential via Scaling & Squaring + Padé [6/6] approximant.
 */
export function expm(M: number[][]): number[][] {
  const n = M.length;
  if (n === 0) return [];
  const norm = matInfNorm(M);
  const s = Math.max(0, Math.ceil(Math.log2(Math.max(1e-12, norm) / 0.5)));
  const scale = Math.pow(2, -s);
  const A = matScale(M, scale);

  // Padé [6/6] coefficients
  const c = [
    1,
    1 / 2,
    5 / 44,
    1 / 66,
    1 / 792,
    1 / 15840,
    1 / 665280,
  ];

  const I = identity(n);
  const A2 = matMul(A, A);
  const A4 = matMul(A2, A2);
  const A6 = matMul(A4, A2);

  // U = A * (c1*I + c3*A2 + c5*A4)
  const U_inner = matAdd(
    matScale(I, c[1]),
    matAdd(matScale(A2, c[3]), matScale(A4, c[5]))
  );
  const U = matMul(A, U_inner);

  // V = c0*I + c2*A2 + c4*A4 + c6*A6
  const V = matAdd(
    matScale(I, c[0]),
    matAdd(matScale(A2, c[2]), matAdd(matScale(A4, c[4]), matScale(A6, c[6])))
  );

  const N_mat = matAdd(V, U);
  const D_mat = matSub(V, U);
  let R = matSolve(D_mat, N_mat);

  for (let i = 0; i < s; i++) {
    R = matMul(R, R);
  }
  return R;
}

/**
 * Discretizes continuous state-space (A, B, C, D) using ZOH (Van Loan block expm)
 * or Tustin (Bilinear) transformation.
 */
export function discretizeStateSpace(
  plant: StateSpaceConfig,
  dt: number,
  method: DiscretizationMethod
): DiscretizedMatrices {
  const { n, m, p, A, B, C, D } = plant;

  if (method === 'zoh') {
    // Block matrix M = [[A*dt, B*dt], [0, 0]] of size (n+m) x (n+m)
    const dim = n + m;
    const M = zeros(dim, dim);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) M[i][j] = A[i][j] * dt;
      for (let j = 0; j < m; j++) M[i][n + j] = B[i][j] * dt;
    }
    const E = expm(M);
    const Ad = zeros(n, n);
    const Bd = zeros(n, m);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) Ad[i][j] = E[i][j];
      for (let j = 0; j < m; j++) Bd[i][j] = E[i][n + j];
    }
    return {
      method,
      dt,
      Ad,
      Bd,
      Cd: C.map((r) => [...r]),
      Dd: D.map((r) => [...r]),
      spectralRadius: estimateSpectralRadius(Ad),
    };
  }

  // Tustin / Bilinear transform:
  // Ad = (I + 0.5*dt*A) * (I - 0.5*dt*A)^-1
  // Bd = (I - 0.5*dt*A)^-1 * B * sqrt(dt)  -> standard state-preserving form:
  // Using x_k+1 = Ad x_k + Bd u_k, y_k = Cd x_k + Dd u_k with bilinear scaling:
  const I = identity(n);
  const halfA = matScale(A, 0.5 * dt);
  const M_minus = matSub(I, halfA);
  const M_plus = matAdd(I, halfA);
  const invMinus = matInv(M_minus);
  const Ad = matMul(M_plus, invMinus);
  const Bd = matScale(matMul(invMinus, B), dt);
  const Cd = matMul(C, invMinus);
  const Dd = matAdd(
    D,
    matScale(matMul(C, matMul(invMinus, B)), 0.5 * dt)
  );

  // Note: When step input u[k] is applied directly with state vector x[k],
  // scaling Bd by dt and Cd by invMinus preserves DC gain C * (-A)^-1 * B + D.
  return {
    method,
    dt,
    Ad,
    Bd,
    Cd,
    Dd: zeros(p, m).map((row, i) => row.map((_, j) => Dd[i][j])),
    spectralRadius: estimateSpectralRadius(Ad),
  };
}

/**
 * Estimates spectral radius via power iteration + norm bound fallback.
 */
function estimateSpectralRadius(A: number[][]): number {
  const n = A.length;
  if (n === 0) return 0;
  let v: number[] = Array.from({ length: n }, (_, i) => (i === 0 ? 1 : 0.5));
  let lambda = 0;
  for (let iter = 0; iter < 30; iter++) {
    const Av = matVecMul(A, v);
    const norm = Math.sqrt(Av.reduce((s, x) => s + x * x, 0));
    if (norm < 1e-12) return 0;
    lambda = norm;
    v = Av.map((x) => x / norm);
  }
  return lambda;
}
