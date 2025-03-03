import * as fs from 'fs';
import * as path from 'path';
import { PostHogEvent } from './posthog';

// Constants
const EVENT_CONTEXT_WINDOW_SIZE = 5;
const NEARBY_EVENT_WINDOW_MS = 30000; // 30 seconds

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
 * Enum for RRweb event types 
 */
enum RRwebEventType {
  DomContentLoaded = 0,
  Load = 1,
  FullSnapshot = 2,
  IncrementalSnapshot = 3,
  Meta = 4,
  Custom = 5
}

/**
 * Enum for RRweb incremental snapshot types
 */
enum IncrementalSnapshotType {
  Mutation = 0,
  MouseMove = 1,
  MouseInteraction = 2,
  Scroll = 3,
  ViewportResize = 4,
  Input = 5,
  TouchMove = 6,
  MediaInteraction = 7,
  StyleSheetRule = 8,
  CanvasMutation = 9,
  Font = 10,
  Selection = 11
}

/**
 * Enum for RRweb mouse interaction types
 */
enum MouseInteractionType {
  MouseDown = 0,
  MouseUp = 1,
  Click = 2,
  ContextMenu = 3,
  DblClick = 4,
  Focus = 5,
  Blur = 6,
  TouchStart = 7,
  TouchMove_Departed = 8,
  TouchEnd = 9
}

/**
 * Base interface for RRweb event
 */
interface RRwebEvent {
  type: RRwebEventType;
  timestamp: number; // Timestamp in ms
  data: any;
}

/**
 * Main interface for processed RRweb data
 */
export interface ProcessedRRwebData {
  /** Unique identifier for the session */
  sessionId: string;
  /** Array of processed RRweb events */
  events: ProcessedRRwebEvent[];
  /** Metadata about the session */
  metadata: {
    /** Timestamp of the first event */
    startTime: number;
    /** Timestamp of the last event */
    endTime: number;
    /** Session duration in milliseconds */
    duration: number;
    /** URL of the page */
    url: string;
    /** User agent string */
    userAgent?: string;
  };
}

/**
 * Interface for a processed RRweb event with extracted information
 */
export interface ProcessedRRwebEvent {
  /** Timestamp in milliseconds */
  timestamp: number;
  /** Human-readable event type */
  type: string;
  /** Additional details about the event */
  details: Record<string, any>;
  /** URL of the page at the time of the event */
  url?: string;
  /** Information about the DOM element involved in the event */
  element?: {
    /** HTML tag name */
    tag: string;
    /** Element ID */
    id?: string;
    /** Element class name */
    className?: string;
    /** Text content of the element */
    textContent?: string;
    /** Element attributes */
    attributes?: Record<string, string>;
    /** Href attribute for links */
    href?: string;
    /** Src attribute for images, scripts, etc. */
    src?: string;
    /** Position and dimensions of the element */
    position?: { 
      x: number; 
      y: number; 
      width: number; 
      height: number; 
    };
  };
}

/**
 * Interface for a key moment extracted from RRweb data
 */
export interface RRwebKeyMoment {
  /** Type of key moment (e.g., 'RageClick', 'FormAbandonment') */
  type: string;
  /** Timestamp of the key moment */
  timestamp: number;
  /** Session ID */
  sessionId: string;
  /** URL where the key moment occurred */
  url: string;
  /** Description of the key moment */
  description: string;
  /** Element involved in the key moment */
  element?: ProcessedRRwebEvent['element'];
  /** Context events around the key moment */
  context?: ProcessedRRwebEvent[];
  /** Score indicating the significance of the moment */
  score?: number;
}

// Event type mapping for easier reading
const eventTypeMap: Record<number, string> = {
  [RRwebEventType.DomContentLoaded]: 'DomContentLoaded',
  [RRwebEventType.Load]: 'Load',
  [RRwebEventType.FullSnapshot]: 'FullSnapshot',
  [RRwebEventType.IncrementalSnapshot]: 'IncrementalSnapshot',
  [RRwebEventType.Meta]: 'Meta',
  [RRwebEventType.Custom]: 'Custom',
};

// Incremental snapshot types
const incrementalTypeMap: Record<number, string> = {
  [IncrementalSnapshotType.Mutation]: 'Mutation',
  [IncrementalSnapshotType.MouseMove]: 'MouseMove',
  [IncrementalSnapshotType.MouseInteraction]: 'MouseInteraction',
  [IncrementalSnapshotType.Scroll]: 'Scroll',
  [IncrementalSnapshotType.ViewportResize]: 'ViewportResize',
  [IncrementalSnapshotType.Input]: 'Input',
  [IncrementalSnapshotType.TouchMove]: 'TouchMove',
  [IncrementalSnapshotType.MediaInteraction]: 'MediaInteraction',
  [IncrementalSnapshotType.StyleSheetRule]: 'StyleSheetRule',
  [IncrementalSnapshotType.CanvasMutation]: 'CanvasMutation',
  [IncrementalSnapshotType.Font]: 'Font',
  [IncrementalSnapshotType.Selection]: 'Selection',
};

