# Debug Collaboration: Points Lost After Unassign + Claim

## Problem Statement

**Issue:** When a user unassigns aliens (one or all) and then claims rewards, points that were earned BEFORE the unassign operation are being lost/removed.

**User Report:** "it removes the points that the alien earned after unassigning"

## What We've Implemented So Far

### Original Requirement (from BACKEND_UPDATE_PROMPT.md)
When ROI changes (aliens assigned/unassigned), the backend must:
1. Calculate earnings accumulated with the OLD ROI up to the change time
2. Add those earnings to `total_claimed_points`
3. Update `last_claim_at` to the time of the ROI change
4. Continue calculating with the NEW ROI from that point forward

### Current Implementation

#### 1. Helper Functions
```javascript
// Calculates unclaimed earnings using seconds-based calculation
function calculateUnclaimedEarnings(lastClaimAt, totalRoiPerDay, now) {
  if (!lastClaimAt || totalRoiPerDay === 0) return 0;
  const lastClaim = new Date(lastClaimAt);
  const diffMs = now.getTime() - lastClaim.getTime();
  if (diffMs <= 0) return 0;
  const elapsedSeconds = diffMs / 1000;
  const earningsPerSecond = (totalRoiPerDay * BASE_POINTS_PER_DAY) / 86400;
  const earnings = elapsedSeconds * earningsPerSecond;
  return Math.round(earnings * 1000000) / 1000000; // Round to 6 decimals
}

// Calculates current ROI from active aliens in ship_slots
async function calculateCurrentROI(wallet) {
  const activeResult = await query(
    `SELECT a.roi FROM ship_slots s JOIN aliens a ON a.id = s.alien_fk WHERE s.wallet = $1`,
    [wallet]
  );
  let totalRoiPerDay = 0;
  for (const row of activeResult.rows) {
    totalRoiPerDay += Number(row.roi);
  }
  return totalRoiPerDay;
}
```

#### 2. `/api/unassign-slot` Endpoint (Current Code)
```javascript
app.post("/api/unassign-slot", async (req, res) => {
  const { wallet, alienDbId } = req.body;
  
  try {
    await query("BEGIN"); // Start transaction
    
    const now = new Date();
    const userResult = await query(
      `SELECT last_claim_at, total_claimed_points FROM users WHERE wallet = $1`,
      [wallet]
    );
    
    let user = userResult.rows[0];
    if (!user) {
      await query("ROLLBACK");
      return res.status(404).json({ error: "User not found" });
    }

    // Get OLD ROI (includes the alien we're about to remove)
    const oldROI = await calculateCurrentROI(wallet);
    
    // Calculate earnings with OLD ROI
    let earnings = 0;
    if (oldROI > 0 && user.last_claim_at) {
      earnings = calculateUnclaimedEarnings(user.last_claim_at, oldROI, now);
      if (earnings < 0) earnings = 0; // Safety check
    }
    
    // Add earnings to total_claimed_points, update last_claim_at
    await query(
      `UPDATE users
       SET total_claimed_points = COALESCE(total_claimed_points, 0) + $1,
           last_claim_at = $2
       WHERE wallet = $3`,
      [earnings, now, wallet]
    );

    // NOW delete the alien (ROI change happens here)
    const result = await query(
      `DELETE FROM ship_slots WHERE wallet = $1 AND alien_fk = $2 RETURNING id`,
      [wallet, alienDbId]
    );

    if (result.rowCount === 0) {
      await query("ROLLBACK");
      return res.status(404).json({ error: "No such slot assignment" });
    }

    await query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await query("ROLLBACK").catch(() => {});
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});
```

#### 3. `/api/assign-slot` Endpoint
Similar logic - calculates earnings with old ROI BEFORE assigning, then assigns alien.

#### 4. `/api/claim-rewards` Endpoint
Calculates earnings from `last_claim_at` to now with current ROI, adds to `total_claimed_points`.

### Fixes Already Applied

1. **Added COALESCE** to handle NULL values in `total_claimed_points`
2. **Simplified logic** to always update both `total_claimed_points` and `last_claim_at` together
3. **Used database transactions** (BEGIN/COMMIT/ROLLBACK) for atomicity
4. **Seconds-based calculation** for precision (earningsPerSecond = roi / 86400)

## What's Still Not Working

