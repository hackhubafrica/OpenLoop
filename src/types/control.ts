export type DiscretizationMethod = 'zoh' | 'tustin';

export type PresetId = 'pendulum' | 'dcmotor' | 'buck';

export type BlockKind =
  | 'step_ref'
  | 'sum'
  | 'lqr_gain'
  | 'pid'
  | 'rate_limiter'
  | 'saturation'
  | 'state_space'
  | 'rate_transition'
  | 'hil_io';

export interface BlockNode {
  id: string;
  label: string;
  kind: BlockKind;
  dt: number; // Sample time in seconds (0 = continuous)
  x: number; // Schematic layout X (0..900)
  y: number; // Schematic layout Y (0..320)
  hasMemory: boolean; // True if output does not algebraically depend on same-tick input (e.g., D==0 state_space, rate_transition)
}

export interface SignalEdge {
  id: string;
  from: string;
  fromPort: string;
  to: string;
  toPort: string;
  signalName: string;
}

export interface StateSpaceConfig {
  n: number; // State dimension
  m: number; // Input dimension
  p: number; // Output dimension
  stateNames: string[];
  stateUnits: string[];
  outputNames: string[];
  outputUnits: string[];
  inputName: string;
  inputUnit: string;
  inputNames: string[];
  inputUnits: string[];
  auxInputs?: number[]; // Steady/trim excitation for auxiliary input channels u[1..m-1]
  A: number[][];
  B: number[][];
  C: number[][];
  D: number[][];
  x0: number[];
}

export interface PidConfig {
  enabled: boolean;
  targetOutputIndex: number; // Which output y[idx] the PID regulates (for pendulum: theta idx 1 with target 0, for motor/buck: y[0] tracks step ref)
  tracksStepRef: boolean; // If true, error = ref - y[idx]; if false, error = 0 - y[idx]
  kp: number;
  ki: number;
  kd: number;
  nFilter: number; // Derivative low-pass filter coefficient N (rad/s)
  kbAntiWindup: number; // Back-calculation anti-windup gain
}

export interface LimitsConfig {
  satMin: number;
  satMax: number;
  rateLimit: number; // Max |du/dt| in units/s
}

export interface StepRefConfig {
  stepTime: number;
  initialValue: number;
  finalValue: number;
  disturbanceTime: number;
  disturbanceMagnitude: number;
}

export interface HilConfig {
  transport: 'uart_cobs' | 'socketcan' | 'udp';
  baudOrRate: string;
  watchdogMissLimit: number;
  safeClampValue: number;
  txChannels: string[];
  rxChannels: string[];
}

export interface ControlModel {
  id: string;
  basePreset?: PresetId;
  isCustomModel?: boolean;
  name: string;
  subtitle: string;
  license: 'MIT' | 'Apache-2.0';
  baseDt: number; // Fixed controller step in seconds
  fastDtRatio: number; // Sub-rate / multi-rate multiplier for inner fast loop
  duration: number;
  discretization: DiscretizationMethod;
  plant: StateSpaceConfig;
  lqrK: number[]; // Full-state feedback gain vector of length n
  lqrTracksRefOnState0: boolean; // Whether x_ref[0] = step_ref
  pid: PidConfig;
  limits: LimitsConfig;
  reference: StepRefConfig;
  hil: HilConfig;
  blocks: BlockNode[];
  edges: SignalEdge[];
  injectAlgebraicLoopTest?: boolean;
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: 'ALGEBRAIC_LOOP' | 'RATE_MISMATCH' | 'MATRIX_DIM' | 'SYNTAX';
  message: string;
  detail: string;
  involvedBlocks: string[];
}

export interface ValidationReport {
  valid: boolean;
  executionOrder: string[];
  issues: ValidationIssue[];
  multiRateSummary: {
    baseHz: number;
    fastHz: number;
    lcmRatio: number;
  };
}

export interface DiscretizedMatrices {
  method: DiscretizationMethod;
  dt: number;
  Ad: number[][];
  Bd: number[][];
  Cd: number[][];
  Dd: number[][];
  spectralRadius: number;
}

export interface TimeSample {
  stepIndex: number;
  t: number;
  ref: number;
  milOutputs: number[];
  silOutputs: number[];
  milStates: number[];
  silStates: number[];
  uRaw: number;
  uSat: number;
  pidIntegral: number;
  saturated: boolean;
}

export interface SimulationMetrics {
  rmsError: number;
  peakOvershootPct: number;
  settlingTimeSec: number | null;
  peakEffort: number;
  saturationDutyPct: number;
  finalValue: number;
  computeTimePerIterationUs: number;
  flopsPerIteration: number;
  executedSteps: number;
}

export interface SimulationTrace {
  samples: TimeSample[];
  metrics: SimulationMetrics;
  discrete: DiscretizedMatrices;
}

export interface HilFramePacket {
  seq: number;
  tickUs: number;
  simTime: number;
  transport: HilConfig['transport'];
  payloadFloats: number[];
  crc16: number;
  rawHex: string;
  wireHex: string;
  byteLength: number;
  rttMs: number;
  dropped: boolean;
  deadlineMissed: boolean;
  watchdogState: 'NOMINAL' | 'WARN' | 'SAFE_CLAMP';
}
