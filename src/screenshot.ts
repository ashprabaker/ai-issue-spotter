import * as fs from 'fs';
import * as path from 'path';
import * as puppeteer from 'puppeteer';
import { Browser, Page } from 'puppeteer';
import { ProcessedRRwebData, ProcessedRRwebEvent } from './rrweb';

// Constants
const SCREENSHOTS_DIR = path.join(process.cwd(), 'screenshots');
const SCREENSHOT_WAIT_TIME_MS = 500;
const DEFAULT_VIEWPORT_WIDTH = 1280;
const DEFAULT_VIEWPORT_HEIGHT = 800;

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
 * Enum for RRweb event types matching the numeric values used by rrweb
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
 * Initialize the screenshots directory
 */
function initScreenshotsDirectory(): void {
  try {
    if (!fs.existsSync(SCREENSHOTS_DIR)) {
      fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
      logger.info(`Created screenshots directory at ${SCREENSHOTS_DIR}`);
    }
  } catch (error) {
    logger.error(`Failed to create screenshots directory: ${SCREENSHOTS_DIR}`, error);
    throw new Error(`Failed to create screenshots directory: ${error}`);
  }
}

/**
 * Clean up old screenshots from the screenshots directory
 * @returns Number of files removed
 */
export function cleanupScreenshots(): number {
  try {
    initScreenshotsDirectory();
    
    const files = fs.readdirSync(SCREENSHOTS_DIR);
    let removedCount = 0;
    
    for (const file of files) {
      if (file.endsWith('.png')) {
        fs.unlinkSync(path.join(SCREENSHOTS_DIR, file));
        removedCount++;
      }
    }
    
    logger.info(`Removed ${removedCount} old screenshots`);
    return removedCount;
  } catch (error) {
    logger.error('Failed to clean up screenshots', error);
    return 0;
  }
}

/**
 * Captures screenshots from rrweb sessions, focusing on key moments
 * 
 * @param rrwebData The processed rrweb session data
 * @param maxScreenshotsPerSession Maximum number of screenshots to capture per session
 * @returns Array of screenshot file paths
 */
export async function captureScreenshotsFromRRwebSessions(
  rrwebData: ProcessedRRwebData[],
  maxScreenshotsPerSession: number = 5
): Promise<string[]> {
  if (!rrwebData || rrwebData.length === 0) {
    logger.warn('No RRweb data provided for screenshot capture');
    return [];
  }
  
  logger.info(`Capturing screenshots from ${rrwebData.length} rrweb sessions...`);
  
  // Start by cleaning up old screenshots
  cleanupScreenshots();
  
  // Array to store screenshot file paths
  const screenshotPaths: string[] = [];
  let browser: Browser | null = null;
  
  try {
    // Launch a headless browser
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    // Create a new page
    const page = await browser.newPage();
    
    // Set viewport dimensions
    await page.setViewport({
      width: DEFAULT_VIEWPORT_WIDTH,
      height: DEFAULT_VIEWPORT_HEIGHT,
      deviceScaleFactor: 1,
    });
    
    // Process each session
    for (let i = 0; i < rrwebData.length; i++) {
      const session = rrwebData[i];
      logger.info(`Processing session ${i+1}/${rrwebData.length}: ${session.sessionId}`);
      
      try {
        const sessionScreenshots = await captureSessionScreenshots(
          page, 
          session, 
          maxScreenshotsPerSession
        );
        
        screenshotPaths.push(...sessionScreenshots);
      } catch (error) {
        logger.error(`Error capturing screenshots for session ${session.sessionId}`, error);
        // Continue with the next session
      }
    }
  } catch (error) {
    logger.error('Error during screenshot capture process', error);
  } finally {
    // Close the browser
    if (browser) {
      await browser.close();
    }
  }
  
  logger.info(`Total screenshots captured: ${screenshotPaths.length}`);
  return screenshotPaths;
}

/**
 * Captures screenshots for a single session
 * 
 * @param page Puppeteer page object
 * @param session The processed RRweb session data
 * @param maxScreenshots Maximum number of screenshots to capture
 * @returns Array of screenshot file paths
 */
async function captureSessionScreenshots(
  page: Page, 
  session: ProcessedRRwebData, 
  maxScreenshots: number
): Promise<string[]> {
  const screenshotPaths: string[] = [];
  
  // Create HTML file with rrweb-player to replay the session
  const playerHtml = createRRwebPlayerHtml(session);
  const tempHtmlPath = path.join(SCREENSHOTS_DIR, `temp_${session.sessionId}.html`);
  
  try {
    fs.writeFileSync(tempHtmlPath, playerHtml);
    
    // Navigate to the HTML file
    await page.goto(`file://${tempHtmlPath}`);
    
    // Wait for player to initialize
    await page.waitForSelector('.rr-player');
    
    // Intelligently determine key moments to capture
    const timePoints = findInterestingTimestamps(session, maxScreenshots);
    
    // Capture screenshots at each time point
    for (let j = 0; j < timePoints.length; j++) {
      const timePoint = timePoints[j];
      
      try {
        // Set player to specific time
        await page.evaluate((time) => {
          // @ts-ignore - rrwebPlayer is injected via the HTML
          window.rrwebPlayer.goto(time);
        }, timePoint);
        
        // Wait for a moment to let animations settle
        await new Promise(resolve => setTimeout(resolve, SCREENSHOT_WAIT_TIME_MS));
        
        // Take screenshot
        // Include timestamp in filename to help with correlation
        const screenshotFilename = `session_${session.sessionId}_time_${timePoint}.png`;
        const screenshotPath = path.join(SCREENSHOTS_DIR, screenshotFilename);
        
        await page.screenshot({ path: screenshotPath });
        screenshotPaths.push(screenshotPath);
        
        logger.info(`Captured screenshot at time ${timePoint}: ${screenshotFilename}`);
      } catch (error) {
        logger.error(`Error capturing screenshot at time ${timePoint}`, error);
        // Continue with the next time point
      }
    }
  } catch (error) {
    logger.error(`Error setting up session replay for ${session.sessionId}`, error);
    throw error; // Re-throw to be handled by the caller
  } finally {
    // Clean up temp HTML file
    if (fs.existsSync(tempHtmlPath)) {
      fs.unlinkSync(tempHtmlPath);
    }
  }
  
  return screenshotPaths;
}

