import type { FirebaseRestClient } from '../firebase-rest.js';
import type {
    AuthenticatedChatUser,
    ChatPresentation,
    ChatToolName,
    ClimateSuggestionRow,
    ClimateSuggestionsPresentation,
    DeviceOnlineState,
    GroundingFact,
    PlannerToolPlan,
    RecentEventRow,
    RecentEventsPresentation,
    RoomCondition,
    RoomTelemetryPresentation,
    RoomTelemetryRow,
    SystemHelpPresentation,
    ToolExecutionResult,
} from '../types/chat.types.js';
import { ChatApiError } from '../types/chat.types.js';
import {
    buildEnergyReport,
    resolveEnergyRange,
    type EnergyRoomInput,
} from './energy.js';

const MAX_TOOL_PLANS = 4;
const MAX_ACTIVE_ROOMS = 200;
const MAX_REQUESTED_ROOMS = 50;
const MAX_EVENTS_RETURNED = 25;
const MAX_EVENT_SCAN = 200;
const MAX_CONCURRENT_ENERGY_READS = 10;
const MAX_SCHEDULE_FACTS = 200;

const ALLOWED_TOOLS: readonly ChatToolName[] = [
    'get_room_telemetry',
    'get_energy_report',
    'get_climate_prediction_logs',
    'get_recent_room_events',
    'get_system_help',
];

const ENERGY_PRESETS = new Set([
    'today',
    'this_week',
    'last_week',
    'last_7_days',
    'this_month',
    'last_month',
    'this_year',
    'last_12_months',
    'custom',
]);
const ENERGY_BUCKETS = new Set(['auto', 'day', 'week', 'month', 'year']);
const WEEK_DAYS = new Set([
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
    'Sunday',
]);

export interface ToolExecutionContext {
    readonly firebase: FirebaseRestClient;
    readonly user: AuthenticatedChatUser;
    readonly now?: Date;
}

interface FacilityRoom {
    readonly uid: string;
    readonly roomName: string;
    readonly deviceAssigned: boolean;
    readonly deviceId: string | null;
    readonly raw: Record<string, unknown>;
}

interface FacilityRoomSnapshot {
    readonly rooms: readonly FacilityRoom[];
    readonly notices: readonly string[];
    readonly partial: boolean;
}

interface RoomSelection {
    readonly rooms: readonly FacilityRoom[];
    readonly notices: readonly string[];
    readonly facts: readonly string[];
    readonly partial: boolean;
}

interface HelpEntry {
    readonly topic: string;
    readonly title: string;
    readonly steps: readonly string[];
    readonly route: string;
    readonly adminOnly: boolean;
}

class RequestSnapshots {
    private roomPromise: Promise<FacilityRoomSnapshot> | undefined;
    private devicePromise: Promise<Record<string, unknown>> | undefined;
    private logPromise: Promise<Record<string, unknown>> | undefined;

    constructor(readonly firebase: FirebaseRestClient) {}

    rooms(): Promise<FacilityRoomSnapshot> {
        this.roomPromise ??= loadActiveRooms(this.firebase);
        return this.roomPromise;
    }

    devices(): Promise<Record<string, unknown>> {
        this.devicePromise ??= this.firebase.getDevices();
        return this.devicePromise;
    }

    logs(): Promise<Record<string, unknown>> {
        this.logPromise ??= this.firebase.getLatestDecisionLogs(MAX_EVENT_SCAN);
        return this.logPromise;
    }
}

const SYSTEM_HELP: readonly HelpEntry[] = [
    {
        topic: 'change-password',
        title: 'Change your password',
        steps: [
            'Open Settings from the OcuTemp sidebar.',
            'In the password section, enter your current password and then the new password twice.',
            'Submit the form and wait for the success message before leaving the page.',
        ],
        route: '/app/settings',
        adminOnly: false,
    },
    {
        topic: 'add-room',
        title: 'Add a room',
        steps: [
            'Open Rooms from the OcuTemp sidebar.',
            'Choose Add room and enter the room details.',
            'Select an available device, then save the room.',
        ],
        route: '/app/room-management',
        adminOnly: false,
    },
    {
        topic: 'edit-room',
        title: 'Edit a room',
        steps: [
            'Open Rooms and find the room you need.',
            'Open its edit action, update the permitted fields, and save.',
        ],
        route: '/app/room-management',
        adminOnly: false,
    },
    {
        topic: 'assign-floor-plan-cell',
        title: 'Assign a room on the floor plan',
        steps: [
            'Open Rooms and switch to the floor-plan view.',
            'Enable floor-plan edit mode.',
            'Select an available cell, choose the room, and save the assignment.',
        ],
        route: '/app/room-management',
        adminOnly: false,
    },
    {
        topic: 'floor-plan-legend',
        title: 'Read the floor-plan status',
        steps: [
            'Open Rooms and switch to the floor-plan view.',
            'Use the on-screen legend to compare room type, condition, and offline indicators.',
        ],
        route: '/app/room-management',
        adminOnly: false,
    },
    {
        topic: 'manage-schedules',
        title: 'Manage a room schedule',
        steps: [
            'Open Rooms and select the room.',
            'Open its schedule section, add or edit a weekly time slot, and save.',
        ],
        route: '/app/room-management',
        adminOnly: false,
    },
    {
        topic: 'approve-staff',
        title: 'Approve a staff account',
        steps: [
            'Open Users from the administrator sidebar.',
            'Find the pending staff account and review its details.',
            'Use the approval action to grant access.',
        ],
        route: '/app/user-management',
        adminOnly: true,
    },
    {
        topic: 'view-energy-reports',
        title: 'View energy reports',
        steps: [
            'Open Reports from the OcuTemp sidebar.',
            'Review estimated energy, runtime, room comparisons, and trends.',
            'Use the PDF action when you need an export of the displayed report.',
        ],
        route: '/app/energy-reports',
        adminOnly: false,
    },
    {
        topic: 'manual-override',
        title: 'Use a manual AC override',
        steps: [
            'Open Rooms and select the room you are authorized to manage.',
            'Open Manual Override, choose the target and duration, then confirm the change.',
        ],
        route: '/app/room-management',
        adminOnly: false,
    },
    {
        topic: 'forced-off',
        title: 'Force an AC unit off',
        steps: [
            'Open Rooms and select the room you are authorized to manage.',
            'Open the room actions, choose Power Off, and confirm the warning.',
        ],
        route: '/app/room-management',
        adminOnly: false,
    },
    {
        topic: 'ocu-guide',
        title: 'Use OcuGuide',
        steps: [
            'Open OcuGuide from the sidebar.',
            'Ask about active-room telemetry, estimated energy, climate suggestions, recent events, or OcuTemp navigation.',
            'Review the evidence report separately from the concise answer.',
        ],
        route: '/app/ocu-guide',
        adminOnly: false,
    },
] as const;

