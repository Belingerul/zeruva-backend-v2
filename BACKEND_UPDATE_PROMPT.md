# Backend Update Prompt: Handle ROI Changes for Earnings System

## Context
You are modifying an existing Node.js + Express + PostgreSQL backend for a passive income/earnings system. The frontend has been updated to preserve visual earnings when ROI changes (e.g., when aliens are unassigned), but the backend currently doesn't handle ROI changes correctly, causing earnings to be lost.

## Current Problem

When a user unassigns all aliens (ROI goes to 0), the backend still has the old `lastClaimAt` timestamp. When the user tries to claim:
- Backend calculates: `totalClaimedPoints + (now - lastClaimAt) * (currentROI / 86400)`
- Since `currentROI = 0`, this equals `totalClaimedPoints` (0 new earnings)
- Earnings accumulated BEFORE ROI went to 0 are lost

## Required Behavior

When ROI changes (aliens assigned/unassigned), the backend MUST:
1. Calculate earnings accumulated with the OLD ROI up to the change time
2. Add those earnings to `totalClaimedPoints`
3. Update `lastClaimAt` to the time of the ROI change
4. Continue calculating with the NEW ROI from that point forward

This ensures earnings are never lost when ROI changes.

## Database Schema

Ensure you have these columns in your users/rewards table:
```sql
- total_claimed_points (NUMERIC, high precision) -- Total points ever claimed
- last_claim_at (TIMESTAMP) -- Server timestamp of last claim
- total_roi_per_day (NUMERIC) -- Current daily ROI (sum of all assigned aliens)
```

## API Endpoints to Modify

### 1. `/api/assign-slot` (POST)
**Current behavior**: Assigns alien to slot, updates ROI
**Required change**: 
- After updating ROI, calculate earnings with OLD ROI from `lastClaimAt` to NOW
- Add earnings to `totalClaimedPoints`
- Update `lastClaimAt` to NOW
- Then update ROI to new value

**Pseudocode**:
```javascript
// Get current state
const oldRoi = user.total_roi_per_day;
const newRoi = oldRoi + alien.roi; // After adding alien

// Calculate earnings with OLD ROI
if (oldRoi > 0 && user.last_claim_at) {
  const now = new Date();
  const elapsedSeconds = (now - user.last_claim_at) / 1000;
  const earningsPerSecond = oldRoi / 86400;
  const newEarnings = elapsedSeconds * earningsPerSecond;
  
  // Add to total claimed
  user.total_claimed_points += newEarnings;
  user.last_claim_at = now; // Update timestamp
}

// Now update ROI
user.total_roi_per_day = newRoi;
await user.save();
```

### 2. `/api/unassign-slot` (POST)
**Current behavior**: Unassigns alien from slot, updates ROI
**Required change**: 
- Before updating ROI, calculate earnings with CURRENT ROI from `lastClaimAt` to NOW
- Add earnings to `totalClaimedPoints`
- Update `lastClaimAt` to NOW
- Then update ROI to new value

**Pseudocode**:
```javascript
// Get current state
const oldRoi = user.total_roi_per_day;
const newRoi = oldRoi - alien.roi; // After removing alien

// Calculate earnings with OLD ROI BEFORE it changes
if (oldRoi > 0 && user.last_claim_at) {
  const now = new Date();
  const elapsedSeconds = (now - user.last_claim_at) / 1000;
  const earningsPerSecond = oldRoi / 86400;
  const newEarnings = elapsedSeconds * earningsPerSecond;
  
  // Add to total claimed
  user.total_claimed_points += newEarnings;
  user.last_claim_at = now; // Update timestamp
}

// Now update ROI
user.total_roi_per_day = newRoi;
await user.save();
```

### 3. `/api/rewards/:wallet` (GET)
**Current behavior**: Returns current rewards state
**Required change**: NO CHANGE - keep as read-only
**Response format**:
```json
{
  "total_roi_per_day": number,
  "total_claimed_points": number,
  "last_claim_at": "ISO timestamp string"
}
```

