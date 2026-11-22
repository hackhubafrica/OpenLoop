export const TEMPLATING_ENGINE_DOCS_MD = `# OpenLoop Templating Engine & Schema Guide

OpenLoop uses a **declarative, Git-diffable Intermediate Representation (IR)** stored in \`.ctrl.toml\` or \`.ctrl.json\` files. Templates compile deterministically into continuous RK4 Model-in-the-Loop (MIL) plants, fixed-step ZOH/Tustin Software-in-the-Loop (SIL) kernels, C/Rust/Python codegen targets, and dynamic state-space signal-flow schematics.

> All plant templates, built-in presets, transfer-function realizations, and imported user files normalize into a single \`ControlModel\` schema before solver execution and validation.

---

## 1. Architecture & Template Resolution Pipeline

When a template or custom file is loaded into the workbench, OpenLoop runs a four-stage normalization and binding pipeline:

1. **Source Ingestion**: Reads a built-in \`PlantTemplate\`, a Transfer Function polynomial pair \`N(s)/D(s)\`, or an external \`.ctrl.toml\` / \`.ctrl.json\` payload.
2. **Fallback Inheritance (\`basePreset\`)**: Any omitted optional metadata (\`[limits]\`, \`[reference]\`, \`[hil]\`, or schematic \`[[blocks]]\` layout coordinates) inherits defaults from the resolved \`basePreset\` (\`pendulum\`, \`dcmotor\`, or \`buck\`).
3. **Dimension & Channel Normalization**: Validates state count \`n\` (\`1..8\`), input count \`m\` (\`1..4\`), and output count \`p\` (\`1..4\`). Missing channel names or units automatically pad to \`x_i\`, \`u_j\`, and \`y_k\`.
4. **Structural Graph Compilation**: Runs \`validateControlModel\` (dimension assertions, algebraic loop detection, multi-rate integer-ratio checks) and compiles the live **State-Space Model GUI** directly from non-zero entries of \`A\`, \`B\`, \`C\`, and \`D\`.

---

## 2. Syntax for Defining Custom Block Components

In OpenLoop, every control loop combines a declarative **Execution Block Graph** (\`[[blocks]]\` and \`[[connections]]\`) with a continuous/discrete **State-Space Plant** (\`[plant.state_space]\`).

### Block Primitive Types (\`BlockKind\`)

| \`kind\` Identifier | Role in Pipeline | Default Memory Break | Typical Sample Rate |
| :--- | :--- | :--- | :--- |
| \`step_ref\` | Setpoint & impulse disturbance generator | \`true\` (source) | \`base_dt\` |
| \`sum\` | Error & feedback summing junction | \`false\` (combinational) | \`base_dt\` |
| \`lqr_gain\` | Full-state feedback law \`-K · (x - x_ref)\` | \`false\` (combinational) | \`base_dt\` |
| \`pid\` | Filtered PID compensator with anti-windup | \`true\` (integrator/filter state) | \`base_dt\` |
| \`rate_limiter\` | Slew-rate clamp (\`du/dt\` bound) | \`true\` (holds \`prev_u\`) | \`base_dt / fast_dt_ratio\` |
| \`saturation\` | Hard actuator clamp \`[sat_min, sat_max]\` | \`false\` (algebraic clamp) | \`base_dt / fast_dt_ratio\` |
| \`rate_transition\` | Zero-order hold / multi-rate bridge | \`true\` (sample latch) | \`base_dt\` |
| \`state_space\` | Continuous/discrete plant \`(A, B, C, D)\` | \`true\` iff \`D == 0\` | \`0\` (continuous RK4) |
| \`hil_io\` | Hardware-in-the-loop UART/CAN/UDP transceiver | \`true\` (frame buffer) | \`base_dt / fast_dt_ratio\` |

### Defining \`[[blocks]]\` in TOML IR

Each block entry declares a unique \`id\`, a valid \`kind\`, an execution period \`dt\` in seconds (\`0\` denotes continuous integration), and a \`memory\` flag used by Kahn's topological scheduler:

\`\`\`toml
[[blocks]]
id = "step_ref"
kind = "step_ref"
dt = 0.01
memory = true

[[blocks]]
id = "sum_err"
kind = "sum"
dt = 0.01
memory = false

[[blocks]]
id = "pid_ctrl"
kind = "pid"
dt = 0.01
memory = true

[[blocks]]
id = "plant_ss"
kind = "state_space"
dt = 0
memory = true
\`\`\`

### Wiring Ports with \`[[connections]]\`

Signal edges bind an output port of a source block to an input port of a destination block using dot notation \`"<block_id>.<port_name>"\`:

\`\`\`toml
[[connections]]
from = "step_ref.ref"
to = "sum_err.in+"
signal = "x_ref"

[[connections]]
from = "sum_err.err"
to = "pid_ctrl.err"
signal = "e_track"

[[connections]]
from = "plant_ss.y"
to = "sum_err.fb-"
signal = "y_meas"
\`\`\`

### Extended Custom Block Metadata (JSON / TypeScript Templates)

When authoring reusable \`PlantTemplate\` objects in TypeScript or \`.ctrl.json\`, blocks also carry schematic canvas coordinates (\`x\`, \`y\`) and human-readable display labels:

\`\`\`json
{
  "blocks": [
    {
      "id": "plant_ss",
      "label": "Mass-Spring-Damper (2x2)",
      "kind": "state_space",
      "dt": 0,
      "x": 715,
      "y": 185,
      "hasMemory": true
    }
  ],
  "edges": [
    {
      "id": "e8",
      "from": "zoh_bridge",
      "fromPort": "out",
      "to": "plant_ss",
      "toPort": "u",
      "signalName": "F_zoh"
    }
  ]
}
\`\`\`

> **Dynamic Model GUI**: Whenever you import a custom model, apply a template, convert a transfer function, or resize \`(n, m, p)\`, the Workbench **State-Space Model GUI** automatically synthesizes block nodes and weighted signal paths directly from non-zero matrix elements in \`A\`, \`B\`, \`C\`, and \`D\`.

---

## 3. Parameter Binding Rules & Invariants

All numeric arrays, matrices, and controller parameters must obey strict structural bindings so simulation, stability analysis, and embedded C/Rust codegen remain synchronized.

### Matrix & Vector Dimension Bindings

| Parameter Key (TOML / JSON) | Required Shape | Bound Limits | Engine Role |
| :--- | :--- | :--- | :--- |
| \`n\`, \`m\`, \`p\` | Positive integers | \`1 <= n <= 8\`, \`1 <= m,p <= 4\` | State, input, and output dimensions |
| \`A\` | \`n x n\` matrix | Finite floats | State transition matrix \`dx/dt = Ax + Bu\` |
| \`B\` | \`n x m\` matrix | Finite floats | Input distribution matrix |
| \`C\` | \`p x n\` matrix | Finite floats | Output observation matrix \`y = Cx + Du\` |
| \`D\` | \`p x m\` matrix | Finite floats | Direct feedthrough (breaks \`state_space\` memory if non-zero) |
| \`x0\` | Length \`n\` vector | Finite floats | Initial state vector \`x(0)\` |
| \`controller.lqr.K\` | Length \`n\` vector | Finite floats | Full-state feedback gain \`u_lqr = -K·(x - x_ref)\` |

### Channel Naming & Auxiliary Input Bindings

- **Primary & Auxiliary Inputs (\`m > 1\`)**:
  - \`u[0]\` is **always bound** to the active closed-loop actuator signal \`u_sat\` (combined LQR + PID law after rate limiting and clamping).
  - Auxiliary channels \`u[1 .. m-1]\` bind to steady/trim bias values stored in \`plant.auxInputs[j]\` (defaulting to \`0\`).
  - \`inputs\` and \`input_units\` bind label/unit metadata per channel; omitted trailing entries auto-pad to \`u_j\` and inherit \`input_units[0]\`.
- **States & Outputs**:
  - \`states\` / \`state_units\` bind 1-to-1 to \`x[0 .. n-1]\`.
  - \`outputs\` / \`output_units\` bind 1-to-1 to \`y[0 .. p-1]\`.

### Controller Target Bindings

- **PID Feedback Target (\`target_output_idx\`)**:
  - Clamped automatically to valid output indices \`0 <= target_output_idx <= p - 1\`.
  - When \`tracks_step_ref = true\`, PID regulates error \`e = ref - y[target_output_idx]\`.
  - When \`tracks_step_ref = false\`, PID regulates \`y[target_output_idx] -> 0\` (e.g., inner pendulum angle stabilization while outer LQR tracks cart position).
- **LQR Reference Tracking (\`tracks_ref_state0\`)**:
  - When \`true\`, LQR computes \`-K[0] * (x[0] - ref) - sum_{i>0} K[i] * x[i]\`.
  - When \`false\`, LQR acts purely as active state damping \`-sum_i K[i] * x[i]\`, leaving reference tracking to PID.
- **Anti-Windup & Derivative Filter**:
  - \`kb_anti_windup\` scales back-calculation \`(u_sat - u_raw)\` into the PID integrator when \`ki != 0\`.
  - \`n_filter\` (> \`0.1 rad/s\`) sets the backward-Euler derivative low-pass pole at \`s = -N\`.

### Algebraic Loop & Multi-Rate Scheduling Rules

1. **Algebraic Loop Rule**: Every directed cycle in \`[[connections]]\` must pass through at least one block with \`memory = true\`. If \`D != 0\`, the \`state_space\` block loses its implicit unit-delay break (\`hasDirectFeedthrough = true\`), triggering an \`ALGEBRAIC_LOOP\` error unless a \`rate_transition\` or delay breaks the path.
2. **Multi-Rate Integer Ratio Rule**: For any connected discrete blocks \`src -> dst\` where both have \`dt > 0\`, \`max(src.dt, dst.dt) / min(src.dt, dst.dt)\` must equal an integer within \`1e-4\`. Non-integer ratios raise \`RATE_MISMATCH\`.

---

## 4. Complete Custom Template Example (\`.ctrl.toml\`)

Copy and paste this template directly into the **IR Editor** tab (or import as a \`.ctrl.toml\` file) to instantiate a coupled 2-input, 2-output system with direct feedthrough:

\`\`\`toml
[model]
id = "dual_zone_thermal"
name = "Dual-Zone Thermal Plant"
license = "MIT"
base_dt = 0.01
fast_dt_ratio = 2
duration = 5.0
discretization = "zoh"

[plant.state_space]
n = 2
m = 2
p = 2
states = [ "core_temp", "chassis_temp" ]
state_units = [ "C", "C" ]
inputs = [ "heater_cmd", "ambient_bias" ]
input_units = [ "W", "W" ]
outputs = [ "sensor_core", "sensor_chassis" ]
output_units = [ "C", "C" ]
x0 = [ 0, 0 ]
A = [
  [ -0.6, 0.25 ],
  [ 0.15, -0.4 ]
]
B = [
  [ 1.2, 0.0 ],
  [ 0.0, 0.5 ]
]
C = [
  [ 1.0, 0.0 ],
  [ 0.0, 1.0 ]
]
D = [
  [ 0.0, 0.0 ],
  [ 0.0, 0.0 ]
]

[controller.lqr]
tracks_ref_state0 = false
K = [ 0.0, 0.8 ]

[controller.pid]
enabled = true
target_output_idx = 0
tracks_step_ref = true
kp = 4.5
ki = 1.8
kd = 0.35
n_filter = 25.0
kb_anti_windup = 3.0

[limits]
sat_min = -20.0
sat_max = 20.0
rate_limit = 150.0

[reference]
step_time = 0.5
initial_value = 0.0
final_value = 1.0
disturbance_time = 2.5
disturbance_magnitude = -4.0
\`\`\`
`;