/**
 * Executes at most four independent, unique, read-only plans. Shared Firebase
 * snapshots are memoized for this request, and tool failures cannot cancel
 * unrelated reads. Authentication, authorization, and facility-size failures
 * always propagate rather than being disguised as missing data.
 */
export async function executeToolPlans(
    plans: readonly PlannerToolPlan[],
    context: ToolExecutionContext,
): Promise<ToolExecutionResult[]> {
    const validatedPlans = validatePlans(plans);
    const snapshots = new RequestSnapshots(context.firebase);
    const now = context.now ?? new Date();
    if (!Number.isFinite(now.getTime())) {
        throw new ChatApiError('invalid_request', 'The request time is invalid.', 400);
    }

    const settled = await Promise.allSettled(
        validatedPlans.map((plan, index) =>
            executeOne(plan, index + 1, snapshots, context.user, now),
        ),
    );

    for (const outcome of settled) {
        if (outcome.status === 'rejected' && shouldPropagate(outcome.reason)) {
            throw outcome.reason;
        }
    }

    return settled.map((outcome, index) =>
        outcome.status === 'fulfilled'
            ? outcome.value
            : buildUnavailableResult(validatedPlans[index]!, index + 1, now),
    );
}

async function executeOne(
    plan: PlannerToolPlan,
    ordinal: number,
    snapshots: RequestSnapshots,
    user: AuthenticatedChatUser,
    now: Date,
): Promise<ToolExecutionResult> {
    switch (plan.name) {
        case 'get_room_telemetry':
            return executeTelemetry(plan, ordinal, snapshots, now);
        case 'get_energy_report':
            return executeEnergy(plan, ordinal, snapshots, now);
        case 'get_climate_prediction_logs':
            return executeClimateSuggestions(plan, ordinal, snapshots);
        case 'get_recent_room_events':
            return executeRecentEvents(plan, ordinal, snapshots);
        case 'get_system_help':
            return executeSystemHelp(plan, ordinal, user);
    }
}

