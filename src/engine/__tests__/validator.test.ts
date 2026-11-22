import { describe, expect, it } from 'vitest';
import { PRESET_MODELS } from '../../data/presets';
import { BlockNode, ControlModel, SignalEdge } from '../../types/control';
import { computeBodeAnalysis, computeNyquistAnalysis } from '../bode';
import { computePoleZeroStabilitySummary } from '../stability';
import { applyTransferFunctionToModel } from '../transferFunction';
import { validateControlModel } from '../validator';

function cloneMotor(): ControlModel {
  return structuredClone(PRESET_MODELS.dcmotor);
}

describe('validateControlModel - State-Space Matrix & Graph Edge Cases', () => {
  it('accepts all built-in presets and reports deterministic multi-rate summary', () => {
    for (const preset of Object.values(PRESET_MODELS)) {
      const report = validateControlModel(preset);
      expect(report.valid).toBe(true);
      expect(report.issues).toHaveLength(0);
      expect(report.executionOrder.length).toBe(preset.blocks.length);
      expect(report.multiRateSummary.baseHz).toBe(Math.round(1 / preset.baseDt));
      expect(report.multiRateSummary.fastHz).toBe(
        Math.round(1 / (preset.baseDt / Math.max(1, preset.fastDtRatio)))
      );
      expect(report.multiRateSummary.lcmRatio).toBe(Math.max(1, preset.fastDtRatio));
    }
  });

  it('rejects non-positive and non-integer state-space dimensions (n, m, p)', () => {
    const zeroState = cloneMotor();
    zeroState.plant.n = 0;
    zeroState.plant.A = [];
    zeroState.plant.B = [];
    zeroState.plant.C = [[]];
    zeroState.plant.x0 = [];
    zeroState.lqrK = [];
    const rZero = validateControlModel(zeroState);
    expect(rZero.valid).toBe(false);
    expect(rZero.issues.some((i) => i.code === 'MATRIX_DIM' && i.message.includes('positive integers'))).toBe(true);

    const fractionalDim = cloneMotor();
    fractionalDim.plant.m = 1.5;
    const rFrac = validateControlModel(fractionalDim);
    expect(rFrac.valid).toBe(false);
    expect(rFrac.issues.some((i) => i.code === 'MATRIX_DIM' && i.message.includes('positive integers'))).toBe(true);

    const negativeOutput = cloneMotor();
    negativeOutput.plant.p = -1;
    const rNeg = validateControlModel(negativeOutput);
    expect(rNeg.valid).toBe(false);
    expect(rNeg.issues.some((i) => i.code === 'MATRIX_DIM')).toBe(true);
  });

  it('detects ragged and mismatched dimensions across A, B, C, D, x0, and lqrK', () => {
    // Ragged A row
    const raggedA = cloneMotor();
    raggedA.plant.A[1] = [0]; // shorter than n=2
    const rA = validateControlModel(raggedA);
    expect(rA.valid).toBe(false);
    expect(rA.issues.some((i) => i.code === 'MATRIX_DIM' && i.message.includes('Matrix A'))).toBe(true);

    // Wrong B column count
    const wrongB = cloneMotor();
    wrongB.plant.B[0] = [1, 2]; // m=1 expected
    const rB = validateControlModel(wrongB);
    expect(rB.valid).toBe(false);
    expect(rB.issues.some((i) => i.code === 'MATRIX_DIM' && i.message.includes('Matrix B'))).toBe(true);

    // Wrong C row count (dcmotor has p=2, n=2)
    const wrongC = cloneMotor();
    wrongC.plant.C = [[1, 0], [0, 1], [1, 1]]; // 3 rows != p=2
    const rC = validateControlModel(wrongC);
    expect(rC.valid).toBe(false);
    expect(rC.issues.some((i) => i.code === 'MATRIX_DIM' && i.message.includes('Matrix C'))).toBe(true);

    // Wrong D column count
    const wrongD = cloneMotor();
    wrongD.plant.D = [[0, 0], [0, 0]]; // m=1 expected
    const rD = validateControlModel(wrongD);
    expect(rD.valid).toBe(false);
    expect(rD.issues.some((i) => i.code === 'MATRIX_DIM' && i.message.includes('Matrix D'))).toBe(true);

    // Mismatched x0 and lqrK length
    const wrongVec = cloneMotor();
    wrongVec.plant.x0 = [0];
    wrongVec.lqrK = [1, 2, 3];
    const rVec = validateControlModel(wrongVec);
    expect(rVec.valid).toBe(false);
    expect(rVec.issues.some((i) => i.code === 'MATRIX_DIM' && i.message.includes('x0 and LQR gain K'))).toBe(true);
  });

  it('rejects NaN, Infinity, and -Infinity entries in state-space matrices and gain vectors', () => {
    const nanA = cloneMotor();
    nanA.plant.A[0][1] = Number.NaN;
    const rNan = validateControlModel(nanA);
    expect(rNan.valid).toBe(false);
    expect(rNan.issues.some((i) => i.code === 'MATRIX_DIM' && i.message.includes('finite numbers'))).toBe(true);

    const infB = cloneMotor();
    infB.plant.B[1][0] = Number.POSITIVE_INFINITY;
    expect(validateControlModel(infB).valid).toBe(false);

    const negInfK = cloneMotor();
    negInfK.lqrK[0] = Number.NEGATIVE_INFINITY;
    expect(validateControlModel(negInfK).valid).toBe(false);
  });

  it('handles direct feedthrough D tolerance threshold and algebraic loop detection accurately', () => {
    // Minimal combinational cycle passing directly through state_space -> gain -> sum -> state_space
    const buildDirectCycleModel = (dVal: number, hasMemoryBreaker: boolean): ControlModel => {
      const m = cloneMotor();
      m.plant.D = Array.from({ length: m.plant.p }, (_, idx) => [idx === 0 ? dVal : 0]);
      const blocks: BlockNode[] = [
        { id: 'sum_err', label: 'Sum', kind: 'sum', dt: 0.01, x: 100, y: 100, hasMemory: false },
        { id: 'plant_ss', label: 'Plant', kind: 'state_space', dt: 0, x: 250, y: 100, hasMemory: false },
        { id: 'fb_gain', label: 'Gain', kind: 'lqr_gain', dt: 0.01, x: 400, y: 100, hasMemory: hasMemoryBreaker },
      ];
      const edges: SignalEdge[] = [
        { id: 'e1', from: 'sum_err', fromPort: 'e', to: 'plant_ss', toPort: 'u', signalName: 'u' },
        { id: 'e2', from: 'plant_ss', fromPort: 'y', to: 'fb_gain', toPort: 'y', signalName: 'y' },
        { id: 'e3', from: 'fb_gain', fromPort: 'fb', to: 'sum_err', toPort: 'fb', signalName: 'fb' },
      ];
      m.blocks = blocks;
      m.edges = edges;
      return m;
    };

    // Tiny floating-point epsilon below 1e-12 does NOT count as direct feedthrough -> plant breaks loop
    const epsModel = buildDirectCycleModel(5e-13, false);
    const epsReport = validateControlModel(epsModel);
    expect(epsReport.valid).toBe(true);

    // Significant D != 0 without a memory block creates an algebraic loop
    const directLoopModel = buildDirectCycleModel(0.25, false);
    const directReport = validateControlModel(directLoopModel);
    expect(directReport.valid).toBe(false);
    const algIssue = directReport.issues.find((i) => i.code === 'ALGEBRAIC_LOOP');
    expect(algIssue).toBeDefined();
    expect(algIssue!.detail).toMatch(/Matrix D is non-zero/i);
    expect(algIssue!.involvedBlocks).toContain('plant_ss');

    // Inserting memory/delay on feedback path breaks the D != 0 cycle cleanly
    const brokenLoopModel = buildDirectCycleModel(0.25, true);
    const brokenReport = validateControlModel(brokenLoopModel);
    expect(brokenReport.valid).toBe(true);
  });

  it('catches non-integer multi-rate ratios, non-positive baseDt, and invalid saturation bounds', () => {
    const rateMismatch = cloneMotor();
    // Create a discrete edge with non-integer period ratio (0.02s vs 0.007s => 2.857)
    rateMismatch.blocks[0].dt = 0.02;
    rateMismatch.blocks[1].dt = 0.007;
    rateMismatch.edges = [
      {
        id: 'e_bad_rate',
        from: rateMismatch.blocks[0].id,
        fromPort: 'out',
        to: rateMismatch.blocks[1].id,
        toPort: 'in',
        signalName: 'sig',
      },
    ];
    const rRate = validateControlModel(rateMismatch);
    expect(rRate.valid).toBe(false);
    expect(rRate.issues.some((i) => i.code === 'RATE_MISMATCH')).toBe(true);

    // Invalid baseDt <= 0 produces safe non-Infinity summary + RATE_MISMATCH
    const zeroDt = cloneMotor();
    zeroDt.baseDt = 0;
    const rZeroDt = validateControlModel(zeroDt);
    expect(rZeroDt.valid).toBe(false);
    expect(rZeroDt.issues.some((i) => i.code === 'RATE_MISMATCH')).toBe(true);
    expect(Number.isFinite(rZeroDt.multiRateSummary.baseHz)).toBe(true);

    // Equal or inverted saturation bounds
    const equalSat = cloneMotor();
    equalSat.limits.satMin = 5;
    equalSat.limits.satMax = 5;
    const rSatEq = validateControlModel(equalSat);
    expect(rSatEq.valid).toBe(false);
    expect(rSatEq.issues.some((i) => i.involvedBlocks.includes('sat_clamp'))).toBe(true);

    const invSat = cloneMotor();
    invSat.limits.satMin = 10;
    invSat.limits.satMax = -10;
    expect(validateControlModel(invSat).valid).toBe(false);
  });

  it('ignores dangling edges to missing blocks gracefully while honoring injectAlgebraicLoopTest', () => {
    const dangling = cloneMotor();
    dangling.edges.push({
      id: 'e_missing',
      from: 'nonexistent_src',
      fromPort: 'out',
      to: 'nonexistent_dst',
      toPort: 'in',
      signalName: 'ghost',
    });
    expect(validateControlModel(dangling).valid).toBe(true);

    dangling.injectAlgebraicLoopTest = true;
    const looped = validateControlModel(dangling);
    expect(looped.valid).toBe(false);
    expect(looped.issues.some((i) => i.code === 'ALGEBRAIC_LOOP')).toBe(true);
  });
});

