import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type HydratedCosts, hydrateUnreportedSubagentCosts } from "./src/hydrate";
import { hasOwn, nonEmptyString, recordOf, type RecordValue, validCost } from "./src/values";

const TASK_SUBAGENT_LIFECYCLE_CHANNEL = "task:subagent:lifecycle";
const TASK_SUBAGENT_PROGRESS_CHANNEL = "task:subagent:progress";
const WIDGET_KEY = "omp-subagent-costs";

type SubagentFrameChannel = typeof TASK_SUBAGENT_LIFECYCLE_CHANNEL | typeof TASK_SUBAGENT_PROGRESS_CHANNEL;
type SubagentFrameRelay = (channel: SubagentFrameChannel, value: unknown) => void;

// OMP gives each nested session its own extension EventBus. Extension factories
// are rebound from one module instance, so relay nested frames to the root
// plugin instance without persisting a second source of truth.
const SUBAGENT_FRAME_RELAYS = new Set<SubagentFrameRelay>();

function relaySubagentFrame(source: SubagentFrameRelay, channel: SubagentFrameChannel, value: unknown): void {
	for (const relay of SUBAGENT_FRAME_RELAYS) {
		if (relay !== source) relay(channel, value);
	}
}

type SubagentLifecycleStatus = "started" | "completed" | "failed" | "aborted";

interface SubagentLifecycleFrame {
	id: string;
	status: SubagentLifecycleStatus;
	sessionFile?: string | null;
	detached?: boolean;
	restoredCost?: number;
}

interface SubagentProgressFrame {
	id: string;
	sessionFile?: string | null;
	cost: number;
}

interface LiveRun {
	id: string;
	sessionFile?: string;
	detachedRoot: boolean;
	included: boolean;
	baseline: number;
	snapshotCost: number;
	progressCost: number;
	terminal: boolean;
}


const EMPTY_HYDRATED_COSTS: HydratedCosts = {
	total: 0,
	costBySessionFile: new Map(),
	includedRoots: new Set(),
};


function lifecycleStatus(value: unknown): value is SubagentLifecycleStatus {
	return value === "started" || value === "completed" || value === "failed" || value === "aborted";
}

function unwrapFrame(value: unknown, type: string): RecordValue | undefined {
	const outer = recordOf(value);
	if (!outer) return undefined;
	return outer.type === type ? recordOf(outer.payload) : outer;
}

function optionalSessionFile(record: RecordValue): string | null | undefined | false {
	if (!hasOwn(record, "sessionFile") || record.sessionFile === undefined) return undefined;
	if (record.sessionFile === null) return null;
	return nonEmptyString(record.sessionFile) ? record.sessionFile : false;
}

function parseLifecycleFrame(value: unknown): SubagentLifecycleFrame | undefined {
	const record = unwrapFrame(value, "subagent_lifecycle");
	if (!record || !nonEmptyString(record.id) || !lifecycleStatus(record.status)) return undefined;
	const sessionFile = optionalSessionFile(record);
	if (sessionFile === false) return undefined;
	if (record.detached !== undefined && typeof record.detached !== "boolean") return undefined;
	if (record.restoredCost !== undefined && (!validCost(record.restoredCost) || record.status !== "started")) return undefined;

	return {
		id: record.id,
		status: record.status,
		...(sessionFile !== undefined ? { sessionFile } : {}),
		...(record.detached !== undefined ? { detached: record.detached } : {}),
		...(record.restoredCost !== undefined ? { restoredCost: record.restoredCost } : {}),
	};
}

