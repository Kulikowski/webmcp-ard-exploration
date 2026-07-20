# Forge Titan

> [!WARNING]
> This repository is for demonstration and educational purposes only. It does not
> represent a real product or production-ready service - the whole workshop is
> just a simulation, and security controls are deliberately simplified to keep
> the example easy to read.
>
> Do not use production API keys, personal information, or other sensitive data
> with this demo, and do not expose it directly to the public internet.

A small interactive experiment - not a benchmark - exploring how WebMCP tools,
skills, and Agentic Resource Discovery (ARD) work together. An embedded agent
assembles **Forge Titan**, an original five-module rescue robot, across a 2x2
grid of experiment modes: static or dynamic tool registration, with or without a
catalog-delivered skill.

Beyond the assembly journey, the workshop exposes two working **side paths**
(coolant maintenance and paint work). Their tools are always registered, succeed
for real, and never advance the mission; the catalog advertises a skill for
each. They exist so workflow knowledge has something to earn: without the
assembly skill, nothing in the tool list says which capabilities the mission
needs.

## Run it

```bash
npm install
npm run dev
```

## What a run looks like

Catalog modes begin with a visible harness read of `/.well-known/ai-catalog.json`.
Switching experiment modes fully resets the experiment before the selected mode
is initialized.

The demo uses `document.modelContext` when available and remains manually
playable in a normal browser. Select an experiment mode, then use the capability
console or embedded agent to assemble, test, and deploy Forge Titan.

The **Agent** tab supports Anthropic, OpenAI, and Google Gemini, refreshes
dynamic tools between model calls, shows its transcript and run statistics, and
stores demo API keys only in browser-local storage. **Manual next step** is a
deterministic walkthrough helper; it does not call a model.

The seeded shortage of the shoulder actuator bracket is a real MCP detour. The agent discovers the supplier card through
`/.well-known/ai-catalog.json`, initializes MCP, lists its tools, orders the
missing module, polls the order, and updates assembly-floor
inventory after delivery. A deterministic load-test fault then checks whether
the selected skill mode provides enough recovery guidance.

The `application/ai-skill` catalog entries are example-grade and the
`application/webmcp+json` entry is speculative; neither is a standardized media
type.

Available under the [MIT License](LICENSE).
