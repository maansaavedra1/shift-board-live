/**
 * SHIFT BOARD — Google Apps Script backend for Sprout HR attendance monitoring
 * -----------------------------------------------------------------------------
 * Pulls live data from Sprout's API (Employees, Attendance Logs, Leave,
 * Schedule Adjustments) and classifies each employee's status for today
 * (Late / Present but Late / On Time / Did Not Report / On Leave / Rest Day).
 *
 * Two ways this gets used:
 *   1. Web App endpoint (doGet) — serves JSON to the "shift-board-live.html"
 *      dashboard. This is the primary, actively-used interface.
 *   2. Google Chat app (onMessage) — optional, replies with the same report
 *      as a text message if deployed as a Chat app instead of/alongside the
 *      Web App.
 *
 * SETUP (do this once):
 * 1. In this Apps Script project, go to Project Settings (gear icon) >
 *    Script Properties > Add script property, and add these:
 *      SPROUT_CLIENT_ID         = (your Sprout API Client ID)
 *      SPROUT_CLIENT_SECRET     = (your Sprout API Client Secret)
 *      SPROUT_SUBSCRIPTION_KEY  = (your Sprout API subscription/API key)
 *      SPROUT_USER_ID           = (a valid Sprout systemId used for the
 *                                  Leave endpoint's required UserId header)
 *      DASHBOARD_ACCESS_KEY     = (a long random string — protects the Web
 *                                  App endpoint from unauthenticated access)
 *    Never paste these values directly into this code file.
 *
 * 2. Add Debug.gs as a separate file in this same project (contains
 *    troubleshooting helpers, not part of the core logic).
 *
 * 3a. For the dashboard: Deploy > New deployment > type "Web app" > Deploy.
 *     Paste the resulting URL + "?key=YOUR_DASHBOARD_ACCESS_KEY" into the
 *     dashboard HTML file's setup box.
 * 3b. For Chat (optional): Deploy > New deployment > type "Chat app" >
 *     Deploy, then follow Google's prompts to register it.
 *
 * NOTE: currently configured against Sprout's SANDBOX environment
 * (gateway-sb.sprout.ph). Point SPROUT_BASE at a production host and use
 * production credentials before using this with real client data.
 */

const SPROUT_BASE = 'https://gateway-sb.sprout.ph';

// ---------- Retry helper for transient network/API blips ----------
// Wraps UrlFetchApp.fetch with up to 3 attempts and exponential backoff.
// Only retries on likely-transient failures (network errors, 429, 5xx) —
// does not change what counts as success/failure, just gives flaky
// connections a couple of extra chances before giving up.
function fetchWithRetry(url, options, maxAttempts) {
  maxAttempts = maxAttempts || 3;
  var lastError = null;
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      var response = UrlFetchApp.fetch(url, options);
      var code = response.getResponseCode();
      if (code === 429 || (code >= 500 && code < 600)) {
        lastError = new Error('Transient HTTP ' + code + ': ' + response.getContentText());
      } else {
        return response; // success or a non-transient error (e.g. 400/401) — return as-is
      }
    } catch (err) {
      lastError = err; // network-level failure (timeout, DNS, etc.)
    }
    if (attempt < maxAttempts) {
      Utilities.sleep(500 * Math.pow(2, attempt - 1)); // 500ms, 1s, 2s...
    }
  }
  throw lastError;
}

// ---------- STEP 1: Get an access token ----------
function getAccessToken() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('sprout_token');
  if (cached) return cached;

  const props = PropertiesService.getScriptProperties();
  const clientId = props.getProperty('SPROUT_CLIENT_ID');
  const clientSecret = props.getProperty('SPROUT_CLIENT_SECRET');
  const subscriptionKey = props.getProperty('SPROUT_SUBSCRIPTION_KEY');

  const response = fetchWithRetry(SPROUT_BASE + '/auth/connect/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    headers: {
      'Ocp-Apim-Subscription-Key': subscriptionKey,
      'Accept': 'application/json'
    },
    payload: {
      Client_Id: clientId,
      Client_Secret: clientSecret,
      grant_type: 'client_credentials'
    },
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  if (code !== 200) {
    throw new Error('Token request failed (' + code + '): ' + response.getContentText());
  }

  const data = JSON.parse(response.getContentText());
  // Cache for slightly less than the actual expiry (usually 3600s) to be safe.
  cache.put('sprout_token', data.access_token, (data.expires_in || 3600) - 120);
  return data.access_token;
}

