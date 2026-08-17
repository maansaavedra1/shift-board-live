/**
 * DEBUG / INSPECTION HELPERS
 * ---------------------------------------------------
 * These are development-time tools, not part of the actual report logic.
 * They call the same getEmployees()/getAttendanceLogs() functions defined
 * in Code.gs (Apps Script shares one global scope across all files in a
 * project, so this works without any imports).
 *
 * Add this as a SEPARATE FILE in your Apps Script project:
 *   Left sidebar > Files > + (next to "Files") > Script
 *   Name it "Debug", paste this content in, save.
 *
 * Before handing this project to a client, consider deleting this file
 * entirely (or at least not mentioning these functions to them) — they're
 * for your own troubleshooting, not part of the delivered product.
 */

// ---------- HELPER: confirm the exact saved access key ----------
// Run this, then compare the printed value character-by-character against
// what's in your dashboard URL's ?key= part.
// NOTE: this prints your actual secret key to the Execution log — only run
// this where you're comfortable with whoever has edit access to this
// project seeing that value.
function checkAccessKeySetup() {
  var value = PropertiesService.getScriptProperties().getProperty('DASHBOARD_ACCESS_KEY');
  if (!value) {
    Logger.log('DASHBOARD_ACCESS_KEY is NOT set in Script Properties. Add it first.');
    return;
  }
  Logger.log('DASHBOARD_ACCESS_KEY is currently: [' + value + ']');
  Logger.log('Length: ' + value.length + ' characters');
}

// ---------- HELPER: inspect real attendance log structure from the live API ----------
// Confirms whether inOutMode comes back as text ("In"/"Out") or numbers (0/1),
// and shows a few real sample rows. Checks the last 30 days so it doesn't
// depend on guessing which exact date has data in this sandbox.
function inspectAttendanceLogStructure() {
  var now = new Date();
  var thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  var dateFromISO = Utilities.formatDate(thirtyDaysAgo, 'Asia/Manila', "yyyy-MM-dd'T'00:00:00");
  var dateToISO = Utilities.formatDate(now, 'Asia/Manila', "yyyy-MM-dd'T'23:59:59");
  var logs = getAttendanceLogs(dateFromISO, dateToISO);
  if (logs.length === 0) {
    Logger.log('No attendance logs found in the last 30 days. This sandbox may not have any test data yet — add some biologs in Sprout HR, then re-run this.');
    return;
  }
  Logger.log('Found ' + logs.length + ' log(s) in the last 30 days. Showing up to 5:');
  logs.slice(0, 5).forEach(function (log) {
    Logger.log(JSON.stringify(log, null, 2));
  });
}

// ---------- HELPER: inspect one employee's full data shape ----------
// Run this, then check the log to find the exact field names for
// department and supervisor before wiring them into the real report.
function inspectEmployeeStructure() {
  var employees = getEmployees();
  if (employees.length === 0) {
    Logger.log('No employees found.');
    return;
  }
  Logger.log('Full structure of first employee record:');
  Logger.log(JSON.stringify(employees[0], null, 2));
}

// ---------- HELPER: (no longer needed) Schedule Adjustments caching was removed ----------
// Kept as a no-op for reference — Schedule Adjustments now always fetches
// fresh (no caching), after a real test case showed cached data could hide
// a just-approved adjustment. Nothing to clear anymore.
function clearScheduleAdjustmentsCache() {
  Logger.log('Schedule Adjustments caching was removed — this always fetches fresh now. Nothing to clear.');
}

// ---------- HELPER: check which bucket a specific employee landed in ----------
function checkEmployeeStatus() {
  var searchText = 'admin'; // <-- change this to check someone else
  var report = computeTodayReport();
  var statuses = ['late', 'presentButLate', 'onTime', 'didNotReport', 'onLeave', 'restDay'];
  var found = false;
  statuses.forEach(function (status) {
    (report[status] || []).forEach(function (e) {
      if (e.name.toLowerCase().indexOf(searchText.toLowerCase()) !== -1) {
        Logger.log('FOUND: ' + e.name + ' is in bucket: ' + status);
        Logger.log(JSON.stringify(e, null, 2));
        found = true;
      }
    });
  });
  if (!found) Logger.log('No one matching "' + searchText + '" found in any bucket.');
}

// ---------- HELPER: inspect real leave data now that UserId header is fixed ----------
function inspectLeaveStructure() {
  var now = new Date();
  var dateFromISO = Utilities.formatDate(now, 'Asia/Manila', "yyyy-MM-dd'T'00:00:00");
  var dateToISO = Utilities.formatDate(now, 'Asia/Manila', "yyyy-MM-dd'T'23:59:59");
  try {
    var leaves = getApprovedLeaves(dateFromISO, dateToISO);
    if (leaves.length === 0) {
      Logger.log('No approved leave found for today (' + dateFromISO.substring(0,10) + '). This could mean genuinely nobody is on approved leave today, or the sandbox simply has no leave data at all for this date.');
      return;
    }
    Logger.log('Found ' + leaves.length + ' approved leave record(s):');
    leaves.forEach(function (l) {
      Logger.log(JSON.stringify(l, null, 2));
    });
  } catch (err) {
    Logger.log('ERROR: ' + err.message);
  }
}

