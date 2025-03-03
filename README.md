# AI Issue Spotter

An AI-powered tool that analyzes user behavior data from PostHog and RRweb session recordings to automatically identify UX issues and generate actionable tickets.

## Overview

This tool connects to PostHog to fetch user interaction events, analyzes them using OpenAI, and generates actionable UX issue tickets. It can also incorporate RRweb session recording data for deeper analysis of user behavior.

## Project Structure

The codebase is organized into the following files:

### Main Components

- `src/index.ts` - Main entry point that coordinates fetching data, analyzing it, and displaying results
- `src/posthog.ts` - Handles PostHog API interaction, event processing, and interface definitions
- `src/rrweb.ts` - Processes RRweb session recordings to identify UX issues
- `src/ai.ts` - Generates actionable tickets from analysis results
- `src/screenshot.ts` - Captures visual evidence from RRweb sessions for analysis
- `src/debugUtils.ts` - Utilities for debugging environment setup, configuration, and API connectivity

## Environment Setup

Create a `.env` file with the following variables:

```
POSTHOG_API_KEY=your_posthog_api_key
POSTHOG_HOST=https://app.posthog.com
OPENAI_API_KEY=your_openai_api_key
CHECK_INTERVAL_MINUTES=15
MAX_EVENTS_TO_ANALYZE=100
INCLUDE_SCREENSHOTS=true
DEBUG_MODE=false
```

## Running the Tool

1. Install dependencies: `npm install`
2. Build the project: `npm run build`
3. Run the tool: `npm run start`

For development with automatic reloading:
```bash
npm run dev
```

For watching file changes during development:
```bash
npm run watch
```

The tool will:
1. Fetch events from PostHog
2. Look for RRweb session recording data
3. Analyze the data using OpenAI
4. Generate actionable UX issue tickets

## Debugging and Troubleshooting

To verify your setup and test API connections:

```bash
node dist/debugUtils.js
```

This will:
- Check for proper environment configuration
- Validate the presence of required API keys
- Test connectivity to PostHog and OpenAI APIs
- Report any issues found

## Analysis Flow

1. PostHog events are fetched via the PostHog API
2. If available, RRweb session recording data is loaded and processed from a local file (Note: In a production environment, this would be fetched via an API integration)
3. Key user interaction patterns are extracted (hesitations, rage clicks, etc.)
4. Screenshots are captured at key moments in user sessions (when enabled)
5. Data is sent to OpenAI for analysis
6. Results are parsed and formatted into actionable tickets

Each ticket includes:
- Title
- Severity/Priority
- Detailed description with evidence
- Visual Analysis of screenshots related to the issue
- Affected page URL
- Element selector (when applicable)
- Suggested fix with actionable recommendations

## Features

- 🔄 Periodically fetches PostHog event data through their API
- 🧠 Uses AI to analyze user behavior patterns
- 🔍 Detects various UX issues:
  - Rage clicks (users rapidly clicking the same element)
  - Form abandonment (users starting but not completing forms)
  - Navigation loops (users getting stuck in circular navigation patterns)
  - Dead clicks (clicks on non-interactive elements that appear clickable)
- 📝 Uses OpenAI to draft detailed, actionable tickets for detected issues
- 📸 Captures screenshots from RRweb sessions to provide visual context for AI analysis
- 🔎 Includes detailed visual analysis of screenshots to identify UI/UX issues
- 🛠️ Includes suggested fixes for each detected issue to help developers address problems quickly
- 🔧 Robust error handling and recovery throughout the codebase
- 📋 Standardized logging system for consistent debugging
- 🔌 Connection testing to verify API accessibility

## Configuration

The application can be configured through environment variables:

- `POSTHOG_API_KEY`: Your PostHog API key
- `POSTHOG_HOST`: PostHog instance URL (defaults to https://app.posthog.com)
- `OPENAI_API_KEY`: Your OpenAI API key
- `CHECK_INTERVAL_MINUTES`: How often to check for issues (defaults to 15 minutes)
- `MAX_EVENTS_TO_ANALYZE`: Maximum number of events to fetch from PostHog (defaults to 100)
- `INCLUDE_SCREENSHOTS`: Set to 'true' to enable capturing screenshots from RRweb sessions (defaults to false)
- `DEBUG_MODE`: Set to 'true' to enable detailed logging and stack traces (defaults to false)

## How It Works

1. The application fetches recent events from PostHog at regular intervals
2. It loads RRweb session recording data from a local JSON file (in a real application, this would be retrieved via an API)
3. If screenshots are enabled, it recreates the RRweb sessions in a headless browser and captures key moments as images
4. The screenshots are converted to base64-encoded strings and passed to OpenAI's multimodal API along with the event data
5. It analyzes user behavior patterns to detect potential UX issues, using both event data and visual context from screenshots
6. When an issue is detected, it uses OpenAI's visual analysis capabilities to draft a detailed ticket
7. The ticket includes context about the issue, its impact, severity assessment, and specific suggested fixes
8. A dedicated "Visual Analysis" section provides detailed observations about what's visible in the UI screenshots

## Prerequisites

- Node.js 16+
- PostHog account with API access
- OpenAI API key

## License

MIT 