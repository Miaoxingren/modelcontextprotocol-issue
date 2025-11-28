/**
 * Test Script to Reproduce the Memory Leak Issue
 * 
 * This script sends requests that demonstrate the stale mapping issue.
 * 
 * Expected behavior:
 *   - Step 1: Request with id: 1 times out (connection closes after 5s)
 *   - Step 2: Mappings should be cleaned up
 *   - Step 3: New request with id: 1 should work normally
 * 
 * Actual behavior (BUG):
 *   - Step 1: Request with id: 1 times out ✓
 *   - Step 2: _requestToStreamMapping still has stale data ✗
 *   - Step 3: New request with id: 1 may fail or timeout ✗
 * 
 * Usage:
 *   1. Start the server: npx tsx reproduce-server.ts
 *   2. In another terminal: npx tsx reproduce-test.ts
 */

const SERVER_URL = 'http://localhost:3001';

interface TestResult {
  step: string;
  success: boolean;
  duration: number;
  error?: string;
  details?: any;
}

const results: TestResult[] = [];

// Helper function to make MCP request
async function mcpRequest(id: number, method: string, params: any, timeoutMs: number = 10000): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${SERVER_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // For SSE responses, collect all events
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('text/event-stream')) {
      const text = await response.text();
      const lines = text.split('\n');
      const events: any[] = [];

      for (const line of lines) {
        if (line.startsWith('data: ') && line.length > 6) {
          try {
            const data = JSON.parse(line.substring(6));
            events.push(data);
          } catch (e) {
            // Ignore parse errors for empty data lines
          }
        }
      }

      return events.length === 1 ? events[0] : events;
    } else {
      return await response.json();
    }
  } catch (error: any) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

// Helper to get debug info
async function getDebugInfo(): Promise<any> {
  try {
    const response = await fetch(`${SERVER_URL}/debug`);
    return await response.json();
  } catch (error) {
    return { error: String(error) };
  }
}

