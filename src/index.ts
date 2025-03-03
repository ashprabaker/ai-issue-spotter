import dotenv from 'dotenv';
import { fetchPostHogEvents, PostHogEvent } from './posthog';
import { analyzeEventsAndDraftTickets } from './ai';
import * as path from 'path';
import { loadRRwebData, syncWithPostHogEvents, ProcessedRRwebData } from './rrweb';
import { captureScreenshotsFromRRwebSessions } from './screenshot';
import * as fs from 'fs';

// Load environment variables
dotenv.config();

// Constants
const DEFAULT_CHECK_INTERVAL_MINUTES = 15;
const RRWEB_DATA_FILENAME = 'RRweb data.json';

// Configuration from environment variables
const config = {
  checkIntervalMinutes: parseInt(process.env.CHECK_INTERVAL_MINUTES || String(DEFAULT_CHECK_INTERVAL_MINUTES), 10),
  includeScreenshots: process.env.INCLUDE_SCREENSHOTS === 'true',
  debugMode: process.env.DEBUG_MODE === 'true'
};

// Create a logger
const logger = {
  info: (message: string) => console.log(`[INFO] ${message}`),
  warn: (message: string) => console.warn(`[WARN] ${message}`),
  error: (message: string, error?: unknown) => {
    console.error(`[ERROR] ${message}`);
    if (error) {
      if (error instanceof Error) {
        console.error(`       ${error.message}`);
        if (config.debugMode && error.stack) {
          console.error(`       ${error.stack}`);
        }
      } else {
        console.error(`       ${String(error)}`);
      }
    }
  },
  debug: (message: string) => {
    if (config.debugMode) {
      console.log(`[DEBUG] ${message}`);
    }
  }
};

/**
 * Display an ASCII art logo
 */
function displayLogo(): void {
  console.log(); // Empty line for spacing
  console.log(`     _    ___   _                                      _   _            `);
  console.log(`    / \\  |_ _| (_)___ ___ _   _  ___   ___ _ __   ___ | |_| |_ ___ _ __ `);
  console.log(`   / _ \\  | |  | / __/ __| | | |/ _ \\ / __| '_ \\ / _ \\| __| __/ _ \\ '__|`);
  console.log(`  / ___ \\ | |  | \\__ \\__ \\ |_| |  __/ \\__ \\ |_) | (_) | |_| ||  __/ |   `);
  console.log(` /_/   \\_\\___| |_|___/___/\\__,_|\\___| |___/ .__/ \\___/ \\__|\\__\\___|_|   `);
  console.log(`                                          |_|                           `);
  console.log();
  console.log(`                 👁️  Automatically Detect UX Issues  👁️                 `);
  console.log(`                 📝  Generate Actionable Tickets  📝                 `);
  console.log();
}

/**
 * Format a date for logging
 * @param date Date to format
 * @returns Formatted date string
 */
function formatDate(date: Date): string {
  return date.toISOString();
}

/**
 * The main entry point of the application
 */
async function main(): Promise<void> {
  // Display the cool ASCII art logo
  displayLogo();
  
  logger.info('🔍 AI Issue Spotter starting up...');
  
  // Log configuration
  logger.info(`Configuration:`);
  logger.info(`- Check interval: ${config.checkIntervalMinutes} minutes`);
  logger.info(`- Include screenshots: ${config.includeScreenshots}`);
  logger.info(`- Debug mode: ${config.debugMode}`);
  
  try {
    // Run the check immediately once
    await checkForIssues();
    
    // Then set up interval for periodic checks
    const intervalMs = config.checkIntervalMinutes * 60 * 1000;
    logger.info(`Setting up periodic checks every ${config.checkIntervalMinutes} minutes`);
    setInterval(checkForIssues, intervalMs);
  } catch (error) {
    logger.error('Error in main process:', error);
    process.exit(1);
  }
}

/**
 * Check for potential UX issues by analyzing PostHog events and RRweb data
 */
async function checkForIssues(): Promise<void> {
  try {
    logger.info(`${formatDate(new Date())} - Checking for potential UX issues...`);
    
    // 1. Fetch events from PostHog
    const events = await fetchPostHogEvents();
    logger.info(`Fetched ${events.length} events from PostHog`);
    
    if (events.length === 0) {
      logger.warn('No events to analyze');
      return;
    }
    
    // 2. Check if RRweb data is available and load it
    const rrwebDataPath = path.join(process.cwd(), RRWEB_DATA_FILENAME);
    
    if (fs.existsSync(rrwebDataPath)) {
      await processWithRRwebData(rrwebDataPath, events);
    } else {
      logger.info(`No RRweb data found at ${rrwebDataPath}, proceeding with standard analysis`);
      await processWithoutRRwebData(events);
    }
  } catch (error) {
    logger.error('Error during issue check:', error);
  }
}

