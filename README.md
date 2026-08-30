# omp-subagent-costs

An OMP plugin that shows the cumulative spend of asynchronous subagents in the
status line.

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
$0.01 (async)
```

The plugin uses OMP's above-editor widget area, so it does not depend on
`statusLine.showHookStatus`.

If your OMP build also provides the native `statusLine.showAsyncSubagentCost`
setting, disable that setting to avoid displaying the same total twice.

Run `/subagent-costs` to hide the widget; run it again to show it. Visibility is
process-local and resets to shown when OMP restarts. Cost tracking continues
while the widget is hidden.

## What is counted

This plugin is async-only. It counts every assistant cost in an asynchronous
(detached) subagent transcript and every descendant nested below that async
root, including blocking descendants. A standalone blocking root is not
counted. Nested transcript directories are traversed recursively, so async
roots below synchronous children and their descendants are included.

## Live and persisted totals

Persisted session transcripts are canonical. Historical async spend is hydrated
when OMP loads, switches, branches, or traverses the session tree, including
spend from before plugin installation whenever its transcripts remain
available. Live lifecycle and progress events update only an in-memory cache;
they are not persisted as plugin state. The plugin writes no plugin-specific
session entries.

Do not add a parent aggregate to this number when that aggregate already
includes child subagent spend: doing so counts the same child cost twice.
