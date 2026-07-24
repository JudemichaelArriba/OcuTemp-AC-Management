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
            'Fetch current temperature, humidity, AC status, and energy metrics ' +
            'for a specific room, or for all rooms if no room name is given. ' +
            'Use for questions about live conditions in a room right now.',
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
            'Fetch rooms ranked by current energy consumption, optionally ' +
            'filtered by AC status (active vs standby). Use for "right now" ' +
            'questions like "which room uses the most energy" or "top energy ' +
            'consumers right now". For totals over a time period, use ' +
            'get_energy_usage instead.',
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
            'Fetch total energy consumption (kWh) over a time period — daily, ' +
            'weekly, monthly, or yearly — either for the whole facility or for ' +
            'one specific room. Use for questions like "how much energy did ' +
            'Room 204 use this month" or "what was our total energy usage last ' +
            'week". For a live snapshot of who is using the most right now, use ' +
            'get_energy_rankings instead.',
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
            'Fetch the latest environmental variables and reasoning used by the ' +
            'AC climate prediction model for a specific device or room. Use for ' +
            'questions about why the AI suggested a particular temperature.',
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
            'Fetch instructions for using the OcuTemp system itself — navigation, ' +
            'how to perform an action, or where a feature is located. Use for ' +
            'questions like "how do I change my password" or "where do I add a ' +
            'room", as opposed to questions about live room/energy data.',
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