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

const ESP32_ULTRASONIC_MODEL: ControlModel = {
  id: 'esp32_ultrasonic_hold',
  basePreset: 'dcmotor',
  isCustomModel: true,
  name: 'ESP32 Ultrasonic Distance Hold (HC-SR04 + RH)',
  subtitle:
    '50 Hz HC-SR04 ranging loop with DHT humidity speed-of-sound compensation, LQR/PID hold & PWM LED / Relay output',
  license: 'MIT',
  baseDt: 0.02, // 50 Hz ultrasonic ping & PID cadence
  fastDtRatio: 2, // 100 Hz PWM/buzzer/HIL framing cadence
  duration: 6.5,
  discretization: 'zoh',
  plant: {
    n: 2,
    m: 1,
    p: 2,
    stateNames: ['distance_m', 'velocity_ms'],
    stateUnits: ['m', 'm/s'],
    outputNames: ['Range Distance (m)', 'Range Velocity (m/s)'],
    outputUnits: ['m', 'm/s'],
    inputName: 'Drive Effort (u)',
    inputUnit: '%',
    inputNames: ['Drive Effort (u)'],
    inputUnits: ['%'],
    auxInputs: [0],
    A: [
      [0, 1],
      [0, -3.2],
    ],
    B: [[0], [0.08]],
    C: [
      [1, 0],
      [0, 1],
    ],
    D: [[0], [0]],
    x0: [0.45, 0],
  },
  lqrK: [0.0, 10.0],
  lqrTracksRefOnState0: false,
  pid: {
    enabled: true,
    targetOutputIndex: 0,
    tracksStepRef: true,
    kp: 240.0,
    ki: 160.0,
    kd: 42.0,
    nFilter: 30.0,
    kbAntiWindup: 25.0,
  },
  limits: {
    satMin: -100.0,
    satMax: 100.0,
    rateLimit: 360.0,
  },
  reference: {
    stepTime: 0.5,
    initialValue: 0.45,
    finalValue: 0.25,
    disturbanceTime: 3.0,
    disturbanceMagnitude: 10.0,
  },
  hil: {
    transport: 'uart_cobs',
    baudOrRate: '921600 bps',
    watchdogMissLimit: 3,
    safeClampValue: 0.0,
    txChannels: ['pwm_led_pct'],
    rxChannels: ['dist_m', 'vel_ms'],
  },
  blocks: [
    { id: 'step_ref', label: 'Distance Ref (m)', kind: 'step_ref', dt: 0.02, x: 30, y: 120, hasMemory: true },
    { id: 'sum_err', label: 'Range Error', kind: 'sum', dt: 0.02, x: 165, y: 120, hasMemory: false },
    { id: 'lqr_ctrl', label: 'Velocity Damp (K_v)', kind: 'lqr_gain', dt: 0.02, x: 300, y: 65, hasMemory: false },
    { id: 'pid_ctrl', label: 'Distance PID', kind: 'pid', dt: 0.02, x: 300, y: 175, hasMemory: true },
    { id: 'rate_lim', label: 'Slew Limiter', kind: 'rate_limiter', dt: 0.01, x: 455, y: 120, hasMemory: true },
    { id: 'sat_clamp', label: 'PWM / Relay Clamp (±100%)', kind: 'saturation', dt: 0.01, x: 585, y: 120, hasMemory: false },
    { id: 'zoh_bridge', label: 'ZOH / LEDC PWM', kind: 'rate_transition', dt: 0.02, x: 715, y: 65, hasMemory: true },
    { id: 'plant_ss', label: 'HC-SR04 Ranging Plant (2x2)', kind: 'state_space', dt: 0, x: 715, y: 185, hasMemory: true },
    { id: 'hil_bridge', label: 'ESP32 UART COBS', kind: 'hil_io', dt: 0.01, x: 455, y: 245, hasMemory: true },
  ],
  edges: [
    { id: 'e1', from: 'step_ref', fromPort: 'ref', to: 'sum_err', toPort: 'in+', signalName: 'd_ref' },
    { id: 'e2', from: 'sum_err', fromPort: 'err', to: 'lqr_ctrl', toPort: 'dx', signalName: 'v_est' },
    { id: 'e3', from: 'sum_err', fromPort: 'err', to: 'pid_ctrl', toPort: 'err', signalName: 'e_dist' },
    { id: 'e4', from: 'lqr_ctrl', fromPort: 'u_lqr', to: 'rate_lim', toPort: 'in1', signalName: 'u_damp' },
    { id: 'e5', from: 'pid_ctrl', fromPort: 'u_pid', to: 'rate_lim', toPort: 'in2', signalName: 'u_pid' },
    { id: 'e6', from: 'rate_lim', fromPort: 'out', to: 'sat_clamp', toPort: 'in', signalName: 'u_slew' },
    { id: 'e7', from: 'sat_clamp', fromPort: 'u', to: 'zoh_bridge', toPort: 'in', signalName: 'u_pwm' },
    { id: 'e8', from: 'zoh_bridge', fromPort: 'out', to: 'plant_ss', toPort: 'u', signalName: 'u_zoh' },
    { id: 'e9', from: 'plant_ss', fromPort: 'y', to: 'sum_err', toPort: 'fb-', signalName: 'dist_meas' },
    { id: 'e10', from: 'sat_clamp', fromPort: 'u', to: 'hil_bridge', toPort: 'tx', signalName: 'hil_tx' },
    { id: 'e11', from: 'hil_bridge', fromPort: 'rx', to: 'sum_err', toPort: 'hil_fb', signalName: 'hil_rx' },
  ],
};

