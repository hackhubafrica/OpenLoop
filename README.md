# OpenLoop — Embedded Control Systems & HIL Workbench

An open-source (MIT / Apache-2.0) browser-based control engineering workbench and firmware code generator designed as a license-free alternative to proprietary control toolchains. OpenLoop unifies continuous/discrete state-space modeling, Model-in-the-Loop (MIL) vs. Software-in-the-Loop (SIL) simulation, Git-friendly declarative text IR, zero-allocation C99 and `#![no_std]` Rust codegen, and Hardware-in-the-Loop (HIL) packet framing.

---

## Core Capabilities

- **Workbench & Oscilloscope**: Interactive block diagram, synchronized 2D physical plant schematics, editable `(A, B, C, D)` matrices, LQR/PID tuning (with derivative filtering `N` and back-calculation anti-windup `Kb`), actuator saturation/rate clamping, mid-run disturbance impulse injection, and a dual-trace MIL (RK4) vs. SIL (fixed-step `dt`) oscilloscope.
- **Built-in Benchmark Models**:
  1. **Inverted Pendulum (Cart-Pole) LQR + PID** (`200 Hz`, 4-state linearized cart-pole)
  2. **DC Motor Velocity & Current Cascade Loop** (`1 kHz`, 2-state electromechanical armature)
  3. **Synchronous Buck Converter Voltage-Mode Control** (`20 kHz`, 2-state LC power stage)
- **Schema & IR (`model.ctrl.toml`)**: Bidirectional human-readable declarative text IR with a static graph validator (Kahn topological sort for algebraic loop detection, integer multi-rate divisibility checks, and matrix dimension validation).
- **Codegen Studio**: Live **Zero-Order Hold (ZOH)** via scaling-and-squaring Padé `[6/6]` matrix exponential and **Tustin** bilinear discretization, emitting standalone zero-`malloc` **C99** (`ctrl_model.h`, `ctrl_model.c`, `hil_frame.h`) and **`#![no_std]` Rust** (`src/lib.rs`) side-by-side.
- **Git-Friendly Persistence & Export**:
  - **Save Model**: Downloads the active `ControlModel` as a formatted, trailing-newline JSON file (`openloop-<id>.ctrl.json`) for clean Git diffs.
  - **Export Bundle**: Packages `model.ctrl.toml`, C99 sources, `no_std` Rust crate, `hil_frame.h`, and build instructions into `openloop-<id>-bundle.zip`.
- **HIL-Bridge Verifier**: Simulates deterministic tick pacing across **UART + COBS**, **SocketCAN FD**, and **UDP Binary** transports with IEEE-754 `f32` payloads, CRC-16-CCITT checksums, jitter/packet-drop fault injection, and watchdog safe-clamping (`NOMINAL → WARN → SAFE_CLAMP`).

---

## Project Layout

```text
├── index.html                  # App entry point, dark theme & typography setup
├── metadata.json               # Applet metadata
├── package.json                # Dependencies & npm scripts
├── vite.config.ts              # Vite + React + Tailwind v4 configuration
└── src/
    ├── App.tsx                 # Top-level view state, playback loop & export wiring
    ├── index.css               # Tailwind v4 tokens & precision instrument styling
    ├── types/control.ts        # ControlModel, matrix, validation, trace & HIL types
    ├── data/presets.ts         # Inverted Pendulum, DC Motor & Buck Converter presets
    ├── engine/
    │   ├── math.ts             # Dense matrix ops, Padé expm, ZOH & Tustin transforms
    │   ├── simulator.ts        # Continuous RK4 (MIL) & fixed-step discrete (SIL) solver
    │   ├── validator.ts        # Kahn sort algebraic-loop & multi-rate validator
    │   ├── ir.ts               # Bidirectional TOML IR serializer & parser
    │   ├── codegen.ts          # Zero-allocation C99 & #![no_std] Rust emitter
    │   ├── hil.ts              # COBS, CRC-16-CCITT & watchdog loopback framing
    │   └── __tests__/
    │       └── math.test.ts    # Vitest analytical & closed-loop verification suite
    ├── utils/
    │   └── exportBundle.ts     # Client-side ZIP packager & Save Model JSON exporter
    └── components/
        ├── Header.tsx          # Top navigation bar & Export Bundle CTA
        ├── WorkbenchView.tsx   # Split console parameter editor, KPIs & stage
        ├── BlockDiagram.tsx    # Interactive SVG declarative graph renderer
        ├── PlantSchematic.tsx  # Synchronized 2D Cart-Pole, Rotor & Buck schematics
        ├── Oscilloscope.tsx    # Multi-channel MIL/SIL waveform plot & crosshair HUD
        ├── SchemaView.tsx      # Declarative TOML IR editor & validator panel
        ├── CodegenView.tsx     # Discrete matrix inspector & C99/Rust code studio
        ├── HilBridgeView.tsx   # Wire frame inspector, RTT plot & fault injection
        └── ArchitectureView.tsx# Workspace crate blueprint & phased MVP roadmap
```

---

## Getting Started (Local Development)

### Prerequisites
- **Node.js 20+** and **npm** (or **Bun**)

### Install & Run
```bash
npm install
npm run dev
```
The Vite dev server starts at `http://localhost:3000`.

### Verify Math, Types & Build
```bash
# Run the Vitest suite (matrix algebra, Padé expm, ZOH/Tustin benchmarks, MIL/SIL equivalence)
npm test

# Type-check with TypeScript
npm run lint

# Build production static assets into dist/
npm run build

# Preview the production build locally
npm run preview
```

### Compiling Exported Firmware Offline
After clicking **Export Bundle** and extracting `openloop-<preset>-bundle.zip`, you can compile the generated C99 and `#![no_std]` Rust targets directly:

```bash
# Verify zero-allocation C99 compilation
cc -std=c99 -Wall -Wextra -Werror -c c99/ctrl_model.c -o ctrl_model.o

# Verify standalone #![no_std] Rust compilation
rustc --crate-type lib --edition 2021 rust_nostd/src/lib.rs -O
```

---

## Deploying OpenLoop

OpenLoop builds into a self-contained static Single-Page Application (`dist/`) with **zero backend database or API key requirements**—all simulation, linear algebra, code generation, and ZIP packaging execute deterministically in the browser.

### Option 1: Static Hosting (Cloudflare Pages, Vercel, Netlify, GitHub Pages)
1. **Build command:** `npm run build`
2. **Output directory:** `dist`
3. **Node version:** `20` (or `22`)

*(Because OpenLoop uses state-based client view switching without deep URL path routing, no custom server rewrite rules are required.)*

### Option 2: Containerized / Cloud Run Deployment (Nginx)
To serve the production bundle inside any container platform (Google Cloud Run, Fly.io, Kubernetes):

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 8080
CMD ["sh", "-c", "sed -i 's/listen  *80;/listen 8080;/g' /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"]
```

Build and run locally:
```bash
docker build -t openloop-workbench .
docker run -p 8080:8080 openloop-workbench
```

### Option 3: Node Preview Server
If deploying to a Node.js host without Nginx:
```bash
npm ci
npm run build
npx vite preview --port 3000 --host 0.0.0.0
```

### Environment Variables
No secrets or API keys are required to run or deploy OpenLoop. The `.env.example` file contains default AI Studio template variables (`GEMINI_API_KEY`, `APP_URL`), which are unused by the deterministic client-side control engine.
