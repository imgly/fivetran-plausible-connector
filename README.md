# Plausible-to-Fivetran Cloud Function

A Google Cloud Function that fetches analytics data from [Plausible](https://plausible.io/) and streams it into [Fivetran](https://fivetran.com/). This function handles incremental syncs, respects timezones configured in your Plausible dashboard, and automatically merges data into a `timeseries` table within Fivetran.

---

## Table of Contents

- [Plausible-to-Fivetran Cloud Function](#plausible-to-fivetran-cloud-function)
  - [Table of Contents](#table-of-contents)
  - [Overview](#overview)
  - [Setup and Deployment](#setup-and-deployment)
  - [Configuration](#configuration)
  - [Usage](#usage)
  - [Testing the Integration](#testing-the-integration)
  - [About IMG.LY](#about-imgly)
  - [License](#license)

---

## Overview

This repository contains a Node.js function meant to be deployed on Google Cloud Functions. It leverages Fivetran’s [function connector](https://fivetran.com/docs/functions) to sync Plausible analytics data on a regular schedule. The function:

- Reads the `plausibleApiKey` and `siteId` secrets from the Fivetran request body.
- Queries Plausible’s v2 analytics API to retrieve incremental hourly data.
- Returns data in a format Fivetran can ingest (including a state object, table schema, and indicators for additional data).

---

## Setup and Deployment

Use the instructions in the official [Fivetran Google Cloud Functions setup guide](https://fivetran.com/docs/connectors/functions/google-cloud-functions/setup-guide) to deploy this function. Make sure to:

1. Provide this repository’s code as your function source.
2. Set the **entry point** to `syncWithPlausible`.
3. Configure two secrets in Fivetran’s **Configuration**:
   - `plausibleApiKey`: Your Plausible API key
   - `siteId`: The Plausible site ID you want to fetch analytics for

---

## Configuration

- **REPORTING_TIMEZONE**  
  Set within the code to match your Plausible dashboard’s timezone. Default is `Europe/Berlin`.
  
- **PAGE_SIZE**  
  The number of records fetched per API call. Default is `1000`. You can adjust this in the code to optimize for your data volume and performance.
  
- **State Management**  
  Fivetran manages a `state` object that the function updates. The function uses:
  - `state.lastDateTime` to know the last timestamp synced
  - `state.lastOffset` for pagination across Plausible’s API

---

## Usage

Once deployed and configured:

1. **Initial Sync**  
   - Fivetran calls the function with no `state`. The function fetches data starting from the earliest available date (or `"all"`) until the latest.  
   - It updates the Fivetran state with the newest timestamp retrieved (`lastDateTime`).

2. **Incremental Sync**  
   - On subsequent calls, Fivetran includes the `lastDateTime` in the request `state`.
   - The function queries Plausible from `lastDateTime` to the current time, ensuring only new data is retrieved.

3. **Data Destination**  
   - Fivetran creates or updates a `plausible_timeseries` table in your destination.
   - Columns include `timestamp`, `visitors`, `pageviews`, `bounce_rate`, `visit_duration`, and `visits`.

---

## Testing the Integration

- **Connection Test**  
  Fivetran’s **Test Connection** calls the function with `setup_test = true`. In this mode, the function performs a minimal API request to Plausible (requesting one row) to confirm credentials and endpoint availability.

- **Local Testing**  
  You can also run the function locally with the [Functions Framework](https://github.com/GoogleCloudPlatform/functions-framework-nodejs):
  ```bash
  npm install
  npx functions-framework --target=syncWithPlausible --port=8080
  ```
  Then POST a request to `http://localhost:8080/` to test the logic.

---

## About IMG.LY

Need a powerful image editing SDK for your next project? Check out [IMG.LY](https://img.ly). Our [CreativeEditor SDK](https://img.ly/products/creative-sdk) provides easy-to-integrate photo and video editing capabilities for web, iOS, and Android. Join thousands of developers who use IMG.LY to enhance their apps with filtering, transformations, stickers, and more—helping users unleash their creativity right inside your product.

---

## License

This project is open source, released under the [MIT License](LICENSE). You are free to use, modify, and distribute this code as permitted under the license terms.

---

**Happy Syncing!**