async function executeTelemetry(
    plan: PlannerToolPlan,
    ordinal: number,
    snapshots: RequestSnapshots,
    now: Date,
): Promise<ToolExecutionResult> {
    const [facility, deviceOutcome] = await Promise.all([
        snapshots.rooms(),
        settlePromise(snapshots.devices()),
    ]);
    if (deviceOutcome.status === 'rejected' && shouldPropagate(deviceOutcome.reason)) {
        throw deviceOutcome.reason;
    }
    const deviceSnapshotFailed = deviceOutcome.status === 'rejected';
    const devices = deviceOutcome.status === 'fulfilled' ? deviceOutcome.value : {};
    const selection = selectRooms(facility, plan.roomNames);
    let unavailableDevices = 0;
    let scheduleFactCount = 0;
    let scheduleFactsOmitted = false;
    const roomFacts: GroundingFact[] = [];

    const rooms: RoomTelemetryRow[] = selection.rooms.map((room, index) => {
        const device = getAssignedDevice(room, devices);
        if (room.deviceAssigned && !device) unavailableDevices += 1;
        const temperature = boundedNumber(device?.['temperature'], -50, 100);
        const humidity = boundedNumber(device?.['humidity'], 0, 100);
        const lastSeen = normalizedTimestamp(nestedValue(device, 'status', 'lastSeen'));
        const onlineState = onlineStateFor(lastSeen, now);
        const condition = roomCondition(temperature, humidity);
        const occupancy = strictBoolean(device?.['occupancy']);
        const acPower = strictBoolean(nestedValue(device, 'acState', 'power'));
        const aiAutoApply = nestedValue(device, 'control', 'aiAutoApply') === true;
        const schedules = parseSchedules(room.raw['schedules']);
        const row: RoomTelemetryRow = {
            roomName: room.roomName,
            onlineState,
            condition,
            temperature: roundNullable(temperature, 1),
            humidity: roundNullable(humidity, 1),
            occupancy,
            acPower,
            aiAutoApply,
            schedules,
            lastSeen,
        };
        roomFacts.push({
            id: `t${ordinal}.telemetry.${index + 1}`,
            statement: telemetryFact(row, room),
        });
        row.schedules.forEach((schedule, scheduleIndex) => {
            if (scheduleFactCount >= MAX_SCHEDULE_FACTS) {
                scheduleFactsOmitted = true;
                return;
            }
            scheduleFactCount += 1;
            roomFacts.push({
                id: `t${ordinal}.schedule.${index + 1}.${scheduleIndex + 1}`,
                statement:
                    `${row.roomName} has a ${schedule.day} schedule from ${schedule.startTime} ` +
                    `to ${schedule.endTime} for "${schedule.subject}".`,
            });
        });
        return row;
    });

    const presentation: RoomTelemetryPresentation = {
        kind: 'room-telemetry',
        id: `tool-${ordinal}`,
        title: plan.roomNames.length === 0
            ? 'Current telemetry for active rooms'
            : 'Current telemetry for selected active rooms',
        rooms,
    };
    const notices = uniqueStrings([
        ...facility.notices,
        ...selection.notices,
        ...(unavailableDevices > 0
            ? [
                `${unavailableDevices} selected room${unavailableDevices === 1 ? '' : 's'} ` +
                    `${unavailableDevices === 1 ? 'has' : 'have'} unavailable assigned-device data.`,
            ]
            : []),
        ...(scheduleFactsOmitted
            ? ['Detailed schedule grounding was limited to 200 entries for this response.']
            : []),
        ...(deviceSnapshotFailed
            ? ['The device snapshot could not be read; assigned-device telemetry is marked unavailable.']
            : []),
    ]);

    return {
        name: plan.name,
        presentation,
        facts: [
            {
                id: `t${ordinal}.telemetry.summary`,
                statement: deviceSnapshotFailed
                    ? `Assigned-device telemetry could not be read for ${rooms.length} selected active rooms.`
                    : telemetrySummary(rooms),
            },
            ...selectionFacts(selection, `t${ordinal}.scope`),
            ...roomFacts,
        ],
        notices,
        partial:
            facility.partial || selection.partial || unavailableDevices > 0 ||
            scheduleFactsOmitted || deviceSnapshotFailed,
    };
}

async function executeEnergy(
    plan: PlannerToolPlan,
    ordinal: number,
    snapshots: RequestSnapshots,
    now: Date,
): Promise<ToolExecutionResult> {
    const range = resolveEnergyRange(plan, now);
    const [facility, deviceKeyOutcome] = await Promise.all([
        snapshots.rooms(),
        settlePromise(snapshots.firebase.read<Record<string, unknown>>('devices', { shallow: true })),
    ]);
    if (deviceKeyOutcome.status === 'rejected' && shouldPropagate(deviceKeyOutcome.reason)) {
        throw deviceKeyOutcome.reason;
    }
    const selection = selectRooms(facility, plan.roomNames);
    const deviceDirectoryFailed = deviceKeyOutcome.status === 'rejected';
    const availableDeviceKeys =
        deviceKeyOutcome.status === 'fulfilled' && isRecord(deviceKeyOutcome.value)
            ? deviceKeyOutcome.value
            : {};
    const energyReads = await allSettledBounded(
        selection.rooms,
        MAX_CONCURRENT_ENERGY_READS,
        async (room): Promise<EnergyRoomInput> => {
            const available = room.deviceId !== null && Object.hasOwn(availableDeviceKeys, room.deviceId);
            if (!room.deviceId || !available) {
                return {
                    roomName: room.roomName,
                    deviceId: room.deviceId,
                    deviceAssigned: room.deviceAssigned,
                    deviceAvailable: available,
                    daily: null,
                    readFailed: deviceDirectoryFailed && room.deviceAssigned,
                };
            }
            return {
                roomName: room.roomName,
                deviceId: room.deviceId,
                deviceAssigned: true,
                deviceAvailable: true,
                daily: await snapshots.firebase.getEnergyForDevice(
                    room.deviceId,
                    range.start,
                    range.end,
                ),
            };
        },
    );

    const inputs: EnergyRoomInput[] = [];
    for (let index = 0; index < energyReads.length; index += 1) {
        const result = energyReads[index]!;
        const room = selection.rooms[index]!;
        if (result.status === 'fulfilled') {
            inputs.push(result.value);
        } else if (shouldPropagate(result.reason)) {
            throw result.reason;
        } else {
            inputs.push({
                roomName: room.roomName,
                deviceId: room.deviceId,
                deviceAssigned: room.deviceAssigned,
                deviceAvailable: false,
                daily: null,
                readFailed: true,
            });
        }
    }

    const built = buildEnergyReport({
        id: `tool-${ordinal}`,
        factPrefix: `t${ordinal}.energy`,
        plan,
        rooms: inputs,
        now,
    });
    return {
        name: plan.name,
        presentation: built.presentation,
        facts: [
            ...selectionFacts(selection, `t${ordinal}.scope`),
            ...built.facts,
        ],
        notices: uniqueStrings([
            ...facility.notices,
            ...selection.notices,
            ...built.notices,
            ...(deviceDirectoryFailed
                ? ['The device directory could not be read; assigned devices are marked unavailable.']
                : []),
        ]),
        partial: facility.partial || selection.partial || built.partial || deviceDirectoryFailed,
    };
}