function parseProgressFrame(value: unknown): SubagentProgressFrame | undefined {
	const record = unwrapFrame(value, "subagent_progress");
	if (!record) return undefined;
	const progress = hasOwn(record, "progress") ? recordOf(record.progress) : undefined;
	if (hasOwn(record, "progress") && !progress) return undefined;

	const directId = record.id;
	const nestedId = progress?.id;
	if (directId !== undefined && !nonEmptyString(directId)) return undefined;
	if (nestedId !== undefined && !nonEmptyString(nestedId)) return undefined;
	if (directId !== undefined && nestedId !== undefined && directId !== nestedId) return undefined;
	const id = directId ?? nestedId;
	if (!nonEmptyString(id)) return undefined;

	const directCost = record.cost;
	const nestedCost = progress?.cost;
	if (directCost !== undefined && !validCost(directCost)) return undefined;
	if (nestedCost !== undefined && !validCost(nestedCost)) return undefined;
	if (directCost !== undefined && nestedCost !== undefined && directCost !== nestedCost) return undefined;
	const cost = nestedCost ?? directCost;
	if (!validCost(cost)) return undefined;

	const sessionFile = optionalSessionFile(record);
	if (sessionFile === false) return undefined;
	return { id, cost, ...(sessionFile !== undefined ? { sessionFile } : {}) };
}

function comparablePath(file: string): string {
	return path.resolve(file);
}

function belongsToRoot(file: string, root: string): boolean {
	const candidate = comparablePath(file);
	const detachedRoot = comparablePath(root);
	return candidate === detachedRoot || candidate.startsWith(`${detachedRoot.slice(0, -".jsonl".length)}${path.sep}`);
}

function runKey(id: string, sessionFile?: string | null): string {
	return sessionFile ? comparablePath(sessionFile) : id;
}

