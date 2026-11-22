import { ControlModel } from '../types/control';

export type TopologyNodeKind = 'controller' | 'input' | 'state' | 'output';

export type TopologyEdgeKind =
  | 'actuation'
  | 'B'
  | 'A_coupling'
  | 'A_self'
  | 'C'
  | 'D_feedthrough'
  | 'lqr_fb'
  | 'pid_fb';

export interface TopologyNode {
  id: string;
  kind: TopologyNodeKind;
  index: number;
  label: string;
  shortLabel: string;
  unit: string;
  subLabel: string;
  x: number;
  y: number;
  width: number;
  height: number;
  hasSelfLoop?: boolean;
  selfLoopGain?: number;
  isPidTarget?: boolean;
  tracksRef?: boolean;
}

export interface TopologyEdge {
  id: string;
  kind: TopologyEdgeKind;
  fromId: string;
  toId: string;
  gain: number;
  label: string;
  equationTerm: string;
  laneIndex: number;
  direction?: 'forward' | 'backward' | 'self' | 'bypass' | 'feedback';
}

export interface TopologyDiagnostics {
  n: number;
  m: number;
  p: number;
  nonZeroA: number;
  selfLoops: number;
  crossCouplings: number;
  nonZeroB: number;
  nonZeroC: number;
  nonZeroD: number;
  activeLqrCount: number;
  pidActive: boolean;
  hasDirectFeedthrough: boolean;
  patternLabel: string;
}

export interface StateSpaceTopology {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  viewBoxWidth: number;
  viewBoxHeight: number;
  diagnostics: TopologyDiagnostics;
  nodeEquations: Record<string, string>;
}

const EPS = 1e-9;

export function formatGainShort(val: number): string {
  const abs = Math.abs(val);
  if (abs < EPS) return '0';
  if (abs >= 1000 || abs < 0.001) return val.toExponential(2);
  if (Number.isInteger(val)) return String(val);
  const rounded = Number(val.toFixed(3));
  return String(rounded);
}

function formatLinearCombination(
  terms: Array<{ coef: number; symbol: string }>,
  zeroFallback = '0'
): string {
  const nonZero = terms.filter((t) => Math.abs(t.coef) > EPS);
  if (nonZero.length === 0) return zeroFallback;
  return nonZero
    .map((term, idx) => {
      const sign = term.coef < 0 ? '-' : '+';
      const mag = Math.abs(term.coef);
      const coefText =
        Math.abs(mag - 1) <= 1e-6 ? '' : `${formatGainShort(mag)}·`;
      if (idx === 0) {
        return `${term.coef < 0 ? '-' : ''}${coefText}${term.symbol}`;
      }
      return ` ${sign} ${coefText}${term.symbol}`;
    })
    .join('');
}

function detectStructuralPattern(
  A: number[][],
  B: number[][],
  n: number,
  m: number,
  p: number,
  crossCouplings: number,
  nonZeroD: number
): string {
  if (n === 1) {
    return nonZeroD > 0 ? '1st-Order Proper (D≠0)' : '1st-Order Integrator/Lag';
  }
  if (crossCouplings === 0) {
    return m > 1 || p > 1 ? 'Decoupled MIMO' : 'Decoupled Modal States';
  }

  // Check Controllable Canonical superdiagonal (A[i][i+1] == 1) + bottom row
  let isCanonical = true;
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n; c++) {
      const expected = c === r + 1 ? 1 : 0;
      if (Math.abs((A[r]?.[c] ?? 0) - expected) > 1e-6) {
        isCanonical = false;
        break;
      }
    }
    if (!isCanonical) break;
  }
  if (isCanonical) {
    return nonZeroD > 0 ? 'Canonical Chain (D≠0)' : 'Controllable Canonical';
  }

  let hasLower = false;
  let hasUpper = false;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (r === c) continue;
      if (Math.abs(A[r]?.[c] ?? 0) > EPS) {
        if (r > c) hasLower = true;
        else hasUpper = true;
      }
    }
  }

  if (hasLower && !hasUpper) return 'Forward Cascade';
  if (hasUpper && !hasLower) return 'Back-Coupled Cascade';
  if (m > 1 || p > 1) return 'Coupled MIMO';
  return 'Coupled State-Space';
}

