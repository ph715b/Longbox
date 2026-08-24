import { useEffect, useMemo, useState } from 'react';
import type { ReadingStats } from '@longbox/core';

/**
 * Reading stats.
 *
 * Three different jobs, so three different treatments: the headline totals are
 * single numbers and get tiles rather than a chart; daily reading is magnitude
 * over time and gets a calendar heatmap; series are nominal categories compared
 * by one measure, so they get a ranked bar list where length carries the value
 * and every bar shares one colour -- colouring them individually would spend the
 * identity channel re-encoding what bar length already says.
 */

/** How many weeks of history the calendar shows. */
const WEEKS = 26;

/** Steps of the sequential ramp, dimmest first. Defined in styles.css. */
const HEAT_LEVELS = 5;

/** Cell plus gap, matching .calendar-day and .calendar-grid in styles.css. */
const COLUMN_WIDTH = 15;

/** Weeks that must separate two month labels so their text cannot collide. */
const MIN_LABEL_GAP = 3;

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

/** Local calendar day, matching how the library records activity. */
function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

interface Day {
  key: string;
  date: Date;
  pages: number;
}

/**
 * The calendar grid, ending today and starting on a week boundary so the rows
 * line up as weekdays.
 */
function buildDays(pagesPerDay: Record<string, number>): Day[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const start = new Date(today);
  start.setDate(start.getDate() - (WEEKS * 7 - 1));
  start.setDate(start.getDate() - start.getDay());

  const days: Day[] = [];
  for (let cursor = new Date(start); cursor <= today; cursor.setDate(cursor.getDate() + 1)) {
    const date = new Date(cursor);
    const key = dayKey(date);
    days.push({ key, date, pages: pagesPerDay[key] ?? 0 });
  }
  return days;
}

/**
 * Bucket a day's pages onto the ramp.
 *
 * Nothing read is its own state rather than the bottom step: an empty day and a
 * barely-read day mean different things and should not look nearly identical.
 */
function levelFor(pages: number, busiest: number): number {
  if (pages <= 0) return 0;
  if (busiest <= 0) return 1;
  const ratio = pages / busiest;
  return Math.min(HEAT_LEVELS, Math.ceil(ratio * HEAT_LEVELS));
}