The user reports that points are still being lost when they:
1. Unassign alien(s) → Points should be preserved in `total_claimed_points`
2. Claim rewards → Points are missing/removed

## Detailed Example: What SHOULD Happen

### Scenario: User unassigns 1 alien, then claims

**Initial State (T1):**
```
total_claimed_points = 100.0
last_claim_at = T1 (1 hour ago)
Active aliens: 1 alien with ROI = 10
Current ROI = 10
```

**Step 1: Unassign Operation (T2, 1 hour after T1)**

Transaction:
1. SELECT user: `total_claimed_points = 100.0`, `last_claim_at = T1`
2. Calculate oldROI = 10 (includes alien being removed) ✅
3. Calculate earnings = (T2 - T1) * (10 / 86400) * 1 = 3600 * 0.00011574 = 0.4167
4. UPDATE: `total_claimed_points = COALESCE(100.0, 0) + 0.4167 = 100.4167` ✅
5. UPDATE: `last_claim_at = T2` ✅
6. DELETE alien from ship_slots ✅
7. COMMIT ✅

**Expected State After Unassign:**
```
total_claimed_points = 100.4167 ✅
last_claim_at = T2
Active aliens: 0
Current ROI = 0
```

**Step 2: Claim Operation (T3, 30 min after T2)**

1. SELECT user: `total_claimed_points = 100.4167`, `last_claim_at = T2` ✅
2. Calculate currentROI = 0 (no aliens) ✅
3. Calculate earnings = (T3 - T2) * (0 / 86400) * 1 = 0 ✅
4. Since earnings = 0, UPDATE only `last_claim_at = T3`
5. Return: `total_claimed_points = 100.4167` ✅

**Expected Result:** Points preserved! ✅

## Potential Issues to Investigate

### Issue 1: Race Condition / Transaction Isolation
- Could claim happen before unassign commits?
- Are transactions properly isolated?
- **Check:** Add logging to verify transaction timing

### Issue 2: Data Not Persisting
- Is the UPDATE actually committing?
- Are we reading stale data after UPDATE?
- **Check:** Add RETURNING clause to verify updated value

### Issue 3: ROI Calculation Timing
- Is `calculateCurrentROI` returning correct value BEFORE delete?
- Could there be a timing issue where ROI is already 0?
- **Check:** Log oldROI value before DELETE

### Issue 4: Earnings Calculation Edge Cases
- Could `calculateUnclaimedEarnings` return 0 when it shouldn't?
- Precision/rounding issues?
- **Check:** Log all intermediate values (oldROI, elapsedSeconds, earnings)

### Issue 5: Frontend/Client Logic
- Is the frontend doing something that affects `total_claimed_points`?
- Could there be multiple concurrent requests?
- **Check:** Verify frontend isn't overwriting backend values

### Issue 6: Database Schema Issues
- Is `total_claimed_points` column type correct? (Should be NUMERIC)
- Are there constraints or triggers affecting updates?
- **Check:** Verify column definition in db.js

### Issue 7: Re-reading Data After UPDATE
- Are we reading the updated `total_claimed_points` after the UPDATE?
- The claim endpoint reads user data at the start - could this be stale?
- **Check:** After UPDATE in unassign, should we verify the new value?

## Debugging Steps Needed

1. **Add Comprehensive Logging:**
```javascript
// In unassign-slot, before DELETE:
console.log('UNASSIGN DEBUG:', {
  wallet,
  oldROI,
  earnings,
  total_claimed_points_before: user.total_claimed_points,
  last_claim_at_before: user.last_claim_at,
  now
});

// After UPDATE, re-read and log:
const verifyResult = await query(
  `SELECT total_claimed_points, last_claim_at FROM users WHERE wallet = $1`,
  [wallet]
);
console.log('UNASSIGN AFTER UPDATE:', verifyResult.rows[0]);

// In claim-rewards, log initial state:
console.log('CLAIM DEBUG:', {
  wallet,
  total_claimed_points: user.total_claimed_points,
  last_claim_at: user.last_claim_at,
  currentROI,
  serverEarnings
});
```

2. **Verify Database State:**
   - Query database directly before/after unassign operation
   - Check if `total_claimed_points` is actually being updated
   - Verify transaction is committing

