/**
 * Final safety layer for chatbot responses. Sanitizes generated answers
 * to remove any remaining unsafe or leaky content that passed through
 * validation. This is a belt-and-suspenders defense — validation should
 * catch most issues, but this ensures nothing slips through.
 *
 * Applied to final answer text before it's shown to the user.
 */

/** Patterns that should never appear in user-facing responses */
const UNSAFE_PATTERNS = [
    // Firebase paths
    { pattern: /\/devices\/[a-zA-Z0-9_-]+/gi, replacement: '[device]' },
    { pattern: /\/rooms\/[a-zA-Z0-9_-]+/gi, replacement: '[room]' },
    { pattern: /\/energy\/[a-zA-Z0-9_-]+/gi, replacement: '[energy data]' },
    { pattern: /\/users\/[a-zA-Z0-Z_-]+/gi, replacement: '[user]' },
    { pattern: /\/logs\/[a-zA-Z0-9_-]+/gi, replacement: '[log]' },
    
    // Device/push IDs that look like Firebase keys
    { pattern: /\b[a-zA-Z0-9_-]{20,}\b/g, replacement: '[id]' },
    
    // API keys or tokens (unlikely but catch if present)
    { pattern: /\b[A-Z0-9]{32,}\b/g, replacement: '[redacted]' },
    
    // Email addresses (PII)
    { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replacement: '[email]' },
    
    // Internal system references
    { pattern: /firebase/gi, replacement: 'the system' },
    { pattern: /realtime database/gi, replacement: 'the database' },
] as const;

/** Common errors that might leak through in generated text */
const ERROR_PATTERNS = [
    // Device IDs used as if they're room names
    { pattern: /\bESP[0-9]+\b/gi, replacement: 'the device' },
    
    // Technical jargon that users shouldn't see
    { pattern: /\bnull\b/gi, replacement: 'no data' },
    { pattern: /\bundefined\b/gi, replacement: 'not available' },
    { pattern: /\bNaN\b/gi, replacement: 'invalid value' },
] as const;

export interface SanitizationResult {
    readonly sanitized: string;
    readonly hadChanges: boolean;
    readonly changesLog: string[];
}

/**
 * Sanitizes a chatbot response to remove unsafe content, internal IDs,
 * and technical jargon. Returns the cleaned text and a log of changes.
 */
export function sanitizeResponse(text: string): SanitizationResult {
    let sanitized = text;
    const changesLog: string[] = [];

    for (const { pattern, replacement } of UNSAFE_PATTERNS) {
        const beforeLength = sanitized.length;
        sanitized = sanitized.replace(pattern, replacement);
        
        if (sanitized.length !== beforeLength) {
            changesLog.push(`Removed unsafe pattern: ${pattern.source}`);
        }
    }
    

    for (const { pattern, replacement } of ERROR_PATTERNS) {
        const beforeLength = sanitized.length;
        sanitized = sanitized.replace(pattern, replacement);
        
        if (sanitized.length !== beforeLength) {
            changesLog.push(`Replaced technical term: ${pattern.source}`);
        }
    }
    

    const beforeMarkdown = sanitized;
    sanitized = removeMarkdown(sanitized);
    if (sanitized !== beforeMarkdown) {
        changesLog.push('Removed markdown formatting');
    }
    

    sanitized = sanitized.replace(/\s+/g, ' ').trim();
    
    return {
        sanitized,
        hadChanges: changesLog.length > 0,
        changesLog,
    };
}

/**
 * Removes markdown formatting (bold, italic, code blocks, etc.) and
 * converts to plain text. The answerer prompt already instructs no
 * markdown, but this catches it if the model disobeys.
 */
function removeMarkdown(text: string): string {
    let cleaned = text;
    
    cleaned = cleaned.replace(/```[\s\S]*?```/g, '');
    cleaned = cleaned.replace(/`[^`]+`/g, '');
    cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');
    cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1');
    cleaned = cleaned.replace(/__([^_]+)__/g, '$1');
    cleaned = cleaned.replace(/_([^_]+)_/g, '$1');
    cleaned = cleaned.replace(/^#{1,6}\s+/gm, '');
    cleaned = cleaned.replace(/^\s*[-*+]\s+/gm, '');
    
    return cleaned;
}

/**
 * Quick check if a response contains potentially unsafe content that
 * should be sanitized. Used for logging/monitoring.
 */
export function containsUnsafeContent(text: string): boolean {

    if (/\/devices\/|\/rooms\/|\/energy\/|\/users\/|\/logs\//i.test(text)) {
        return true;
    }
    if (/\b[a-zA-Z0-9_-]{25,}\b/.test(text)) {
        return true;
    }
    if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}/.test(text)) {
        return true;
    }
    
    return false;
}
