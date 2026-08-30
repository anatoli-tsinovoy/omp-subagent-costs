/**
 * A small, dependency-free cost ledger for subagent lifecycle/progress frames.
 *
 * Progress is reported as a cumulative snapshot for one run, rather than as a
 * delta. A lifecycle `started` frame begins a fresh delta and carries forward
 * the total already known for that key. Detached transcript roots make nested
 * blocking runs eligible without making unrelated synchronous runs eligible.
 */

export type SubagentLifecycleStatus = "started" | "completed" | "failed" | "aborted";

/** A lifecycle frame, or the payload of a `subagent_lifecycle` event. */
export interface SubagentLifecycleFrame {
	id?: string;
	status?: SubagentLifecycleStatus;
	sessionFile?: string | null;
	detached?: boolean;
	restoredCost?: number;
	agent?: string;
	agentSource?: string;
	description?: string;
	parentToolCallId?: string;
	index?: number;
	type?: string;
	payload?: SubagentLifecycleFrame;
	[key: string]: unknown;
}

/** Cumulative progress data carried by a progress frame. */
export interface SubagentProgress {
	id?: string;
	cost?: number;
	[key: string]: unknown;
}

/** A progress frame, or the payload of a `subagent_progress` event. */
export interface SubagentProgressFrame {
	id?: string;
	sessionFile?: string | null;
	detached?: boolean;
	progress?: SubagentProgress;
	/** Also accepted for small callers that provide the cost directly. */
	cost?: number;
	agent?: string;
	agentSource?: string;
	task?: string;
	assignment?: string;
	parentToolCallId?: string;
	index?: number;
	type?: string;
	payload?: SubagentProgressFrame;
	[key: string]: unknown;
}

/** JSON-safe persisted ledger state. */
export interface SubagentCostSnapshot {
	version: 1;
	runs: Array<{
		key: string;
		id: string;
		sessionFile?: string;
		total: number;
		detachedRoot: boolean;
		included: boolean;
	}>;
}

interface RunState {
	key: string;
	id: string;
	sessionFile?: string;
	/** Total finalized before the current lifecycle delta. */
	baseline: number;
	/** Latest cumulative progress snapshot for the current lifecycle delta. */
	progress: number;
	/** `baseline + progress`; retained separately for stable persisted state. */
	total: number;
	detachedRoot: boolean;
	included: boolean;
}

type PlainRecord = Record<string, unknown>;

const LIFECYCLE_STATUSES: ReadonlySet<string> = new Set([
	"started",
	"completed",
	"failed",
	"aborted",
]);
const SNAPSHOT_KEYS: ReadonlySet<string> = new Set([
	"version",
	"runs",
]);
const RUN_KEYS: ReadonlySet<string> = new Set([
	"key",
	"id",
	"sessionFile",
	"total",
	"detachedRoot",
	"included",
]);

function recordOf(value: unknown): PlainRecord | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
	} catch {
		return undefined;
	}
	return value as PlainRecord;
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function validCost(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function hasOwn(record: PlainRecord, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Normalize paths only for comparisons. The original path is retained in the
 * public snapshot so replay does not rewrite caller data.
 */
function comparablePath(file: string): string {
	// `path.resolve` is deliberately avoided: the plugin is also usable in
	// runtimes without Node's path module. Transcript paths emitted by OMP are
	// absolute; this normalization still gives correct boundary checks there.
	const slashified = file.replace(/\\/g, "/");
	const normalized = slashified.replace(/\/+/g, "/");
	if (normalized.length > 1 && normalized.endsWith("/")) return normalized.slice(0, -1);
	return normalized;
}

function belongsToDetachedRoot(file: string, root: string): boolean {
	const comparableFile = comparablePath(file);
	const comparableRoot = comparablePath(root);
	if (comparableFile === comparableRoot) return true;
	const artifactRoot = comparableRoot.endsWith(".jsonl")
		? comparableRoot.slice(0, -".jsonl".length)
		: comparableRoot;
	return comparableFile.startsWith(`${artifactRoot}/`);
}

function unknownKeys(record: PlainRecord, allowed: ReadonlySet<string>): boolean {
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) return true;
	}
	return false;
}

function optionalSessionFile(record: PlainRecord): string | undefined | null {
	if (!hasOwn(record, "sessionFile")) return undefined;
	const value = record.sessionFile;
	if (value === null || value === undefined) return null;
	return nonEmptyString(value) ? value : undefined;
}

function unwrapFrame(value: unknown, type: "subagent_lifecycle" | "subagent_progress"): PlainRecord | undefined {
	const outer = recordOf(value);
	if (!outer) return undefined;
	const payload = recordOf(outer.payload);
	if (outer.type === type && payload) return payload;
	return outer;
}

