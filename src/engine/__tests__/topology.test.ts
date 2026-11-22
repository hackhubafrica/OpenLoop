import { describe, expect, it } from 'vitest';
import { PRESET_MODELS } from '../../data/presets';
import { applyTransferFunctionToModel } from '../transferFunction';
import { extractStateSpaceTopology } from '../topology';
import { importModelFromText, resizePlantDimensions } from '../../utils/modelHelpers';

describe('extractStateSpaceTopology', () => {
  it('extracts structural nodes, couplings, self-loops, and closed-loop feedback for pendulum preset', () => {
    const topo = extractStateSpaceTopology(PRESET_MODELS.pendulum);

    expect(topo.diagnostics.n).toBe(4);
    expect(topo.diagnostics.m).toBe(1);
    expect(topo.diagnostics.p).toBe(2);
    expect(topo.diagnostics.hasDirectFeedthrough).toBe(false);
    expect(topo.diagnostics.activeLqrCount).toBe(4);
    expect(topo.diagnostics.pidActive).toBe(true);

    // 1 ctrl + 1 input + 4 states + 2 outputs = 8 nodes
    expect(topo.nodes).toHaveLength(8);

    // A non-zeros: A[0,1]=1, A[1,1]=-0.1, A[1,2]=-1.962, A[2,3]=1, A[3,1]=0.2, A[3,2]=23.544 -> 6 non-zeros (1 self, 5 cross)
    expect(topo.diagnostics.nonZeroA).toBe(6);
    expect(topo.diagnostics.selfLoops).toBe(1);
    expect(topo.diagnostics.crossCouplings).toBe(5);
    expect(topo.diagnostics.nonZeroB).toBe(2);
    expect(topo.diagnostics.nonZeroC).toBe(2);

    const aSelf = topo.edges.filter((e) => e.kind === 'A_self');
    expect(aSelf).toHaveLength(1);
    expect(aSelf[0].fromId).toBe('x_1');

    const pidEdges = topo.edges.filter((e) => e.kind === 'pid_fb');
    expect(pidEdges).toHaveLength(1);
    expect(pidEdges[0].fromId).toBe('y_1');

    expect(topo.nodeEquations['x_0']).toContain('x[1]');
    expect(topo.nodeEquations['x_1']).toContain('u[0]');
  });

  it('detects Controllable Canonical structure for synthesized Transfer Function models', () => {
    const { model: tfModel, error } = applyTransferFunctionToModel(
      PRESET_MODELS.dcmotor,
      [2, 5],
      [1, 6, 11, 6],
      'Third-Order Lag'
    );
    expect(error).toBeNull();

    const topo = extractStateSpaceTopology(tfModel);
    expect(topo.diagnostics.n).toBe(3);
    expect(topo.diagnostics.patternLabel).toBe('Controllable Canonical');
    // Superdiagonal ones A[0,1]=1, A[1,2]=1 + bottom row (-6, -11, -6) = 5 non-zero A entries
    expect(topo.diagnostics.nonZeroA).toBe(5);
    expect(topo.diagnostics.selfLoops).toBe(1);
    expect(topo.diagnostics.nonZeroB).toBe(1);
    expect(topo.diagnostics.nonZeroC).toBe(2);
  });

  it('renders imported MIMO TOML models with direct feedthrough D and zero spurious zero-gain edges', () => {
    const toml = `
[model]
id = "custom_mimo_thermal"
name = "Dual-Zone Thermal Plant"
base_dt = 0.01
duration = 4.0

[plant.state_space]
n = 2
m = 2
p = 2
states = ["core_temp", "chassis_temp"]
state_units = ["C", "C"]
inputs = ["heater_cmd", "ambient_bias"]
input_units = ["W", "W"]
outputs = ["sensor_top", "sensor_bot"]
output_units = ["C", "C"]
A = [[-0.5, 0.2], [0.1, -0.3]]
B = [[1.2, 0.0], [0.0, 0.8]]
C = [[1.0, 0.0], [0.0, 1.0]]
D = [[0.0, 0.25], [0.0, 0.0]]
x0 = [25.0, 25.0]

[controller.lqr]
K = [0.0, 0.0]

[controller.pid]
enabled = false
target_output_index = 0
tracks_step_ref = true
kp = 0.0
ki = 0.0
kd = 0.0
n_filter = 20.0
kb_anti_windup = 1.0
`;

    const imported = importModelFromText('thermal.toml', toml, PRESET_MODELS.dcmotor);
    expect(imported.error).toBeNull();
    expect(imported.model).toBeTruthy();

    const model = imported.model!;

    const topo = extractStateSpaceTopology(model);
    expect(topo.diagnostics.m).toBe(2);
    expect(topo.diagnostics.n).toBe(2);
    expect(topo.diagnostics.p).toBe(2);
    expect(topo.diagnostics.hasDirectFeedthrough).toBe(true);
    expect(topo.diagnostics.nonZeroD).toBe(1);
    expect(topo.diagnostics.activeLqrCount).toBe(0);
    expect(topo.diagnostics.pidActive).toBe(false);
    expect(topo.diagnostics.patternLabel).toBe('Coupled MIMO');

    const dEdges = topo.edges.filter((e) => e.kind === 'D_feedthrough');
    expect(dEdges).toHaveLength(1);
    expect(dEdges[0].fromId).toBe('u_1');
    expect(dEdges[0].toId).toBe('y_0');
    expect(dEdges[0].gain).toBeCloseTo(0.25);

    const bEdges = topo.edges.filter((e) => e.kind === 'B');
    expect(bEdges).toHaveLength(2);
    expect(topo.nodeEquations['y_0']).toContain('0.25·u[1]');
  });

  it('updates structural nodes cleanly when plant dimensions are resized dynamically', () => {
    const resized = resizePlantDimensions(PRESET_MODELS.buck, 5, 3, 2);
    const topo = extractStateSpaceTopology(resized);
    expect(topo.diagnostics.n).toBe(5);
    expect(topo.diagnostics.p).toBe(3);
    expect(topo.diagnostics.m).toBe(2);
    expect(topo.nodes.filter((n) => n.kind === 'state')).toHaveLength(5);
    expect(topo.nodes.filter((n) => n.kind === 'input')).toHaveLength(2);
    expect(topo.nodes.filter((n) => n.kind === 'output')).toHaveLength(3);
  });
});
