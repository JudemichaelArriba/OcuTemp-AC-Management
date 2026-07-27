// chat-tool-schema.ts
import type { ProviderToolSchema } from '../providers/provider.interface';

/**
 * Provider-agnostic tool definitions. gemini.provider.ts and
 * groq.provider.ts each translate this array into their own SDK's
 * expected function-declaration format — this file is the single
 * source of truth for what tools exist and what parameters they take.
 *
 * Only attached to the planning step's request (see orchestrator.ts).
 * The answering step does not need this resent.
 */
export const CHAT_TOOL_SCHEMA: readonly ProviderToolSchema[] = [
    {
        name: 'get_room_telemetry',
        description:
            'Live snapshot of a room\'s current sensor and control state: ' +
            'temperature, humidity, occupancy, AC power, AI auto-apply flag, ' +
            'online/offline status, and active schedule count. Use for ' +
            '"right now" questions about a room\'s status — is the AC on, is ' +
            'auto-apply enabled, is the room occupied. Does NOT return energy ' +
            'consumption (kWh) — use get_energy_rankings or get_energy_usage ' +
            'for that. Omit roomName to fetch every room at once, e.g. "how ' +
            'are all the rooms doing right now".',
        parameters: {
            type: 'object',
            properties: {
                roomName: {
                    type: 'string',
                    description: "Exact room name, e.g. 'Room 204'. Omit to fetch all rooms.",
                },
            },
        },
    },
    {
        name: 'get_energy_rankings',
        description:
            'Ranks rooms against each other by energy consumption today ' +
            '(kWh so far), optionally filtered to only active or only ' +
            'standby AC units. Use ONLY for live comparison questions like ' +
            '"which room is using the most energy right now" or "top energy ' +
            'consumers today". Do NOT use this for totals over a stated time ' +
            'period (this week, last month, this year) — that is ' +
            'get_energy_usage. Do NOT use this for a single room\'s AC status ' +
            '— that is get_room_telemetry.',
        parameters: {
            type: 'object',
            properties: {
                acStatus: {
                    type: 'string',
                    enum: ['active', 'standby', 'all'],
                    description: 'Filter rooms by AC status. Defaults to all if omitted.',
                },
                limit: {
                    type: 'number',
                    description: 'Max number of rooms to return, ranked highest first. Defaults to 5.',
                },
            },
        },
    },
    {
        name: 'get_energy_usage',
        description:
            'Time-series energy totals (kWh) for the whole facility or one ' +
            'named room, bucketed daily (last 7 days), weekly (last 8 ' +
            'weeks), monthly (last 12 months), or yearly (last 5 years). Use ' +
            'for any question naming a time period or trend, e.g. "how much ' +
            'energy did Room 204 use this month" or "facility usage last ' +
            'week". Do NOT use this to compare rooms against each other right ' +
            'now — that is get_energy_rankings.',
        parameters: {
            type: 'object',
            properties: {
                scope: {
                    type: 'string',
                    enum: ['facility', 'room'],
                    description:
                        "'facility' sums usage across all rooms. 'room' returns usage " +
                        'for one room only and requires roomName.',
                },
                roomName: {
                    type: 'string',
                    description: "Exact room name, e.g. 'Room 204'. Required when scope is 'room'.",
                },
                period: {
                    type: 'string',
                    enum: ['daily', 'weekly', 'monthly', 'yearly'],
                    description:
                        "'daily' returns the last 7 days, 'weekly' the last 8 weeks, " +
                        "'monthly' the last 12 months, 'yearly' the last 5 years.",
                },
            },
            required: ['scope', 'period'],
        },
    },
    {
        name: 'get_climate_prediction_logs',
        description:
            'The AI climate model\'s latest suggested temperature for one ' +
            'room, its stated reasoning, and whether it was applied or ' +
            'auto-apply is enabled. Use ONLY when the user asks why the AI ' +
            'suggested a temperature or wants to see its reasoning. Not for ' +
            'general room status — use get_room_telemetry for that. ' +
            'roomName is required; if the user hasn\'t named a room, ask ' +
            'which one instead of calling this tool.',
        parameters: {
            type: 'object',
            properties: {
                roomName: {
                    type: 'string',
                    description: "Exact room name, e.g. 'Room 204'.",
                },
            },
            required: ['roomName'],
        },
    },
    {
        name: 'get_system_help',
        description:
            'Instructions for using the OcuTemp dashboard itself — never live ' +
            'room or energy data. Use for "how do I..." or "where is..." ' +
            'questions about the UI. Pass the topic key that most closely ' +
            'matches the request. Known topics include: change-password, ' +
            'add-room, assign-floor-plan-cell, manage-schedules, ' +
            'approve-staff, view-energy-reports. If nothing matches well, ' +
            'still pass your best-guess key — the tool reports back if no ' +
            'entry is found rather than failing.',
        parameters: {
            type: 'object',
            properties: {
                topic: {
                    type: 'string',
                    description:
                        "A short topic key describing the requested action, e.g. " +
                        "'change-password', 'add-room', 'assign-floor-plan-cell', " +
                        "'manage-schedules', 'approve-staff', 'view-energy-reports'.",
                },
            },
            required: ['topic'],
        },
    },
] as const;

/** Convenience lookup used by orchestrator.ts and validate-request.ts. */
export const CHAT_TOOL_NAMES = CHAT_TOOL_SCHEMA.map((tool) => tool.name);