async function executeClimateSuggestions(
    plan: PlannerToolPlan,
    ordinal: number,
    snapshots: RequestSnapshots,
): Promise<ToolExecutionResult> {
    const [facility, deviceOutcome] = await Promise.all([
        snapshots.rooms(),
        settlePromise(snapshots.devices()),
    ]);
    if (deviceOutcome.status === 'rejected' && shouldPropagate(deviceOutcome.reason)) {
        throw deviceOutcome.reason;
    }
    const deviceSnapshotFailed = deviceOutcome.status === 'rejected';
    const devices = deviceOutcome.status === 'fulfilled' ? deviceOutcome.value : {};
    const selection = selectRooms(facility, plan.roomNames);
    let unavailableDevices = 0;
    const facts: GroundingFact[] = [];

    const rooms: ClimateSuggestionRow[] = selection.rooms.map((room, index) => {
        const device = getAssignedDevice(room, devices);
        let row: ClimateSuggestionRow;
        if (!room.deviceAssigned) {
            row = emptyClimateRow(room.roomName, 'no_device');
        } else if (!device) {
            unavailableDevices += 1;
            row = emptyClimateRow(room.roomName, 'device_unavailable');
        } else {
            const suggestion = recordValue(device['mlSuggestion']);
            const suggestedTemp = boundedNumber(suggestion?.['suggestedTemp'], 10, 40);
            if (!suggestion || suggestedTemp === null) {
                row = emptyClimateRow(room.roomName, 'no_suggestion');
            } else {
                row = {
                    roomName: room.roomName,
                    status: 'available',
                    currentRoomTemp: roundNullable(
                        firstNumber(
                            boundedNumber(suggestion['currentRoomTemp'], -50, 100),
                            boundedNumber(device['temperature'], -50, 100),
                        ),
                        1,
                    ),
                    humidity: roundNullable(
                        firstNumber(
                            boundedNumber(suggestion['humidity'], 0, 100),
                            boundedNumber(device['humidity'], 0, 100),
                        ),
                        1,
                    ),
                    suggestedTemp: round(suggestedTemp, 1),
                    reason: cleanStoredText(suggestion['reason'], 300),
                    applied: suggestion['applied'] === true,
                    autoApplyEnabled:
                        nestedValue(device, 'control', 'aiAutoApply') === true ||
                        suggestion['autoApplyEnabled'] === true,
                    updatedAt: normalizedTimestamp(suggestion['updatedAt']),
                };
            }
        }
        facts.push({
            id: `t${ordinal}.climate.${index + 1}`,
            statement: climateFact(row),
        });
        return row;
    });

    const presentation: ClimateSuggestionsPresentation = {
        kind: 'climate-suggestions',
        id: `tool-${ordinal}`,
        title: plan.roomNames.length === 0
            ? 'Latest climate suggestions for active rooms'
            : 'Latest climate suggestions for selected active rooms',
        rooms,
    };
    const available = rooms.filter((room) => room.status === 'available').length;
    const notices = uniqueStrings([
        ...facility.notices,
        ...selection.notices,
        ...(unavailableDevices > 0
            ? [
                `${unavailableDevices} selected room${unavailableDevices === 1 ? '' : 's'} ` +
                    `${unavailableDevices === 1 ? 'has' : 'have'} unavailable assigned-device data.`,
            ]
            : []),
        ...(deviceSnapshotFailed
            ? ['The device snapshot could not be read; climate suggestions are marked unavailable.']
            : []),
    ]);
    return {
        name: plan.name,
        presentation,
        facts: [
            {
                id: `t${ordinal}.climate.summary`,
                statement: deviceSnapshotFailed
                    ? `Stored climate suggestions could not be read for ${rooms.length} selected active rooms.`
                    : `${available} of ${rooms.length} selected active rooms have a stored climate suggestion.`,
            },
            ...selectionFacts(selection, `t${ordinal}.scope`),
            ...facts,
        ],
        notices,
        partial: facility.partial || selection.partial || unavailableDevices > 0 || deviceSnapshotFailed,
    };
}

