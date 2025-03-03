import dotenv from 'dotenv';
import OpenAI from 'openai';
import { DetectedIssue, PostHogEvent } from './posthog';
import * as fs from 'fs';
import { ProcessedRRwebData, ProcessedRRwebEvent } from './rrweb';
import path from 'path';

// Load environment variables
dotenv.config();

// Constants for optimization
const MAX_SCREENSHOTS = 3;
const MAX_EVENTS_PER_SESSION = 10;
const MAX_SESSIONS = 3;
const TIME_WINDOW_MS = 5000; // 5 second window for contextual events
const MAX_JSON_PREVIEW_LENGTH = 2000;

// Simple logger interface
interface Logger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

// Create a simple logger
const logger: Logger = {
  info: (message: string) => console.log(`[INFO] ${message}`),
  warn: (message: string) => console.warn(`[WARN] ${message}`),
  error: (message: string) => console.error(`[ERROR] ${message}`)
};

/**
 * Groups events by session ID
 * @param events Array of PostHog events
 * @returns Array of objects containing sessionId and corresponding events
 */
function groupEventsBySession(events: PostHogEvent[]): { sessionId: string; events: PostHogEvent[] }[] {
  const sessions: Record<string, PostHogEvent[]> = {};
  
  events.forEach(event => {
    const sessionId = event.properties?.$session_id;
    if (sessionId) {
      if (!sessions[sessionId]) {
        sessions[sessionId] = [];
      }
      sessions[sessionId].push(event);
    }
  });
  
  return Object.entries(sessions).map(([sessionId, events]) => ({
    sessionId,
    events
  }));
}

/**
 * Selects the most relevant sessions based on number of events
 * @param sessions Array of session objects with events
 * @param maxSessions Maximum number of sessions to select
 * @returns Array of selected session objects
 */
function selectRelevantSessions(
  sessions: { sessionId: string; events: PostHogEvent[] }[],
  maxSessions: number
): { sessionId: string; events: PostHogEvent[] }[] {
  return [...sessions]
    .sort((a, b) => b.events.length - a.events.length)
    .slice(0, maxSessions);
}

/**
 * Selects the most relevant events from a session
 * @param events Array of PostHog events
 * @param maxEvents Maximum number of events to select
 * @returns Array of selected events
 */
function selectRelevantEvents(events: PostHogEvent[], maxEvents: number): PostHogEvent[] {
  // Prioritize events with element information
  const eventsWithElements = events.filter(event => 
    event.properties?.$el_text || 
    event.properties?.$el_selector ||
    event.event === '$rageclick'
  );
  
  // If we have enough events with elements, return those
  if (eventsWithElements.length >= maxEvents) {
    return eventsWithElements.slice(0, maxEvents);
  }
  
  // Otherwise, add other important events
  const otherImportantEvents = events.filter(event => 
    !eventsWithElements.includes(event) && 
    ['$pageview', '$pageleave'].includes(event.event as string)
  );
  
  // Combine and limit
  return [...eventsWithElements, ...otherImportantEvents].slice(0, maxEvents);
}

/**
 * Find screenshots that correspond with events that have element information
 * @param screenshotFiles Array of screenshot filenames
 * @param events Array of PostHog events with element information
 * @param maxScreenshots Maximum number of screenshots to return
 * @returns Array of screenshot filenames prioritized by relevance
 */
function selectRelevantScreenshots(
  screenshotFiles: string[],
  events: PostHogEvent[],
  maxScreenshots: number
): string[] {
  // Extract timestamps from events with element information
  const eventTimestamps = events
    .filter(event => 
      event.properties?.$el_text || 
      event.properties?.$el_selector ||
      event.event === '$rageclick'
    )
    .map(event => event.timestamp || 0);
  
  // Extract timestamps from screenshot filenames
  const screenshotsWithTimestamps = screenshotFiles.map(filename => {
    const match = filename.match(/time_(\d+)\.png/);
    return {
      filename,
      timestamp: match ? parseInt(match[1]) : 0
    };
  });
  
  // If we have event timestamps, find screenshots closest to those timestamps
  if (eventTimestamps.length > 0) {
    screenshotsWithTimestamps.sort((a, b) => {
      const aClosestDiff = Math.min(...eventTimestamps.map(t => Math.abs(Number(t) - a.timestamp)));
      const bClosestDiff = Math.min(...eventTimestamps.map(t => Math.abs(Number(t) - b.timestamp)));
      return aClosestDiff - bClosestDiff;
    });
  }
  
  return screenshotsWithTimestamps.slice(0, maxScreenshots).map(s => s.filename);
}

