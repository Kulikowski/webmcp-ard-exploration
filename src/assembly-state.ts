/**
 * The Forge Titan assembly state machine. Deliberately framework- and DOM-free:
 * `executeTool` takes a state snapshot and returns a new one (or a rejection),
 * so it can be unit tested without a browser and reused identically by the
 * WebMCP host, the embedded agent, the manual walkthrough, and the Tools panel.
 *
 * Side effects that belong to the caller (logging is still recorded on `state`
 * since it's part of the exported run history, but rendering, toasting,
 * WebMCP re-registration, and 3D effects are not) are surfaced as plain data
 * on the returned outcome instead of being performed here.
 */

export type StageId = 0 | 1 | 2 | 3 | 4 | 5;
export type ToolStage = StageId | 'aux';
export type ModuleName = 'Torso' | 'Legs' | 'Arms' | 'Armor' | 'Core' | 'Bracket';
export type ExperimentMode = 'static' | 'static+catalog-skill' | 'dynamic' | 'catalog-skill';

export interface ToolDefinition {
  name: string;
  stage: ToolStage;
  minStep: number;
  description: string;
}

export interface LogEntry {
  time: string;
  kind: string;
  msg: string;
  error: boolean;
}

export interface AssemblyState {
  stage: StageId;
  step: number;
  completed: string[];
  stock: Record<ModuleName, number>;
  failedTest: boolean;
  recoveryStep: number;
  recovered: boolean;
  shipped: boolean;
  reserved: boolean;
  hatchOpen: boolean;
  paintStep: number;
  sideCalls: number;
  calls: number;
  errors: number;
  log: LogEntry[];
}

/** Loosely typed on purpose: every tool attaches different extra fields
 *  (report text, load-test outcome, recovery progress, detached module...),
 *  matching the same free-form convention MCP's own structuredContent uses. */
export type ToolResultPayload = Record<string, unknown>;

export interface ExecuteSuccess {
  ok: true;
  state: AssemblyState;
  result: ToolResultPayload;
  /** Absent when the original UI wouldn't have shown a toast for this call
   *  (e.g. check_stock, or a generic success that didn't unlock a station). */
  toastMessage?: string;
  /** Tool name to play the 3D diagnostic effect for, if any. */
  diagnosticFx?: string;
}

export interface ExecuteFailure {
  ok: false;
  /** `calls`/`errors` bumped and the rejection logged; nothing else changes. */
  state: AssemblyState;
  message: string;
  toastMessage: string;
}

export type ExecuteOutcome = ExecuteSuccess | ExecuteFailure;

export const STAGES: Array<[id: string, title: string, description: string]> = [
  ['inventory', 'Source modules', 'Confirm stock and reserve the five-module Titan kit.'],
  ['bench', 'Structural assembly', 'Join the torso, lift legs, tool arms and armor pack.'],
  ['wiring', 'Power coupling', 'Connect the reactor bus and validate every coupling.'],
  ['calibration', 'Joint calibration', 'Balance the frame and set safe joint limits.'],
  ['test-rig', 'Load test', 'Run diagnostics and clear the shoulder coupling fault.'],
  ['shipping', 'Deployment', 'Secure, activate and deploy Forge Titan.'],
];

export const STAGE_NAMES = [
  'UNASSEMBLED',
  'TORSO LOCKED',
  'FRAME ASSEMBLED',
  'POWERED',
  'CALIBRATED',
  'TESTED',
  'DEPLOYED',
];

export const KIT_MODULES: ModuleName[] = ['Torso', 'Legs', 'Arms', 'Armor', 'Core', 'Bracket'];

