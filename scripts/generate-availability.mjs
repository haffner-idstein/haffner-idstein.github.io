import fs from "node:fs";

const BOOKING_ICAL_URL = process.env.BOOKING_ICAL_URL;
const HORIZON_MONTHS = Number(process.env.HORIZON_MONTHS || "6");

if (!BOOKING_ICAL_URL) {
  console.error("Missing env BOOKING_ICAL_URL (set it as GitHub Secret BOOKING_ICAL_URL)");
  process.exit(1);
}

function startOfDayUTC(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function ymdUTC(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDaysUTC(d, n) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

function addMonthsUTC(d, n) {
  const x = new Date(d);
  x.setUTCMonth(x.getUTCMonth() + n);
  return x;
}

function parseICalDateToUTC(value) {
  // Supports:
  // - YYYYMMDD (all-day)
  // - YYYYMMDDTHHMMSSZ
  // - YYYYMMDDTHHMMSS (treated as UTC to keep deterministic behavior in Actions)
  const v = value.trim();
  if (/^\d{8}$/.test(v)) {
    const y = Number(v.slice(0, 4));
    const m = Number(v.slice(4, 6));
    const d = Number(v.slice(6, 8));
    return new Date(Date.UTC(y, m - 1, d));
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (m) {
    const [, Y, M, D, hh, mm, ss, z] = m;
    // If no Z, assume UTC (deterministic)
    return new Date(Date.UTC(Number(Y), Number(M) - 1, Number(D), Number(hh), Number(mm), Number(ss)));
  }
  throw new Error(`Unsupported iCal date: ${value}`);
}

function unfoldLines(text) {
  // RFC5545 line unfolding: CRLF followed by space/tab means continuation
  return text.replace(/\r?\n[ \t]/g, "");
}

function extractEvents(icsText) {
  const text = unfoldLines(icsText);
  const lines = text.split(/\r?\n/);
  const events = [];

  let inEvent = false;
  let cur = {};

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      inEvent = true;
      cur = {};
      continue;
    }
    if (line === "END:VEVENT") {
      inEvent = false;
      if (cur.DTSTART && cur.DTEND) events.push(cur);
      cur = {};
      continue;
    }
    if (!inEvent) continue;

    const idx = line.indexOf(":");
    if (idx === -1) continue;

    const left = line.slice(0, idx);
    const value = line.slice(idx + 1);

    const key = left.split(";")[0];
    if (key === "DTSTART" || key === "DTEND" || key === "SUMMARY") {
      cur[key] = value;
    }
  }

  return events;
}

function expandBusyDates(events, rangeStartUTC, rangeEndUTC) {
  // Requirement: "Anreise und Abreisetage sind belegt".
  // We'll mark every date from DTSTART through DTEND inclusive.
  const busy = new Set();

  for (const ev of events) {
    let start = parseICalDateToUTC(ev.DTSTART);
    let end = parseICalDateToUTC(ev.DTEND);

    // Normalize to day boundaries in UTC.
    start = startOfDayUTC(start);
    end = startOfDayUTC(end);

    // If DTEND < DTSTART, skip.
    if (end < start) continue;

    // Iterate inclusive
    for (let d = start; d <= end; d = addDaysUTC(d, 1)) {
      if (d < rangeStartUTC || d > rangeEndUTC) continue;
      busy.add(ymdUTC(d));
    }
  }

  return [...busy].sort();
}

async function main() {
  const now = new Date();
  const rangeStartUTC = startOfDayUTC(now);
  const rangeEndUTC = startOfDayUTC(addDaysUTC(addMonthsUTC(rangeStartUTC, HORIZON_MONTHS), -1));

  const res = await fetch(BOOKING_ICAL_URL, { headers: { "User-Agent": "availability-bot/1.0" } });
  if (!res.ok) throw new Error(`Failed to fetch ICS: HTTP ${res.status}`);
  const ics = await res.text();

  const events = extractEvents(ics);
  const busy_dates = expandBusyDates(events, rangeStartUTC, rangeEndUTC);

  const out = {
    meta: {
      generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      source: "booking.com iCal",
      range_start: ymdUTC(rangeStartUTC),
      range_end: ymdUTC(rangeEndUTC),
      horizon_months: HORIZON_MONTHS,
      rule: "arrival_and_departure_days_busy"
    },
    busy_dates
  };

  fs.writeFileSync("availability.json", JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`Wrote availability.json with ${busy_dates.length} busy dates.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
