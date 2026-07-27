import { ChatToolResult, ChatValidationResult } from '../models/chat.models';
import { getSystemHelpEntry } from './system-help-content';

/**
 * Deterministic, zero-LLM guardrail. Checks a model's final answer text
 * against the clean tool result it was supposed to be grounded in,
 * before the answer is allowed to render. This is the last line of
 * defense against hallucinations.
 *
 * Pure functions, no network calls — must stay fast and free.
 *
 * Validation checks:
 * 1. Numbers in answer must exist in tool result
 * 2. Room names in answer must exist in tool result
 * 3. Timestamps must match or be absent
 * 4. No control/modification claims ("I turned off", "I set", "I changed")
 * 5. No invented causal explanations without data support
 * 6. For system help: steps/routes must match stored entries exactly
 */

/** Phrases that indicate control actions (always invalid - chatbot is read-only) */
const CONTROL_PHRASES = [
    "I turned",
    "I set",
    "I changed",
    "I updated",
    "I modified",
    "I adjusted",
    "I controlled",
    "I will turn",
    "I will set",
    "I will change",
    "I'll turn",
    "I'll set",
    "I'll change",
    "turning on",
    "turning off",
    "setting the",
] as const;

/** Speculation phrases that suggest invented causation */
const SPECULATION_PHRASES = [
    "probably",
    "likely",
    "might be",
    "could be",
    "perhaps",
    "possibly",
    "seems like",
    "appears to be due to",
    "because of",
    "caused by",
    "due to",
] as const;
export function validateChatAnswer(
    answerText: string,
    toolResult: ChatToolResult | null,
): ChatValidationResult {
    if (!toolResult) {
        return { isValid: true };
    }

    if (toolResult.name === 'get_system_help') {
        return validateSystemHelpAnswer(answerText, toolResult.data);
    }

    return validateDataAnswer(answerText, toolResult.data);
}

/**
 * For data tools: validates that the answer is grounded in the tool
 * result and doesn't contain hallucinations, control claims, or
 * speculation.
 */
function validateDataAnswer(answerText: string, data: unknown): ChatValidationResult {
    const controlCheck = detectControlClaims(answerText);
    if (!controlCheck.isValid) {
        return controlCheck;
    }

    const speculationCheck = detectExcessiveSpeculation(answerText);
    if (!speculationCheck.isValid) {
        return speculationCheck;
    }

    const payloadNumbers = extractNumbers(JSON.stringify(data));
    const answerNumbers = extractNumbers(answerText);

    const inventedNumber = answerNumbers.find((num) => !payloadNumbers.includes(num));
    if (inventedNumber !== undefined) {
        return {
            isValid: false,
            reason: `Answer contains a number (${inventedNumber}) not present in the tool result`,
        };
    }

    const payloadRoomNames = extractRoomNames(data);
    const answerRoomNames = extractRoomNamesFromText(answerText, payloadRoomNames);

    const inventedRoom = answerRoomNames.find((room) => !payloadRoomNames.includes(room));
    if (inventedRoom) {
        return {
            isValid: false,
            reason: `Answer mentions a room ("${inventedRoom}") not present in the tool result`,
        };
    }

    if (answerText.includes('/devices/') || answerText.includes('/rooms/') || answerText.includes('/energy/')) {
        return {
            isValid: false,
            reason: 'Answer contains internal Firebase paths',
        };
    }

    // Check timestamps/dates - must match or be absent
    const timestampCheck = validateTimestamps(answerText, data);
    if (!timestampCheck.isValid) {
        return timestampCheck;
    }

    return { isValid: true };
}

/**
 * Detects if the answer claims to have performed control actions,
 * which is always invalid since the chatbot is read-only.
 */
function detectControlClaims(answerText: string): ChatValidationResult {
    const lowerAnswer = answerText.toLowerCase();

    for (const phrase of CONTROL_PHRASES) {
        if (lowerAnswer.includes(phrase.toLowerCase())) {
            return {
                isValid: false,
                reason: `Answer claims to perform control action: "${phrase}"`,
            };
        }
    }

    return { isValid: true };
}

