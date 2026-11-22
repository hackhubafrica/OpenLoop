import { ControlModel } from '../types/control';
import { computeMatrixEigenvalues } from './stability';

export interface BodePoint {
  omega: number; // rad/s
  hz: number;
  magDb: number;
  phaseDeg: number;
}

export interface StabilityMargins {
  gainMarginDb: number | null;
  phaseCrossoverOmega: number | null;
  phaseMarginDeg: number | null;
  gainCrossoverOmega: number | null;
  closedLoopStableHint: 'MARGIN_POSITIVE' | 'MARGIN_NEGATIVE' | 'OPEN_LOOP_UNSTABLE' | 'NO_CROSSOVER';
}

export interface BodeAnalysis {
  points: BodePoint[];
  margins: StabilityMargins;
  omegaMin: number;
  omegaMax: number;
  dcGainDb: number;
  peakMagDb: number;
  peakOmega: number;
  bandwidthOmega: number | null;
}

/**
 * Solves complex linear system (M_re + j*M_im) * x = (b_re + j*b_im)
 * via Gaussian elimination with partial pivoting.
 */
function solveComplexSystem(
  mRe: number[][],
  mIm: number[][],
  bRe: number[],
  bIm: number[]
): { xRe: number[]; xIm: number[] } {
  const n = mRe.length;
  const aRe = mRe.map((r) => [...r]);
  const aIm = mIm.map((r) => [...r]);
  const rhsRe = [...bRe];
  const rhsIm = [...bIm];

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxMag = Math.hypot(aRe[col][col], aIm[col][col]);
    for (let row = col + 1; row < n; row++) {
      const mag = Math.hypot(aRe[row][col], aIm[row][col]);
      if (mag > maxMag) {
        maxMag = mag;
        pivotRow = row;
      }
    }

    if (pivotRow !== col) {
      [aRe[col], aRe[pivotRow]] = [aRe[pivotRow], aRe[col]];
      [aIm[col], aIm[pivotRow]] = [aIm[pivotRow], aIm[col]];
      [rhsRe[col], rhsRe[pivotRow]] = [rhsRe[pivotRow], rhsRe[col]];
      [rhsIm[col], rhsIm[pivotRow]] = [rhsIm[pivotRow], rhsIm[col]];
    }

    let pRe = aRe[col][col];
    let pIm = aIm[col][col];
    let denom = pRe * pRe + pIm * pIm;
    if (denom < 1e-24) {
      pRe = 1e-12;
      pIm = 0;
      denom = 1e-24;
    }

    // Divide pivot row by pivot
    for (let j = col; j < n; j++) {
      const re = aRe[col][j];
      const im = aIm[col][j];
      aRe[col][j] = (re * pRe + im * pIm) / denom;
      aIm[col][j] = (im * pRe - re * pIm) / denom;
    }
    const br = rhsRe[col];
    const bi = rhsIm[col];
    rhsRe[col] = (br * pRe + bi * pIm) / denom;
    rhsIm[col] = (bi * pRe - br * pIm) / denom;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const fRe = aRe[row][col];
      const fIm = aIm[row][col];
      if (fRe === 0 && fIm === 0) continue;

      for (let j = col; j < n; j++) {
        const cRe = aRe[col][j];
        const cIm = aIm[col][j];
        aRe[row][j] -= fRe * cRe - fIm * cIm;
        aIm[row][j] -= fRe * cIm + fIm * cRe;
      }
      rhsRe[row] -= fRe * rhsRe[col] - fIm * rhsIm[col];
      rhsIm[row] -= fRe * rhsIm[col] + fIm * rhsRe[col];
    }
  }

  return { xRe: rhsRe, xIm: rhsIm };
}

function evalPidComplex(
  model: ControlModel,
  omega: number
): { re: number; im: number } {
  if (!model.pid.enabled) return { re: 1, im: 0 };
  const { kp, ki, kd, nFilter } = model.pid;
  // C_pid(jw) = Kp + Ki/(jw) + Kd * (N * jw) / (jw + N)
  const iRe = 0;
  const iIm = -ki / Math.max(1e-9, omega);

  const denom = nFilter * nFilter + omega * omega;
  const dRe = (kd * nFilter * omega * omega) / denom;
  const dIm = (kd * nFilter * nFilter * omega) / denom;

  return {
    re: kp + iRe + dRe,
    im: iIm + dIm,
  };
}

