import { ControlModel } from '../types/control';

export interface PlantTemplate {
  id: string;
  label: string;
  category: string;
  summary: string;
  model: ControlModel;
}

/**
 * Single-DOF Mass-Spring-Damper Cart (m = 1.0 kg, k = 16.0 N/m, c = 1.2 N*s/m)
 * Continuous equations of motion:
 *   x_dot = [ 0,   1  ] x + [ 0 ] F
 *           [-k/m, -c/m]     [1/m]
 */
const MASS_SPRING_DAMPER_MODEL: ControlModel = {
  id: 'mass_spring_damper',
  basePreset: 'pendulum',
  isCustomModel: true,
  name: 'Mass-Spring-Damper Cart (2-State PID + Damping)',
  subtitle:
    'Single-DOF cart (m = 1 kg, k = 16 N/m, c = 1.2 N·s/m) with PID tracking, active velocity damping & ±30 N actuator clamp',
  license: 'MIT',
  baseDt: 0.01, // 100 Hz control loop
  fastDtRatio: 2, // 200 Hz inner HIL/actuator rate
  duration: 4.5,
  discretization: 'zoh',
  plant: {
    n: 2,
    m: 1,
    p: 2,
    stateNames: ['x', 'x_dot'],
    stateUnits: ['m', 'm/s'],
    outputNames: ['Position (x)', 'Velocity (x_dot)'],
    outputUnits: ['m', 'm/s'],
    inputName: 'Applied Force (F)',
    inputUnit: 'N',
    inputNames: ['Applied Force (F)'],
    inputUnits: ['N'],
    auxInputs: [0],
    A: [
      [0, 1],
      [-16.0, -1.2],
    ],
    B: [[0], [1.0]],
    C: [
      [1, 0],
      [0, 1],
    ],
    D: [[0], [0]],
    x0: [0, 0],
  },
  lqrK: [0.0, 2.5], // Active velocity damping feedback (-2.5 * x_dot)
  lqrTracksRefOnState0: false,
  pid: {
    enabled: true,
    targetOutputIndex: 0, // Position y[0] = x
    tracksStepRef: true,
    kp: 32.0,
    ki: 56.0,
    kd: 6.0,
    nFilter: 60.0,
    kbAntiWindup: 14.0,
  },
  limits: {
    satMin: -35.0,
    satMax: 35.0,
    rateLimit: 500.0,
  },
  reference: {
    stepTime: 0.4,
    initialValue: 0.0,
    finalValue: 1.0,
    disturbanceTime: 2.2,
    disturbanceMagnitude: -12.0,
  },
  hil: {
    transport: 'uart_cobs',
    baudOrRate: '921600 bps',
    watchdogMissLimit: 3,
    safeClampValue: 0.0,
    txChannels: ['force_N'],
    rxChannels: ['x_m', 'xdot_ms'],
  },
  blocks: [
    { id: 'step_ref', label: 'Step Ref (x_ref)', kind: 'step_ref', dt: 0.01, x: 30, y: 120, hasMemory: true },
    { id: 'sum_err', label: 'Position Error', kind: 'sum', dt: 0.01, x: 165, y: 120, hasMemory: false },
    { id: 'lqr_ctrl', label: 'Active Damping (K_v)', kind: 'lqr_gain', dt: 0.01, x: 300, y: 65, hasMemory: false },
    { id: 'pid_ctrl', label: 'Position PID', kind: 'pid', dt: 0.01, x: 300, y: 175, hasMemory: true },
    { id: 'rate_lim', label: 'Force Slew Limiter', kind: 'rate_limiter', dt: 0.005, x: 455, y: 120, hasMemory: true },
    { id: 'sat_clamp', label: 'Force Clamp (±30N)', kind: 'saturation', dt: 0.005, x: 585, y: 120, hasMemory: false },
    { id: 'zoh_bridge', label: 'ZOH / Rate Trans', kind: 'rate_transition', dt: 0.01, x: 715, y: 65, hasMemory: true },
    { id: 'plant_ss', label: 'Mass-Spring-Damper (2x2)', kind: 'state_space', dt: 0, x: 715, y: 185, hasMemory: true },
    { id: 'hil_bridge', label: 'HIL Bridge I/O', kind: 'hil_io', dt: 0.005, x: 455, y: 245, hasMemory: true },
  ],
  edges: [
    { id: 'e1', from: 'step_ref', fromPort: 'ref', to: 'sum_err', toPort: 'in+', signalName: 'x_ref' },
    { id: 'e2', from: 'sum_err', fromPort: 'err', to: 'lqr_ctrl', toPort: 'dx', signalName: 'x_dot' },
    { id: 'e3', from: 'sum_err', fromPort: 'err', to: 'pid_ctrl', toPort: 'err', signalName: 'e_x' },
    { id: 'e4', from: 'lqr_ctrl', fromPort: 'u_lqr', to: 'rate_lim', toPort: 'in1', signalName: 'u_damp' },
    { id: 'e5', from: 'pid_ctrl', fromPort: 'u_pid', to: 'rate_lim', toPort: 'in2', signalName: 'u_pid' },
    { id: 'e6', from: 'rate_lim', fromPort: 'out', to: 'sat_clamp', toPort: 'in', signalName: 'f_slew' },
    { id: 'e7', from: 'sat_clamp', fromPort: 'u', to: 'zoh_bridge', toPort: 'in', signalName: 'F_cmd' },
    { id: 'e8', from: 'zoh_bridge', fromPort: 'out', to: 'plant_ss', toPort: 'u', signalName: 'F_zoh' },
    { id: 'e9', from: 'plant_ss', fromPort: 'y', to: 'sum_err', toPort: 'fb-', signalName: 'y_meas' },
    { id: 'e10', from: 'sat_clamp', fromPort: 'u', to: 'hil_bridge', toPort: 'tx', signalName: 'hil_tx' },
    { id: 'e11', from: 'hil_bridge', fromPort: 'rx', to: 'sum_err', toPort: 'hil_fb', signalName: 'hil_rx' },
  ],
};

export const PLANT_TEMPLATES: PlantTemplate[] = [
  {
    id: 'mass_spring_damper',
    label: 'Mass-Spring-Damper (2-State)',
    category: 'Mechanical',
    summary: 'Single-DOF cart (m=1 kg, k=16 N/m, c=1.2 N·s/m) with PID + velocity damping',
    model: MASS_SPRING_DAMPER_MODEL,
  },
];

export function getPlantTemplateById(id: string): PlantTemplate | undefined {
  return PLANT_TEMPLATES.find((tpl) => tpl.id === id);
}