// Mouse interaction types
const mouseInteractionMap: Record<number, string> = {
  [MouseInteractionType.MouseDown]: 'MouseDown',
  [MouseInteractionType.MouseUp]: 'MouseUp',
  [MouseInteractionType.Click]: 'Click',
  [MouseInteractionType.ContextMenu]: 'ContextMenu',
  [MouseInteractionType.DblClick]: 'DblClick',
  [MouseInteractionType.Focus]: 'Focus',
  [MouseInteractionType.Blur]: 'Blur',
  [MouseInteractionType.TouchStart]: 'TouchStart',
  [MouseInteractionType.TouchMove_Departed]: 'TouchMove_Departed',
  [MouseInteractionType.TouchEnd]: 'TouchEnd',
};

/**
 * Safely parses JSON data from a string
 * @param jsonString The JSON string to parse
 * @returns The parsed JSON object or null if parsing fails
 */
function safeJsonParse(jsonString: string): any | null {
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    logger.error('Error parsing JSON:', error);
    return null;
  }
}

/**
 * Loads RRweb data from a file and processes it into a more useful format
 * @param filePath Path to the RRweb data file
 * @returns Array of processed RRweb data objects
 */
export function loadRRwebData(filePath: string): ProcessedRRwebData[] {
  try {
    logger.info(`Loading RRweb data from ${filePath}`);
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      logger.error(`File not found: ${filePath}`);
      return [];
    }
    
    const rawData = fs.readFileSync(filePath, 'utf8');
    const data = safeJsonParse(rawData);
    
    if (!data) {
      logger.error('Failed to parse RRweb data JSON');
      return [];
    }
    
    // Validate the data structure
    if (!data.sessions || !Array.isArray(data.sessions)) {
      logger.error('RRweb data does not have the expected format (no sessions array)');
      return [];
    }
    
    logger.info(`Found ${data.sessions.length} sessions in RRweb data`);
    
    // Process each session
    const processedData: ProcessedRRwebData[] = data.sessions.map((session: any) => {
      const sessionId = session.sessionId || `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      
      // Get all events from all records
      let allEvents: RRwebEvent[] = [];
      
      if (session.records && Array.isArray(session.records)) {
        session.records.forEach((record: any) => {
          if (record.events && Array.isArray(record.events)) {
            allEvents = allEvents.concat(record.events);
          }
        });
      }
      
      // Sort events by timestamp
      allEvents.sort((a, b) => a.timestamp - b.timestamp);
      
      // Get start and end times
      const startTime = allEvents.length > 0 ? allEvents[0].timestamp : 0;
      const endTime = allEvents.length > 0 ? allEvents[allEvents.length - 1].timestamp : 0;
      
      // Extract metadata from initial events
      let url = '';
      let userAgent = '';
      
      // Process all events to extract useful information
      const processedEvents = allEvents.map(event => {
        // Extract URLs and metadata when available
        if (event.type === RRwebEventType.Meta) { // Meta event
          if (event.data?.href) {
            url = event.data.href;
          }
          if (event.data?.userAgent) {
            userAgent = event.data.userAgent;
          }
        }
        
        return processRRwebEvent(event);
      });
      
      return {
        sessionId,
        events: processedEvents,
        metadata: {
          startTime,
          endTime,
          duration: endTime - startTime,
          url,
          userAgent
        }
      };
    });
    
    logger.info(`Successfully processed ${processedData.length} RRweb sessions`);
    return processedData;
  } catch (error) {
    logger.error('Error loading RRweb data:', error);
    return [];
  }
}

/**
 * Processes a single RRweb event to extract useful information
 * @param event The raw RRweb event to process
 * @returns Processed event with extracted information
 */
function processRRwebEvent(event: RRwebEvent): ProcessedRRwebEvent {
  const eventType = eventTypeMap[event.type] || 'Unknown';
  let details: Record<string, any> = {};
  let url: string | undefined;
  let element: ProcessedRRwebEvent['element'] | undefined;
  
  switch (event.type) {
    case RRwebEventType.IncrementalSnapshot: // IncrementalSnapshot
      const incrementalType = incrementalTypeMap[event.data.source] || 'Unknown';
      details = { incrementalType };
      
      // Extract more details based on the incremental type
      if (event.data.source === IncrementalSnapshotType.MouseInteraction) { // MouseInteraction
        details.interactionType = mouseInteractionMap[event.data.type] || 'Unknown';
        
        // Extract element information for clicks and other interactions
        if (event.data.target) {
          element = {
            tag: event.data.target.tagName,
            id: event.data.target.id,
            className: event.data.target.className,
            textContent: event.data.target.textContent,
            attributes: event.data.target.attributes,
            position: {
              x: event.data.x,
              y: event.data.y,
              width: event.data.target.width,
              height: event.data.target.height
            }
          };
        }
      } else if (event.data.source === IncrementalSnapshotType.Input) { // Input
        details.inputType = 'Input';
        details.value = event.data.text || event.data.value;
        
        if (event.data.target) {
          element = {
            tag: event.data.target.tagName,
            id: event.data.target.id,
            className: event.data.target.className,
            attributes: event.data.target.attributes
          };
        }
      }
      break;
      
    case RRwebEventType.Meta: // Meta
      details = { ...event.data };
      url = event.data.href;
      break;
      
    case RRwebEventType.Custom: // Custom
      details = { ...event.data };
      break;
      
    default:
      details = { ...event.data };
  }
  
  return {
    timestamp: event.timestamp,
    type: eventType,
    details,
    url,
    element
  };
}

/**
 * Helper function to get context around an event (events before and after)
 * @param events Array of processed events
 * @param currentIndex Index of the current event
 * @param windowSize Number of events to include before and after
 * @returns Array of events providing context
 */
function getContextAroundEvent(
  events: ProcessedRRwebEvent[], 
  currentIndex: number, 
  windowSize: number = EVENT_CONTEXT_WINDOW_SIZE
): ProcessedRRwebEvent[] {
  // Validate inputs
  if (!events || !Array.isArray(events) || events.length === 0) {
    return [];
  }
  
  if (currentIndex < 0 || currentIndex >= events.length) {
    return [];
  }
  
  const startIdx = Math.max(0, currentIndex - windowSize);
  const endIdx = Math.min(events.length - 1, currentIndex + windowSize);
  
  return events.slice(startIdx, endIdx + 1).map(e => {
    // Filter out large properties to keep context size manageable
    const { type, timestamp, details, element } = e;
    let simplifiedDetails = { ...details };
    
    // Remove verbose properties
    if (simplifiedDetails.positions && simplifiedDetails.positions.length > 3) {
      simplifiedDetails.positions = simplifiedDetails.positions.slice(0, 3);
    }
    
    return { type, timestamp, details: simplifiedDetails, element };
  });
}

/**
 * Extract key moments that indicate potential UX issues from RRweb data
 * Expanded to capture a wider range of interaction patterns
 */
export function extractKeyMoments(rrwebData: ProcessedRRwebData[]): any[] {
  const keyMoments: any[] = [];
  
  for (const session of rrwebData) {
    const { events, sessionId, metadata } = session;
    
    // Skip empty sessions
    if (!events || events.length === 0) continue;
    
    // Tracking variables
    let clickEvents: ProcessedRRwebEvent[] = [];
    let lastClickTime = 0;
    let formInteractions: ProcessedRRwebEvent[] = [];
    let currentFormId: string | null = null;
    let navigationEvents: ProcessedRRwebEvent[] = [];
    // Use metadata URL as default but don't use a hardcoded fallback
    let currentUrl: string = metadata?.url || "";
    let lastInputTime = 0;
    let lastInputValue: string | undefined = undefined;
    let scrollEvents: ProcessedRRwebEvent[] = [];
    let lastScrollTime = 0;
    let errorEvents: ProcessedRRwebEvent[] = [];
    let mouseMovements: ProcessedRRwebEvent[] = [];
    let lastMouseMoveTime = 0;
    let viewportSize = { width: 0, height: 0 };
    
    // Track interactive elements to detect dead clicks
    const interactiveElements = new Set<string>(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL']);
    
    // First pass to extract metadata
    for (const event of events) {
      if (event.type === 'Meta') {
        if (event.details.width && event.details.height) {
          viewportSize = {
            width: event.details.width,
            height: event.details.height
          };
        }
      }
      
      // Track current URL
      if (event.type === 'Navigate' && event.details.href) {
        currentUrl = event.details.href;
        
        // Add to navigation events
        navigationEvents.push(event);
        
        // Check for navigation loops (going back to the same URL repeatedly)
        const NAVIGATION_LOOP_THRESHOLD = 3;
        const NAVIGATION_LOOP_TIME_WINDOW = 120000; // 2 minutes
        
        const recentNavigations = navigationEvents
          .filter(e => e.timestamp > event.timestamp - NAVIGATION_LOOP_TIME_WINDOW)
          .filter(e => e.url === currentUrl);
        
        if (recentNavigations.length >= NAVIGATION_LOOP_THRESHOLD) {
          keyMoments.push({
            type: 'NavigationLoop',
            timestamp: event.timestamp,
            url: currentUrl,
            frequency: recentNavigations.length,
            timeWindow: NAVIGATION_LOOP_TIME_WINDOW,
            sessionId
          });
        }
      }
      
      // Capture error events 
      if (event.type === 'IncrementalSnapshot' && 
          event.details.incrementalType === 'Canvas' && 
          event.details.error) {
        errorEvents.push(event);
        keyMoments.push({
          type: 'JSError',
          timestamp: event.timestamp,
          error: event.details.error,
          url: currentUrl,
          sessionId
        });
      }
    }
    
    // Second pass for complex patterns
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      
      // Detect rage clicks (multiple rapid clicks in the same area)
      if (event.type === 'IncrementalSnapshot' && 
          event.details.incrementalType === 'MouseInteraction' &&
          (event.details.interactionType === 'Click' || event.details.interactionType === 'MouseDown')) {
        
        clickEvents.push(event);
        
        // Check for multiple clicks in quick succession
        const MAX_RAGE_CLICK_INTERVAL = 1000; // 1 second
        if (event.timestamp - lastClickTime < MAX_RAGE_CLICK_INTERVAL) {
          if (clickEvents.length >= 3) {
            // Check if clicks are in the same area (within 20px)
            const sameAreaClicks = clickEvents.filter(click => {
              if (!click.element || !event.element) return false;
              
              const xDistance = Math.abs((click.element.position?.x || 0) - (event.element.position?.x || 0));
              const yDistance = Math.abs((click.element.position?.y || 0) - (event.element.position?.y || 0));
              
              return xDistance < 20 && yDistance < 20;
            });
            
            if (sameAreaClicks.length >= 3) {
              keyMoments.push({
                type: 'RageClick',
                timestamp: event.timestamp,
                clickCount: sameAreaClicks.length,
                element: event.element,
                url: currentUrl,
                context: getContextAroundEvent(events, i, 5),
                sessionId
              });
              
              clickEvents = [];
            }
          }
        } else {
          clickEvents = [event];
        }
        
        lastClickTime = event.timestamp;
        
        // Detect dead clicks (clicks on non-interactive elements)
        if (event.element && 
            !interactiveElements.has(event.element.tag) && 
            !(event.element.className && event.element.className.includes('btn')) &&
            !(event.element.className && event.element.className.includes('button')) &&
            !(event.element.attributes && event.element.attributes['role'] === 'button') && 
            !(event.element.attributes && event.element.attributes.onclick)) {
          
          keyMoments.push({
            type: 'DeadClick',
            timestamp: event.timestamp,
            element: event.element,
            url: currentUrl,
            context: getContextAroundEvent(events, i, 3),
            sessionId
          });
        }
      }
      
      // Detect form abandonment
      if (event.type === 'IncrementalSnapshot' && 
          event.details.incrementalType === 'Input') {
        
        // Keep track of all form interactions
        formInteractions.push(event);
        lastInputTime = event.timestamp;
        lastInputValue = event.details.value === null ? undefined : event.details.value;
        
        if (event.element && event.element.attributes && event.element.attributes['form']) {
          currentFormId = event.element.attributes['form'] || `form-${formInteractions.length}`;
        }
      }
      
      // Check for form abandonment when navigating away
      if (event.type === 'Navigate' && currentFormId && formInteractions.length > 0) {
        // Check if any submit events happened within 5 seconds before navigation
        const submissionFound = events
          .slice(Math.max(0, i - 10), i)
          .some(e => 
            e.type === 'IncrementalSnapshot' && 
            e.details.incrementalType === 'MouseInteraction' && 
            e.details.interactionType === 'Click' && 
            e.element && 
            ((e.element.tag === 'BUTTON' && e.element.attributes && e.element.attributes.type === 'submit') || 
             (e.element.attributes && e.element.attributes['form'] === currentFormId))
          );
        
        if (!submissionFound && formInteractions.length >= 2) {
          keyMoments.push({
            type: 'FormAbandonment',
            timestamp: event.timestamp,
            formId: currentFormId,
            interactionCount: formInteractions.length,
            lastValue: lastInputValue,
            url: currentUrl,
            context: getContextAroundEvent(events, i, 10),
            sessionId
          });
        }
        
        // Reset form tracking
        formInteractions = [];
        currentFormId = null;
      }
      
      // Detect rapid scrolling (potentially looking for something)
      if (event.type === 'IncrementalSnapshot' && 
          event.details.incrementalType === 'Scroll') {
        
        scrollEvents.push(event);
        
        // Check for rapid scrolling (lots of scroll events in a short time)
        const SCROLL_DETECTION_WINDOW = 5000; // 5 seconds
        const RAPID_SCROLL_THRESHOLD = 8; // number of scroll events
        
        const recentScrolls = scrollEvents.filter(e => 
          e.timestamp > event.timestamp - SCROLL_DETECTION_WINDOW
        );
        
        if (recentScrolls.length >= RAPID_SCROLL_THRESHOLD) {
          keyMoments.push({
            type: 'RapidScrolling',
            timestamp: event.timestamp,
            scrollCount: recentScrolls.length,
            duration: event.timestamp - recentScrolls[0].timestamp,
            url: currentUrl,
            context: getContextAroundEvent(events, i, 5),
            sessionId
          });
          
          // Reset to avoid duplicate detection
          scrollEvents = scrollEvents.slice(-2);
        }
        
        lastScrollTime = event.timestamp;
      }
      
      // Detect mouse hovering (cursor staying in same area for extended period)
      if (event.type === 'IncrementalSnapshot' && 
          event.details.incrementalType === 'MouseMove') {
        
        mouseMovements.push(event);
        
        // If we have multiple mouse move events in same area over time
        if (mouseMovements.length >= 3 && event.timestamp - lastMouseMoveTime > 3000) {
          const lastMoves = mouseMovements.slice(-3);
          
          // Check if mouse has stayed within a small area
          const positions = lastMoves.map(m => {
            // Safely access the positions array
            if (m.details && m.details.positions && m.details.positions.length > 0) {
              return {
                x: m.details.positions[0].x,
                y: m.details.positions[0].y
              };
            }
            // Default position if not available
            return { x: 0, y: 0 };
          });
          
          // Only proceed if all positions are valid
          const allPositionsValid = positions.every(pos => pos.x !== 0 || pos.y !== 0);
          
          if (allPositionsValid) {
            const allPositionsWithinRange = positions.every((pos, idx) => {
              if (idx === 0) return true;
              
              const prevPos = positions[idx - 1];
              const xDist = Math.abs(pos.x - prevPos.x);
              const yDist = Math.abs(pos.y - prevPos.y);
              
              return xDist < 30 && yDist < 30;
            });
            
            if (allPositionsWithinRange) {
              keyMoments.push({
                type: 'MouseHovering',
                timestamp: event.timestamp,
                duration: event.timestamp - lastMoves[0].timestamp,
                position: positions[positions.length - 1],
                url: currentUrl,
                context: getContextAroundEvent(events, i, 3),
                sessionId
              });
            }
          }
        }
        
        lastMouseMoveTime = event.timestamp;
      }
      
      // Detect hesitation (long pauses between interactions)
      if (i > 0) {
        const prevEvent = events[i - 1];
        const timeDiff = event.timestamp - prevEvent.timestamp;
        
        // Only consider pauses during active interaction sessions, not between page loads
        if (timeDiff > 10000 && // More than 10 seconds
            timeDiff < 300000 && // Less than 5 minutes (to avoid counting normal breaks)
            event.type === 'IncrementalSnapshot' && 
            prevEvent.type === 'IncrementalSnapshot' &&
            (event.details.incrementalType === 'MouseInteraction' || 
             event.details.incrementalType === 'Input')) {
          
          keyMoments.push({
            type: 'Hesitation',
            timestamp: event.timestamp,
            durationMs: timeDiff,
            beforeEvent: prevEvent,
            afterEvent: event,
            url: currentUrl,
            context: getContextAroundEvent(events, i, 5),
            sessionId
          });
        }
      }
      
      // Detect multi-click submissions (user clicked submit multiple times)
      if (event.type === 'IncrementalSnapshot' && 
          event.details.incrementalType === 'MouseInteraction' &&
          event.details.interactionType === 'Click' &&
          event.element &&
          ((event.element.tag === 'BUTTON' && event.element.attributes && event.element.attributes.type === 'submit') ||
           (event.element.className && (
             event.element.className.includes('submit') || 
             event.element.className.includes('send')
           )))) {
        
        // Check for repeated submission clicks in a short period
        const SUBMISSION_WINDOW = 10000; // 10 seconds
        const recentSubmissions = events
          .slice(Math.max(0, i - 20), i)
          .filter(e => 
            e.type === 'IncrementalSnapshot' && 
            e.details.incrementalType === 'MouseInteraction' &&
            e.timestamp > event.timestamp - SUBMISSION_WINDOW &&
            e.element &&
            ((e.element.tag === 'BUTTON' && e.element.attributes && e.element.attributes.type === 'submit') ||
             (e.element.className && (
               e.element.className.includes('submit') || 
               e.element.className.includes('send')
             )))
          );
        
        if (recentSubmissions.length >= 2) {
          keyMoments.push({
            type: 'MultipleSubmissions',
            timestamp: event.timestamp,
            count: recentSubmissions.length + 1,
            element: event.element,
            url: currentUrl,
            context: getContextAroundEvent(events, i, 10),
            sessionId
          });
        }
      }
      
      // Detect viewport issues (horizontal scrolling on mobile size viewports)
      if (viewportSize.width < 768 && // Mobile-ish size
          event.type === 'IncrementalSnapshot' && 
          event.details.incrementalType === 'Scroll' &&
          event.details.x > 0) { // Horizontal scrolling detected
        
        keyMoments.push({
          type: 'HorizontalScrollMobile',
          timestamp: event.timestamp,
          viewport: viewportSize,
          scrollX: event.details.x,
          url: currentUrl,
          sessionId
        });
      }
    }
    
    // Post-session analysis
    
    // Check for form abandonment at the end of the session
    if (currentFormId && formInteractions.length > 0) {
      // If the session ended with form inputs without submission
      keyMoments.push({
        type: 'FormAbandonment',
        timestamp: events[events.length - 1].timestamp,
        formId: currentFormId,
        interactionCount: formInteractions.length,
        lastValue: lastInputValue,
        url: currentUrl,
        formCompleted: false,
        sessionId
      });
    }
    
    // Check for short sessions (user leaving quickly)
    const sessionDuration = session.metadata.duration;
    if (sessionDuration < 10000 && navigationEvents.length <= 2) {
      keyMoments.push({
        type: 'ShortSession',
        timestamp: session.metadata.startTime,
        durationMs: sessionDuration,
        pageCount: navigationEvents.length,
        url: currentUrl,
        sessionId
      });
    }
    
    // Send some raw session data for AI analysis
    // Rather than try to catch everything, give the AI some general session metrics
    keyMoments.push({
      type: 'SessionMetrics',
      timestamp: session.metadata.startTime,
      duration: session.metadata.duration,
      clickCount: events.filter(e => 
        e.type === 'IncrementalSnapshot' && 
        e.details.incrementalType === 'MouseInteraction' && 
        e.details.interactionType === 'Click'
      ).length,
      inputCount: events.filter(e => 
        e.type === 'IncrementalSnapshot' && 
        e.details.incrementalType === 'Input'
      ).length,
      pageViewCount: events.filter(e => e.type === 'Navigate').length,
      errorCount: errorEvents.length,
      sessionId
    });
  }
  
  return keyMoments;
}

/**
 * Synchronize RRweb events with PostHog events based on timestamp proximity
 * Improved to provide better context for connected events
 */
export function syncWithPostHogEvents(
  rrwebData: ProcessedRRwebData[],
  posthogEvents: PostHogEvent[]
): { posthogEvents: PostHogEvent[], rrwebKeyMoments: any[] } {
  // Extract key moments from RRweb data
  const keyMoments = extractKeyMoments(rrwebData);
  
  // Convert PostHog timestamps to milliseconds since epoch to match RRweb format
  const normalizedPosthogEvents = posthogEvents.map(event => {
    return {
      ...event,
      normalizedTimestamp: new Date(event.timestamp).getTime()
    };
  });
  
  // Find PostHog events that happened close to each key moment
  // Using a wider window to ensure more matches with historical data
  const NEARBY_EVENT_WINDOW_MS = 30000; // Increased from 3000ms to 30000ms (30 seconds)
  
  const synced = keyMoments.map(moment => {
    // Find events within the window of this moment
    const nearbyEvents = normalizedPosthogEvents.filter(event => 
      Math.abs(event.normalizedTimestamp - moment.timestamp) < NEARBY_EVENT_WINDOW_MS
    );
    
    // Sort by temporal proximity
    nearbyEvents.sort((a, b) => 
      Math.abs(a.normalizedTimestamp - moment.timestamp) - 
      Math.abs(b.normalizedTimestamp - moment.timestamp)
    );
    
    // Add a relevance score based on temporal proximity
    const relevantEvents = nearbyEvents.map(event => {
      const timeDiffMs = Math.abs(event.normalizedTimestamp - moment.timestamp);
      const relevanceScore = 1 - (timeDiffMs / NEARBY_EVENT_WINDOW_MS);
      
      return {
        ...event,
        relevanceScore: parseFloat(relevanceScore.toFixed(2))
      };
    });
    
    return {
      ...moment,
      nearbyPosthogEvents: relevantEvents
    };
  });
  
  return {
    posthogEvents: normalizedPosthogEvents,
    rrwebKeyMoments: synced
  };
}

/**
 * Helper function to format duration in ms to a human-readable string
 * @param ms Duration in milliseconds
 * @returns Formatted duration string
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

/**
 * Helper function to truncate a string to a maximum length
 * @param str String to truncate
 * @param maxLength Maximum length
 * @returns Truncated string
 */
function truncateString(str: string, maxLength: number): string {
  if (!str) return '';
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength) + '...';
}

/**
 * Helper function to format an element object to a readable string
 * @param element Element object to format
 * @returns Formatted element string
 */
function formatElement(element: ProcessedRRwebEvent['element']): string {
  if (!element) return 'Unknown element';
  
  let description = element.tag || 'Unknown';
  
  if (element.id) description += `#${element.id}`;
  if (element.className) description += `.${element.className.replace(/\s+/g, '.')}`;
  
  if (element.textContent) {
    const text = truncateString(element.textContent, 30);
    description += ` "${text}"`;
  }
  
  return description;
}

/**
 * Helper function to format a time difference in ms to a readable string
 * @param ms Time difference in milliseconds
 * @returns Formatted time difference string
 */
function formatTimeDiff(ms: number): string {
  const absMs = Math.abs(ms);
  const sign = ms >= 0 ? '+' : '-';
  
  if (absMs < 1000) return `${sign}${absMs}ms`;
  return `${sign}${(absMs / 1000).toFixed(1)}s`;
}

/**
 * Helper function to format event properties in a condensed way
 * @param properties Properties object to format
 * @returns Formatted properties string
 */
function formatProperties(properties: Record<string, any>): string {
  const filteredProps = Object.entries(properties)
    // Filter out commonly noisy props
    .filter(([key, _]) => !key.startsWith('$lib') && !key.startsWith('$feature'))
    // Take only the first few properties
    .slice(0, 3);
    
  if (filteredProps.length === 0) return '{}';
  
  return '{' + filteredProps.map(([key, value]) => {
    let displayValue = value;
    if (typeof value === 'string') {
      displayValue = truncateString(value, 20);
    } else if (typeof value === 'object') {
      displayValue = '[Object]';
    }
    return `${key}: ${displayValue}`;
  }).join(', ') + (Object.keys(properties).length > 3 ? ', ...' : '') + '}';
}

/**
 * Helper function to format an event to a readable string
 * @param event Event to format
 * @returns Formatted event string
 */
function formatEvent(event: ProcessedRRwebEvent): string {
  if (!event) return 'Unknown event';
  
  let description = event.type || 'Unknown';
  
  if (event.details && event.details.incrementalType) {
    description += `:${event.details.incrementalType}`;
  }
  
  if (event.details && event.details.interactionType) {
    description += `:${event.details.interactionType}`;
  }
  
  if (event.element) {
    description += ` on ${formatElement(event.element)}`;
  }
  
  return description;
}

/**
 * Helper to describe context around events
 * @param context Array of events providing context
 * @returns Formatted context string
 */
function describeContext(context: ProcessedRRwebEvent[] | undefined): string {
  if (!context || context.length === 0) {
    return 'No context available';
  }
  
  return context
    .map(event => `${event.type} (${formatTimeDiff(event.timestamp)})`)
    .join(', ');
}

/**
 * Create enhanced context for OpenAI analysis, including both RRweb and PostHog data
 * @param posthogEvents Array of PostHog events
 * @param rrwebData Array of processed RRweb sessions
 * @returns Formatted context string for OpenAI
 */
export function createEnhancedContextForOpenAI(
  posthogEvents: PostHogEvent[],
  rrwebData: ProcessedRRwebData[]
): string {
  // Sync the data sources
  const { rrwebKeyMoments } = syncWithPostHogEvents(rrwebData, posthogEvents);
  
  // Count unique users
  const distinctIds = new Set(posthogEvents.map(e => e.distinct_id));
  
  // Group key moments by type for better organization
  const momentsByType: Record<string, any[]> = {};
  rrwebKeyMoments.forEach(moment => {
    if (!momentsByType[moment.type]) {
      momentsByType[moment.type] = [];
    }
    momentsByType[moment.type].push(moment);
  });
  
  // Count total key moments by type
  const momentCounts: Record<string, number> = {};
  Object.entries(momentsByType).forEach(([type, moments]) => {
    momentCounts[type] = moments.length;
  });
  
  // Format event type counts from PostHog
  const eventTypeCounts: Record<string, number> = {};
  posthogEvents.forEach(event => {
    eventTypeCounts[event.event] = (eventTypeCounts[event.event] || 0) + 1;
  });
  
  // Count pages with interactions
  const pagesWithInteractions = new Set(
    rrwebKeyMoments
      .filter(m => m.url)
      .map(m => m.url)
  );
  
  // Collect URL data by session and moment type
  const urlData: Record<string, string[]> = {};
  rrwebKeyMoments.forEach(moment => {
    if (moment.url) {
      if (!urlData[moment.url]) {
        urlData[moment.url] = [];
      }
      urlData[moment.url].push(moment.type);
    }
  });
  
  // Define explanations for each moment type to help the AI
  const momentTypeExplanations: Record<string, string> = {
    'RageClick': 'Multiple rapid clicks in the same area, indicating user frustration with unresponsive elements',
    'Hesitation': 'Long pauses during active interaction, suggesting confusion or uncertainty',
    'FormAbandonment': 'User started filling a form but left without completing or submitting it',
    'NavigationLoop': 'User repeatedly visiting the same page in a short time period',
    'DeadClick': 'Clicks on non-interactive elements that look clickable',
    'RapidScrolling': 'Quick scrolling through content, potentially searching for something',
    'MouseHovering': 'Mouse staying in the same area for an extended period',
    'MultipleSubmissions': 'Clicking submit/send buttons multiple times',
    'HorizontalScrollMobile': 'Horizontal scrolling detected on mobile viewport sizes',
    'ShortSession': 'Brief session with minimal page views',
    'JSError': 'JavaScript errors encountered during the session',
    'SessionMetrics': 'Overall session statistics'
  };

  // Interesting moments are selected based on:
  // 1. Moments with the longest duration
  // 2. Moments with high frequency counts
  // 3. Moments with extreme values for various metrics
  const interestingMomentsByType: Record<string, any[]> = {};
  
  Object.entries(momentsByType).forEach(([type, moments]) => {
    let interesting;
    
    switch (type) {
      case 'Hesitation':
      case 'FormAbandonment':
      case 'MouseHovering':
        // For time-based events, select the ones with the longest duration
        interesting = [...moments].sort((a, b) => (b.duration || 0) - (a.duration || 0)).slice(0, 3);
        break;
        
      case 'RageClick':
      case 'ErrorClick':
      case 'DeadClick':
        // For click events, select the ones with the most clicks or highest frustration score
        interesting = [...moments].sort((a, b) => (b.frequency || b.count || 0) - (a.frequency || a.count || 0)).slice(0, 3);
        break;
        
      case 'RapidScrolling':
        // For scrolling, select the ones with the most scrolls in the shortest time
        interesting = [...moments].sort((a, b) => (b.scrollCount || 0) - (a.scrollCount || 0)).slice(0, 3);
        break;
        
      case 'SessionMetrics':
        // For session metrics, select diverse examples (short/long sessions, high/low interaction)
        const sortedByDuration = [...moments].sort((a, b) => b.duration - a.duration);
        const sortedByClicks = [...moments].sort((a, b) => b.clickCount - a.clickCount);
        
        // Get most extreme examples
        interesting = [
          sortedByDuration[0], // longest session
          sortedByDuration[sortedByDuration.length - 1], // shortest session
          sortedByClicks[0] // most clicks
        ].filter(Boolean);
        
        // If we don't have 3 examples yet, add more
        if (interesting.length < 3 && moments.length > interesting.length) {
          interesting.push(...moments.slice(0, 3 - interesting.length));
        }
        break;
        
      default:
        // Default strategy: take the 3 most recent
        interesting = moments.slice(0, 3);
    }
    
    interestingMomentsByType[type] = interesting || [];
  });
  
  // Format the prompt with all the enhanced data
  let contextString = `
I need you to analyze user behavior data from our application to identify UX issues. The data combines PostHog analytics events and RRweb session recordings.

## OVERVIEW
- ${distinctIds.size} distinct users with ${posthogEvents.length} total analytics events
- ${rrwebData.length} session recordings analyzed
- ${pagesWithInteractions.size} unique pages with user interactions
- Total duration: ${formatDuration(Math.max(...rrwebData.map(s => s.metadata.duration)))}

## [IMPORTANT] PAGES WITH USER INTERACTIONS
The following URLs were detected in the session data. *YOU MUST USE THESE EXACT URLs in your analysis*:
${Array.from(pagesWithInteractions).map(url => `- URL: "${url}"`).join('\n')}

## URLS AND THEIR INTERACTION PATTERNS
${Object.entries(urlData).map(([url, types]) => {
  return `- URL: "${url}"\n  Issues: ${[...new Set(types)].join(', ')}`;
}).join('\n\n')}

## DETECTED INTERACTION PATTERNS
${Object.entries(momentCounts)
  .sort((a, b) => b[1] - a[1]) // Sort by count, highest first
  .map(([type, count]) => {
    const explanation = momentTypeExplanations[type] || '';
    return `- ${count} instances of **${type}**${explanation ? ` - ${explanation}` : ''}`;
  })
  .join('\n')}

## DETAILED ANALYSIS OF KEY MOMENTS

${Object.entries(interestingMomentsByType)
  .filter(([_, moments]) => moments.length > 0)
  .map(([type, moments]) => {
    return `### ${type} Moments\n${moments.map(moment => {
      let description = `#### ${new Date(moment.timestamp).toISOString()} (${formatDuration(moment.durationMs || 0)})\n`;
      
      // Always put URL first and make it very prominent if available
      if (moment.url) {
        description += `- **URL: "${moment.url}"** ⭐️\n`;
      } else {
        description += `- **URL: No URL data available for this event**\n`;
      }
      
      // Add session ID for context
      description += `- **Session ID:** ${moment.sessionId}\n`;
      
      // Add nearby PostHog events for context
      if (moment.nearbyPosthogEvents && moment.nearbyPosthogEvents.length > 0) {
        description += `- **Nearby events:** ${moment.nearbyPosthogEvents.map((e: any) => e.event).join(', ')}\n`;
      }
      
      // Add type-specific details
      switch (moment.type) {
        case 'Hesitation':
          description += `- **Duration:** ${formatDuration(moment.duration)}\n`;
          description += `- **Context:** ${describeContext(moment.context)}\n`;
          break;
          
        case 'RageClick':
          description += `- **Clicks:** ${moment.count} clicks\n`;
          description += `- **TimeSpan:** ${formatDuration(moment.timeSpan)}\n`;
          if (moment.element) {
            description += `- **Element:** ${formatElement(moment.element)}\n`;
          }
          break;
          
        case 'ErrorClick':
          if (moment.element) {
            description += `- **Element:** ${formatElement(moment.element)}\n`;
          }
          description += `- **Errors:** ${moment.errorCount} JS errors around this click\n`;
          break;
          
        case 'RapidScrolling':
          description += `- **Scrolls:** ${moment.scrollCount} scrolls\n`;
          description += `- **TimeSpan:** ${formatDuration(moment.timeSpan)}\n`;
          description += `- **Direction:** ${moment.direction}\n`;
          break;
          
        case 'FormAbandonment':
          description += `- **Form Fields:** ${moment.fieldCount} fields\n`;
          description += `- **TimeSpan:** ${formatDuration(moment.timeSpan)}\n`;
          description += `- **Completion:** ${moment.completionPercentage}%\n`;
          break;
          
        case 'NavigationLoop':
          description += `- **Frequency:** ${moment.frequency} times in ${formatDuration(moment.timeWindow)}\n`;
          break;
          
        case 'DeadClick':
          if (moment.element) {
            description += `- **Element:** ${formatElement(moment.element)}\n`;
          }
          break;
          
        case 'SessionMetrics':
          description += `- **Duration:** ${formatDuration(moment.duration)}\n`;
          description += `- **Clicks:** ${moment.clickCount}\n`;
          description += `- **Inputs:** ${moment.inputCount}\n`;
          description += `- **Page views:** ${moment.pageViewCount}\n`;
          if (moment.errorCount > 0) {
            description += `- **JS Errors:** ${moment.errorCount}\n`;
          }
          break;
          
        default:
          // Add any properties as generic details
          Object.entries(moment)
            .filter(([key, _]) => !['type', 'timestamp', 'url', 'sessionId', 'nearbyPosthogEvents', 'context'].includes(key))
            .forEach(([key, value]) => {
              if (typeof value === 'object') return;
              description += `- **${key}:** ${value}\n`;
            });
      }
      
      return description;
    }).join('\n\n')}`;
  })
  .join('\n\n')}

## POSTHOG EVENT SUMMARY
${Object.entries(eventTypeCounts)
  .sort((a, b) => b[1] - a[1])
  .map(([event, count]) => `- ${count} ${event} events`)
  .join('\n')}

## ANALYSIS INSTRUCTIONS

Please analyze this data to identify specific UX issues. For each issue you identify, draft a ticket in the following JSON format:
[
  {
    "title": "Concise title describing the issue",
    "severity": "low", "medium", or "high" based on user impact,
    "description": "Detailed description including evidence from the data",
    "pageUrl": "The affected page URL - USE THE EXACT URL FROM THE DATA",
    "elementSelector": "The CSS selector of the problematic element (if applicable)",
    "suggestedFix": "Brief suggestion for how to address the issue"
  }
]

CRITICAL INSTRUCTIONS: 
1. Your output must be valid JSON
2. For each issue, use the EXACT pageUrl from the data. URLs have been clearly marked in the data with "URL: " followed by the URL in quotes. Copy these EXACTLY.
3. Never output "unknown" for pageUrl if a URL is available in the data. 
4. ELEMENT SELECTORS: The "elementSelector" field is CRUCIAL. Examine all elements in interactions and include the actual CSS selector (like "button.submit" or ".sidebar-toggle"). DO NOT use "N/A" unless absolutely no element was involved. Look for element data in $el_selector, Element: fields, and formatElement() outputs.
5. Even subtle patterns can indicate UX issues - be proactive in identifying potential problems
6. Look for hesitations, rapid scrolling, or any unusual behavior that might indicate confusion
7. Group issues by page when possible, and identify patterns across sessions
8. If you can't find ANY issues, only then respond with an empty array: []
`;

  return contextString;
}
