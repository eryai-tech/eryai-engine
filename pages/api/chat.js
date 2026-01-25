import { handleChat } from './_lib/engine/chatEngine.js';
import { rateLimit, getClientIP } from './_lib/rateLimit.js';

// NOTE: Suspicious detection has been moved to chatEngine.js
// using AI-powered Security Judge (Gemini Flash Lite)
// This works on ALL languages, not just hardcoded keywords

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Test-Mode');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ===== RATE LIMITING =====
  const clientIP = getClientIP(req);
  const rateLimitResult = rateLimit(clientIP);

  // Set rate limit headers
  res.setHeader('X-RateLimit-Limit', '5');
  res.setHeader('X-RateLimit-Remaining', String(rateLimitResult.remaining));

  if (!rateLimitResult.success) {
    res.setHeader('Retry-After', String(rateLimitResult.retryAfter));
    return res.status(429).json({ 
      error: 'Too many requests',
      message: 'Du skickar för många meddelanden. Vänta några sekunder.',
      retryAfter: rateLimitResult.retryAfter
    });
  }

  // Check if test mode
  const isTestMode = req.headers['x-test-mode'] === 'true';
  if (isTestMode) {
    console.log('🧪 TEST MODE ENABLED');
  }

  const { prompt, history, sessionId, customerId, slug, companion } = req.body || {};
  
  // DEBUG: Log incoming request
  console.log('📥 Request body:', JSON.stringify({ 
    prompt: prompt?.substring(0, 30), 
    slug, 
    companion, 
    customerId 
  }));

  // Validate prompt
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'Invalid prompt' });
  }

  // ===== HANDLE __greeting__ REQUEST =====
  if (prompt.trim() === '__greeting__') {
    console.log('📨 Greeting request detected - use /api/greeting instead');
    return res.status(400).json({ 
      error: 'Use /api/greeting endpoint for greetings',
      hint: 'GET /api/greeting?slug=your-slug'
    });
  }

  // ===== HANDLE CHAT =====
  // Security analysis is now done inside chatEngine.js using AI-powered Security Judge
  // No more hardcoded keywords - works on ALL languages
  try {
    const result = await handleChat({
      prompt,
      history,
      sessionId,
      customerId,
      slug,
      companion,
      isTestMode
    });

    // Check for errors
    if (result.error) {
      return res.status(result.status || 500).json({ error: result.error });
    }

    // Log if suspicious was detected by Security Judge
    if (result.suspicious) {
      console.warn(`🚨 [SECURITY] IP: ${clientIP}, Risk: ${result.riskLevel}/10, Session: ${result.sessionId}`);
    }

    return res.status(200).json(result);

  } catch (error) {
    console.error('❌ Chat handler error:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
