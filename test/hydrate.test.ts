import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { hydrateUnreportedSubagentCosts } from "../src/hydrate";

const temporaryDirectories: string[] = [];
const timestamp = "2026-01-01T00:00:00.000Z";

async function fixtureRoot(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-subagent-costs-"));
	temporaryDirectories.push(directory);
	return path.join(directory, "root.jsonl");
}

function assistantEntry(id: string, parentId: string | null, cost: number) {
	return {
		type: "message",
		id,
		parentId,
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
	};
}

async function writeTranscript(file: string, entries: readonly unknown[], detached?: boolean): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const header = { type: "session", version: 3, id: path.basename(file, ".jsonl"), timestamp, cwd: "/tmp" };
	const init = {
		type: "session_init",
		id: "init",
		parentId: null,
		timestamp,
		systemPrompt: "test",
		task: "test",
		tools: [],
		...(detached !== undefined ? { detached } : {}),
	};
	await Bun.write(file, [header, init, ...entries].map(value => JSON.stringify(value)).join("\n"));
}

function asyncTaskEntry(id: string, parentId: string | null, asyncIds: readonly string[], syncIds: readonly string[] = []) {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "toolResult",
			toolCallId: `call-${id}`,
			toolName: "task",
			content: [{ type: "text", text: "running" }],
			details: {
				results: syncIds.map((resultId, index) => ({ id: resultId, index })),
				progress: [...syncIds, ...asyncIds].map(progressId => ({ id: progressId })),
				async: { state: "running", jobId: asyncIds[0], type: "task" },
			},
		},
	};
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("hydrateUnreportedSubagentCosts", () => {
	it("includes eval and async trees but excludes root synchronous task spend", async () => {
		const root = await fixtureRoot();
		const asyncFile = path.join(root.slice(0, -6), "async.jsonl");
		const blockingChild = path.join(asyncFile.slice(0, -6), "blocking.jsonl");
		const evalFile = path.join(root.slice(0, -6), "eval-agent.jsonl");
		const synchronousFile = path.join(root.slice(0, -6), "synchronous-task.jsonl");
		await writeTranscript(asyncFile, [assistantEntry("async-cost", "init", 2.5)], true);
		await writeTranscript(blockingChild, [assistantEntry("child-cost", "init", 1.25)], false);
		await writeTranscript(evalFile, [assistantEntry("eval-cost", "init", 9)], false);
		await writeTranscript(synchronousFile, [assistantEntry("sync-cost", "init", 8)], false);
		const rootBranch = [asyncTaskEntry("task-result", null, ["async"], ["synchronous-task"])];

		const hydrated = await hydrateUnreportedSubagentCosts(root, rootBranch);

		expect(hydrated.total).toBe(12.75);
		expect(hydrated.costBySessionFile.get(path.resolve(asyncFile))).toBe(2.5);
		expect(hydrated.costBySessionFile.get(path.resolve(blockingChild))).toBe(1.25);
		expect(hydrated.costBySessionFile.get(path.resolve(evalFile))).toBe(9);
		expect(hydrated.costBySessionFile.has(path.resolve(synchronousFile))).toBe(false);
	});

	it("discovers legacy async roots from task results without session-init metadata", async () => {
		const root = await fixtureRoot();
		const asyncFile = path.join(root.slice(0, -6), "legacy.jsonl");
		await writeTranscript(asyncFile, [assistantEntry("cost", "init", 4)]);
		const rootBranch = [asyncTaskEntry("task-result", null, ["legacy"])];

		const hydrated = await hydrateUnreportedSubagentCosts(root, rootBranch);

		expect(hydrated.total).toBe(4);
		expect(hydrated.includedRoots.has(path.resolve(asyncFile))).toBe(true);
	});

	it("finds an async tree spawned below a standalone synchronous root", async () => {
		const root = await fixtureRoot();
		const syncFile = path.join(root.slice(0, -6), "sync.jsonl");
		const asyncFile = path.join(syncFile.slice(0, -6), "nested-async.jsonl");
		await writeTranscript(syncFile, [asyncTaskEntry("spawn", "init", ["nested-async"]), assistantEntry("sync-cost", "spawn", 8)], false);
		await writeTranscript(asyncFile, [assistantEntry("async-cost", "init", 3)], false);

		const hydrated = await hydrateUnreportedSubagentCosts(root, [
			asyncTaskEntry("root-task", null, [], ["sync"]),
		]);

		expect(hydrated.total).toBe(3);
		expect(hydrated.costBySessionFile.has(path.resolve(syncFile))).toBe(false);
	});

	it("sums only the active child branch and never counts discovery twice", async () => {
		const root = await fixtureRoot();
		const asyncFile = path.join(root.slice(0, -6), "async.jsonl");
		await writeTranscript(
			asyncFile,
			[assistantEntry("abandoned", "init", 20), assistantEntry("active", "init", 2)],
			true,
		);

		const hydrated = await hydrateUnreportedSubagentCosts(root, [asyncTaskEntry("task-result", null, ["async"])]);

		expect(hydrated.total).toBe(2);
		expect(hydrated.costBySessionFile.size).toBe(1);
	});
});
