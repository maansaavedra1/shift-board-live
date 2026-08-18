/**
 * Core Sprout HR integration logic — identical to the verified Azure
 * Functions port (shift-board-azure/src/functions/shiftBoard.js), just
 * extracted into its own module so it can be reused by an Express server
 * instead of an Azure Function trigger. The classification rules and
 * confirmed Sprout API quirks (UserId header, flat Leave response, the
 * Schedule Adjustments date-filter behavior, safe string-based date
 * comparisons) are unchanged.
 *
 * Same caveat as the Azure port: this has NOT been tested against a live
 * Sprout API call. Verify against your sandbox before trusting it with
 * real client data.
 */

const SPROUT_BASE = process.env.SPROUT_BASE || 'https://gateway-sb.sprout.ph';
const WEEKDAY_FIELDS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

let cachedToken = null;
let cachedTokenExpiry = 0;

async function fetchWithRetry(url, options, maxAttempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        lastError = new Error(`Transient HTTP ${response.status}: ${await response.text()}`);
      } else {
        return response;
      }
    } catch (err) {
      lastError = err;
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt - 1)));
    }
  }
  throw lastError;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;

  const response = await fetchWithRetry(`${SPROUT_BASE}/auth/connect/token`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': process.env.SPROUT_SUBSCRIPTION_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: new URLSearchParams({
      Client_Id: process.env.SPROUT_CLIENT_ID,
      Client_Secret: process.env.SPROUT_CLIENT_SECRET,
      grant_type: 'client_credentials'
    })
  });

  if (response.status !== 200) {
    throw new Error(`Token request failed (${response.status}): ${await response.text()}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  cachedTokenExpiry = Date.now() + ((data.expires_in || 3600) - 120) * 1000;
  return cachedToken;
}

async function sproutHeaders() {
  return {
    'Authorization': `Bearer ${await getAccessToken()}`,
    'Ocp-Apim-Subscription-Key': process.env.SPROUT_SUBSCRIPTION_KEY,
    'Accept': 'application/json'
  };
}

async function getEmployees(preloadedFirstResponse) {
  let allEmployees = [];
  let pageNumber = 1;
  const pageSize = 100;

  while (true) {
    const url = `${SPROUT_BASE}/empservice/api/v1/Employees?Include=WorkSchedule&Include=WorkInformation&RowsPerPage=${pageSize}&PageNumber=${pageNumber}`;
    const response = (pageNumber === 1 && preloadedFirstResponse)
      ? preloadedFirstResponse
      : await fetchWithRetry(url, { headers: await sproutHeaders() });

    if (response.status !== 200) {
      throw new Error(`Employees request failed: ${await response.text()}`);
    }
    const data = await response.json();
    const page = data.data || [];
    allEmployees = allEmployees.concat(page);
    if (page.length < pageSize) break;
    pageNumber++;
    if (pageNumber > 50) break;
  }

  return allEmployees;
}

async function getAttendanceLogs(dateFromISO, dateToISO, preloadedFirstResponse) {
  let allLogs = [];
  let pageNumber = 1;
  const pageSize = 100;

  while (true) {
    const url = `${SPROUT_BASE}/timeattendance/api/v1/AttendanceLogs?DateFrom=${encodeURIComponent(dateFromISO)}&DateTo=${encodeURIComponent(dateToISO)}&RowsPerPage=${pageSize}&PageNumber=${pageNumber}`;
    const response = (pageNumber === 1 && preloadedFirstResponse)
      ? preloadedFirstResponse
      : await fetchWithRetry(url, { headers: await sproutHeaders() });

    if (response.status !== 200) {
      throw new Error(`AttendanceLogs request failed: ${await response.text()}`);
    }
    const data = await response.json();
    const page = data.data || [];
    allLogs = allLogs.concat(page);
    if (page.length < pageSize) break;
    pageNumber++;
    if (pageNumber > 100) break;
  }

  return allLogs;
}

async function getApprovedLeaves(dateFromISO, dateToISO, preloadedCreateResponse) {
  const userId = process.env.SPROUT_USER_ID;
  const createUrl = `${SPROUT_BASE}/timeattendance/api/v1/Leaves/SearchCriteria`;
  const createHeaders = { ...(await sproutHeaders()), 'UserId': userId, 'Content-Type': 'application/json' };

  const createResponse = preloadedCreateResponse || await fetchWithRetry(createUrl, {
    method: 'POST',
    headers: createHeaders,
    body: JSON.stringify({
      UserId: Number(userId),
      dateFrom: dateFromISO,
      dateTo: dateToISO,
      statusIds: [4],
      pageNumber: 1,
      rowsPerPage: 100
    })
  });

  if (createResponse.status !== 201 && createResponse.status !== 200) {
    throw new Error(`Leaves SearchCriteria (create) failed: ${await createResponse.text()}`);
  }
  const createData = await createResponse.json();
  const searchCriteriaId = createData.searchCriteriaId;
  if (!searchCriteriaId) return [];

  const fetchUrl = `${SPROUT_BASE}/timeattendance/api/v1/Leaves/SearchCriteria?SearchCriteriaId=${encodeURIComponent(searchCriteriaId)}`;
  const fetchHeaders = { ...(await sproutHeaders()), 'UserId': userId };
  const fetchResponse = await fetchWithRetry(fetchUrl, { headers: fetchHeaders });

  if (fetchResponse.status !== 200) {
    throw new Error(`Leaves SearchCriteria (fetch) failed: ${await fetchResponse.text()}`);
  }
  const fetchData = await fetchResponse.json();
  return fetchData.data || [];
}

async function getScheduleAdjustments(dateFromISO, dateToISO, preloadedFirstResponse) {
  let allAdjustments = [];
  let pageNumber = 1;
  const pageSize = 100;

  while (true) {
    const url = `${SPROUT_BASE}/timeattendance/api/v1/ScheduleAdjustments?DateFrom=${encodeURIComponent(dateFromISO)}&DateTo=${encodeURIComponent(dateToISO)}&StatusId=4&SortColumn=DateFiled&SortOrder=asc&RowsPerPage=${pageSize}&PageNumber=${pageNumber}`;
    const response = (pageNumber === 1 && preloadedFirstResponse)
      ? preloadedFirstResponse
      : await fetchWithRetry(url, { headers: await sproutHeaders() });

    if (response.status !== 200) {
      throw new Error(`ScheduleAdjustments list request failed: ${await response.text()}`);
    }
    const data = await response.json();
    const page = data.data || [];
    allAdjustments = allAdjustments.concat(page);
    if (page.length < pageSize) break;
    pageNumber++;
    if (pageNumber > 20) break;
  }

  if (allAdjustments.length === 0) return [];

  const detailHeaders = await sproutHeaders();
  const detailResults = await Promise.all(
    allAdjustments.map(async (item) => {
      try {
        const detailResponse = await fetchWithRetry(
          `${SPROUT_BASE}/timeattendance/api/v1/ScheduleAdjustment/${item.id}`,
          { headers: detailHeaders }
        );
        if (detailResponse.status === 200) return await detailResponse.json();
        return null;
      } catch (err) {
        return null;
      }
    })
  );

  return detailResults.filter((d) => d !== null);
}

function classifyEmployeeForDay(emp, dayContext) {
  const basic = emp.basicInformation || {};
  const work = emp.workInformation || {};
  const schedule = emp.workSchedule || {};
  const name = `${basic.firstName || ''} ${basic.lastName || ''}`;
  const bioId = work.biometricId;
  const systemId = basic.systemId;

  const department = work.department || '—';
  const supervisor = work.reportsTo || '—';
  const contactInfo = { department, supervisor };

  const adjustment = dayContext.adjustmentByEmployeeId[systemId];
  const isRestDay = adjustment
    ? !!adjustment.isRestDay
    : schedule[`${dayContext.weekday}IsRestday`];
  if (isRestDay) {
    return { status: 'restDay', entry: { name, ...contactInfo } };
  }

  if (dayContext.leaveEmployeeIds[systemId]) {
    return { status: 'onLeave', entry: { name, ...contactInfo } };
  }

  const shiftFromStr = (adjustment && adjustment.shiftFrom) || schedule[`${dayContext.weekday}From`];
  const shiftToStr = (adjustment && adjustment.shiftTo) || schedule[`${dayContext.weekday}To`];
  const inTime = dayContext.firstInByBioId[bioId];
  const outTime = dayContext.firstOutByBioId[bioId];

  if (!inTime) {
    if (outTime) {
      return {
        status: 'presentButLate',
        entry: { name, ...contactInfo, lateMinutes: null, reason: 'missing log-in (has log-out)' }
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
      return { status: 'didNotReport', entry: { name, ...contactInfo, reason: 'no log-in or log-out, shift already ended' } };
    }
    return { status: 'late', entry: { name, ...contactInfo, reason: 'no log-in yet, shift still ongoing' } };
  }

  if (!shiftFromStr) {
    return { status: 'onTime', entry: { name, ...contactInfo, hasLogout: !!outTime } };
  }

  const [h, m] = shiftFromStr.split(':').map(Number);
  const shiftStart = new Date(inTime);
  shiftStart.setHours(h, m, 0, 0);
  const lateMinutes = Math.round((inTime - shiftStart) / 60000);
  if (lateMinutes > 0) {
    return { status: 'presentButLate', entry: { name, ...contactInfo, lateMinutes, hasLogout: !!outTime } };
  }

  return { status: 'onTime', entry: { name, ...contactInfo, hasLogout: !!outTime } };
}

function newEmptyReport() {
  return { late: [], presentButLate: [], onLeave: [], onTime: [], restDay: [], didNotReport: [] };
}

function formatDateKey(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

function buildDayAttendanceIndex(allLogs, dayKey) {
  const firstInByBioId = {};
  const firstOutByBioId = {};
  allLogs.forEach((log) => {
    const logDateKey = formatDateKey(new Date(log.logTime));
    if (logDateKey !== dayKey) return;
    const bioId = log.bioEmpID;
    const logTime = new Date(log.logTime);
    const modeStr = String(log.inOutMode).toLowerCase();
    const isIn = modeStr === 'in' || modeStr === '0';
    const isOut = modeStr === 'out' || modeStr === '1';
    if (isIn && (!firstInByBioId[bioId] || logTime < firstInByBioId[bioId])) firstInByBioId[bioId] = logTime;
    if (isOut && (!firstOutByBioId[bioId] || logTime < firstOutByBioId[bioId])) firstOutByBioId[bioId] = logTime;
  });
  return { firstInByBioId, firstOutByBioId };
}

function buildDayLeaveIndex(allLeaves, dayKey) {
  const leaveEmployeeIds = {};
  allLeaves.forEach((leave) => {
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
  scheduleAdjustments.forEach((adj) => {
    const empId = adj.employeeId;
    if (!empId || !adj.details) return;
    const dayDetail = adj.details.find((d) => d.date.substring(0, 10) === dayKey);
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

async function computeTodayReport() {
  const now = new Date();
  const todayKey = formatDateKey(now);
  const dateFromISO = `${todayKey}T00:00:00`;
  const dateToISO = `${todayKey}T23:59:59`;
  const todayWeekday = WEEKDAY_FIELDS[now.getDay()];

  const adjustmentSearchFrom = `${formatDateKey(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000))}T00:00:00`;
  const adjustmentSearchTo = `${formatDateKey(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000))}T23:59:59`;
  const userId = process.env.SPROUT_USER_ID;

  let leaveCheckFailed = false;
  let scheduleAdjustmentCheckFailed = false;

  const headers = await sproutHeaders();
  const leaveHeaders = { ...headers, 'UserId': userId, 'Content-Type': 'application/json' };

  const employeesUrl = `${SPROUT_BASE}/empservice/api/v1/Employees?Include=WorkSchedule&Include=WorkInformation&RowsPerPage=100&PageNumber=1`;
  const attendanceUrl = `${SPROUT_BASE}/timeattendance/api/v1/AttendanceLogs?DateFrom=${encodeURIComponent(dateFromISO)}&DateTo=${encodeURIComponent(dateToISO)}&RowsPerPage=100&PageNumber=1`;
  const leaveCreateUrl = `${SPROUT_BASE}/timeattendance/api/v1/Leaves/SearchCriteria`;
  const adjustmentsUrl = `${SPROUT_BASE}/timeattendance/api/v1/ScheduleAdjustments?DateFrom=${encodeURIComponent(adjustmentSearchFrom)}&DateTo=${encodeURIComponent(adjustmentSearchTo)}&StatusId=4&SortColumn=DateFiled&SortOrder=asc&RowsPerPage=100&PageNumber=1`;

  const [empResp, attResp, leaveResp, adjResp] = await Promise.allSettled([
    fetchWithRetry(employeesUrl, { headers }),
    fetchWithRetry(attendanceUrl, { headers }),
    fetchWithRetry(leaveCreateUrl, {
      method: 'POST',
      headers: leaveHeaders,
      body: JSON.stringify({ UserId: Number(userId), dateFrom: dateFromISO, dateTo: dateToISO, statusIds: [4], pageNumber: 1, rowsPerPage: 100 })
    }),
    fetchWithRetry(adjustmentsUrl, { headers })
  ]);

  const employees = await getEmployees(empResp.status === 'fulfilled' ? empResp.value : undefined);
  const logs = await getAttendanceLogs(dateFromISO, dateToISO, attResp.status === 'fulfilled' ? attResp.value : undefined);

  let leaves = [];
  try {
    leaves = await getApprovedLeaves(dateFromISO, dateToISO, leaveResp.status === 'fulfilled' ? leaveResp.value : undefined);
  } catch (err) {
    leaveCheckFailed = true;
  }

  let scheduleAdjustments = [];
  try {
    scheduleAdjustments = await getScheduleAdjustments(adjustmentSearchFrom, adjustmentSearchTo, adjResp.status === 'fulfilled' ? adjResp.value : undefined);
  } catch (err) {
    scheduleAdjustmentCheckFailed = true;
  }

  const attendanceIndex = buildDayAttendanceIndex(logs, todayKey);
  const dayContext = {
    weekday: todayWeekday,
    dayDate: now,
    firstInByBioId: attendanceIndex.firstInByBioId,
    firstOutByBioId: attendanceIndex.firstOutByBioId,
    leaveEmployeeIds: buildDayLeaveIndex(leaves, todayKey),
    adjustmentByEmployeeId: buildDayAdjustmentIndex(scheduleAdjustments, todayKey)
  };

  const report = newEmptyReport();
  employees.forEach((emp) => {
    const result = classifyEmployeeForDay(emp, dayContext);
    report[result.status].push(result.entry);
  });

  report.leaveCheckFailed = leaveCheckFailed;
  report.scheduleAdjustmentCheckFailed = scheduleAdjustmentCheckFailed;
  return report;
}

async function computeReportsForDateRange(numDays) {
  const now = new Date();
  const dayDates = [];
  for (let i = numDays - 1; i >= 0; i--) {
    dayDates.push(new Date(now.getTime() - i * 24 * 60 * 60 * 1000));
  }

  const rangeStart = dayDates[0];
  const dateFromISO = `${formatDateKey(rangeStart)}T00:00:00`;
  const dateToISO = `${formatDateKey(now)}T23:59:59`;

  const employees = await getEmployees();
  const logs = await getAttendanceLogs(dateFromISO, dateToISO);

  let leaves = [];
  let leaveCheckFailed = false;
  try {
    leaves = await getApprovedLeaves(dateFromISO, dateToISO);
  } catch (err) {
    leaveCheckFailed = true;
  }

  let scheduleAdjustments = [];
  let scheduleAdjustmentCheckFailed = false;
  try {
    const adjustmentSearchFrom = `${formatDateKey(new Date(rangeStart.getTime() - 30 * 24 * 60 * 60 * 1000))}T00:00:00`;
    const adjustmentSearchTo = `${formatDateKey(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000))}T23:59:59`;
    scheduleAdjustments = await getScheduleAdjustments(adjustmentSearchFrom, adjustmentSearchTo);
  } catch (err) {
    scheduleAdjustmentCheckFailed = true;
  }

  return dayDates.map((dayDate) => {
    const dayKey = formatDateKey(dayDate);
    const weekday = WEEKDAY_FIELDS[dayDate.getDay()];
    const attendanceIndex = buildDayAttendanceIndex(logs, dayKey);

    const dayContext = {
      weekday,
      dayDate,
      firstInByBioId: attendanceIndex.firstInByBioId,
      firstOutByBioId: attendanceIndex.firstOutByBioId,
      leaveEmployeeIds: buildDayLeaveIndex(leaves, dayKey),
      adjustmentByEmployeeId: buildDayAdjustmentIndex(scheduleAdjustments, dayKey)
    };

    const report = newEmptyReport();
    employees.forEach((emp) => {
      const result = classifyEmployeeForDay(emp, dayContext);
      report[result.status].push(result.entry);
    });
    report.leaveCheckFailed = leaveCheckFailed;
    report.scheduleAdjustmentCheckFailed = scheduleAdjustmentCheckFailed;

    return { dateKey: dayKey, report };
  });
}

module.exports = { computeTodayReport, computeReportsForDateRange };