function snapshotRecord(value: unknown): SubagentCostSnapshot | undefined {
	const record = recordOf(value);
	if (!record || unknownKeys(record, SNAPSHOT_KEYS) || record.version !== 1 || !Array.isArray(record.runs)) {
		return undefined;
	}

	const runs: SubagentCostSnapshot["runs"] = [];
	const keys = new Set<string>();
	for (const candidate of record.runs) {
		const run = recordOf(candidate);
		if (!run || unknownKeys(run, RUN_KEYS)) return undefined;
		if (
			!nonEmptyString(run.key) ||
			!nonEmptyString(run.id) ||
			!validCost(run.total) ||
			typeof run.detachedRoot !== "boolean" ||
			typeof run.included !== "boolean" ||
			keys.has(run.key)
		) {
			return undefined;
		}
		let sessionFile: string | undefined;
		if (hasOwn(run, "sessionFile")) {
			if (!nonEmptyString(run.sessionFile)) return undefined;
			sessionFile = run.sessionFile;
		}
		if (run.key !== (sessionFile ?? run.id)) return undefined;
		keys.add(run.key);
		runs.push({
			key: run.key,
			id: run.id,
			...(sessionFile === undefined ? {} : { sessionFile }),
			total: run.total,
			detachedRoot: run.detachedRoot,
			included: run.included,
		});
	}
	return { version: 1, runs };
}

export class SubagentCostLedger {
	#runs = new Map<string, RunState>();
	#detachedRoots = new Set<string>();

	constructor(snapshot?: unknown) {
		if (snapshot !== undefined) this.#restoreSnapshot(snapshot);
	}

