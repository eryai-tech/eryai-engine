import { handleChat } from './_lib/engine/chatEngine.js';
import { rateLimit, getClientIP } from './_lib/rateLimit.js';
// Suspicious keywords that should flag a session
const SUSPICIOUS_KEYWORDS = [
  'api key', 'api-nyckel', 'apikey',
  'database', 'databas', 'sql', 'query',
  'injection', 'hack', 'penetration', 'exploit',
  'vulnerability', 'sårbarhet', 'security test',
  'system prompt', 'systemprompt',
  'ignore previous', 'ignorera tidigare', 'ignore instructions',
  'token', 'secret', 'hemlighet',
  'password', 'lösenord', 'passwd',
  'admin', 'root', 'sudo',
  'env', 'environment', '.env',
  'config', 'configuration',
  'supabase', 'vercel', 'gemini', 'openai',
  'internal', 'backend', 'server'
];
// Check if message contains suspicious keywords
function checkSuspicious(message) {
  const lower = message.toLowerCase();
  for (const keyword of SUSPICIOUS_KEYWORDS) {
    if (lower.includes(keyword)) {
      return { suspicious: true, reason: `Keyword: ${keyword}` };
    }
  }
  return { suspicious: false, reason: null };
}
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
  console.log('📥 Request body:', JSON.stringify({ prompt: prompt?.substring(0, 20), slug, companion, customerId }));

  // Validate prompt
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'Invalid prompt' });
  }
  // ===== HANDLE __greeting__ REQUEST =====
  // This is a special request to get the greeting - redirect to /api/greeting
  if (prompt.trim() === '__greeting__') {
    console.log('📨 Greeting request detected - use /api/greeting instead');
    return res.status(400).json({ 
      error: 'Use /api/greeting endpoint for greetings',
      hint: 'GET /api/greeting?slug=your-slug'
    });
  }
  // ===== SUSPICIOUS CHECK =====
  const suspiciousCheck = checkSuspicious(prompt);
  if (suspiciousCheck.suspicious) {
    console.warn(`⚠️ [SUSPICIOUS] IP: ${clientIP}, Reason: ${suspiciousCheck.reason}, Prompt: "${prompt.substring(0, 100)}..."`);
  }
  // Handle chat (pass suspicious info and companion to engine)
  const result = await handleChat({
    prompt,
    history,
    sessionId,
    customerId,
    slug,
    companion,
    isTestMode,
    suspicious: suspiciousCheck.suspicious,
    suspiciousReason: suspiciousCheck.reason
  });
  // Check for errors
  if (result.error) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  return res.status(200).json(result);
}
