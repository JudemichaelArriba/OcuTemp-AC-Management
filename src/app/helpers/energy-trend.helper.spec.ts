import { EnergyDaily } from '../models/energy.model';
import {
  sumKwhByDate,
  sumKwhByMonth,
  sumKwhByWeek,
  sumKwhByYear,
} from '../services/energy-report.service';
import {
  buildEnergyTrendSeries,
  computeTrendViewport,
  getVisibleCount,
  isSameTrendSeries,
} from './energy-trend.helper';

const TODAY = '2026-11-04';

function day(estimatedKwh: number): EnergyDaily {
  return {
    estimatedKwh,
    estimatedWattsOn: 0,
    roomUid: 'room-1',
    runtimeSeconds: 0,
    sessionCount: 0,
    updatedAt: '',
  };
}

describe('buildEnergyTrendSeries', () => {
  describe('trimming', () => {
    it('removes empty periods before the first data', () => {
      const series = buildEnergyTrendSeries({ a: { '2026-03-01': day(5) } }, 'yearly', TODAY);
      expect(series.map((p) => p.key)).toEqual(['2026']);
    });

    it('keeps gaps between periods as real zeros', () => {
      const series = buildEnergyTrendSeries(
        { a: { '2024-06-01': day(1), '2026-06-01': day(2) } },
        'yearly',
        TODAY
      );
      expect(series.map((p) => [p.key, p.kwh])).toEqual([['2024', 1], ['2025', 0], ['2026', 2]]);
    });

    it('keeps zero periods through today', () => {
      const series = buildEnergyTrendSeries({ a: { '2026-08-15': day(3) } }, 'monthly', TODAY);
      expect(series.map((p) => [p.key, p.kwh])).toEqual([
        ['2026-08', 3],
        ['2026-09', 0],
        ['2026-10', 0],
        ['2026-11', 0],
      ]);
    });

    it('treats zero-kWh entries as no data when finding the start', () => {
      const series = buildEnergyTrendSeries(
        { a: { '2024-01-01': day(0), '2026-01-01': day(1) } },
        'yearly',
        TODAY
      );
      expect(series.map((p) => p.key)).toEqual(['2026']);
    });

    it('starts at the earliest device when devices began at different times', () => {
      const series = buildEnergyTrendSeries(
        { a: { '2026-01-01': day(1) }, b: { '2025-01-01': day(1) } },
        'yearly',
        TODAY
      );
      expect(series.map((p) => p.key)).toEqual(['2025', '2026']);
    });
  });

  describe('bucketing', () => {
    const data = {
      a: {
        '2025-12-29': day(1.5),
        '2025-12-31': day(0.25),
        '2026-01-01': day(2),
        '2026-02-28': day(3),
        '2026-03-01': day(4),
        '2026-10-29': day(0.5),
        [TODAY]: day(0.75),
      },
      b: {
        '2025-12-31': day(10),
        '2026-03-01': day(20),
        '2026-10-28': day(7),
        [TODAY]: day(1),
      },
    };

    it('matches sumKwhByDate per day', () => {
      for (const point of buildEnergyTrendSeries(data, 'daily', TODAY)) {
        expect(point.kwh).toBeCloseTo(sumKwhByDate(data, point.key), 4);
      }
    });

    it('matches sumKwhByMonth across a year boundary', () => {
      const series = buildEnergyTrendSeries(data, 'monthly', TODAY);
      expect(series[0].key).toBe('2025-12');
      expect(series[1].key).toBe('2026-01');
      for (const point of series) {
        expect(point.kwh).toBeCloseTo(sumKwhByMonth(data, point.key), 4);
      }
    });

    it('matches sumKwhByYear', () => {
      for (const point of buildEnergyTrendSeries(data, 'yearly', TODAY)) {
        expect(point.kwh).toBeCloseTo(sumKwhByYear(data, point.key), 4);
      }
    });

    it('uses rolling weeks ending today that match sumKwhByWeek', () => {
      const series = buildEnergyTrendSeries(data, 'weekly', TODAY);
      const latest = series[series.length - 1];
      expect(latest.key).toBe(TODAY);
      expect(latest.label).toBe('Oct 29 - Nov 4');
      expect(latest.kwh).toBeCloseTo(sumKwhByWeek(data, '2026-10-29', TODAY), 4);

      const previous = series[series.length - 2];
      expect(previous.key).toBe('2026-10-28');
      expect(previous.kwh).toBeCloseTo(sumKwhByWeek(data, '2026-10-22', '2026-10-28'), 4);
    });

    it('has no holes in the daily series across a leap day', () => {
      const series = buildEnergyTrendSeries({ a: { '2024-02-28': day(1) } }, 'daily', '2024-03-01');
      expect(series.map((p) => p.key)).toEqual(['2024-02-28', '2024-02-29', '2024-03-01']);
    });
  });

  describe('labels', () => {
    it('keeps the existing short axis labels', () => {
      const data = { a: { '2026-10-29': day(1) } };
      expect(buildEnergyTrendSeries(data, 'daily', TODAY)[0].label).toBe('10-29');
      expect(buildEnergyTrendSeries(data, 'monthly', TODAY)[0].label).toBe('Oct 26');
      expect(buildEnergyTrendSeries(data, 'yearly', TODAY)[0].label).toBe('2026');
    });

    it('includes the year in tooltip titles', () => {
      const data = { a: { '2026-10-29': day(1) } };
      expect(buildEnergyTrendSeries(data, 'daily', TODAY)[0].tooltipTitle).toBe('Oct 29, 2026');
      expect(buildEnergyTrendSeries(data, 'weekly', TODAY)[0].tooltipTitle).toBe('Oct 29 - Nov 4, 2026');
      expect(buildEnergyTrendSeries(data, 'monthly', TODAY)[0].tooltipTitle).toBe('October 2026');
    });

    it('spells out both years for a week that straddles new year', () => {
      const series = buildEnergyTrendSeries({ a: { '2025-12-30': day(1) } }, 'weekly', '2026-01-02');
      expect(series[0].tooltipTitle).toBe('Dec 27, 2025 - Jan 2, 2026');
    });
  });

  describe('bad data', () => {
    it('returns an empty series for empty input', () => {
      expect(buildEnergyTrendSeries({}, 'daily', TODAY)).toEqual([]);
    });

    it('returns an empty series when all usage is zero', () => {
      expect(buildEnergyTrendSeries({ a: { '2026-01-01': day(0) } }, 'daily', TODAY)).toEqual([]);
    });

    it('returns an empty series for an invalid today key', () => {
      expect(buildEnergyTrendSeries({ a: { '2026-01-01': day(1) } }, 'daily', 'not-a-date')).toEqual([]);
    });

    it.each(['garbage', '2026-13-01', '2026-02-31', '2026-1-1', '2026-01-01T00:00', ''])(
      'ignores the malformed date key "%s"',
      (key) => {
        const series = buildEnergyTrendSeries({ a: { [key]: day(99), [TODAY]: day(1) } }, 'daily', TODAY);
        expect(series.map((p) => [p.key, p.kwh])).toEqual([[TODAY, 1]]);
      }
    );

    it('ignores future dates', () => {
      const series = buildEnergyTrendSeries({ a: { '2030-01-01': day(99), [TODAY]: day(1) } }, 'yearly', TODAY);
      expect(series.map((p) => [p.key, p.kwh])).toEqual([['2026', 1]]);
    });

    it('ignores an unsynced device clock instead of drawing decades of empty periods', () => {
      const series = buildEnergyTrendSeries({ a: { '1970-01-01': day(99), [TODAY]: day(1) } }, 'daily', TODAY);
      expect(series).toHaveLength(1);
    });

    it('ignores non-finite, negative and non-numeric kWh', () => {
      const bad = (value: unknown) => ({ ...day(0), estimatedKwh: value as number });
      const series = buildEnergyTrendSeries(
        {
          a: {
            '2020-01-01': bad(Number.NaN),
            '2021-01-01': bad(Number.POSITIVE_INFINITY),
            '2022-01-01': bad(-5),
            '2023-01-01': bad('12'),
            '2024-01-01': bad(undefined),
            [TODAY]: day(1),
          },
        },
        'yearly',
        TODAY
      );
      expect(series.map((p) => p.key)).toEqual(['2026']);
    });

    it('tolerates null devices and entries from the database', () => {
      const data = {
        a: null,
        b: { '2026-01-01': null, [TODAY]: day(1) },
      } as unknown as Record<string, Record<string, EnergyDaily>>;
      expect(buildEnergyTrendSeries(data, 'yearly', TODAY)).toHaveLength(1);
    });
  });
});