// Helper to wait
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Main test sequence
async function runTests() {
  console.log('🧪 Starting reproduction tests...\n');

  try {
    // ============================================================
    // STEP 1: Send request with id: 1, timeout after 5 seconds
    // ============================================================
    console.log('📤 STEP 1: Sending slow_tool request with id: 1 (will timeout in 5s)...');
    const step1Start = Date.now();
    let step1Success = false;
    let step1Error = '';

    try {
      await mcpRequest(1, 'tools/call', { name: 'slow_tool', arguments: {} }, 5000);
      step1Error = 'Expected timeout but request succeeded!';
    } catch (error: any) {
      if (error.message.includes('timed out')) {
        step1Success = true;
        console.log('✓ Request timed out as expected');
      } else {
        step1Error = error.message;
      }
    }

    const step1Duration = Date.now() - step1Start;
    results.push({
      step: 'Step 1: Timeout request with id: 1',
      success: step1Success,
      duration: step1Duration,
      error: step1Error || undefined,
    });

    // ============================================================
    // STEP 2: Check internal state for stale mappings
    // ============================================================
    console.log('\n🔍 STEP 2: Checking for stale mappings...');
    await sleep(1000); // Wait a bit for cleanup to happen (if it were to happen)

    const debugInfo = await getDebugInfo();
    console.log('Debug Info:', JSON.stringify(debugInfo, null, 2));

    const hasStaleMappings = debugInfo.requestToStreamMapping?.size > 0;
    const step2Success = hasStaleMappings; // We expect stale data (bug present)

    if (hasStaleMappings) {
      console.log('⚠️  BUG CONFIRMED: Stale mappings found!');
      console.log(`   _requestToStreamMapping has ${debugInfo.requestToStreamMapping.size} entries:`, debugInfo.requestToStreamMapping.entries);
      console.log('   These mappings should have been cleaned up when the connection closed.');
    } else {
      console.log('✓ No stale mappings (bug may be fixed)');
    }

    results.push({
      step: 'Step 2: Check for stale mappings',
      success: step2Success,
      duration: 0,
      details: {
        requestToStreamMappingSize: debugInfo.requestToStreamMapping?.size,
        requestResponseMapSize: debugInfo.requestResponseMap?.size,
        staleMappings: debugInfo.requestToStreamMapping?.entries,
      },
    });

    // ============================================================
    // STEP 3: Wait for slow_tool to complete (still running!)
    // ============================================================
    console.log('\n⏳ STEP 3: Waiting for slow_tool to complete (still running in background)...');
    console.log('   The tool handler is still executing even though client disconnected.');
    console.log('   Waiting 15 seconds...');
    await sleep(15000);

    const debugInfo2 = await getDebugInfo();
    console.log('Debug Info after waiting:', {
      activeRequests: debugInfo2.activeRequests,
      mappingSize: debugInfo2.requestToStreamMapping?.size,
    });

    // ============================================================
    // STEP 4: Send another request with id: 1 (fast tool)
    // ============================================================
    console.log('\n📤 STEP 4: Sending fast_tool request with id: 1 (should work immediately)...');
    const step4Start = Date.now();
    let step4Success = false;
    let step4Error = '';
    let step4Response: any;

    try {
      step4Response = await mcpRequest(1, 'tools/call', { name: 'fast_tool', arguments: {} }, 10000);
      step4Success = true;
      console.log('✓ Request succeeded:', step4Response);
    } catch (error: any) {
      step4Error = error.message;
      console.log('✗ Request failed:', error.message);
    }

    const step4Duration = Date.now() - step4Start;
    results.push({
      step: 'Step 4: Send fast_tool with id: 1',
      success: step4Success,
      duration: step4Duration,
      error: step4Error || undefined,
      details: step4Response,
    });

    // ============================================================
    // STEP 5: Try with a different ID (id: 999) for comparison
    // ============================================================
    console.log('\n📤 STEP 5: Sending fast_tool request with id: 999 (clean ID for comparison)...');
    const step5Start = Date.now();
    let step5Success = false;
    let step5Error = '';
    let step5Response: any;

    try {
      step5Response = await mcpRequest(999, 'tools/call', { name: 'fast_tool', arguments: {} }, 10000);
      step5Success = true;
      console.log('✓ Request succeeded:', step5Response);
    } catch (error: any) {
      step5Error = error.message;
      console.log('✗ Request failed:', error.message);
    }

    const step5Duration = Date.now() - step5Start;
    results.push({
      step: 'Step 5: Send fast_tool with id: 999 (clean ID)',
      success: step5Success,
      duration: step5Duration,
      error: step5Error || undefined,
      details: step5Response,
    });

    // ============================================================
    // STEP 6: Final state check
    // ============================================================
    console.log('\n🔍 STEP 6: Final state check...');
    const finalDebugInfo = await getDebugInfo();
    console.log('Final Debug Info:', JSON.stringify(finalDebugInfo, null, 2));

  } catch (error) {
    console.error('❌ Test failed with error:', error);
  }

  // ============================================================
  // Summary
  // ============================================================
  console.log('\n' + '='.repeat(60));
  console.log('📊 TEST RESULTS SUMMARY');
  console.log('='.repeat(60));

  results.forEach((result, index) => {
    const icon = result.success ? '✓' : '✗';
    console.log(`\n${icon} ${result.step}`);
    console.log(`  Duration: ${result.duration}ms`);
    if (result.error) {
      console.log(`  Error: ${result.error}`);
    }
    if (result.details) {
      console.log(`  Details:`, JSON.stringify(result.details, null, 2));
    }
  });

  console.log('\n' + '='.repeat(60));
  console.log('🎯 CONCLUSION');
  console.log('='.repeat(60));

  const bugConfirmed = results[1]?.success; // Step 2: stale mappings found
  const step4Failed = !results[3]?.success; // Step 4: id: 1 request failed
  const step5Succeeded = results[4]?.success; // Step 5: id: 999 request succeeded

  if (bugConfirmed) {
    console.log('\n⚠️  BUG CONFIRMED: Memory leak detected!');
    console.log('\nEvidence:');
    console.log('  1. Connection closed after timeout ✓');
    console.log('  2. Stale mappings remain in _requestToStreamMapping ✓');
    console.log(`  3. Subsequent request with id: 1 ${step4Failed ? 'FAILED ✓' : 'succeeded (unexpected)'}`);
    console.log(`  4. Request with clean id: 999 ${step5Succeeded ? 'SUCCEEDED ✓' : 'failed (unexpected)'}`);
    console.log('\nRoot cause:');
    console.log('  res.on("close") handler only cleans up _streamMapping');
    console.log('  but leaves _requestToStreamMapping and _requestResponseMap dirty.');
  } else {
    console.log('\n✓ No stale mappings detected - bug may be fixed!');
  }

  console.log('\n');
}

// Run tests
runTests().catch(console.error);