function sproutHeaders() {
  const subscriptionKey = PropertiesService.getScriptProperties().getProperty('SPROUT_SUBSCRIPTION_KEY');
  return {
    'Authorization': 'Bearer ' + getAccessToken(),
    'Ocp-Apim-Subscription-Key': subscriptionKey,
    'Accept': 'application/json'
  };
}

// ---------- STEP 2: Get all employees + their shift schedule ----------
function getEmployees(preloadedFirstResponse) {
  // Cache the roster briefly — department/schedule/supervisor data doesn't
  // change minute to minute, so this avoids re-fetching on every refresh.
  var cache = CacheService.getScriptCache();
  var cached = cache.get('sprout_employees');
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through and re-fetch */ }
  }

  var allEmployees = [];
  var pageNumber = 1;
  var pageSize = 100;
  while (true) {
    var response;
    if (pageNumber === 1 && preloadedFirstResponse) {
      // Already fetched in parallel by computeTodayReport — skip re-fetching.
      response = preloadedFirstResponse;
    } else {
      var url = SPROUT_BASE + '/empservice/api/v1/Employees?Include=WorkSchedule&Include=WorkInformation'
        + '&RowsPerPage=' + pageSize + '&PageNumber=' + pageNumber;
      response = fetchWithRetry(url, { headers: sproutHeaders(), muteHttpExceptions: true });
    }
    if (response.getResponseCode() !== 200) {
      throw new Error('Employees request failed: ' + response.getContentText());
    }
    var data = JSON.parse(response.getContentText());
    var pageOfEmployees = data.data || [];
    allEmployees = allEmployees.concat(pageOfEmployees);

    if (pageOfEmployees.length < pageSize) break; // last page
    pageNumber++;
    if (pageNumber > 50) break; // safety valve — 5000 employees is well beyond any realistic client size
  }

  try {
    cache.put('sprout_employees', JSON.stringify(allEmployees), 300); // 5 minutes
  } catch (e) {
    // Cache write can fail (e.g. payload too large for a very big roster) —
    // that's fine, we just skip caching for this run rather than failing.
  }

  return allEmployees;
}

// ---------- STEP 3: Get today's attendance logs ----------
function getAttendanceLogs(dateFromISO, dateToISO, preloadedFirstResponse) {
  var allLogs = [];
  var pageNumber = 1;
  var pageSize = 100;
  while (true) {
    var response;
    if (pageNumber === 1 && preloadedFirstResponse) {
      // Already fetched in parallel by computeTodayReport — skip re-fetching.
      response = preloadedFirstResponse;
    } else {
      var url = SPROUT_BASE + '/timeattendance/api/v1/AttendanceLogs'
        + '?DateFrom=' + encodeURIComponent(dateFromISO)
        + '&DateTo=' + encodeURIComponent(dateToISO)
        + '&RowsPerPage=' + pageSize + '&PageNumber=' + pageNumber;
      response = fetchWithRetry(url, { headers: sproutHeaders(), muteHttpExceptions: true });
    }
    if (response.getResponseCode() !== 200) {
      throw new Error('AttendanceLogs request failed: ' + response.getContentText());
    }
    var data = JSON.parse(response.getContentText());
    var pageOfLogs = data.data || [];
    allLogs = allLogs.concat(pageOfLogs);

    if (pageOfLogs.length < pageSize) break; // last page
    pageNumber++;
    if (pageNumber > 100) break; // safety valve — 10,000 punches in one day is well beyond any realistic case
  }
  return allLogs;
}

// ---------- STEP 4: Get today's approved leave ----------
function getApprovedLeaves(dateFromISO, dateToISO, preloadedCreateResponse) {
  // Deliberately NOT cached — same real-time correctness concern that led
  // to removing Schedule Adjustments' cache: a leave request can be filed
  // and approved same-day, and stale cached data would hide it. Always
  // fetches fresh.

  // Step A: create a search criteria
  // CONFIRMED (Sprout support feedback, July 2026): UserId must be sent as an
  // HTTP HEADER, not just in the body or as a URL query param — that's what
  // every previous attempt was missing.
  const userId = PropertiesService.getScriptProperties().getProperty('SPROUT_USER_ID');
  const createUrl = SPROUT_BASE + '/timeattendance/api/v1/Leaves/SearchCriteria';
  const createHeaders = sproutHeaders();
  createHeaders['UserId'] = userId;
  const createResponse = preloadedCreateResponse || fetchWithRetry(createUrl, {
    method: 'post',
    contentType: 'application/json',
    headers: createHeaders,
    payload: JSON.stringify({
      UserId: Number(userId), // kept in body too, matching Sprout's confirmed-working example exactly
      dateFrom: dateFromISO,
      dateTo: dateToISO,
      statusIds: [4], // 4 = Approved — matches the same status enum used for Schedule Adjustments
      pageNumber: 1,
      rowsPerPage: 100
    }),
    muteHttpExceptions: true
  });
  if (createResponse.getResponseCode() !== 201 && createResponse.getResponseCode() !== 200) {
    throw new Error('Leaves SearchCriteria (create) failed: ' + createResponse.getContentText());
  }
  const createData = JSON.parse(createResponse.getContentText());
  const searchCriteriaId = createData.searchCriteriaId; // flat response, not wrapped in a "data" array
  if (!searchCriteriaId) return [];

  // Step B: fetch results using that ID
  const fetchUrl = SPROUT_BASE + '/timeattendance/api/v1/Leaves/SearchCriteria?SearchCriteriaId=' + encodeURIComponent(searchCriteriaId);
  const fetchHeaders = sproutHeaders();
  fetchHeaders['UserId'] = userId;
  const fetchResponse = fetchWithRetry(fetchUrl, { headers: fetchHeaders, muteHttpExceptions: true });
  if (fetchResponse.getResponseCode() !== 200) {
    throw new Error('Leaves SearchCriteria (fetch) failed: ' + fetchResponse.getContentText());
  }
  const fetchData = JSON.parse(fetchResponse.getContentText());
  const result = fetchData.data || [];

  return result;
}

