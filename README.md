# omp-subagent-costs

An OMP plugin that shows subagent spend not already included in the main
session cost.

## Install

Install the public GitHub plugin with:

```sh
omp plugin install github:anatoli-tsinovoy/omp-subagent-costs
```

Remove it with:

```sh
omp plugin uninstall omp-subagent-costs
```

## Display

The total is pinned directly above the prompt box:

```text
$0.01 (agents)
```

The plugin uses OMP's above-editor widget area, so it does not depend on
`statusLine.showHookStatus`.

If your OMP build also provides the native `statusLine.showAsyncSubagentCost`
setting, disable it: its detached-agent total is already included here.

Run `/subagent-costs` to hide the widget; run it again to show it. Visibility is
process-local and resets to shown when OMP restarts. Cost tracking continues
while the widget is hidden.

## What is counted

The plugin counts child-agent spend that OMP's main session cost omits:
detached `task` agents, `eval agent()` children, and their descendants.
Root-level synchronous `task` results are excluded because OMP already rolls
their usage into the main session cost.

## Live and persisted totals

Persisted session transcripts are canonical. Historical unreported spend is
hydrated when OMP loads, switches, branches, or traverses the session tree,
including spend from before plugin installation whenever its transcripts
remain available. Completed `eval agent()` calls trigger a refresh. Live task
lifecycle and progress events update only an in-memory cache; they are not
persisted as plugin state. The plugin writes no plugin-specific session entries.

The displayed main session cost and this widget are non-overlapping, so adding
them gives the complete persisted session spend.