3. **Test Specific Scenarios:**
   - Unassign single alien → check DB → claim → check DB
   - Unassign all aliens → check DB → claim → check DB
   - Multiple rapid unassigns
   - Unassign then immediate claim

4. **Check for Concurrent Operations:**
   - Could multiple requests be interfering?
   - Are there other endpoints modifying `total_claimed_points`?

## Questions for Investigation

1. **When exactly are points lost?**
   - During unassign operation?
   - During claim operation?
   - Between operations?

2. **What does the database show?**
   - What is `total_claimed_points` immediately after unassign?
   - What is it after claim?
   - Is `last_claim_at` being updated correctly?

3. **Are there any error messages or logs?**
   - Transaction rollbacks?
   - SQL errors?
   - Validation errors?

4. **Frontend behavior?**
   - What value does frontend calculate for earnings?
   - Does frontend send `expected_earnings` in claim request?
   - Could frontend be displaying cached/stale data?

## Code Location

All relevant code is in `index.js`:
- Lines 116-125: `calculateUnclaimedEarnings` function
- Lines 127-140: `calculateCurrentROI` function
- Lines 193-281: `/api/claim-rewards` endpoint
- Lines 387-457: `/api/assign-slot` endpoint
- Lines 458-516: `/api/unassign-slot` endpoint

## Next Steps

1. Add detailed logging to track values at each step
2. Verify database state directly (SQL queries)
3. Test with controlled scenarios (known initial state)
4. Check for any other code paths that modify `total_claimed_points`
5. Verify transaction behavior and isolation level

## Database Schema

From `db.js`, the schema should have:
```sql
total_claimed_points NUMERIC(30, 10) DEFAULT 0
last_claim_at TIMESTAMP
```

**Important:** Verify this matches the actual database schema.

---

## 🔍 Frontend AI Analysis & Message to Backend AI

**From Frontend AI to Backend AI:**

Hi Backend AI! I've analyzed the issue and I think I've identified the problem. Let me explain what the frontend is doing and what we're seeing:

### Frontend Behavior

1. **When user unassigns aliens:**
   - Frontend calls `/api/unassign-slot`
   - Frontend then calls `/api/rewards/:wallet` to refresh state
   - Frontend displays: `total_claimed_points` (from backend response)

2. **When user claims:**
   - Frontend calculates: `calculatedValue = total_claimed_points + (now - last_claim_at) * (currentROI / 86400)`
   - Frontend sends: `{ wallet, calculatedValue }` to `/api/claim-rewards`
   - Frontend expects backend to validate and update

### The Problem I Suspect

Looking at the `/api/claim-rewards` endpoint logic, I suspect the issue is in **how the claim endpoint calculates and updates `total_claimed_points`**.

**Current claim logic (what I think is happening):**
```javascript
// Calculate earnings from last_claim_at to now
earnings = (now - last_claim_at) * (currentROI / 86400)
// Then: total_claimed_points = total_claimed_points + earnings
```

**The Issue:**
When ROI is 0 (after unassigning all aliens), the claim endpoint calculates:
- `earnings = (now - last_claim_at) * (0 / 86400) = 0`
- So it should just keep `total_claimed_points` the same, right?

**BUT** - I suspect the claim endpoint might be doing one of these wrong things:

1. **Replacing instead of adding?** 
   - Is it doing `total_claimed_points = earnings` instead of `total_claimed_points = total_claimed_points + earnings`?

2. **Using wrong last_claim_at?**
   - Is it reading `last_claim_at` BEFORE the unassign operation updated it?
   - Could there be a race condition where claim reads stale data?

3. **Double calculation issue?**
   - When unassign adds earnings to `total_claimed_points`, then claim calculates earnings from the NEW `last_claim_at` (which was just updated in unassign)
   - If ROI is 0, earnings = 0, so it should be fine
   - BUT: What if the claim endpoint is recalculating ALL earnings from the original last_claim_at instead of using the updated one?

### Specific Questions for Backend AI

1. **In `/api/claim-rewards`, what exactly is the UPDATE query?**
   - Is it: `UPDATE users SET total_claimed_points = total_claimed_points + $earnings`?
   - Or: `UPDATE users SET total_claimed_points = $calculatedValue`?
   - Please share the exact SQL UPDATE statement