// Debug/inspection helpers (checkAccessKeySetup, inspectAttendanceLogStructure,
// inspectEmployeeStructure, findMyEmployeeId) now live in Debug.gs — add that
// as a separate file in this same Apps Script project if you need them.

// ---------- STEP 5: Put it all together ----------
const WEEKDAY_FIELDS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// ---------- STEP 4b: Get today's per-date schedule adjustments ----------
// A schedule adjustment is a one-off override for a specific date (e.g. "this
// Friday is a rest day instead of a work day"), separate from the employee's
// normal recurring weekly pattern. Without checking this, someone whose
// schedule was adjusted to a rest day would still be evaluated against their
// regular weekly pattern and could incorrectly show as Late/Did Not Report.
//
// CONFIRMED against real sandbox docs and a real adjustment record (July 2026):
// - List endpoint (plural "ScheduleAdjustments"): filterable by DateFrom/DateTo/
//   StatusId, but only returns {id, employeeId, statusId} — not enough on its own.
//   NOTE: DateFrom/DateTo here filter by when the adjustment was FILED, not the
//   date it takes effect — so we search a wide window (30 days back/forward)
//   rather than just "today", to avoid missing adjustments filed on a prior day.
// - Detail endpoint (singular "ScheduleAdjustment/:id"): returns the real
//   per-date override info inside a "details" array, with fields
//   date/timeFrom/timeTo/isRestDay.
// StatusId 4 = Approved (same status enum as Leave/OfficialBusiness/Overtime).
function getScheduleAdjustments(dateFromISO, dateToISO, preloadedFirstResponse) {
  // Deliberately NOT cached — a real test case showed a just-filed/approved
  // adjustment can take up to the cache's TTL to show up, which matters more
  // for this data than the extra API cost. Always fetches fresh.
  var allAdjustments = [];
  var pageNumber = 1;
  var pageSize = 100;
  while (true) {
    var url = SPROUT_BASE + '/timeattendance/api/v1/ScheduleAdjustments'
      + '?DateFrom=' + encodeURIComponent(dateFromISO)
      + '&DateTo=' + encodeURIComponent(dateToISO)
      + '&StatusId=4'
      + '&SortColumn=DateFiled&SortOrder=asc'
      + '&RowsPerPage=' + pageSize + '&PageNumber=' + pageNumber;
    var response = (pageNumber === 1 && preloadedFirstResponse)
      ? preloadedFirstResponse
      : fetchWithRetry(url, { headers: sproutHeaders(), muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) {
      throw new Error('ScheduleAdjustments list request failed: ' + response.getContentText());
    }
    var data = JSON.parse(response.getContentText());
    var page = data.data || [];
    allAdjustments = allAdjustments.concat(page);
    if (page.length < pageSize) break;
    pageNumber++;
    if (pageNumber > 20) break;
  }

  // The list only gives IDs — fetch each one's actual override details.
  var fullAdjustments = [];
  if (allAdjustments.length > 0) {
    var detailHeaders = sproutHeaders();
    var detailRequests = allAdjustments.map(function (item) {
      return {
        url: SPROUT_BASE + '/timeattendance/api/v1/ScheduleAdjustment/' + item.id,
        headers: detailHeaders,
        muteHttpExceptions: true
      };
    });

    var detailResponses;
    try {
      // Fire all detail requests at once instead of one-by-one — these are
      // fully independent of each other, so no reason to wait for each in turn.
      detailResponses = UrlFetchApp.fetchAll(detailRequests);
    } catch (err) {
      detailResponses = []; // fall through to per-item retry below
    }

    detailResponses.forEach(function (detailResponse, i) {
      if (detailResponse && detailResponse.getResponseCode() === 200) {
        fullAdjustments.push(JSON.parse(detailResponse.getContentText()));
      } else {
        // If the batch failed for this one (transient issue, or the whole
        // batch call threw), retry it individually rather than losing it —
        // same safety net as before, just no longer the default path.
        try {
          var retryResponse = fetchWithRetry(detailRequests[i].url, { headers: detailHeaders, muteHttpExceptions: true });
          if (retryResponse.getResponseCode() === 200) {
            fullAdjustments.push(JSON.parse(retryResponse.getContentText()));
          }
        } catch (e) {
          // Skip just this one rather than failing the whole batch.
        }
      }
    });
  }

  return fullAdjustments;
}


// ---------- Shared classification rules (used by both single-day and ----------
// ---------- multi-day report generation — identical rules either way) ----------
// Given one employee and one specific day's context (attendance indexes,
// leave index, schedule-adjustment index, weekday, and the day's own Date),
// returns which bucket this employee lands in for that day. This is
// extracted so the exact same rules run whether we're computing "today" or
// looping over several past days — no duplication, no risk of the two paths
// drifting apart.
function classifyEmployeeForDay(emp, dayContext) {
  const basic = emp.basicInformation || {};
  const work = emp.workInformation || {};
  const schedule = emp.workSchedule || {};
  const name = (basic.firstName || '') + ' ' + (basic.lastName || '');
  const bioId = work.biometricId;
  const systemId = basic.systemId;

  const department = work.department || '—';
  const supervisor = work.reportsTo || '—';
  const contactInfo = { department: department, supervisor: supervisor };

  const adjustment = dayContext.adjustmentByEmployeeId[systemId];
  const isRestDay = adjustment
    ? !!adjustment.isRestDay
    : schedule[dayContext.weekday + 'IsRestday'];
  if (isRestDay) {
    return { status: 'restDay', entry: { name: name, ...contactInfo } };
  }

  if (dayContext.leaveEmployeeIds[systemId]) {
    return { status: 'onLeave', entry: { name: name, ...contactInfo } };
  }

  const shiftFromStr = (adjustment && adjustment.shiftFrom) || schedule[dayContext.weekday + 'From'];
  const shiftToStr = (adjustment && adjustment.shiftTo) || schedule[dayContext.weekday + 'To'];
  const inTime = dayContext.firstInByBioId[bioId];
  const outTime = dayContext.firstOutByBioId[bioId];

  if (!inTime) {
    if (outTime) {
      return {
        status: 'presentButLate',
        entry: { name: name, ...contactInfo, lateMinutes: null, reason: 'missing log-in (has log-out)' }
      };
    }

    let shiftHasEnded = false;
    if (shiftToStr) {
      const [endH, endM] = shiftToStr.split(':').map(Number);
      const shiftEnd = new Date(dayContext.dayDate);
      shiftEnd.setHours(endH, endM, 0, 0);
      shiftHasEnded = new Date() > shiftEnd;
    }

    if (shiftHasEnded) {
      return { status: 'didNotReport', entry: { name: name, ...contactInfo, reason: 'no log-in or log-out, shift already ended' } };
    }
    return { status: 'late', entry: { name: name, ...contactInfo, reason: 'no log-in yet, shift still ongoing' } };
  }

  if (!shiftFromStr) {
    return { status: 'onTime', entry: { name: name, ...contactInfo, hasLogout: !!outTime } };
  }

  const [h, m] = shiftFromStr.split(':').map(Number);
  const shiftStart = new Date(inTime);
  shiftStart.setHours(h, m, 0, 0);
  const lateMinutes = Math.round((inTime - shiftStart) / 60000);
  if (lateMinutes > 0) {
    return { status: 'presentButLate', entry: { name: name, ...contactInfo, lateMinutes: lateMinutes, hasLogout: !!outTime } };
  }

  return { status: 'onTime', entry: { name: name, ...contactInfo, hasLogout: !!outTime } };
}

function newEmptyReport() {
  return { late: [], presentButLate: [], onLeave: [], onTime: [], restDay: [], didNotReport: [] };
}

// Builds the attendance in/out index for one specific day, filtering a
// larger (possibly multi-day) set of logs down to just that day first.
function buildDayAttendanceIndex(allLogs, dayKey) {
  const firstInByBioId = {};
  const firstOutByBioId = {};
  allLogs.forEach(function (log) {
    const logDateKey = Utilities.formatDate(new Date(log.logTime), 'Asia/Manila', 'yyyy-MM-dd');
    if (logDateKey !== dayKey) return;
    const bioId = log.bioEmpID;
    const logTime = new Date(log.logTime);
    var modeStr = String(log.inOutMode).toLowerCase();
    const isIn = modeStr === 'in' || modeStr === '0';
    const isOut = modeStr === 'out' || modeStr === '1';
    if (isIn) {
      if (!firstInByBioId[bioId] || logTime < firstInByBioId[bioId]) firstInByBioId[bioId] = logTime;
    }
    if (isOut) {
      if (!firstOutByBioId[bioId] || logTime < firstOutByBioId[bioId]) firstOutByBioId[bioId] = logTime;
    }
  });
  return { firstInByBioId: firstInByBioId, firstOutByBioId: firstOutByBioId };
}

// Leave records genuinely have an accurate dateFrom/dateTo (unlike Schedule
// Adjustments), so a leave fetched for a wide range can be checked directly
// against any specific day within that range. Uses plain string comparison
// of "YYYY-MM-DD" (not Date object parsing) to avoid the same timezone
// ambiguity that caused an earlier bug in the Schedule Adjustments matching.
function buildDayLeaveIndex(allLeaves, dayKey) {
  const leaveEmployeeIds = {};
  allLeaves.forEach(function (leave) {
    if (!leave.dateFrom || !leave.dateTo) return;
    const fromKey = leave.dateFrom.substring(0, 10);
    const toKey = leave.dateTo.substring(0, 10);
    if (fromKey <= dayKey && dayKey <= toKey) {
      leaveEmployeeIds[leave.employeeId] = true;
    }
  });
  return leaveEmployeeIds;
}

function buildDayAdjustmentIndex(scheduleAdjustments, dayKey) {
  const adjustmentByEmployeeId = {};
  scheduleAdjustments.forEach(function (adj) {
    var empId = adj.employeeId;
    if (!empId || !adj.details) return;
    var dayDetail = adj.details.find(function (d) {
      return d.date.substring(0, 10) === dayKey;
    });
    if (dayDetail) {
      adjustmentByEmployeeId[empId] = {
        isRestDay: dayDetail.isRestDay,
        shiftFrom: dayDetail.timeFrom,
        shiftTo: dayDetail.timeTo
      };
    }
  });
  return adjustmentByEmployeeId;
}

function computeTodayReport() {
  const now = new Date();
  const dateFromISO = Utilities.formatDate(now, 'Asia/Manila', "yyyy-MM-dd'T'00:00:00");
  const dateToISO = Utilities.formatDate(now, 'Asia/Manila', "yyyy-MM-dd'T'23:59:59");
  const todayWeekday = WEEKDAY_FIELDS[now.getDay()]; // 0=Sunday

  const adjustmentSearchFrom = Utilities.formatDate(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), 'Asia/Manila', "yyyy-MM-dd'T'00:00:00");
  const adjustmentSearchTo = Utilities.formatDate(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), 'Asia/Manila', "yyyy-MM-dd'T'23:59:59");
  const userId = PropertiesService.getScriptProperties().getProperty('SPROUT_USER_ID');

  // Employees, Attendance Logs, Leave (create step), and Schedule Adjustments
  // (list step) are all independent of each other, so fire all of them
  // together instead of one-after-another — cuts real round trips on every
  // refresh, since only Employees ever caches now (Leave and Schedule
  // Adjustments were both switched to always-fresh after a real test case
  // showed cached data could hide a same-day filed/approved change).
  var preloadedEmployeesResponse, preloadedAttendanceResponse, preloadedLeaveCreateResponse, preloadedAdjustmentsFirstResponse;
  var employeesCacheCold = !CacheService.getScriptCache().get('sprout_employees');

  var attendanceUrl = SPROUT_BASE + '/timeattendance/api/v1/AttendanceLogs'
    + '?DateFrom=' + encodeURIComponent(dateFromISO)
    + '&DateTo=' + encodeURIComponent(dateToISO)
    + '&RowsPerPage=100&PageNumber=1';
  var leaveCreateUrl = SPROUT_BASE + '/timeattendance/api/v1/Leaves/SearchCriteria';
  var adjustmentsUrl = SPROUT_BASE + '/timeattendance/api/v1/ScheduleAdjustments'
    + '?DateFrom=' + encodeURIComponent(adjustmentSearchFrom)
    + '&DateTo=' + encodeURIComponent(adjustmentSearchTo)
    + '&StatusId=4&SortColumn=DateFiled&SortOrder=asc&RowsPerPage=100&PageNumber=1';

  try {
    var headers = sproutHeaders();
    var leaveHeaders = sproutHeaders();
    leaveHeaders['UserId'] = userId;

    var batchRequests = [
      { url: attendanceUrl, headers: headers, muteHttpExceptions: true },
      {
        url: leaveCreateUrl, method: 'post', contentType: 'application/json', headers: leaveHeaders,
        payload: JSON.stringify({ UserId: Number(userId), dateFrom: dateFromISO, dateTo: dateToISO, statusIds: [4], pageNumber: 1, rowsPerPage: 100 }),
        muteHttpExceptions: true
      },
      { url: adjustmentsUrl, headers: headers, muteHttpExceptions: true }
    ];
    if (employeesCacheCold) {
      batchRequests.unshift({
        url: SPROUT_BASE + '/empservice/api/v1/Employees?Include=WorkSchedule&Include=WorkInformation&RowsPerPage=100&PageNumber=1',
        headers: headers, muteHttpExceptions: true
      });
    }

    var batchResponses = UrlFetchApp.fetchAll(batchRequests);
    var idx = 0;
    var empResp = employeesCacheCold ? batchResponses[idx++] : null;
    var attResp = batchResponses[idx++];
    var leaveResp = batchResponses[idx++];
    var adjResp = batchResponses[idx++];

    function isTransient(resp) {
      var code = resp.getResponseCode();
      return code === 429 || (code >= 500 && code < 600);
    }
    if (empResp && isTransient(empResp)) {
      try { empResp = fetchWithRetry(batchRequests[0].url, { headers: headers, muteHttpExceptions: true }); } catch (e) { /* surfaces downstream */ }
    }
    if (isTransient(attResp)) {
      try { attResp = fetchWithRetry(attendanceUrl, { headers: headers, muteHttpExceptions: true }); } catch (e) { /* surfaces downstream */ }
    }
    if (isTransient(leaveResp)) {
      try { leaveResp = fetchWithRetry(leaveCreateUrl, { method: 'post', contentType: 'application/json', headers: leaveHeaders, payload: batchRequests[employeesCacheCold ? 2 : 1].payload, muteHttpExceptions: true }); } catch (e) { /* surfaces downstream */ }
    }
    if (isTransient(adjResp)) {
      try { adjResp = fetchWithRetry(adjustmentsUrl, { headers: headers, muteHttpExceptions: true }); } catch (e) { /* surfaces downstream */ }
    }

    preloadedEmployeesResponse = empResp;
    preloadedAttendanceResponse = attResp;
    preloadedLeaveCreateResponse = leaveResp;
    preloadedAdjustmentsFirstResponse = adjResp;
  } catch (e) {
    // If the parallel batch itself fails for any reason, just fall through —
    // the normal calls below will fetch everything sequentially instead.
  }

  const employees = getEmployees(preloadedEmployeesResponse);
  const logs = getAttendanceLogs(dateFromISO, dateToISO, preloadedAttendanceResponse);

  let leaves = [];
  let leaveCheckFailed = false;
  try {
    leaves = getApprovedLeaves(dateFromISO, dateToISO, preloadedLeaveCreateResponse);
  } catch (err) {
    leaveCheckFailed = true;
    Logger.log('WARNING: Leave check failed, continuing without it: ' + err.message);
  }

  let scheduleAdjustments = [];
  let scheduleAdjustmentCheckFailed = false;
  try {
    scheduleAdjustments = getScheduleAdjustments(adjustmentSearchFrom, adjustmentSearchTo, preloadedAdjustmentsFirstResponse);
  } catch (err) {
    scheduleAdjustmentCheckFailed = true;
    Logger.log('WARNING: Schedule adjustment check failed, continuing without it: ' + err.message);
  }

  const todayDateKey = Utilities.formatDate(now, 'Asia/Manila', 'yyyy-MM-dd');
  const attendanceIndex = buildDayAttendanceIndex(logs, todayDateKey);
  const dayContext = {
    weekday: todayWeekday,
    dayDate: now,
    firstInByBioId: attendanceIndex.firstInByBioId,
    firstOutByBioId: attendanceIndex.firstOutByBioId,
    leaveEmployeeIds: buildDayLeaveIndex(leaves, todayDateKey),
    adjustmentByEmployeeId: buildDayAdjustmentIndex(scheduleAdjustments, todayDateKey)
  };

  const report = newEmptyReport();
  employees.forEach(function (emp) {
    const result = classifyEmployeeForDay(emp, dayContext);
    report[result.status].push(result.entry);
  });

  report.leaveCheckFailed = leaveCheckFailed;
  report.scheduleAdjustmentCheckFailed = scheduleAdjustmentCheckFailed;
  return report;
}