export function computeBodeAnalysis(
  model: ControlModel,
  outputIndex: number,
  mode: 'plant' | 'open_loop',
  inputIndex: number = 0
): BodeAnalysis {
  const { n, m, A, B, C, D } = model.plant;
  const safeOutIdx = Math.min(Math.max(0, outputIndex), Math.max(0, C.length - 1));
  const safeInIdx = Math.min(Math.max(0, inputIndex), Math.max(0, m - 1));

  // Scale frequency range automatically around the sample rate / Nyquist
  const nyquistOmega = Math.PI / Math.max(1e-6, model.baseDt);
  const omegaMax = Math.max(100, Math.pow(10, Math.ceil(Math.log10(nyquistOmega * 2))));
  const omegaMin = Math.max(0.05, omegaMax / 1e5);

  const numPts = 220;
  const logMin = Math.log10(omegaMin);
  const logMax = Math.log10(omegaMax);

  const points: BodePoint[] = [];
  let prevRawPhase = 0;

  for (let k = 0; k < numPts; k++) {
    const frac = k / (numPts - 1);
    const omega = Math.pow(10, logMin + frac * (logMax - logMin));

    // Build (jw*I - A)
    const mRe = A.map((row) => row.map((v) => -v));
    const mIm = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (__, j) => (i === j ? omega : 0))
    );
    const bRe = B.map((row) => row[safeInIdx] ?? 0);
    const bIm = Array(n).fill(0);

    const { xRe, xIm } = solveComplexSystem(mRe, mIm, bRe, bIm);

    // G(jw) = C[out] * x + D[out][in]
    let gRe = D[safeOutIdx]?.[safeInIdx] ?? 0;
    let gIm = 0;
    for (let j = 0; j < n; j++) {
      const cVal = C[safeOutIdx]?.[j] ?? 0;
      gRe += cVal * xRe[j];
      gIm += cVal * xIm[j];
    }

    let respRe = gRe;
    let respIm = gIm;

    if (mode === 'open_loop' && model.pid.enabled) {
      const pidC = evalPidComplex(model, omega);
      respRe = pidC.re * gRe - pidC.im * gIm;
      respIm = pidC.re * gIm + pidC.im * gRe;
    }

    const mag = Math.hypot(respRe, respIm);
    const magDb = 20 * Math.log10(Math.max(1e-12, mag));
    let rawPhase = (Math.atan2(respIm, respRe) * 180) / Math.PI;

    // Continuous phase unwrapping
    if (k > 0) {
      let diff = rawPhase - prevRawPhase;
      while (diff > 180) {
        rawPhase -= 360;
        diff = rawPhase - prevRawPhase;
      }
      while (diff < -180) {
        rawPhase += 360;
        diff = rawPhase - prevRawPhase;
      }
    }
    prevRawPhase = rawPhase;

    points.push({
      omega,
      hz: omega / (2 * Math.PI),
      magDb,
      phaseDeg: rawPhase,
    });
  }

  // Detect Gain Crossover (magDb crosses 0 dB) and Phase Crossover (phase crosses -180 or +180)
  let gainCrossoverOmega: number | null = null;
  let phaseMarginDeg: number | null = null;
  let phaseCrossoverOmega: number | null = null;
  let gainMarginDb: number | null = null;

  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1];
    const p1 = points[i];

    // 0 dB crossing
    if (
      gainCrossoverOmega === null &&
      ((p0.magDb >= 0 && p1.magDb <= 0) || (p0.magDb <= 0 && p1.magDb >= 0))
    ) {
      const denom = p1.magDb - p0.magDb;
      const t = Math.abs(denom) > 1e-12 ? (0 - p0.magDb) / denom : 0.5;
      const logW =
        Math.log10(p0.omega) + t * (Math.log10(p1.omega) - Math.log10(p0.omega));
      gainCrossoverOmega = Math.pow(10, logW);
      const interpPhase = p0.phaseDeg + t * (p1.phaseDeg - p0.phaseDeg);
      // Wrap phase margin cleanly into [-180, 180] around -180 deg critical point
      let pm = 180 + interpPhase;
      while (pm > 180) pm -= 360;
      while (pm < -180) pm += 360;
      phaseMarginDeg = pm;
    }

    // -180 deg crossing (or +180 deg equivalent)
    for (const targetPhase of [-180, 180, -540]) {
      if (
        phaseCrossoverOmega === null &&
        ((p0.phaseDeg >= targetPhase && p1.phaseDeg <= targetPhase) ||
          (p0.phaseDeg <= targetPhase && p1.phaseDeg >= targetPhase))
      ) {
        const denom = p1.phaseDeg - p0.phaseDeg;
        const t = Math.abs(denom) > 1e-12 ? (targetPhase - p0.phaseDeg) / denom : 0.5;
        const logW =
          Math.log10(p0.omega) + t * (Math.log10(p1.omega) - Math.log10(p0.omega));
        phaseCrossoverOmega = Math.pow(10, logW);
        const interpMagDb = p0.magDb + t * (p1.magDb - p0.magDb);
        gainMarginDb = -interpMagDb;
      }
    }
  }

  const dcGainDb = points[0]?.magDb ?? 0;
  let peakMagDb = points[0]?.magDb ?? 0;
  let peakOmega = points[0]?.omega ?? omegaMin;
  for (const pt of points) {
    if (pt.magDb > peakMagDb) {
      peakMagDb = pt.magDb;
      peakOmega = pt.omega;
    }
  }

  // -3 dB cutoff frequency relative to low-frequency gain
  const cutoffTargetDb = dcGainDb - 3.0103;
  let bandwidthOmega: number | null = null;
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1];
    const p1 = points[i];
    if (p0.magDb >= cutoffTargetDb && p1.magDb < cutoffTargetDb) {
      const denom = p1.magDb - p0.magDb;
      const t = Math.abs(denom) > 1e-12 ? (cutoffTargetDb - p0.magDb) / denom : 0.5;
      const logW =
        Math.log10(p0.omega) + t * (Math.log10(p1.omega) - Math.log10(p0.omega));
      bandwidthOmega = Math.pow(10, logW);
      break;
    }
  }

  const openLoopEigs = computeMatrixEigenvalues(A);
  const hasOpenLoopRhpPole = openLoopEigs.some((e) => e.re > 1e-6);

  let closedLoopStableHint: StabilityMargins['closedLoopStableHint'] = 'NO_CROSSOVER';
  if (hasOpenLoopRhpPole && mode === 'plant') {
    closedLoopStableHint = 'OPEN_LOOP_UNSTABLE';
  } else if (phaseMarginDeg !== null || gainMarginDb !== null) {
    const pmOk = phaseMarginDeg === null || phaseMarginDeg > 0;
    const gmOk = gainMarginDb === null || gainMarginDb > 0;
    closedLoopStableHint = pmOk && gmOk ? 'MARGIN_POSITIVE' : 'MARGIN_NEGATIVE';
  }

  return {
    points,
    margins: {
      gainMarginDb,
      phaseCrossoverOmega,
      phaseMarginDeg,
      gainCrossoverOmega,
      closedLoopStableHint,
    },
    omegaMin,
    omegaMax,
    dcGainDb,
    peakMagDb,
    peakOmega,
    bandwidthOmega,
  };
}

