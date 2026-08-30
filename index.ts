import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { SubagentCostLedger } from "./src/ledger";
import type {
	SubagentCostSnapshot,
	SubagentLifecycleFrame,
	SubagentLifecycleStatus,
	SubagentProgressFrame,
} from "./src/ledger";

const TASK_SUBAGENT_LIFECYCLE_CHANNEL = "task:subagent:lifecycle";
const TASK_SUBAGENT_PROGRESS_CHANNEL = "task:subagent:progress";
const CUSTOM_ENTRY_TYPE = "omp-subagent-costs";
const STATUS_KEY = "omp-subagent-costs";

const LIFECYCLE_STATUSES: Record<string, true> = {
	started: true,
	completed: true,
	failed: true,
	aborted: true,
};
const SNAPSHOT_RUN_KEYS: Record<string, true> = {
	key: true,
	id: true,
	sessionFile: true,
	total: true,
	detachedRoot: true,
	included: true,
};

interface RecordValue {
	[key: string]: unknown;
}

interface SessionFileValue {
	valid: boolean;
	value?: string | null;
}

function isRecord(value: unknown): value is RecordValue {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
}

function hasOwn(record: RecordValue, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function validCost(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function lifecycleStatus(value: unknown): value is SubagentLifecycleStatus {
	return typeof value === "string" && LIFECYCLE_STATUSES[value] === true;
}

function readSessionFile(record: RecordValue): SessionFileValue {
	if (!hasOwn(record, "sessionFile")) return { valid: true };
	const value = record.sessionFile;
	if (value === undefined) return { valid: true };
	if (value === null) return { valid: true, value: null };
	return nonEmptyString(value) ? { valid: true, value } : { valid: false };
}

function unwrapFrame(value: unknown, type: string): RecordValue | undefined {
	const outer = isRecord(value) ? value : undefined;
	if (!outer) return undefined;
	const payload = outer.payload;
	if (outer.type === type && isRecord(payload)) return payload;
	return outer;
}

function parseLifecycleFrame(value: unknown): SubagentLifecycleFrame | undefined {
	const record = unwrapFrame(value, "subagent_lifecycle");
	if (!record || !nonEmptyString(record.id) || !lifecycleStatus(record.status)) return undefined;

	const sessionFile = readSessionFile(record);
	if (!sessionFile.valid) return undefined;
	if (record.detached !== undefined && typeof record.detached !== "boolean") return undefined;

	const hasRestoredCost = hasOwn(record, "restoredCost");
	const restoredCostValue = record.restoredCost;
	let restoredCost: number | undefined;
	if (hasRestoredCost) {
		if (!validCost(restoredCostValue) || record.status !== "started") return undefined;
		restoredCost = restoredCostValue;
	}

	const frame: SubagentLifecycleFrame = { id: record.id, status: record.status };
	if (sessionFile.value !== undefined) frame.sessionFile = sessionFile.value;
	if (record.detached !== undefined) frame.detached = record.detached;
	if (restoredCost !== undefined) frame.restoredCost = restoredCost;
	return frame;
}

function parseProgressFrame(value: unknown): SubagentProgressFrame | undefined {
	const record = unwrapFrame(value, "subagent_progress");
	if (!record) return undefined;

	let progress: RecordValue | undefined;
	if (hasOwn(record, "progress")) {
		if (!isRecord(record.progress)) return undefined;
		progress = record.progress;
	}

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
	if (directCost === undefined && nestedCost === undefined) return undefined;
	if (directCost !== undefined && nestedCost !== undefined && directCost !== nestedCost) return undefined;
	const cost = nestedCost ?? directCost;
	if (!validCost(cost)) return undefined;

	const sessionFile = readSessionFile(record);
	if (!sessionFile.valid) return undefined;
	if (record.detached !== undefined && typeof record.detached !== "boolean") return undefined;

	const frame: SubagentProgressFrame = { id, cost };
	if (sessionFile.value !== undefined) frame.sessionFile = sessionFile.value;
	if (record.detached !== undefined) frame.detached = record.detached;
	return frame;
}

function isSnapshot(value: unknown): value is SubagentCostSnapshot {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.runs)) return false;

	const keys = new Set<string>();
	for (const candidate of value.runs) {
		if (!isRecord(candidate)) return false;
		for (const key of Object.keys(candidate)) {
			if (SNAPSHOT_RUN_KEYS[key] !== true) return false;
		}
		if (!nonEmptyString(candidate.key) || !nonEmptyString(candidate.id) || !validCost(candidate.total)) return false;
		if (typeof candidate.detachedRoot !== "boolean" || typeof candidate.included !== "boolean") return false;
		if (keys.has(candidate.key)) return false;

		let sessionFile: string | undefined;
		if (hasOwn(candidate, "sessionFile")) {
			if (!nonEmptyString(candidate.sessionFile)) return false;
			sessionFile = candidate.sessionFile;
		}
		if (candidate.key !== (sessionFile ?? candidate.id)) return false;
		keys.add(candidate.key);
	}
	return true;
}

