import { SystemHelpEntry } from '../models/chat.models';

/**
 * Static, hand-authored knowledge base for the get_system_help tool.
 * No Firebase, no vector DB — a plain lookup map. Keep `route` values
 * exactly matching real paths in app.routes.ts; the chatbot quotes
 * these back to users as ground truth, so drift here is a real bug,
 * not a cosmetic one.
 *
 * Topic keys are the contract with the LLM's tool call arguments —
 * see the `topic` description in api/chat/tools/schema.ts for the
 * exact set of keys the model is instructed to use.
 */
const SYSTEM_HELP_ENTRIES: readonly SystemHelpEntry[] = [
    {
        topic: 'change-password',
        title: 'Change your password',
        steps: [
            "Go to Settings.",
            "Find the password option located below the Personal Profile section.",
            "Enter your current password, then your new password, and confirm.",
        ],
        route: '/app/settings',
        adminOnly: false,
    },
    {
        topic: 'add-room',
        title: 'Add a new room',
        steps: [
            "Go to the Rooms page.",
            "Use the add room action to create a new room and assign a device.",
            "You can switch between card and map views to see the room afterward.",
        ],
        route: '/app/room-management',
        adminOnly: false,
    },
    {
        topic: 'edit-room',
        title: 'Edit or delete a room',
        steps: [
            "Go to the Rooms page.",
            "Search for the room you want to change.",
            "Use the edit action to update it, or the delete action to remove it.",
        ],
        route: '/app/room-management',
        adminOnly: false,
    },
    {
        topic: 'assign-floor-plan-cell',
        title: 'Assign a room to the floor plan',
        steps: [
            "Go to Room Management.",
            "Enable floor plan edit mode using the edit button.",
            "Click a cell on the floor plan — a modal opens to add or edit that cell's room assignment.",
        ],
        route: '/app/room-management',
        adminOnly: false,
    },
    {
        topic: 'floor-plan-legend',
        title: 'Understand the floor plan colors',
        steps: [
            "Room type colors: green is AC On, brown is Lab, blue is Classroom, pink is Office, dark blue is Canteen, light green is Comfort Room, yellow is Library.",
            "Condition dots: emerald is comfortable, yellow is slightly warm, amber is warm, orange is hot, red is very hot or high humidity, gray is off or no telemetry.",
        ],
        route: '/app/room-management',
        adminOnly: false,
    },
    {
        topic: 'manage-schedules',
        title: 'Manage a room schedule',
        steps: [
            "Open the room's detail page and look for a Schedules section to add or edit weekly time slots.",
        ],
        route: '/app/room-details',
        adminOnly: false,
    },
    {
        topic: 'approve-staff',
        title: 'Approve a pending staff account',
        steps: [
            "Go to the Users page (admin-only).",
            "Find the pending staff account.",
            "Approve, restrict, or manage the account from there.",
        ],
        route: '/app/user-management',
        adminOnly: true,
    },
    {
        topic: 'view-energy-reports',
        title: 'View energy reports',
        steps: [
            "Go to Reports.",
            "View energy summaries, charts, room energy trends, monthly totals, and runtime.",
            "Use the PDF download to export the full energy report as-is — no date selection needed.",
        ],
        route: '/app/energy-reports',
        adminOnly: false,
    },
    {
        topic: 'manual-override',
        title: "Manually control a room's AC",
        steps: [
            "Open the room's detail page.",
            "Use Manual Override to set an AC target temperature.",
            "AI Auto-Apply can also be toggled here if you'd rather approve AI suggestions manually.",
        ],
        route: '/app/room-details',
        adminOnly: false,
    },
    {
        topic: 'forced-off',
        title: 'Force an AC unit off',
        steps: [
            "Open the room's detail page or go to the card directory and look for a three dots setttings and click Power Off.",
        ],
        route: '/app/room-details',
        adminOnly: false,
    },
] as const;

const SYSTEM_HELP_BY_TOPIC: ReadonlyMap<string, SystemHelpEntry> = new Map(
    SYSTEM_HELP_ENTRIES.map((entry) => [entry.topic, entry]),
);

/**
 * Looks up a help entry by topic key. Returns null if the topic doesn't
 * match anything system-help.executor.ts is responsible for turning
 * that into a clear "not found" tool result rather than an empty object.
 */
export function getSystemHelpEntry(topic: string): SystemHelpEntry | null {
    const normalized = topic.trim().toLowerCase();
    return SYSTEM_HELP_BY_TOPIC.get(normalized) ?? null;
}

/** Used by chat-response-validator.ts to confirm a model didn't invent a route or step. */
export function getAllSystemHelpTopics(): readonly string[] {
    return SYSTEM_HELP_ENTRIES.map((entry) => entry.topic);
}