async function executeRecentEvents(
    plan: PlannerToolPlan,
    ordinal: number,
    snapshots: RequestSnapshots,
): Promise<ToolExecutionResult> {
    const [facility, logOutcome] = await Promise.all([
        snapshots.rooms(),
        settlePromise(snapshots.logs()),
    ]);
    if (logOutcome.status === 'rejected' && shouldPropagate(logOutcome.reason)) {
        throw logOutcome.reason;
    }
    const logSnapshotFailed = logOutcome.status === 'rejected';
    const rawLogs = logOutcome.status === 'fulfilled' ? logOutcome.value : {};
    const selection = selectRooms(facility, plan.roomNames);
    const roomByUid = new Map(selection.rooms.map((room) => [room.uid, room]));
    const roomByDevice = new Map(
        selection.rooms
            .filter((room): room is FacilityRoom & { readonly deviceId: string } => room.deviceId !== null)
            .map((room) => [room.deviceId, room]),
    );
    const roomByName = new Map(selection.rooms.map((room) => [roomKey(room.roomName), room]));
    const limit = Math.min(MAX_EVENTS_RETURNED, Math.max(1, plan.limit));

    const events = Object.values(rawLogs)
        .filter(isRecord)
        .map((raw): { readonly row: RecentEventRow; readonly sortTime: number } | null => {
            const room = findEventRoom(raw, roomByUid, roomByDevice, roomByName);
            if (!room) return null;
            const updatedAt = normalizedTimestamp(raw['updatedAt']);
            if (!updatedAt) return null;
            const eventType = cleanStoredText(raw['eventType'], 60) ?? 'Operational event';
            const mode = cleanStoredText(raw['mode'], 40);
            const detail = cleanStoredText(raw['reason'], 240) ?? 'No additional detail was recorded.';
            return {
                row: {
                    roomName: room.roomName,
                    eventType,
                    mode,
                    detail,
                    applied: strictBoolean(raw['applied']),
                    updatedAt,
                },
                sortTime: new Date(updatedAt).getTime(),
            };
        })
        .filter((event): event is { readonly row: RecentEventRow; readonly sortTime: number } => event !== null)
        .sort((left, right) => right.sortTime - left.sortTime)
        .slice(0, limit)
        .map((event) => event.row);

    const presentation: RecentEventsPresentation = {
        kind: 'recent-events',
        id: `tool-${ordinal}`,
        title: plan.roomNames.length === 0
            ? 'Recent events for active rooms'
            : 'Recent events for selected active rooms',
        events,
    };
    const facts: GroundingFact[] = [
        {
            id: `t${ordinal}.events.summary`,
            statement: logSnapshotFailed
                ? 'Recent operational events could not be read.'
                : `${events.length} matching events were returned after scanning up to the latest ` +
                    `${MAX_EVENT_SCAN} facility events (result limit ${limit}).`,
        },
        ...selectionFacts(selection, `t${ordinal}.scope`),
        ...events.map((event, index) => ({
            id: `t${ordinal}.events.${index + 1}`,
            statement: recentEventFact(event),
        })),
    ];
    return {
        name: plan.name,
        presentation,
        facts,
        notices: uniqueStrings([
            ...facility.notices,
            ...selection.notices,
            ...(logSnapshotFailed ? ['Recent operational events could not be read.'] : []),
        ]),
        partial: facility.partial || selection.partial || logSnapshotFailed,
    };
}

function executeSystemHelp(
    plan: PlannerToolPlan,
    ordinal: number,
    user: AuthenticatedChatUser,
): ToolExecutionResult {
    const topic = normalizeTopic(plan.topic);
    const entry = SYSTEM_HELP.find((candidate) => candidate.topic === topic);
    if (!entry) {
        const presentation: SystemHelpPresentation = {
            kind: 'system-help',
            id: `tool-${ordinal}`,
            title: 'Help topic not found',
            topic,
            steps: [],
            route: null,
            restricted: false,
        };
        return {
            name: plan.name,
            presentation,
            facts: [{
                id: `t${ordinal}.help`,
                statement: `No static OcuTemp help entry exactly matches the topic "${topic || 'unspecified'}".`,
            }],
            notices: ['No exact static help topic matched the request.'],
            partial: false,
        };
    }

    const restricted = entry.adminOnly && user.role !== 'admin';
    const presentation: SystemHelpPresentation = {
        kind: 'system-help',
        id: `tool-${ordinal}`,
        title: restricted ? 'Administrator help topic' : entry.title,
        topic: entry.topic,
        steps: restricted ? [] : [...entry.steps],
        route: restricted ? null : entry.route,
        restricted,
    };
    const statement = restricted
        ? `The ${entry.topic} help topic is restricted to administrators.`
        : `${entry.title}: ${entry.steps.join(' ')} Route: ${entry.route}.`;
    return {
        name: plan.name,
        presentation,
        facts: [{ id: `t${ordinal}.help`, statement }],
        notices: restricted ? ['This help topic requires administrator access.'] : [],
        partial: false,
    };
}

async function loadActiveRooms(firebase: FirebaseRestClient): Promise<FacilityRoomSnapshot> {
    const rawRooms = await firebase.getRooms();
    const activeEntries = Object.entries(rawRooms).filter(([, raw]) =>
        isRecord(raw) && raw['status'] === 'active',
    );
    if (activeEntries.length > MAX_ACTIVE_ROOMS) {
        throw new ChatApiError(
            'facility_too_large',
            `OcuGuide supports at most ${MAX_ACTIVE_ROOMS} active rooms per request.`,
            413,
        );
    }

    const rooms: FacilityRoom[] = [];
    let invalidRooms = 0;
    for (const [uid, rawValue] of activeEntries) {
        if (!isRecord(rawValue) || !isSafeFirebaseKey(uid)) {
            invalidRooms += 1;
            continue;
        }
        const roomName = cleanStoredText(rawValue['roomName'], 100);
        if (!roomName) {
            invalidRooms += 1;
            continue;
        }
        const assignedValue = typeof rawValue['device'] === 'string'
            ? rawValue['device'].trim()
            : '';
        const deviceAssigned = assignedValue.length > 0;
        const deviceId = deviceAssigned && isSafeFirebaseKey(assignedValue) ? assignedValue : null;
        rooms.push({
            uid,
            roomName,
            deviceAssigned,
            deviceId,
            raw: rawValue,
        });
    }
    rooms.sort((left, right) => left.roomName.localeCompare(right.roomName));
    return {
        rooms,
        notices: invalidRooms > 0
            ? [
                `${invalidRooms} active room record${invalidRooms === 1 ? '' : 's'} ` +
                    `${invalidRooms === 1 ? 'was' : 'were'} omitted because required identifiers were invalid.`,
            ]
            : [],
        partial: invalidRooms > 0,
    };
}

