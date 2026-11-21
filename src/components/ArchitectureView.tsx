import React from 'react';
import { ArrowRight } from 'lucide-react';
import { AppView } from './Header';

interface ArchitectureViewProps {
  onNavigate: (view: AppView) => void;
}

export const ArchitectureView: React.FC<ArchitectureViewProps> = ({ onNavigate }) => {
  return (
    <div className="flex-1 overflow-y-auto bg-[#07090E] px-6 py-8">
      <div className="max-w-5xl mx-auto space-y-10">
        {/* Intro */}
        <section className="border-b border-slate-800 pb-6">
          <div className="text-xs font-mono text-cyan-400 mb-2">
            MIT / Apache-2.0 Open-Source Control Architecture
          </div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-100 max-w-3xl">
            OpenLoop System Blueprint &amp; Embedded Specification
          </h1>
          <p className="mt-3 text-sm text-slate-400 max-w-3xl leading-relaxed">
            A license-free, CI/CD-native alternative to proprietary control suites. Every diagram, solver step, C99/Rust emitter, and HIL frame derives deterministically from a single human-readable text IR with zero GUI lock-in and zero dynamic heap allocation on target firmware.
          </p>
        </section>

        {/* Deliverable 1: Architecture & Crate Blueprint */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-100">
              01. Workspace Blueprint &amp; Separation of Concerns
            </h2>
            <button
              type="button"
              onClick={() => onNavigate('workbench')}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-cyan-400 hover:text-cyan-300 cursor-pointer"
            >
              Open Workbench <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <pre className="p-4 rounded border border-slate-800 bg-[#0B0E17] text-xs font-mono text-slate-300 overflow-x-auto leading-5">
{`┌─────────────────────────────────────────────────────────────────────────┐
│ openloop-workspace (MIT OR Apache-2.0)                                  │
├─────────────────────────────────────────────────────────────────────────┤
│ 1. ctrl-core      (Rust #![no_std] + C99 ABI)                           │
│    • Static dense matrix ops, ZOH Padé expm, Tustin, RK4 plant runner   │
│    • PID (derivative filter N, back-calc anti-windup), Rate/Sat clamp   │
│ 2. ctrl-ir        (Headless Graph Parser & Validator)                   │
│    • Reads/writes model.ctrl.toml                                       │
│    • Kahn topological sort, algebraic loop check, multi-rate dividers   │
│ 3. ctrl-codegen   (Deterministic Target Emitter)                        │
│    • Lowers validated IR -> standalone ctrl_model.h/.c & lib.rs         │
│    • Zero malloc/free, static const matrices, explicit CtrlState struct │
│ 4. hil-bridge     (Deterministic Target Loopback)                       │
│    • UART-COBS, SocketCAN, UDP framing + CRC16-CCITT + Watchdog clamp   │
│ 5. ctrl-studio    (Decoupled UI / CLI / CI Harness)                     │
│    • Optional visual workbench; CI runs ctrl-core + hil-bridge headless │
└─────────────────────────────────────────────────────────────────────────┘`}
          </pre>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-4 rounded border border-slate-800 bg-[#0F141E] space-y-1.5">
              <div className="text-xs font-semibold text-slate-100">
                Zero Heap Allocation
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                All state vectors, discrete matrices, and ring buffers are fixed-dimension stack or static globals (<code className="text-cyan-300">CtrlState</code>), eliminating fragmentation and non-deterministic allocator pauses.
              </p>
            </div>
            <div className="p-4 rounded border border-slate-800 bg-[#0F141E] space-y-1.5">
              <div className="text-xs font-semibold text-slate-100">
                Zero Timing Drift
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Execution is driven by hardware timer ticks or monotonic <code className="text-cyan-300">tick_us</code> counters with integer multi-rate dividers rather than wall-clock sleep loops.
              </p>
            </div>
            <div className="p-4 rounded border border-slate-800 bg-[#0F141E] space-y-1.5">
              <div className="text-xs font-semibold text-slate-100">
                Zero GUI Lock-In
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                The UI reads and writes pure declarative TOML IR. Headless CLI tools run MIL/SIL regression suites and emit firmware artifacts directly in GitHub Actions or GitLab CI.
              </p>
            </div>
          </div>
        </section>

        {/* Deliverable 2: Text Model & Validation */}
        <section className="space-y-4 border-t border-slate-800 pt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-100">
              02. Declarative Text IR &amp; Static Graph Validation
            </h2>
            <button
              type="button"
              onClick={() => onNavigate('schema')}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-cyan-400 hover:text-cyan-300 cursor-pointer"
            >
              Inspect Schema &amp; Validator <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-4 rounded border border-slate-800 bg-[#0F141E] space-y-2">
              <div className="text-xs font-semibold text-cyan-300">
                Algebraic Loop Detection (Kahn Sort)
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Every block declares whether its output carries state memory (e.g., <code className="text-slate-200">rate_transition</code>, <code className="text-slate-200">pid</code> integrator, or strictly proper <code className="text-slate-200">state_space</code> where <code className="text-slate-200">D == 0</code>). Non-memory edges form the instantaneous DAG; any remaining cycle halts codegen with exact block diagnostics.
              </p>
            </div>
            <div className="p-4 rounded border border-slate-800 bg-[#0F141E] space-y-2">
              <div className="text-xs font-semibold text-amber-300">
                Multi-Rate &amp; Matrix Compatibility
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Connected discrete blocks must satisfy integer-multiple sample periods (<code className="text-slate-200">dt_slow % dt_fast == 0</code>) or cross a <code className="text-slate-200">zoh</code> rate transition block. Continuous matrices <code className="text-slate-200">(A, B, C, D)</code> are dimension-checked against <code className="text-slate-200">(n, m, p)</code> prior to discretization.
              </p>
            </div>
          </div>

          <div className="p-4 rounded border border-slate-800 bg-[#0F141E] space-y-2">
            <div className="text-xs font-semibold text-emerald-300">
              Classical num(s)/den(s) &amp; External Linearization (OpenModelica / Scilab Xcos)
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              OpenLoop&apos;s canonical runtime representation is continuous state-space <code className="text-slate-200">(A, B, C, D)</code>, ensuring uniform MIMO simulation, Padé ZOH / Tustin discretization, and zero-malloc C99/Rust codegen. Engineers can enter classical rational <code className="text-slate-200">N(s)/D(s)</code> polynomials directly in the Workbench converter (auto-realized into Controllable Canonical Form), or import linearized operating-point models from <strong className="text-slate-200">OpenModelica</strong> (<code className="text-cyan-300">linearize(...)</code>) and <strong className="text-slate-200">Scilab Xcos</strong> (<code className="text-cyan-300">lincos(...)</code> / <code className="text-cyan-300">tf2ss</code>) via <code className="text-slate-200">.ctrl.toml</code> / <code className="text-slate-200">.ctrl.json</code>.
            </p>
          </div>
        </section>

        {/* Deliverable 3: Discretization & Codegen Spec */}
        <section className="space-y-4 border-t border-slate-800 pt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-100">
              03. Discretization, Fixed-Step Scheduling &amp; Embedded ABI
            </h2>
            <button
              type="button"
              onClick={() => onNavigate('codegen')}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-cyan-400 hover:text-cyan-300 cursor-pointer"
            >
              View Live C99 / Rust Codegen <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="p-4 rounded border border-slate-800 bg-[#0F141E] space-y-2 text-xs text-slate-300 leading-relaxed">
            <p>
              <strong className="text-slate-100">Continuous MIL Reference:</strong> Plant states advance via 4th-order Runge-Kutta (RK4) at 4× sub-stepping per <code className="text-cyan-300">dt</code> to provide continuous-time physical truth.
            </p>
            <p>
              <strong className="text-slate-100">Zero-Order Hold (ZOH):</strong> Computes exact <code className="text-cyan-300">(Ad, Bd)</code> via Van Loan block matrix exponential <code className="text-cyan-300">expm([[A·dt, B·dt], [0, 0]])</code> using scaling-and-squaring with a Padé [6/6] approximant.
            </p>
            <p>
              <strong className="text-slate-100">Tustin (Bilinear) Transform:</strong> Computes <code className="text-cyan-300">Ad = (I + 0.5·dt·A)(I - 0.5·dt·A)⁻¹</code> with exact DC-gain-preserving <code className="text-cyan-300">Bd, Cd, Dd</code> matrices for high-frequency switching plants such as buck converters.
            </p>
            <p>
              <strong className="text-slate-100">Target Firmware ABI:</strong> Exposes <code className="text-amber-300">ctrl_init(&amp;state)</code> and <code className="text-amber-300">ctrl_step(&amp;state, &amp;in, &amp;out)</code> in C99 and <code className="text-amber-300">CtrlState::init / step</code> in <code className="text-amber-300">#![no_std]</code> Rust with built-in watchdog safe-clamping.
            </p>
          </div>
        </section>

        {/* Deliverable 4: Phased MVP & HIL Bridge */}
        <section className="space-y-4 border-t border-slate-800 pt-8 pb-6">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-100">
              04. Phased MVP Build Roadmap &amp; HIL Loopback
            </h2>
            <button
              type="button"
              onClick={() => onNavigate('hil')}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-cyan-400 hover:text-cyan-300 cursor-pointer"
            >
              Test HIL Framing <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {[
              {
                phase: 'Phase 1 · Headless Core',
                items: [
                  'Fixed-step RK4 & ZOH/Tustin kernel',
                  'State-space + PID anti-windup',
                  'Deterministic CSV/trace CLI runner',
                ],
              },
              {
                phase: 'Phase 2 · Text IR & Validator',
                items: [
                  'Diffable TOML graph schema',
                  'Kahn sort algebraic loop detector',
                  'Integer multi-rate compatibility',
                ],
              },
              {
                phase: 'Phase 3 · C99 & Rust Codegen',
                items: [
                  'Zero-malloc CtrlState struct emitter',
                  'MISRA-friendly C99 + #![no_std] Rust',
                  'Automated host SIL equivalence CI',
                ],
              },
              {
                phase: 'Phase 4 · HIL-Bridge & Studio',
                items: [
                  'COBS/CRC-16 UART, SocketCAN, UDP',
                  'Deadline watchdog SAFE_CLAMP',
                  'Interactive scope & block UI',
                ],
              },
            ].map((p) => (
              <div
                key={p.phase}
                className="p-4 rounded border border-slate-800 bg-[#0F141E] space-y-2"
              >
                <div className="text-xs font-semibold text-cyan-300">{p.phase}</div>
                <ul className="space-y-1.5 text-xs text-slate-400">
                  {p.items.map((item) => (
                    <li key={item}>· {item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