// ---------- Multi-day report (Last 2 / 5 / 7 days) ----------
// Fetches each data source ONCE for the whole range (not once per day) to
// keep this efficient, then applies the exact same classifyEmployeeForDay
// rules per day. Returns an array of { dateKey, report } from oldest to
// most recent (today last).
function computeReportsForDateRange(numDays) {
  const now = new Date();
  const dayDates = [];
  for (var i = numDays - 1; i >= 0; i--) {
    dayDates.push(new Date(now.getTime() - i * 24 * 60 * 60 * 1000));
  }

  const rangeStart = dayDates[0];
  const dateFromISO = Utilities.formatDate(rangeStart, 'Asia/Manila', "yyyy-MM-dd'T'00:00:00");
  const dateToISO = Utilities.formatDate(now, 'Asia/Manila', "yyyy-MM-dd'T'23:59:59");

  const employees = getEmployees();
  const logs = getAttendanceLogs(dateFromISO, dateToISO);

  let leaves = [];
  let leaveCheckFailed = false;
  try {
    leaves = getApprovedLeaves(dateFromISO, dateToISO);
  } catch (err) {
    leaveCheckFailed = true;
    Logger.log('WARNING: Leave check failed, continuing without it: ' + err.message);
  }

  let scheduleAdjustments = [];
  let scheduleAdjustmentCheckFailed = false;
  try {
    const adjustmentSearchFrom = Utilities.formatDate(new Date(rangeStart.getTime() - 30 * 24 * 60 * 60 * 1000), 'Asia/Manila', "yyyy-MM-dd'T'00:00:00");
    const adjustmentSearchTo = Utilities.formatDate(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), 'Asia/Manila', "yyyy-MM-dd'T'23:59:59");
    scheduleAdjustments = getScheduleAdjustments(adjustmentSearchFrom, adjustmentSearchTo);
  } catch (err) {
    scheduleAdjustmentCheckFailed = true;
    Logger.log('WARNING: Schedule adjustment check failed, continuing without it: ' + err.message);
  }

  const results = dayDates.map(function (dayDate) {
    const dayKey = Utilities.formatDate(dayDate, 'Asia/Manila', 'yyyy-MM-dd');
    const weekday = WEEKDAY_FIELDS[dayDate.getDay()];
    const attendanceIndex = buildDayAttendanceIndex(logs, dayKey);

    const dayContext = {
      weekday: weekday,
      dayDate: dayDate,
      firstInByBioId: attendanceIndex.firstInByBioId,
      firstOutByBioId: attendanceIndex.firstOutByBioId,
      leaveEmployeeIds: buildDayLeaveIndex(leaves, dayKey),
      adjustmentByEmployeeId: buildDayAdjustmentIndex(scheduleAdjustments, dayKey)
    };

    const report = newEmptyReport();
    employees.forEach(function (emp) {
      const result = classifyEmployeeForDay(emp, dayContext);
      report[result.status].push(result.entry);
    });
    report.leaveCheckFailed = leaveCheckFailed;
    report.scheduleAdjustmentCheckFailed = scheduleAdjustmentCheckFailed;

    return { dateKey: dayKey, report: report };
  });

  return results;
}

