import { ControlModel, PidConfig } from '../types/control';
import {
  analyzeSystemStability,
  computeImpulseResponse,
  computePoleZeroStabilitySummary,
  computeTransferFunctionStepResponse,
  stateSpaceToTransferFunction,
  StabilityVerdict,
} from './stability';
import { Esp32BoardEnv, ESP32_BOARD_SPECS } from './esp32Codegen';

export interface PidAutoTuneConstraints {
  targetRiseTimeSec: number;
  maxOvershootPct: number;
  maxSettlingTimeSec?: number;
  objective?: 'balanced' | 'min_settling_time';
  esp32Board?: Esp32BoardEnv;
}

export interface PidAutoTuneResult {
  recommendedPid: Pick<PidConfig, 'kp' | 'ki' | 'kd' | 'nFilter'>;
  achievedRiseTimeSec: number | null;
  achievedOvershootPct: number | null;
  achievedSettlingTimeSec: number | null;
  baselineSettlingTimeSec: number | null;
  closedLoopVerdict: StabilityVerdict;
  phaseMarginDeg: number | null;
  gainMarginDb: number | null;
  dampingRatio: number | null;
  meetsConstraints: boolean;
  objective: 'balanced' | 'min_settling_time';
  targetModelId: string;
  targetModelName: string;
  esp32BoardLabel: string;
  loopRateHz: number;
  strategySummary: string;
  iterationsEvaluated: number;
}

