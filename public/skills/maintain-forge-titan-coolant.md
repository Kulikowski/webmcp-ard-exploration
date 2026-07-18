---
name: maintain-forge-titan-coolant
description: Flush and refill the Forge Titan actuator coolant loop through the cradle service hatch.
---

# Maintain the Forge Titan coolant loop

Use this only when the user asks for coolant or lubricant maintenance. This
procedure never advances assembly, testing, or deployment.

1. Call `open_maintenance_hatch`. The call is rejected if the hatch is already open.
2. Call `flush_coolant_loop`. It requires an open service hatch.
3. Call `seal_maintenance_hatch`. Never leave the hatch open after the flush.
4. Confirm each result before the next call; do not interleave assembly tools
   while the hatch is open.