// ---------- STEP 6: Reply in Google Chat ----------
function buildChatCard(report) {
  function line(list, formatter) {
    if (list.length === 0) return '_None_';
    return list.map(formatter).join('\n');
  }

  const text =
    '*Shift Board — Today*\n\n' +
    '*Late — no log-in yet, shift ongoing (' + report.late.length + ')*\n' +
    line(report.late, function (e) { return '• ' + e.name; }) + '\n\n' +
    '*Present but Late (' + report.presentButLate.length + ')*\n' +
    line(report.presentButLate, function (e) { return '• ' + e.name + (e.lateMinutes != null ? ' (' + e.lateMinutes + ' min)' : ' (no log-in, has log-out)'); }) + '\n\n' +
    '*On Leave (' + report.onLeave.length + ')*\n' +
    line(report.onLeave, function (e) { return '• ' + e.name; }) + '\n\n' +
    '*On Time (' + report.onTime.length + ')*\n' +
    line(report.onTime, function (e) { return '• ' + e.name; }) + '\n\n' +
    '*Did Not Report — shift ended, never showed (' + report.didNotReport.length + ')*\n' +
    line(report.didNotReport, function (e) { return '• ' + e.name; }) + '\n\n' +
    '*Rest Day (' + report.restDay.length + ')*\n' +
    line(report.restDay, function (e) { return '• ' + e.name; });

  return { text: text };
}