function roundGain(val: number): number {
  if (!Number.isFinite(val) || Math.abs(val) < 1e-12) return 0;
  return Number(val.toPrecision(4));
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

/**
 * Returns model-appropriate default rise-time and overshoot targets, tailored
 * to the ESP32 embedded hardware templates as well as standard workbench plants.
 */
export function getRecommendedAutoTuneDefaults(
  model: ControlModel
): PidAutoTuneConstraints {
  if (model.id === 'esp32_ultrasonic_hold') {
    return {
      targetRiseTimeSec: 0.45,
      maxOvershootPct: 8,
    };
  }
  if (model.id === 'esp32_gas_humidity_relay') {
    return {
      targetRiseTimeSec: 1.4,
      maxOvershootPct: 5,
    };
  }
  if (model.id === 'buck' || model.basePreset === 'buck') {
    return {
      targetRiseTimeSec: 0.0025,
      maxOvershootPct: 6,
    };
  }
  if (model.id === 'dcmotor' || model.basePreset === 'dcmotor') {
    return {
      targetRiseTimeSec: 0.14,
      maxOvershootPct: 8,
    };
  }
  if (model.id === 'pendulum' || model.basePreset === 'pendulum') {
    return {
      targetRiseTimeSec: 0.55,
      maxOvershootPct: 10,
    };
  }
  const est = clamp(Number((model.duration * 0.15).toPrecision(2)), model.baseDt * 4, 2.5);
  return {
    targetRiseTimeSec: est,
    maxOvershootPct: 8,
  };
}

function buildEffectiveOpenPlantAfterLqr(model: ControlModel) {
  const { n, A, B, C, D } = model.plant;
  const bCol = B.map((r) => r[0] ?? 0);
  const effectiveA = A.map((row, i) =>
    row.map((val, j) => val - bCol[i] * (model.lqrK[j] ?? 0))
  );
  return {
    ...model.plant,
    A: effectiveA,
    C,
    D,
    n,
  };
}

function evalPolyJw(coeffs: number[], omega: number): { re: number; im: number } {
  let re = 0;
  let im = 0;
  for (let i = 0; i < coeffs.length; i++) {
    // Multiply accumulated (re + j*im) by j*omega => (-omega*im + j*omega*re)
    const nextRe = -omega * im + coeffs[i];
    const nextIm = omega * re;
    re = nextRe;
    im = nextIm;
  }
  return { re, im };
}

function evalSisoFrequencyResponse(
  num: number[],
  den: number[],
  omega: number
): { re: number; im: number; mag: number; phaseDeg: number } {
  const nVal = evalPolyJw(num, omega);
  const dVal = evalPolyJw(den, omega);
  const denomMag2 = Math.max(1e-24, dVal.re * dVal.re + dVal.im * dVal.im);
  const re = (nVal.re * dVal.re + nVal.im * dVal.im) / denomMag2;
  const im = (nVal.im * dVal.re - nVal.re * dVal.im) / denomMag2;
  const mag = Math.hypot(re, im);
  const phaseDeg = (Math.atan2(im, re) * 180) / Math.PI;
  return { re, im, mag, phaseDeg };
}

interface CandidateEval {
  kp: number;
  ki: number;
  kd: number;
  nFilter: number;
  cost: number;
  verdict: StabilityVerdict;
  riseTimeSec: number | null;
  overshootPct: number | null;
  settlingTimeSec: number | null;
  phaseMarginDeg: number | null;
  gainMarginDb: number | null;
  dampingRatio: number | null;
  meetsConstraints: boolean;
}

/**
 * Computes optimal PID gains (Kp, Ki, Kd, N) for the active model subject to
 * desired closed-loop 10–90% rise time and maximum percentage overshoot constraints,
 * honoring ESP32 sampling frequency / Nyquist derivative filter limits.
 */
export function autoTunePidGains(
  model: ControlModel,
  constraints: PidAutoTuneConstraints
): PidAutoTuneResult {
  const safeDt = Math.max(1e-5, model.baseDt);
  const loopRateHz = Math.round(1 / safeDt);
  const objective: 'balanced' | 'min_settling_time' =
    constraints.objective === 'min_settling_time' ? 'min_settling_time' : 'balanced';

  const minRise = Math.max(safeDt * 2.2, 1e-4);
  const maxRise = Math.max(minRise * 2, Math.max(model.duration, 10));
  const defaults = getRecommendedAutoTuneDefaults(model);
  const targetRise = clamp(
    Number.isFinite(constraints.targetRiseTimeSec)
      ? constraints.targetRiseTimeSec
      : defaults.targetRiseTimeSec,
    minRise,
    maxRise
  );
  const maxOvershoot = clamp(
    Number.isFinite(constraints.maxOvershootPct)
      ? constraints.maxOvershootPct
      : defaults.maxOvershootPct,
    0,
    50
  );
  const maxSettlingTimeSec =
    constraints.maxSettlingTimeSec !== undefined &&
    Number.isFinite(constraints.maxSettlingTimeSec) &&
    constraints.maxSettlingTimeSec > 0
      ? constraints.maxSettlingTimeSec
      : undefined;

  const outIdx = clamp(
    model.pid.targetOutputIndex,
    0,
    Math.max(0, model.plant.C.length - 1)
  );

  // Target 2nd-order damping & crossover frequency from (tr, OS_max)
  const mp = Math.max(0.004, maxOvershoot / 100);
  const zetaTarget =
    maxOvershoot <= 0.5
      ? 1.02
      : clamp(-Math.log(mp) / Math.sqrt(Math.PI * Math.PI + Math.log(mp) ** 2), 0.25, 0.98);

  // Accurate approximation tr * wn ~ 1 + 1.1*zeta + 1.4*zeta^2
  const wnBase = (1.0 + 1.1 * zetaTarget + 1.4 * zetaTarget * zetaTarget) / targetRise;
  const wnFromSettling = maxSettlingTimeSec
    ? 4.2 / Math.max(0.05, zetaTarget * maxSettlingTimeSec)
    : wnBase;
  const wnTarget =
    objective === 'min_settling_time'
      ? Math.max(wnBase * 1.15, wnFromSettling)
      : wnBase;

  const wcRatio = Math.sqrt(
    Math.sqrt(1 + 4 * zetaTarget ** 4) - 2 * zetaTarget * zetaTarget
  );
  const omegaC = Math.max(0.1, wnTarget * Math.max(0.45, wcRatio));
  const targetPhaseMarginDeg = clamp(
    (Math.atan((2 * zetaTarget) / Math.sqrt(Math.sqrt(1 + 4 * zetaTarget ** 4) - 2 * zetaTarget ** 2)) *
      180) /
      Math.PI,
    35,
    82
  );

  // Respect Nyquist bandwidth of the ESP32 loop cadence for derivative low-pass filter N
  const nyquistSafeN = Math.max(4, Math.round(0.95 / safeDt));
  const desiredN = Math.round(clamp(wnTarget * 4.5, 4, nyquistSafeN));
  const nFilter = clamp(
    desiredN,
    Math.min(4, nyquistSafeN),
    Math.max(model.pid.nFilter, nyquistSafeN)
  );

  // Analytical loop-shaping seed using effective SISO plant (after LQR damping)
  const effPlant = buildEffectiveOpenPlantAfterLqr(model);
  const tf = stateSpaceToTransferFunction(effPlant, outIdx, 0);
  const respWc = evalSisoFrequencyResponse(tf.numerator, tf.denominator, omegaC);
  const respDc = evalSisoFrequencyResponse(
    tf.numerator,
    tf.denominator,
    Math.min(0.05, omegaC * 0.05)
  );

  const baselineSign =
    Math.abs(model.pid.kp) > 1e-12 ? Math.sign(model.pid.kp) : 1;
  const dcSign =
    Math.abs(respDc.re) > 1e-9
      ? Math.sign(respDc.re)
      : baselineSign;
  const gainSign = model.pid.tracksStepRef ? dcSign : baselineSign;

  const plantMagWc = Math.max(1e-6, respWc.mag);
  const rawKp = (1 / plantMagWc) * Math.min(1.15, Math.max(0.65, zetaTarget + 0.15));
  // Phase deficit relative to desired (-180 + PM)
  const phaseBoostNeeded = clamp(
    -180 + targetPhaseMarginDeg - respWc.phaseDeg,
    -20,
    75
  );
  const tdFactor =
    phaseBoostNeeded > 5
      ? clamp(Math.tan((phaseBoostNeeded * Math.PI) / 180) / omegaC, 0.05 / omegaC, 0.65 / omegaC)
      : 0.12 / omegaC;
  const tiFactor = Math.max(tdFactor * 5.0, 2.8 / (zetaTarget * omegaC));

  const seedAnalytical = {
    kp: gainSign * rawKp,
    ki: gainSign * (rawKp / tiFactor),
    kd: gainSign * (rawKp * tdFactor),
  };

  // Second anchor: existing/baseline PID
  const hasUsableBaseline =
    Math.abs(model.pid.kp) > 1e-9 &&
    (Math.abs(model.pid.ki) > 1e-9 || Math.abs(model.pid.kd) > 1e-9);
  const seedBaseline = hasUsableBaseline
    ? {
        kp: model.pid.kp,
        ki: model.pid.ki,
        kd: model.pid.kd,
      }
    : seedAnalytical;

  const evalHorizon = clamp(
    Math.max(targetRise * 7.5, maxSettlingTimeSec ? maxSettlingTimeSec * 2.5 : 0, model.duration * 0.9),
    Math.max(safeDt * 40, targetRise * 4),
    Math.max(25, model.duration * 1.5)
  );

  const baselineStep = model.pid.tracksStepRef
    ? computeTransferFunctionStepResponse(model, 'closed', outIdx, 0, evalHorizon, 90)
    : null;
  const baselineSettlingTimeSec = baselineStep?.settlingTimeSec ?? null;

  let iterationsEvaluated = 0;

  const evaluateCandidate = (
    kpRaw: number,
    kiRaw: number,
    kdRaw: number,
    highRes = false
  ): CandidateEval => {
    iterationsEvaluated++;
    const kp = kpRaw;
    const ki = kiRaw;
    const kd = kdRaw;

    const candModel: ControlModel = {
      ...model,
      pid: {
        ...model.pid,
        enabled: true,
        kp,
        ki,
        kd,
        nFilter,
      },
    };

    const stab = analyzeSystemStability(candModel, outIdx, 0);
    if (stab.closedLoopVerdict !== 'STABLE') {
      return {
        kp,
        ki,
        kd,
        nFilter,
        cost: 1e6 + Math.max(0, stab.maxRealPartClosed) * 1e4,
        verdict: stab.closedLoopVerdict,
        riseTimeSec: null,
        overshootPct: null,
        settlingTimeSec: null,
        phaseMarginDeg: null,
        gainMarginDb: null,
        dampingRatio: null,
        meetsConstraints: false,
      };
    }

    // Ensure fastest stable closed-loop pole stays well below firmware sample aliasing
    const maxClosedMag = Math.max(0, ...stab.closedLoopPoles.map((p) => p.mag));
    if (maxClosedMag * safeDt > 2.4) {
      return {
        kp,
        ki,
        kd,
        nFilter,
        cost: 5e5 + maxClosedMag * safeDt * 1e3,
        verdict: stab.closedLoopVerdict,
        riseTimeSec: null,
        overshootPct: null,
        settlingTimeSec: null,
        phaseMarginDeg: null,
        gainMarginDb: null,
        dampingRatio: null,
        meetsConstraints: false,
      };
    }

    if (!model.pid.tracksStepRef) {
      // Regulator mode (e.g., inverted pendulum angle theta -> 0)
      const pz = computePoleZeroStabilitySummary(candModel, 'closed', outIdx, 0);
      const imp = computeImpulseResponse(
        candModel,
        'closed',
        outIdx,
        0,
        evalHorizon,
        highRes ? 110 : 60
      );
      if (imp.divergent) {
        return {
          kp,
          ki,
          kd,
          nFilter,
          cost: 2e5,
          verdict: 'UNSTABLE',
          riseTimeSec: null,
          overshootPct: null,
          settlingTimeSec: imp.settlingTimeSec,
          phaseMarginDeg: pz.phaseMarginDeg,
          gainMarginDb: pz.gainMarginDb,
          dampingRatio: pz.dampingRatio,
          meetsConstraints: false,
        };
      }
      const zeta = pz.minDampingRatio ?? pz.dampingRatio ?? 0.5;
      const zetaShortfall = Math.max(0, zetaTarget - zeta);
      const settle = imp.settlingTimeSec ?? evalHorizon;
      const settleTarget = maxSettlingTimeSec ?? targetRise * 3.2;
      const cost =
        (objective === 'min_settling_time'
          ? 5.0 * (settle / Math.max(0.05, settleTarget))
          : 3.0 * Math.abs(settle - settleTarget) / Math.max(0.05, settleTarget)) +
        12.0 * zetaShortfall +
        0.15 * imp.l2Energy;

      return {
        kp,
        ki,
        kd,
        nFilter,
        cost,
        verdict: stab.closedLoopVerdict,
        riseTimeSec: settle / 2.2,
        overshootPct: Number((Math.exp((-zeta * Math.PI) / Math.sqrt(Math.max(0.05, 1 - zeta * zeta))) * 100).toFixed(2)),
        settlingTimeSec: imp.settlingTimeSec,
        phaseMarginDeg: pz.phaseMarginDeg,
        gainMarginDb: pz.gainMarginDb,
        dampingRatio: pz.dampingRatio,
        meetsConstraints: zeta >= zetaTarget * 0.9 && settle <= settleTarget * 1.25,
      };
    }

    const stepRes = computeTransferFunctionStepResponse(
      candModel,
      'closed',
      outIdx,
      0,
      evalHorizon,
      highRes ? 120 : 68
    );

    if (stepRes.divergent || stepRes.riseTimeSec === null) {
      return {
        kp,
        ki,
        kd,
        nFilter,
        cost: 1e4 + Math.abs(1 - stepRes.finalValue) * 100,
        verdict: stepRes.divergent ? 'UNSTABLE' : stab.closedLoopVerdict,
        riseTimeSec: stepRes.riseTimeSec,
        overshootPct: stepRes.overshootPct,
        settlingTimeSec: stepRes.settlingTimeSec,
        phaseMarginDeg: null,
        gainMarginDb: null,
        dampingRatio: null,
        meetsConstraints: false,
      };
    }

    const rt = stepRes.riseTimeSec;
    const os = stepRes.overshootPct ?? 0;
    const ts = stepRes.settlingTimeSec ?? evalHorizon;
    const ssErr = Math.abs(1 - stepRes.finalValue);
    const riseRelErr = Math.abs(rt - targetRise) / Math.max(1e-4, targetRise);
    const overshootViolation = Math.max(0, os - maxOvershoot);
    const overshootZeroGuard = maxOvershoot <= 0.5 ? os * 1.2 : 0;

    const derivKickPenalty =
      Math.abs(kd) > Math.abs(kp) * Math.max(0.01, targetRise * 1.5)
        ? 0.22 * (Math.abs(kd) / Math.max(1e-6, Math.abs(kp) * targetRise) - 1.5)
        : 0;

    let cost: number;
    let meets: boolean;

    if (objective === 'min_settling_time') {
      // Minimize 2% settling time ts while honoring overshoot & steady-state constraints
      const tsNorm = ts / Math.max(0.05, maxSettlingTimeSec ?? targetRise * 3);
      const tsCeilingPenalty = maxSettlingTimeSec
        ? Math.max(0, ts - maxSettlingTimeSec) * 6.0
        : 0;
      const slowSettlePenalty = stepRes.settlingTimeSec === null ? 25.0 : 0;
      cost =
        5.5 * tsNorm +
        tsCeilingPenalty +
        slowSettlePenalty +
        0.95 * overshootViolation +
        0.15 * overshootViolation * overshootViolation +
        overshootZeroGuard +
        8.0 * ssErr +
        0.15 * derivKickPenalty;

      meets =
        stepRes.settlingTimeSec !== null &&
        os <= maxOvershoot + 0.5 &&
        ssErr <= 0.05 &&
        (maxSettlingTimeSec === undefined || ts <= maxSettlingTimeSec + 1e-3);
    } else {
      const settleRatio = ts / Math.max(0.02, targetRise * 5);
      cost =
        4.5 * riseRelErr +
        1.8 * riseRelErr * riseRelErr +
        0.6 * overshootViolation +
        0.08 * overshootViolation * overshootViolation +
        overshootZeroGuard +
        6.0 * ssErr +
        0.35 * settleRatio +
        derivKickPenalty;

      meets =
        rt <= targetRise * 1.18 &&
        rt >= targetRise * 0.45 &&
        os <= maxOvershoot + 0.35 &&
        ssErr <= 0.05;
    }

    let phaseMarginDeg: number | null = null;
    let gainMarginDb: number | null = null;
    let dampingRatio: number | null = null;
    if (highRes) {
      const pz = computePoleZeroStabilitySummary(candModel, 'closed', outIdx, 0);
      phaseMarginDeg = pz.phaseMarginDeg;
      gainMarginDb = pz.gainMarginDb;
      dampingRatio = pz.dampingRatio;
    }

    return {
      kp,
      ki,
      kd,
      nFilter,
      cost,
      verdict: stab.closedLoopVerdict,
      riseTimeSec: rt,
      overshootPct: os,
      settlingTimeSec: stepRes.settlingTimeSec,
      phaseMarginDeg,
      gainMarginDb,
      dampingRatio,
      meetsConstraints: meets,
    };
  };

  // Phase A: Multi-seed coarse grid around analytical loop-shaping seed and baseline seed
  const candidates: CandidateEval[] = [];
  const kpScales =
    objective === 'min_settling_time'
      ? [0.35, 0.7, 1.0, 1.55, 2.4, 3.6]
      : [0.25, 0.55, 1.0, 1.85, 3.4];
  const kiScales = model.pid.tracksStepRef
    ? objective === 'min_settling_time'
      ? [0.35, 0.75, 1.35, 2.4]
      : [0.25, 0.65, 1.25, 2.5]
    : [0, 0.25, 0.65, 1.25];
  const kdScales =
    objective === 'min_settling_time' ? [0.45, 1.0, 1.75, 2.8] : [0.35, 1.0, 2.2];

  const seeds = [seedAnalytical];
  if (
    Math.abs(seedBaseline.kp - seedAnalytical.kp) > 0.1 * Math.abs(seedAnalytical.kp) ||
    Math.abs(seedBaseline.ki - seedAnalytical.ki) > 0.1 * Math.abs(seedAnalytical.ki)
  ) {
    seeds.push(seedBaseline);
  }

  for (const seed of seeds) {
    for (const skp of kpScales) {
      for (const ski of kiScales) {
        for (const skd of kdScales) {
          candidates.push(
            evaluateCandidate(seed.kp * skp, seed.ki * ski, seed.kd * skd, false)
          );
        }
      }
    }
  }

  candidates.sort((a, b) => a.cost - b.cost);
  let best = candidates[0];

  // Phase B: Multiplicative coordinate pattern search from top 2 distinct starting basins
  const startingPoints = [candidates[0]];
  const second = candidates.find(
    (c) =>
      Math.abs(c.kp - candidates[0].kp) > 0.25 * Math.abs(candidates[0].kp) ||
      Math.abs(c.ki - candidates[0].ki) > 0.25 * Math.abs(candidates[0].ki)
  );
  if (second && second.verdict === 'STABLE') {
    startingPoints.push(second);
  }

  const stepFactors = [0.48, 0.26, 0.14, 0.06];
  for (const start of startingPoints) {
    let cur = start;
    for (const delta of stepFactors) {
      const trials: [number, number, number][] = [
        [cur.kp * (1 + delta), cur.ki, cur.kd],
        [cur.kp * (1 - delta), cur.ki, cur.kd],
        [cur.kp, cur.ki * (1 + delta), cur.kd],
        [cur.kp, cur.ki * (1 - delta), cur.kd],
        [cur.kp, cur.ki, cur.kd * (1 + delta)],
        [cur.kp, cur.ki, cur.kd * (1 - delta)],
        // Coupled proportional+derivative bandwidth scaling step
        [cur.kp * (1 + delta), cur.ki * (1 + delta), cur.kd * (1 + delta * 0.5)],
        [cur.kp * (1 - delta), cur.ki * (1 - delta), cur.kd * (1 - delta * 0.5)],
      ];
      let improved = cur;
      for (const [tkp, tki, tkd] of trials) {
        const res = evaluateCandidate(tkp, tki, tkd, false);
        if (res.cost < improved.cost) {
          improved = res;
        }
      }
      cur = improved;
    }
    if (cur.cost < best.cost) {
      best = cur;
    }
  }

  // Final high-resolution verification with rounded gains so displayed numbers match UI exactly
  const finalKp = roundGain(best.kp);
  const finalKi = roundGain(best.ki);
  const finalKd = roundGain(best.kd);
  const verified = evaluateCandidate(finalKp, finalKi, finalKd, true);

  // Fallback to exact unrounded gains if rounding nudged stability
  const chosen = verified.verdict === 'STABLE' ? verified : evaluateCandidate(best.kp, best.ki, best.kd, true);

  const boardSpec = constraints.esp32Board
    ? ESP32_BOARD_SPECS[constraints.esp32Board]
    : null;
  const esp32BoardLabel = boardSpec
    ? boardSpec.label
    : model.id.startsWith('esp32')
    ? 'ESP32-WROOM-32 (esp32dev)'
    : `${model.name} Target`;

  const strategySummary =
    objective === 'min_settling_time'
      ? `Unit-step settling-time minimization at ${loopRateHz} Hz (OS≤${maxOvershoot}%, N=${chosen.nFilter} rad/s)`
      : `Synthesized at ${loopRateHz} Hz (dt=${safeDt}s) targeting tr=${targetRise}s, OS≤${maxOvershoot}% with Nyquist-bounded N=${chosen.nFilter} rad/s`;

  return {
    recommendedPid: {
      kp: chosen === verified ? finalKp : Number(best.kp.toPrecision(5)),
      ki: chosen === verified ? finalKi : Number(best.ki.toPrecision(5)),
      kd: chosen === verified ? finalKd : Number(best.kd.toPrecision(5)),
      nFilter: chosen.nFilter,
    },
    achievedRiseTimeSec: chosen.riseTimeSec,
    achievedOvershootPct: chosen.overshootPct,
    achievedSettlingTimeSec: chosen.settlingTimeSec,
    baselineSettlingTimeSec,
    closedLoopVerdict: chosen.verdict,
    phaseMarginDeg: chosen.phaseMarginDeg,
    gainMarginDb: chosen.gainMarginDb,
    dampingRatio: chosen.dampingRatio,
    meetsConstraints: chosen.meetsConstraints,
    objective,
    targetModelId: model.id,
    targetModelName: model.name,
    esp32BoardLabel,
    loopRateHz,
    strategySummary,
    iterationsEvaluated,
  };
}