export interface NyquistPoint {
  omega: number;
  hz: number;
  re: number;
  im: number;
  mag: number;
  magDb: number;
  phaseDeg: number;
}

export interface NyquistAnalysis {
  points: NyquistPoint[];
  margins: StabilityMargins;
  gainCrossoverPoint: { re: number; im: number; omega: number } | null;
  phaseCrossoverPoint: {
    re: number;
    im: number;
    omega: number;
    linearGainMargin: number;
  } | null;
  closestPoint: {
    re: number;
    im: number;
    omega: number;
    distance: number;
    sensitivityPeakMs: number;
  } | null;
  openLoopRhpPoles: number;
  cwEncirclements: number;
  verdict: 'STABLE_MARGIN' | 'UNSTABLE_MARGIN' | 'OPEN_LOOP_RHP' | 'NO_CROSSOVER';
  omegaMin: number;
  omegaMax: number;
}

function normalizeAngleDiff(delta: number): number {
  let d = delta;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * Computes the complex-plane Nyquist locus L(jw) = Re + j*Im (plant G(jw) or
 * loop C_pid(jw)*G(jw)) along with gain/phase crossover geometry around (-1, 0),
 * minimum vector distance (1/Ms), and Nyquist stability criterion metrics.
 */
export function computeNyquistAnalysis(
  model: ControlModel,
  outputIndex: number,
  mode: 'plant' | 'open_loop' = 'open_loop',
  inputIndex: number = 0
): NyquistAnalysis {
  const { n, m, A, B, C, D } = model.plant;
  const safeOutIdx = Math.min(Math.max(0, outputIndex), Math.max(0, C.length - 1));
  const safeInIdx = Math.min(Math.max(0, inputIndex), Math.max(0, m - 1));

  const nyquistOmega = Math.PI / Math.max(1e-6, model.baseDt);
  const omegaMax = Math.max(100, Math.pow(10, Math.ceil(Math.log10(nyquistOmega * 3))));
  const omegaMin = Math.max(0.01, omegaMax / 1e5);

  const numPts = 280;
  const logMin = Math.log10(omegaMin);
  const logMax = Math.log10(omegaMax);

  const points: NyquistPoint[] = [];
  let prevRawPhase = 0;

  for (let k = 0; k < numPts; k++) {
    const frac = k / (numPts - 1);
    const omega = Math.pow(10, logMin + frac * (logMax - logMin));

    const mRe = A.map((row) => row.map((v) => -v));
    const mIm = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (__, j) => (i === j ? omega : 0))
    );
    const bRe = B.map((row) => row[safeInIdx] ?? 0);
    const bIm = Array(n).fill(0);

    const { xRe, xIm } = solveComplexSystem(mRe, mIm, bRe, bIm);

    let gRe = D[safeOutIdx]?.[safeInIdx] ?? 0;
    let gIm = 0;
    for (let j = 0; j < n; j++) {
      const cVal = C[safeOutIdx]?.[j] ?? 0;
      gRe += cVal * xRe[j];
      gIm += cVal * xIm[j];
    }

    let respRe = gRe;
    let respIm = gIm;

    if (mode === 'open_loop' && model.pid.enabled) {
      const pidC = evalPidComplex(model, omega);
      respRe = pidC.re * gRe - pidC.im * gIm;
      respIm = pidC.re * gIm + pidC.im * gRe;
    }

    const mag = Math.hypot(respRe, respIm);
    const magDb = 20 * Math.log10(Math.max(1e-12, mag));
    let rawPhase = (Math.atan2(respIm, respRe) * 180) / Math.PI;

    if (k > 0) {
      let diff = rawPhase - prevRawPhase;
      while (diff > 180) {
        rawPhase -= 360;
        diff = rawPhase - prevRawPhase;
      }
      while (diff < -180) {
        rawPhase += 360;
        diff = rawPhase - prevRawPhase;
      }
    }
    prevRawPhase = rawPhase;

    points.push({
      omega,
      hz: omega / (2 * Math.PI),
      re: respRe,
      im: respIm,
      mag,
      magDb,
      phaseDeg: rawPhase,
    });
  }

  let gainCrossoverOmega: number | null = null;
  let phaseMarginDeg: number | null = null;
  let gainCrossoverPoint: NyquistAnalysis['gainCrossoverPoint'] = null;

  let phaseCrossoverOmega: number | null = null;
  let gainMarginDb: number | null = null;
  let phaseCrossoverPoint: NyquistAnalysis['phaseCrossoverPoint'] = null;

  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1];
    const p1 = points[i];

    // Unit circle crossing (|L(jw)| = 1, 0 dB)
    if (
      gainCrossoverOmega === null &&
      ((p0.magDb >= 0 && p1.magDb <= 0) || (p0.magDb <= 0 && p1.magDb >= 0))
    ) {
      const denom = p1.magDb - p0.magDb;
      const t = Math.abs(denom) > 1e-12 ? (0 - p0.magDb) / denom : 0.5;
      const logW =
        Math.log10(p0.omega) + t * (Math.log10(p1.omega) - Math.log10(p0.omega));
      gainCrossoverOmega = Math.pow(10, logW);
      const interpPhase = p0.phaseDeg + t * (p1.phaseDeg - p0.phaseDeg);
      let pm = 180 + interpPhase;
      while (pm > 180) pm -= 360;
      while (pm < -180) pm += 360;
      phaseMarginDeg = pm;

      const rad = (interpPhase * Math.PI) / 180;
      gainCrossoverPoint = {
        re: Math.cos(rad),
        im: Math.sin(rad),
        omega: gainCrossoverOmega,
      };
    }

    // Negative real axis crossing (-180 deg / +180 deg equivalent)
    for (const targetPhase of [-180, 180, -540]) {
      if (
        phaseCrossoverOmega === null &&
        ((p0.phaseDeg >= targetPhase && p1.phaseDeg <= targetPhase) ||
          (p0.phaseDeg <= targetPhase && p1.phaseDeg >= targetPhase))
      ) {
        const denom = p1.phaseDeg - p0.phaseDeg;
        const t = Math.abs(denom) > 1e-12 ? (targetPhase - p0.phaseDeg) / denom : 0.5;
        const logW =
          Math.log10(p0.omega) + t * (Math.log10(p1.omega) - Math.log10(p0.omega));
        phaseCrossoverOmega = Math.pow(10, logW);
        const interpMagDb = p0.magDb + t * (p1.magDb - p0.magDb);
        gainMarginDb = -interpMagDb;
        const interpRe = p0.re + t * (p1.re - p0.re);
        const absCrossing = Math.max(1e-9, Math.abs(interpRe));
        phaseCrossoverPoint = {
          re: interpRe < 0 ? interpRe : -Math.pow(10, interpMagDb / 20),
          im: 0,
          omega: phaseCrossoverOmega,
          linearGainMargin: 1 / absCrossing,
        };
      }
    }
  }

  // Closest point to critical (-1, 0) => Vector Margin & Sensitivity Peak Ms
  let closestPoint: NyquistAnalysis['closestPoint'] = null;
  for (const pt of points) {
    const dist = Math.hypot(pt.re + 1, pt.im);
    if (!closestPoint || dist < closestPoint.distance) {
      closestPoint = {
        re: pt.re,
        im: pt.im,
        omega: pt.omega,
        distance: dist,
        sensitivityPeakMs: 1 / Math.max(1e-6, dist),
      };
    }
  }

  const openLoopEigs = computeMatrixEigenvalues(A);
  const openLoopRhpPoles = openLoopEigs.filter((e) => e.re > 1e-6).length;

  // Compute net clockwise encirclements N around (-1, 0) using symmetric D-contour
  let cwEncirclements = 0;
  if (points.length >= 2) {
    const negBranch = points
      .slice()
      .reverse()
      .map((p) => ({ re: p.re, im: -p.im }));
    const contour: Array<{ re: number; im: number }> = [...points, ...negBranch];

    const first = points[0];
    const lastNeg = negBranch[negBranch.length - 1];
    if (Math.hypot(first.re, first.im) > 5 || Math.abs(first.im) > 0.5) {
      const rArc = Math.max(12, Math.hypot(first.re, first.im) * 1.4);
      contour.push({ re: rArc, im: 0 });
    } else if (Math.abs(lastNeg.im) > 1e-6) {
      contour.push({ re: first.re, im: 0 });
    }
    contour.push({ re: points[0].re, im: points[0].im });

    let totalCwAngle = 0;
    for (let i = 1; i < contour.length; i++) {
      const a0 = Math.atan2(contour[i - 1].im, contour[i - 1].re + 1);
      const a1 = Math.atan2(contour[i].im, contour[i].re + 1);
      totalCwAngle += -normalizeAngleDiff(a1 - a0);
    }
    cwEncirclements = Math.round(totalCwAngle / (2 * Math.PI));
    if (Object.is(cwEncirclements, -0)) cwEncirclements = 0;
  }

  let closedLoopStableHint: StabilityMargins['closedLoopStableHint'] = 'NO_CROSSOVER';
  let verdict: NyquistAnalysis['verdict'] = 'NO_CROSSOVER';

  if (openLoopRhpPoles > 0 && mode === 'plant') {
    closedLoopStableHint = 'OPEN_LOOP_UNSTABLE';
    verdict = 'OPEN_LOOP_RHP';
  } else if (phaseMarginDeg !== null || gainMarginDb !== null) {
    const pmOk = phaseMarginDeg === null || phaseMarginDeg > 0;
    const gmOk = gainMarginDb === null || gainMarginDb > 0;
    closedLoopStableHint = pmOk && gmOk ? 'MARGIN_POSITIVE' : 'MARGIN_NEGATIVE';
    verdict =
      pmOk && gmOk && (openLoopRhpPoles === 0 || cwEncirclements === -openLoopRhpPoles)
        ? 'STABLE_MARGIN'
        : 'UNSTABLE_MARGIN';
  } else if (cwEncirclements !== 0) {
    verdict = 'UNSTABLE_MARGIN';
  }

  return {
    points,
    margins: {
      gainMarginDb,
      phaseCrossoverOmega,
      phaseMarginDeg,
      gainCrossoverOmega,
      closedLoopStableHint,
    },
    gainCrossoverPoint,
    phaseCrossoverPoint,
    closestPoint,
    openLoopRhpPoles,
    cwEncirclements,
    verdict,
    omegaMin,
    omegaMax,
  };
}
