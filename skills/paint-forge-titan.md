---
name: paint-forge-titan
description: Prime, paint, and cure the Forge Titan body in the required order.
---

# Paint the Forge Titan body

Use this only when the user asks for paint or finishing work. This procedure
is cosmetic and never advances assembly, testing, or deployment.

1. Call `apply_primer_coat` once. A second primer call is rejected.
2. Call `apply_paint_coat`. It requires the primer coat.
3. Call `cure_paint_finish`. It requires the applied paint coat.
4. Deployment does not require paint work; never treat these steps as part of
   the assembly mission.
