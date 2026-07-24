import { Injectable } from '@angular/core';
import { Room } from '../models/room.model';
import { Device } from '../models/esp.model';
import { EnergyDaily } from '../models/energy.model';
import { ChatToolCall, ChatToolResult, ChatUserRole } from '../models/chat.models';
import { RoomService } from './room.service';
import { DeviceService, getDeviceOnlineState } from './device.service';
import {
    EnergyReportService,
    getTodayKey,
    getLast7DayKeys,
    getLast8WeekRanges,
    getLast12MonthKeys,
    getLast5YearKeys,
    sumKwhByDate,
    sumKwhByWeek,
    sumKwhByMonth,
    sumKwhByYear,
    sumKwhByDateForDevice,
    sumKwhByWeekForDevice,
    sumKwhByMonthForDevice,
    sumKwhByYearForDevice,
} from './energy-report.service';
import { LoggerService } from './logger.service';
import { getSystemHelpEntry } from '../helpers/system-help-content';
import { roundAllNumbers, cleanTimestamp } from '../helpers/chat-response-cleaner';

type EnergyByDevice = Record<string, Record<string, EnergyDaily>>;

/**
 * Executes the five chatbot tools by wrapping existing services —
 * RoomService, DeviceService, EnergyReportService — rather than opening
 * new Firebase listeners, per the project's no-duplicate-services rule.
 * Each execute* method resolves once (not a live stream); the chatbot
 * needs a single snapshot per question, not an ongoing subscription.
 */
@Injectable({ providedIn: 'root' })
export class ChatToolsService {
    constructor(
        private roomService: RoomService,
        private deviceService: DeviceService,
        private energyReportService: EnergyReportService,
        private logger: LoggerService,
    ) { }

    /**
     * Single entry point used by chat.service.ts. Applies the Admin-only
     * role check before dispatching to a specific tool executor — see
     * Phase 7 of the plan.
     */
    async executeTool(toolCall: ChatToolCall, userRole: ChatUserRole): Promise<ChatToolResult> {
        try {
            const data = await this.dispatch(toolCall, userRole);
            return { name: toolCall.name, data, fetchedAt: new Date().toISOString() };
        } catch (err) {
            this.logger.error('Chat tool execution failed', err, {
                service: 'ChatToolsService',
                tool: toolCall.name,
                args: toolCall.args,
            });
            throw err;
        }
    }

    private async dispatch(toolCall: ChatToolCall, userRole: ChatUserRole): Promise<unknown> {
        switch (toolCall.name) {
            case 'get_room_telemetry':
                return this.getRoomTelemetry(toolCall.args as { roomName?: string });
            case 'get_energy_rankings':
                return this.getEnergyRankings(
                    toolCall.args as { acStatus?: 'active' | 'standby' | 'all'; limit?: number },
                );
            case 'get_energy_usage':
                return this.getEnergyUsage(
                    toolCall.args as {
                        scope: 'facility' | 'room';
                        roomName?: string;
                        period: 'daily' | 'weekly' | 'monthly' | 'yearly';
                    },
                );
            case 'get_climate_prediction_logs':
                return this.getClimatePredictionLogs(toolCall.args as { roomName: string });
            case 'get_system_help':
                return this.getSystemHelp(toolCall.args as { topic: string }, userRole);
            default:
                throw new Error(`Unknown tool: ${toolCall.name}`);
        }
    }



    private async getRoomTelemetry(args: { roomName?: string }): Promise<unknown> {
        const rooms = await this.getRoomsOnce();
        const devices = await this.getDevicesOnce();

        const targetRooms = args.roomName
            ? rooms.filter((r) => this.matchesRoomName(r.roomName, args.roomName!))
            : rooms;

        const results = targetRooms.map((room) => this.buildRoomTelemetryEntry(room, devices));
        return roundAllNumbers(results);
    }

    private buildRoomTelemetryEntry(room: Room, devices: Record<string, Device>): unknown {
        const device = devices[room.device];
        const onlineState = getDeviceOnlineState(device?.status?.lastSeen);

        return {
            roomName: room.roomName,
            status: room.status,
            onlineState,
            temperature: device?.temperature ?? room.temperature ?? null,
            humidity: device?.humidity ?? room.humidity ?? null,
            occupancy: device?.occupancy ?? room.occupancy ?? null,
            acPower: device?.acState?.power ?? room.power ?? null,
            aiAutoApply: device?.control?.aiAutoApply ?? false,
            activeSchedulesCount: room.schedules?.length ?? 0,
            lastSeen: cleanTimestamp(device?.status?.lastSeen ?? null),
        };
    }


    private async getEnergyRankings(args: {
        acStatus?: 'active' | 'standby' | 'all';
        limit?: number;
    }): Promise<unknown> {
        const rooms = await this.getRoomsOnce();
        const devices = await this.getDevicesOnce();
        const energyData = await this.getEnergyDailyOnce();
        const today = getTodayKey();

        const filterStatus = args.acStatus ?? 'all';
        const limit = args.limit ?? 5;

        const ranked = rooms
            .filter((room) => room.device)
            .map((room) => {
                const device = devices[room.device];
                const acPower = device?.acState?.power ?? false;
                const kwhToday = sumKwhByDateForDevice(energyData, room.device, today);
                return { roomName: room.roomName, acPower, kwhToday };
            })
            .filter((entry) => {
                if (filterStatus === 'all') return true;
                if (filterStatus === 'active') return entry.acPower === true;
                return entry.acPower !== true;
            })
            .sort((a, b) => b.kwhToday - a.kwhToday)
            .slice(0, limit);

        return roundAllNumbers(ranked);
    }



