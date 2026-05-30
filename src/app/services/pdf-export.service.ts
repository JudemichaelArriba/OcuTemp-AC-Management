import { Injectable } from '@angular/core';
import jsPDF from 'jspdf';
import autoTable, { UserOptions } from 'jspdf-autotable';

import { ReportSummary } from '../models/report-summary.model';
import { Room } from '../models/room.model';
import { EnergyDaily } from '../models/energy.model';
import {
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

interface KpiCard {
    label: string;
    value: string;
    sublabel: string;
}

@Injectable({ providedIn: 'root' })
export class PdfExportService {
    private readonly W  = 210;
    private readonly H  = 297;
    private readonly M  = 20;
    private readonly CW = 170;

    private _logoBase64: string | null = null;

    async generateEnergyReport(
        energyData: Record<string, Record<string, EnergyDaily>>,
        rooms: Room[],
        summary: ReportSummary
    ): Promise<void> {
        this._logoBase64 = await this.loadImageAsBase64('/logo.png').catch(() => null);

        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

        const todayKey = getTodayKey();
        const todayKwh = Object.values(energyData)
            .reduce((sum, deviceDays) => sum + (deviceDays[todayKey]?.estimatedKwh ?? 0), 0)
            .toFixed(4);

        const days7   = getLast7DayKeys();
        const weekKwh = days7
            .reduce((sum, d) =>
                sum + Object.values(energyData)
                    .reduce((s, deviceDays) => s + (deviceDays[d]?.estimatedKwh ?? 0), 0)
            , 0)
            .toFixed(4);

        this.buildCoverPage(doc, summary, todayKwh, weekKwh);
        doc.addPage();
        this.buildTrendSection(doc, energyData);
        doc.addPage();
        this.buildRoomSection(doc, energyData, rooms);
        this.stampPageNumbers(doc);

        doc.save(`energy-report-${todayKey}.pdf`);
        this._logoBase64 = null;
    }

    private buildCoverPage(
        doc: jsPDF,
        summary: ReportSummary,
        todayKwh: string,
        weekKwh: string
    ): void {
        doc.setFillColor(37, 99, 235);
        doc.rect(0, 0, this.W, 68, 'F');

        doc.setFillColor(29, 78, 216);
        doc.rect(0, 62, this.W, 6, 'F');

        // ── FIXED: larger logo, properly vertically centred in the header band ──
        const LOGO_SIZE = 16;           // was 11 — now noticeably bigger
        const LOGO_Y    = 5;            // top of logo, giving a 5 mm top margin

        if (this._logoBase64) {
            doc.addImage(this._logoBase64, 'PNG', this.M, LOGO_Y, LOGO_SIZE, LOGO_SIZE);
        }

        const brandTextX = this._logoBase64 ? this.M + LOGO_SIZE + 3 : this.M;

        // Vertically centre the brand text against the logo
        // baseline = logo_top + logo_height/2 + half cap-height of 15 pt ≈ 2.7 mm
        const brandTextY = LOGO_Y + LOGO_SIZE / 2 + 2.7;

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(15);
        doc.setTextColor(255, 255, 255);
        doc.text('OCUTEMP', brandTextX, brandTextY);

        doc.setDrawColor(255, 255, 255);
        doc.setLineWidth(0.25);
        doc.setLineDashPattern([], 0);
        doc.setGState(new (doc as any).GState({ opacity: 0.35 }));
        doc.line(this.M, LOGO_Y + LOGO_SIZE + 2, this.W - this.M, LOGO_Y + LOGO_SIZE + 2);
        doc.setGState(new (doc as any).GState({ opacity: 1 }));

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(24);
        doc.setTextColor(255, 255, 255);
        doc.text('Facility Energy Report', this.M, 38);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9.5);
        doc.setTextColor(219, 234, 254);
        doc.text('System Telemetrics — Comprehensive Consumption Analysis', this.M, 46);

        doc.setDrawColor(255, 255, 255);
        doc.setLineWidth(0.3);
        doc.setLineDashPattern([1, 2], 0);
        doc.line(this.M, 53, this.W - this.M, 53);
        doc.setLineDashPattern([], 0);

        const genDate = new Date().toLocaleString('en-US', {
            timeZone:  'Asia/Manila',
            weekday:   'long',
            year:      'numeric',
            month:     'long',
            day:       'numeric',
            hour:      '2-digit',
            minute:    '2-digit',
        });
        doc.setFontSize(8);
        doc.setTextColor(219, 234, 254);
        doc.text(`Generated: ${genDate}  ·  Asia/Manila (PHT, UTC+8)`, this.M, 61);

        this.drawSectionHeader(doc, 'REPORT SUMMARY', summary.monthLabel, 76);

        this.drawKpiRow(doc, 94, [
            { label: "Today's Usage",  value: `${todayKwh} kWh`,        sublabel: 'Current day'      },
            { label: '7-Day Usage',    value: `${weekKwh} kWh`,          sublabel: 'Last 7 days'      },
            { label: 'Monthly Usage',  value: `${summary.totalKwh} kWh`, sublabel: summary.monthLabel },
            { label: 'Active Rooms',   value: `${summary.activeRooms}`,  sublabel: 'Monitored units'  },
        ]);

        autoTable(doc, {
            startY: 124,
            head: [['Metric', 'Value', 'Notes']],
            body: [
                ['Total Monthly Consumption', `${summary.totalKwh} kWh`,     'Estimated load profile'  ],
                ['Total Monthly Runtime',      summary.totalRuntime,          'Aggregate device uptime' ],
                ['Active Monitored Rooms',    `${summary.activeRooms} Rooms`, 'Live-streamed units'     ],
                ['Report Period',              summary.monthLabel,            'Current billing month'   ],
                ['Data Source',               'Firebase Realtime Database',   'Live stream aggregation' ],
            ],
            ...this.baseTableOptions(),
            columnStyles: {
                0: { fontStyle: 'bold', cellWidth: 68 },
                1: { textColor: [37, 99, 235], fontStyle: 'bold', cellWidth: 52 },
                2: { textColor: [100, 116, 139], cellWidth: 50 },
            },
            margin: { left: this.M, right: this.M },
        } as UserOptions);

        const afterY = (doc as any).lastAutoTable?.finalY ?? 179;
        doc.setFontSize(7);
        doc.setTextColor(148, 163, 184);
        doc.setFont('helvetica', 'italic');
        doc.text(
            'All energy values are estimates based on device runtime × fixed wattage profiles. Not to be used for billing.',
            this.M,
            afterY + 10
        );
    }

    private drawKpiRow(doc: jsPDF, y: number, cards: KpiCard[]): void {
        const cardH = 22;
        const gap   = 4;
        const cardW = (this.CW - gap * (cards.length - 1)) / cards.length;

        cards.forEach((card, i) => {
            const x = this.M + i * (cardW + gap);

            doc.setFillColor(248, 250, 252);
            doc.roundedRect(x, y, cardW, cardH, 2, 2, 'F');

            doc.setFillColor(37, 99, 235);
            doc.roundedRect(x, y, cardW, 3, 1, 1, 'F');
            doc.rect(x, y + 1.5, cardW, 1.5, 'F');

            doc.setFont('helvetica', 'normal');
            doc.setFontSize(7);
            doc.setTextColor(100, 116, 139);
            doc.text(card.label, x + cardW / 2, y + 8, { align: 'center' });

            doc.setFont('helvetica', 'bold');
            doc.setFontSize(10);
            doc.setTextColor(37, 99, 235);
            doc.text(card.value, x + cardW / 2, y + 15, { align: 'center' });

            doc.setFont('helvetica', 'normal');
            doc.setFontSize(6.5);
            doc.setTextColor(148, 163, 184);
            doc.text(card.sublabel, x + cardW / 2, y + 20, { align: 'center' });
        });
    }

    private buildTrendSection(
        doc: jsPDF,
        energyData: Record<string, Record<string, EnergyDaily>>
    ): void {
        this.drawSectionHeader(
            doc,
            'OVERALL CONSUMPTION TREND',
            'Facility-wide energy usage aggregated across all devices',
            20
        );

        let y = 38;

        y = this.drawSubHeader(doc, 'Daily View', 'Last 7 days', y);
        const days       = getLast7DayKeys();
        const dailyBody  = days.map((d) => [this.formatDate(d), `${sumKwhByDate(energyData, d).toFixed(4)} kWh`]);
        const dailyTotal = days.reduce((s, d) => s + sumKwhByDate(energyData, d), 0);
        autoTable(doc, {
            startY: y,
            head: [['Date', 'Consumption']],
            body: dailyBody,
            foot: [['7-Day Total', `${dailyTotal.toFixed(4)} kWh`]],
            ...this.baseTableOptions(),
            margin: { left: this.M, right: this.M },
        } as UserOptions);
        y = ((doc as any).lastAutoTable?.finalY ?? y) + 8;

        y = this.checkBreak(doc, y, 65);
        y = this.drawSubHeader(doc, 'Weekly View', 'Last 8 weeks', y);
        const weeks        = getLast8WeekRanges();
        const weeklyBody   = weeks.map((w) => [`${this.formatDate(w.start)} – ${this.formatDate(w.end)}`, `${sumKwhByWeek(energyData, w.start, w.end).toFixed(4)} kWh`]);
        const weeklyTotal  = weeks.reduce((s, w) => s + sumKwhByWeek(energyData, w.start, w.end), 0);
        autoTable(doc, {
            startY: y,
            head: [['Week Period', 'Consumption']],
            body: weeklyBody,
            foot: [['8-Week Total', `${weeklyTotal.toFixed(4)} kWh`]],
            ...this.baseTableOptions(),
            margin: { left: this.M, right: this.M },
        } as UserOptions);
        y = ((doc as any).lastAutoTable?.finalY ?? y) + 8;

        y = this.checkBreak(doc, y, 70);
        y = this.drawSubHeader(doc, 'Monthly View', 'Last 12 months', y);
        const months       = getLast12MonthKeys();
        const monthlyBody  = months.map((m) => {
            const [yr, mo] = m.split('-');
            return [
                new Date(+yr, +mo - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' }),
                `${sumKwhByMonth(energyData, m).toFixed(4)} kWh`,
            ];
        });
        const monthlyTotal = months.reduce((s, m) => s + sumKwhByMonth(energyData, m), 0);
        autoTable(doc, {
            startY: y,
            head: [['Month', 'Consumption']],
            body: monthlyBody,
            foot: [['12-Month Total', `${monthlyTotal.toFixed(4)} kWh`]],
            ...this.baseTableOptions(),
            margin: { left: this.M, right: this.M },
        } as UserOptions);
        y = ((doc as any).lastAutoTable?.finalY ?? y) + 8;

        y = this.checkBreak(doc, y, 50);
        y = this.drawSubHeader(doc, 'Yearly View', 'Last 5 years', y);
        const years       = getLast5YearKeys();
        const yearlyBody  = years.map((yr) => [yr, `${sumKwhByYear(energyData, yr).toFixed(4)} kWh`]);
        const yearlyTotal = years.reduce((s, yr) => s + sumKwhByYear(energyData, yr), 0);
        autoTable(doc, {
            startY: y,
            head: [['Year', 'Consumption']],
            body: yearlyBody,
            foot: [['5-Year Total', `${yearlyTotal.toFixed(4)} kWh`]],
            ...this.baseTableOptions(),
            margin: { left: this.M, right: this.M },
        } as UserOptions);
    }

    private buildRoomSection(
        doc: jsPDF,
        energyData: Record<string, Record<string, EnergyDaily>>,
        rooms: Room[]
    ): void {
        this.drawSectionHeader(
            doc,
            'PER-ROOM ENERGY BREAKDOWN',
            'Individual unit consumption across all periods',
            20
        );

        let y = 38;

        if (rooms.length === 0) {
            doc.setFontSize(9);
            doc.setTextColor(100, 116, 139);
            doc.text('No active rooms found.', this.M, y + 6);
            return;
        }

        y = this.drawSubHeader(doc, 'Room Comparison Overview', 'All rooms across all filter periods', y);

        const days7    = getLast7DayKeys();
        const start7   = days7[0];
        const end7     = days7[days7.length - 1];
        const today    = end7;
        const monthKey = today.slice(0, 7);
        const years5   = getLast5YearKeys();

        const compBody = rooms.map((room) => {
            const daily   = sumKwhByDateForDevice(energyData, room.device, today).toFixed(3);
            const weekly  = sumKwhByWeekForDevice(energyData, room.device, start7, end7).toFixed(3);
            const monthly = sumKwhByMonthForDevice(energyData, room.device, monthKey).toFixed(3);
            const yearly  = years5
                .reduce((s, yr) => s + sumKwhByYearForDevice(energyData, room.device, yr), 0)
                .toFixed(3);
            return [room.roomName, room.device, `${daily} kWh`, `${weekly} kWh`, `${monthly} kWh`, `${yearly} kWh`];
        });

        autoTable(doc, {
            startY: y,
            head: [['Room', 'Device', 'Today', 'Last 7 Days', 'This Month', 'Last 5 Yrs']],
            body: compBody,
            headStyles: { fillColor: [37, 99, 235], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
            bodyStyles: { fontSize: 8, textColor: [30, 41, 59] },
            alternateRowStyles: { fillColor: [248, 250, 252] },
            columnStyles: {
                0: { fontStyle: 'bold', cellWidth: 30 },
                1: { textColor: [100, 116, 139], cellWidth: 28 },
                2: { textColor: [37, 99, 235], cellWidth: 26 },
                3: { textColor: [37, 99, 235], cellWidth: 26 },
                4: { textColor: [37, 99, 235], cellWidth: 26 },
                5: { textColor: [37, 99, 235], cellWidth: 26 },
            },
            margin: { left: this.M, right: this.M },
        } as UserOptions);
        y = ((doc as any).lastAutoTable?.finalY ?? y) + 12;

        for (const room of rooms) {
            y = this.checkBreak(doc, y, 85);

            doc.setFillColor(37, 99, 235);
            doc.rect(this.M, y, this.CW, 10, 'F');
            doc.setTextColor(255, 255, 255);
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(10);
            doc.text(room.roomName, this.M + 4, y + 7);
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(8);
            doc.text(`Device: ${room.device}`, this.W - this.M - 4, y + 7, { align: 'right' });
            y += 14;

            const dailyData      = getLast7DayKeys().map((d) => [
                this.formatDate(d),
                `${sumKwhByDateForDevice(energyData, room.device, d).toFixed(4)} kWh`,
            ]);
            const dailyRoomTotal = getLast7DayKeys()
                .reduce((s, d) => s + sumKwhByDateForDevice(energyData, room.device, d), 0);
            autoTable(doc, {
                startY: y,
                head: [['Daily — Last 7 Days', 'Consumption']],
                body: dailyData,
                foot: [['7-Day Total', `${dailyRoomTotal.toFixed(4)} kWh`]],
                ...this.baseTableOptions(true),
                margin: { left: this.M, right: this.M },
            } as UserOptions);
            y = ((doc as any).lastAutoTable?.finalY ?? y) + 5;

            y = this.checkBreak(doc, y, 55);
            const weekRanges      = getLast8WeekRanges();
            const weeklyData      = weekRanges.map((w) => [
                `${this.formatDate(w.start)} – ${this.formatDate(w.end)}`,
                `${sumKwhByWeekForDevice(energyData, room.device, w.start, w.end).toFixed(4)} kWh`,
            ]);
            const weeklyRoomTotal = weekRanges
                .reduce((s, w) => s + sumKwhByWeekForDevice(energyData, room.device, w.start, w.end), 0);
            autoTable(doc, {
                startY: y,
                head: [['Weekly — Last 8 Weeks', 'Consumption']],
                body: weeklyData,
                foot: [['8-Week Total', `${weeklyRoomTotal.toFixed(4)} kWh`]],
                ...this.baseTableOptions(true),
                margin: { left: this.M, right: this.M },
            } as UserOptions);
            y = ((doc as any).lastAutoTable?.finalY ?? y) + 5;

            y = this.checkBreak(doc, y, 65);
            const monthlyData      = getLast12MonthKeys().map((m) => {
                const [yr, mo] = m.split('-');
                return [
                    new Date(+yr, +mo - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' }),
                    `${sumKwhByMonthForDevice(energyData, room.device, m).toFixed(4)} kWh`,
                ];
            });
            const monthlyRoomTotal = getLast12MonthKeys()
                .reduce((s, m) => s + sumKwhByMonthForDevice(energyData, room.device, m), 0);
            autoTable(doc, {
                startY: y,
                head: [['Monthly — Last 12 Months', 'Consumption']],
                body: monthlyData,
                foot: [['12-Month Total', `${monthlyRoomTotal.toFixed(4)} kWh`]],
                ...this.baseTableOptions(true),
                margin: { left: this.M, right: this.M },
            } as UserOptions);
            y = ((doc as any).lastAutoTable?.finalY ?? y) + 5;

            y = this.checkBreak(doc, y, 45);
            const yearlyData      = getLast5YearKeys().map((yr) => [
                yr,
                `${sumKwhByYearForDevice(energyData, room.device, yr).toFixed(4)} kWh`,
            ]);
            const yearlyRoomTotal = getLast5YearKeys()
                .reduce((s, yr) => s + sumKwhByYearForDevice(energyData, room.device, yr), 0);
            autoTable(doc, {
                startY: y,
                head: [['Yearly — Last 5 Years', 'Consumption']],
                body: yearlyData,
                foot: [['5-Year Total', `${yearlyRoomTotal.toFixed(4)} kWh`]],
                ...this.baseTableOptions(true),
                margin: { left: this.M, right: this.M },
            } as UserOptions);
            y = ((doc as any).lastAutoTable?.finalY ?? y) + 14;
        }
    }

    private drawSectionHeader(doc: jsPDF, title: string, subtitle: string, y: number): void {
        doc.setFillColor(248, 250, 252);
        doc.rect(this.M, y, this.CW, 14, 'F');
        doc.setFillColor(37, 99, 235);
        doc.rect(this.M, y, 3, 14, 'F');

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12);
        doc.setTextColor(30, 41, 59);
        doc.text(title, this.M + 7, y + 6);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(100, 116, 139);
        doc.text(subtitle, this.M + 7, y + 11);
    }

    private drawSubHeader(doc: jsPDF, title: string, subtitle: string, y: number): number {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.setTextColor(30, 41, 59);
        doc.text(title, this.M, y + 5);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(100, 116, 139);
        doc.text(subtitle, this.M, y + 10);

        doc.setDrawColor(37, 99, 235);
        doc.setLineWidth(0.3);
        doc.line(this.M, y + 13, this.W - this.M, y + 13);

        return y + 17;
    }

    private checkBreak(doc: jsPDF, y: number, needed: number): number {
        if (y + needed > this.H - 25) {
            doc.addPage();
            return 20;
        }
        return y;
    }

    private baseTableOptions(compact = false): Partial<UserOptions> {
        return {
            headStyles: {
                fillColor: compact ? [71, 85, 105] : [37, 99, 235],
                textColor: [255, 255, 255],
                fontStyle: 'bold',
                fontSize: compact ? 8 : 9,
            },
            bodyStyles: { fontSize: compact ? 8 : 9, textColor: [30, 41, 59] },
            footStyles: {
                fillColor: [248, 250, 252],
                textColor: [37, 99, 235],
                fontStyle: 'bold',
                fontSize: compact ? 8 : 9,
            },
            alternateRowStyles: { fillColor: [248, 250, 252] },
            columnStyles: {
                0: { textColor: [30, 41, 59] },
                1: { textColor: [37, 99, 235], fontStyle: 'bold' },
            },
        };
    }

    private formatDate(dateStr: string): string {
        if (!dateStr) return '';
        const parts = dateStr.split('-');
        if (parts.length !== 3) return dateStr;
        const [y, m, d] = parts;
        return new Date(+y, +m - 1, +d).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
        });
    }

    private stampPageNumbers(doc: jsPDF): void {
        const total    = doc.getNumberOfPages();

        // ── FIXED: larger footer logo, logo & text share the same vertical centre ──
        const LOGO_W   = 6;                   // was 5
        const LOGO_H   = 6;                   // was 5
        const TEXT_Y   = this.H - 7;          // text baseline (unchanged)
        const DIVIDER_Y = this.H - 12;        // separator line (unchanged)
        // Centre logo between divider line and text baseline
        const LOGO_FOOTER_Y = DIVIDER_Y + (TEXT_Y - DIVIDER_Y - LOGO_H) / 2;

        for (let i = 1; i <= total; i++) {
            doc.setPage(i);

            // Separator line
            doc.setDrawColor(226, 232, 240);
            doc.setLineWidth(0.3);
            doc.line(this.M, DIVIDER_Y, this.W - this.M, DIVIDER_Y);

            // Logo only on non-cover pages
            if (this._logoBase64 && i > 1) {
                doc.addImage(this._logoBase64, 'PNG', this.M, LOGO_FOOTER_Y, LOGO_W, LOGO_H);
            }

            // Brand text starts right after logo (or at margin on cover)
            const brandOffset = (this._logoBase64 && i > 1) ? LOGO_W + 2 : 0;

            doc.setFont('helvetica', 'bold');
            doc.setFontSize(7);
            doc.setTextColor(100, 116, 139);
            doc.text('OcuTemp', this.M + brandOffset, TEXT_Y);

            doc.setFont('helvetica', 'normal');
            doc.setTextColor(148, 163, 184);
            doc.text(
                '  Facility Management System — Confidential',
                this.M + brandOffset + doc.getTextWidth('OcuTemp'),
                TEXT_Y
            );

            doc.text(`Page ${i} of ${total}`, this.W - this.M, TEXT_Y, { align: 'right' });
        }
    }

    private loadImageAsBase64(url: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const img       = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const canvas  = document.createElement('canvas');
                canvas.width  = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx     = canvas.getContext('2d');
                if (!ctx) { reject(new Error('Canvas 2D context unavailable')); return; }
                ctx.drawImage(img, 0, 0);
                resolve(canvas.toDataURL('image/png'));
            };
            img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
            img.src     = url;
        });
    }
}