### 4. `/api/claim-rewards` (POST)
**Current behavior**: Validates and claims rewards
**Required change**: NO CHANGE to validation logic, but ensure it uses current ROI correctly

**Validation logic** (keep existing):
```javascript
// Backend independently calculates expected value
const now = new Date();
const elapsedSeconds = (now - user.last_claim_at) / 1000;
const earningsPerSecond = user.total_roi_per_day / 86400;
const serverCalculated = user.total_claimed_points + (elapsedSeconds * earningsPerSecond);

// Validate client value
if (Math.abs(serverCalculated - clientCalculatedValue) > 0.01) {
  return { success: false, error: "Validation failed" };
}

// Update on success
user.total_claimed_points = serverCalculated;
user.last_claim_at = now;
await user.save();
```

## Critical Requirements

1. **Always calculate earnings BEFORE ROI changes**: When ROI is about to change (assign/unassign), calculate earnings with the OLD ROI first, then update ROI.

2. **Use server timestamps only**: Always use `new Date()` on the server, never trust client timestamps.

3. **High precision**: Use NUMERIC type in PostgreSQL, round to 6 decimal places for calculations.

4. **Atomic operations**: Use database transactions to ensure ROI update and earnings calculation happen together.

5. **Edge cases**:
   - If `lastClaimAt` is null, set it to NOW (first time)
   - If ROI is 0, earnings calculation should be 0 (already handled by formula)
   - If elapsed time is negative, treat as 0

## Example Flow

**Scenario**: User has $10/day ROI, earns $5, then unassigns all aliens (ROI → 0)

1. **Before unassign**:
   - `total_claimed_points = 100`
   - `last_claim_at = T1`
   - `total_roi_per_day = 10`

2. **User unassigns all aliens**:
   - Calculate: `earnings = (T2 - T1) * (10 / 86400) = $5`
   - Update: `total_claimed_points = 100 + 5 = 105`
   - Update: `last_claim_at = T2`
   - Update: `total_roi_per_day = 0`

3. **User claims** (ROI is 0):
   - Calculate: `earnings = (T3 - T2) * (0 / 86400) = $0`
   - Total: `105 + 0 = 105` ✅ (earnings preserved!)

4. **User reassigns aliens** (ROI → 8):
   - Calculate: `earnings = (T4 - T2) * (0 / 86400) = $0` (no earnings while ROI was 0)
   - Update: `total_claimed_points = 105 + 0 = 105`
   - Update: `last_claim_at = T4`
   - Update: `total_roi_per_day = 8`

## Testing Checklist

- [ ] Assign alien: Earnings accumulated before assign are preserved
- [ ] Unassign alien: Earnings accumulated before unassign are preserved
- [ ] Unassign all aliens: All earnings are preserved, can claim successfully
- [ ] Reassign after unassign: Earnings continue from preserved point
- [ ] Claim with ROI = 0: Returns correct total (no new earnings, but old earnings preserved)
- [ ] Multiple assign/unassign: Earnings never lost
- [ ] Edge case: First assign (no previous ROI)
- [ ] Edge case: Assign when ROI already 0

## Implementation Notes

- Use database transactions for assign/unassign operations
- Round all calculations to 6 decimal places
- Use PostgreSQL NUMERIC type for precision
- Log all ROI changes for debugging
- Ensure `last_claim_at` is always a valid timestamp (never null after first operation)

## Deliverables

1. Updated `/api/assign-slot` endpoint
2. Updated `/api/unassign-slot` endpoint
3. Verification that `/api/claim-rewards` validation still works correctly
4. Database migration (if schema changes needed)
5. Test cases covering all scenarios above

## Important

- Do NOT change `/api/rewards/:wallet` (it's read-only)
- Do NOT change `/api/claim-rewards` validation logic (only ensure it works with new flow)
- Do NOT trust client timestamps - always use server time
- Do NOT skip earnings calculation when ROI changes - this is critical