function selectRooms(facility: FacilityRoomSnapshot, requestedNames: readonly string[]): RoomSelection {
    if (requestedNames.length === 0) {
        return {
            rooms: facility.rooms,
            notices: [],
            facts: facility.rooms.length === 0 ? ['No active rooms are configured.'] : [],
            partial: false,
        };
    }

    const selected: FacilityRoom[] = [];
    const missing: string[] = [];
    const selectedUids = new Set<string>();
    for (const requested of requestedNames) {
        const key = roomKey(requested);
        const matches = facility.rooms.filter((room) => roomKey(room.roomName) === key);
        if (matches.length === 0) {
            missing.push(requested);
            continue;
        }
        for (const room of matches) {
            if (!selectedUids.has(room.uid)) {
                selected.push(room);
                selectedUids.add(room.uid);
            }
        }
    }
    selected.sort((left, right) => left.roomName.localeCompare(right.roomName));
    return {
        rooms: selected,
        notices: missing.length > 0
            ? [
                `${missing.length} requested room name${missing.length === 1 ? '' : 's'} did not exactly match an active room.`,
            ]
            : [],
        facts: missing.map((name) => `No active room exactly matches "${name}".`),
        partial: missing.length > 0,
    };
}

function selectionFacts(selection: RoomSelection, prefix: string): GroundingFact[] {
    return selection.facts.map((statement, index) => ({
        id: `${prefix}.${index + 1}`,
        statement,
    }));
}

function getAssignedDevice(
    room: FacilityRoom,
    devices: Record<string, unknown>,
): Record<string, unknown> | null {
    if (!room.deviceId) return null;
    return recordValue(devices[room.deviceId]);
}

function findEventRoom(
    raw: Record<string, unknown>,
    byUid: ReadonlyMap<string, FacilityRoom>,
    byDevice: ReadonlyMap<string, FacilityRoom>,
    byName: ReadonlyMap<string, FacilityRoom>,
): FacilityRoom | null {
    const uid = typeof raw['roomUid'] === 'string' ? raw['roomUid'] : '';
    if (uid && byUid.has(uid)) return byUid.get(uid) ?? null;
    const deviceId = typeof raw['deviceId'] === 'string' ? raw['deviceId'] : '';
    if (deviceId && byDevice.has(deviceId)) return byDevice.get(deviceId) ?? null;
    const storedName = cleanStoredText(raw['roomName'], 100);
    return storedName ? byName.get(roomKey(storedName)) ?? null : null;
}

function telemetryFact(row: RoomTelemetryRow, room: FacilityRoom): string {
    if (!room.deviceAssigned) {
        return `${row.roomName} is active with no assigned device; live telemetry is unavailable.`;
    }
    if (!room.deviceId || row.lastSeen === null && row.temperature === null && row.humidity === null) {
        return `${row.roomName} is active but its assigned-device telemetry is unavailable.`;
    }
    const parts = [
        `${row.roomName}: device ${row.onlineState}`,
        `condition ${row.condition}`,
        row.temperature === null ? 'temperature unavailable' : `${row.temperature} °C`,
        row.humidity === null ? 'humidity unavailable' : `${row.humidity}% humidity`,
        row.occupancy === null ? 'occupancy unavailable' : row.occupancy ? 'occupied' : 'unoccupied',
        row.acPower === null ? 'AC state unavailable' : row.acPower ? 'AC on' : 'AC off',
        `AI auto-apply ${row.aiAutoApply ? 'enabled' : 'disabled'}`,
        `${row.schedules.length} schedules`,
    ];
    if (row.lastSeen) parts.push(`last seen ${row.lastSeen}`);
    return `${parts.join(', ')}.`;
}

function telemetrySummary(rooms: readonly RoomTelemetryRow[]): string {
    const online = rooms.filter((room) => room.onlineState === 'online').length;
    const hot = rooms.filter((room) => room.condition === 'hot' || room.condition === 'critical').length;
    return `${online} of ${rooms.length} selected active rooms are online; ${hot} have a hot or critical heat condition.`;
}

function climateFact(row: ClimateSuggestionRow): string {
    switch (row.status) {
        case 'no_device':
            return `${row.roomName} has no assigned device and therefore no device climate suggestion.`;
        case 'device_unavailable':
            return `${row.roomName}'s assigned-device climate data is unavailable.`;
        case 'no_suggestion':
            return `${row.roomName} has no valid stored climate suggestion.`;
        case 'available': {
            const values = [
                `${row.roomName} has a stored suggestion of ${row.suggestedTemp} °C`,
                row.currentRoomTemp === null ? null : `current room temperature ${row.currentRoomTemp} °C`,
                row.humidity === null ? null : `humidity ${row.humidity}%`,
                `applied ${row.applied ? 'yes' : 'no'}`,
                `auto-apply ${row.autoApplyEnabled ? 'enabled' : 'disabled'}`,
                row.updatedAt ? `updated ${row.updatedAt}` : null,
                row.reason ? `stored reason: "${row.reason}"` : 'no stored reason',
            ].filter((value): value is string => value !== null);
            return `${values.join(', ')}.`;
        }
    }
}

function recentEventFact(event: RecentEventRow): string {
    const fields = [
        `${event.roomName}: ${event.eventType} at ${event.updatedAt}`,
        event.mode ? `mode ${event.mode}` : null,
        event.applied === null ? null : `applied ${event.applied ? 'yes' : 'no'}`,
        `detail: "${event.detail}"`,
    ].filter((value): value is string => value !== null);
    return `${fields.join(', ')}.`;
}