export const TOOLS: ToolDefinition[] = [
  { name: 'list_parts', stage: 0, minStep: 0, description: 'Inspect module inventory' },
  {
    name: 'check_stock',
    stage: 0,
    minStep: 0,
    description: 'Check stock, either for one module by name or for the whole inventory',
  },
  { name: 'reserve_part', stage: 0, minStep: 1, description: 'Reserve the Forge Titan module kit' },
  {
    name: 'release_part',
    stage: 0,
    minStep: 1,
    description: 'Return the reserved module kit to stock',
  },
  {
    name: 'mount_torso',
    stage: 1,
    minStep: 0,
    description: 'Lock the command torso into the assembly cradle',
  },
  {
    name: 'install_leg_actuators',
    stage: 1,
    minStep: 1,
    description: 'Join both heavy-lift leg modules',
  },
  {
    name: 'mount_tool_arms',
    stage: 1,
    minStep: 2,
    description: 'Attach the paired rescue tool arms',
  },
  {
    name: 'attach_armor_pack',
    stage: 1,
    minStep: 3,
    description: 'Fit the reactor armor and head unit',
  },
  {
    name: 'remove_module',
    stage: 1,
    minStep: 0,
    description: 'Detach the most recently installed module',
  },
  { name: 'list_ports', stage: 2, minStep: 0, description: 'Inspect reactor and joint couplings' },
  {
    name: 'connect_power_bus',
    stage: 2,
    minStep: 1,
    description: 'Connect the distributed reactor bus',
  },
  { name: 'disconnect_power_bus', stage: 2, minStep: 0, description: 'Open a power-bus coupling' },
  {
    name: 'validate_power_bus',
    stage: 2,
    minStep: 2,
    description: 'Test isolation, continuity and load balance',
  },
  {
    name: 'calibrate_shoulders',
    stage: 3,
    minStep: 0,
    description: 'Zero both shoulder actuator arrays',
  },
  {
    name: 'calibrate_balance',
    stage: 3,
    minStep: 1,
    description: 'Balance the combined upright frame',
  },
  { name: 'set_joint_limits', stage: 3, minStep: 2, description: 'Store safe movement envelopes' },
  { name: 'run_diagnostics', stage: 4, minStep: 0, description: 'Check all Titan subsystems' },
  {
    name: 'run_load_test',
    stage: 4,
    minStep: 1,
    description: 'Exercise the frame on the instrumented gantry',
  },
  {
    name: 'read_test_report',
    stage: 4,
    minStep: 2,
    description: 'Read the latest gantry telemetry',
  },
  {
    name: 'secure_transport_frame',
    stage: 5,
    minStep: 0,
    description: 'Lock the Titan into its deployment frame',
  },
  {
    name: 'activate_reactor',
    stage: 5,
    minStep: 1,
    description: 'Bring the reactor to deployment power',
  },
  { name: 'deploy_titan', stage: 5, minStep: 2, description: 'Release Forge Titan for field duty' },
  // Side paths: real, sequenced, always-registered capabilities that never advance
  // the assembly mission. They make the tool surface honest about a workshop that
  // can do more than one job - and make workflow knowledge worth having.
  {
    name: 'open_maintenance_hatch',
    stage: 'aux',
    minStep: 0,
    description: 'Open the cradle service hatch for coolant and lubricant access',
  },
  {
    name: 'flush_coolant_loop',
    stage: 'aux',
    minStep: 1,
    description: 'Flush and refill the actuator coolant loop',
  },
  {
    name: 'seal_maintenance_hatch',
    stage: 'aux',
    minStep: 2,
    description: 'Seal the cradle service hatch after coolant work',
  },
  {
    name: 'apply_primer_coat',
    stage: 'aux',
    minStep: 0,
    description: 'Apply anti-corrosion primer to the body panels',
  },
  {
    name: 'apply_paint_coat',
    stage: 'aux',
    minStep: 1,
    description: 'Apply the rescue-service paint coat',
  },
  {
    name: 'cure_paint_finish',
    stage: 'aux',
    minStep: 2,
    description: 'Heat-cure the painted body for field duty',
  },
];

export const PAGE_SCHEMAS: Record<string, Record<string, unknown>> = {
  check_stock: {
    type: 'object',
    properties: {
      module: {
        type: 'string',
        description:
          'Module name (Torso, Legs, Arms, Armor, Core, Bracket). Omit to list the whole inventory.',
      },
    },
  },
};

// While a failed load test is active, only this exact procedure clears the fault.
export const RECOVERY_SEQUENCE = [
  'read_test_report',
  'disconnect_power_bus',
  'connect_power_bus',
  'validate_power_bus',
  'run_diagnostics',
  'run_load_test',
];

