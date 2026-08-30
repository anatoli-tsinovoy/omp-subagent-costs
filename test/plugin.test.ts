import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import plugin from "../index";

const LIFECYCLE_CHANNEL = "task:subagent:lifecycle";
const PROGRESS_CHANNEL = "task:subagent:progress";
const STATUS_KEY = "omp-subagent-costs";
const temporaryDirectories: string[] = [];

type EventHandler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
type BusHandler = (value: unknown) => void;
type StatusUpdate = { key: string; text: string | undefined };

class FakeEventBus {
	readonly #handlers = new Map<string, Set<BusHandler>>();

	on(channel: string, handler: BusHandler): () => void {
		const handlers = this.#handlers.get(channel) ?? new Set<BusHandler>();
		handlers.add(handler);
		this.#handlers.set(channel, handlers);
		return () => handlers.delete(handler);
	}

	emit(channel: string, value: unknown): void {
		for (const handler of this.#handlers.get(channel) ?? []) handler(value);
	}
}

function makeContext(statuses: StatusUpdate[], sessionFile: string, branch: readonly unknown[] = []): ExtensionContext {
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
			getSessionFile: () => sessionFile,
		} as unknown as ExtensionContext["sessionManager"],
	} as unknown as ExtensionContext;
}

function createHarness(sessionFile: string, branch: readonly unknown[] = []) {
	const statuses: StatusUpdate[] = [];
	const eventHandlers = new Map<string, EventHandler[]>();
	const bus = new FakeEventBus();
	const context = makeContext(statuses, sessionFile, branch);
	const api = {
		on(event: string, handler: EventHandler): void {
			const handlers = eventHandlers.get(event) ?? [];
			handlers.push(handler);
			eventHandlers.set(event, handlers);
		},
		events: bus,
	} as unknown as ExtensionAPI;
	plugin(api);

	return {
		bus,
		context,
		statuses,
		async emit(event: string, value: unknown, target: ExtensionContext = context): Promise<void> {
			await Promise.all((eventHandlers.get(event) ?? []).map(handler => handler(value, target)));
		},
	};
}

function latestStatus(statuses: readonly StatusUpdate[]): StatusUpdate | undefined {
	return statuses.at(-1);
}

async function fixtureRoot(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-subagent-cost-plugin-"));
	temporaryDirectories.push(directory);
	return path.join(directory, "root.jsonl");
}

async function writeAsyncTranscript(file: string, cost: number): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const timestamp = "2026-01-01T00:00:00.000Z";
	const entries = [
		{ type: "session", version: 3, id: "async", timestamp, cwd: "/tmp" },
		{
			type: "session_init",
			id: "init",
			parentId: null,
			timestamp,
			systemPrompt: "test",
			task: "test",
			tools: [],
			detached: true,
		},
		{
			type: "message",
			id: "cost",
			parentId: "init",
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				provider: "test",
				model: "test",
				api: "test",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
				},
				stopReason: "stop",
				timestamp: Date.parse(timestamp),
			},
		},
	];
	await Bun.write(file, entries.map(entry => JSON.stringify(entry)).join("\n"));
}


afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("omp-subagent-costs plugin", () => {
	it("uses cumulative live progress as an ephemeral cache", async () => {
		const root = await fixtureRoot();
		const harness = createHarness(root);
		const sessionFile = path.join(root.slice(0, -6), "detached-root.jsonl");
		await harness.emit("session_start", {});

		harness.bus.emit(LIFECYCLE_CHANNEL, {
			id: "detached-root",
			status: "started",
			detached: true,
			sessionFile,
		});
		harness.bus.emit(PROGRESS_CHANNEL, { id: "detached-root", sessionFile, cost: 2.25 });
		expect(latestStatus(harness.statuses)).toEqual({ key: STATUS_KEY, text: "Async subagents: $2.25" });

		harness.bus.emit(PROGRESS_CHANNEL, { id: "detached-root", sessionFile, cost: 1.5 });
		expect(latestStatus(harness.statuses)).toEqual({ key: STATUS_KEY, text: "Async subagents: $1.50" });
	});

	it("hydrates historical async cost without custom plugin entries", async () => {
		const root = await fixtureRoot();
		await writeAsyncTranscript(path.join(root.slice(0, -6), "historical.jsonl"), 4.75);
		const harness = createHarness(root);

		await harness.emit("session_start", {});

		expect(latestStatus(harness.statuses)).toEqual({ key: STATUS_KEY, text: "Async subagents: $4.75" });
	});

	it("clears the prior session immediately when switching", async () => {
		const firstRoot = await fixtureRoot();
		const harness = createHarness(firstRoot);
		const detachedFile = path.join(firstRoot.slice(0, -6), "detached.jsonl");
		await harness.emit("session_start", {});
		harness.bus.emit(LIFECYCLE_CHANNEL, {
			id: "detached",
			status: "started",
			detached: true,
			sessionFile: detachedFile,
		});
		harness.bus.emit(PROGRESS_CHANNEL, { id: "detached", sessionFile: detachedFile, cost: 6 });

		const secondRoot = await fixtureRoot();
		await harness.emit("session_switch", {}, makeContext(harness.statuses, secondRoot));

		expect(latestStatus(harness.statuses)).toEqual({ key: STATUS_KEY, text: undefined });
	});
});