/**
 * For a given screenshot, find related element information from nearby events
 * @param screenshotFilename Filename of the screenshot
 * @param events Array of PostHog events
 * @returns Context string containing element information, or empty string if none found
 */
function getElementContextForScreenshot(screenshotFilename: string, events: PostHogEvent[]): string {
  // Extract timestamp from screenshot filename
  const match = screenshotFilename.match(/time_(\d+)\.png/);
  if (!match) return '';
  
  const screenshotTimestamp = parseInt(match[1]);
  
  // Find events that occurred within the time window of the screenshot
  const nearbyEvents = events.filter(event => {
    const eventTimestamp = Number(event.timestamp) || 0;
    return Math.abs(eventTimestamp - screenshotTimestamp) <= TIME_WINDOW_MS;
  });
  
  // Extract element information from nearby events
  const elementsInfo = nearbyEvents
    .filter(event => 
      event.properties?.$el_text || 
      event.properties?.$el_selector ||
      event.event === '$rageclick'
    )
    .map(event => {
      const elementText = event.properties?.$el_text || 'N/A';
      const elementSelector = event.properties?.$el_selector || 'N/A';
      const elementTag = event.properties?.$el_tag_name || 'N/A';
      const eventType = event.event || 'unknown';
      
      return `- Event: ${eventType}\n  Element: ${elementText} (${elementTag})\n  Selector: ${elementSelector}`;
    });
  
  if (elementsInfo.length === 0) return '';
  
  return `User interaction context:\n${elementsInfo.join('\n')}`;
}

/**
 * Compresses an event to only include essential properties
 * @param event Full PostHog event
 * @returns Simplified event object
 */
function compressEvent(event: PostHogEvent): Record<string, any> {
  return {
    event: event.event,
    timestamp: event.timestamp,
    properties: {
      $current_url: event.properties?.$current_url,
      $el_text: event.properties?.$el_text,
      $el_selector: event.properties?.$el_selector,
      $el_tag_name: event.properties?.$el_tag_name,
      $browser: event.properties?.$browser,
      $os: event.properties?.$os,
      $device_type: event.properties?.$device_type
    }
  };
}

/**
 * Reads screenshot from file and converts to base64
 * @param filepath Path to the screenshot file
 * @returns Base64-encoded image string or empty string on error
 */
async function readScreenshotFromFile(filepath: string): Promise<string> {
  try {
    const imageBuffer = fs.readFileSync(filepath);
    return imageBuffer.toString('base64');
  } catch (error) {
    logger.error(`Error reading screenshot from file: ${error}`);
    return '';
  }
}

/**
 * Simplify events to reduce token usage but preserve element details
 * @param events Array of PostHog events
 * @returns Array of simplified event objects
 */