2. **When does `/api/claim-rewards` read the user data?**
   - Does it read `total_claimed_points` and `last_claim_at` at the START of the function?
   - If so, could it be reading STALE data if claim happens immediately after unassign?
   - Should it re-read after validation but before UPDATE?

3. **What is the validation logic?**
   - The frontend sends `calculatedValue = total_claimed_points + pending_earnings`
   - Backend should calculate: `serverValue = total_claimed_points + (now - last_claim_at) * (currentROI / 86400)`
   - If they match within tolerance, update: `total_claimed_points = serverValue`
   - Is this what's happening? Or is it doing something different?

4. **Transaction isolation:**
   - When unassign commits, does claim see the updated `total_claimed_points`?
   - Or could claim be reading the OLD value if it started before unassign committed?

### My Hypothesis

I think the issue is that `/api/claim-rewards` is doing:
```javascript
// WRONG (hypothesis):
total_claimed_points = serverCalculatedValue  // This REPLACES the value!
```

Instead of:
```javascript
// CORRECT:
total_claimed_points = total_claimed_points + newEarnings  // This ADDS to existing
```

OR, the claim endpoint might be calculating earnings from the WRONG `last_claim_at` - maybe it's using a cached/stale value instead of the one that was just updated by unassign.

### Requested Fix

Please check the `/api/claim-rewards` endpoint and verify:

1. **The UPDATE statement** - Show me the exact SQL
2. **When user data is read** - Is it read at the start, or re-read after validation?
3. **The calculation logic** - Is it adding to existing `total_claimed_points` or replacing it?
4. **Transaction handling** - Are reads happening within the same transaction?

### Test Case to Verify

**Scenario:**
1. User has `total_claimed_points = 100`, `last_claim_at = T1`, ROI = 10
2. User unassigns all aliens at T2
   - Backend should: Calculate earnings = (T2-T1)*10/86400, add to total → `total_claimed_points = 100 + earnings`
   - Backend should: Update `last_claim_at = T2`
3. User claims at T3
   - Backend should: Read `total_claimed_points = 100 + earnings` (from step 2)
   - Backend should: Calculate new earnings = (T3-T2)*0/86400 = 0
   - Backend should: Update `total_claimed_points = (100 + earnings) + 0 = 100 + earnings` ✅

**Expected result:** Points preserved!

**Actual result:** Points lost ❌

Please add logging to show:
- What `total_claimed_points` is when claim endpoint reads it
- What `last_claim_at` is when claim endpoint reads it  
- What the calculated `serverValue` is
- What the UPDATE statement sets `total_claimed_points` to

This will help us identify exactly where the points are being lost!

---

## ✅ Fix Applied

Based on the frontend AI's analysis, I've made the following fix to `/api/claim-rewards`:

### Changes Made:

1. **Added Transaction Handling**: Wrapped the entire claim operation in a transaction (BEGIN/COMMIT/ROLLBACK) to ensure data consistency and prevent race conditions.

2. **Always Return Latest Value**: Changed both code paths (when earnings <= 0 and when earnings > 0) to use RETURNING clause to get the updated `total_claimed_points` from the database, ensuring we always return the latest value rather than the value read at the start.

3. **Consistent Error Handling**: Added proper transaction rollback on validation errors.

### The Fix:

**Before:** When `serverEarnings <= 0`, we returned `user.total_claimed_points` which was read at the start (potentially stale).

**After:** We always use the RETURNING clause to get the latest `total_claimed_points` value from the database after any UPDATE, ensuring consistency.

### Updated Code Logic:

```javascript
// Always get latest value after UPDATE using RETURNING
if (serverEarnings <= 0) {
  updateResult = await query(
    `UPDATE users SET last_claim_at = $1 WHERE wallet = $2 RETURNING total_claimed_points`,
    [now, wallet]
  );
} else {
  updateResult = await query(
    `UPDATE users SET total_claimed_points = COALESCE(...) + $1, last_claim_at = $2 WHERE wallet = $3 RETURNING total_claimed_points`,
    [serverEarnings, now, wallet]
  );
}
// Always return the value from RETURNING (latest from DB)
const totalClaimed = Number(updateResult.rows[0].total_claimed_points);
```

This ensures that:
- Transaction isolation prevents race conditions
- We always return the most up-to-date `total_claimed_points` value
- Points accumulated during unassign are preserved when claiming

**Please test and verify this resolves the issue!**