/**
 * Process data with RRweb recordings available
 * @param rrwebDataPath Path to the RRweb data file
 * @param events PostHog events
 */
async function processWithRRwebData(rrwebDataPath: string, events: PostHogEvent[]): Promise<void> {
  try {
    // Load and process the RRweb data
    const processedRRwebData = loadRRwebData(rrwebDataPath);
    logger.info(`Loaded ${processedRRwebData.length} sessions from RRweb data`);
    
    if (processedRRwebData.length === 0) {
      logger.warn('No RRweb sessions found in data file');
      await processWithoutRRwebData(events);
      return;
    }
    
    // Synchronize RRweb data with PostHog events to identify key moments
    const syncResult = syncWithPostHogEvents(processedRRwebData, events);
    const { rrwebKeyMoments } = syncResult;
    
    logger.info(`Identified ${rrwebKeyMoments.length} key moments across RRweb sessions`);
    
    // Only capture screenshots for sessions with identified key moments
    const sessionsWithKeyMoments = processedRRwebData.filter(session => 
      rrwebKeyMoments.some(moment => moment.sessionId === session.sessionId)
    );
    
    logger.info(`Found ${sessionsWithKeyMoments.length} sessions with key moments`);
    
    if (sessionsWithKeyMoments.length === 0) {
      logger.warn('No sessions with key moments found, proceeding with standard analysis');
      await processWithoutRRwebData(events);
      return;
    }
    
    // Capture screenshots specifically for these sessions
    let screenshotPaths: string[] = [];
    
    if (config.includeScreenshots) {
      try {
        screenshotPaths = await captureScreenshotsFromRRwebSessions(sessionsWithKeyMoments);
        logger.info(`Captured ${screenshotPaths.length} screenshots from RRweb sessions`);
      } catch (error) {
        logger.error('Error capturing screenshots:', error);
      }
    } else {
      logger.info('Screenshot capture disabled by configuration');
    }
    
    // Analyze events and generate issue tickets
    logger.info(`Analyzing ${events.length} events for potential UX issues...`);
    
    // Now analyze events with the screenshots
    const tickets = await analyzeEventsAndDraftTickets(events);
    displayIssueTickets(tickets);
  } catch (error) {
    logger.error('Error processing RRweb data:', error);
    // Fall back to standard processing
    await processWithoutRRwebData(events);
  }
}

/**
 * Process data without RRweb recordings
 * @param events PostHog events
 */
async function processWithoutRRwebData(events: PostHogEvent[]): Promise<void> {
  logger.info(`Processing with standard analysis (no RRweb data)`);
  const tickets = await analyzeEventsAndDraftTickets(events);
  displayIssueTickets(tickets);
}

/**
 * Display generated issue tickets in a formatted way
 * @param tickets Array of ticket strings
 */
function displayIssueTickets(tickets: string[]): void {
  if (!tickets || tickets.length === 0) {
    logger.info('No issues detected by AI');
    return;
  }
  
  logger.info(`Generated ${tickets.length} ticket(s) for potential UX issues\n`);
  
  tickets.forEach((ticket, index) => {
    console.log('\n======== DRAFT TICKET ========');
    
    // Split the ticket into sections and format them
    const sections = ticket.split(/\n\s*(?=- )/g);
    
    // Print the title section normally
    console.log(sections[0]);
    
    // Format and print remaining sections with proper spacing
    if (sections.length > 1) {
      for (let i = 1; i < sections.length; i++) {
        const section = sections[i].trim();
        
        // Check if this is the Visual Analysis section and highlight it
        if (section.startsWith('- Visual Analysis:')) {
          console.log('\n🔍 VISUAL ANALYSIS:');
          console.log(section.replace('- Visual Analysis:', '').trim());
        } else {
          console.log('\n' + section);
        }
      }
    } else {
      // If no sections were detected, just print the whole ticket
      console.log(ticket);
    }
    
    console.log('==============================\n');
  });
}

// Start the application
main().catch(error => {
  logger.error('Fatal error in main process:', error);
  process.exit(1);
}); 