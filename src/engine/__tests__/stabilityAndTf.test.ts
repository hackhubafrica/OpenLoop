import { describe, expect, it } from 'vitest';
import { PRESET_MODELS } from '../../data/presets';
import { getPlantTemplateById } from '../../data/plantTemplates';
import { computeBodeAnalysis } from '../bode';
import { runSimulation } from '../simulator';
import {
  analyzeSystemStability,
  computeImpulseResponse,
  computeMatrixEigenvalues,
  computePidCompensatorZeros,
  computePoleZeroStabilitySummary,
  computePolynomialRoots,
  computeRootLocus,
  computeTransferFunctionStepResponse,
  generateLatexStabilityReport,
  stateSpaceToTransferFunction,
} from '../stability';
import {
  applyTransferFunctionToModel,
  parseCoefficientList,
  transferFunctionToStateSpace,
} from '../transferFunction';
import { validateControlModel } from '../validator';

describe('Transfer Function (num/den) Converter & Canonical Realization', () => {
  it('parses descending polynomial coefficients and converts to controllable canonical form', () => {
    const parsedNum = parseCoefficientList('1, 3');
    const parsedDen = parseCoefficientList('1  4, 16');
    expect(parsedNum.error).toBeNull();
    expect(parsedDen.error).toBeNull();

    const { result, error } = transferFunctionToStateSpace(
      parsedNum.coeffs,
      parsedDen.coeffs
    );
    expect(error).toBeNull();
    expect(result).not.toBeNull();
    expect(result!.order).toBe(2);
    expect(result!.A).toEqual([
      [0, 1],
      [-16, -4],
    ]);
    expect(result!.B).toEqual([[0], [1]]);
    expect(result!.C).toEqual([[3, 1]]);
    expect(result!.D).toEqual([[0]]);
    expect(result!.dcGain).toBeCloseTo(3 / 16, 10);
  });

  it('normalizes non-monic denominators and handles biproper feedthrough D != 0', () => {
    // G(s) = (2s^2 + 10s + 16) / (2s^2 + 6s + 4) = (s^2 + 5s + 8) / (s^2 + 3s + 2)
    // D = 1, C = [b0 - 1*a0, b1 - 1*a1] = [8 - 2, 5 - 3] = [6, 2]
    const { result, error } = transferFunctionToStateSpace([2, 10, 16], [2, 6, 4]);
    expect(error).toBeNull();
    expect(result!.A).toEqual([
      [0, 1],
      [-2, -3],
    ]);
    expect(result!.C).toEqual([[6, 2]]);
    expect(result!.D).toEqual([[1]]);
    expect(result!.dcGain).toBeCloseTo(4, 10);
  });

  it('flags integrator systems with null DC gain and rejects invalid/improper functions', () => {
    const integrator = transferFunctionToStateSpace([1], [1, 2, 0]);
    expect(integrator.error).toBeNull();
    expect(integrator.result!.dcGain).toBeNull();

    const improper = transferFunctionToStateSpace([1, 2, 3], [1, 4]);
    expect(improper.result).toBeNull();
    expect(improper.error).toMatch(/improper/i);

    const zeroDen = transferFunctionToStateSpace([1], [0]);
    expect(zeroDen.result).toBeNull();
    expect(zeroDen.error).toBeTruthy();

    const tooHigh = transferFunctionToStateSpace([1], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(tooHigh.result).toBeNull();
    expect(tooHigh.error).toMatch(/between/i);
  });

  it('round-trips SISO plants accurately via stateSpaceToTransferFunction', () => {
    const { result } = transferFunctionToStateSpace([2, 5, 11], [1, 6, 11, 6]);
    expect(result).not.toBeNull();

    const recovered = stateSpaceToTransferFunction(
      {
        n: 3,
        m: 1,
        p: 1,
        stateNames: ['x0', 'x1', 'x2'],
        stateUnits: ['u', 'u', 'u'],
        outputNames: ['y'],
        outputUnits: ['u'],
        inputName: 'u',
        inputUnit: 'u',
        inputNames: ['u'],
        inputUnits: ['u'],
        A: result!.A,
        B: result!.B,
        C: result!.C,
        D: result!.D,
        x0: [0, 0, 0],
      },
      0,
      0
    );

    expect(recovered.denominator.length).toBe(4);
    expect(recovered.denominator[0]).toBeCloseTo(1, 8);
    expect(recovered.denominator[1]).toBeCloseTo(6, 8);
    expect(recovered.denominator[2]).toBeCloseTo(11, 8);
    expect(recovered.denominator[3]).toBeCloseTo(6, 8);

    expect(recovered.numerator.length).toBe(3);
    expect(recovered.numerator[0]).toBeCloseTo(2, 8);
    expect(recovered.numerator[1]).toBeCloseTo(5, 8);
    expect(recovered.numerator[2]).toBeCloseTo(11, 8);
  });

  it('matches analytical frequency response after applying transfer function to model', () => {
    const base = PRESET_MODELS.dcmotor;
    const { model: tfModel, error } = applyTransferFunctionToModel(
      base,
      [1, 3],
      [1, 4, 16],
      'Custom TF Plant'
    );
    expect(error).toBeNull();
    expect(tfModel.isCustomModel).toBe(true);
    expect(tfModel.plant.n).toBe(2);

    const validation = validateControlModel(tfModel);
    expect(validation.valid).toBe(true);

    // Check Bode response against analytical G(j*w) = (j*w + 3) / ((16 - w^2) + j*4w)
    const bode = computeBodeAnalysis(tfModel, 0, 'plant', 0);
    const sample = bode.points.find((pt) => pt.omega > 1.5 && pt.omega < 5)!;
    const w = sample.omega;
    const numMag = Math.hypot(3, w);
    const denMag = Math.hypot(16 - w * w, 4 * w);
    const expectedDb = 20 * Math.log10(numMag / denMag);
    expect(sample.magDb).toBeCloseTo(expectedDb, 4);

    // Verify simulation runs smoothly on converted model
    const trace = runSimulation(tfModel);
    expect(trace.samples.length).toBeGreaterThan(50);
  });
});

describe('Eigenvalue Solver & Continuous/Discrete Stability Analysis', () => {
  it('computes exact complex conjugate eigenvalues and damping metrics for Mass-Spring-Damper', () => {
    const msd = getPlantTemplateById('mass_spring_damper')!.model;
    const analysis = analyzeSystemStability(msd, 0, 0);

    // Characteristic eq: s^2 + 1.2s + 16 = 0 => -0.6 +/- j*sqrt(15.64)
    expect(analysis.openLoopPoles).toHaveLength(2);
    expect(analysis.openLoopVerdict).toBe('STABLE');
    expect(analysis.closedLoopVerdict).toBe('STABLE');
    expect(analysis.discreteVerdict).toBe('STABLE');

    const p0 = analysis.openLoopPoles[0];
    expect(p0.re).toBeCloseTo(-0.6, 6);
    expect(Math.abs(p0.im)).toBeCloseTo(Math.sqrt(15.64), 6);
    expect(p0.naturalFreqRad).toBeCloseTo(4.0, 6);
    expect(p0.dampingRatio).toBeCloseTo(0.15, 6);
  });

  it('detects unstable open-loop RHP pole and stabilized closed-loop poles for Inverted Pendulum', () => {
    const analysis = analyzeSystemStability(PRESET_MODELS.pendulum, 1, 0);

    expect(analysis.openLoopPoles).toHaveLength(4);
    expect(analysis.openLoopVerdict).toBe('UNSTABLE');
    expect(analysis.maxRealPartOpen).toBeGreaterThan(3.0);
    expect(analysis.discreteVerdict).toBe('UNSTABLE'); // open-loop Ad = exp(A*dt) has |z| > 1

    // With ki != 0 on theta in parallel with LQR on x, an origin pole appears (re = 0 -> MARGINAL)
    // and all non-origin poles are strictly in LHP
    expect(analysis.closedLoopVerdict).toBe('MARGINAL');
    expect(analysis.maxRealPartClosed).toBeCloseTo(0, 6);
    const nonZeroClosed = analysis.closedLoopPoles.filter((p) => Math.abs(p.re) > 1e-4);
    expect(nonZeroClosed.every((p) => p.re < 0)).toBe(true);

    // Without conflicting inner theta integrator (LQR + inner PD), all closed-loop poles are strictly LHP STABLE
    const pdPendulum = structuredClone(PRESET_MODELS.pendulum);
    pdPendulum.pid.ki = 0;
    const pdAnalysis = analyzeSystemStability(pdPendulum, 1, 0);
    expect(pdAnalysis.closedLoopVerdict).toBe('STABLE');
    expect(pdAnalysis.maxRealPartClosed).toBeLessThan(-0.4);

    // Output y[0] = x has transmission zeros including sqrt(g/l) RHP/LHP pair
    const xChannel = analyzeSystemStability(PRESET_MODELS.pendulum, 0, 0);
    expect(xChannel.plantZeros.length).toBeGreaterThanOrEqual(2);
  });

  it('converges accurately on higher-order matrices (4x4) and polynomial zero roots', () => {
    const mat4 = [
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
      [-24, -50, -35, -10], // roots: -1, -2, -3, -4
    ];
    const eigs = computeMatrixEigenvalues(mat4);
    const reals = eigs.map((e) => e.re).sort((a, b) => b - a);
    expect(eigs.every((e) => Math.abs(e.im) < 1e-6)).toBe(true);
    expect(reals[0]).toBeCloseTo(-1, 5);
    expect(reals[1]).toBeCloseTo(-2, 5);
    expect(reals[2]).toBeCloseTo(-3, 5);
    expect(reals[3]).toBeCloseTo(-4, 5);

    // Zero roots of (s + 2)(s^2 + 2s + 5) = s^3 + 4s^2 + 9s + 10
    const roots = computePolynomialRoots([1, 4, 9, 10]);
    expect(roots).toHaveLength(3);
    expect(roots.some((r) => Math.abs(r.re - -2) < 1e-5 && Math.abs(r.im) < 1e-5)).toBe(true);
    expect(roots.some((r) => Math.abs(r.re - -1) < 1e-5 && Math.abs(Math.abs(r.im) - 2) < 1e-5)).toBe(true);
  });

  it('verifies DC Motor and Buck Converter are open-loop and closed-loop stable', () => {
    const dcAnalysis = analyzeSystemStability(PRESET_MODELS.dcmotor, 0, 0);
    expect(dcAnalysis.openLoopVerdict).toBe('STABLE');
    expect(dcAnalysis.closedLoopVerdict).toBe('STABLE');
    expect(dcAnalysis.discreteVerdict).toBe('STABLE');

    const buckAnalysis = analyzeSystemStability(PRESET_MODELS.buck, 0, 0);
    expect(buckAnalysis.openLoopVerdict).toBe('STABLE');
    expect(buckAnalysis.closedLoopVerdict).toBe('STABLE');
    expect(buckAnalysis.discreteVerdict).toBe('STABLE');
  });

  it('computes dominant damping ratio, natural frequency, and gain/phase margins from pole-zero locations', () => {
    const msd = getPlantTemplateById('mass_spring_damper')!.model;
    const msdOpenSummary = computePoleZeroStabilitySummary(msd, 'open', 0, 0);
    expect(msdOpenSummary.dampingRatio).toBeCloseTo(0.15, 5);
    expect(msdOpenSummary.naturalFreqRad).toBeCloseTo(4.0, 5);
    expect(msdOpenSummary.naturalFreqHz).toBeCloseTo(4.0 / (2 * Math.PI), 5);
    expect(msdOpenSummary.dampingRegime).toBe('Underdamped');

    // Classic 3rd-order plant G(s) = 20 / ((s+1)(s+2)(s+4)) = 20 / (s^3 + 7s^2 + 14s + 8)
    // Phase crossover w_pc = sqrt(14) ~= 3.7417 rad/s, |G(jw_pc)| = 20/90 => GM = 20*log10(4.5) ~= 13.064 dB
    const { model: plant3rd } = applyTransferFunctionToModel(
      PRESET_MODELS.dcmotor,
      [20],
      [1, 7, 14, 8],
      '3rd-Order Benchmark'
    );
    const summary = computePoleZeroStabilitySummary(plant3rd, 'open', 0, 0);
    expect(summary.verdict).toBe('STABLE');
    expect(summary.naturalFreqRad).toBeCloseTo(1.0, 5); // Dominant pole at s = -1
    expect(summary.dampingRatio).toBeCloseTo(1.0, 5);
    expect(summary.phaseCrossoverOmega).not.toBeNull();
    expect(summary.phaseCrossoverOmega!).toBeCloseTo(Math.sqrt(14), 1);
    expect(summary.gainMarginDb).not.toBeNull();
    expect(summary.gainMarginDb!).toBeCloseTo(20 * Math.log10(4.5), 1);
    expect(summary.gainCrossoverOmega).not.toBeNull();
    expect(summary.phaseMarginDeg).not.toBeNull();
    expect(summary.phaseMarginDeg!).toBeGreaterThan(20);
  });

  it('computes open-loop transfer function step response metrics and detects RHP divergence', () => {
    // 2nd-order underdamped TF: G(s) = 16 / (s^2 + 4s + 16), zeta = 0.5, DC gain = 1.0
    // Theoretical %OS = exp(-pi * zeta / sqrt(1 - zeta^2)) * 100 ~= 16.303%
    const { model: secondOrder } = applyTransferFunctionToModel(
      PRESET_MODELS.dcmotor,
      [16],
      [1, 4, 16],
      'Underdamped 2nd Order'
    );
    const step = computeTransferFunctionStepResponse(secondOrder, 'open', 0, 0);
    expect(step.divergent).toBe(false);
    expect(step.dcSteadyState).toBeCloseTo(1.0, 5);
    expect(step.finalValue).toBeCloseTo(1.0, 2);
    expect(step.overshootPct).not.toBeNull();
    expect(step.overshootPct!).toBeCloseTo(16.3, 0);
    expect(step.settlingTimeSec).not.toBeNull();
    expect(step.settlingTimeSec!).toBeGreaterThan(0.5);

    // Inverted pendulum open-loop is unstable -> divergent = true
    const pendOpen = computeTransferFunctionStepResponse(
      PRESET_MODELS.pendulum,
      'open',
      1,
      0
    );
    expect(pendOpen.divergent).toBe(true);
  });

  it('computes continuous root locus branches, asymptotes, and jw-axis crossings', () => {
    // G(s) = 20 / ((s+1)(s+2)(s+4)): 3 poles, 0 zeros => centroid = -7/3, angles = 60, 180, 300
    // Crosses jw-axis when 8 + 20K = 7*14 => K_crit = 4.5, omega = sqrt(14) ~= 3.7417
    const { model: plant3rd } = applyTransferFunctionToModel(
      PRESET_MODELS.dcmotor,
      [20],
      [1, 7, 14, 8],
      'Root Locus 3rd Order'
    );
    const rl = computeRootLocus(plant3rd, 0, 0);
    expect(rl.branches).toHaveLength(3);
    expect(rl.branches[0].points[0].k).toBe(0);
    expect(rl.relativeDegree).toBe(3);
    expect(rl.asymptoteCentroid).toBeCloseTo(-7 / 3, 5);
    expect(rl.asymptoteAnglesDeg).toEqual([60, 180, 300]);
    expect(rl.jwCrossings.length).toBeGreaterThanOrEqual(1);
    expect(rl.jwCrossings[0].gainK).toBeCloseTo(4.5, 0);
    expect(rl.jwCrossings[0].omega).toBeCloseTo(Math.sqrt(14), 0);

    // Mass-spring-damper stays strictly in LHP for all K >= 0
    const msd = getPlantTemplateById('mass_spring_damper')!.model;
    const rlMsd = computeRootLocus(msd, 0, 0);
    expect(rlMsd.branches).toHaveLength(2);
    expect(rlMsd.asymptoteCentroid).toBeCloseTo(-0.6, 5);
    expect(rlMsd.asymptoteAnglesDeg).toEqual([90, 270]);
    expect(rlMsd.jwCrossings).toHaveLength(0);
  });

  it('exports a formatted LaTeX system analysis report snippet with TF, poles, zeros, damping, and stability metrics', () => {
    const { model: plant3rd } = applyTransferFunctionToModel(
      PRESET_MODELS.dcmotor,
      [20],
      [1, 7, 14, 8],
      'Control_Benchmark_3rd'
    );
    const tex = generateLatexStabilityReport(plant3rd, 0, 0);

    expect(tex).toContain('\\subsection*{System Analysis: Control\\_Benchmark\\_3rd}');
    expect(tex).toContain('G(s) = \\frac{20}{s^{3} + 7s^{2} + 14s + 8}');
    expect(tex).toContain('\\begin{bmatrix}');
    expect(tex).toContain('\\lambda(A)');
    expect(tex).toContain('\\lambda(A_{\\mathrm{cl}})');
    expect(tex).toContain('Plant Zeros');
    expect(tex).toContain('Dominant Damping Ratio ($\\zeta$)');
    expect(tex).toContain('Dominant Natural Freq ($\\omega_n$)');
    expect(tex).toContain('Gain Margin ($GM$)');
    expect(tex).toContain('Phase Margin ($PM$)');
    expect(tex).toContain('Root Locus $j\\omega$-Crossing');
  });

  it('tracks PID compensator zeros and real-time closed-loop pole-zero shifts across gain adjustments', () => {
    // PI controller: C(s) = 2 + 6/s -> zero at s = -3
    const piZeros = computePidCompensatorZeros({
      enabled: true,
      targetOutputIndex: 0,
      tracksStepRef: true,
      kp: 2,
      ki: 6,
      kd: 0,
      nFilter: 50,
      kbAntiWindup: 1,
    });
    expect(piZeros).toHaveLength(1);
    expect(piZeros[0].re).toBeCloseTo(-3, 6);
    expect(piZeros[0].source).toBe('pid');

    // Bypassed PID -> no compensator zeros
    const disabledZeros = computePidCompensatorZeros({
      enabled: false,
      targetOutputIndex: 0,
      tracksStepRef: true,
      kp: 10,
      ki: 20,
      kd: 2,
      nFilter: 50,
      kbAntiWindup: 1,
    });
    expect(disabledZeros).toHaveLength(0);

    // Real-time pole & zero shift check on DC Motor when tuning Kp and Kd
    const baseModel = structuredClone(PRESET_MODELS.dcmotor);
    const lowGain = structuredClone(baseModel);
    lowGain.pid.kp = 0.2;
    lowGain.pid.ki = 2.0;
    lowGain.pid.kd = 0.005;

    const highGain = structuredClone(baseModel);
    highGain.pid.kp = 2.5;
    highGain.pid.ki = 20.0;
    highGain.pid.kd = 0.04;

    const lowAnalysis = analyzeSystemStability(lowGain, 0, 0);
    const highAnalysis = analyzeSystemStability(highGain, 0, 0);

    expect(lowAnalysis.pidZeros).toHaveLength(2);
    expect(highAnalysis.pidZeros).toHaveLength(2);
    expect(highAnalysis.pidZeros[0].re).not.toBeCloseTo(lowAnalysis.pidZeros[0].re, 3);
    expect(highAnalysis.closedLoopPoles[0].re).not.toBeCloseTo(
      lowAnalysis.closedLoopPoles[0].re,
      2
    );
  });

  it('computes open-loop analytical 2nd-order impulse response, closed-loop decay, and RHP divergence', () => {
    // G(s) = 16 / (s^2 + 4s + 16): wn = 4, zeta = 0.5, wd = sqrt(12)
    // Analytical h(t) = (16 / wd) * exp(-2t) * sin(wd * t)
    const { model: secondOrder } = applyTransferFunctionToModel(
      PRESET_MODELS.dcmotor,
      [16],
      [1, 4, 16],
      'Impulse 2nd Order'
    );
    const openImp = computeImpulseResponse(secondOrder, 'open', 0, 0, 3.0, 150);
    expect(openImp.divergent).toBe(false);
    expect(openImp.points.length).toBeGreaterThan(100);
    expect(openImp.initialValue).toBeCloseTo(0, 8);

    const wd = Math.sqrt(12);
    const midPt = openImp.points.find((p) => p.t >= 0.4 && p.t <= 0.5)!;
    const expectedH = (16 / wd) * Math.exp(-2 * midPt.t) * Math.sin(wd * midPt.t);
    expect(midPt.h).toBeCloseTo(expectedH, 3);
    expect(openImp.l2Energy).toBeGreaterThan(1.0);
    expect(openImp.settlingTimeSec).not.toBeNull();

    // Closed-loop DC Motor impulse decays to zero cleanly
    const dcClosedImp = computeImpulseResponse(
      PRESET_MODELS.dcmotor,
      'closed',
      0,
      0,
      PRESET_MODELS.dcmotor.duration,
      200
    );
    expect(dcClosedImp.divergent).toBe(false);
    expect(Math.abs(dcClosedImp.points[dcClosedImp.points.length - 1].h)).toBeLessThan(0.05);

    // Open-loop Inverted Pendulum is unstable -> divergent = true
    const pendOpenImp = computeImpulseResponse(PRESET_MODELS.pendulum, 'open', 1, 0, 2.0, 100);
    expect(pendOpenImp.divergent).toBe(true);
  });

  it('computes 10-90% rise time, settling tolerance band, and closed-loop step transient metrics', () => {
    // 1st-order system G(s) = 1 / (s + 2): tau = 0.5s, y_ss = 0.5
    // Exact rise time t_r = tau * ln(9) ~= 1.0986s, settling time (2%) = tau * ln(50) ~= 1.9560s
    const { model: firstOrder } = applyTransferFunctionToModel(
      PRESET_MODELS.dcmotor,
      [1],
      [1, 2],
      'First Order Lag'
    );
    const openStep = computeTransferFunctionStepResponse(
      firstOrder,
      'open',
      0,
      0,
      3.5,
      240
    );
    expect(openStep.divergent).toBe(false);
    expect(openStep.dcSteadyState).toBeCloseTo(0.5, 6);
    expect(openStep.y10).toBeCloseTo(0.05, 6);
    expect(openStep.y90).toBeCloseTo(0.45, 6);
    expect(openStep.riseTimeSec).not.toBeNull();
    expect(openStep.riseTimeSec!).toBeCloseTo(0.5 * Math.log(9), 2);
    expect(openStep.settlingTimeSec).not.toBeNull();
    expect(openStep.settlingTimeSec!).toBeCloseTo(0.5 * Math.log(50), 1);
    expect(openStep.settlingBandLow).toBeCloseTo(0.49, 4);
    expect(openStep.settlingBandHigh).toBeCloseTo(0.51, 4);

    // Closed-loop DC Motor tracks unit step cleanly with rise and settling metrics
    const dcClosedStep = computeTransferFunctionStepResponse(
      PRESET_MODELS.dcmotor,
      'closed',
      0,
      0,
      PRESET_MODELS.dcmotor.duration,
      240
    );
    expect(dcClosedStep.divergent).toBe(false);
    expect(dcClosedStep.dcSteadyState).toBeCloseTo(1.0, 4);
    expect(dcClosedStep.riseTimeSec).not.toBeNull();
    expect(dcClosedStep.riseTimeSec!).toBeGreaterThan(0);
    expect(dcClosedStep.settlingTimeSec).not.toBeNull();
  });

  it('computes s-plane stability margin heatmap highlighting stable time-constant and controller gain regions', async () => {
    const { computeSPlaneStabilityHeatmap } = await import('../stability');
    const heatmap = computeSPlaneStabilityHeatmap(
      PRESET_MODELS.dcmotor,
      [-20, 4],
      [-15, 15],
      {
        scope: 'closed',
        gainScale: 1.0,
        maxTimeConstantSec: 0.5, // sigma_threshold = -2.0
        minDampingRatio: 0.2,
        cols: 20,
        rows: 12,
      }
    );

    expect(heatmap.cells).toHaveLength(240);
    expect(heatmap.sigmaThreshold).toBeCloseTo(-2.0, 8);
    expect(heatmap.activeSystemStable).toBe(true);
    expect(heatmap.stableGainRange.min).not.toBeNull();
    expect(heatmap.stableGainRange.max).not.toBeNull();
    expect(heatmap.stableGainRange.max!).toBeGreaterThanOrEqual(1.0);

    // Every cell in RHP (re > 0) must be outside stable region with negative score
    const rhpCells = heatmap.cells.filter((c) => c.re > 0);
    expect(rhpCells.length).toBeGreaterThan(0);
    expect(rhpCells.every((c) => !c.inStableRegion && c.marginScore < 0)).toBe(true);

    // Deep LHP cells well inside damping cone and faster than tau_max must be inside stable region
    const deepLhpStable = heatmap.cells.filter(
      (c) => c.re <= -4.0 && Math.abs(c.im) <= 2.0
    );
    expect(deepLhpStable.length).toBeGreaterThan(0);
    expect(deepLhpStable.every((c) => c.inStableRegion && c.marginScore > 0)).toBe(true);
  });
});
