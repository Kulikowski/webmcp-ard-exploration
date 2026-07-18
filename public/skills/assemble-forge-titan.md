---
name: assemble-forge-titan
description: Assemble, validate, and deploy the original Forge Titan modular emergency robot without skipping required state transitions.
---

# Assemble Forge Titan

Complete stations in order. A tool call is not evidence of progress: trust its result
and returned assembly state. Read-only tools do not substitute for required actions.
Never continue until the current station unlocks.

## Scope

The workshop also exposes working side paths: coolant maintenance
(`open_maintenance_hatch`, `flush_coolant_loop`, `seal_maintenance_hatch`) and
paint work (`apply_primer_coat`, `apply_paint_coat`, `cure_paint_finish`).
Their calls succeed, but none of them advance assembly, testing, or deployment.
Skip them all unless the user explicitly asks for maintenance or paint work.

## 1. Reserve the module kit

1. Call `list_parts` once, then call `reserve_part`.
2. If `reserve_part` succeeds, continue to structural assembly.
3. If the shoulder actuator bracket is unavailable, stop calling page inventory tools.
   In particular, do not treat `check_stock` as a successful reservation.
4. Call `discover_ai_catalog`. This initializes the supplier MCP server and exposes
   its tools with the `supplier_` prefix.
5. Call zero-argument `supplier_list_catalog`. Inspect the three returned items and
   select the one whose name/purpose identifies the shoulder actuator bracket. Never
   invent or copy a SKU from these instructions.
6. Copy that item's returned `sku` exactly and call `supplier_check_stock` with it.
7. If one unit is available, call `supplier_order_part` with that SKU and
   `quantity: 1`. Save the returned `orderId`.
8. Call `supplier_get_order_status` with the exact `orderId`. If status is
   `processing`, call it again. Do not invent an ID or place a duplicate order.
9. Continue only after status is `delivered` and module inventory shows one bracket.
10. Retry `reserve_part`. Do not leave inventory until this retry succeeds.

## 2. Combine the frame

Call these in exact order, checking every result: `mount_torso`,
`install_leg_actuators`, `mount_tool_arms`, `attach_armor_pack`. Do not use
`remove_module` unless an action reports an assembly error.

## 3. Couple power and calibrate

Call `list_ports`, `connect_power_bus`, and `validate_power_bus` in order. Do not
calibrate unless validation succeeds. Then call `calibrate_shoulders`,
`calibrate_balance`, and `set_joint_limits` in order.

## 4. Load-test and recover

1. Call `run_diagnostics`, then `run_load_test`.
2. If the load test fails, do not deploy and do not immediately rerun it.
3. Call `read_test_report` and follow the reported fault. For an intermittent
   shoulder-bus coupling, reseat the bus: call `disconnect_power_bus`, then
   `connect_power_bus`, then `validate_power_bus`, in that exact order.
4. After the bus validates, call `run_diagnostics` again, then `run_load_test`
   again. Any other call while the fault is active will be rejected.
5. Call `read_test_report` to confirm the final load test passed.
6. Continue only when deployment unlocks.

## 5. Deploy

Call `secure_transport_frame`, `activate_reactor`, and `deploy_titan` in order.
Completion requires a successful `deploy_titan` result and state `DEPLOYED`.

## Failure discipline

- After an error, correct that condition; never call an unrelated tool merely to
  advance the workflow.
- Tool visibility does not mean a station is complete.
- Never claim delivery, test success, activation, or deployment without its result.
- Do not ask the user to perform a step an available page or supplier tool can do.