function simplifyEvents(events: PostHogEvent[]): Record<string, any>[] {
  return events.map(event => {
    // Extract just the essential properties
    const simplifiedEvent: Record<string, any> = {
      event: event.event,
      timestamp: event.timestamp,
      distinct_id: event.distinct_id.substring(0, 8), // Truncate distinct_id to save tokens
      properties: {
        $current_url: event.properties?.$current_url,
        $event_type: event.properties?.$event_type,
        $host: event.properties?.$host,
        $pathname: event.properties?.$pathname,
        
        // Always include element selectors for any event type that might have them
        $el_text: event.properties?.$el_text,
        $el_tag_name: event.properties?.$el_tag_name,
        $el_selector: event.properties?.$el_selector,
        $el_class: event.properties?.$el_class,
        $el_id: event.properties?.$el_id,
      }
    };
    
    // Add specialized properties for specific event types
    if (event.event === '$autocapture') {
      simplifiedEvent.properties = {
        ...simplifiedEvent.properties,
        $el_text: event.properties?.$el_text,
        $el_tag_name: event.properties?.$el_tag_name,
        $el_selector: event.properties?.$el_selector,
        $el_class: event.properties?.$el_class,
        $el_id: event.properties?.$el_id,
      };
    } else if (event.event === '$rageclick') {
      simplifiedEvent.properties = {
        ...simplifiedEvent.properties,
        $rageclick_count: event.properties?.$rageclick_count,
        $el_selector: event.properties?.$el_selector,
      };
    }
    
    // If the event has an elements_chain, include that as well
    if (event.elements_chain) {
      simplifiedEvent.properties.$elements_chain = event.elements_chain;
    }
    
    return simplifiedEvent;
  });
}

/**
 * Creates a detailed context for OpenAI with event data
 * @param events Array of simplified event objects
 * @returns Context string for OpenAI
 */
export function createContextForOpenAI(events: Record<string, any>[]): string {
  // Count unique users and event types
  const distinctIds = new Set(events.map(e => e.distinct_id));
  const eventTypes = new Set(events.map(e => e.event));
  
  // Highlight events with element selectors for better element analysis
  const eventsWithElementInfo = events.map(event => {
    const hasElementSelector = 
      event.properties?.$el_selector || 
      (event.properties && '$el_selector' in event.properties);
    
    return {
      ...event,
      _hasElementInfo: hasElementSelector,
      _elementSelector: event.properties?.$el_selector || 'N/A',
      _elementTag: event.properties?.$el_tag_name || 'N/A',
      _elementText: event.properties?.$el_text || 'N/A'
    };
  });
  
  return `
I need you to analyze ${events.length} user events from our application and identify potential UX issues. Events are from ${distinctIds.size} distinct users and include event types: ${Array.from(eventTypes).join(', ')}.

Here's the event data:
${JSON.stringify(eventsWithElementInfo, null, 2)}

Please analyze these events and identify patterns that might indicate UX issues, such as:
- Rage clicks (users repeatedly clicking on something that doesn't respond)
- Dead clicks (users clicking on non-interactive elements)
- Error states
- Form abandonment
- Navigation difficulties
- Confusion with the interface

IMPORTANT: Pay close attention to the '_hasElementInfo', '_elementSelector', '_elementTag', and '_elementText' fields which highlight events with element information.

Then, for each unique issue you identify, draft a ticket in the following JSON format:
[
  {
    "title": "Concise title describing the issue",
    "severity": "low", "medium", or "high" based on user impact,
    "description": "Detailed description of the issue including:
- The problem observed
- Evidence from the event data
- Impact on users
- Possible solutions",
    "pageUrl": "The affected page URL",
    "elementSelector": "The CSS selector of the problematic element (if applicable - should be taken from the '_elementSelector' field when available)",
    "suggestedFix": "Brief suggestion for how to address the issue"
  }
]

If you don't detect any issues, return an empty array [].

VERY IMPORTANT: Output ONLY valid JSON with no additional formatting, no code blocks, and no explanatory text before or after the JSON. Your entire response should be a valid JSON array that can be directly parsed.
`;
}

/**
 * Create a ticket for manual review when automated analysis fails
 * @param events Array of PostHog events
 * @returns DetectedIssue object
 */
function createManualReviewTicket(events: PostHogEvent[]): DetectedIssue {
  const distinctIds = new Set(events.map(e => e.distinct_id));
  
  const eventTypeCount: Record<string, number> = {};
  for (const event of events) {
    eventTypeCount[event.event] = (eventTypeCount[event.event] || 0) + 1;
  }
  
  return {
    title: 'Potential UX Issues Detected - Manual Review Required',
    severity: 'medium',
    description: `
## Automated Analysis Failed

The AI analysis of PostHog events failed to complete. A manual review of the data is recommended.

### Event Summary
- Total Events: ${events.length}
- Event Types: ${Object.keys(eventTypeCount).join(', ')}
- Unique Users: ${distinctIds.size}

### Recommendation
Please review the raw PostHog data in the dashboard to identify potential UX issues manually.
    `,
    pageUrl: 'N/A',
    elementSelector: 'N/A',
    suggestedFix: 'Manual review of the data in PostHog dashboard is required'
  };
}