export function extractStateSpaceTopology(
  model: ControlModel
): StateSpaceTopology {
  const { plant, lqrK, pid, lqrTracksRefOnState0 } = model;
  const n = Math.max(1, plant.n);
  const m = Math.max(1, plant.m);
  const p = Math.max(1, plant.p);
  const A = plant.A;
  const B = plant.B;
  const C = plant.C;
  const D = plant.D;

  // Inspect feedthrough and controller feedback first for dynamic canvas margins
  let nonZeroD = 0;
  for (let k = 0; k < p; k++) {
    for (let j = 0; j < m; j++) {
      if (Math.abs(D[k]?.[j] ?? 0) > EPS) nonZeroD += 1;
    }
  }

  const activeLqrIndices: number[] = [];
  for (let i = 0; i < n; i++) {
    if (Math.abs(lqrK[i] ?? 0) > EPS) activeLqrIndices.push(i);
  }

  const pidHasGain =
    pid.enabled &&
    (Math.abs(pid.kp) > EPS ||
      Math.abs(pid.ki) > EPS ||
      Math.abs(pid.kd) > EPS);
  const hasFeedbackBus = activeLqrIndices.length > 0 || pidHasGain;
  const hasDirectFeedthrough = nonZeroD > 0;

  const maxRows = Math.max(n, m, p, 2);
  const rowPitch = maxRows <= 4 ? 76 : maxRows <= 6 ? 66 : 58;
  const stateH = maxRows <= 4 ? 52 : maxRows <= 6 ? 48 : 44;
  const ioH = maxRows <= 4 ? 50 : maxRows <= 6 ? 46 : 42;

  const topOffset = hasDirectFeedthrough ? 78 : 44;
  const bodyHeight = maxRows * rowPitch;
  const bottomOffset = hasFeedbackBus ? 92 : 36;
  const viewBoxWidth = 960;
  const viewBoxHeight = Math.max(300, topOffset + bodyHeight + bottomOffset);

  const centerBlockColumn = (count: number, height: number): number[] => {
    const span = count * rowPitch;
    const startY = topOffset + (bodyHeight - span) / 2 + (rowPitch - height) / 2;
    return Array.from({ length: count }, (_, idx) => startY + idx * rowPitch);
  };

  const nodes: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];
  const nodeEquations: Record<string, string> = {};

  // 1. Controller / Reference Node (Col 0)
  const ctrlX = 20;
  const ctrlW = 136;
  const ctrlH = 74;
  const ctrlY = topOffset + bodyHeight / 2 - ctrlH / 2;
  const ctrlLabel =
    activeLqrIndices.length > 0 && pidHasGain
      ? 'LQR + PID Law'
      : activeLqrIndices.length > 0
      ? 'LQR State Law'
      : pidHasGain
      ? 'PID Compensator'
      : 'Open-Loop Ref';
  const ctrlSub = [
    activeLqrIndices.length > 0 ? `K(${activeLqrIndices.length})` : null,
    pidHasGain ? `PID→y[${pid.targetOutputIndex}]` : null,
  ]
    .filter(Boolean)
    .join(' · ') || 'u[0] = 0';

  nodes.push({
    id: 'ctrl',
    kind: 'controller',
    index: 0,
    label: ctrlLabel,
    shortLabel: 'CTRL',
    unit: plant.inputUnits?.[0] ?? plant.inputUnit ?? 'u',
    subLabel: ctrlSub,
    x: ctrlX,
    y: ctrlY,
    width: ctrlW,
    height: ctrlH,
  });

  // Controller law equation
  const lqrTerms = activeLqrIndices.map((i) => ({
    coef: -(lqrK[i] ?? 0),
    symbol: i === 0 && lqrTracksRefOnState0 ? `(x[${i}]-r)` : `x[${i}]`,
  }));
  const lawParts: string[] = [];
  if (lqrTerms.length > 0) {
    lawParts.push(formatLinearCombination(lqrTerms));
  }
  if (pidHasGain) {
    const pidErrSym = pid.tracksStepRef
      ? `(r - y[${pid.targetOutputIndex}])`
      : `(-y[${pid.targetOutputIndex}])`;
    lawParts.push(`PID${pidErrSym}`);
  }
  nodeEquations['ctrl'] =
    lawParts.length > 0
      ? `u[0] = clamp(${lawParts.join(' + ')})`
      : 'u[0] = 0 (open-loop / unexcited)';

  // 2. Input Nodes u[0..m-1] (Col 1)
  const uX = 202;
  const uW = 128;
  const uYs = centerBlockColumn(m, ioH);
  for (let j = 0; j < m; j++) {
    const rawName = plant.inputNames?.[j] || (j === 0 ? plant.inputName : `u_${j}`);
    const unit = plant.inputUnits?.[j] || plant.inputUnit || 'u';
    const auxBias = plant.auxInputs?.[j] ?? 0;
    const nodeId = `u_${j}`;

    nodes.push({
      id: nodeId,
      kind: 'input',
      index: j,
      label: rawName,
      shortLabel: `u[${j}]`,
      unit,
      subLabel: j === 0 ? 'Actuated u_sat' : `Aux bias ${formatGainShort(auxBias)}`,
      x: uX,
      y: uYs[j],
      width: uW,
      height: ioH,
    });

    nodeEquations[nodeId] =
      j === 0
        ? `u[0] (${rawName}) = u_sat [${model.limits.satMin}, ${model.limits.satMax}] ${unit}`
        : `u[${j}] (${rawName}) = ${formatGainShort(auxBias)} ${unit} (aux)`;
  }

  // Controller -> u[0]
  edges.push({
    id: 'e_ctrl_u0',
    kind: 'actuation',
    fromId: 'ctrl',
    toId: 'u_0',
    gain: 1,
    label: 'u_sat',
    equationTerm: 'u_sat -> u[0]',
    laneIndex: 0,
    direction: 'forward',
  });

  // 3. State Integrator Nodes x[0..n-1] (Col 2)
  const xX = 480;
  const xW = 148;
  const xYs = centerBlockColumn(n, stateH);

  let nonZeroA = 0;
  let selfLoops = 0;
  let crossCouplings = 0;

  for (let i = 0; i < n; i++) {
    const selfGain = A[i]?.[i] ?? 0;
    const hasSelf = Math.abs(selfGain) > EPS;
    if (hasSelf) {
      nonZeroA += 1;
      selfLoops += 1;
    }

    const rawName = plant.stateNames?.[i] || `x_${i}`;
    const unit = plant.stateUnits?.[i] || 'u';
    const nodeId = `x_${i}`;
    const tracksRef = i === 0 && lqrTracksRefOnState0 && activeLqrIndices.includes(0);

    nodes.push({
      id: nodeId,
      kind: 'state',
      index: i,
      label: rawName,
      shortLabel: `x[${i}]`,
      unit,
      subLabel: `x0=${formatGainShort(plant.x0?.[i] ?? 0)}`,
      x: xX,
      y: xYs[i],
      width: xW,
      height: stateH,
      hasSelfLoop: hasSelf,
      selfLoopGain: hasSelf ? selfGain : 0,
      tracksRef,
    });

    if (hasSelf) {
      edges.push({
        id: `e_A_${i}_${i}`,
        kind: 'A_self',
        fromId: nodeId,
        toId: nodeId,
        gain: selfGain,
        label: formatGainShort(selfGain),
        equationTerm: `${formatGainShort(selfGain)}·x[${i}]`,
        laneIndex: 0,
        direction: 'self',
      });
    }

    // Dynamic state derivative equation dx[i]/dt = sum_j A[i,j] x[j] + sum_j B[i,j] u[j]
    const terms: Array<{ coef: number; symbol: string }> = [];
    for (let c = 0; c < n; c++) {
      terms.push({ coef: A[i]?.[c] ?? 0, symbol: `x[${c}]` });
    }
    for (let j = 0; j < m; j++) {
      terms.push({ coef: B[i]?.[j] ?? 0, symbol: `u[${j}]` });
    }
    nodeEquations[nodeId] = `d(x[${i}])/dt = ${formatLinearCombination(terms)}`;
  }

  // A off-diagonal couplings: x[c] -> x[r] when A[r][c] != 0
  let leftLaneCounter = 0;
  let rightLaneCounter = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (r === c) continue;
      const gain = A[r]?.[c] ?? 0;
      if (Math.abs(gain) <= EPS) continue;
      nonZeroA += 1;
      crossCouplings += 1;

      const isForward = c < r; // upper state feeding lower state
      const laneIndex = isForward ? rightLaneCounter++ : leftLaneCounter++;
      edges.push({
        id: `e_A_${r}_${c}`,
        kind: 'A_coupling',
        fromId: `x_${c}`,
        toId: `x_${r}`,
        gain,
        label: `A[${r},${c}]=${formatGainShort(gain)}`,
        equationTerm: `${formatGainShort(gain)}·x[${c}] → dx[${r}]/dt`,
        laneIndex,
        direction: isForward ? 'forward' : 'backward',
      });
    }
  }

  // B matrix edges: u[j] -> x[i] when B[i][j] != 0
  let nonZeroB = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const gain = B[i]?.[j] ?? 0;
      if (Math.abs(gain) <= EPS) continue;
      nonZeroB += 1;
      edges.push({
        id: `e_B_${i}_${j}`,
        kind: 'B',
        fromId: `u_${j}`,
        toId: `x_${i}`,
        gain,
        label: `B[${i},${j}]=${formatGainShort(gain)}`,
        equationTerm: `${formatGainShort(gain)}·u[${j}] → dx[${i}]/dt`,
        laneIndex: j,
        direction: 'forward',
      });
    }
  }

  // 4. Output Nodes y[0..p-1] (Col 3)
  const yX = 790;
  const yW = 148;
  const yYs = centerBlockColumn(p, ioH);

  let nonZeroC = 0;
  for (let k = 0; k < p; k++) {
    const rawName = plant.outputNames?.[k] || `y_${k}`;
    const unit = plant.outputUnits?.[k] || 'u';
    const nodeId = `y_${k}`;
    const isPidTarget = pidHasGain && pid.targetOutputIndex === k;

    nodes.push({
      id: nodeId,
      kind: 'output',
      index: k,
      label: rawName,
      shortLabel: `y[${k}]`,
      unit,
      subLabel: isPidTarget ? 'PID Feedback Target' : 'Measured Sensor',
      x: yX,
      y: yYs[k],
      width: yW,
      height: ioH,
      isPidTarget,
    });

    const outTerms: Array<{ coef: number; symbol: string }> = [];
    for (let i = 0; i < n; i++) {
      const cGain = C[k]?.[i] ?? 0;
      outTerms.push({ coef: cGain, symbol: `x[${i}]` });
      if (Math.abs(cGain) > EPS) {
        nonZeroC += 1;
        edges.push({
          id: `e_C_${k}_${i}`,
          kind: 'C',
          fromId: `x_${i}`,
          toId: nodeId,
          gain: cGain,
          label: `C[${k},${i}]=${formatGainShort(cGain)}`,
          equationTerm: `${formatGainShort(cGain)}·x[${i}] → y[${k}]`,
          laneIndex: k,
          direction: 'forward',
        });
      }
    }

    for (let j = 0; j < m; j++) {
      const dGain = D[k]?.[j] ?? 0;
      outTerms.push({ coef: dGain, symbol: `u[${j}]` });
      if (Math.abs(dGain) > EPS) {
        edges.push({
          id: `e_D_${k}_${j}`,
          kind: 'D_feedthrough',
          fromId: `u_${j}`,
          toId: nodeId,
          gain: dGain,
          label: `D[${k},${j}]=${formatGainShort(dGain)}`,
          equationTerm: `${formatGainShort(dGain)}·u[${j}] → y[${k}] (direct)`,
          laneIndex: k * m + j,
          direction: 'bypass',
        });
      }
    }

    nodeEquations[nodeId] = `y[${k}] = ${formatLinearCombination(outTerms)}`;
  }

  // 5. LQR Feedback Edges: x[i] -> ctrl
  activeLqrIndices.forEach((stateIdx, laneIdx) => {
    const kVal = lqrK[stateIdx] ?? 0;
    edges.push({
      id: `e_lqr_${stateIdx}`,
      kind: 'lqr_fb',
      fromId: `x_${stateIdx}`,
      toId: 'ctrl',
      gain: -kVal,
      label: `-K[${stateIdx}]=${formatGainShort(-kVal)}`,
      equationTerm: `${formatGainShort(-kVal)}·x[${stateIdx}] → u[0]`,
      laneIndex: laneIdx,
      direction: 'feedback',
    });
  });

  // 6. PID Output Feedback Edge: y[target] -> ctrl
  if (pidHasGain) {
    const targetIdx = Math.max(0, Math.min(p - 1, pid.targetOutputIndex));
    edges.push({
      id: `e_pid_${targetIdx}`,
      kind: 'pid_fb',
      fromId: `y_${targetIdx}`,
      toId: 'ctrl',
      gain: pid.kp,
      label: `PID(${formatGainShort(pid.kp)},${formatGainShort(pid.ki)},${formatGainShort(pid.kd)})`,
      equationTerm: `PID(y[${targetIdx}]) → u[0]`,
      laneIndex: activeLqrIndices.length,
      direction: 'feedback',
    });
  }

  const patternLabel = detectStructuralPattern(
    A,
    B,
    n,
    m,
    p,
    crossCouplings,
    nonZeroD
  );

  return {
    nodes,
    edges,
    viewBoxWidth,
    viewBoxHeight,
    diagnostics: {
      n,
      m,
      p,
      nonZeroA,
      selfLoops,
      crossCouplings,
      nonZeroB,
      nonZeroC,
      nonZeroD,
      activeLqrCount: activeLqrIndices.length,
      pidActive: pidHasGain,
      hasDirectFeedthrough,
      patternLabel,
    },
    nodeEquations,
  };
}