/**
 * Finds interesting timestamps in a session where screenshots should be captured
 * Focuses on key user interactions and potential UX issue moments
 * 
 * @param session The processed RRweb session data
 * @param maxPoints Maximum number of timestamps to return
 * @returns Array of timestamp values in milliseconds
 */
function findInterestingTimestamps(session: ProcessedRRwebData, maxPoints: number): number[] {
  const { events, metadata } = session;
  const timestamps: number[] = [];
  const keyEventTypes = [
    // Navigation and page events are always interesting
    'DomContentLoaded', 'Load', 'Navigate',
    
    // User interactions that might indicate UX issues
    'IncrementalSnapshot' // We'll filter these further
  ];
  
  // First, collect all timestamps from potentially interesting events
  const candidateTimestamps: number[] = [];
  
  // Add session start
  candidateTimestamps.push(metadata.startTime);
  
  // Add navigation events
  events.forEach(event => {
    if (keyEventTypes.includes(event.type)) {
      // For IncrementalSnapshot events, focus on specific user interactions
      if (event.type === 'IncrementalSnapshot') {
        const isInteresting = 
          // Mouse clicks are always interesting
          (event.details?.incrementalType === 'MouseInteraction' && 
           ['Click', 'MouseDown', 'Focus', 'Blur'].includes(event.details?.interactionType as string)) ||
          // Input events can reveal form interactions
          (event.details?.incrementalType === 'Input') ||
          // Scroll events can indicate searching behavior
          (event.details?.incrementalType === 'Scroll');
          
        if (isInteresting) {
          candidateTimestamps.push(event.timestamp);
        }
      } else {
        // All other key event types
        candidateTimestamps.push(event.timestamp);
      }
    }
  });
  
  // Add session end
  candidateTimestamps.push(metadata.endTime);
  
  // Sort timestamps chronologically
  candidateTimestamps.sort((a, b) => a - b);
  
  // If we have fewer candidates than our max, use all of them
  if (candidateTimestamps.length <= maxPoints) {
    return candidateTimestamps;
  }
  
  // Otherwise, select timestamps that are well-distributed
  // This ensures we get representative moments throughout the session
  
  // Always include start and end
  timestamps.push(candidateTimestamps[0]);
  
  // Select interesting points in between
  const step = (candidateTimestamps.length - 2) / (maxPoints - 2);
  for (let i = 1; i < maxPoints - 1; i++) {
    const index = Math.min(Math.floor(1 + i * step), candidateTimestamps.length - 2);
    timestamps.push(candidateTimestamps[index]);
  }
  
  // Add the end timestamp
  timestamps.push(candidateTimestamps[candidateTimestamps.length - 1]);
  
  return timestamps;
}

/**
 * Creates HTML content with rrweb-player to replay a session
 * 
 * @param session The processed rrweb session data
 * @returns HTML content as string
 */
function createRRwebPlayerHtml(session: ProcessedRRwebData): string {
  // Convert processed events back to rrweb format
  const rrwebEvents = session.events.map(event => {
    // Basic conversion - this may need to be adjusted based on your data structure
    return {
      type: eventTypeToNumber(event.type),
      timestamp: event.timestamp,
      data: event.details
    };
  });
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RRWeb Session Replay</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/rrweb-player@latest/dist/style.css">
  <style>
    body { margin: 0; padding: 0; overflow: hidden; }
    .rr-player { width: 100vw; height: 100vh; }
  </style>
</head>
<body>
  <div id="player"></div>
  
  <script src="https://cdn.jsdelivr.net/npm/rrweb-player@latest/dist/index.js"></script>
  <script>
    // Session data
    const events = ${JSON.stringify(rrwebEvents)};
    
    // Initialize player
    window.rrwebPlayer = new rrwebPlayer({
      target: document.getElementById('player'),
      props: {
        events,
        showController: false,
        autoPlay: false,
        skipInactive: true,
        width: ${DEFAULT_VIEWPORT_WIDTH},
        height: ${DEFAULT_VIEWPORT_HEIGHT}
      }
    });
  </script>
</body>
</html>
  `;
}

/**
 * Converts event type string to rrweb numeric type
 * 
 * @param typeString The event type string
 * @returns The corresponding numeric type
 */
function eventTypeToNumber(typeString: string): RRwebEventType {
  const typeMap: Record<string, RRwebEventType> = {
    'DomContentLoaded': RRwebEventType.DomContentLoaded,
    'Load': RRwebEventType.Load,
    'FullSnapshot': RRwebEventType.FullSnapshot,
    'IncrementalSnapshot': RRwebEventType.IncrementalSnapshot,
    'Meta': RRwebEventType.Meta,
    'Custom': RRwebEventType.Custom
  };
  
  return typeMap[typeString] || RRwebEventType.DomContentLoaded;
} 