function emptyClimateRow(
    roomName: string,
    status: Exclude<ClimateSuggestionRow['status'], 'available'>,
): ClimateSuggestionRow {
    return {
        roomName,
        status,
        currentRoomTemp: null,
        humidity: null,
        suggestedTemp: null,
        reason: null,
        applied: false,
        autoApplyEnabled: false,
        updatedAt: null,
    };
}

function parseSchedules(value: unknown): RoomTelemetryRow['schedules'] {
    const values = Array.isArray(value)
        ? value
        : isRecord(value)
            ? Object.values(value)
            : [];
    return values
        .filter(isRecord)
        .map((schedule) => {
            const day = cleanStoredText(schedule['day'], 12);
            const startTime = safeClockTime(schedule['startTime']);
            const endTime = safeClockTime(schedule['endTime']);
            const subject = cleanStoredText(schedule['subject'], 100);
            if (!day || !WEEK_DAYS.has(day) || !startTime || !endTime || !subject) return null;
            return { day, startTime, endTime, subject };
        })
        .filter((schedule): schedule is NonNullable<typeof schedule> => schedule !== null)
        .slice(0, 30);
}

function onlineStateFor(lastSeen: string | null, now: Date): DeviceOnlineState {
    if (!lastSeen) return 'offline';
    const age = now.getTime() - new Date(lastSeen).getTime();
    if (age < -2 * 60_000) return 'offline';
    if (age < 2 * 60_000) return 'online';
    if (age < 5 * 60_000) return 'stale';
    return 'offline';
}

function roomCondition(temperature: number | null, humidity: number | null): RoomCondition {
    if (temperature === null) return 'unknown';
    const heatIndex = computeHeatIndex(temperature, humidity);
    if (heatIndex >= 38) return 'critical';
    if (heatIndex >= 34) return 'hot';
    if (heatIndex >= 30) return 'warm';
    return 'comfortable';
}

function computeHeatIndex(temperature: number, humidity: number | null): number {
    if (humidity === null) return temperature;
    const fahrenheit = temperature * 9 / 5 + 32;
    const result =
        -42.379 +
        2.04901523 * fahrenheit +
        10.14333127 * humidity -
        0.22475541 * fahrenheit * humidity -
        0.00683783 * fahrenheit * fahrenheit -
        0.05481717 * humidity * humidity +
        0.00122874 * fahrenheit * fahrenheit * humidity +
        0.00085282 * fahrenheit * humidity * humidity -
        0.00000199 * fahrenheit * fahrenheit * humidity * humidity;
    const celsius = (result - 32) * 5 / 9;
    return Number.isFinite(celsius) ? celsius : temperature;
}

function buildUnavailableResult(
    plan: PlannerToolPlan,
    ordinal: number,
    now: Date,
): ToolExecutionResult {
    const id = `tool-${ordinal}`;
    let presentation: ChatPresentation;
    switch (plan.name) {
        case 'get_room_telemetry':
            presentation = { kind: 'room-telemetry', id, title: 'Room telemetry unavailable', rooms: [] };
            break;
        case 'get_energy_report':
            presentation = {
                kind: 'energy-report',
                id,
                title: 'Estimated energy report unavailable',
                estimated: true,
                range: resolveEnergyRange(plan, now),
                metrics: {
                    totalKwh: 0,
                    runtimeSeconds: 0,
                    sessionCount: 0,
                    activeRooms: 0,
                    roomsWithRecords: 0,
                    coveragePercent: 0,
                },
                trend: [],
                rooms: [],
            };
            break;
        case 'get_climate_prediction_logs':
            presentation = { kind: 'climate-suggestions', id, title: 'Climate suggestions unavailable', rooms: [] };
            break;
        case 'get_recent_room_events':
            presentation = { kind: 'recent-events', id, title: 'Recent room events unavailable', events: [] };
            break;
        case 'get_system_help':
            presentation = {
                kind: 'system-help',
                id,
                title: 'System help unavailable',
                topic: normalizeTopic(plan.topic),
                steps: [],
                route: null,
                restricted: false,
            };
            break;
    }
    return {
        name: plan.name,
        presentation,
        facts: [{
            id: `t${ordinal}.unavailable`,
            statement: `The requested ${toolLabel(plan.name)} data could not be read safely.`,
        }],
        notices: [`The requested ${toolLabel(plan.name)} data is temporarily unavailable.`],
        partial: true,
    };
}

function validatePlans(plans: readonly PlannerToolPlan[]): PlannerToolPlan[] {
    if (!Array.isArray(plans) || plans.length > MAX_TOOL_PLANS) {
        throw new ChatApiError('invalid_request', `At most ${MAX_TOOL_PLANS} tool plans may run per turn.`, 400);
    }
    const seen = new Set<ChatToolName>();
    return plans.map((plan) => {
        if (!plan || !ALLOWED_TOOLS.includes(plan.name)) {
            throw new ChatApiError('invalid_request', 'An unknown or unsafe chat tool was requested.', 400);
        }
        if (seen.has(plan.name)) {
            throw new ChatApiError('invalid_request', 'Duplicate chat tools are not allowed in one turn.', 400);
        }
        seen.add(plan.name);
        if (!Array.isArray(plan.roomNames) || plan.roomNames.length > MAX_REQUESTED_ROOMS) {
            throw new ChatApiError('invalid_request', 'The requested room scope is invalid.', 400);
        }
        const roomNames = uniqueStrings(
            plan.roomNames.map((roomName: unknown) => validateRequestedText(roomName, 100)),
        );
        if (!ENERGY_PRESETS.has(plan.rangePreset) || !ENERGY_BUCKETS.has(plan.bucket)) {
            throw new ChatApiError('invalid_request', 'The requested energy range is invalid.', 400);
        }
        if (typeof plan.startDate !== 'string' || plan.startDate.length > 10 ||
            typeof plan.endDate !== 'string' || plan.endDate.length > 10) {
            throw new ChatApiError('invalid_request', 'The requested energy dates are invalid.', 400);
        }
        if (typeof plan.topic !== 'string' || plan.topic.length > 64 || hasUnsafeControls(plan.topic)) {
            throw new ChatApiError('invalid_request', 'The requested help topic is invalid.', 400);
        }
        if (!Number.isInteger(plan.limit) || plan.limit < 1 || plan.limit > MAX_EVENTS_RETURNED) {
            throw new ChatApiError('invalid_request', 'The requested result limit is invalid.', 400);
        }
        return { ...plan, roomNames, topic: plan.topic.trim() };
    });
}