	/**
	 * Accept a lifecycle frame. Returns false for malformed input; valid frames
	 * return true even when the run is synchronous and therefore excluded.
	 */
	handleLifecycle(frame: SubagentLifecycleFrame): boolean {
		const record = unwrapFrame(frame, "subagent_lifecycle");
		if (!record) return false;

		const id = record.id;
		const status = record.status;
		if (!nonEmptyString(id) || typeof status !== "string" || !LIFECYCLE_STATUSES.has(status)) return false;

		const sessionFileValue = optionalSessionFile(record);
		if (hasOwn(record, "sessionFile") && sessionFileValue === undefined) return false;
		const detached = record.detached;
		if (detached !== undefined && typeof detached !== "boolean") return false;
		const hasRestoredCost = hasOwn(record, "restoredCost");
		const restoredCost = record.restoredCost;
		if (hasRestoredCost && !validCost(restoredCost)) return false;
		if (status !== "started" && hasRestoredCost) return false;

		const sessionFile = sessionFileValue === null || sessionFileValue === undefined ? undefined : sessionFileValue;
		const key = sessionFile ?? id;
		if (detached === true && sessionFile !== undefined) this.#addDetachedRoot(sessionFile);

		const existing = this.#runs.get(key);
		const underDetachedRoot = sessionFile !== undefined && this.#isUnderDetachedRoot(sessionFile);
		if (status === "started") {
			if (existing) {
				// The previous total is the baseline for this new lifecycle delta.
				existing.baseline = existing.total;
				existing.progress = 0;
				existing.total = existing.baseline;
				existing.detachedRoot = existing.detachedRoot || detached === true;
				existing.included = existing.included || underDetachedRoot || detached === true;
				this.#updateMetadata(existing, id, sessionFile);
			} else {
				const baseline = hasRestoredCost ? (restoredCost as number) : 0;
				this.#runs.set(key, {
					key,
					id,
					...(sessionFile === undefined ? {} : { sessionFile }),
					baseline,
					progress: 0,
					total: baseline,
					detachedRoot: detached === true,
					included: detached === true || underDetachedRoot,
				});
			}
		} else if (existing) {
			// Terminal lifecycle frames carry no usage and never alter totals.
			existing.detachedRoot = existing.detachedRoot || detached === true;
			existing.included = existing.included || underDetachedRoot || detached === true;
			this.#updateMetadata(existing, id, sessionFile);
		} else {
			// Keep a valid terminal row for deterministic replay; its total is zero.
			this.#runs.set(key, {
				key,
				id,
				...(sessionFile === undefined ? {} : { sessionFile }),
				baseline: 0,
				progress: 0,
				total: 0,
				detachedRoot: detached === true,
				included: detached === true || underDetachedRoot,
			});
		}
		return true;
	}

	/**
	 * Accept one cumulative progress snapshot. A valid snapshot replaces the
	 * current delta; it is never added to the previous progress snapshot.
	 */
	handleProgress(frame: SubagentProgressFrame): boolean {
		const record = unwrapFrame(frame, "subagent_progress");
		if (!record) return false;

		const progress = recordOf(record.progress);
		if (hasOwn(record, "progress") && !progress) return false;
		const directId = record.id;
		const nestedId = progress?.id;
		if (directId !== undefined && !nonEmptyString(directId)) return false;
		if (nestedId !== undefined && !nonEmptyString(nestedId)) return false;
		if (directId !== undefined && nestedId !== undefined && directId !== nestedId) return false;
		const id = (directId ?? nestedId) as string | undefined;
		if (!id) return false;

		const directCost = record.cost;
		const nestedCost = progress?.cost;
		if (directCost !== undefined && !validCost(directCost)) return false;
		if (nestedCost !== undefined && !validCost(nestedCost)) return false;
		if (directCost === undefined && nestedCost === undefined) return false;
		if (directCost !== undefined && nestedCost !== undefined && directCost !== nestedCost) return false;
		const cost = (nestedCost ?? directCost) as number;

		const sessionFileValue = optionalSessionFile(record);
		if (hasOwn(record, "sessionFile") && sessionFileValue === undefined) return false;
		const detached = record.detached;
		if (detached !== undefined && typeof detached !== "boolean") return false;
		const sessionFile = sessionFileValue === null || sessionFileValue === undefined ? undefined : sessionFileValue;
		const key = sessionFile ?? id;
		const existing = this.#runs.get(key);
		const total = existing ? existing.baseline + cost : cost;
		if (!Number.isFinite(total) || total < 0) return false;
		if (detached === true && sessionFile !== undefined) this.#addDetachedRoot(sessionFile);

		const underDetachedRoot = sessionFile !== undefined && this.#isUnderDetachedRoot(sessionFile);
		if (existing) {
			existing.progress = cost;
			existing.total = total;
			existing.detachedRoot = existing.detachedRoot || detached === true;
			existing.included = existing.included || underDetachedRoot || detached === true;
			this.#updateMetadata(existing, id, sessionFile);
		} else {
			this.#runs.set(key, {
				key,
				id,
				...(sessionFile === undefined ? {} : { sessionFile }),
				baseline: 0,
				progress: cost,
				total,
				detachedRoot: detached === true,
				included: detached === true || underDetachedRoot,
			});
		}
		return true;
	}

	/** Clear the ledger, or replace it with a valid persisted snapshot. */
	reset(snapshot?: unknown): void {
		if (snapshot === undefined) {
			this.#runs.clear();
			this.#detachedRoots.clear();
			return;
		}
		this.#restoreSnapshot(snapshot);
	}

	/** Return the included accumulated cost. */
	total(): number {
		let total = 0;
		for (const run of this.#runs.values()) {
			if (run.included) total += run.total;
		}
		return total;
	}

	/** Return a deterministic, JSON-safe copy of the ledger state. */
	snapshot(): SubagentCostSnapshot {
		const runs = [...this.#runs.values()]
			.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
			.map(run => ({
				key: run.key,
				id: run.id,
				...(run.sessionFile === undefined ? {} : { sessionFile: run.sessionFile }),
				total: run.total,
				detachedRoot: run.detachedRoot,
				included: run.included,
			}));
		return { version: 1, runs };
	}

	#restoreSnapshot(value: unknown): void {
		const parsed = snapshotRecord(value);
		if (!parsed) return;

		const runs = new Map<string, RunState>();
		const roots = new Set<string>();
		for (const run of parsed.runs) {
			runs.set(run.key, {
				key: run.key,
				id: run.id,
				...(run.sessionFile === undefined ? {} : { sessionFile: run.sessionFile }),
				baseline: run.total,
				progress: 0,
				total: run.total,
				detachedRoot: run.detachedRoot,
				included: run.included,
			});
			if (run.detachedRoot && run.sessionFile !== undefined) roots.add(comparablePath(run.sessionFile));
		}
		this.#runs = runs;
		this.#detachedRoots = roots;
	}

	#addDetachedRoot(sessionFile: string): void {
		const root = comparablePath(sessionFile);
		if (this.#detachedRoots.has(root)) return;
		this.#detachedRoots.add(root);
		for (const run of this.#runs.values()) {
			if (run.sessionFile !== undefined && belongsToDetachedRoot(run.sessionFile, root)) run.included = true;
		}
	}

	#isUnderDetachedRoot(sessionFile: string): boolean {
		for (const root of this.#detachedRoots) {
			if (belongsToDetachedRoot(sessionFile, root)) return true;
		}
		return false;
	}

	#updateMetadata(run: RunState, id: string, sessionFile: string | undefined): void {
		run.id = id;
		if (sessionFile !== undefined) run.sessionFile = sessionFile;
	}
}