function lastSnapshot(ctx: ExtensionContext): SubagentCostSnapshot | undefined {
	try {
		const branch = ctx.sessionManager.getBranch();
		if (!Array.isArray(branch)) return undefined;
		for (let index = branch.length - 1; index >= 0; index -= 1) {
			const entry = branch[index];
			if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) continue;
			if (hasOwn(entry, "data") && isSnapshot(entry.data)) return entry.data;
		}
	} catch {
		// A malformed or unavailable branch must not prevent the extension from loading.
	}
	return undefined;
}

export default function (pi: ExtensionAPI): void {
	let activeContext: ExtensionContext | undefined;
	let ledger = new SubagentCostLedger();
	const terminalPersisted = new Set<string>();

	const repaint = (ctx: ExtensionContext | undefined = activeContext): void => {
		if (!ctx || !ctx.hasUI || ctx.mode !== "tui") return;
		try {
			const total = ledger.total();
			ctx.ui.setStatus(STATUS_KEY, total === 0 ? undefined : `Async subagents: $${total.toFixed(2)}`);
		} catch {
			// UI teardown and malformed host contexts must not break event handling.
		}
	};

	const persist = (ctx: ExtensionContext | undefined = activeContext): boolean => {
		if (!ctx) return false;
		try {
			pi.appendEntry(CUSTOM_ENTRY_TYPE, ledger.snapshot());
			return true;
		} catch {
			return false;
		}
	};

	const restore = (ctx: ExtensionContext): void => {
		activeContext = ctx;
		try {
			const snapshot = lastSnapshot(ctx);
			ledger = new SubagentCostLedger(snapshot);
			terminalPersisted.clear();
		} catch {
			ledger = new SubagentCostLedger();
			terminalPersisted.clear();
		}
		repaint(ctx);
	};

	const preserve = (ctx: ExtensionContext): void => {
		activeContext = ctx;
		persist(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		restore(ctx);
	});
	pi.on("session_before_switch", (_event, ctx) => {
		preserve(ctx);
	});
	pi.on("session_switch", (_event, ctx) => {
		restore(ctx);
	});
	pi.on("session_before_branch", (_event, ctx) => {
		preserve(ctx);
	});
	pi.on("session_branch", (_event, ctx) => {
		restore(ctx);
	});
	pi.on("session_before_tree", (_event, ctx) => {
		preserve(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		restore(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		preserve(ctx);
	});

	pi.events.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, value => {
		try {
			const frame = parseLifecycleFrame(value);
			if (!frame || !ledger.handleLifecycle(frame)) return;
			const key = frame.sessionFile ?? frame.id;
			if (!key) return;
			if (frame.status === "started") {
				terminalPersisted.delete(key);
			} else if (!terminalPersisted.has(key) && persist()) {
				terminalPersisted.add(key);
			}
			repaint();
		} catch {
			// Raw event channels are untrusted input; malformed frames are ignored.
		}
	});

	pi.events.on(TASK_SUBAGENT_PROGRESS_CHANNEL, value => {
		try {
			const frame = parseProgressFrame(value);
			if (frame && ledger.handleProgress(frame)) repaint();
		} catch {
			// Raw event channels are untrusted input; malformed frames are ignored.
		}
	});
}
