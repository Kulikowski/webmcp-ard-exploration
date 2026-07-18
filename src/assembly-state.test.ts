import { describe, expect, it } from 'vitest';
import {
  type AssemblyState,
  createInitialState,
  availableTools,
  nextManualAction,
  executeTool,
} from './assembly-state';

/** Runs a tool call and asserts it succeeded, returning the new state so tests
 *  can chain calls without repeating the ok-check at every step. */
function apply(state: AssemblyState, name: string, args?: Record<string, unknown>) {
  const outcome = executeTool(state, name, args);
  if (!outcome.ok)
    throw new Error(`expected ${name} to succeed, but it was rejected: ${outcome.message}`);
  return outcome;
}

/** Drives the state from scratch through a successful reservation (stock.Bracket
 *  is seeded to 1, standing in for "the supplier delivered one"). */
function reservedState(): AssemblyState {
  let state = createInitialState();
  state = { ...state, stock: { ...state.stock, Bracket: 1 } };
  state = apply(state, 'list_parts').state;
  return apply(state, 'reserve_part').state;
}

function assembledState(): AssemblyState {
  let state = reservedState();
  state = apply(state, 'mount_torso').state;
  state = apply(state, 'install_leg_actuators').state;
  state = apply(state, 'mount_tool_arms').state;
  return apply(state, 'attach_armor_pack').state;
}

describe('createInitialState', () => {
  it('starts at inventory/step 0 with no bracket in stock', () => {
    const state = createInitialState();
    expect(state.stage).toBe(0);
    expect(state.step).toBe(0);
    expect(state.stock.Bracket).toBe(0);
    expect(state.reserved).toBe(false);
    expect(state.shipped).toBe(false);
  });
});

describe('availableTools', () => {
  it('static mode exposes every tool regardless of state', () => {
    const state = createInitialState();
    expect(availableTools(state, 'static').map((t) => t.name)).toContain('deploy_titan');
  });

  it('dynamic mode only exposes list_parts, check_stock, and side paths at the start', () => {
    const state = createInitialState();
    const names = availableTools(state, 'dynamic').map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'list_parts',
        'check_stock',
        'open_maintenance_hatch',
        'apply_primer_coat',
      ]),
    );
    expect(names).not.toContain('reserve_part');
    expect(names).not.toContain('mount_torso');
  });

  it('dynamic mode reveals reserve_part only after list_parts is called', () => {
    const state = apply(createInitialState(), 'list_parts').state;
    expect(availableTools(state, 'dynamic').map((t) => t.name)).toContain('reserve_part');
  });

  it('dynamic mode reveals release_part only right after a reservation, not later', () => {
    const reserved = reservedState();
    expect(availableTools(reserved, 'dynamic').map((t) => t.name)).toContain('release_part');

    const afterMount = apply(reserved, 'mount_torso').state;
    expect(availableTools(afterMount, 'dynamic').map((t) => t.name)).not.toContain('release_part');
  });

  it('dynamic mode surfaces the full recovery sequence during a failed test, even out of station', () => {
    let state = assembledState();
    state = apply(state, 'list_ports').state;
    state = apply(state, 'connect_power_bus').state;
    state = apply(state, 'validate_power_bus').state;
    state = apply(state, 'calibrate_shoulders').state;
    state = apply(state, 'calibrate_balance').state;
    state = apply(state, 'set_joint_limits').state;
    state = apply(state, 'run_diagnostics').state;
    const failed = executeTool(state, 'run_load_test');
    if (!failed.ok)
      throw new Error(
        'expected the first load test to be accepted (it fails in-fiction, not rejected)',
      );
    expect(failed.state.failedTest).toBe(true);
    const names = availableTools(failed.state, 'dynamic').map((t) => t.name);
    for (const step of [
      'read_test_report',
      'disconnect_power_bus',
      'connect_power_bus',
      'validate_power_bus',
    ]) {
      expect(names).toContain(step);
    }
  });
});

