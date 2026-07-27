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
 *
 * IMPORTANT: All tools are READ-ONLY. No tool can modify, control, or
 * change any data or device state. Tools only fetch and return data.
 */
export const CHAT_TOOL_SCHEMA: readonly ProviderToolSchema[] = [
    {
        name: 'get_room_telemetry',
        description:
            'READ-ONLY: Fetch live snapshot of room sensor and control state. ' +
            'Returns: temperature, humidity, occupancy, AC power status, AI ' +
            'auto-apply flag, online/offline status, and room schedules (day, ' +
            'startTime, endTime, subject). ' +
            'Use for "right now" questions about a room\'s current status or ' +
            'schedule details (when classes are, what time activities start). ' +
            'DOES return: current temperature, AC on/off, occupancy, device online state, schedule times. ' +
            'Does NOT return: energy consumption (use get_energy_rankings or get_energy_usage), ' +
            'historical data (use get_energy_usage), AI reasoning (use get_climate_prediction_logs). ' +
            'Parameters: roomName (exact match, e.g. "Room 204"). Omit roomName to fetch ALL rooms. ' +
            'CANNOT: turn AC on/off, change temperature, modify settings, edit schedules. Read-only.',
        parameters: {
            type: 'object',
            properties: {
                roomName: {
                    type: 'string',
                    description: "Exact room name, case-insensitive, e.g. 'Room 204'. Omit to fetch all rooms at once.",
                },
            },
        },
    },
    {
        name: 'get_energy_rankings',
        description:
            'READ-ONLY: Rank rooms by energy consumption TODAY (kWh accumulated ' +
            'so far today), optionally filtered by AC status (active/standby/all). ' +
            'Returns rooms sorted highest energy first. ' +
            'USE ONLY FOR: live comparison questions like "which room is using ' +
            'the most energy right now" or "top 5 energy consumers today". ' +
            'Do NOT use for: totals over a stated time period (this week, last ' +
            'month, this year) — that is get_energy_usage. Do NOT use for a ' +
            'single room\'s AC status — that is get_room_telemetry. Do NOT use ' +
            'for "how much energy" questions — that is get_energy_usage. ' +
            'CANNOT: reduce energy, turn off devices, change rankings. Read-only.',
        parameters: {
            type: 'object',
            properties: {
                acStatus: {
                    type: 'string',
                    enum: ['active', 'standby', 'all'],
                    description: 'Filter: active = AC running, standby = AC off, all = both. Defaults to "all".',
                },
                limit: {
                    type: 'number',
                    description: 'Max rooms to return, ranked highest first. Defaults to 5. Max 50.',
                },
            },
        },
    },
    {
        name: 'get_energy_usage',
        description:
            'READ-ONLY: Time-series energy totals (kWh) for the whole facility ' +
            'or one named room, bucketed by period (daily/weekly/monthly/yearly). ' +
            'Returns historical series data. ' +
            'USE FOR: any question naming a time period or trend, e.g. "how much ' +
            'energy did Room 204 use this month", "facility usage last week", ' +
            '"energy trend over the year", "total kWh in January". ' +
            'Do NOT use for: comparing rooms against each other right now (that ' +
            'is get_energy_rankings). Do NOT use for current AC status (that is ' +
            'get_room_telemetry). ' +
            'DOES return: kWh totals bucketed by day/week/month/year. ' +
            'Does NOT return: cost estimates, predictions, live rankings. ' +
            'CANNOT: reduce usage, change settings, control devices. Read-only.',
        parameters: {
            type: 'object',
            properties: {
                scope: {
                    type: 'string',
                    enum: ['facility', 'room'],
                    description:
                        "facility = sum usage across all rooms. room = usage for one room only (requires roomName).",
                },
                roomName: {
                    type: 'string',
                    description: "Exact room name, e.g. 'Room 204'. Required when scope='room'. Omit for facility.",
                },
                period: {
                    type: 'string',
                    enum: ['daily', 'weekly', 'monthly', 'yearly'],
                    description:
                        "daily = last 7 days, weekly = last 8 weeks, monthly = last 12 months, yearly = last 5 years.",
                },
            },
            required: ['scope', 'period'],
        },
    },
    {
        name: 'get_climate_prediction_logs',
        description:
            'READ-ONLY: Fetch the AI climate model\'s latest temperature ' +
            'suggestion for ONE room, including its reasoning text, suggested ' +
            'temp, current conditions, and whether it was applied. ' +
            'USE ONLY WHEN: user explicitly asks why the AI suggested a ' +
            'temperature or wants to see its reasoning. Not for general room ' +
            'status — use get_room_telemetry for that. Not for energy data. ' +
            'DOES return: AI suggestion, reasoning, suggested temp, applied status. ' +
            'Does NOT return: full room telemetry (use get_room_telemetry), ' +
            'energy data (use get_energy_usage), live temperature (use get_room_telemetry). ' +
            'REQUIRED: roomName must be provided. If user hasn\'t named a room, ' +
            'ask which one instead of calling this tool. ' +
            'CANNOT: change AI suggestion, apply suggestion, modify reasoning. Read-only.',
        parameters: {
            type: 'object',
            properties: {
                roomName: {
                    type: 'string',
                    description: "Exact room name, e.g. 'Room 204'. REQUIRED - do not call without a room name.",
                },
            },
            required: ['roomName'],
        },
    },
    {
        name: 'get_system_help',
        description:
            'READ-ONLY: Fetch instructions for using the OcuTemp dashboard ' +
            'itself — UI navigation, feature locations, how-to steps. NEVER ' +
            'live room or energy data (use other tools for that). ' +
            'USE FOR: "how do I...", "where is...", "how to..." questions about ' +
            'the dashboard UI and features. ' +
            'Do NOT use for: live room data (use get_room_telemetry), energy ' +
            'data (use get_energy_usage or get_energy_rankings), device status. ' +
            'Known topics: change-password, add-room, edit-room, assign-floor-plan-cell, ' +
            'floor-plan-legend, manage-schedules, approve-staff, view-energy-reports, ' +
            'manual-override, forced-off. If nothing matches, pass your best-guess ' +
            'key — tool reports if not found. ' +
            'DOES return: step-by-step instructions, page routes, feature locations. ' +
            'Does NOT return: live data, room status, energy values, device state. ' +
            'CANNOT: perform actions, navigate for user, change settings. Read-only.',
        parameters: {
            type: 'object',
            properties: {
                topic: {
                    type: 'string',
                    description:
                        "Short topic key, e.g. 'change-password', 'add-room', 'assign-floor-plan-cell', " +
                        "'manage-schedules', 'approve-staff', 'view-energy-reports', 'manual-override', 'forced-off'.",
                },
            },
            required: ['topic'],
        },
    },
] as const;

/** Convenience lookup used by orchestrator.ts and validate-request.ts. */
export const CHAT_TOOL_NAMES = CHAT_TOOL_SCHEMA.map((tool) => tool.name);