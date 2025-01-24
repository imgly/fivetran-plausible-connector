const functions = require("@google-cloud/functions-framework");
const moment = require("moment-timezone");

/**
 * Cloud Function to sync data from Plausible to Fivetran.
 *
 * Expects a JSON body with the following structure:
 * {
 *   agent: string,           // Agent name from Fivetran (not used here)
 *   state: object,           // State object from Fivetran with e.g. lastDateTime, lastOffset
 *   secrets: {
 *     plausibleApiKey: string,
 *     siteId: string
 *   },
 *   customPayload: object,   // Custom payload from Fivetran (not used here)
 *   setup_test: boolean,     // Indicates if this is a connection test
 *   sync_id: string          // Sync ID from Fivetran
 * }
 */
functions.http("syncWithPlausible", async (req, res) => {
  // Timezone used by the Plausible dashboard.
  // Important so that moment can interpret the dimension timestamps correctly.
  const REPORTING_TIMEZONE = "Europe/Berlin";

  // Number of rows to fetch at once from Plausible.
  // Increase or decrease as needed based on performance or limits.
  const PAGE_SIZE = 1000;

  try {
    // 1) Parse the incoming body from Fivetran.
    const body = req.body || {};
    const { agent, state, secrets, customPayload, setup_test, sync_id } = body;

    // 2) Extract secrets from the request body (configured in Fivetran).
    const plausibleApiKey = secrets?.plausibleApiKey;
    const siteId = secrets?.siteId;

    // Validate required secrets. If missing, return an error immediately.
    if (!plausibleApiKey || !siteId) {
      return res.status(400).json({
        errorMessage: "Missing 'plausibleApiKey' or 'siteId' secret!",
        errorType: "ConfigurationError",
      });
    }

    // 3) If this is a setup test, just do a minimal connectivity check and exit.
    //    This is triggered by Fivetran's "Test Connection" button.
    if (setup_test) {
      try {
        const response = await fetch("https://plausible.io/api/v2/query", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${plausibleApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            site_id: siteId,
            metrics: ["visitors"],
            date_range: "day",
            dimensions: ["time:day"],
            pagination: { limit: 1, offset: 0 },
          }),
        });

        if (!response.ok) {
          const text = await response.text();
          return res.status(500).json({
            errorMessage: `Plausible API request failed (status=${response.status})`,
            errorType: "PlausibleAPIError",
            stackTrace: [text],
          });
        }

        // If successful, return no data but indicate success.
        return res.json({
          state: state || {},
          insert: {},
          hasMore: false,
        });
      } catch (error) {
        // Handle unexpected errors during the test request
        console.error("Setup test error:", error);
        return res.status(500).json({
          errorMessage: error.message || String(error),
          errorType: error.name || "RuntimeError",
          stackTrace: error.stack ? error.stack.split("\n") : [],
        });
      }
    }

    // 4) Determine pagination/state from Fivetran's last sync.
    //    'lastDateTime' indicates the most recent timestamp we've successfully synced.
    //    'lastOffset' tracks the pagination offset in the Plausible results for chunked fetching.
    const lastDateTime = state?.lastDateTime;
    const lastOffset = state?.lastOffset;

    // If we don't have a lastDateTime, let's fetch "all" (per Plausible's "all" range).
    // Otherwise, fetch from the last known timestamp to now.
    const range = lastDateTime
      ? [lastDateTime, new Date().toISOString()]
      : "all";

    // Determine next offset. If it's the first fetch, start at 0; otherwise increment by PAGE_SIZE.
    const offset = lastOffset == null ? 0 : lastOffset + PAGE_SIZE;

    // 5) Build the Plausible v2 query object to request timeseries data.
    //    Using dimension "time:hour" for hourly aggregated data.
    const plausibleQuery = {
      site_id: siteId,
      date_range: range,
      metrics: [
        "visitors",
        "visits",
        "pageviews",
        "bounce_rate",
        "visit_duration",
      ],
      dimensions: ["time:hour"],
      pagination: {
        limit: PAGE_SIZE,
        offset: offset,
      },
      include: {
        total_rows: true, // So we know how many total rows are available
      },
    };

    console.log(
      "Executing Plausible query:",
      JSON.stringify(plausibleQuery, null, 2)
    );

    // 6) Query the Plausible API.
    const response = await fetch("https://plausible.io/api/v2/query", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${plausibleApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(plausibleQuery),
    });

    // If Plausible returns an error, forward it to Fivetran.
    if (!response.ok) {
      const text = await response.text();
      return res.status(500).json({
        errorMessage: `Plausible API request failed (status=${response.status})`,
        errorType: "PlausibleAPIError",
        stackTrace: [text],
      });
    }

    // Parse the JSON response from Plausible.
    // Expected shape:
    // {
    //   results: [
    //     {
    //       dimensions: ["YYYY-MM-DD HH:mm"], // single dimension since "time:hour"
    //       metrics: [visitors, visits, pageviews, bounce_rate, visit_duration]
    //     },
    //     ...
    //   ],
    //   meta: { total_rows: <number of rows available> },
    //   query: { ... }
    // }
    const plausibleData = await response.json();
    const results = plausibleData.results || [];
    const totalRows = plausibleData.meta?.total_rows;

    console.log(
      `Fetched rows ${offset} to ${
        offset + PAGE_SIZE
      }, total ${totalRows} rows.`
    );

    // 7) Transform Plausible results into a row-based structure for Fivetran.
    //    We'll create "plausible_timeseries" rows, each with:
    //      - timestamp
    //      - visitors
    //      - pageviews
    //      - bounce_rate
    //      - visit_duration
    //      - visits
    const rows = [];

    for (const row of results) {
      const [dimDateTime] = row.dimensions; // "YYYY-MM-DD HH:mm"
      const [visitors, visits, pageviews, bounce_rate, visit_duration] =
        row.metrics;

      // Convert dimension string (in the Plausible dashboard's timezone) to UTC ISO8601.
      const timestamp = moment
        .tz(dimDateTime, "YYYY-MM-DD HH:mm", REPORTING_TIMEZONE)
        .toISOString();

      rows.push({
        timestamp,
        visitors,
        pageviews,
        bounce_rate,
        visit_duration,
        visits,
      });
    }

    // Check if more data is available by comparing total_rows to the next offset chunk.
    const hasMore = totalRows > offset + PAGE_SIZE;

    // 8) Determine new state for incremental fetch next time.
    //    If there's more data, keep the same lastDateTime but increment the offset.
    //    If no more data remains, update lastDateTime to the newest timestamp and clear the offset.
    let newState = { ...state };
    if (hasMore) {
      newState.lastOffset = offset;
    } else if (rows.length > 0) {
      // Sort the fetched rows by timestamp and pick the max (most recent) for lastDateTime.
      const sortedByDate = rows
        .slice()
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const maxDateTime = sortedByDate[sortedByDate.length - 1].timestamp;

      newState.lastDateTime = maxDateTime;
      delete newState.lastOffset; // reset offset once we've reached the end
    }

    // 9) Build the Fivetran output payload:
    //    - state: updated incremental state
    //    - insert: table data (plausible_timeseries)
    //    - schema: define primary key(s) for the table
    //    - hasMore: indicates if Fivetran should call again
    const output = {
      state: newState,
      insert: {
        plausible_timeseries: rows,
      },
      schema: {
        plausible_timeseries: {
          primary_key: ["timestamp"],
        },
      },
      hasMore,
    };

    console.log(
      `Returning ${rows.length} rows, hasMore=${hasMore}, newState=`,
      JSON.stringify(newState, null, 2)
    );

    // 10) Send the JSON response back to Fivetran.
    return res.status(200).json(output);
  } catch (err) {
    // Catch any unhandled errors and return a structured response to Fivetran.
    console.error("Unexpected error:", err);
    return res.status(500).json({
      errorMessage: err.message || String(err),
      errorType: err.name || "RuntimeError",
      stackTrace: err.stack ? err.stack.split("\n") : [],
    });
  }
});