    private async getEnergyUsage(args: {
        scope: 'facility' | 'room';
        roomName?: string;
        period: 'daily' | 'weekly' | 'monthly' | 'yearly';
    }): Promise<unknown> {
        const energyData = await this.getEnergyDailyOnce();

        if (args.scope === 'room') {
            if (!args.roomName) {
                throw new Error('roomName is required when scope is "room"');
            }
            const room = await this.findRoomByName(args.roomName);
            if (!room?.device) {
                return { roomName: args.roomName, found: false, series: [] };
            }
            return {
                roomName: room.roomName,
                found: true,
                series: this.buildUsageSeries(energyData, args.period, room.device),
            };
        }

        return { scope: 'facility', series: this.buildUsageSeries(energyData, args.period) };
    }

    private buildUsageSeries(
        energyData: EnergyByDevice,
        period: 'daily' | 'weekly' | 'monthly' | 'yearly',
        deviceId?: string,
    ): Array<{ label: string; kwh: number }> {
        if (period === 'daily') {
            return getLast7DayKeys().map((day) => ({
                label: day,
                kwh: deviceId
                    ? sumKwhByDateForDevice(energyData, deviceId, day)
                    : sumKwhByDate(energyData, day),
            }));
        }
        if (period === 'weekly') {
            return getLast8WeekRanges().map((wk) => ({
                label: wk.label,
                kwh: deviceId
                    ? sumKwhByWeekForDevice(energyData, deviceId, wk.start, wk.end)
                    : sumKwhByWeek(energyData, wk.start, wk.end),
            }));
        }
        if (period === 'monthly') {
            return getLast12MonthKeys().map((month) => ({
                label: month,
                kwh: deviceId
                    ? sumKwhByMonthForDevice(energyData, deviceId, month)
                    : sumKwhByMonth(energyData, month),
            }));
        }
        return getLast5YearKeys().map((year) => ({
            label: year,
            kwh: deviceId
                ? sumKwhByYearForDevice(energyData, deviceId, year)
                : sumKwhByYear(energyData, year),
        }));
    }



    private async getClimatePredictionLogs(args: { roomName: string }): Promise<unknown> {
        const room = await this.findRoomByName(args.roomName);
        if (!room?.device) {
            return { roomName: args.roomName, found: false };
        }
        const devices = await this.getDevicesOnce();
        const suggestion = devices[room.device]?.mlSuggestion;

        if (!suggestion) {
            return { roomName: room.roomName, found: false };
        }

        return {
            roomName: room.roomName,
            found: true,
            currentRoomTemp: suggestion.currentRoomTemp ?? null,
            humidity: suggestion.humidity ?? null,
            suggestedTemp: suggestion.suggestedTemp ?? null,
            reason: suggestion.reason ?? null,
            applied: suggestion.applied ?? false,
            autoApplyEnabled: suggestion.autoApplyEnabled ?? false,
            updatedAt: cleanTimestamp(suggestion.updatedAt ?? null),
        };
    }



    private getSystemHelp(args: { topic: string }, userRole: ChatUserRole): unknown {
        const entry = getSystemHelpEntry(args.topic);
        if (!entry) {
            return { topic: args.topic, found: false };
        }
        if (entry.adminOnly && userRole !== 'admin') {
            return { topic: args.topic, found: true, restricted: true };
        }
        return { found: true, restricted: false, ...entry };
    }



    private matchesRoomName(roomName: string, query: string): boolean {
        return roomName.trim().toLowerCase() === query.trim().toLowerCase();
    }

    private async findRoomByName(roomName: string): Promise<Room | undefined> {
        const rooms = await this.getRoomsOnce();
        return rooms.find((r) => this.matchesRoomName(r.roomName, roomName));
    }

    /** Converts RoomService's live stream into a single resolved snapshot. */
    private getRoomsOnce(): Promise<Room[]> {
        return new Promise((resolve, reject) => {
            let unsub: (() => void) | undefined;
            let settled = false;

            unsub = this.roomService.streamRooms(
                (rooms) => {
                    if (settled) return;
                    settled = true;
                    unsub?.();
                    resolve(rooms);
                },
                (err) => {
                    if (settled) return;
                    settled = true;
                    unsub?.();
                    reject(err);
                },
            );

            if (settled) {
                // Callback already fired synchronously before unsub was assigned above.
                unsub?.();
            }
        });
    }

    /** Converts DeviceService's live stream into a single resolved snapshot. */
    private getDevicesOnce(): Promise<Record<string, Device>> {
        return new Promise((resolve, reject) => {
            let unsub: (() => void) | undefined;
            let settled = false;

            unsub = this.deviceService.streamDevices(
                (devices) => {
                    if (settled) return;
                    settled = true;
                    unsub?.();
                    resolve(devices);
                },
                (err) => {
                    if (settled) return;
                    settled = true;
                    unsub?.();
                    reject(err);
                },
            );

            if (settled) {
                unsub?.();
            }
        });
    }

    /** Converts EnergyReportService's live stream into a single resolved snapshot. */
    private getEnergyDailyOnce(): Promise<EnergyByDevice> {
        return new Promise((resolve, reject) => {
            let unsub: (() => void) | undefined;
            let settled = false;

            unsub = this.energyReportService.AllEnergyDaily(
                (data) => {
                    if (settled) return;
                    settled = true;
                    unsub?.();
                    resolve(data);
                },
                (err) => {
                    if (settled) return;
                    settled = true;
                    unsub?.();
                    reject(err);
                },
            );

            if (settled) {
                unsub?.();
            }
        });
    }


}