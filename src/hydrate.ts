import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { nonEmptyString, recordOf, validCost } from "./values";

export interface HydratedCosts {
	total: number;
	costBySessionFile: ReadonlyMap<string, number>;
	asyncRoots: ReadonlySet<string>;
}

function sessionEntryOf(value: unknown): SessionEntry | undefined {
	const record = recordOf(value);
	if (!record || !nonEmptyString(record.id) || (record.parentId !== null && !nonEmptyString(record.parentId))) {
		return undefined;
	}
	return value as SessionEntry;
}

function activeBranch(values: readonly unknown[]): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (const value of values) {
		const entry = sessionEntryOf(value);
		if (entry) entries.push(entry);
	}
	const leaf = entries.at(-1);
	if (!leaf) return [];

	const byId = new Map(entries.map(entry => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const visited = new Set<string>();
	let current: SessionEntry | undefined = leaf;
	while (current && !visited.has(current.id)) {
		branch.push(current);
		visited.add(current.id);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	branch.reverse();
	return branch;
}

async function listTranscriptFiles(directory: string): Promise<string[]> {
	let entries;
	try {
		entries = await fs.readdir(directory, { withFileTypes: true });
	} catch {
		return [];
	}

	const files: string[] = [];
	for (const entry of entries) {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await listTranscriptFiles(file)));
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path.resolve(file));
	}
	return files;
}

function asyncChildren(parentSessionFile: string, branch: readonly SessionEntry[]): string[] {
	const files = new Set<string>();
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "task") continue;
		const details = recordOf(entry.message.details);
		const asyncDetails = recordOf(details?.async);
		if (!details || asyncDetails?.type !== "task" || !Array.isArray(details.progress)) continue;

		const synchronousIds = new Set<string>();
		if (Array.isArray(details.results)) {
			for (const resultValue of details.results) {
				const result = recordOf(resultValue);
				if (nonEmptyString(result?.id)) synchronousIds.add(result.id);
			}
		}
		for (const progressValue of details.progress) {
			const progress = recordOf(progressValue);
			if (!nonEmptyString(progress?.id) || synchronousIds.has(progress.id)) continue;
			files.add(path.resolve(parentSessionFile.slice(0, -".jsonl".length), `${progress.id}.jsonl`));
		}
	}
	return [...files];
}

function assistantCost(branch: readonly SessionEntry[]): number {
	let total = 0;
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const cost = entry.message.usage?.cost?.total;
		if (validCost(cost)) total += cost;
	}
	return total;
}

function isAtOrBelow(file: string, root: string): boolean {
	return file === root || file.startsWith(`${root.slice(0, -".jsonl".length)}${path.sep}`);
}

/** Reconstruct async-only spend from the canonical active transcript tree. */
export async function hydrateAsyncSubagentCosts(
	rootSessionFile: string | null | undefined,
	rootBranchValues: readonly unknown[],
): Promise<HydratedCosts> {
	if (!rootSessionFile) return { total: 0, costBySessionFile: new Map(), asyncRoots: new Set() };

	const normalizedRoot = path.resolve(rootSessionFile);
	const childFiles = await listTranscriptFiles(normalizedRoot.slice(0, -".jsonl".length));
	const branches = new Map<string, SessionEntry[]>();
	for (const file of childFiles) {
		try {
			branches.set(file, activeBranch(await loadEntriesFromFile(file)));
		} catch {
			// A partial or unrelated JSONL artifact is not a usable subagent transcript.
		}
	}

	const rootBranch = activeBranch(rootBranchValues);
	const asyncRoots = new Set(asyncChildren(normalizedRoot, rootBranch));
	for (const [file, branch] of branches) {
		if (branch.some(entry => entry.type === "session_init" && recordOf(entry)?.detached === true)) asyncRoots.add(file);
		for (const child of asyncChildren(file, branch)) asyncRoots.add(child);
	}

	const costBySessionFile = new Map<string, number>();
	let total = 0;
	for (const [file, branch] of branches) {
		let included = false;
		for (const root of asyncRoots) {
			if (isAtOrBelow(file, root)) {
				included = true;
				break;
			}
		}
		if (!included) continue;
		const cost = assistantCost(branch);
		costBySessionFile.set(file, cost);
		total += cost;
	}

	return { total, costBySessionFile, asyncRoots };
}