describe('Stability Margin Calculation Edge Cases', () => {
  it('reports NO_CROSSOVER when plant gain stays strictly below 0 dB and phase never reaches -180°', () => {
    // G(s) = 2 / (s + 10) => DC gain = 0.2 (-13.98 dB), max phase lag = -90°
    const { model: lowGain } = applyTransferFunctionToModel(
      PRESET_MODELS.dcmotor,
      [2],
      [1, 10],
      'Sub-Unity First Order'
    );
    const bode = computeBodeAnalysis(lowGain, 0, 'plant', 0);
    expect(bode.dcGainDb).toBeCloseTo(20 * Math.log10(0.2), 1);
    expect(bode.margins.gainCrossoverOmega).toBeNull();
    expect(bode.margins.phaseCrossoverOmega).toBeNull();
    expect(bode.margins.phaseMarginDeg).toBeNull();
    expect(bode.margins.gainMarginDb).toBeNull();
    expect(bode.margins.closedLoopStableHint).toBe('NO_CROSSOVER');
  });

  it('reports positive phase margin and infinite (null) gain margin on passive 2nd-order plant with >0 dB DC gain', () => {
    // G(s) = 40 / (s^2 + 6s + 20) => DC gain = 2 (+6.02 dB), phase stays in (0°, -180°)
    const { model: secondOrder } = applyTransferFunctionToModel(
      PRESET_MODELS.dcmotor,
      [40],
      [1, 6, 20],
      'Passive 2nd Order'
    );
    const bode = computeBodeAnalysis(secondOrder, 0, 'plant', 0);
    expect(bode.margins.gainCrossoverOmega).not.toBeNull();
    expect(bode.margins.phaseMarginDeg).not.toBeNull();
    expect(bode.margins.phaseMarginDeg!).toBeGreaterThan(30);
    expect(bode.margins.phaseCrossoverOmega).toBeNull();
    expect(bode.margins.gainMarginDb).toBeNull();
    expect(bode.margins.closedLoopStableHint).toBe('MARGIN_POSITIVE');
  });

  it('computes consistent negative GM and PM across Bode, Nyquist, and Pole-Zero stability summaries', () => {
    // G(s) = 180 / ((s+1)(s+2)(s+4)) => |G(j*sqrt(14))| = 180/90 = 2.0 (+6.02 dB) -> GM = -6.02 dB
    const { model: unstableLoop } = applyTransferFunctionToModel(
      PRESET_MODELS.dcmotor,
      [180],
      [1, 7, 14, 8],
      'Negative Margin 3rd Order'
    );
    const bode = computeBodeAnalysis(unstableLoop, 0, 'plant', 0);
    const nyquist = computeNyquistAnalysis(unstableLoop, 0, 'plant', 0);
    const pzSummary = computePoleZeroStabilitySummary(unstableLoop, 'open', 0, 0);

    expect(bode.margins.closedLoopStableHint).toBe('MARGIN_NEGATIVE');
    expect(bode.margins.gainMarginDb!).toBeCloseTo(-20 * Math.log10(2), 1);
    expect(bode.margins.phaseMarginDeg!).toBeLessThan(0);

    expect(nyquist.margins.gainMarginDb!).toBeCloseTo(bode.margins.gainMarginDb!, 1);
    expect(nyquist.margins.phaseMarginDeg!).toBeCloseTo(bode.margins.phaseMarginDeg!, 1);
    expect(pzSummary.gainMarginDb!).toBeCloseTo(bode.margins.gainMarginDb!, 1);
  });

  it('handles biproper D != 0 direct feedthrough high-frequency asymptotes and PID-disabled equivalence', () => {
    // G(s) = (2s + 10) / (s + 2) => D = 2 (+6.02 dB high-freq magnitude asymptote, 0° phase at high ω)
    const { model: biproper } = applyTransferFunctionToModel(
      PRESET_MODELS.dcmotor,
      [2, 10],
      [1, 2],
      'Biproper Feedthrough'
    );
    biproper.pid.enabled = false;

    const plantBode = computeBodeAnalysis(biproper, 0, 'plant', 0);
    const openLoopBode = computeBodeAnalysis(biproper, 0, 'open_loop', 0);

    const hfPoint = plantBode.points[plantBode.points.length - 1];
    expect(hfPoint.magDb).toBeCloseTo(20 * Math.log10(2), 1);
    expect(Math.abs(hfPoint.phaseDeg)).toBeLessThan(2);

    // With pid.enabled = false, open_loop and plant Bode curves & margins are identical
    expect(openLoopBode.dcGainDb).toBeCloseTo(plantBode.dcGainDb, 8);
    expect(openLoopBode.margins.closedLoopStableHint).toBe(
      plantBode.margins.closedLoopStableHint
    );
  });
});
