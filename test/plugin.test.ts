import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import plugin from "../index";

const LIFECYCLE_CHANNEL = "task:subagent:lifecycle";
const PROGRESS_CHANNEL = "task:subagent:progress";
const WIDGET_KEY = "omp-subagent-costs";
const COMMAND_NAME = "subagent-costs";
const temporaryDirectories: string[] = [];

type EventHandler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
type BusHandler = (value: unknown) => void;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;
type WidgetUpdate = { key: string; content: string[] | undefined; placement: string | undefined };

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

function makeContext(
	updates: WidgetUpdate[],
	sessionFile: string,
	branch: readonly unknown[] = [],
	notifications: string[] = [],
): ExtensionContext {
	return {
		ui: {
			setWidget(key: string, content: string[] | undefined, options?: { placement?: string }): void {
				updates.push({ key, content, placement: options?.placement });
			},
			notify(message: string): void {
				notifications.push(message);
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
	const updates: WidgetUpdate[] = [];
	const eventHandlers = new Map<string, EventHandler[]>();
	const bus = new FakeEventBus();
	const notifications: string[] = [];
	const commands = new Map<string, CommandHandler>();
	const context = makeContext(updates, sessionFile, branch, notifications);
	const api = {
		on(event: string, handler: EventHandler): void {
			const handlers = eventHandlers.get(event) ?? [];
			handlers.push(handler);
			eventHandlers.set(event, handlers);
		},
		events: bus,
		registerCommand(_name: string, options: { handler: CommandHandler }): void {
			commands.set(_name, options.handler);
		},
	} as unknown as ExtensionAPI;
	plugin(api);

	return {
		bus,
		context,
		updates,
		notifications,
		async emit(event: string, value: unknown, target: ExtensionContext = context): Promise<void> {
			await Promise.all((eventHandlers.get(event) ?? []).map(handler => handler(value, target)));
		},
		async runCommand(name: string, args = ""): Promise<void> {
			const handler = commands.get(name);
			if (!handler) throw new Error(`Command not registered: ${name}`);
			await handler(args, context);
		},
	};
}

function latestWidget(updates: readonly WidgetUpdate[]): WidgetUpdate | undefined {
	return updates.at(-1);
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
		expect(latestWidget(harness.updates)).toEqual({
			key: WIDGET_KEY,
			content: ["$2.25 (async)"],
			placement: "aboveEditor",
		});

		harness.bus.emit(PROGRESS_CHANNEL, { id: "detached-root", sessionFile, cost: 1.5 });
		expect(latestWidget(harness.updates)).toEqual({
			key: WIDGET_KEY,
			content: ["$1.50 (async)"],
			placement: "aboveEditor",
		});
	});

	it("hydrates historical async cost without custom plugin entries", async () => {
		const root = await fixtureRoot();
		await writeAsyncTranscript(path.join(root.slice(0, -6), "historical.jsonl"), 4.75);
		const harness = createHarness(root);

		await harness.emit("session_start", {});

		expect(latestWidget(harness.updates)).toEqual({
			key: WIDGET_KEY,
			content: ["$4.75 (async)"],
			placement: "aboveEditor",
		});
	});

	it("toggles the widget while continuing to track cost", async () => {
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
		harness.bus.emit(PROGRESS_CHANNEL, { id: "detached-root", sessionFile, cost: 2 });

		await harness.runCommand(COMMAND_NAME);
		expect(latestWidget(harness.updates)?.content).toBeUndefined();
		harness.bus.emit(PROGRESS_CHANNEL, { id: "detached-root", sessionFile, cost: 3.5 });
		expect(latestWidget(harness.updates)?.content).toBeUndefined();

		await harness.runCommand(COMMAND_NAME);
		expect(latestWidget(harness.updates)).toEqual({
			key: WIDGET_KEY,
			content: ["$3.50 (async)"],
			placement: "aboveEditor",
		});
		expect(harness.notifications).toEqual(["Async subagent cost hidden.", "Async subagent cost shown."]);
	});

	it("relays nested subagent progress to the owning root widget", async () => {
		const root = await fixtureRoot();
		const asyncRoot = path.join(root.slice(0, -6), "async-root.jsonl");
		await writeAsyncTranscript(asyncRoot, 1);
		const rootHarness = createHarness(root);
		const childHarness = createHarness(asyncRoot);
		await rootHarness.emit("session_start", {});
		await childHarness.emit("session_start", {});

		const nestedFile = path.join(asyncRoot.slice(0, -6), "nested.jsonl");
		childHarness.bus.emit(LIFECYCLE_CHANNEL, {
			id: "nested",
			status: "started",
			detached: false,
			sessionFile: nestedFile,
		});
		childHarness.bus.emit(PROGRESS_CHANNEL, { id: "nested", sessionFile: nestedFile, cost: 2.5 });

		expect(latestWidget(rootHarness.updates)).toEqual({
			key: WIDGET_KEY,
			content: ["$3.50 (async)"],
			placement: "aboveEditor",
		});
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
		await harness.emit("session_switch", {}, makeContext(harness.updates, secondRoot));

		expect(latestWidget(harness.updates)).toEqual({
			key: WIDGET_KEY,
			content: undefined,
			placement: "aboveEditor",
		});
	});
});
