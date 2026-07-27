/**
 * Context relevance checker for the OcuTemp chatbot. Detects when user
 * questions are outside the system's domain and should be rejected
 * early without calling any LLM or tools.
 *
 * This is a fast, deterministic pre-filter that catches obvious
 * out-of-scope requests before they waste API calls or confuse the
 * model. Not meant to be perfect — borderline cases can pass through
 * and let the planner decide.
 */

/** Keywords that indicate the question is about OcuTemp facility operations */
const IN_SCOPE_KEYWORDS = [
    'room',
    'classroom',
    'office',
    'lab',
    'canteen',
    'library',
    'facility',
    'building',
    'floor',
    'ac',
    'air conditioning',
    'temperature',
    'temp',
    'cooling',
    'heating',
    'hvac',
    'climate',
    'thermostat',
    'humidity',
    'occupancy',
    'occupied',
    'sensor',
    'telemetry',
    'status',
    'online',
    'offline',
    'energy',
    'kwh',
    'power',
    'consumption',
    'usage',
    'cost',
    'dashboard',
    'ocutemp',
    'schedule',
    'report',
    'chart',
    'map',
    'floor plan',
    'override',
    'auto-apply',
    'suggestion',
    'prediction',
    'log',
] as const;

/** Phrases that clearly indicate out-of-scope requests */
const OUT_OF_SCOPE_PATTERNS = [

    /what is (?!.*(?:status|temperature|temp|humidity|occupancy|energy|power|consumption|room|ac|air conditioning|device|schedule|floor plan|ocutemp))/i,
    /who is.*\?$/i,
    /who was.*\?$/i,
    /when did.*(?!room|device|ac|energy)/i,
    /where is.*(?!ocutemp|room|facility)/i,
    /how does.*(?!room|ac|energy|system)/i,
    /calculate/i,
    /what is \d+.*[\+\-\*\/]/i,
    /weather outside/i,
    /weather forecast/i,
    /forecast/i,
    /\brain\b(?!.*schedule)/i,
    /\bsunny\b/i,
    /\bcloudy\b/i,
    /\bsnow/i,
    /my birthday/i,
    /my name/i,
    /my age/i,
    /write.*essay/i,
    /write.*email/i,
    /write.*code/i,
    /write.*story/i,
    /write.*poem/i,
    /recipe for/i,
    /how to cook/i,
    /how to bake/i,
    /google/i,
    /facebook/i,
    /twitter/i,
    /youtube/i,
    /instagram/i,
] as const;

export interface ContextCheckResult {
    readonly isRelevant: boolean;
    readonly reason?: string;
}

/**
 * Checks if a user message is relevant to OcuTemp facility management.
 * Returns early rejection for clearly out-of-scope questions.
 * 
 * Strategy:
 * 1. Short queries (< 3 words) usually pass (might be room names, commands)
 * 2. Check for explicit out-of-scope patterns
 * 3. Check for in-scope keywords
 * 4. Default to allowing (let planner handle borderline cases)
 */
export function checkContextRelevance(message: string): ContextCheckResult {
    const normalized = message.trim().toLowerCase();


    if (normalized.length < 3) {
        return { isRelevant: true };
    }


    if (isGreetingOrAcknowledgment(normalized)) {
        return { isRelevant: true };
    }


    for (const pattern of OUT_OF_SCOPE_PATTERNS) {
        if (pattern.test(normalized)) {
            return {
                isRelevant: false,
                reason: 'Question appears to be outside OcuTemp facility management domain',
            };
        }
    }


    const hasInScopeKeyword = IN_SCOPE_KEYWORDS.some(keyword =>
        normalized.includes(keyword.toLowerCase())
    );

    if (hasInScopeKeyword) {
        return { isRelevant: true };
    }

    // For questions without in-scope keywords but not explicitly out-of-scope,
    // be PERMISSIVE - only reject very long questions (> 50 chars)
    if (normalized.includes('?') && normalized.length > 50) {
        return {
            isRelevant: false,
            reason: 'Question does not appear to be about OcuTemp facility operations',
        };
    }

    // Default to allowing - better to let planner reject than block valid questions
    return { isRelevant: true };
}

/**
 * Simple check for common greetings and acknowledgments that should
 * always be allowed through.
 */
function isGreetingOrAcknowledgment(text: string): boolean {
    const greetings = [
        'hi',
        'hello',
        'hey',
        'good morning',
        'good afternoon',
        'good evening',
        'thanks',
        'thank you',
        'ok',
        'okay',
        'yes',
        'no',
        'help',
    ];

    return greetings.some(greeting => text === greeting || text.startsWith(greeting + ' '));
}
