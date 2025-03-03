import axios, { AxiosError, AxiosResponse } from 'axios';
import * as dotenv from 'dotenv';

// Ensure environment variables are loaded
dotenv.config();

// Constants
const DEFAULT_POSTHOG_HOST = 'https://app.posthog.com';
const DEFAULT_MAX_EVENTS = 100;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Create a simple logger
const logger = {
  info: (message: string) => console.log(`[INFO] ${message}`),
  warn: (message: string) => console.warn(`[WARN] ${message}`),
  error: (message: string, error?: unknown) => {
    console.error(`[ERROR] ${message}`);
    if (error) {
      if (error instanceof Error) {
        console.error(`       ${error.message}`);
      } else {
        console.error(`       ${String(error)}`);
      }
    }
  }
};

/**
 * Represents a PostHog event as returned by the API
 */
export interface PostHogEvent {
  /** Unique event identifier */
  id: string;
  /** Event type (e.g. $pageview, $autocapture) */
  event: string;
  /** User identifier */
  distinct_id: string;
  /** Event properties including metadata */
  properties: Record<string, any>;
  /** ISO formatted timestamp when the event occurred */
  timestamp: string;
  /** DOM element chain for autocaptured events */
  elements_chain?: string;
}

/**
 * Interface representing an issue ticket that will be generated from analysis
 */
export interface DetectedIssue {
  /** Descriptive title of the issue */
  title: string;
  /** Impact level of the issue */
  severity: 'low' | 'medium' | 'high';
  /** Detailed description of the issue */
  description: string;
  /** URL of the page where the issue occurs */
  pageUrl?: string;
  /** CSS selector of the problematic element */
  elementSelector?: string;
  /** Suggested solution to the issue */
  suggestedFix?: string;
}

/**
 * Event types that are relevant for UX analysis
 */
export enum UXRelevantEvents {
  AUTOCAPTURE = '$autocapture',
  RAGECLICK = '$rageclick',
  PAGEVIEW = '$pageview',
  PAGELEAVE = '$pageleave',
}

/**
 * Configuration options for fetching PostHog events
 */
interface PostHogFetchOptions {
  limit?: number;
  eventNames?: string[];
}

/**
 * Fetches recent events from PostHog API, filtered to events relevant for UX analysis
 * 
 * @param options - Optional configuration for the API request
 * @returns Array of PostHog events sorted by timestamp
 * @throws Error if PostHog API key is missing or API request fails
 */
export async function fetchPostHogEvents(options?: PostHogFetchOptions): Promise<PostHogEvent[]> {
  const apiKey = process.env.POSTHOG_API_KEY;
  const host = process.env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST;
  const maxEvents = options?.limit || parseInt(process.env.MAX_EVENTS_TO_ANALYZE || String(DEFAULT_MAX_EVENTS), 10);
  const eventNames = options?.eventNames || [
    UXRelevantEvents.AUTOCAPTURE,
    UXRelevantEvents.RAGECLICK,
    UXRelevantEvents.PAGEVIEW,
    UXRelevantEvents.PAGELEAVE
  ];
  
  if (!apiKey) {
    logger.error('PostHog API key is not configured in .env file');
    throw new Error('PostHog API key is not configured in .env file');
  }
  
  try {
    logger.info(`Fetching up to ${maxEvents} events from PostHog API at ${host}`);
    
    const response: AxiosResponse = await axios.get(`${host}/api/event/`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      params: {
        limit: maxEvents,
        event_names: JSON.stringify(eventNames),
      }
    });
    
    if (response.data && Array.isArray(response.data.results)) {
      const events = response.data.results as PostHogEvent[];
      logger.info(`Successfully fetched ${events.length} events from PostHog`);
      return events;
    }
    
    logger.warn('No events found in the PostHog API response or unexpected response format');
    return [];
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      logger.error(
        `Error fetching PostHog events: ${axiosError.message}`, 
        axiosError.response?.data || axiosError
      );
    } else {
      logger.error('Error fetching PostHog events:', error);
    }
    throw error;
  }
}

/**
 * Groups events by user session to provide context for analysis
 * 
 * A session is defined as a series of events from the same user within 30 minutes
 * of each other. This helps identify problems within a single user journey.
 * 
 * @param events - Array of PostHog events to group
 * @returns Object mapping session IDs to arrays of events within that session
 */
export function groupEventsBySession(events: PostHogEvent[]): Record<string, PostHogEvent[]> {
  if (!events || events.length === 0) {
    logger.warn('No events provided for session grouping');
    return {};
  }
  
  const sessions: Record<string, PostHogEvent[]> = {};
  
  // Sort events by timestamp
  const sortedEvents = [...events].sort((a, b) => 
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  
  logger.info(`Grouping ${events.length} events into sessions`);
  
  // Group by distinct_id (user) and session timeframe
  for (const event of sortedEvents) {
    const userId = event.distinct_id;
    const eventTime = new Date(event.timestamp).getTime();
    let sessionFound = false;
    
    // Check if this event belongs to an existing session
    for (const sessionId in sessions) {
      if (sessionId.startsWith(userId)) {
        const sessionEvents = sessions[sessionId];
        const lastEventTime = new Date(sessionEvents[sessionEvents.length - 1].timestamp).getTime();
        
        if (eventTime - lastEventTime < SESSION_TIMEOUT_MS) {
          sessions[sessionId].push(event);
          sessionFound = true;
          break;
        }
      }
    }
    
    // Create a new session if needed
    if (!sessionFound) {
      const sessionId = `${userId}_${eventTime}`;
      sessions[sessionId] = [event];
    }
  }
  
  logger.info(`Created ${Object.keys(sessions).length} distinct user sessions`);
  return sessions;
}

/**
 * Returns events of specific types from a collection of events
 * 
 * @param events - Collection of PostHog events to filter
 * @param eventTypes - Array of event types to include
 * @returns Filtered array of events matching the specified types
 */
export function filterEventsByType(events: PostHogEvent[], eventTypes: string[]): PostHogEvent[] {
  return events.filter(event => eventTypes.includes(event.event));
}

/**
 * Processes PostHog events for UX issue analysis
 * 
 * This is a pass-through processor that simply forwards the raw events to OpenAI
 * for analysis. All actual analysis is performed by OpenAI.
 * 
 * @param events - Raw PostHog events to be analyzed
 * @returns The same PostHog events, unmodified
 */
export async function analyzeUserBehavior(events: PostHogEvent[]): Promise<PostHogEvent[]> {
  if (!events || events.length === 0) {
    logger.warn('No events provided for analysis');
    return [];
  }
  
  logger.info(`Processing ${events.length} events for UX analysis`);
  
  // In the future, this function could be expanded to preprocess events
  // before sending them to OpenAI, or to implement local analysis logic
  
  return events;
} 