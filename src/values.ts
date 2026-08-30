export interface RecordValue {
	[key: string]: unknown;
}

/** Parse an untrusted object at the plugin boundary. */
export function recordOf(value: unknown): RecordValue | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null ? (value as RecordValue) : undefined;
	} catch {
		return undefined;
	}
}

export function hasOwn(record: RecordValue, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

export function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function validCost(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