describe('getVisibleCount', () => {
  it('uses the usual count for each mode on wide screens', () => {
    expect(getVisibleCount('daily', 1200)).toBe(7);
    expect(getVisibleCount('weekly', 1200)).toBe(8);
    expect(getVisibleCount('monthly', 1200)).toBe(12);
    expect(getVisibleCount('yearly', 1200)).toBe(5);
  });

  it('shows fewer periods on narrow screens', () => {
    expect(getVisibleCount('weekly', 300)).toBe(3);
    expect(getVisibleCount('monthly', 300)).toBe(6);
  });

  it('never drops below one point', () => {
    expect(getVisibleCount('weekly', 10)).toBe(1);
  });

  it('falls back to the usual count before the chart has a width', () => {
    expect(getVisibleCount('weekly', 0)).toBe(8);
  });
});

describe('computeTrendViewport', () => {
  const center = ({ min, max }: { min: number; max: number }) => (min + max) / 2;

  it('puts a single point exactly in the center', () => {
    const viewport = computeTrendViewport(1, 5, 1);
    expect(center(viewport)).toBe(0);
    expect(viewport.scrollable).toBe(false);
    expect(viewport.contentWidthPercent).toBe(100);
  });

  it('centers a small group symmetrically', () => {
    const viewport = computeTrendViewport(4, 12, 1);
    expect(center(viewport)).toBe(1.5);
    expect(viewport.max - viewport.min).toBe(12);
    expect(viewport.scrollable).toBe(false);
  });

  it('gives the same range from both formulas at the fit boundary', () => {
    const fits = computeTrendViewport(8, 8, 1);
    const scrolls = computeTrendViewport(9, 8, 0);
    expect(fits.min).toBe(-0.5);
    expect(scrolls.min).toBe(-0.5);
    expect(fits.max).toBe(7.5);
    expect(scrolls.max).toBe(7.5);
  });

  it('reaches the first and last points at the scroll limits', () => {
    expect(computeTrendViewport(20, 8, 0)).toMatchObject({ min: -0.5, max: 7.5, scrollable: true });
    expect(computeTrendViewport(20, 8, 1)).toMatchObject({ min: 11.5, max: 19.5, scrollable: true });
  });

  it('sizes the scroll content to the number of hidden points', () => {
    expect(computeTrendViewport(16, 8, 0).contentWidthPercent).toBe(200);
  });

  it('clamps out-of-range and non-finite progress', () => {
    expect(computeTrendViewport(20, 8, 2).min).toBe(11.5);
    expect(computeTrendViewport(20, 8, -1).min).toBe(-0.5);
    expect(computeTrendViewport(20, 8, Number.NaN).min).toBe(-0.5);
  });
});

describe('isSameTrendSeries', () => {
  const point = (key: string, kwh: number) => ({ key, label: key, tooltipTitle: key, kwh });

  it('matches identical series', () => {
    expect(isSameTrendSeries([point('a', 1)], [point('a', 1)])).toBe(true);
  });

  it('detects changed length, key and value', () => {
    expect(isSameTrendSeries([point('a', 1)], [])).toBe(false);
    expect(isSameTrendSeries([point('a', 1)], [point('b', 1)])).toBe(false);
    expect(isSameTrendSeries([point('a', 1)], [point('a', 2)])).toBe(false);
  });
});
