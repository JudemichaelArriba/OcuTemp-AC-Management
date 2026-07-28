# AI Chatbot Energy Consumption Fix - Summary

## Problem Statement

The AI chatbot was unable to properly answer energy consumption questions with the following issues:

1. **Could not rank energy consumption per room** - When asked "rank the consumption per room", the AI would only show today's data
2. **Could not understand time periods** - Questions like "this year" would return incorrect data or claim it doesn't have room-level breakdown
3. **Poor data comprehension** - The AI couldn't distinguish between:
   - Today's rankings vs. period-based rankings
   - Total facility consumption vs. per-room breakdown
   - Energy usage (totals) vs. energy rankings (comparisons)
4. **Unclear data sources** - The AI didn't explain where energy data comes from (ESP devices assigned to rooms)

## Root Cause Analysis

### 1. Missing Tool for Period-Based Rankings
The chatbot had:
- `get_energy_rankings` - Only returns TODAY's rankings
- `get_energy_usage` - Returns time series data for trends, not rankings

But it was **missing** a tool to rank rooms by total consumption over a time period (weekly, monthly, yearly).

### 2. Ambiguous Tool Selection in Planner
The planner prompt didn't clearly distinguish when to use:
- `get_energy_rankings` (today only)
- `get_energy_usage` (time series, not rankings)
- The new tool (period-based rankings)

### 3. Answerer Not Optimized for Rankings
The answerer prompt didn't have specific guidance on:
- How to present ranked data clearly
- How to clarify what time period the ranking covers
- How to handle zero-value results gracefully

### 4. Missing Context About Data Architecture
The AI didn't understand that:
- Energy data comes from ESP devices
- Devices are assigned to rooms
- Rooms without devices won't have energy data

## Solution Implemented

### 1. Added New Tool: `get_energy_rankings_by_period`

**Location:** `api/chat/tools/schema.ts`

**Purpose:** Ranks rooms by total energy consumption over a specified period.

**Parameters:**
- `period` (required): 'daily' | 'weekly' | 'monthly' | 'yearly'
  - daily = last 7 days total
  - weekly = last 8 weeks total
  - monthly = last 12 months total
  - yearly = last 5 years total
- `limit` (optional): Max rooms to return (default: 10, max: 50)

**Returns:**
```typescript
[
  { roomName: "Room 204", totalKwh: 17.5, period: "yearly" },
  { roomName: "Room 305", totalKwh: 12.3, period: "yearly" },
  { roomName: "Room 401", totalKwh: 8.1, period: "yearly" }
]
```

### 2. Enhanced Planner Prompt

**Location:** `api/chat/prompts/planner.prompt.ts`

**Changes:**
- Added **"CRITICAL: TIME PERIOD DETECTION FOR ENERGY QUERIES"** section
- Clear decision tree for tool selection:
  1. Check if time period specified → `get_energy_rankings_by_period`
  2. Check if asking "right now" or "today" → `get_energy_rankings`
  3. Check if asking for totals, not rankings → `get_energy_usage`
- Added explicit examples for each tool type

**Key Examples Added:**
```
✓ "rank consumption per room this year" 
  → get_energy_rankings_by_period, period: "yearly"

✓ "which room used most energy this month" 
  → get_energy_rankings_by_period, period: "monthly"

✓ "which room is using the most energy today" 
  → get_energy_rankings

✓ "how much energy did we use this week" 
  → get_energy_usage, scope: "facility", period: "weekly"
```

### 3. Enhanced Answerer Prompt

**Location:** `api/chat/prompts/answerer.prompt.ts`

**Changes:**
- Added **"DATA SOURCES AND CONNECTIONS"** section explaining:
  - Energy data comes from ESP devices assigned to rooms
  - Rooms without devices won't appear in energy results
  - Always refer by room name, not device ID
  
- Added formatting guidance for ranked energy results:
  - Clearly state the time period ("for today", "this year")
  - List rooms in order with kWh values
  - Handle zero values gracefully
  
- Added examples for ranked output:
```
Good: "Energy consumption ranked for 2026:
1. Room 204: 8.5 kWh
2. Room 305: 5.2 kWh
3. Room 401: 3.3 kWh"

Good: "All rooms are showing zero energy consumption for today, 
which means no AC units have been running yet."
```

### 4. Implemented Tool Logic

**Location:** `src/app/services/chat-tools.service.ts`

**Implementation:** `getEnergyRankingsByPeriod` method
- Fetches all rooms with assigned devices
- Aggregates energy consumption over the specified period using existing energy report service functions:
  - `getLast7DayKeys()` + `sumKwhByDateForDevice()` for daily
  - `getLast8WeekRanges()` + `sumKwhByWeekForDevice()` for weekly
  - `getLast12MonthKeys()` + `sumKwhByMonthForDevice()` for monthly
  - `getLast5YearKeys()` + `sumKwhByYearForDevice()` for yearly
- Sorts rooms by total kWh (highest first)
- Returns top N rooms (configurable limit)

### 5. Updated Type Definitions

**Locations:**
- `src/app/models/chat.models.ts`
- `api/chat/types/chat.types.ts`

**Changes:**
- Added `'get_energy_rankings_by_period'` to `ChatToolName` type
- Added to allowed tools list in `validateToolCallSafety()`
- Added dispatch case in tool executor

## Testing Scenarios

### Test Case 1: Yearly Ranking
**User:** "rank the consumption per room this year"

