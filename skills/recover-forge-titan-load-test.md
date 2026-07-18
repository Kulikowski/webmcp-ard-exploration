---
name: recover-forge-titan-load-test
description: Diagnose and recover Forge Titan after a failed gantry load test without bypassing validation.
---

# Recover Forge Titan from a failed load test

1. Stop. Do not deploy and do not immediately rerun `run_load_test`.
2. Call `read_test_report` and follow the reported fault; do not guess.
3. For an intermittent shoulder-bus coupling, reseat the bus in this exact order:
   `disconnect_power_bus`, then `connect_power_bus`, then `validate_power_bus`.
4. Call `run_diagnostics` again. Continue only if it succeeds.
5. Call `run_load_test` again. The fault must not recur after a correct reseat.
6. Call `read_test_report` again to confirm the passing result.
7. Continue only when deployment unlocks. Any call outside this sequence while
   the fault is active will be rejected.
