import { describe, expect, it } from "bun:test";
import { SubagentCostLedger } from "../src/ledger";

describe("SubagentCostLedger", () => {
	it("replaces detached live cumulative progress instead of double-counting repeated snapshots", () => {
		const ledger = new SubagentCostLedger();
		const sessionFile = "/tmp/detached-run.jsonl";

		expect(
			ledger.handleLifecycle({
				id: "detached-run",
				status: "started",
				detached: true,
				sessionFile,
			}),
		).toBe(true);
		expect(ledger.handleProgress({ id: "detached-run", sessionFile, cost: 2 })).toBe(true);
		expect(ledger.handleProgress({ id: "detached-run", sessionFile, cost: 5 })).toBe(true);

		expect(ledger.total()).toBe(5);
	});

	it("accumulates a same-key follow-up lifecycle after the previous run total", () => {
		const ledger = new SubagentCostLedger();
		const sessionFile = "/tmp/follow-up.jsonl";
		const started = { id: "follow-up", status: "started" as const, detached: true, sessionFile };

		expect(ledger.handleLifecycle(started)).toBe(true);
		expect(ledger.handleProgress({ id: "follow-up", sessionFile, cost: 4 })).toBe(true);
		expect(ledger.handleLifecycle({ id: "follow-up", status: "completed", sessionFile })).toBe(true);
		expect(ledger.handleLifecycle(started)).toBe(true);
		expect(ledger.handleProgress({ id: "follow-up", sessionFile, cost: 3 })).toBe(true);

		expect(ledger.total()).toBe(7);
	});

	it("uses restoredCost as the initial baseline without re-adding it to progress snapshots", () => {
		const ledger = new SubagentCostLedger();
		const sessionFile = "/tmp/restored-run.jsonl";

		expect(
			ledger.handleLifecycle({
				id: "restored-run",
				status: "started",
				detached: true,
				sessionFile,
				restoredCost: 6,
			}),
		).toBe(true);
		expect(ledger.total()).toBe(6);
		expect(ledger.handleProgress({ id: "restored-run", sessionFile, cost: 2 })).toBe(true);
		expect(ledger.total()).toBe(8);
		expect(ledger.handleProgress({ id: "restored-run", sessionFile, cost: 5 })).toBe(true);

		expect(ledger.total()).toBe(11);
	});

	it("includes a blocking descendant whose transcript path is under a detached root", () => {
		const ledger = new SubagentCostLedger();
		const rootSessionFile = "/tmp/transcripts/root.jsonl";
		const childSessionFile = "/tmp/transcripts/root/blocking-child.jsonl";

		expect(
			ledger.handleLifecycle({
				id: "root",
				status: "started",
				detached: true,
				sessionFile: rootSessionFile,
			}),
		).toBe(true);
		expect(
			ledger.handleLifecycle({
				id: "blocking-child",
				status: "started",
				detached: false,
				sessionFile: childSessionFile,
			}),
		).toBe(true);
		expect(ledger.handleProgress({ id: "blocking-child", sessionFile: childSessionFile, cost: 3 })).toBe(true);

		expect(ledger.total()).toBe(3);
	});

	it("excludes an unrelated synchronous run from the detached-only total", () => {
		const ledger = new SubagentCostLedger();
		const sessionFile = "/tmp/transcripts/unrelated.jsonl";

		expect(
			ledger.handleLifecycle({
				id: "unrelated-sync",
				status: "started",
				detached: false,
				sessionFile,
			}),
		).toBe(true);
		expect(ledger.handleProgress({ id: "unrelated-sync", sessionFile, cost: 9 })).toBe(true);

		expect(ledger.total()).toBe(0);
	});

	it("recognizes a detached root late and includes an already-seen child transcript", () => {
		const ledger = new SubagentCostLedger();
		const rootSessionFile = "/tmp/late-root.jsonl";
		const childSessionFile = "/tmp/late-root/child.jsonl";

		expect(
			ledger.handleLifecycle({
				id: "child",
				status: "started",
				detached: false,
				sessionFile: childSessionFile,
			}),
		).toBe(true);
		expect(ledger.handleProgress({ id: "child", sessionFile: childSessionFile, cost: 4 })).toBe(true);
		expect(ledger.total()).toBe(0);

		expect(
			ledger.handleLifecycle({
				id: "late-root",
				status: "started",
				detached: true,
				sessionFile: rootSessionFile,
			}),
		).toBe(true);

		expect(ledger.total()).toBe(4);
	});

	it("replays a valid snapshot through reset and keeps its persisted baseline for later progress", () => {
		const source = new SubagentCostLedger();
		const sessionFile = "/tmp/persisted-root.jsonl";
		source.handleLifecycle({ id: "persisted-root", status: "started", detached: true, sessionFile });
		source.handleProgress({ id: "persisted-root", sessionFile, cost: 4 });
		const persisted = source.snapshot();

		const replay = new SubagentCostLedger();
		replay.handleLifecycle({ id: "stale", status: "started", detached: true, sessionFile: "/tmp/stale.jsonl" });
		replay.handleProgress({ id: "stale", sessionFile: "/tmp/stale.jsonl", cost: 99 });
		replay.reset(persisted);

		expect(replay.snapshot()).toEqual(persisted);
		expect(replay.total()).toBe(4);
		expect(replay.handleProgress({ id: "persisted-root", sessionFile, cost: 3 })).toBe(true);
		expect(replay.total()).toBe(7);
	});

	it("rejects malformed snapshots without replacing the current ledger state", () => {
		const ledger = new SubagentCostLedger();
		const sessionFile = "/tmp/valid-state.jsonl";
		ledger.handleLifecycle({ id: "valid-state", status: "started", detached: true, sessionFile });
		ledger.handleProgress({ id: "valid-state", sessionFile, cost: 2 });
		const before = ledger.snapshot();
		const malformedSnapshots: unknown[] = [
			{ version: 2, runs: before.runs },
			{ version: 1, runs: [{ key: "valid-state", id: "valid-state", total: 2, detachedRoot: true }] },
			{ version: 1, runs: [{ key: sessionFile, id: "valid-state", sessionFile, total: 2, detachedRoot: true, included: true, extra: true }] },
		];

		for (const malformed of malformedSnapshots) {
			expect(new SubagentCostLedger(malformed).total()).toBe(0);
			ledger.reset(malformed);
			expect(ledger.snapshot()).toEqual(before);
		}
	});

	it("accepts zero progress while rejecting negative and non-finite costs", () => {
		const ledger = new SubagentCostLedger();
		const sessionFile = "/tmp/zero-cost.jsonl";
		ledger.handleLifecycle({ id: "zero-cost", status: "started", detached: true, sessionFile });

		expect(ledger.handleProgress({ id: "zero-cost", sessionFile, cost: 0 })).toBe(true);
		expect(ledger.total()).toBe(0);
		expect(ledger.handleProgress({ id: "zero-cost", sessionFile, cost: -1 })).toBe(false);
		expect(ledger.handleProgress({ id: "zero-cost", sessionFile, cost: Number.NaN })).toBe(false);
		expect(ledger.handleProgress({ id: "zero-cost", sessionFile, cost: Number.POSITIVE_INFINITY })).toBe(false);

		expect(ledger.total()).toBe(0);
	});

	it("keeps detached runs with the same id separate when their session files differ", () => {
		const ledger = new SubagentCostLedger();
		const firstSessionFile = "/tmp/session-a.jsonl";
		const secondSessionFile = "/tmp/session-b.jsonl";

		for (const sessionFile of [firstSessionFile, secondSessionFile]) {
			expect(
				ledger.handleLifecycle({
					id: "same-id",
					status: "started",
					detached: true,
					sessionFile,
				}),
			).toBe(true);
		}
		expect(ledger.handleProgress({ id: "same-id", sessionFile: firstSessionFile, cost: 2 })).toBe(true);
		expect(ledger.handleProgress({ id: "same-id", sessionFile: secondSessionFile, cost: 3 })).toBe(true);

		const snapshot = ledger.snapshot();
		expect(ledger.total()).toBe(5);
		expect(snapshot.runs).toHaveLength(2);
		expect(snapshot.runs.map(run => run.key)).toEqual([firstSessionFile, secondSessionFile]);
	});
});