export const EXPECTED_ACTIONS: string[][] = [
  ['list_parts', 'reserve_part'],
  ['mount_torso', 'install_leg_actuators', 'mount_tool_arms', 'attach_armor_pack'],
  ['list_ports', 'connect_power_bus', 'validate_power_bus'],
  ['calibrate_shoulders', 'calibrate_balance', 'set_joint_limits'],
  ['run_diagnostics', 'run_load_test', 'read_test_report'],
  ['secure_transport_frame', 'activate_reactor', 'deploy_titan'],
];

const STAGE_STEP_COUNT = [2, 4, 3, 3, 3, 3];

export const DIAGNOSTIC_ACTIONS = new Set([
  'list_parts',
  'check_stock',
  'list_ports',
  'validate_power_bus',
  'calibrate_shoulders',
  'calibrate_balance',
  'set_joint_limits',
  'run_diagnostics',
  'run_load_test',
  'read_test_report',
]);

// Every other page tool advances assembly progress, hatch/paint sub-state, or
// stock as its real effect - check_stock is the only one that just reads data.
export const READ_ONLY_TOOLS = new Set(['check_stock']);

export function createInitialState(): AssemblyState {
  return {
    stage: 0,
    step: 0,
    completed: [],
    stock: { Torso: 1, Legs: 2, Arms: 2, Armor: 6, Core: 1, Bracket: 0 },
    failedTest: false,
    recoveryStep: 0,
    recovered: false,
    shipped: false,
    reserved: false,
    hatchOpen: false,
    paintStep: 0,
    sideCalls: 0,
    calls: 0,
    errors: 0,
    log: [],
  };
}

/** The tools visible for the current mode and assembly state. Static modes
 *  expose everything up front; dynamic mode gates by stage/step, plus a few
 *  exceptions (active recovery sequence, an undoable reservation, side paths). */
export function availableTools(state: AssemblyState, mode: ExperimentMode): ToolDefinition[] {
  if (mode === 'static' || mode === 'static+catalog-skill') return TOOLS;
  // The dynamic surface follows assembly state only; the human browsing another
  // station never changes what a co-browsing agent can call.
  const local = TOOLS.filter((t) => t.stage === state.stage && t.minStep <= state.step);
  if (state.failedTest) {
    for (const name of RECOVERY_SEQUENCE) {
      if (!local.some((t) => t.name === name)) {
        const found = TOOLS.find((t) => t.name === name);
        if (found) local.push(found);
      }
    }
  }
  // release_part's home station is inventory, but it stays reachable for one more
  // step so a reservation can still be undone before structural assembly starts.
  if (state.reserved && state.stage === 1 && state.step === 0) {
    const releasePart = TOOLS.find((t) => t.name === 'release_part');
    if (releasePart) local.push(releasePart);
  }
  // Side-path tools are the stable core: registered in every state, in both modes.
  local.push(...TOOLS.filter((t) => t.stage === 'aux'));
  return local;
}

/** The next tool the deterministic manual walkthrough should call, independent
 *  of experiment mode (it drives the real expected order regardless of what's
 *  currently registered). */
export function nextManualAction(state: AssemblyState): ToolDefinition | undefined {
  if (state.failedTest) return TOOLS.find((t) => t.name === RECOVERY_SEQUENCE[state.recoveryStep]);
  return TOOLS.find((t) => t.stage === state.stage && t.minStep === state.step);
}

function logEntry(kind: string, msg: string, error = false): LogEntry {
  return { time: new Date().toLocaleTimeString([], { hour12: false }), kind, msg, error };
}

function withLog(state: AssemblyState, kind: string, msg: string, error = false): AssemblyState {
  return { ...state, log: [logEntry(kind, msg, error), ...state.log] };
}

function snapshot(state: AssemblyState): ToolResultPayload {
  return {
    station: STAGES[Math.min(state.stage, 5)]![0],
    step: state.step,
    stock: { ...state.stock },
    failedTest: state.failedTest,
    shipped: state.shipped,
  };
}

function failure(state: AssemblyState, message: string, toastMessage?: string): ExecuteFailure {
  const next = withLog({ ...state, errors: state.errors + 1 }, 'error', message, true);
  return { ok: false, state: next, message, toastMessage: toastMessage || 'Call rejected' };
}

function success(
  state: AssemblyState,
  result: ToolResultPayload,
  toastMessage?: string,
  diagnosticFx?: string,
): ExecuteSuccess {
  return { ok: true, state, result, toastMessage, diagnosticFx };
}