const ESP32_GAS_HUMIDITY_MODEL: ControlModel = {
  id: 'esp32_gas_humidity_relay',
  basePreset: 'dcmotor',
  isCustomModel: true,
  name: 'ESP32 Gas & Humidity Relay Loop (MQ + DHT)',
  subtitle:
    '20 Hz ADC1 gas & humidity monitor with filtered PID, relay/buzzer hysteresis clamping & COBS telemetry',
  license: 'MIT',
  baseDt: 0.05, // 20 Hz environmental loop
  fastDtRatio: 2,
  duration: 12.0,
  discretization: 'zoh',
  plant: {
    n: 2,
    m: 1,
    p: 2,
    stateNames: ['gas_ppm', 'rel_humidity'],
    stateUnits: ['ppm', '%RH'],
    outputNames: ['Gas Level (ppm)', 'Rel Humidity (%RH)'],
    outputUnits: ['ppm', '%RH'],
    inputName: 'Vent / Relay Drive (%)',
    inputUnit: '%',
    inputNames: ['Vent / Relay Drive (%)'],
    inputUnits: ['%'],
    auxInputs: [0],
    A: [
      [-0.45, 0.08],
      [0.0, -0.22],
    ],
    B: [[2.2], [0.4]],
    C: [
      [1, 0],
      [0, 1],
    ],
    D: [[0], [0]],
    x0: [50, 45],
  },
  lqrK: [0.0, 0.1],
  lqrTracksRefOnState0: false,
  pid: {
    enabled: true,
    targetOutputIndex: 0,
    tracksStepRef: true,
    kp: 1.35,
    ki: 0.6,
    kd: 0.12,
    nFilter: 10.0,
    kbAntiWindup: 1.2,
  },
  limits: {
    satMin: 0.0,
    satMax: 100.0,
    rateLimit: 200.0,
  },
  reference: {
    stepTime: 1.0,
    initialValue: 50.0,
    finalValue: 220.0,
    disturbanceTime: 6.5,
    disturbanceMagnitude: 35.0,
  },
  hil: {
    transport: 'uart_cobs',
    baudOrRate: '921600 bps',
    watchdogMissLimit: 4,
    safeClampValue: 0.0,
    txChannels: ['relay_duty_pct'],
    rxChannels: ['gas_ppm', 'rh_pct'],
  },
  blocks: [
    { id: 'step_ref', label: 'Gas Threshold Ref (ppm)', kind: 'step_ref', dt: 0.05, x: 30, y: 120, hasMemory: true },
    { id: 'sum_err', label: 'Gas / RH Error', kind: 'sum', dt: 0.05, x: 165, y: 120, hasMemory: false },
    { id: 'lqr_ctrl', label: 'RH Feed-Damp (K_rh)', kind: 'lqr_gain', dt: 0.05, x: 300, y: 65, hasMemory: false },
    { id: 'pid_ctrl', label: 'Environmental PID', kind: 'pid', dt: 0.05, x: 300, y: 175, hasMemory: true },
    { id: 'rate_lim', label: 'Drive Slew Clamp', kind: 'rate_limiter', dt: 0.025, x: 455, y: 120, hasMemory: true },
    { id: 'sat_clamp', label: 'Relay / PWM Clamp [0..100%]', kind: 'saturation', dt: 0.025, x: 585, y: 120, hasMemory: false },
    { id: 'zoh_bridge', label: 'ZOH / Relay Latch', kind: 'rate_transition', dt: 0.05, x: 715, y: 65, hasMemory: true },
    { id: 'plant_ss', label: 'MQ Gas + DHT Chamber (2x2)', kind: 'state_space', dt: 0, x: 715, y: 185, hasMemory: true },
    { id: 'hil_bridge', label: 'ESP32 UART COBS', kind: 'hil_io', dt: 0.025, x: 455, y: 245, hasMemory: true },
  ],
  edges: [
    { id: 'e1', from: 'step_ref', fromPort: 'ref', to: 'sum_err', toPort: 'in+', signalName: 'ppm_ref' },
    { id: 'e2', from: 'sum_err', fromPort: 'err', to: 'lqr_ctrl', toPort: 'dx', signalName: 'rh_pct' },
    { id: 'e3', from: 'sum_err', fromPort: 'err', to: 'pid_ctrl', toPort: 'err', signalName: 'e_ppm' },
    { id: 'e4', from: 'lqr_ctrl', fromPort: 'u_lqr', to: 'rate_lim', toPort: 'in1', signalName: 'u_rh' },
    { id: 'e5', from: 'pid_ctrl', fromPort: 'u_pid', to: 'rate_lim', toPort: 'in2', signalName: 'u_pid' },
    { id: 'e6', from: 'rate_lim', fromPort: 'out', to: 'sat_clamp', toPort: 'in', signalName: 'u_slew' },
    { id: 'e7', from: 'sat_clamp', fromPort: 'u', to: 'zoh_bridge', toPort: 'in', signalName: 'u_relay' },
    { id: 'e8', from: 'zoh_bridge', fromPort: 'out', to: 'plant_ss', toPort: 'u', signalName: 'u_zoh' },
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
  {
    id: 'esp32_ultrasonic_hold',
    label: 'Ultrasonic Distance Hold (HC-SR04 + RH)',
    category: 'ESP32 HIL',
    summary: '50 Hz HC-SR04 ranging + humidity sound-speed comp feeding PWM LED & hysteresis relay',
    model: ESP32_ULTRASONIC_MODEL,
  },
  {
    id: 'esp32_gas_humidity_relay',
    label: 'Gas & Humidity Relay Loop (MQ + DHT)',
    category: 'ESP32 HIL',
    summary: '20 Hz filtered MQ-series gas ADC1 + DHT humidity enclosure relay & buzzer clamp loop',
    model: ESP32_GAS_HUMIDITY_MODEL,
  },
];

export function getPlantTemplateById(id: string): PlantTemplate | undefined {
  return PLANT_TEMPLATES.find((tpl) => tpl.id === id);
}