describe('nextManualAction', () => {
  it('starts with list_parts', () => {
    expect(nextManualAction(createInitialState())?.name).toBe('list_parts');
  });
});

describe('executeTool: rejections', () => {
  it('rejects an unknown tool name', () => {
    const outcome = executeTool(createInitialState(), 'not_a_real_tool');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/unknown tool/);
    expect(outcome.state.errors).toBe(1);
  });

  it('rejects a tool called out of its assembly state', () => {
    const outcome = executeTool(createInitialState(), 'mount_torso');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/tool cannot be called in the current assembly state/);
  });
});

describe('executeTool: check_stock', () => {
  it('never shows a toast and never advances the workflow', () => {
    const outcome = executeTool(createInitialState(), 'check_stock');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.toastMessage).toBeUndefined();
    expect(outcome.state.step).toBe(0);
    expect(outcome.result).toEqual({ stock: createInitialState().stock });
  });

  it('reports a single module by name', () => {
    const outcome = executeTool(createInitialState(), 'check_stock', { module: 'Torso' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result).toEqual({ module: 'Torso', available: 1 });
  });
});

describe('executeTool: reserve_part / release_part', () => {
  it('rejects reserve_part when the bracket is out of stock', () => {
    const state = apply(createInitialState(), 'list_parts').state;
    const outcome = executeTool(state, 'reserve_part');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/shoulder actuator bracket unavailable/);
  });

  it('consumes one of every kit module on success and advances to bench/step 0', () => {
    const state = reservedState();
    expect(state.stock).toEqual({ Torso: 0, Legs: 1, Arms: 1, Armor: 5, Core: 0, Bracket: 0 });
    expect(state.reserved).toBe(true);
    expect(state.stage).toBe(1);
    expect(state.step).toBe(0);
  });

  it('rejects release_part when nothing is reserved', () => {
    const outcome = executeTool(createInitialState(), 'release_part');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/no reserved module kit to release/);
  });

  it('exactly reverses a reservation: stock, reserved flag, and station all restored', () => {
    const before = createInitialState();
    const reserved = reservedState();
    const released = apply(reserved, 'release_part').state;
    expect(released.stock).toEqual({ ...before.stock, Bracket: 1 });
    expect(released.reserved).toBe(false);
    expect(released.stage).toBe(0);
    expect(released.step).toBe(1);
  });

  it('release_part is no longer reachable once structural assembly has started', () => {
    const afterMount = apply(reservedState(), 'mount_torso').state;
    const outcome = executeTool(afterMount, 'release_part');
    expect(outcome.ok).toBe(false);
  });
});

describe('executeTool: remove_module', () => {
  it('rejects when nothing has been installed yet', () => {
    const outcome = executeTool(reservedState(), 'remove_module');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/nothing installed to detach/);
  });

  it('detaches the most recent module first, in reverse order, until nothing is left', () => {
    let state = reservedState();
    state = apply(state, 'mount_torso').state;
    state = apply(state, 'install_leg_actuators').state;

    const first = apply(state, 'remove_module');
    expect(first.result.detached).toBe('install_leg_actuators');
    expect(first.state.step).toBe(1);

    const second = apply(first.state, 'remove_module');
    expect(second.result.detached).toBe('mount_torso');
    expect(second.state.step).toBe(0);

    const third = executeTool(second.state, 'remove_module');
    expect(third.ok).toBe(false);
  });
});

