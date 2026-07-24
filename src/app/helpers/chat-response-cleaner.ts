/**
 * Sanitizes raw Firebase data before it's sent to Gemini/Groq as a tool
 * result. Two jobs: strip noise that wastes tokens and confuses the
 * model (push IDs, internal fields), and round numbers to a sane
 * display precision. Pure functions only no Firebase, no network,
 * fully unit-testable in isolation.
 */


export function stripPushIds<T>(record: Record<string, T>): T[] {
    return Object.values(record);
}


export function roundReading(value: number | null | undefined, decimals = 1): number | null {
    if (value === null || value === undefined || !Number.isFinite(value)) return null;
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}


export function omitKeys<T extends Record<string, unknown>>(
    obj: T,
    keysToOmit: readonly (keyof T)[],
): Partial<T> {
    const result: Partial<T> = { ...obj };
    for (const key of keysToOmit) {
        delete result[key];
    }
    return result;
}


export function roundAllNumbers<T>(value: T, decimals = 1): T {
    if (typeof value === 'number') {
        return roundReading(value, decimals) as T;
    }
    if (Array.isArray(value)) {
        return value.map((item) => roundAllNumbers(item, decimals)) as T;
    }
    if (value !== null && typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
            result[key] = roundAllNumbers(val, decimals);
        }
        return result as T;
    }
    return value;
}

export function cleanTimestamp(isoString: string | null | undefined): string | null {
    if (!isoString) return null;
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}