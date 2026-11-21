import { ControlModel, ValidationIssue, ValidationReport } from '../types/control';

export function validateControlModel(model: ControlModel): ValidationReport {
  const issues: ValidationIssue[] = [];

  // 1. Matrix dimension consistency checks
  const { n, m, p, A, B, C, D, x0 } = model.plant;
  if (n <= 0 || m <= 0 || p <= 0) {
    issues.push({
      severity: 'error',
      code: 'MATRIX_DIM',
      message: 'State-space dimensions (n, m, p) must be positive integers.',
      detail: `Received n=${n}, m=${m}, p=${p}.`,
      involvedBlocks: ['plant_ss'],
    });
  }
  if (A.length !== n || A.some((row) => row.length !== n)) {
    issues.push({
      severity: 'error',
      code: 'MATRIX_DIM',
      message: `Matrix A must be ${n}x${n}.`,
      detail: `Found ${A.length} rows; expected square matrix matching n=${n}.`,
      involvedBlocks: ['plant_ss'],
    });
  }
  if (B.length !== n || B.some((row) => row.length !== m)) {
    issues.push({
      severity: 'error',
      code: 'MATRIX_DIM',
      message: `Matrix B must be ${n}x${m}.`,
      detail: `Expected ${n} rows and ${m} columns.`,
      involvedBlocks: ['plant_ss'],
    });
  }
  if (C.length !== p || C.some((row) => row.length !== n)) {
    issues.push({
      severity: 'error',
      code: 'MATRIX_DIM',
      message: `Matrix C must be ${p}x${n}.`,
      detail: `Expected ${p} rows and ${n} columns.`,
      involvedBlocks: ['plant_ss'],
    });
  }
  if (D.length !== p || D.some((row) => row.length !== m)) {
    issues.push({
      severity: 'error',
      code: 'MATRIX_DIM',
      message: `Matrix D must be ${p}x${m}.`,
      detail: `Expected ${p} rows and ${m} columns.`,
      involvedBlocks: ['plant_ss'],
    });
  }
  if (x0.length !== n || model.lqrK.length !== n) {
    issues.push({
      severity: 'error',
      code: 'MATRIX_DIM',
      message: `Initial state x0 and LQR gain K must match state dimension n=${n}.`,
      detail: `x0 length=${x0.length}, K length=${model.lqrK.length}.`,
      involvedBlocks: ['plant_ss', 'lqr_ctrl'],
    });
  }

  // 2. Direct feedthrough check on state-space (D != 0 removes memory break!)
  const hasDirectFeedthrough = D.some((row) => row.some((v) => Math.abs(v) > 1e-12));

  // Build effective block map and algebraic dependency graph (only non-memory edges!)
  const blockMap = new Map(model.blocks.map((b) => [b.id, b]));
  const effectiveEdges = [...model.edges];
  if (model.injectAlgebraicLoopTest) {
    // Inject a direct zero-delay combinational feedback edge from lqr_ctrl -> sum_err
    effectiveEdges.push({
      id: 'e_loop_test',
      from: 'lqr_ctrl',
      fromPort: 'u_lqr',
      to: 'sum_err',
      toPort: 'alg_fb',
      signalName: 'u_direct_loop',
    });
  }

  // Kahn's topological sort on instantaneous (non-memory) signal dependencies
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const b of model.blocks) {
    inDegree.set(b.id, 0);
    adj.set(b.id, []);
  }

  for (const edge of effectiveEdges) {
    const src = blockMap.get(edge.from);
    const dst = blockMap.get(edge.to);
    if (!src || !dst) continue;

    // A block breaks an algebraic loop if its output has memory / state delay:
    // state_space breaks loops ONLY if D == 0 (strictly proper).
    // rate_transition / zoh / step_ref / hil_io break instantaneous loops.
    const srcBreaksLoop =
      src.kind === 'state_space'
        ? !hasDirectFeedthrough
        : src.hasMemory;

    if (!srcBreaksLoop) {
      adj.get(src.id)!.push(dst.id);
      inDegree.set(dst.id, (inDegree.get(dst.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }

  const executionOrder: string[] = [];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    executionOrder.push(curr);
    for (const nxt of adj.get(curr) ?? []) {
      const nextDeg = (inDegree.get(nxt) ?? 1) - 1;
      inDegree.set(nxt, nextDeg);
      if (nextDeg === 0) queue.push(nxt);
    }
  }

  if (executionOrder.length < model.blocks.length) {
    const cycleBlocks = model.blocks
      .filter((b) => !executionOrder.includes(b.id))
      .map((b) => b.id);
    issues.push({
      severity: 'error',
      code: 'ALGEBRAIC_LOOP',
      message: 'Algebraic loop detected in instantaneous execution graph.',
      detail: hasDirectFeedthrough
        ? 'Plant matrix D is non-zero (direct feedthrough) and creates a zero-delay cycle. Insert a unit delay or zero D.'
        : `Blocks [${cycleBlocks.join(' -> ')}] form a zero-delay combinational cycle without a state/ZOH break.`,
      involvedBlocks: cycleBlocks,
    });
  }

  // 3. Multi-rate compatibility checks
  const baseDt = model.baseDt;
  const fastDt = baseDt / Math.max(1, model.fastDtRatio);
  for (const edge of effectiveEdges) {
    const src = blockMap.get(edge.from);
    const dst = blockMap.get(edge.to);
    if (!src || !dst) continue;
    if (src.dt === 0 || dst.dt === 0) continue; // continuous plant connected via ZOH/rate transition

    const ratio = Math.max(src.dt, dst.dt) / Math.min(src.dt, dst.dt);
    const nearestInt = Math.round(ratio);
    if (Math.abs(ratio - nearestInt) > 1e-4) {
      issues.push({
        severity: 'error',
        code: 'RATE_MISMATCH',
        message: `Non-integer rate ratio between ${src.id} and ${dst.id}.`,
        detail: `Sample periods (${src.dt}s vs ${dst.dt}s) are not integer multiples for deterministic fixed-step scheduling.`,
        involvedBlocks: [src.id, dst.id],
      });
    }
  }

  // Warn if saturation bounds are inverted
  if (model.limits.satMin >= model.limits.satMax) {
    issues.push({
      severity: 'error',
      code: 'MATRIX_DIM',
      message: 'Actuator saturation minimum must be strictly less than maximum.',
      detail: `satMin (${model.limits.satMin}) >= satMax (${model.limits.satMax}).`,
      involvedBlocks: ['sat_clamp'],
    });
  }

  return {
    valid: !issues.some((i) => i.severity === 'error'),
    executionOrder,
    issues,
    multiRateSummary: {
      baseHz: Math.round(1 / baseDt),
      fastHz: Math.round(1 / fastDt),
      lcmRatio: Math.max(1, model.fastDtRatio),
    },
  };
}