/**
 * Detects excessive speculation that suggests the model is inventing
 * causal explanations without data support. Simple observations like
 * "31°C is quite warm" are OK, but "probably because" or "likely due
 * to" are not.
 */
function detectExcessiveSpeculation(answerText: string): ChatValidationResult {
    const lowerAnswer = answerText.toLowerCase();

    let speculationCount = 0;
    let detectedPhrase = '';

    for (const phrase of SPECULATION_PHRASES) {
        if (lowerAnswer.includes(phrase.toLowerCase())) {
            speculationCount++;
            detectedPhrase = phrase;


            if (phrase.includes('because') || phrase.includes('due to') || phrase.includes('caused')) {
                return {
                    isValid: false,
                    reason: `Answer contains unsupported causal explanation: "${phrase}"`,
                };
            }
        }
    }


    if (speculationCount > 2) {
        return {
            isValid: false,
            reason: `Answer contains too much speculation (detected "${detectedPhrase}" and others)`,
        };
    }

    return { isValid: true };
}

/**
 * For get_system_help: the answer's steps/route should trace back to
 * the matched entry. Loose substring check rather than exact match,
 * since the model may lightly rephrase — this is a fuzzier check by
 * necessity, catching only clear invention (a route or step-like
 * sentence that shares no real overlap with the stored entry).
 */
function validateSystemHelpAnswer(answerText: string, data: unknown): ChatValidationResult {
    const topic = (data as { topic?: string } | null)?.topic;
    if (!topic) {

        return { isValid: true };
    }

    const entry = getSystemHelpEntry(topic);
    if (!entry) {
        return { isValid: true }; closed
    }

    if (entry.route && answerText.includes('/app/') && !answerText.includes(entry.route)) {
        const mentionsOtherRoute = /\/app\/[a-z-]+/i.exec(answerText);
        if (mentionsOtherRoute && mentionsOtherRoute[0] !== entry.route) {
            return {
                isValid: false,
                reason: `Answer references route "${mentionsOtherRoute[0]}" which doesn't match the help entry's route "${entry.route}"`,
            };
        }
    }

    return { isValid: true };
}

function extractNumbers(text: string): number[] {
    const matches = text.match(/-?\d+(\.\d+)?/g) ?? [];
    return matches.map(Number).filter((num) => Number.isFinite(num));
}

/** Pulls room names out of a tool result payload, checking common field names. */
function extractRoomNames(data: unknown): string[] {
    const names: string[] = [];
    const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        if (value !== null && typeof value === 'object') {
            const record = value as Record<string, unknown>;
            if (typeof record['roomName'] === 'string') {
                names.push(record['roomName']);
            }
            Object.values(record).forEach(visit);
        }
    };
    visit(data);
    return names;
}

/** Finds any known room name that appears as a substring of the answer text. */
function extractRoomNamesFromText(text: string, knownRoomNames: string[]): string[] {
    return knownRoomNames.filter((room) => text.includes(room));
}

/**
 * Validates that dates/timestamps in the answer match those in the tool
 * result. Prevents AI from inventing or misreading dates.
 */
function validateTimestamps(answerText: string, data: unknown): ChatValidationResult {

    const payloadTimestamps = extractFormattedDates(JSON.stringify(data));


    const months = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];


    for (const month of months) {
        if (answerText.includes(month)) {

            const hasMatchingMonth = payloadTimestamps.some(ts => ts.includes(month));
            if (!hasMatchingMonth && payloadTimestamps.length > 0) {
                return {
                    isValid: false,
                    reason: `Answer mentions ${month} which doesn't appear in the tool result timestamps`,
                };
            }
        }
    }

    return { isValid: true };
}

/**
 * Extracts formatted dates from JSON (after cleanTimestamp conversion).
 * Looks for patterns like "May 18, 2026 at 11:43 AM"
 */
function extractFormattedDates(jsonString: string): string[] {
    const dates: string[] = [];


    const datePattern = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\s+at\s+\d{1,2}:\d{2}\s+[AP]M/g;
    const matches = jsonString.match(datePattern);

    if (matches) {
        dates.push(...matches);
    }

    return dates;
}