function ActivityCalendar({ pagesPerDay }: { pagesPerDay: Record<string, number> }) {
  const [showNumbers, setShowNumbers] = useState(false);

  const days = useMemo(() => buildDays(pagesPerDay), [pagesPerDay]);
  const busiest = useMemo(() => Math.max(0, ...days.map((day) => day.pages)), [days]);
  const active = useMemo(() => days.filter((day) => day.pages > 0), [days]);

  // Columns are weeks; a month label sits above the week its first day falls in.
  const weeks = useMemo(() => {
    const columns: Day[][] = [];
    for (let index = 0; index < days.length; index += 7) columns.push(days.slice(index, index + 7));
    return columns;
  }, [days]);

  /**
   * A label per month, placed over the week its first day falls in.
   *
   * A month name is wider than the 12px column it labels, so two months
   * starting a week apart would overlap. Anything closer than MIN_LABEL_GAP
   * columns to the previous label is dropped rather than drawn on top of it.
   */
  const monthLabels = useMemo(() => {
    const labels: { text: string; column: number }[] = [];
    let lastColumn = -MIN_LABEL_GAP;

    weeks.forEach((week, index) => {
      // Label the week a month actually begins in. Keying off "the month
      // changed since last column" instead would put a label on the partial
      // week at the start, which then crowds out the first real month.
      const opens = week.find((day) => day.date.getDate() === 1);
      if (!opens) return;
      if (index - lastColumn < MIN_LABEL_GAP) return;
      labels.push({ text: opens.date.toLocaleDateString(undefined, { month: 'short' }), column: index });
      lastColumn = index;
    });

    return labels;
  }, [weeks]);

  const totalPages = active.reduce((sum, day) => sum + day.pages, 0);

  return (
    <section className="chart">
      <header className="chart-head">
        <div>
          <h3>Pages read per day</h3>
          <p className="chart-sub">
            {active.length === 0
              ? 'No reading recorded yet — turn a few pages and this fills in.'
              : `${formatCount(totalPages)} pages across ${active.length} ${active.length === 1 ? 'day' : 'days'}, busiest ${formatCount(busiest)}.`}
          </p>
        </div>
        <button className="btn small" onClick={() => setShowNumbers((value) => !value)}>
          {showNumbers ? 'Show calendar' : 'Show numbers'}
        </button>
      </header>

      {showNumbers ? (
        active.length === 0 ? (
          <p className="chart-sub">Nothing to list yet.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Day</th>
                <th className="num">Pages</th>
              </tr>
            </thead>
            <tbody>
              {[...active].reverse().map((day) => (
                <tr key={day.key}>
                  <td>{day.date.toLocaleDateString(undefined, { dateStyle: 'medium' })}</td>
                  <td className="num">{formatCount(day.pages)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : (
        <>
          <div className="calendar-scroll">
            <div className="calendar">
              <div className="calendar-months" style={{ width: weeks.length * COLUMN_WIDTH }}>
                {monthLabels.map((label) => (
                  <span
                    key={label.column}
                    className="calendar-month"
                    style={{ left: label.column * COLUMN_WIDTH }}
                  >
                    {label.text}
                  </span>
                ))}
              </div>
              <div className="calendar-grid">
                {weeks.map((week, index) => (
                  <div key={index} className="calendar-week">
                    {week.map((day) => (
                      <div
                        key={day.key}
                        className="calendar-day"
                        data-level={levelFor(day.pages, busiest)}
                        title={`${day.date.toLocaleDateString(undefined, { dateStyle: 'medium' })} — ${day.pages === 0 ? 'nothing read' : `${formatCount(day.pages)} ${day.pages === 1 ? 'page' : 'pages'}`}`}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="calendar-legend">
            <span>Less</span>
            {Array.from({ length: HEAT_LEVELS + 1 }, (_, level) => (
              <span key={level} className="calendar-day" data-level={level} />
            ))}
            <span>More</span>
          </div>
        </>
      )}
    </section>
  );
}

function TopSeries({ series }: { series: ReadingStats['topSeries'] }) {
  const ranked = series.filter((entry) => entry.pagesRead > 0);
  if (ranked.length === 0) return null;

  // One bar is not a comparison, so it is reported as a sentence instead.
  if (ranked.length === 1) {
    return (
      <section className="chart">
        <h3>Most read series</h3>
        <p className="chart-sub">
          Everything read so far is <b>{ranked[0].name}</b> — {formatCount(ranked[0].pagesRead)}{' '}
          {ranked[0].pagesRead === 1 ? 'page' : 'pages'}. A second series will turn this into a
          comparison.
        </p>
      </section>
    );
  }

  const most = ranked[0].pagesRead;

  return (
    <section className="chart">
      <h3>Most read series</h3>
      <p className="chart-sub">By pages read.</p>
      <div className="bars">
        {ranked.map((entry) => (
          <div key={entry.seriesId} className="bar-row">
            <span className="bar-label" title={entry.name}>
              {entry.name}
            </span>
            <div className="bar-track">
              <div
                className="bar-fill"
                style={{ width: `${Math.max(2, (entry.pagesRead / most) * 100)}%` }}
              />
            </div>
            <span className="bar-value">{formatCount(entry.pagesRead)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Tile({ figure, label, note }: { figure: string; label: string; note?: string }) {
  return (
    <div className="tile">
      <div className="tile-figure">{figure}</div>
      <div className="tile-label">{label}</div>
      {note && <div className="tile-note">{note}</div>}
    </div>
  );
}

export function Stats({ refreshKey }: { refreshKey: number }) {
  const [stats, setStats] = useState<ReadingStats>();

  useEffect(() => {
    let live = true;
    void window.longbox.getStats().then((next) => {
      if (live) setStats(next);
    });
    return () => {
      live = false;
    };
  }, [refreshKey]);

  if (!stats) return null;

  const percentComplete =
    stats.totalComics > 0 ? Math.round((stats.comicsCompleted / stats.totalComics) * 100) : 0;

  return (
    <div className="panel wide stats">
      <div className="tiles">
        <Tile figure={formatCount(stats.totalComics)} label="Comics" note={`${formatCount(stats.totalPages)} pages in all`} />
        <Tile
          figure={formatCount(stats.comicsCompleted)}
          label="Finished"
          note={`${percentComplete}% of the library`}
        />
        <Tile figure={formatCount(stats.pagesRead)} label="Pages read" />
        <Tile figure={formatDuration(stats.timeSpentMs)} label="Time reading" />
      </div>

      <ActivityCalendar pagesPerDay={stats.pagesPerDay} />
      <TopSeries series={stats.topSeries} />
    </div>
  );
}