// This function runs automatically whenever someone messages the bot in Chat.
function onMessage(event) {
  try {
    const report = computeTodayReport();
    return buildChatCard(report);
  } catch (err) {
    return { text: 'Something went wrong pulling today\'s attendance: ' + err.message };
  }
}

// ---------- OBSERVABILITY: log every run to a Google Sheet ----------
// Creates a dedicated Sheet automatically the first time this runs, then
// appends one row per request: timestamp, success/failure, and a summary.
// This gives a persistent history to check later, instead of only the
// Apps Script Execution log (which isn't kept for long and isn't visible
// outside the editor).
function logRun(status, message) {
  try {
    var props = PropertiesService.getScriptProperties();
    var sheetId = props.getProperty('LOG_SHEET_ID');
    var spreadsheet;

    if (sheetId) {
      try {
        spreadsheet = SpreadsheetApp.openById(sheetId);
      } catch (e) {
        spreadsheet = null; // sheet was deleted or ID is stale — recreate below
      }
    }

    if (!spreadsheet) {
      spreadsheet = SpreadsheetApp.create('Shift Board — Run Log');
      var sheet = spreadsheet.getSheets()[0];
      sheet.appendRow(['Timestamp', 'Status', 'Details']);
      props.setProperty('LOG_SHEET_ID', spreadsheet.getId());
    }

    var sheet = spreadsheet.getSheets()[0];
    sheet.appendRow([new Date(), status, message || '']);

    // Keep the log from growing forever — trim to the most recent 1000 rows.
    var lastRow = sheet.getLastRow();
    if (lastRow > 1001) {
      sheet.deleteRows(2, lastRow - 1001);
    }
  } catch (e) {
    // Logging must never break the actual report — if the Sheet write fails
    // for any reason, silently skip it rather than affecting the response.
  }
}

