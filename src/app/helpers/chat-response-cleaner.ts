/**
 * Sanitizes raw Firebase data before it's sent to Gemini/Groq as a tool
 * result. Multiple jobs:
 * 1. Strip noise that wastes tokens and confuses the model (push IDs,
 *    internal fields, metadata)
 * 2. Round numbers to appropriate precision for context (temp vs energy)
 * 3. Remove PII and sensitive internal identifiers
 * 4. Limit data size to prevent token overflow
 *
 * Pure functions only — no Firebase, no network, fully unit-testable.
 */

/** Internal fields that should never be sent to LLM */
const INTERNAL_FIELDS = [
    'uid',
    'userId',
    'deviceId',
    'facilityId',
    'pushId',
    'internalId',
    'apiKey',
    'token',
    'secret',
    'password',
    'createdBy',
    'modifiedBy',
] as const;


const MAX_ARRAY_LENGTH = 50;


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

/**
 * Converts ISO timestamp to human-readable format for chatbot responses.
 * Returns null for invalid timestamps.
 */
export function cleanTimestamp(isoString: string | null | undefined): string | null {
    if (!isoString) return null;
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return null;

    const dateStr = date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });

    const timeStr = date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });

    return `${dateStr} at ${timeStr}`;
}

/**
 * Formats date keys into human-readable format for chatbot responses.
 */
export function formatDateLabel(label: string): string {

    if (/^\d{4}-\d{2}-\d{2}$/.test(label)) {
        const date = new Date(label + 'T00:00:00');
        return date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    }


    if (/^\d{4}-\d{2}$/.test(label)) {
        const [year, month] = label.split('-');
        const date = new Date(parseInt(year), parseInt(month) - 1);
        return date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long'
        });
    }


    if (label.startsWith('Week of ')) {
        const dateStr = label.replace('Week of ', '');
        const date = new Date(dateStr + 'T00:00:00');
        return `Week of ${date.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        })}`;
    }


    return label;
}

/**
 * Removes internal fields and PII from an object before sending to LLM.
 * Prevents leaking sensitive identifiers and reduces token usage.
 */
export function sanitizeObject<T extends Record<string, unknown>>(obj: T): Partial<T> {
    const result: Partial<T> = {};

    for (const [key, value] of Object.entries(obj)) {
        if (INTERNAL_FIELDS.some(field => key.toLowerCase().includes(field.toLowerCase()))) {
            continue;
        }
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            result[key as keyof T] = sanitizeObject(value as Record<string, unknown>) as T[keyof T];
        } else if (Array.isArray(value)) {
            result[key as keyof T] = sanitizeArray(value) as T[keyof T];
        } else {
            result[key as keyof T] = value as T[keyof T];
        }
    }

    return result;
}

/**
 * Limits array length and sanitizes each item to prevent token overflow.
 */
export function sanitizeArray<T>(arr: T[]): T[] {
    const limited = arr.slice(0, MAX_ARRAY_LENGTH);
    return limited.map(item => {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
            return sanitizeObject(item as Record<string, unknown>) as T;
        }
        return item;
    });
}

/**
 * Comprehensive data cleaning pipeline: round numbers, remove PII,
 * sanitize objects, limit array sizes. Use this as the final step
 * before returning data from any tool executor.
 */
export function cleanToolData<T>(value: T, decimals = 1): T {
    const rounded = roundAllNumbers(value, decimals);

    if (rounded !== null && typeof rounded === 'object') {
        if (Array.isArray(rounded)) {
            return sanitizeArray(rounded) as T;
        }
        return sanitizeObject(rounded as Record<string, unknown>) as T;
    }

    return rounded;
}

/**
 * Context-aware number rounding for different data types:
 * - Temperature: 1 decimal (e.g., 31.5°C)
 * - Humidity: 0 decimals (e.g., 75%)
 * - Energy: 2 decimals (e.g., 12.34 kWh)
 * - Generic: 1 decimal (fallback)
 */
export function roundByContext(value: number | null | undefined, context: 'temperature' | 'humidity' | 'energy' | 'generic' = 'generic'): number | null {
    if (value === null || value === undefined || !Number.isFinite(value)) return null;

    const decimals = {
        temperature: 1,
        humidity: 0,
        energy: 2,
        generic: 1,
    }[context];

    return roundReading(value, decimals);
}