/**
 * Map severity to ticket priority
 * @param severity Severity string (high, medium, low)
 * @returns Priority string
 */
export function mapSeverityToPriority(severity: string): string {
  switch (severity.toLowerCase()) {
    case 'high':
      return 'High';
    case 'medium':
      return 'Medium';
    case 'low':
      return 'Low';
    default:
      return 'Medium';
  }
}

/**
 * Analyze events and draft tickets for detected issues
 * @param events Array of PostHog events
 * @returns Array of ticket strings
 */
export async function analyzeEventsAndDraftTickets(events: PostHogEvent[]): Promise<string[]> {
  try {
    // Check if there are any events to analyze
    if (!events.length) {
      logger.warn('No events available for analysis');
      return ['No events available for analysis'];
    }

    // Initialize OpenAI API client
    const openai = new OpenAI();
    logger.info('OpenAI client initialized successfully');

    // Get array of screenshots if available
    const screenshotDir = path.join(process.cwd(), 'screenshots');
    let screenshotFiles: string[] = [];
    
    try {
      if (fs.existsSync(screenshotDir)) {
        screenshotFiles = fs.readdirSync(screenshotDir)
          .filter(file => file.endsWith('.png'));
        logger.info(`Found ${screenshotFiles.length} screenshots in the screenshots directory`);
      }
    } catch (error) {
      logger.error(`Error reading screenshot directory: ${error}`);
    }

    // Group events by session
    const sessions = groupEventsBySession(events);
    logger.info(`Events grouped into ${sessions.length} user sessions`);

    // Select most relevant sessions
    const selectedSessions = selectRelevantSessions(sessions, MAX_SESSIONS);
    logger.info(`Selected ${selectedSessions.length} sessions for analysis`);

    // Select most relevant events from each session
    const selectedEvents: PostHogEvent[] = [];
    selectedSessions.forEach(session => {
      const relevantSessionEvents = selectRelevantEvents(session.events, MAX_EVENTS_PER_SESSION);
      selectedEvents.push(...relevantSessionEvents);
    });
    logger.info(`Selected ${selectedEvents.length} events for analysis`);

    // Select most relevant screenshots
    const selectedScreenshots = selectRelevantScreenshots(screenshotFiles, selectedEvents, MAX_SCREENSHOTS);
    logger.info(`Limiting analysis to ${selectedScreenshots.length} screenshots (out of ${screenshotFiles.length} total)`);

    // Prepare content blocks for OpenAI
    const contentBlocks: { type: string; text?: string; image_url?: { url: string } }[] = [];
    
    // Add initial text content with event summary
    contentBlocks.push({
      type: "text",
      text: `
# PostHog Analysis Request

## Event Summary
- Total Events: ${events.length}
- Selected Events: ${selectedEvents.length}
- Number of Sessions: ${sessions.length}
- Selected Sessions: ${selectedSessions.length}

## Selected Event Types
${Array.from(new Set(selectedEvents.map(e => e.event))).join(', ')}

## Event Data (Compressed)
\`\`\`json
${JSON.stringify(selectedEvents.map(compressEvent), null, 2).substring(0, MAX_JSON_PREVIEW_LENGTH)}
...
\`\`\`
      `.trim()
    });

    // Add screenshots (if available)
    for (const screenshot of selectedScreenshots) {
      try {
        const screenshotPath = path.join(screenshotDir, screenshot);
        const base64Image = await readScreenshotFromFile(screenshotPath);
        
        if (base64Image) {
          // Add the image
          contentBlocks.push({
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${base64Image}`
            }
          });
          
          // Add context about the screenshot with timestamp for correlation
          const sessionMatch = screenshot.match(/session_([^_]+)_time/);
          const sessionId = sessionMatch ? sessionMatch[1] : 'unknown';
          const timestamp = screenshot.match(/time_(\d+)\.png/)?.[1] || 'unknown';
          
          contentBlocks.push({
            type: "text",
            text: `Screenshot Info (${screenshot}):\n- Session ID: ${sessionId}\n- Timestamp: ${timestamp}`
          });
          
          // Add element context if available
          const elementContext = getElementContextForScreenshot(screenshot, selectedEvents);
          if (elementContext) {
            contentBlocks.push({
              type: "text",
              text: elementContext
            });
          }
        } else {
          logger.warn(`Invalid base64 data for screenshot: ${screenshot}`);
          contentBlocks.push({
            type: "text",
            text: `[Failed to load screenshot: ${screenshot}]`
          });
        }
      } catch (error) {
        logger.error(`Error processing screenshot ${screenshot}: ${error}`);
        contentBlocks.push({
          type: "text",
          text: `[Error loading screenshot: ${screenshot}]`
        });
      }
    }

    // Call the OpenAI API
    logger.info(`Sending analysis request to OpenAI with ${contentBlocks.length} content blocks`);
    
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are an expert UX analyst. Analyze the provided PostHog events and screenshots to identify potential UX issues.
          
Focus on:
1. Dead clicks (user clicked but nothing happened)
2. Rage clicks (user repeatedly clicked in frustration)
3. Error states
4. Confusing navigation
5. Form submission issues
6. Performance problems

For each screenshot provided:
- Describe what you see in the UI
- Identify any visual issues or problems (misalignments, poor contrast, etc.)
- Note any elements that appear to be the target of user interaction
- Describe the visual state of the UI (loading, error, success, etc.)
- Identify any UI elements that might be causing confusion or frustration

Format each identified issue as a ticket with:
- Title: Clear, concise description of the issue
- Priority: High/Medium/Low
- Description: Detailed explanation including affected user flow
- Visual Analysis: Describe what you see in the screenshots related to this issue
- Affected Page: URL where the issue occurs
- Element: Specific UI element with the issue (use element selector if available)
- Suggested Fix: Concrete recommendation to resolve the issue

The Visual Analysis section should include detailed descriptions of what you observe in the screenshots, such as:
- The specific part of the UI where the issue occurs
- The visual state of elements (e.g., "button appears disabled but is receiving clicks") 
- Any visual cues that might mislead users
- Layout or design issues contributing to the problem

DO NOT MAKE UP ISSUES THAT ARE NOT EVIDENT IN THE DATA.
If no issues are detected, create a single ticket stating "No UX issues detected" with appropriate explanation.`
        },
        {
          role: "user",
          content: contentBlocks as any
        }
      ]
    });

    const response = completion.choices[0].message.content;
    if (!response) {
      logger.error('Empty response from OpenAI');
      return ['Error: Empty response from OpenAI'];
    }

    // Extract tickets from the response
    const tickets = response.split('---').filter(Boolean).map(ticket => ticket.trim());
    logger.info(`Generated ${tickets.length} ticket(s) for potential UX issues`);

    return tickets;
  } catch (error) {
    logger.error(`Error analyzing events and drafting tickets: ${error}`);
    
    // Return a fallback ticket when API fails
    return [
      `Title: Potential UX Issues Detected - Manual Review Required
Priority: Medium

Description:

## Automated Analysis Failed

The AI analysis of PostHog events failed to complete. A manual review of the data is recommended.

### Event Summary
- Total Events: ${events.length}
- Event Types: ${Array.from(new Set(events.map(e => e.event))).join(', ')}
- Unique Users: ${new Set(events.map(e => e.distinct_id)).size}

### Recommendation
Please review the raw PostHog data in the dashboard to identify potential UX issues manually.
    

Affected Page: ✅ N/A
Element: N/A

Suggested Fix: Manual review of the data in PostHog dashboard is required`
    ];
  }
}