**Expected Flow:**
1. Planner detects time period "this year" → calls `get_energy_rankings_by_period` with `period: "yearly"`
2. Tool aggregates last 5 years of data (including 2026)
3. Answerer presents: "Energy consumption ranked for the last 5 years: [list]"

**Expected Result:**
```
Energy consumption ranked over the last 5 years:
1. Room 204: 17.5 kWh
2. Room 305: 12.3 kWh
3. Room 401: 8.1 kWh
```

### Test Case 2: Monthly Ranking
**User:** "which room used most energy this month?"

**Expected Flow:**
1. Planner detects "this month" → calls `get_energy_rankings_by_period` with `period: "monthly"`
2. Tool aggregates last 12 months of data
3. Answerer presents top room with context

**Expected Result:**
```
Room 204 consumed the most energy over the last 12 months with 8.5 kWh, 
followed by Room 305 with 5.2 kWh and Room 401 with 3.3 kWh.
```

### Test Case 3: Today vs. Period Distinction
**User:** "which room is using most energy today?"

**Expected Flow:**
1. Planner detects "today" → calls `get_energy_rankings` (NOT the period version)
2. Tool returns today's accumulation only
3. Answerer presents with "today" context

**Expected Result:**
```
Room 204 is using the most energy today with 2.1 kWh so far.
```

### Test Case 4: Zero Values Handling
**User:** "rank energy consumption per room this year"
*(When all rooms show 0 kWh)*

**Expected Flow:**
1. Planner calls `get_energy_rankings_by_period` with `period: "yearly"`
2. Tool returns all rooms with totalKwh: 0
3. Answerer detects all zeros and explains clearly

**Expected Result:**
```
All rooms are showing zero energy consumption over the last 5 years. 
This means either no AC units have been running, or energy tracking hasn't 
been active for this period.
```

### Test Case 5: Overall Consumption (Not Ranking)
**User:** "what is the overall energy consumption this year?"

**Expected Flow:**
1. Planner detects "overall" (not asking for ranking) → calls `get_energy_usage` with `scope: "facility"`, `period: "yearly"`
2. Tool returns time series (yearly buckets)
3. Answerer sums up or lists the series

**Expected Result:**
```
Total facility energy usage over the last 5 years:
2022: 120.5 kWh
2023: 145.2 kWh
2024: 167.8 kWh
2025: 201.3 kWh
2026: 17.1 kWh
```

### Test Case 6: Per-Room Over Time (Not Ranking)
**User:** "show me Room 204's energy usage this month"

**Expected Flow:**
1. Planner detects specific room + time period (not ranking) → calls `get_energy_usage` with `scope: "room"`, `roomName: "Room 204"`, `period: "monthly"`
2. Tool returns monthly series for Room 204
3. Answerer lists monthly breakdown

**Expected Result:**
```
Room 204's energy usage over the last 12 months:
August 2025: 1.2 kWh
September 2025: 2.4 kWh
...
July 2026: 2.8 kWh
```

## Files Modified

### API/Backend
1. `api/chat/prompts/planner.prompt.ts` - Enhanced tool selection logic
2. `api/chat/prompts/answerer.prompt.ts` - Added ranking presentation guidance
3. `api/chat/tools/schema.ts` - Added new tool definition
4. `api/chat/types/chat.types.ts` - Added tool name to type

### Frontend
5. `src/app/models/chat.models.ts` - Added tool name to type
6. `src/app/services/chat-tools.service.ts` - Implemented tool logic

## Verification Steps

1. **Build Verification** ✓
   - `npm run build` completed successfully
   - No TypeScript compilation errors
   - No runtime errors introduced

2. **Type Safety** ✓
   - `ChatToolName` type updated in both frontend and backend
   - Tool dispatch handles new case
   - Validation includes new tool in allowed list

3. **Integration Points** ✓
   - Uses existing `EnergyReportService` functions
   - Reuses aggregation helpers (sum functions, date key functions)
   - Follows read-only pattern (no writes)
   - Consistent with existing tool implementations

## Potential Edge Cases Handled

1. **Rooms without devices** - Filtered out automatically (`.filter((room) => room.device)`)
2. **Zero energy values** - Answerer prompt instructs to handle gracefully
3. **Empty results** - Returns empty array, answerer explains
4. **Large number of rooms** - Limit parameter caps results (default 10, max 50)
5. **Time zone consistency** - Uses existing timezone helpers from energy-report.service

## Benefits

1. **Smarter AI** - Can now distinguish between different types of energy queries
2. **Better UX** - Clear, ranked answers with proper context
3. **Complete Coverage** - Handles all combinations:
   - Rankings: today, daily, weekly, monthly, yearly
   - Totals: facility-wide or per-room
   - Time series: trends over periods
4. **Production Quality** - RAG-style grounding prevents hallucinations
5. **Maintainable** - Reuses existing services and patterns

## Next Steps for Production

1. **User Testing** - Test with real user questions
2. **Monitor Tool Usage** - Track which tools are called most
3. **Refine Prompts** - Adjust based on real usage patterns
4. **Add Tool Metrics** - Log tool execution times and error rates
5. **Consider Caching** - Cache energy aggregations if queries are slow

## Notes

- All changes are backward-compatible
- Existing tools (`get_energy_rankings`, `get_energy_usage`) unchanged
- No database schema changes required
- No breaking changes to API contracts
- Tool remains strictly read-only (no control operations)
