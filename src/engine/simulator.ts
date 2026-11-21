import {
  ControlModel,
  SimulationMetrics,
  SimulationTrace,
  TimeSample,
} from '../types/control';
import { discretizeStateSpace, matVecMul } from './math';

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function getReferenceAt(model: ControlModel, t: number): number {
  return t >= model.reference.stepTime
    ? model.reference.finalValue
    : model.reference.initialValue;
}

function getDisturbanceAt(model: ControlModel, t: number, dt: number): number {
  const dTime = model.reference.disturbanceTime;
  // Apply an impulse-like pulse (~0.8% of duration or at least 4 discrete steps)
  const pulseWidth = Math.max(model.duration * 0.008, dt * 4);
  if (t >= dTime && t < dTime + pulseWidth) {
    return model.reference.disturbanceMagnitude;
  }
  return 0;
}

/**
 * Runs deterministic side-by-side simulation:
 * - MIL: High-resolution continuous plant (RK4 with 4 substeps per baseDt) + continuous controller reference
 * - SIL: Fixed-step discrete state-space (Ad, Bd, Cd, Dd) + fixed-step discrete PID & rate/sat clamping
 */
export function runSimulation(model: ControlModel): SimulationTrace {
  const dt = Math.max(1e-6, model.baseDt);
  const discrete = discretizeStateSpace(model.plant, dt, model.discretization);
  const steps = Math.min(2500, Math.max(50, Math.round(model.duration / dt)));

  const { A, B, C, D, x0, n, m, p, auxInputs } = model.plant;
  const { satMin, satMax, rateLimit } = model.limits;

  const buildInputVec = (u0: number): number[] => {
    const vec = Array(m).fill(0);
    vec[0] = u0;
    for (let j = 1; j < m; j++) {
      vec[j] = auxInputs?.[j] ?? 0;
    }
    return vec;
  };

  // MIL state
  let xMil = [...x0];
  let pidIntMil = 0;
  let pidDerivMil = 0;
  let prevErrMil = 0;
  let prevUMil = 0;

  // SIL state
  let xSil = [...x0];
  let pidIntSil = 0;
  let pidDerivSil = 0;
  let prevErrSil = 0;
  let prevUSil = 0;

  const samples: TimeSample[] = [];
  const stride = Math.max(1, Math.floor(steps / 450)); // Keep chart crisp <= 450 points while executing every fixed step

  const computeController = (
    x: number[],
    y: number[],
    ref: number,
    stepDt: number,
    pidInt: number,
    pidDeriv: number,
    prevErr: number,
    prevU: number
  ) => {
    // 1. LQR full-state feedback: u_lqr = -sum(K_i * (x_i - x_ref_i))
    let uLqr = 0;
    for (let i = 0; i < n; i++) {
      const target = i === 0 && model.lqrTracksRefOnState0 ? ref : 0;
      uLqr += -(model.lqrK[i] ?? 0) * (x[i] - target);
    }

    // 2. Inner / primary PID with derivative filter N and back-calculation anti-windup
    let uPid = 0;
    let nextInt = pidInt;
    let nextDeriv = pidDeriv;
    let err = 0;

    if (model.pid.enabled) {
      const yIdx = clamp(model.pid.targetOutputIndex, 0, Math.max(0, y.length - 1));
      const target = model.pid.tracksStepRef ? ref : 0;
      err = target - (y[yIdx] ?? 0);

      // Filtered derivative via backward Euler on Tustin-like filter tau = 1/N
      const N = Math.max(0.1, model.pid.nFilter);
      const alpha = (N * stepDt) / (1 + N * stepDt);
      const rawDeriv = (err - prevErr) / stepDt;
      nextDeriv = pidDeriv + alpha * (rawDeriv - pidDeriv);

      const uUnsatPid =
        model.pid.kp * err + model.pid.ki * pidInt + model.pid.kd * nextDeriv;
      uPid = uUnsatPid;
    }

    const uRaw = uLqr + uPid;

    // 3. Rate Limiter
    const maxDelta = rateLimit * stepDt;
    const uRateLimited = clamp(uRaw, prevU - maxDelta, prevU + maxDelta);

    // 4. Actuator Saturation
    const uSat = clamp(uRateLimited, satMin, satMax);
    const saturated = Math.abs(uSat - uRateLimited) > 1e-9;

    // 5. Anti-windup back-calculation update for next step
    if (model.pid.enabled) {
      const awTerm = model.pid.kbAntiWindup * (uSat - uRaw);
      nextInt = pidInt + (err + awTerm * (model.pid.ki !== 0 ? 1 / model.pid.ki : 0)) * stepDt;
      // Also guard integrator runaway when ki == 0
      if (Math.abs(model.pid.ki) < 1e-12) nextInt = 0;
    }

    return {
      uRaw,
      uSat,
      saturated,
      nextInt,
      nextDeriv,
      err,
    };
  };

  const rk4PlantStep = (x: number[], u0: number, h: number): number[] => {
    const Bu = matVecMul(B, buildInputVec(u0));
    const deriv = (state: number[]) => {
      const Ax = matVecMul(A, state);
      return Ax.map((v, i) => v + (Bu[i] ?? 0));
    };
    const k1 = deriv(x);
    const k2 = deriv(x.map((v, i) => v + 0.5 * h * k1[i]));
    const k3 = deriv(x.map((v, i) => v + 0.5 * h * k2[i]));
    const k4 = deriv(x.map((v, i) => v + h * k3[i]));
    return x.map((v, i) => v + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
  };

  // Initialize prevErr before loop
  const y0Mil = matVecMul(C, xMil);
  const y0Sil = matVecMul(discrete.Cd, xSil);
  const initRef = getReferenceAt(model, 0);
  const yIdx0 = clamp(model.pid.targetOutputIndex, 0, Math.max(0, y0Mil.length - 1));
  prevErrMil = (model.pid.tracksStepRef ? initRef : 0) - (y0Mil[yIdx0] ?? 0);
  prevErrSil = (model.pid.tracksStepRef ? initRef : 0) - (y0Sil[yIdx0] ?? 0);

  const flopsPerIteration =
    2 * p * (n + m) +
    p +
    4 * n +
    2 * n * (n + m) +
    (model.pid.enabled ? 16 : 0) +
    4;

  let satCount = 0;
  let peakEffort = 0;
  let sqErrSum = 0;

  const simStartMs = performance.now();

  for (let k = 0; k <= steps; k++) {
    const t = k * dt;
    const ref = getReferenceAt(model, t);
    const dist = getDisturbanceAt(model, t, dt);

    // Current outputs (include Dd * prevUSilVec for Tustin state-space sensor consistency)
    const yMil = matVecMul(C, xMil);
    const ddPrevU = matVecMul(discrete.Dd, buildInputVec(prevUSil));
    const ySil = matVecMul(discrete.Cd, xSil).map(
      (v, i) => v + (ddPrevU[i] ?? 0)
    );

    // Compute MIL control (at fine 4x substeps below, capture start-of-step for telemetry)
    const milCtrl = computeController(
      xMil,
      yMil,
      ref,
      dt,
      pidIntMil,
      pidDerivMil,
      prevErrMil,
      prevUMil
    );

    // Compute SIL discrete control (fixed dt)
    const silCtrl = computeController(
      xSil,
      ySil,
      ref,
      dt,
      pidIntSil,
      pidDerivSil,
      prevErrSil,
      prevUSil
    );

    // Add direct feedthrough if plant D != 0
    const duMil = matVecMul(D, buildInputVec(milCtrl.uSat));
    const milOutputs = yMil.map((v, i) => v + (duMil[i] ?? 0));
    const silOutputs = ySil;

    if (silCtrl.saturated) satCount++;
    peakEffort = Math.max(peakEffort, Math.abs(silCtrl.uSat));
    const primaryOut = silOutputs[0] ?? 0;
    const trackErr = ref - primaryOut;
    sqErrSum += trackErr * trackErr;

    if (k % stride === 0 || k === steps) {
      samples.push({
        stepIndex: k,
        t,
        ref,
        milOutputs,
        silOutputs,
        milStates: [...xMil],
        silStates: [...xSil],
        uRaw: silCtrl.uRaw,
        uSat: silCtrl.uSat,
        pidIntegral: pidIntSil,
        saturated: silCtrl.saturated,
      });
    }

    if (k === steps) break;

    // Advance MIL via 4 RK4 substeps for continuous ground truth
    const subSteps = 4;
    const subDt = dt / subSteps;
    for (let s = 0; s < subSteps; s++) {
      const ySub = matVecMul(C, xMil);
      const subCtrl = computeController(
        xMil,
        ySub,
        ref,
        subDt,
        pidIntMil,
        pidDerivMil,
        prevErrMil,
        prevUMil
      );
      xMil = rk4PlantStep(xMil, subCtrl.uSat + dist, subDt);
      pidIntMil = subCtrl.nextInt;
      pidDerivMil = subCtrl.nextDeriv;
      prevErrMil = subCtrl.err;
      prevUMil = subCtrl.uSat;
    }

    // Advance SIL via exact discretized Ad * x + Bd * uVec
    const uSilVec = buildInputVec(silCtrl.uSat + dist);
    const Adx = matVecMul(discrete.Ad, xSil);
    const Bdu = matVecMul(discrete.Bd, uSilVec);
    xSil = Adx.map((v, i) => v + (Bdu[i] ?? 0));
    pidIntSil = silCtrl.nextInt;
    pidDerivSil = silCtrl.nextDeriv;
    prevErrSil = silCtrl.err;
    prevUSil = silCtrl.uSat;
  }

  // Compute Step Performance Metrics (on primary output y[0])
  const finalRef = model.reference.finalValue;
  const postStepSamples = samples.filter((s) => s.t >= model.reference.stepTime);
  let peakVal = -Infinity;
  let settlingTimeSec: number | null = null;
  if (postStepSamples.length > 0) {
    for (const s of postStepSamples) {
      const val = s.silOutputs[0] ?? 0;
      if (val > peakVal) peakVal = val;
    }
    const band = Math.max(0.02 * Math.abs(finalRef), 0.01);
    for (let i = postStepSamples.length - 1; i >= 0; i--) {
      const val = postStepSamples[i].silOutputs[0] ?? 0;
      if (Math.abs(val - finalRef) > band) {
        settlingTimeSec =
          i + 1 < postStepSamples.length
            ? postStepSamples[i + 1].t - model.reference.stepTime
            : null;
        break;
      }
      if (i === 0) settlingTimeSec = 0;
    }
  }

  const peakOvershootPct =
    Math.abs(finalRef) > 1e-6 && peakVal > finalRef
      ? ((peakVal - finalRef) / Math.abs(finalRef)) * 100
      : 0;

  const simElapsedMs = Math.max(0, performance.now() - simStartMs);
  const executedSteps = steps + 1;
  const computeTimePerIterationUs = (simElapsedMs * 1000) / executedSteps;

  const metrics: SimulationMetrics = {
    rmsError: Math.sqrt(sqErrSum / executedSteps),
    peakOvershootPct: Math.max(0, peakOvershootPct),
    settlingTimeSec,
    peakEffort,
    saturationDutyPct: (satCount / executedSteps) * 100,
    finalValue: samples[samples.length - 1]?.silOutputs[0] ?? 0,
    computeTimePerIterationUs,
    flopsPerIteration,
    executedSteps,
  };

  return {
    samples,
    metrics,
    discrete,
  };
}
