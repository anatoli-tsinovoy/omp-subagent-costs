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

## Configuration

The plugin reports through OMP's hook-status area. Keep
`statusLine.showHookStatus` enabled (the default) or the status will not be
visible:

```yaml
statusLine:
  showHookStatus: true
```

When spend is available, the status line looks like:

```text
Async subagents: $0.01
```

## What is counted

This plugin is intentionally async-only. It counts detached/asynchronous
subagent runs and also counts blocking descendants nested inside those detached
runs. A standalone blocking subagent is not an asynchronous run and is not
included. Nested descendants are attributed to a detached run using their
session-file path under the detached transcript root.

Progress events are cumulative snapshots, not increments: a newer snapshot
replaces the earlier value, so the same progress is never added twice. A
`restoredCost` value, when supplied by OMP, is used only as the initial baseline
for a run; it is not repeatedly added to later snapshots. The plugin tracks
runs by `sessionFile` when present and otherwise by run id.

## Live and persisted totals

While a detached run is in flight, live progress updates are reflected in the
status line. Terminal snapshots are persisted in the plugin ledger and restored
for the active session branch, so recorded totals survive reloads and later
progress updates continue from the recorded baseline. The ledger is reset or
re-scoped when OMP starts a new session, switches or branches the active
session, or shuts down.

The plugin does not reconstruct spend from before it was installed. Any spend
that predates plugin installation is therefore unavailable, even if the OMP
session transcript still exists. Live lifecycle channels are not replayed for
runs that were already in progress when the plugin started; only plugin-ledger
records (and cost information available through the supported transcript
metadata) can restore such totals.

Finally, do not add a parent aggregate to this number when that aggregate
already includes the child subagent spend: doing so counts the same child cost
twice.