export default function (pi: ExtensionAPI): void {
	let activeContext: ExtensionContext | undefined;
	let hydrated = EMPTY_HYDRATED_COSTS;
	let refreshGeneration = 0;
	let visible = true;
	const liveRuns = new Map<string, LiveRun>();
	const liveDetachedRoots = new Set<string>();

	const includedByRoot = (sessionFile: string | undefined): boolean => {
		if (!sessionFile) return false;
		for (const root of hydrated.includedRoots) {
			if (belongsToRoot(sessionFile, root)) return true;
		}
		for (const root of liveDetachedRoots) {
			if (belongsToRoot(sessionFile, root)) return true;
		}
		return false;
	};

	const total = (): number => {
		let value = hydrated.total;
		for (const run of liveRuns.values()) {
			if (!run.included) continue;
			value += Math.max(0, run.baseline + run.progressCost - run.snapshotCost);
		}
		return value;
	};

	const repaint = (ctx: ExtensionContext | undefined = activeContext): void => {
		if (!ctx || !ctx.hasUI || ctx.mode !== "tui") return;
		try {
			const cost = total();
			const content = !visible || cost === 0 ? undefined : [`$${cost.toFixed(2)} (agents)`];
			ctx.ui.setWidget(WIDGET_KEY, content, { placement: "aboveEditor" });
		} catch {
			// UI teardown and malformed host contexts must not break event handling.
		}
	};

	const refresh = async (ctx: ExtensionContext): Promise<void> => {
		const generation = ++refreshGeneration;
		let next: HydratedCosts;
		try {
			const sessionFile = ctx.sessionManager.getSessionFile();
			const branch = ctx.sessionManager.getBranch();
			next = await hydrateUnreportedSubagentCosts(sessionFile, branch);
		} catch {
			return;
		}
		if (generation !== refreshGeneration || ctx !== activeContext) return;

		hydrated = next;
		for (const [key, run] of liveRuns) {
			run.snapshotCost = run.sessionFile ? (next.costBySessionFile.get(comparablePath(run.sessionFile)) ?? 0) : 0;
			run.included = run.detachedRoot || includedByRoot(run.sessionFile);
			if (!run.terminal) continue;
			liveRuns.delete(key);
			if (run.detachedRoot && run.sessionFile) liveDetachedRoots.delete(comparablePath(run.sessionFile));
		}
		repaint(ctx);
	};

	const reset = (ctx: ExtensionContext): Promise<void> => {
		activeContext = ctx;
		refreshGeneration += 1;
		hydrated = EMPTY_HYDRATED_COSTS;
		liveRuns.clear();
		liveDetachedRoots.clear();
		repaint(ctx);
		return refresh(ctx);
	};

	pi.registerCommand("subagent-costs", {
		description: "Show or hide unreported subagent cost",
		handler: async (_args, ctx) => {
			activeContext = ctx;
			visible = !visible;
			repaint(ctx);
			ctx.ui.notify(`Unreported subagent cost ${visible ? "shown" : "hidden"}.`, "info");
		},
	});

	const ownsRelayedFrame = (sessionFile: string | null | undefined): boolean => {
		if (!sessionFile || !activeContext) return false;
		try {
			const rootSessionFile = activeContext.sessionManager.getSessionFile();
			return rootSessionFile ? belongsToRoot(sessionFile, rootSessionFile) : false;
		} catch {
			return false;
		}
	};

	const handleLifecycle = (value: unknown, relayed: boolean): void => {
		try {
			const frame = parseLifecycleFrame(value);
			if (!frame || (relayed && !ownsRelayedFrame(frame.sessionFile))) return;
			const sessionFile = frame.sessionFile ?? undefined;
			const key = runKey(frame.id, sessionFile);
			if (frame.status === "started") {
				const normalizedFile = sessionFile ? comparablePath(sessionFile) : undefined;
				if (frame.detached === true && normalizedFile) liveDetachedRoots.add(normalizedFile);
				const snapshotCost = normalizedFile ? (hydrated.costBySessionFile.get(normalizedFile) ?? 0) : 0;
				const run: LiveRun = {
					id: frame.id,
					...(normalizedFile ? { sessionFile: normalizedFile } : {}),
					detachedRoot: frame.detached === true,
					included: frame.detached === true || includedByRoot(normalizedFile),
					baseline: frame.restoredCost ?? snapshotCost,
					snapshotCost,
					progressCost: 0,
					terminal: false,
				};
				liveRuns.set(key, run);
				for (const candidate of liveRuns.values()) {
					if (!candidate.included) candidate.included = includedByRoot(candidate.sessionFile);
				}
				repaint();
				return;
			}

			const run = liveRuns.get(key);
			if (run) run.terminal = true;
			if (activeContext) void refresh(activeContext);
		} catch {
			// Raw event channels are untrusted input; malformed frames are ignored.
		}
	};

	const handleProgress = (value: unknown, relayed: boolean): void => {
		try {
			const frame = parseProgressFrame(value);
			if (!frame || (relayed && !ownsRelayedFrame(frame.sessionFile))) return;
			const key = runKey(frame.id, frame.sessionFile);
			const run = liveRuns.get(key);
			if (!run) {
				if (activeContext) void refresh(activeContext);
				return;
			}
			run.progressCost = frame.cost;
			repaint();
		} catch {
			// Raw event channels are untrusted input; malformed frames are ignored.
		}
	};

	const frameRelay: SubagentFrameRelay = (channel, value) => {
		if (channel === TASK_SUBAGENT_LIFECYCLE_CHANNEL) handleLifecycle(value, true);
		else handleProgress(value, true);
	};
	SUBAGENT_FRAME_RELAYS.add(frameRelay);

	pi.on("session_start", (_value, ctx) => reset(ctx));
	pi.on("session_switch", (_value, ctx) => reset(ctx));
	pi.on("session_branch", (_value, ctx) => reset(ctx));
	pi.on("session_tree", (_value, ctx) => reset(ctx));
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === "eval") await refresh(ctx);
	});
	pi.on("session_shutdown", (_value, ctx) => {
		SUBAGENT_FRAME_RELAYS.delete(frameRelay);
		refreshGeneration += 1;
		hydrated = EMPTY_HYDRATED_COSTS;
		liveRuns.clear();
		liveDetachedRoots.clear();
		repaint(ctx);
		activeContext = undefined;
	});

	pi.events.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, value => {
		handleLifecycle(value, false);
		relaySubagentFrame(frameRelay, TASK_SUBAGENT_LIFECYCLE_CHANNEL, value);
	});
	pi.events.on(TASK_SUBAGENT_PROGRESS_CHANNEL, value => {
		handleProgress(value, false);
		relaySubagentFrame(frameRelay, TASK_SUBAGENT_PROGRESS_CHANNEL, value);
	});
}