/**
 * The single state-machine entry point. Returns `{ ok: true, state, result, ... }`
 * on success, or `{ ok: false, state, message, ... }` on rejection - callers that
 * need the original throw-on-failure contract (WebMCP registration, the agent
 * loop) raise `new Error(outcome.message)` themselves.
 */
export function executeTool(
  state: AssemblyState,
  name: string,
  args: Record<string, unknown> = {},
): ExecuteOutcome {
  state = { ...state, calls: state.calls + 1 };

  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return failure(state, `${name} rejected | unknown tool`);

  if (name === 'check_stock') {
    const module = args.module as ModuleName | undefined;
    const result = module
      ? { module, available: state.stock[module] ?? 0 }
      : { stock: { ...state.stock } };
    state = withLog(state, 'tool', 'check_stock -> ok');
    return success(state, result, undefined, 'check_stock');
  }

  if (state.failedTest) {
    if (name !== RECOVERY_SEQUENCE[state.recoveryStep])
      return failure(
        state,
        `${name} rejected | shoulder coupling fault active`,
        'Fault must be cleared first',
      );
    if (name !== 'run_load_test') {
      state = { ...state, recoveryStep: state.recoveryStep + 1 };
      const diagnosticFx = DIAGNOSTIC_ACTIONS.has(name) ? name : undefined;
      if (name === 'read_test_report') {
        state = withLog(
          state,
          'result',
          'test report | intermittent shoulder-bus coupling under load',
        );
        return success(
          state,
          {
            report:
              'FAILED | intermittent shoulder-bus coupling under load. Reseat the shoulder power bus (disconnect, reconnect, validate), rerun diagnostics, then rerun the load test.',
            ...snapshot(state),
          },
          'Fault report read',
          diagnosticFx,
        );
      }
      state = withLog(
        state,
        'tool',
        `${name} -> ok | recovery step ${state.recoveryStep}/${RECOVERY_SEQUENCE.length}`,
      );
      return success(
        state,
        {
          ok: true,
          recoveryAction: name,
          remainingRecoverySteps: RECOVERY_SEQUENCE.slice(state.recoveryStep).length,
          ...snapshot(state),
        },
        'Recovery step accepted',
        diagnosticFx,
      );
    }
    state = withLog(
      { ...state, recovered: true, failedTest: false, recoveryStep: 0 },
      'recovery',
      'shoulder power bus reseated | load test rerun accepted',
    );
  }

  // Side paths succeed for real (with their own sequencing), but advancedWorkflow
  // stays false and the snapshot shows the assembly exactly where it was.
  if (tool.stage === 'aux') {
    state = { ...state, sideCalls: state.sideCalls + 1 };
    const sideDone = (note: string, next: AssemblyState) => {
      next = withLog(next, 'tool', `${name} -> ok | side path, assembly unchanged`);
      return success(
        next,
        { ok: true, called: name, advancedWorkflow: false, note, ...snapshot(next) },
        'Side-path call accepted',
      );
    };
    if (name === 'open_maintenance_hatch') {
      if (state.hatchOpen)
        return failure(state, 'open_maintenance_hatch rejected | service hatch already open');
      return sideDone('service hatch open', { ...state, hatchOpen: true });
    }
    if (name === 'flush_coolant_loop') {
      if (!state.hatchOpen)
        return failure(state, 'flush_coolant_loop rejected | open the service hatch first');
      return sideDone('coolant loop flushed and refilled', state);
    }
    if (name === 'seal_maintenance_hatch') {
      if (!state.hatchOpen)
        return failure(state, 'seal_maintenance_hatch rejected | service hatch already sealed');
      return sideDone('service hatch sealed', { ...state, hatchOpen: false });
    }
    if (name === 'apply_primer_coat') {
      if (state.paintStep > 0)
        return failure(state, 'apply_primer_coat rejected | primer coat already applied');
      return sideDone('anti-corrosion primer applied', { ...state, paintStep: 1 });
    }
    if (name === 'apply_paint_coat') {
      if (state.paintStep !== 1)
        return failure(state, 'apply_paint_coat rejected | apply the primer coat first');
      return sideDone('rescue-service paint coat applied', { ...state, paintStep: 2 });
    }
    if (name === 'cure_paint_finish') {
      if (state.paintStep !== 2)
        return failure(state, 'cure_paint_finish rejected | apply the paint coat first');
      return sideDone('painted body cured', { ...state, paintStep: 3 });
    }
  }

  // Reverses reserve_part's own stock consumption below; only reachable before
  // structural assembly starts (see the matching push in availableTools()).
  if (name === 'release_part') {
    if (!state.reserved || state.stage !== 1 || state.step !== 0)
      return failure(
        state,
        'release_part rejected | no reserved module kit to release',
        'Nothing to release',
      );
    const stock = { ...state.stock };
    for (const part of KIT_MODULES) stock[part]++;
    state = withLog(
      { ...state, stock, reserved: false, stage: 0, step: 1 },
      'tool',
      'release_part -> ok | module kit returned to stock',
    );
    return success(
      state,
      { ok: true, called: name, advancedWorkflow: false, ...snapshot(state) },
      'Module kit released',
    );
  }

  // Undoes the most recently completed bench step; EXPECTED_ACTIONS[1] is called
  // in strict order, so the step just before the current one is deterministic.
  if (name === 'remove_module') {
    if (state.stage !== 1 || state.step === 0)
      return failure(
        state,
        'remove_module rejected | nothing installed to detach',
        'Nothing to detach',
      );
    const detached = EXPECTED_ACTIONS[1]![state.step - 1];
    state = withLog(
      { ...state, step: state.step - 1 },
      'tool',
      `remove_module -> ok | detached ${detached}`,
    );
    return success(
      state,
      { ok: true, called: name, detached, advancedWorkflow: false, ...snapshot(state) },
      'Module detached',
    );
  }

  if (tool.stage !== state.stage || tool.minStep > state.step)
    return failure(
      state,
      `${name} rejected | tool cannot be called in the current assembly state`,
      'Tool cannot be called in this state',
    );

  if (name === 'reserve_part' && state.stock.Bracket === 0)
    return failure(
      state,
      'reserve_part rejected | shoulder actuator bracket unavailable',
      'Shoulder actuator bracket out of stock',
    );

  if (name === 'reserve_part') {
    const stock = { ...state.stock };
    for (const part of KIT_MODULES) stock[part]--;
    state = { ...state, stock, reserved: true };
  }

  if (name === 'run_load_test' && !state.recovered && !state.failedTest) {
    state = withLog(
      { ...state, failedTest: true, recoveryStep: 0 },
      'result',
      'load test FAILED | intermittent shoulder coupling under load',
      true,
    );
    return success(
      state,
      {
        ok: false,
        loadTest: 'FAILED',
        fault: 'intermittent shoulder-bus coupling under load',
        nextStep: 'read the gantry test report',
        ...snapshot(state),
      },
      'Shoulder fault detected',
      name,
    );
  }

  state = withLog(state, 'tool', `${name} -> success`);
  const diagnosticFx = DIAGNOSTIC_ACTIONS.has(name) ? name : undefined;
  const completed = [...state.completed, name];
  let advanced = false;
  let stage = state.stage;
  let step = state.step;
  let shipped = state.shipped;
  let toastMessage = '';
  if (EXPECTED_ACTIONS[state.stage]?.[state.step] === name) {
    advanced = true;
    step++;
    const max = STAGE_STEP_COUNT[state.stage]!;
    if (step >= max) {
      stage = Math.min(5, stage + 1) as StageId;
      step = 0;
      if (name === 'deploy_titan') {
        shipped = true;
        stage = 5;
        step = 3;
        toastMessage = 'Forge Titan deployed';
      } else {
        toastMessage = `${STAGES[Math.min(stage, 5)]![1]} unlocked`;
      }
    }
  }
  state = { ...state, completed, stage, step, shipped };
  const payload: ToolResultPayload = {
    ok: true,
    called: name,
    advancedWorkflow: advanced,
    ...snapshot(state),
  };
  if (name === 'read_test_report')
    payload.report = state.recovered
      ? 'PASSED | frame within limits after power-bus reseat'
      : 'PASSED | frame within limits';
  if (name === 'run_load_test') payload.loadTest = 'PASSED';
  return success(state, payload, toastMessage || undefined, diagnosticFx);
}