function shouldPropagate(reason: unknown): boolean {
    if (!(reason instanceof ChatApiError)) return false;
    return reason.code === 'authentication_required' ||
        reason.code === 'account_not_authorized' ||
        reason.code === 'facility_too_large' ||
        reason.code === 'configuration_error' ||
        reason.code === 'invalid_request';
}

function normalizedTimestamp(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 64 || hasUnsafeControls(value)) return null;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function safeClockTime(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(value);
    return match ? match[0] : null;
}

function cleanStoredText(value: unknown, maximumLength: number): string | null {
    if (typeof value !== 'string') return null;
    const cleaned = value
        .normalize('NFKC')
        .replace(/[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, ' ')
        .replace(/\s+/gu, ' ')
        .replace(/https:\/\/[^\s"'<>]*(?:firebaseio\.com|firebasedatabase\.app)[^\s"'<>]*/giu, '[internal database reference]')
        .replace(/\b(?:users|devices|rooms|decisionLogs|energy|logs)\/[A-Za-z0-9_.~%-]+(?:\/[A-Za-z0-9_.~%-]+)*/giu, '[internal data reference]')
        .replace(/\bBearer\s+[^\s,;]+/giu, '[redacted credential]')
        .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, '[redacted credential]')
        .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/gu, '[redacted credential]')
        .replace(/\b(?:api[_-]?key|access[_-]?token|id[_-]?token)\s*[:=]\s*[^\s,;]+/giu, '[redacted credential]')
        .replace(/[<>]/g, ' ')
        .replace(/`{3,}/g, '')
        .replace(/\s+/gu, ' ')
        .trim();
    if (!cleaned) return null;
    return Array.from(cleaned).slice(0, maximumLength).join('');
}

function validateRequestedText(value: unknown, maximumLength: number): string {
    if (typeof value !== 'string' || !value.trim() ||
        Array.from(value).length > maximumLength || hasUnsafeControls(value)) {
        throw new ChatApiError('invalid_request', 'A requested room name is invalid.', 400);
    }
    return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function hasUnsafeControls(value: string): boolean {
    return /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/.test(value);
}

function nestedValue(record: Record<string, unknown> | null, key: string, nestedKey: string): unknown {
    const nested = recordValue(record?.[key]);
    return nested?.[nestedKey];
}

function recordValue(value: unknown): Record<string, unknown> | null {
    return isRecord(value) ? value : null;
}

function strictBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
        ? value
        : null;
}

function firstNumber(...values: Array<number | null>): number | null {
    return values.find((value): value is number => value !== null) ?? null;
}

function roundNullable(value: number | null, decimals: number): number | null {
    return value === null ? null : round(value, decimals);
}

function round(value: number, decimals: number): number {
    const factor = 10 ** decimals;
    return Math.round((value + Number.EPSILON) * factor) / factor;
}

function normalizeTopic(value: string): string {
    return (cleanStoredText(value, 64) ?? '').toLowerCase().replace(/[\s_]+/g, '-');
}

function roomKey(value: string): string {
    return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

function isSafeFirebaseKey(value: string): boolean {
    return value.length > 0 && value.length <= 768 && !/[.#$\[\]/\u0000-\u001F\u007F]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uniqueStrings(values: readonly string[]): string[] {
    return [...new Set(values)];
}

async function allSettledBounded<T, R>(
    values: readonly T[],
    concurrency: number,
    worker: (value: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
    const results: Array<PromiseSettledResult<R>> = new Array(values.length);
    let nextIndex = 0;
    const runner = async (): Promise<void> => {
        while (nextIndex < values.length) {
            const index = nextIndex;
            nextIndex += 1;
            try {
                results[index] = { status: 'fulfilled', value: await worker(values[index]!, index) };
            } catch (reason: unknown) {
                results[index] = { status: 'rejected', reason };
            }
        }
    };
    const runnerCount = Math.min(Math.max(1, concurrency), values.length);
    await Promise.all(Array.from({ length: runnerCount }, () => runner()));
    return results;
}

async function settlePromise<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
    try {
        return { status: 'fulfilled', value: await promise };
    } catch (reason: unknown) {
        return { status: 'rejected', reason };
    }
}

function toolLabel(name: ChatToolName): string {
    switch (name) {
        case 'get_room_telemetry': return 'room telemetry';
        case 'get_energy_report': return 'energy report';
        case 'get_climate_prediction_logs': return 'climate suggestion';
        case 'get_recent_room_events': return 'recent event';
        case 'get_system_help': return 'system help';
    }
}