describe('executeTool: side paths never advance the mission', () => {
  it('enforces open -> flush -> seal order for coolant maintenance', () => {
    const state = createInitialState();
    expect(executeTool(state, 'flush_coolant_loop').ok).toBe(false);

    const opened = apply(state, 'open_maintenance_hatch');
    expect(opened.result.advancedWorkflow).toBe(false);
    expect(executeTool(opened.state, 'open_maintenance_hatch').ok).toBe(false);

    const flushed = apply(opened.state, 'flush_coolant_loop').state;
    const sealed = apply(flushed, 'seal_maintenance_hatch').state;
    expect(sealed.hatchOpen).toBe(false);
    // Side paths never touch assembly progress.
    expect(sealed.stage).toBe(state.stage);
    expect(sealed.step).toBe(state.step);
  });

  it('enforces primer -> paint -> cure order and rejects a duplicate primer coat', () => {
    const state = createInitialState();
    expect(executeTool(state, 'apply_paint_coat').ok).toBe(false);
    const primed = apply(state, 'apply_primer_coat').state;
    expect(executeTool(primed, 'apply_primer_coat').ok).toBe(false);
    const painted = apply(primed, 'apply_paint_coat').state;
    const cured = apply(painted, 'cure_paint_finish').state;
    expect(cured.paintStep).toBe(3);
  });
});

describe('executeTool: load-test failure and recovery', () => {
  function atLoadTest(): AssemblyState {
    let state = assembledState();
    state = apply(state, 'list_ports').state;
    state = apply(state, 'connect_power_bus').state;
    state = apply(state, 'validate_power_bus').state;
    state = apply(state, 'calibrate_shoulders').state;
    state = apply(state, 'calibrate_balance').state;
    state = apply(state, 'set_joint_limits').state;
    return apply(state, 'run_diagnostics').state;
  }

  it('the first load test is accepted but reports an in-fiction failure and sets failedTest', () => {
    const outcome = apply(atLoadTest(), 'run_load_test');
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.loadTest).toBe('FAILED');
    expect(outcome.state.failedTest).toBe(true);
  });

  it('rejects any tool outside the exact recovery sequence while the fault is active', () => {
    const failed = apply(atLoadTest(), 'run_load_test').state;
    const outcome = executeTool(failed, 'run_diagnostics');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/shoulder coupling fault active/);
  });

  it('the exact reseat sequence clears the fault and passes the retest', () => {
    let state = apply(atLoadTest(), 'run_load_test').state;
    const report = apply(state, 'read_test_report');
    expect(report.result.report).toMatch(/FAILED/);
    state = apply(report.state, 'disconnect_power_bus').state;
    state = apply(state, 'connect_power_bus').state;
    state = apply(state, 'validate_power_bus').state;
    state = apply(state, 'run_diagnostics').state;
    const passed = apply(state, 'run_load_test');
    expect(passed.state.failedTest).toBe(false);
    expect(passed.state.recovered).toBe(true);
    expect(passed.result.loadTest).toBe('PASSED');
    expect(passed.state.stage).toBe(4);
    expect(passed.state.step).toBe(2);

    const finalReport = apply(passed.state, 'read_test_report');
    expect(finalReport.result.report).toBe('PASSED | frame within limits after power-bus reseat');
  });
});

describe('executeTool: full happy path ships Forge Titan', () => {
  it('reaches shipped:true via deploy_titan', () => {
    let state = assembledState();
    state = apply(state, 'list_ports').state;
    state = apply(state, 'connect_power_bus').state;
    state = apply(state, 'validate_power_bus').state;
    state = apply(state, 'calibrate_shoulders').state;
    state = apply(state, 'calibrate_balance').state;
    state = apply(state, 'set_joint_limits').state;
    state = apply(state, 'run_diagnostics').state;
    state = apply(state, 'run_load_test').state; // fails in-fiction the first time
    state = apply(state, 'read_test_report').state;
    state = apply(state, 'disconnect_power_bus').state;
    state = apply(state, 'connect_power_bus').state;
    state = apply(state, 'validate_power_bus').state;
    state = apply(state, 'run_diagnostics').state;
    state = apply(state, 'run_load_test').state;
    state = apply(state, 'read_test_report').state;
    state = apply(state, 'secure_transport_frame').state;
    state = apply(state, 'activate_reactor').state;
    const shipped = apply(state, 'deploy_titan');
    expect(shipped.state.shipped).toBe(true);
    expect(shipped.state.stage).toBe(5);
    expect(shipped.state.step).toBe(3);
    expect(shipped.toastMessage).toBe('Forge Titan deployed');
  });
});
