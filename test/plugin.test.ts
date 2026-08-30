import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import plugin from "../index";

const LIFECYCLE_CHANNEL = "task:subagent:lifecycle";
const PROGRESS_CHANNEL = "task:subagent:progress";
const STATUS_KEY = "omp-subagent-costs";
const CUSTOM_ENTRY_TYPE = "omp-subagent-costs";

type EventHandler = (event: unknown, ctx: ExtensionContext) => void;
type BusHandler = (value: unknown) => void;

type StatusUpdate = {
	key: string;
	text: string | undefined;
};

type CustomEntry = {
	customType: string;
	data: unknown;
};

class FakeEventBus {
	readonly #handlers = new Map<string, Set<BusHandler>>();

	on(channel: string, handler: BusHandler): () => void {
		let handlers = this.#handlers.get(channel);
		if (!handlers) {
			handlers = new Set<BusHandler>();
			this.#handlers.set(channel, handlers);
		}
		handlers.add(handler);
		return () => handlers?.delete(handler);
	}

	emit(channel: string, value: unknown): void {
		for (const handler of this.#handlers.get(channel) ?? []) handler(value);
	}
}

function makeContext(statuses: StatusUpdate[], branch: readonly unknown[] = []): ExtensionContext {
	return {
		ui: {
			setStatus(key: string, text: string | undefined): void {
				statuses.push({ key, text });
			},
		} as unknown as ExtensionContext["ui"],
		mode: "tui",
		hasUI: true,
		sessionManager: {
			getBranch: () => branch,
		} as unknown as ExtensionContext["sessionManager"],
	} as unknown as ExtensionContext;
}

function createHarness(branch: readonly unknown[] = []) {
	const statuses: StatusUpdate[] = [];
	const entries: CustomEntry[] = [];
	const eventHandlers = new Map<string, EventHandler[]>();
	const bus = new FakeEventBus();
	const context = makeContext(statuses, branch);
	const api = {
		on(event: string, handler: EventHandler): void {
			const handlers = eventHandlers.get(event) ?? [];
			handlers.push(handler);
			eventHandlers.set(event, handlers);
		},
		appendEntry(customType: string, data: unknown): void {
			entries.push({ customType, data });
		},
		events: bus,
	} as unknown as ExtensionAPI;

	plugin(api);

	return {
		bus,
		context,
		statuses,
		entries,
		makeContext: (nextBranch: readonly unknown[] = []) => makeContext(statuses, nextBranch),
		emit(event: string, value: unknown, target: ExtensionContext = context): void {
			for (const handler of eventHandlers.get(event) ?? []) handler(value, target);
		},
	};
}

function latestStatus(statuses: readonly StatusUpdate[]): StatusUpdate | undefined {
	return statuses.at(-1);
}

describe("omp-subagent-costs plugin", () => {
	it("renders detached cumulative progress, persists terminal state, and clears zero totals", () => {
		const harness = createHarness();
		const sessionFile = "/tmp/detached-root.jsonl";

		harness.emit("session_start", {});
		expect(latestStatus(harness.statuses)).toEqual({ key: STATUS_KEY, text: undefined });

		harness.bus.emit(LIFECYCLE_CHANNEL, {
			id: "detached-root",
			status: "started",
			detached: true,
			sessionFile,
		});
		harness.bus.emit(PROGRESS_CHANNEL, { id: "detached-root", sessionFile, cost: 0 });
		expect(latestStatus(harness.statuses)).toEqual({ key: STATUS_KEY, text: undefined });
		harness.bus.emit(PROGRESS_CHANNEL, { id: "detached-root", sessionFile, cost: 2.25 });
		expect(latestStatus(harness.statuses)).toEqual({ key: STATUS_KEY, text: "Async subagents: $2.25" });

		harness.bus.emit(PROGRESS_CHANNEL, { id: "detached-root", sessionFile, cost: 1.5 });
		expect(latestStatus(harness.statuses)).toEqual({ key: STATUS_KEY, text: "Async subagents: $1.50" });

		harness.bus.emit(LIFECYCLE_CHANNEL, {
			id: "detached-root",
			status: "completed",
			sessionFile,
		});
		expect(harness.entries).toEqual([
			{
				customType: CUSTOM_ENTRY_TYPE,
				data: {
					version: 1,
					runs: [
						{
							key: sessionFile,
							id: "detached-root",
							sessionFile,
							total: 1.5,
							detachedRoot: true,
							included: true,
						},
					],
				},
			},
		]);

		harness.emit("session_start", {});
		expect(latestStatus(harness.statuses)).toEqual({ key: STATUS_KEY, text: undefined });
	});

	it("restores the last valid matching custom entry on session start", () => {
		const sessionFile = "/tmp/restored-root.jsonl";
		const branch = [
			{
				type: "custom",
				customType: CUSTOM_ENTRY_TYPE,
				data: {
					version: 1,
					runs: [
						{
							key: sessionFile,
							id: "restored-root",
							sessionFile,
							total: 1.25,
							detachedRoot: true,
							included: true,
						},
					],
				},
			},
			{ type: "message", role: "user", content: "continue" },
			{
				type: "custom",
				customType: CUSTOM_ENTRY_TYPE,
				data: {
					version: 1,
					runs: [
						{
							key: sessionFile,
							id: "restored-root",
							sessionFile,
							total: 4.75,
							detachedRoot: true,
							included: true,
						},
					],
				},
			},
		];
		const harness = createHarness(branch);

		harness.emit("session_start", {});

		expect(latestStatus(harness.statuses)).toEqual({ key: STATUS_KEY, text: "Async subagents: $4.75" });
		expect(harness.entries).toEqual([]);
	});

	it("ignores malformed raw frames without changing status or persistence", () => {
		const harness = createHarness();
		const sessionFile = "/tmp/malformed-root.jsonl";

		harness.emit("session_start", {});
		harness.bus.emit(LIFECYCLE_CHANNEL, {
			id: "malformed-root",
			status: "started",
			detached: true,
			sessionFile,
		});
		harness.bus.emit(PROGRESS_CHANNEL, { id: "malformed-root", sessionFile, cost: 2 });
		const statusCount = harness.statuses.length;
		const statusBefore = latestStatus(harness.statuses);
		const entriesBefore = [...harness.entries];

		harness.bus.emit(LIFECYCLE_CHANNEL, {
			id: "malformed-root",
			status: "finished",
			detached: true,
			sessionFile,
		});
		harness.bus.emit(PROGRESS_CHANNEL, { id: "malformed-root", sessionFile, cost: -1 });
		harness.bus.emit(PROGRESS_CHANNEL, { id: "malformed-root", sessionFile, cost: Number.NaN });

		expect(harness.statuses).toHaveLength(statusCount);
		expect(latestStatus(harness.statuses)).toEqual(statusBefore);
		expect(harness.entries).toEqual(entriesBefore);
	});

	it("replaces the active ledger on session switch instead of accumulating across sessions", () => {
		const harness = createHarness();
		const firstContext = harness.context;
		const secondContext = harness.makeContext();
		const firstSessionFile = "/tmp/session-a.jsonl";
		const secondSessionFile = "/tmp/session-b.jsonl";

		harness.emit("session_start", {}, firstContext);
		harness.bus.emit(LIFECYCLE_CHANNEL, {
			id: "session-a",
			status: "started",
			detached: true,
			sessionFile: firstSessionFile,
		});
		harness.bus.emit(PROGRESS_CHANNEL, { id: "session-a", sessionFile: firstSessionFile, cost: 6 });
		expect(latestStatus(harness.statuses)).toEqual({ key: STATUS_KEY, text: "Async subagents: $6.00" });

		harness.emit("session_switch", {}, secondContext);
		expect(latestStatus(harness.statuses)).toEqual({ key: STATUS_KEY, text: undefined });

		harness.bus.emit(LIFECYCLE_CHANNEL, {
			id: "session-b",
			status: "started",
			detached: true,
			sessionFile: secondSessionFile,
		});
		harness.bus.emit(PROGRESS_CHANNEL, { id: "session-b", sessionFile: secondSessionFile, cost: 1.5 });
		expect(latestStatus(harness.statuses)).toEqual({ key: STATUS_KEY, text: "Async subagents: $1.50" });
	});
});