// ---------- WEB ENDPOINT (for the dashboard, no Chat needed) ----------
// After deploying this as a Web App (see setup guide Step 5b), you'll get
// a URL. Paste that URL into the dashboard's APPS_SCRIPT_URL setting.
//
// SECURITY: this endpoint requires a matching ?key= value, checked against
// the DASHBOARD_ACCESS_KEY script property. Without this, anyone who ever
// saw the bare URL (screenshot, browser history, shared link, etc.) could
// pull the full company's attendance/leave/department report with no
// login at all. Set DASHBOARD_ACCESS_KEY to a long random string in
// Script Properties, then paste the URL into the dashboard as:
//   https://script.google.com/macros/s/XXXX/exec?key=YOUR_LONG_RANDOM_STRING
function doGet(e) {
  var requiredKey = PropertiesService.getScriptProperties().getProperty('DASHBOARD_ACCESS_KEY');
  var providedKey = e && e.parameter && e.parameter.key;

  if (requiredKey && providedKey !== requiredKey) {
    logRun('UNAUTHORIZED', 'Request made without a valid access key.');
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: 'Unauthorized — missing or incorrect access key.' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var requestedDays = parseInt(e && e.parameter && e.parameter.days, 10);

  try {
    if (requestedDays && requestedDays > 1) {
      // Multi-day view (Last 2 / 5 / 7 days) — same rules, applied per day.
      var dayResults = computeReportsForDateRange(requestedDays);
      var summaryParts = dayResults.map(function (d) {
        return d.dateKey + ': late=' + d.report.late.length +
          ', presentButLate=' + d.report.presentButLate.length +
          ', onLeave=' + d.report.onLeave.length +
          ', onTime=' + d.report.onTime.length +
          ', didNotReport=' + d.report.didNotReport.length +
          ', restDay=' + d.report.restDay.length;
      });
      logRun('SUCCESS', 'Multi-day (' + requestedDays + ' days): ' + summaryParts.join(' | '));
      return ContentService
        .createTextOutput(JSON.stringify({ ok: true, reports: dayResults, generatedAt: new Date().toISOString() }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const report = computeTodayReport();
    var summary = 'late=' + report.late.length +
      ', presentButLate=' + report.presentButLate.length +
      ', onLeave=' + report.onLeave.length +
      ', onTime=' + report.onTime.length +
      ', didNotReport=' + report.didNotReport.length +
      ', restDay=' + report.restDay.length +
      (report.leaveCheckFailed ? ' (leave check failed)' : '') +
      (report.scheduleAdjustmentCheckFailed ? ' (schedule adjustment check failed)' : '');
    logRun('SUCCESS', summary);
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, report: report, generatedAt: new Date().toISOString() }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    logRun('FAILURE', err.message);
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