// ---------- HELPER: find any employee by name, and show their systemId ----------
// Change the search text below to whatever name you're checking.
function findEmployeeByName() {
  var searchText = 'batara'; // <-- change this to search for someone else
  var employees = getEmployees();
  var matches = employees.filter(function (emp) {
    var basic = emp.basicInformation || {};
    var fullName = (basic.firstName || '') + ' ' + (basic.lastName || '');
    return fullName.toLowerCase().indexOf(searchText.toLowerCase()) !== -1;
  });
  if (matches.length === 0) {
    Logger.log('No employee found matching "' + searchText + '".');
    return;
  }
  matches.forEach(function (emp) {
    var basic = emp.basicInformation || {};
    Logger.log('MATCH: ' + (basic.firstName || '') + ' ' + (basic.lastName || '') + ' -> systemId: ' + basic.systemId);
  });
}

// ---------- HELPER: find your own employee record ----------
// Run this function (pick it from the dropdown), then check the log.
// Edit the name below if "Saavedra" isn't showing your record.
function findMyEmployeeId() {
  var employees = getEmployees();
  var matches = employees.filter(function (emp) {
    var basic = emp.basicInformation || {};
    var fullName = (basic.firstName || '') + ' ' + (basic.lastName || '');
    return fullName.toLowerCase().indexOf('saavedra') !== -1;
  });
  if (matches.length === 0) {
    Logger.log('No employee found matching "saavedra". Here are the first 5 names found instead:');
    employees.slice(0, 5).forEach(function (emp) {
      var basic = emp.basicInformation || {};
      Logger.log((basic.firstName || '') + ' ' + (basic.lastName || '') + ' -> systemId: ' + basic.systemId);
    });
    return;
  }
  matches.forEach(function (emp) {
    var basic = emp.basicInformation || {};
    Logger.log('MATCH: ' + (basic.firstName || '') + ' ' + (basic.lastName || '') + ' -> systemId: ' + basic.systemId);
  });
}

// ---------- HELPER: inspect real schedule adjustment structure ----------
// Run this once you have an employee with a real schedule adjustment on
// record (e.g. a specific date changed to a rest day). Confirms the actual
// detail-level fields (date/timeFrom/timeTo/isRestDay) match what Code.gs expects.
function inspectScheduleAdjustmentStructure() {
  var now = new Date();
  var thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  var thirtyDaysAhead = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  var dateFromISO = Utilities.formatDate(thirtyDaysAgo, 'Asia/Manila', "yyyy-MM-dd'T'00:00:00");
  var dateToISO = Utilities.formatDate(thirtyDaysAhead, 'Asia/Manila', "yyyy-MM-dd'T'23:59:59");
  var adjustments = getScheduleAdjustments(dateFromISO, dateToISO);
  if (adjustments.length === 0) {
    Logger.log('No APPROVED schedule adjustments found in the last/next 30 days. Note: this only looks for StatusId=4 (Approved) — a pending or rejected adjustment won\'t show up here.');
    return;
  }
  Logger.log('Found ' + adjustments.length + ' approved adjustment(s). Showing up to 5:');
  adjustments.slice(0, 5).forEach(function (adj) {
    Logger.log(JSON.stringify(adj, null, 2));
  });
}

// ---------- HELPER: view the run log sheet directly ----------
// Prints the URL of the observability log Sheet (created automatically the
// first time the dashboard runs) so you don't have to hunt for it in Drive.
function getLogSheetUrl() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty('LOG_SHEET_ID');
  if (!sheetId) {
    Logger.log('No log sheet has been created yet — it gets created automatically the first time the dashboard is used.');
    return;
  }
  Logger.log('Log sheet: https://docs.google.com/spreadsheets/d/' + sheetId + '/edit');
}

// ---------- HELPER: manually trigger Sheet creation + authorization ----------
// Run THIS function directly from the editor first (not via the dashboard).
// Google only shows the "allow this script to create Sheets?" permission
// popup when you run something from the editor — Web App requests never
// show that popup, they just fail silently if permission isn't granted yet.
// This forces that prompt to appear once, so the dashboard's calls work
// afterward.
function testLogging() {
  logRun('TEST', 'Manual authorization test run from the editor.');
  Logger.log('If you did not see a permissions popup, logging should now be working.');
  getLogSheetUrl();
}
