import fs from 'fs';
import dotenv from 'dotenv';
import path from 'path';

/**
 * Logger interface to maintain consistency with other modules
 */
interface Logger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string, error?: unknown) => void;
  debug: (message: string) => void;
}

// Create a logger consistent with other modules
const logger: Logger = {
  info: (message: string) => console.log(`[INFO] ${message}`),
  warn: (message: string) => console.warn(`[WARN] ${message}`),
  error: (message: string, error?: unknown) => {
    console.error(`[ERROR] ${message}`);
    if (error) {
      if (error instanceof Error) {
        console.error(`       ${error.message}`);
        if (process.env.DEBUG_MODE === 'true' && error.stack) {
          console.error(`       ${error.stack}`);
        }
      } else {
        console.error(`       ${String(error)}`);
      }
    }
  },
  debug: (message: string) => {
    if (process.env.DEBUG_MODE === 'true') {
      console.log(`[DEBUG] ${message}`);
    }
  }
};

/**
 * Required environment variables for the application
 */
const REQUIRED_ENV_VARS = [
  'POSTHOG_API_KEY',
  'OPENAI_API_KEY',
  'POSTHOG_HOST',
  'CHECK_INTERVAL_MINUTES',
  'MAX_EVENTS_TO_ANALYZE'
];

/**
 * Check if a file exists at the specified path
 * 
 * @param filePath - The path to check
 * @returns Boolean indicating if the file exists
 */
function checkFileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch (error) {
    logger.error(`Error checking if file exists at path: ${filePath}`, error);
    return false;
  }
}

/**
 * Safely read a file's contents
 * 
 * @param filePath - The path to the file
 * @returns The file contents or null if an error occurred
 */
function safeReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    logger.error(`Error reading file: ${filePath}`, error);
    return null;
  }
}

/**
 * Format an API key for safe display (showing only first few characters)
 * 
 * @param key - Name of the environment variable
 * @param value - The value to format
 * @returns Safely formatted string representation of the API key
 */
function formatSensitiveValue(key: string, value: string): string {
  if (key.includes('API_KEY') || key.includes('SECRET') || key.includes('PASSWORD')) {
    return `${value.substring(0, 5)}... (${value.length} chars)`;
  }
  return value;
}

/**
 * Utility to verify environment variable configuration
 * Used for troubleshooting connection issues with APIs
 * 
 * @returns Object with verification results
 */
export function verifyEnvironmentSetup(): {
  envFileExists: boolean;
  missingKeys: string[];
  loadedVars: number;
} {
  logger.info('===== Environment Configuration Verification =====');

  // Check for .env file
  const envPath = path.resolve(process.cwd(), '.env');
  const fileExists = checkFileExists(envPath);
  
  logger.info('Environment file check:');
  logger.info(`- .env location: ${envPath}`);
  logger.info(`- File exists: ${fileExists ? '✓' : '✗'}`);

  const missingKeys: string[] = [];
  let loadedVars = 0;

  if (fileExists) {
    // Analyze .env without exposing sensitive values
    const envContent = safeReadFile(envPath);
    
    if (!envContent) {
      logger.error('Failed to read .env file content');
      return { envFileExists: fileExists, missingKeys: REQUIRED_ENV_VARS, loadedVars: 0 };
    }
    
    // Check for required keys
    logger.info('\nRequired configuration keys:');
    REQUIRED_ENV_VARS.forEach(key => {
      const keyExists = envContent.includes(`${key}=`);
      logger.info(`- ${key}: ${keyExists ? '✓ Present' : '✗ Missing'}`);
      
      if (!keyExists) {
        missingKeys.push(key);
      }
    });
    
    // Load variables with dotenv
    dotenv.config();
    
    // Verify loaded values (showing only first few characters for API keys)
    logger.info('\nEnvironment variables loaded into process:');
    REQUIRED_ENV_VARS.forEach(key => {
      const value = process.env[key];
      
      if (value) {
        loadedVars++;
        logger.info(`- ${key}: ${formatSensitiveValue(key, value)}`);
      } else {
        logger.warn(`- ${key}: ✗ Not loaded`);
        if (!missingKeys.includes(key)) {
          missingKeys.push(key);
        }
      }
    });
  } else {
    logger.error('\nERROR: .env file missing - please create one based on .env.example');
    missingKeys.push(...REQUIRED_ENV_VARS);
  }
  
  logger.info('\n=================================================');
  
  return {
    envFileExists: fileExists,
    missingKeys,
    loadedVars
  };
}

/**
 * Test connection to external APIs required by the application
 * 
 * @returns Promise with results of connection tests
 */
export async function testExternalConnections(): Promise<{
  posthog: boolean;
  openai: boolean;
}> {
  logger.info('Testing external API connections...');
  
  const results = {
    posthog: false,
    openai: false
  };
  
  // Test PostHog connection
  try {
    const posthogKey = process.env.POSTHOG_API_KEY;
    const posthogHost = process.env.POSTHOG_HOST;
    
    if (!posthogKey || !posthogHost) {
      logger.warn('Missing PostHog configuration, skipping connection test');
    } else {
      // Simple fetch to test connection
      const response = await fetch(`${posthogHost}/api/event?api_key=${posthogKey}`, {
        method: 'HEAD'
      });
      
      results.posthog = response.status < 500; // Consider anything not a server error as "connected"
      logger.info(`PostHog connection test: ${results.posthog ? '✓' : '✗'}`);
    }
  } catch (error) {
    logger.error('PostHog connection test failed', error);
  }
  
  // Test OpenAI connection
  try {
    const openaiKey = process.env.OPENAI_API_KEY;
    
    if (!openaiKey) {
      logger.warn('Missing OpenAI configuration, skipping connection test');
    } else {
      const response = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${openaiKey}`
        }
      });
      
      results.openai = response.status === 200;
      logger.info(`OpenAI connection test: ${results.openai ? '✓' : '✗'}`);
    }
  } catch (error) {
    logger.error('OpenAI connection test failed', error);
  }
  
  return results;
}

/**
 * When run directly, verify the environment and test connections
 */
if (require.main === module) {
  (async () => {
    const envResults = verifyEnvironmentSetup();
    
    if (envResults.missingKeys.length === 0) {
      const connectionResults = await testExternalConnections();
      logger.info(JSON.stringify(connectionResults, null, 2));
    } else {
      logger.warn('Fix environment configuration before testing connections');
    }
  })().catch(error => {
    logger.error('Error in debug utilities', error);
    process.exit(1);
  });
} 